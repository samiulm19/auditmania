import { fetchPage } from './url.js';
import { buildModel } from './engine/model.js';
import { siteProbes, pool } from './engine/probes.js';
import { runChecks } from './engine/run.js';
import { SEO_CHECKS, SEO_CATEGORIES, SITE_SCOPE } from './checks/seo.js';
import { SITE_CHECKS } from './checks/site.js';

// Full-site SEO crawl.
// 1. Site probes once (robots, sitemap, https, www, 404, TLS, llms.txt)
// 2. Crawl pages from the sitemap + links (time/page budget)
// 3. Run every page-level SEO check on every page (same engine as Page SEO)
// 4. Run cross-page checks (duplicates, orphans, depth, broken pages…)
// 5. Group issues by check and score the site

const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|pdf|zip|rar|7z|gz|mp4|mp3|wav|webm|mov|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|csv)$/i;
const SKIP_PATH = /\/(wp-admin|wp-login|wp-json|cart|checkout|my-account|account|login|logout|register|feed|cdn-cgi)(\/|$)|\/(tag|author)\/|[?&](add-to-cart|replytocom)=/i;
const bareHost = h => h.replace(/^www\./i, '').toLowerCase();
const norm = u => String(u || '').replace(/\/$/, '');

function cleanUrl(href, base, host) {
  try {
    const u = new URL(href, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (bareHost(u.hostname) !== host) return null;
    if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname + u.search)) return null;
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch { return null; }
}

const PAGE_CHECKS = SEO_CHECKS.filter(c => !SITE_SCOPE.has(c.id));
const HOME_SITE_CHECKS = SEO_CHECKS.filter(c => SITE_SCOPE.has(c.id));
const W = { high: 10, medium: 5, low: 2 };

export async function crawlSite(startUrl, { limit = 25, budgetMs = 45000, onProgress = () => {} } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;

  const home = await fetchPage(startUrl, { timeoutMs: 12000 });
  const origin = new URL(home.finalUrl).origin;
  const host = bareHost(new URL(home.finalUrl).hostname);
  onProgress({ done: 0, total: limit, stage: 'Reading robots.txt and sitemap' });

  const site = await siteProbes(origin, { budgetMs: Math.min(12000, budgetMs / 3), sampleSitemap: 0 });
  const homeUrl = cleanUrl(home.finalUrl, origin, host) || home.finalUrl;
  const sitemapSet = new Set((site.sitemap.urls || []).map(u => cleanUrl(u, origin, host)).filter(Boolean));

  const queue = [homeUrl, ...[...sitemapSet].filter(u => u !== homeUrl)];
  const queued = new Set(queue);
  const pages = new Map();
  let finished = 0;
  const report = () => onProgress({ done: ++finished, total: Math.min(limit, Math.max(queue.length, pages.size)), source: sitemapSet.size ? 'sitemap' : 'links' });
  report.initial = () => onProgress({ done: 0, total: Math.min(limit, queue.length), source: sitemapSet.size ? 'sitemap' : 'links' });
  report.initial();

  const visit = async url => {
    if (pages.size >= limit || Date.now() > deadline) return;
    const rec = { url, fromSitemap: sitemapSet.has(url), chain: [], links: [] };
    pages.set(url, rec);
    let page;
    try {
      page = url === homeUrl ? home : await fetchPage(url, { timeoutMs: 10000, maxBytes: 2 * 1024 * 1024 });
    } catch (e) {
      Object.assign(rec, { status: 0, error: e.message, chain: e.chain || [] });
      return report();
    }
    const finalClean = cleanUrl(page.finalUrl, origin, host) || page.finalUrl;
    Object.assign(rec, { status: page.status, timeMs: page.timeMs, chain: page.chain || [], redirected: finalClean !== url ? finalClean : null });

    if (rec.redirected) {
      if (!queued.has(finalClean)) { queued.add(finalClean); queue.push(finalClean); }
      return report();
    }
    const isHtml = /text\/html|xhtml/i.test(page.headers['content-type'] || '') || /<html/i.test(page.html.slice(0, 2000));
    if (page.status >= 400 || !isHtml) return report();

    const m = buildModel(page);
    const result = runChecks(PAGE_CHECKS, m, { site: { robots: site.robots } });
    const issues = result.categories.flatMap(c => c.checks).filter(k => k.status === 'fail' || k.status === 'warn');
    rec.links = [...new Set(m.links.map(l => l.abs && cleanUrl(l.abs, origin, host)).filter(Boolean))];
    Object.assign(rec, {
      title: m.title, desc: m.descriptions[0] || '', h1: m.h1[0] || '',
      canonical: m.canonical, noindex: /noindex|none/.test(m.robotsMeta + m.xRobots),
      words: m.stats.words, minhash: m.minhash, score: result.score, issues,
    });
    if (url === homeUrl) rec.homeModel = m;
    for (const l of rec.links) if (!queued.has(l) && queued.size < limit * 4) { queued.add(l); queue.push(l); }
    report();
  };

  let cursor = 0;
  while (cursor < queue.length && pages.size < limit && Date.now() < deadline) {
    const batch = queue.slice(cursor, cursor + Math.min(limit - pages.size, 10));
    cursor += batch.length;
    await pool(batch, 5, visit);
  }
  const timedOut = cursor < queue.length && pages.size < limit;

  return buildReport({ origin, homeUrl, pages: [...pages.values()], site, limit, discovered: queued.size, timedOut, ms: Date.now() - started });
}

