import { readJson, send, rateLimit } from '../lib/http.js';
import { normalizeUrl, assertPublicUrl } from '../lib/url.js';
import { crawlSite } from '../lib/crawl.js';

// POST { url } -> streams NDJSON lines:
//   {"type":"progress","done":3,"total":25}
//   {"type":"result","data":{...}}   or   {"type":"error","error":"..."}
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  let url;
  try {
    const body = await readJson(req);
    rateLimit(req, 'crawl', Number(process.env.CRAWLS_PER_HOUR || 6), 60 * 60 * 1000);
    url = normalizeUrl(body.url);
    await assertPublicUrl(url);
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'Something went wrong' });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = obj => res.write(JSON.stringify(obj) + '\n');

  const limit = Math.min(Number(process.env.CRAWL_LIMIT || 25), 100);
  const budgetMs = Number(process.env.CRAWL_BUDGET_MS || 45000);

  try {
    const data = await crawlSite(url, {
      limit,
      budgetMs,
      onProgress: p => write({ type: 'progress', ...p }),
    });
    write({ type: 'result', data });
  } catch (err) {
    if ((err.status || 500) >= 500) console.error(err);
    write({ type: 'error', error: err.message || 'The crawl failed. Please try again.' });
  }
  res.end();
}
