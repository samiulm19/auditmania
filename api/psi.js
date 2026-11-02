import { handler, rateLimit, HttpError } from '../lib/http.js';
import { normalizeUrl, assertPublicUrl } from '../lib/url.js';
import { runPsi } from '../lib/psi.js';
import { mockPsi } from '../lib/mock-psi.js';

// POST { url, strategy: "mobile" | "desktop" } -> Google PageSpeed Insights result
export default handler(async ({ url, strategy }, req) => {
  rateLimit(req, 'psi', Number(process.env.SCANS_PER_HOUR || 15), 60 * 60 * 1000);
  const clean = normalizeUrl(url);
  await assertPublicUrl(clean);
  const s = strategy === 'desktop' ? 'desktop' : 'mobile';
  if (process.env.MOCK_PSI === '1') return mockPsi(clean, s);
  return runPsi(clean, s);
});
