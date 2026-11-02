// Small helpers so the same handlers work on Vercel and in the local dev server.

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Best-effort in-memory rate limit (per server instance).
// For production traffic, put Cloudflare Turnstile / Upstash in front of this.
const buckets = new Map();
export function rateLimit(req, key, limit, windowMs) {
  const id = `${key}:${getIp(req)}`;
  const now = Date.now();
  const hits = (buckets.get(id) || []).filter(t => now - t < windowMs);
  if (hits.length >= limit) {
    throw new HttpError(429, 'Too many scans from your network. Please try again later.');
  }
  hits.push(now);
  buckets.set(id, hits);
}

// Wraps a handler: method check, errors -> JSON.
export function handler(fn, { method = 'POST' } = {}) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== method) return send(res, 405, { error: 'Method not allowed' });
    try {
      const body = await readJson(req);
      const data = await fn(body, req);
      send(res, 200, data);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message || 'Something went wrong' });
    }
  };
}
