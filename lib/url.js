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

// Fetches a page's HTML with timeout + size cap. Follows redirects manually so every hop is checked.
export async function fetchPage(urlString, { timeoutMs = 15000, maxBytes = 3 * 1024 * 1024 } = {}) {
  let current = urlString;
  const started = Date.now();
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new HttpError(502, e.name === 'AbortError' ? 'The site took too long to respond.' : 'Could not connect to the site.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { ctrl.abort(); break; }
        chunks.push(value);
      }
    }
    clearTimeout(timer);
    return {
      finalUrl: current,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'),
      timeMs: Date.now() - started,
      redirects: hop,
    };
  }
  throw new HttpError(502, 'Too many redirects.');
}

// Quick HEAD/GET check for files like robots.txt and sitemap.xml
export async function fetchText(urlString, timeoutMs = 8000) {
  try {
    await assertPublicUrl(urlString);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(urlString, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    const text = res.ok ? (await res.text()).slice(0, 200000) : '';
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') || '' };
  } catch {
    return { ok: false, status: 0, text: '', contentType: '' };
  }
}
