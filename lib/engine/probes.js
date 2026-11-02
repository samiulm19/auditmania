import tls from 'node:tls';
import { fetchText, probeUrl, request, assertPublicUrl } from '../url.js';

// Network checks that need extra requests (assets, links, robots, sitemap, TLS…).
// Everything runs in parallel with a hard time budget so the API always answers in time.

export async function pool(items, size, fn, deadline = Infinity) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      if (Date.now() > deadline) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out.filter(Boolean);
}

const uniq = arr => [...new Set(arr.filter(Boolean))];
const ext = u => { try { return (new URL(u).pathname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || ''; } catch { return ''; } };

function maxAge(cc = '') {
  if (/no-store|no-cache/i.test(cc)) return 0;
  const m = cc.match(/max-age=(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Heuristic: minified files have long lines and little whitespace
function looksMinified(body) {
  if (!body || body.length < 2000) return true;
  const lines = body.split('\n');
  const avgLine = body.length / lines.length;
  const ws = (body.match(/[ \t]/g) || []).length / body.length;
  return avgLine > 200 || ws < 0.08;
}

// ---------------------------------------------------------------------------
// Page-level probes
// ---------------------------------------------------------------------------
export async function pageProbes(m, { budgetMs = 15000, maxImages = 20, maxLinks = 30, maxAssets = 20, minifyChecks = 6 } = {}) {
  const deadline = Date.now() + budgetMs;

  const imgUrls = uniq(m.images.map(i => i.src)).slice(0, maxImages);
  const assetList = [
    ...m.scripts.filter(s => s.src).map(s => ({ url: s.src, kind: 'js' })),
    ...m.stylesheets.map(s => ({ url: s.href, kind: 'css' })),
  ].filter((a, i, arr) => arr.findIndex(b => b.url === a.url) === i).slice(0, maxAssets);
  const internalLinks = uniq(m.links.filter(l => l.internal && l.abs).map(l => l.abs.split('#')[0])).filter(u => u !== m.url).slice(0, Math.ceil(maxLinks / 2));
  const externalLinks = uniq(m.links.filter(l => !l.internal && l.abs && /^https?:/.test(l.abs)).map(l => l.abs)).slice(0, Math.floor(maxLinks / 2));

  const [images, assets, links] = await Promise.all([
    pool(imgUrls, 6, async u => {
      const r = await probeUrl(u);
      return { url: u, status: r.status, size: r.size, type: (r.headers['content-type'] || '').toLowerCase(), ext: ext(u), cache: maxAge(r.headers['cache-control']), internal: sameSite(u, m.host) };
    }, deadline),
    pool(assetList, 6, async (a, idx) => {
      // Fetch a few internal files fully to check minification; HEAD the rest
      const full = idx < minifyChecks && sameSite(a.url, m.host);
      let r;
      try {
        r = full
          ? await request(a.url, { timeoutMs: 6000, maxBytes: 600 * 1024, accept: '*/*' })
          : await request(a.url, { method: 'HEAD', timeoutMs: 6000, readBody: false, accept: '*/*' });
      } catch (e) { return { ...a, status: 0, size: 0, internal: sameSite(a.url, m.host) }; }
      return {
        ...a,
        status: r.status,
        size: r.size,
        encoding: (r.headers['content-encoding'] || '').toLowerCase(),
        cache: maxAge(r.headers['cache-control']),
        minified: full && r.status < 400 ? looksMinified(r.body) : null,
        internal: sameSite(a.url, m.host),
      };
    }, deadline),
    pool([...internalLinks.map(u => ({ u, internal: true })), ...externalLinks.map(u => ({ u, internal: false }))], 8, async ({ u, internal }) => {
      const r = await probeUrl(u);
      return { url: u, internal, status: r.status, chain: r.chain, finalUrl: r.finalUrl };
    }, deadline),
  ]);

  return { images, assets, links, partial: Date.now() > deadline };
}

function sameSite(u, host) {
  try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
const ROBOTS_DIRECTIVE = /^(user-agent|allow|disallow|sitemap|crawl-delay|host|clean-param|request-rate|visit-time|noindex|content-signal)\s*:/i;

export function parseRobots(text) {
  const groups = [];
  let current = null;
  const errors = [];
  const sitemaps = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) { return; }
    if (!ROBOTS_DIRECTIVE.test(line)) { errors.push(`Line ${n + 1}: ${raw.trim().slice(0, 60)}`); return; }
    const [key, ...rest] = line.split(':');
    const k = key.trim().toLowerCase();
    const v = rest.join(':').trim();
    if (k === 'sitemap') { sitemaps.push(v); return; }
    if (k === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(v.toLowerCase());
      return;
    }
    if ((k === 'allow' || k === 'disallow') && current) current.rules.push({ allow: k === 'allow', path: v });
  });
  return { groups, errors, sitemaps };
}

function ruleMatches(path, rule) {
  if (!rule.path) return false;
  const re = new RegExp('^' + rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}

export function robotsAllows(robots, path, agent = 'googlebot') {
  if (!robots) return true;
  const g = robots.groups.find(x => x.agents.includes(agent)) || robots.groups.find(x => x.agents.includes('*'));
  if (!g) return true;
  const matches = g.rules.filter(r => ruleMatches(path, r)).sort((a, b) => b.path.length - a.path.length || (a.allow ? -1 : 1));
  return matches.length ? matches[0].allow : true;
}

// ---------------------------------------------------------------------------
// Site-level probes (run once per scan)
// ---------------------------------------------------------------------------
const locs = xml => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(x => x[1].replace(/&amp;/g, '&'));

export async function siteProbes(origin, { budgetMs = 15000, sampleSitemap = 15 } = {}) {
  const deadline = Date.now() + budgetMs;
  const u = new URL(origin);
  const host = u.hostname;
  const out = { origin };

  const robotsRes = await fetchText(`${origin}/robots.txt`);
  const robotsIsText = robotsRes.ok && !/<html/i.test(robotsRes.text.slice(0, 500));
  out.robots = robotsIsText ? { found: true, ...parseRobots(robotsRes.text), size: robotsRes.text.length } : { found: false, groups: [], errors: [], sitemaps: [] };

  // Sitemap
  const candidates = uniq([...out.robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`]);
  out.sitemap = { found: false };
  for (const sm of candidates) {
    const r = await fetchText(sm);
    if (!r.ok) continue;
    const isXml = /<(urlset|sitemapindex)[\s>]/i.test(r.text);
    if (!isXml && !/^\s*<\?xml/.test(r.text)) continue;
    const isIndex = /<sitemapindex/i.test(r.text);
    let urls = isIndex ? [] : locs(r.text);
    const children = isIndex ? locs(r.text) : [];
    if (isIndex) {
      // Prefer page/post sitemaps over product/category/tag ones
      const rank = x => (/page/i.test(x) ? 0 : /post/i.test(x) ? 1 : /product/i.test(x) ? 2 : /categor|tag|author/i.test(x) ? 4 : 3);
      for (const c of [...children].sort((a, b) => rank(a) - rank(b)).slice(0, 5)) {
        const cr = await fetchText(c);
        if (cr.ok) urls.push(...locs(cr.text));
      }
    }
    out.sitemap = {
      found: true,
      url: sm,
      declared: out.robots.sitemaps.length > 0,
      valid: isXml && (!/<urlset/i.test(r.text) || /<\/urlset>/i.test(r.text)),
      isIndex,
      children: children.length,
      count: urls.length,
      bytes: r.size || r.text.length,
      httpUrls: u.protocol === 'https:' ? urls.filter(x => x.startsWith('http://')).length : 0,
      urls: urls.slice(0, 2000),
    };
    break;
  }
  if (out.sitemap.found && out.sitemap.urls.length) {
    const sample = out.sitemap.urls.slice(0, sampleSitemap);
    out.sitemap.sample = await pool(sample, 6, async s => {
      const r = await probeUrl(s);
      return { url: s, status: r.status, redirected: r.chain.length > 0 };
    }, deadline);
  }

  const [https, wwwVariant, notFound, llms, cert] = await Promise.all([
    // HTTP -> HTTPS redirect
    (async () => {
      try {
        const r = await request(`http://${host}/`, { timeoutMs: 6000, maxBytes: 64 * 1024 });
        return { tested: true, redirects: r.finalUrl.startsWith('https://'), chain: r.chain.length };
      } catch { return { tested: false }; }
    })(),
    // www and non-www should end on the same URL
    (async () => {
      const alt = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
      try {
        await assertPublicUrl(`${u.protocol}//${alt}/`);
        const [a, b] = await Promise.all([
          request(`${u.protocol}//${host}/`, { timeoutMs: 6000, maxBytes: 64 * 1024 }),
          request(`${u.protocol}//${alt}/`, { timeoutMs: 6000, maxBytes: 64 * 1024 }),
        ]);
        const fa = new URL(a.finalUrl).hostname, fb = new URL(b.finalUrl).hostname;
        return { tested: true, alt, same: fa === fb, aHost: fa, bHost: fb, bStatus: b.status };
      } catch { return { tested: false, alt }; }
    })(),
    // A random URL must return 404/410, not 200 (soft 404)
    (async () => {
      try {
        const r = await request(`${origin}/this-page-does-not-exist-${Math.random().toString(36).slice(2, 8)}`, { timeoutMs: 6000, maxBytes: 64 * 1024 });
        return { tested: true, status: r.status, redirectedHome: r.chain.length > 0 && new URL(r.finalUrl).pathname === '/' };
      } catch { return { tested: false }; }
    })(),
    // llms.txt (for AI search engines)
    (async () => {
      const r = await fetchText(`${origin}/llms.txt`);
      const ok = r.ok && !/<html/i.test(r.text.slice(0, 300));
      return { found: ok, formatted: ok && /^#\s+\S/m.test(r.text) };
    })(),
    certInfo(host, u.protocol),
  ]);
  Object.assign(out, { https, www: wwwVariant, notFound, llms, cert });
  return out;
}

function certInfo(host, protocol) {
  if (protocol !== 'https:') return Promise.resolve({ tested: false });
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 6000 }, () => {
        const c = sock.getPeerCertificate();
        const validTo = c?.valid_to ? new Date(c.valid_to) : null;
        finish({
          tested: true,
          authorized: sock.authorized,
          error: sock.authorizationError ? String(sock.authorizationError) : null,
          protocol: sock.getProtocol(),
          daysLeft: validTo ? Math.floor((validTo - Date.now()) / 86400000) : null,
          issuer: c?.issuer?.O || c?.issuer?.CN || null,
        });
        sock.end();
      });
      sock.on('error', () => finish({ tested: false }));
      sock.on('timeout', () => { sock.destroy(); finish({ tested: false }); });
    } catch { finish({ tested: false }); }
  });
}
