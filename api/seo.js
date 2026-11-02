import { handler, rateLimit, HttpError } from '../lib/http.js';
import { normalizeUrl, fetchPage } from '../lib/url.js';
import { runSeo } from '../lib/seo.js';

// POST { url } -> on-page SEO checklist
export default handler(async ({ url }, req) => {
  rateLimit(req, 'seo', Number(process.env.SCANS_PER_HOUR || 15) * 2, 60 * 60 * 1000);
  const page = await fetchPage(normalizeUrl(url));
  if (!/<html|<body|<head/i.test(page.html)) {
    throw new HttpError(422, `The site returned HTTP ${page.status} without a readable HTML page. It may block bots or be offline.`);
  }
  return runSeo(page);
});
