import * as cheerio from 'cheerio';
import { fetchText } from './url.js';

// Each check: status pass | warn | fail, weight decides how much it moves the score.
function check(id, label, status, value, tip, weight = 1) {
  return { id, label, status, value, tip, weight };
}

const len = s => (s || '').trim().length;

export async function runSeo(page) {
  const $ = cheerio.load(page.html);
  const url = new URL(page.finalUrl);
  const origin = url.origin;
  const checks = [];

  // --- Indexing ---------------------------------------------------------
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const xRobots = String(page.headers['x-robots-tag'] || '').toLowerCase();
  const noindex = robotsMeta.includes('noindex') || xRobots.includes('noindex');
  checks.push(check('indexable', 'Page can be indexed by Google', noindex ? 'fail' : 'pass',
    noindex ? 'noindex found' : 'No noindex tag',
    noindex ? 'Remove the noindex directive if you want this page to appear in search results.' : '', 3));

  checks.push(check('status', 'Page returns HTTP 200', page.status === 200 ? 'pass' : 'fail',
    `HTTP ${page.status}`, page.status === 200 ? '' : 'Search engines may not index pages that do not return 200.', 3));

  checks.push(check('https', 'Uses HTTPS', url.protocol === 'https:' ? 'pass' : 'fail',
    url.protocol === 'https:' ? 'Secure' : 'Not secure',
    url.protocol === 'https:' ? '' : 'Install an SSL certificate and redirect all traffic to https.', 2));

  // --- Title & description --------------------------------------------
  const title = $('head > title').first().text().trim();
  const tl = len(title);
  checks.push(check('title', 'Title tag', !tl ? 'fail' : tl < 30 || tl > 60 ? 'warn' : 'pass',
    tl ? `"${title.slice(0, 80)}" (${tl} chars)` : 'Missing',
    !tl ? 'Add a unique title with your main keyword and brand.' : tl < 30 || tl > 60 ? 'Keep the title between 30 and 60 characters so it is not cut off in Google.' : '', 3));

  const desc = $('meta[name="description"]').attr('content') || '';
  const dl = len(desc);
  checks.push(check('description', 'Meta description', !dl ? 'fail' : dl < 70 || dl > 160 ? 'warn' : 'pass',
    dl ? `${dl} chars` : 'Missing',
    !dl ? 'Write a 120–160 character description that sells the click.' : dl < 70 || dl > 160 ? 'Aim for 120–160 characters.' : '', 2));

  // --- Headings -------------------------------------------------------
  const h1s = $('h1').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
  checks.push(check('h1', 'One H1 heading', h1s.length === 1 ? 'pass' : h1s.length === 0 ? 'fail' : 'warn',
    h1s.length === 0 ? 'No H1 found' : h1s.length === 1 ? `"${h1s[0].slice(0, 70)}"` : `${h1s.length} H1 tags`,
    h1s.length === 1 ? '' : h1s.length === 0 ? 'Add one H1 that clearly says what the page is about.' : 'Use a single H1; turn the others into H2s.', 2));

  const h2 = $('h2').length;
  checks.push(check('h2', 'Subheadings (H2) structure', h2 >= 2 ? 'pass' : h2 === 1 ? 'warn' : 'fail',
    `${h2} H2 tag${h2 === 1 ? '' : 's'}`, h2 >= 2 ? '' : 'Break content into sections with H2 subheadings.', 1));

  // --- Content --------------------------------------------------------
  const $body = $('body').clone();
  $body.find('script,style,noscript,svg,template').remove();
  const words = $body.text().replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 1).length;
  checks.push(check('words', 'Enough text content', words >= 300 ? 'pass' : words >= 150 ? 'warn' : 'fail',
    `${words} words`, words >= 300 ? '' : 'Thin pages rank poorly. Aim for 300+ useful words on key pages.', 1));

  const imgs = $('img');
  const noAlt = imgs.filter((_, el) => !len($(el).attr('alt'))).length;
  const imgStatus = imgs.length === 0 ? 'pass' : noAlt === 0 ? 'pass' : noAlt / imgs.length > 0.3 ? 'fail' : 'warn';
  checks.push(check('alt', 'Images have alt text', imgStatus,
    imgs.length ? `${imgs.length - noAlt}/${imgs.length} have alt` : 'No images',
    imgStatus === 'pass' ? '' : `Add descriptive alt text to ${noAlt} image${noAlt === 1 ? '' : 's'}.`, 1));

  // --- Technical tags -------------------------------------------------
  const canonical = $('link[rel="canonical"]').attr('href');
  checks.push(check('canonical', 'Canonical tag', canonical ? 'pass' : 'warn',
    canonical ? canonical.slice(0, 90) : 'Missing', canonical ? '' : 'Add a canonical URL to avoid duplicate-content issues.', 1));

  const viewport = $('meta[name="viewport"]').attr('content');
  checks.push(check('viewport', 'Mobile viewport tag', viewport ? 'pass' : 'fail',
    viewport ? 'Present' : 'Missing', viewport ? '' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 2));

  const lang = $('html').attr('lang');
  checks.push(check('lang', 'Language declared', lang ? 'pass' : 'warn',
    lang || 'Missing', lang ? '' : 'Add a lang attribute to the <html> tag, e.g. lang="en".', 0.5));

  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogCount = [ogTitle, ogImage].filter(Boolean).length;
  checks.push(check('og', 'Social sharing tags (Open Graph)', ogCount === 2 ? 'pass' : ogCount ? 'warn' : 'fail',
    ogCount === 2 ? 'og:title + og:image' : ogCount ? 'Partially set' : 'Missing',
    ogCount === 2 ? '' : 'Add og:title and og:image so links look good on Facebook, LinkedIn and WhatsApp.', 1));

  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      const walk = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n['@type']) schemaTypes.push([].concat(n['@type']).join('/'));
        if (n['@graph']) walk(n['@graph']);
      };
      walk(j);
    } catch { /* ignore invalid JSON-LD */ }
  });
  checks.push(check('schema', 'Structured data (Schema)', schemaTypes.length ? 'pass' : 'warn',
    schemaTypes.length ? [...new Set(schemaTypes)].slice(0, 5).join(', ') : 'None found',
    schemaTypes.length ? '' : 'Add JSON-LD schema (Organization, LocalBusiness, Product…) for rich results.', 1));

  const favicon = $('link[rel~="icon"]').length > 0;
  checks.push(check('favicon', 'Favicon', favicon ? 'pass' : 'warn', favicon ? 'Present' : 'Missing',
    favicon ? '' : 'Add a favicon; Google shows it next to your result on mobile.', 0.5));

  // --- Links ----------------------------------------------------------
  let internal = 0, external = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try { new URL(href, origin).origin === origin ? internal++ : external++; } catch { /* skip */ }
  });
  checks.push(check('links', 'Internal links', internal >= 5 ? 'pass' : internal >= 1 ? 'warn' : 'fail',
    `${internal} internal, ${external} external`, internal >= 5 ? '' : 'Link to your important pages so Google can discover them.', 1));

  // --- robots.txt & sitemap ------------------------------------------
  const robots = await fetchText(`${origin}/robots.txt`);
  const robotsOk = robots.ok && !/<html/i.test(robots.text.slice(0, 500));
  const blocksAll = robotsOk && /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(robots.text);
  checks.push(check('robots', 'robots.txt', !robotsOk ? 'warn' : blocksAll ? 'fail' : 'pass',
    !robotsOk ? 'Not found' : blocksAll ? 'Blocks all crawlers' : 'Found',
    !robotsOk ? 'Add a robots.txt file that points to your sitemap.' : blocksAll ? 'Your robots.txt blocks every page from Google.' : '', 1));

  const sitemapFromRobots = robotsOk ? (robots.text.match(/^sitemap:\s*(\S+)/im) || [])[1] : null;
  let sitemapUrl = sitemapFromRobots;
  let sitemapOk = false;
  for (const candidate of [sitemapFromRobots, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`].filter(Boolean)) {
    const s = await fetchText(candidate);
    if (s.ok && /<(urlset|sitemapindex)/i.test(s.text)) { sitemapOk = true; sitemapUrl = candidate; break; }
  }
  checks.push(check('sitemap', 'XML sitemap', sitemapOk ? 'pass' : 'fail',
    sitemapOk ? sitemapUrl.replace(origin, '') : 'Not found',
    sitemapOk ? '' : 'Create an XML sitemap and submit it in Google Search Console.', 1.5));

  // --- Server response ------------------------------------------------
  const t = page.timeMs;
  checks.push(check('response', 'Server response time', t < 800 ? 'pass' : t < 1800 ? 'warn' : 'fail',
    `${(t / 1000).toFixed(2)} s`, t < 800 ? '' : 'Slow server. Consider better hosting, page caching or a CDN.', 1));

  // --- Score ----------------------------------------------------------
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const order = { fail: 0, warn: 1, pass: 2 };
  checks.sort((a, b) => order[a.status] - order[b.status] || b.weight - a.weight);

  return {
    finalUrl: page.finalUrl,
    score: Math.round((got / total) * 100),
    summary: {
      passed: checks.filter(c => c.status === 'pass').length,
      warnings: checks.filter(c => c.status === 'warn').length,
      failed: checks.filter(c => c.status === 'fail').length,
    },
    checks: checks.map(({ weight, ...c }) => c),
  };
}
