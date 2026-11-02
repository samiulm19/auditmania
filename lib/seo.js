import { buildModel } from './engine/model.js';
import { pageProbes, siteProbes } from './engine/probes.js';
import { runChecks } from './engine/run.js';
import { SEO_CHECKS, SEO_CATEGORIES } from './checks/seo.js';

// Page SEO: parse the page once, run network probes in parallel, then run every SEO check.
export async function runSeo(page, { budgetMs = Number(process.env.SEO_BUDGET_MS || 20000) } = {}) {
  const m = buildModel(page);
  const [probes, site] = await Promise.all([
    pageProbes(m, { budgetMs }),
    siteProbes(m.origin, { budgetMs }),
  ]);
  const result = runChecks(SEO_CHECKS, m, { probes, site }, { categories: SEO_CATEGORIES });
  return {
    finalUrl: m.url,
    ...result,
    platforms: m.platforms,
    embed: embeddable(m),
    checked: { images: probes.images.length, links: probes.links.length, assets: probes.assets.length, partial: probes.partial },
  };
}

// Can the site be shown in an <iframe> preview? (no X-Frame-Options / CSP frame-ancestors block, https only)
function embeddable(m) {
  const xfo = m.headers['x-frame-options'];
  const fa = (m.headers['content-security-policy'] || '').match(/frame-ancestors([^;]*)/i)?.[1]?.trim();
  return { allowed: m.protocol === 'https:' && !xfo && (!fa || /(^|\s)\*(\s|$)/.test(fa)), url: m.url };
}
