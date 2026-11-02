import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './http.js';

// Accepts "example.com", "www.example.com/page", "https://..." and returns a clean URL string.
export function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, 'Please enter a website URL.');
  if (raw.length > 2048) throw new HttpError(400, 'That URL is too long.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'That does not look like a valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http and https URLs are supported.');
  if (!u.hostname.includes('.')) throw new HttpError(400, 'Please enter a full domain, like example.com');
  if (u.username || u.password) throw new HttpError(400, 'URLs with login details are not allowed.');
  u.hash = '';
  return u.toString();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Blocks scans of internal/private addresses (SSRF protection).
export async function assertPublicUrl(urlString) {
  if (process.env.ALLOW_PRIVATE === '1') return; // local testing only
  const { hostname } = new URL(urlString);
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HttpError(400, 'Private or local addresses cannot be scanned.');
  }
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(400, `We couldn't find "${host}". Check the domain and try again.`);
  }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
    throw new HttpError(400, 'Private or local addresses cannot be scanned.');
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SiteAuditBot/1.0';

// Low-level request: follows redirects manually (each hop SSRF-checked) and records the chain.
// Returns { finalUrl, status, headers, body, size, timeMs, chain:[{url,status}], loop }.
export async function request(urlString, {
  method = 'GET', timeoutMs = 10000, maxBytes = 3 * 1024 * 1024, maxHops = 8, readBody = true, accept,
} = {}) {
  let current = urlString;
  const started = Date.now();
  const chain = [];
  const seen = new Set();
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: accept || 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new HttpError(502, e.name === 'AbortError' ? 'The site took too long to respond.' : 'Could not connect to the site.');
      err.chain = chain;
      throw err;
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      clearTimeout(timer);
      chain.push({ url: current, status: res.status });
      try { res.body?.cancel(); } catch { /* ignore */ }
      seen.add(current);
      current = new URL(location, current).toString();
      if (seen.has(current)) {
        return { finalUrl: current, status: res.status, headers: {}, body: '', size: 0, timeMs: Date.now() - started, chain, loop: true };
      }
      continue;
    }
    const chunks = [];
    let size = 0;
    if (readBody && method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { ctrl.abort(); break; }
        chunks.push(value);
      }
    } else {
      try { res.body?.cancel(); } catch { /* ignore */ }
    }
    clearTimeout(timer);
    const headers = Object.fromEntries(res.headers.entries());
    if (!size && headers['content-length']) size = Number(headers['content-length']) || 0;
    return {
      finalUrl: current,
      status: res.status,
      headers,
      body: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'),
      size,
      timeMs: Date.now() - started,
      chain,
      loop: false,
    };
  }
  const err = new HttpError(502, 'Too many redirects.');
  err.chain = chain;
  throw err;
}

// Fetches a page's HTML. Keeps the old shape ({ html, redirects }) plus the redirect chain.
export async function fetchPage(urlString, { timeoutMs = 15000, maxBytes = 3 * 1024 * 1024 } = {}) {
  const r = await request(urlString, { timeoutMs, maxBytes });
  if (r.loop) throw new HttpError(502, 'This URL redirects in a loop.');
  return { ...r, html: r.body, redirects: r.chain.length };
}

// Small GET for robots.txt, sitemap.xml etc. Never throws.
export async function fetchText(urlString, timeoutMs = 8000) {
  try {
    const r = await request(urlString, { timeoutMs, maxBytes: 5 * 1024 * 1024, accept: '*/*' });
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, text: ok ? r.body : '', contentType: r.headers['content-type'] || '', finalUrl: r.finalUrl, chain: r.chain, size: r.size };
  } catch {
    return { ok: false, status: 0, text: '', contentType: '', finalUrl: urlString, chain: [], size: 0 };
  }
}

// Status check for a link or asset. Tries HEAD, falls back to a tiny GET when HEAD isn't allowed. Never throws.
export async function probeUrl(urlString, { timeoutMs = 6000 } = {}) {
  try {
    let r = await request(urlString, { method: 'HEAD', timeoutMs, readBody: false, accept: '*/*' });
    if ([403, 405, 501].includes(r.status) || r.status === 0) {
      r = await request(urlString, { method: 'GET', timeoutMs, maxBytes: 64 * 1024, accept: '*/*' });
    }
    return { url: urlString, status: r.status, headers: r.headers, size: Number(r.headers['content-length']) || r.size || 0, chain: r.chain, finalUrl: r.finalUrl };
  } catch (e) {
    return { url: urlString, status: 0, headers: {}, size: 0, chain: e.chain || [], error: e.message };
  }
}
