import { handler, rateLimit, HttpError } from '../lib/http.js';
import { normalizeUrl, fetchPage } from '../lib/url.js';
import { extractStructure, runUx } from '../lib/ux.js';

const cache = new Map();

// POST { url, screenshots?: [dataUri] } -> AI UX/CRO audit (falls back to rule-based checks)
export default handler(async ({ url, screenshots }, req) => {
  rateLimit(req, 'ux', Number(process.env.SCANS_PER_HOUR || 15), 60 * 60 * 1000);
  const clean = normalizeUrl(url);
  const hit = cache.get(clean);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.data, cached: true };

  const page = await fetchPage(clean);
  if (!/<html|<body|<head/i.test(page.html)) {
    throw new HttpError(422, 'We could not read this page. It may block bots or be offline.');
  }
  const structure = extractStructure(page.html, page.finalUrl);
  const shots = (Array.isArray(screenshots) ? screenshots : [])
    .filter(s => typeof s === 'string' && s.startsWith('data:image/'))
    .slice(0, 2);
  const data = { ...(await runUx(structure, shots)), finalUrl: page.finalUrl };
  cache.set(clean, { at: Date.now(), data });
  return data;
});