function buildReport({ origin, homeUrl, pages, site, limit, discovered, timedOut, ms }) {
  // Link graph: incoming counts and click depth (BFS from home)
  const incoming = new Map();
  const byUrl = new Map(pages.map(p => [p.url, p]));
  // Follow redirects so a link to /about counts for /about/
  const resolve = u => { let k = u; for (let i = 0; i < 5; i++) { const r = byUrl.get(k); if (!r?.redirected) break; k = r.redirected; } return k; };
  for (const p of pages) for (const l of new Set(p.links.map(resolve))) if (l !== p.url) incoming.set(l, (incoming.get(l) || 0) + 1);
  const rawIncoming = new Map();
  for (const p of pages) for (const l of new Set(p.links)) if (l !== p.url) rawIncoming.set(l, (rawIncoming.get(l) || 0) + 1);
  pages.forEach(p => { p.depth = 99; });
  const homeRec = byUrl.get(homeUrl);
  if (homeRec) {
    homeRec.depth = 0;
    const q = [homeRec];
    while (q.length) {
      const cur = q.shift();
      for (const l of cur.links) {
        const t = byUrl.get(resolve(l));
        if (t && t.depth > cur.depth + 1) { t.depth = cur.depth + 1; q.push(t); }
      }
    }
  }

  const ok = pages.filter(p => p.status >= 200 && p.status < 400 && !p.redirected && p.title !== undefined);
  const ctx = {
    home: homeUrl, ok, byUrl,
    indexable: ok.filter(p => !p.noindex),
    incoming: u => incoming.get(u) || 0,
    rawIncoming: u => rawIncoming.get(u) || 0,
    lookup: u => byUrl.get(resolve(u)) || byUrl.get(resolve(u + '/')) || byUrl.get(resolve(String(u).replace(/\/$/, ''))),
    path: u => { try { return new URL(u).pathname; } catch { return u; } },
  };

  const groups = [];

  // 1. Page-level checks aggregated across pages
  const agg = new Map();
  for (const p of ok) for (const k of p.issues) {
    if (!agg.has(k.id)) agg.set(k.id, { id: k.id, label: k.label, cat: SEO_CHECKS.find(c => c.id === k.id)?.cat || 'Other', sevs: [], tip: k.tip, pages: [] });
    const g = agg.get(k.id);
    g.sevs.push(k.status === 'fail' ? k.sev : k.sev === 'high' ? 'medium' : 'low');
    g.pages.push({ url: p.url, detail: k.value });
  }
  for (const g of agg.values()) {
    const sev = g.sevs.includes('high') ? 'high' : g.sevs.includes('medium') ? 'medium' : 'low';
    groups.push({ id: g.id, label: g.label, cat: g.cat, severity: sev, tip: g.tip, count: g.pages.length, pages: g.pages.slice(0, 40) });
  }

  // 2. Cross-page checks
  for (const c of SITE_CHECKS) {
    let flagged = [];
    try { flagged = c.run(pages, ctx) || []; } catch (e) { if (process.env.DEBUG_CHECKS) console.error(c.id, e); }
    if (flagged.length) groups.push({ id: c.id, label: c.label, cat: c.cat, severity: c.sev, tip: c.tip, count: flagged.length, pages: flagged.slice(0, 40) });
  }

  // 3. Site-wide checks, run once (homepage + site probes)
  const homeModel = homeRec?.homeModel;
  let siteResult = null;
  if (homeModel) {
    siteResult = runChecks(HOME_SITE_CHECKS, homeModel, { site }, { categories: SEO_CATEGORIES });
    for (const k of siteResult.categories.flatMap(c => c.checks)) {
      if (k.status !== 'fail' && k.status !== 'warn') continue;
      groups.push({ id: k.id, label: k.label, cat: HOME_SITE_CHECKS.find(c => c.id === k.id)?.cat || 'Site', severity: k.status === 'fail' ? k.sev : k.sev === 'high' ? 'medium' : 'low', tip: k.tip, count: 0, siteWide: true, detail: k.value, pages: (k.items || []).map(i => ({ url: '', detail: i })) });
    }
  }

  // Score: average page score, site-wide checks, and cross-page penalties
  const avgPage = ok.length ? ok.reduce((s, p) => s + p.score, 0) / ok.length : 0;
  const total = Math.max(1, pages.length);
  const crossPenalty = groups.filter(g => SITE_CHECKS.some(c => c.id === g.id)).reduce((s, g) => s + W[g.severity] * (0.4 + 0.6 * Math.min(1, g.count / total)), 0);
  const crossScore = Math.max(0, 100 - crossPenalty);
  const score = Math.round(0.55 * avgPage + 0.25 * (siteResult?.score ?? avgPage) + 0.2 * crossScore);

  const order = { high: 0, medium: 1, low: 2 };
  groups.sort((a, b) => order[a.severity] - order[b.severity] || (b.siteWide ? 1 : 0) - (a.siteWide ? 1 : 0) || b.count - a.count);

  const byCat = {};
  groups.forEach(g => { byCat[g.cat] = (byCat[g.cat] || 0) + 1; });

  return {
    origin,
    score,
    source: site.sitemap.found ? `sitemap (${new URL(site.sitemap.url).pathname})` : 'following links',
    crawled: pages.length,
    discovered: Math.max(discovered, site.sitemap.count || 0),
    limit,
    timedOut,
    seconds: Math.round(ms / 100) / 10,
    checksRun: PAGE_CHECKS.length + SITE_CHECKS.length + HOME_SITE_CHECKS.length,
    summary: {
      high: groups.filter(g => g.severity === 'high').length,
      medium: groups.filter(g => g.severity === 'medium').length,
      low: groups.filter(g => g.severity === 'low').length,
    },
    categories: Object.entries(byCat).map(([name, issues]) => ({ name, issues })),
    groups,
    pages: pages.map(p => ({
      url: p.url,
      status: p.status || 0,
      redirected: !!p.redirected,
      title: p.title || '',
      words: p.words ?? null,
      timeMs: p.timeMs || 0,
      depth: p.depth < 99 ? p.depth : null,
      score: p.score ?? null,
      issues: (p.issues?.length || 0) + groups.filter(g => !g.siteWide && SITE_CHECKS.some(c => c.id === g.id) && g.pages.some(x => x.url === p.url)).length,
    })),
  };
}
