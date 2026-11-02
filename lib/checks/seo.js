import { pass, warn, fail, info, plural, short, kb } from '../engine/run.js';
import { robotsAllows } from '../engine/probes.js';

// Page-level SEO checks. Each check reads the page model (m) and optional network
// results in ctx: ctx.probes (assets/links/images) and ctx.site (robots, sitemap, TLS…).
// Checks that need data that wasn't collected return null and are skipped.

export const SEO_CATEGORIES = ['Indexability', 'On-page', 'Content', 'Links', 'Images', 'Structured data', 'Social', 'Technical', 'Performance', 'Security', 'International', 'Site', 'AI search'];

const VALID_LANG = /^(x-default|[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Z]{2}|\d{3}))?)$/i;
const GENERIC_ANCHOR = /^(click here|here|read more|more|learn more|this|link|this page|go|details|click|continue|see more|view more|more info)$/i;
const words = s => (s || '').split(/\s+/).filter(Boolean).length;
const isHttps = m => m.protocol === 'https:';
const noindex = m => /noindex|none/.test(m.robotsMeta) || /noindex|none/.test(m.xRobots);

const REQUIRED_SCHEMA = {
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  Product: ['name', ['offers', 'review', 'aggregateRating']],
  Article: ['headline', ['author'], ['datePublished']],
  BlogPosting: ['headline', ['author'], ['datePublished']],
  NewsArticle: ['headline', ['datePublished']],
  BreadcrumbList: ['itemListElement'],
  FAQPage: ['mainEntity'],
  Event: ['name', 'startDate', 'location'],
  Recipe: ['name', 'image'],
  Review: ['itemReviewed', 'author'],
  VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
  WebSite: ['name', 'url'],
};
const LOCAL_TYPES = /LocalBusiness|Dentist|Restaurant|Store|MedicalBusiness|LegalService|HomeAndConstructionBusiness|AutoRepair|BeautySalon|HealthAndBeautyBusiness|ProfessionalService|RealEstateAgent|Hotel|Physician/;

// Checks that describe the whole site (run once on the homepage during a crawl)
export const SITE_SCOPE = new Set(['https', 'robots-txt', 'robots-sitemap', 'sitemap', 'sitemap-size', 'sitemap-http', 'sitemap-urls', 'http-redirect', 'www-resolve', 'soft-404', 'llms-txt', 'cert', 'tls', 'hsts', 'security-headers', 'server-leak', 'compression', 'schema-org']);

export const SEO_CHECKS = [
  // ---------------------------------------------------------------- Indexability
  { id: 'status', cat: 'Indexability', sev: 'high', label: 'Page returns 200 OK',
    run: m => m.status >= 200 && m.status < 300 ? pass(`HTTP ${m.status}`) : fail(`HTTP ${m.status}`, m.status >= 500 ? 'Server error. Google drops pages that keep returning 5xx.' : 'Search engines will not index pages that return an error.') },
  { id: 'noindex', cat: 'Indexability', sev: 'high', label: 'Not blocked by noindex',
    run: m => noindex(m) ? fail(m.xRobots.includes('noindex') ? 'X-Robots-Tag: noindex header' : 'meta robots noindex', 'Remove noindex if this page should appear in Google.') : pass('Indexable') },
  { id: 'nofollow-meta', cat: 'Indexability', sev: 'medium', label: 'Links on page can be followed',
    run: m => /nofollow|none/.test(m.robotsMeta + m.xRobots) ? warn('meta robots nofollow', 'Google will ignore every link on this page. Remove nofollow unless intended.') : pass('Followable') },
  { id: 'robots-blocked', cat: 'Indexability', sev: 'high', label: 'Not blocked by robots.txt',
    run: (m, c) => c.site?.robots?.found ? (robotsAllows(c.site.robots, m.path + m.search) ? pass('Allowed for Googlebot') : fail('Disallowed in robots.txt', 'Googlebot cannot crawl this page. Update the Disallow rule.')) : null },
  { id: 'canonical', cat: 'Indexability', sev: 'medium', label: 'Canonical tag',
    run: m => !m.canonicals.length ? warn('Missing', 'Add a self-referencing canonical to prevent duplicate-content issues.')
      : m.canonicals.length > 1 ? fail(`${m.canonicals.length} canonical tags`, 'Keep exactly one canonical tag; Google may ignore conflicting ones.')
      : !m.canonical ? fail('Invalid URL', 'The canonical URL is malformed.')
      : m.canonical.replace(/\/$/, '') === m.url.replace(/\/$/, '') ? pass('Self-referencing')
      : info(`Points to ${short(m.canonical)}`, 'This page tells Google another URL is the main version. Make sure that is intended.') },
  { id: 'canonical-target', cat: 'Indexability', sev: 'high', label: 'Canonical URL works',
    run: (m, c) => {
      if (!m.canonical || m.canonical.replace(/\/$/, '') === m.url.replace(/\/$/, '') || !c.probes) return null;
      const p = c.probes.links.find(l => l.url === m.canonical);
      if (!p) return null;
      return p.status >= 400 || p.status === 0 ? fail(`Canonical returns ${p.status || 'error'}`, 'The canonical points to a broken page.') : p.chain?.length ? warn('Canonical redirects', 'Point the canonical straight to the final URL.') : pass('OK');
    } },
  { id: 'redirect-chain', cat: 'Indexability', sev: 'medium', label: 'No redirect chain to reach page',
    run: m => m.chain.length > 1 ? warn(`${m.chain.length} redirects: ${m.chain.map(h => h.status).join(' → ')}`, 'Each hop wastes crawl budget and link equity. Redirect in one step.')
      : m.chain.length === 1 ? (m.chain[0].status === 302 || m.chain[0].status === 307 ? warn(`Temporary ${m.chain[0].status} redirect`, 'Use a 301 for permanent moves so Google transfers ranking signals.') : pass(`One ${m.chain[0].status} redirect`))
      : pass('Direct') },
  { id: 'meta-refresh', cat: 'Indexability', sev: 'medium', label: 'No meta refresh redirect',
    run: m => m.metaRefresh ? fail(`content="${m.metaRefresh.slice(0, 50)}"`, 'Replace meta refresh with a server-side 301 redirect.') : pass('None') },
  { id: 'url-length', cat: 'Indexability', sev: 'low', label: 'URL is short and clean',
    run: m => {
      const issues = [];
      if (m.url.length > 115) issues.push(`${m.url.length} chars`);
      if (/[A-Z]/.test(m.path)) issues.push('uppercase letters');
      if (/_/.test(m.path)) issues.push('underscores');
      if (/\/\//.test(m.path)) issues.push('double slashes');
      if ((m.search.match(/[?&]/g) || []).length > 2) issues.push('many parameters');
      if (/[^\x00-\x7F]/.test(decodeURIComponent(m.path).replace(/[ঀ-৿]/g, ''))) issues.push('non-ASCII characters');
      return issues.length ? warn(issues.join(', '), 'Use short, lowercase, hyphen-separated URLs.') : pass(`${m.url.length} chars`);
    } },

  // ---------------------------------------------------------------- On-page
  { id: 'title', cat: 'On-page', sev: 'high', label: 'Title tag',
    run: m => !m.title ? fail('Missing', 'Add a unique title with your main keyword and brand.')
      : m.title.length < 30 ? warn(`"${m.title}" (${m.title.length} chars)`, 'Too short. Use 30–60 characters with your main keyword.')
      : m.title.length > 60 ? warn(`${m.title.length} chars`, 'Google cuts titles around 60 characters. Shorten it.')
      : pass(`"${m.title}" (${m.title.length} chars)`) },
  { id: 'title-multiple', cat: 'On-page', sev: 'medium', label: 'Only one title tag',
    run: m => m.titles.length > 1 ? fail(`${m.titles.length} title tags`, 'Remove the extra title tags; usually a theme + SEO plugin both add one.') : m.titles.length ? pass('One') : null },
  { id: 'description', cat: 'On-page', sev: 'medium', label: 'Meta description',
    run: m => {
      const d = m.descriptions[0] || '';
      if (!d) return fail('Missing', 'Write a 120–160 character description that sells the click.');
      if (d.length < 70) return warn(`${d.length} chars`, 'Too short. Aim for 120–160 characters.');
      if (d.length > 160) return warn(`${d.length} chars`, 'Google cuts it after ~160 characters.');
      return pass(`${d.length} chars`);
    } },
  { id: 'description-multiple', cat: 'On-page', sev: 'low', label: 'Only one meta description',
    run: m => m.descriptions.length > 1 ? warn(`${m.descriptions.length} meta descriptions`, 'Keep a single description tag.') : m.descriptions.length ? pass('One') : null },
  { id: 'h1', cat: 'On-page', sev: 'high', label: 'One H1 heading',
    run: m => !m.h1.length ? fail('No H1', 'Add one H1 that says what the page is about.')
      : m.h1.length > 1 ? warn(`${m.h1.length} H1 tags`, 'Use one H1 and turn the others into H2s.')
      : !m.h1[0] ? fail('Empty H1', 'The H1 has no text.')
      : pass(`"${m.h1[0].slice(0, 80)}"`) },
  { id: 'h1-length', cat: 'On-page', sev: 'low', label: 'H1 length',
    run: m => m.h1[0] ? (m.h1[0].length > 70 ? warn(`${m.h1[0].length} chars`, 'Keep the H1 under 70 characters.') : pass(`${m.h1[0].length} chars`)) : null },
  { id: 'h1-title', cat: 'On-page', sev: 'low', label: 'H1 is not identical to title',
    run: m => m.h1[0] && m.title ? (m.h1[0].toLowerCase() === m.title.toLowerCase() ? warn('Same text', 'Use the title and H1 to target slightly different phrasing.') : pass('Different')) : null },
  { id: 'heading-order', cat: 'On-page', sev: 'low', label: 'Heading levels in order',
    run: m => {
      const skips = [];
      for (let i = 1; i < m.headings.length; i++) if (m.headings[i].level - m.headings[i - 1].level > 1) skips.push(`H${m.headings[i - 1].level}→H${m.headings[i].level}`);
      return m.headings.length < 2 ? null : skips.length ? warn([...new Set(skips)].slice(0, 4).join(', '), "Don't skip heading levels; it helps screen readers and Google understand structure.") : pass('Logical');
    } },
  { id: 'h2', cat: 'On-page', sev: 'low', label: 'Uses subheadings (H2)',
    run: m => { const n = m.headings.filter(h => h.level === 2).length; return n >= 2 ? pass(plural(n, 'H2')) : warn(plural(n, 'H2'), 'Break content into sections with H2s.'); } },
  { id: 'keyword-focus', cat: 'On-page', sev: 'low', label: 'Title and H1 share a keyword',
    run: m => {
      if (!m.title || !m.h1[0]) return null;
      const stop = new Set(['the', 'and', 'for', 'with', 'your', 'our', 'you', 'are', 'from', 'that', 'this', 'home', 'page', 'welcome', 'to', 'in', 'of', 'a']);
      const tw = new Set(m.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !stop.has(w)));
      const shared = m.h1[0].toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => tw.has(w));
      return shared.length ? pass(`Shared: ${[...new Set(shared)].slice(0, 3).join(', ')}`) : warn('No overlap', 'Use your main keyword in both the title and the H1.');
    } },

  // ---------------------------------------------------------------- Content
  { id: 'word-count', cat: 'Content', sev: 'medium', label: 'Enough text content',
    run: m => m.stats.words >= 300 ? pass(`${m.stats.words} words`) : m.stats.words >= 150 ? warn(`${m.stats.words} words`, 'Thin pages rank poorly. Aim for 300+ useful words.') : fail(`${m.stats.words} words`, 'Very little text. Google may treat this as thin content.') },
  { id: 'text-ratio', cat: 'Content', sev: 'low', label: 'Text-to-HTML ratio',
    run: m => m.textRatio >= 10 ? pass(`${m.textRatio}%`) : warn(`${m.textRatio}%`, 'Lots of code, little text. Remove bloat or add useful content.') },
  { id: 'readability', cat: 'Content', sev: 'low', label: 'Easy to read',
    run: m => m.stats.flesch == null ? null : m.stats.flesch >= 50 ? pass(`Reading ease ${m.stats.flesch}`) : warn(`Reading ease ${m.stats.flesch}`, 'Use shorter sentences and simpler words (aim for 60+).') },
  { id: 'paragraphs', cat: 'Content', sev: 'low', label: 'No walls of text',
    run: m => { const long = m.paragraphs.filter(n => n > 120).length; return !m.paragraphs.length ? null : long ? warn(plural(long, 'paragraph') + ' over 120 words', 'Split long paragraphs; most visitors scan.') : pass('Short paragraphs'); } },
  { id: 'deprecated', cat: 'Content', sev: 'low', label: 'No outdated HTML tags',
    run: m => m.deprecatedTags ? warn(plural(m.deprecatedTags, 'tag') + ' like <font>/<center>', 'Replace deprecated tags with CSS.') : pass('None') },

  // ---------------------------------------------------------------- Links
  { id: 'internal-links', cat: 'Links', sev: 'medium', label: 'Internal links',
    run: m => { const n = new Set(m.links.filter(l => l.internal).map(l => l.abs)).size; return n >= 5 ? pass(`${n} unique`) : n ? warn(`${n} unique`, 'Link to your key pages so Google can find and rank them.') : fail('None', 'No internal links. Add navigation and contextual links.'); } },
  { id: 'too-many-links', cat: 'Links', sev: 'low', label: 'Not too many links',
    run: m => m.links.length > 300 ? warn(`${m.links.length} links`, 'Too many links dilute their value. Trim menus and footers.') : pass(`${m.links.length} links`) },
  { id: 'broken-internal', cat: 'Links', sev: 'high', label: 'No broken internal links',
    run: (m, c) => { if (!c.probes) return null; const b = c.probes.links.filter(l => l.internal && (l.status >= 400 || l.status === 0)); const t = c.probes.links.filter(l => l.internal).length; return !t ? null : b.length ? fail(`${b.length} of ${t} checked`, 'Fix or redirect these links.', { items: b.map(l => `${l.status || 'ERR'} ${l.url}`) }) : pass(`${t} checked`); } },
  { id: 'broken-external', cat: 'Links', sev: 'medium', label: 'No broken external links',
    run: (m, c) => { if (!c.probes) return null; const ext = c.probes.links.filter(l => !l.internal); const b = ext.filter(l => l.status >= 400 && l.status !== 403 && l.status !== 429 || l.status === 0); return !ext.length ? null : b.length ? warn(`${b.length} of ${ext.length} checked`, 'Update or remove links to dead sites.', { items: b.map(l => `${l.status || 'ERR'} ${l.url}`) }) : pass(`${ext.length} checked`); } },
  { id: 'redirected-links', cat: 'Links', sev: 'low', label: 'Internal links point to final URLs',
    run: (m, c) => { if (!c.probes) return null; const r = c.probes.links.filter(l => l.internal && l.chain?.length && l.status < 400); return r.length ? warn(plural(r.length, 'link') + ' redirect', 'Update links to the final URL to save crawl budget.', { items: r.map(l => `${l.url} → ${l.finalUrl}`) }) : pass('None redirect'); } },
  { id: 'nofollow-internal', cat: 'Links', sev: 'low', label: 'Internal links are followed',
    run: m => { const n = m.links.filter(l => l.internal && l.rel.includes('nofollow')).length; return n ? warn(plural(n, 'internal link') + ' with nofollow', 'Remove nofollow from internal links so link equity flows.') : pass('All followed'); } },
  { id: 'anchor-empty', cat: 'Links', sev: 'low', label: 'Links have anchor text',
    run: m => { const n = m.links.filter(l => l.abs && !l.label).length; return n ? warn(plural(n, 'link') + ' with no text', 'Add text or aria-label so Google and screen readers know where the link goes.') : pass('All labeled'); } },
  { id: 'anchor-generic', cat: 'Links', sev: 'low', label: 'Descriptive anchor text',
    run: m => { const g = m.links.filter(l => GENERIC_ANCHOR.test(l.text)); return g.length ? warn(plural(g.length, 'link') + ` like "${g[0].text}"`, 'Use descriptive anchors like "SEO services" instead of "click here".') : pass('Descriptive'); } },
  { id: 'malformed-links', cat: 'Links', sev: 'medium', label: 'No malformed links',
    run: m => { const b = m.links.filter(l => l.malformed); return b.length ? fail(plural(b.length, 'link'), 'Fix these hrefs.', { items: b.map(l => l.href) }) : pass('None'); } },
  { id: 'http-links', cat: 'Links', sev: 'low', label: 'No links to HTTP pages',
    run: m => { if (!isHttps(m)) return null; const n = m.links.filter(l => l.abs?.startsWith('http://')); return n.length ? warn(plural(n.length, 'link') + ' to http://', 'Link to https versions where possible.', { items: n.map(l => l.abs) }) : pass('None'); } },
  { id: 'long-link-urls', cat: 'Links', sev: 'low', label: 'Link URLs not too long',
    run: m => { const n = m.links.filter(l => l.abs && l.abs.length > 200); return n.length ? warn(plural(n.length, 'URL') + ' over 200 chars', 'Shorten these URLs.') : pass('OK'); } },
  { id: 'noopener', cat: 'Links', sev: 'low', label: 'New-tab links use rel="noopener"',
    run: m => { const n = m.links.filter(l => l.target === '_blank' && !l.internal && !/noopener|noreferrer/.test(l.rel)).length; return n ? warn(plural(n, 'link'), 'Add rel="noopener" to target="_blank" links for security and speed.') : pass('OK'); } },

  // ---------------------------------------------------------------- Images
  { id: 'img-alt', cat: 'Images', sev: 'medium', label: 'Images have alt text',
    run: m => { const t = m.images.length; const n = m.images.filter(i => i.alt === undefined).length; return !t ? null : n ? (n / t > 0.3 ? fail : warn)(`${n} of ${t} missing alt`, 'Add descriptive alt text; it helps Google Images and accessibility.') : pass(`${t} images`); } },
  { id: 'img-broken', cat: 'Images', sev: 'high', label: 'No broken images',
    run: (m, c) => { if (!c.probes?.images.length) return null; const b = c.probes.images.filter(i => i.status >= 400 || i.status === 0); return b.length ? fail(plural(b.length, 'broken image'), 'Fix or remove these images.', { items: b.map(i => `${i.status || 'ERR'} ${i.url}`) }) : pass(`${c.probes.images.length} checked`); } },
  { id: 'img-size', cat: 'Images', sev: 'medium', label: 'Images are compressed',
    run: (m, c) => { if (!c.probes?.images.length) return null; const big = c.probes.images.filter(i => i.status < 400 && i.size > 200 * 1024); return big.length ? warn(plural(big.length, 'image') + ' over 200 KB', 'Compress and resize these images (TinyPNG, Squoosh, ShortPixel).', { items: big.map(i => `${kb(i.size)} ${i.url}`) }) : pass('All under 200 KB'); } },
  { id: 'img-format', cat: 'Images', sev: 'low', label: 'Modern image formats (WebP/AVIF)',
    run: (m, c) => { const ok = c.probes?.images.filter(i => i.status > 0 && i.status < 400); const list = ok?.length ? ok : m.images.filter(i => i.src).map(i => ({ url: i.src, ext: (i.src.match(/\.([a-z0-9]+)(\?|$)/i) || [])[1]?.toLowerCase(), type: '' })); if (!list.length) return null; const old = list.filter(i => /jpe?g|png|gif|bmp/.test(i.type || i.ext || '') && !/webp|avif|svg/.test(i.type || '')); return old.length ? warn(`${old.length} of ${list.length} JPG/PNG`, 'Serve WebP or AVIF; they are 25–50% smaller.') : pass('Modern formats'); } },
  { id: 'img-dimensions', cat: 'Images', sev: 'low', label: 'Images have width and height',
    run: m => { const t = m.images.filter(i => !i.inline).length; const n = m.images.filter(i => !i.inline && (!i.width || !i.height)).length; return !t ? null : n ? warn(`${n} of ${t} missing`, 'Set width/height to prevent layout shift (CLS).') : pass('All set'); } },
  { id: 'img-lazy', cat: 'Images', sev: 'low', label: 'Below-the-fold images lazy-load',
    run: m => { const below = m.images.filter(i => !i.early); if (below.length < 3) return null; const n = below.filter(i => i.loading !== 'lazy').length; return n > below.length / 2 ? warn(`${n} of ${below.length} not lazy`, 'Add loading="lazy" to images further down the page.') : pass('Lazy loading used'); } },
  { id: 'img-responsive', cat: 'Images', sev: 'low', label: 'Responsive images (srcset)',
    run: m => { const t = m.images.filter(i => i.src).length; if (t < 3) return null; const n = m.images.filter(i => i.srcset).length; return n ? pass(`${n} of ${t} use srcset`) : warn('No srcset', 'Serve smaller images to phones with srcset.'); } },

  // ---------------------------------------------------------------- Structured data
  { id: 'schema-present', cat: 'Structured data', sev: 'medium', label: 'Structured data present',
    run: m => m.schemaTypes.length ? pass(m.schemaTypes.slice(0, 6).join(', ')) : m.microdata ? pass('Microdata') : warn('None', 'Add JSON-LD schema (Organization, LocalBusiness, Product…) to win rich results.') },
  { id: 'schema-valid', cat: 'Structured data', sev: 'high', label: 'JSON-LD is valid',
    run: m => { if (!m.jsonld.length) return null; const bad = m.jsonld.filter(j => !j.ok); return bad.length ? fail(plural(bad.length, 'block') + ' with JSON errors', 'Fix syntax errors; Google ignores invalid JSON-LD.', { items: bad.map(b => b.error) }) : pass(plural(m.jsonld.length, 'block')); } },
  { id: 'schema-required', cat: 'Structured data', sev: 'medium', label: 'Schema has required fields',
    run: m => {
      const problems = [];
      for (const item of m.schemaItems) {
        for (const t of [].concat(item['@type'])) {
          const req = REQUIRED_SCHEMA[t] || (LOCAL_TYPES.test(t) ? REQUIRED_SCHEMA.LocalBusiness : null);
          if (!req) continue;
          const missing = req.filter(f => Array.isArray(f) ? !f.some(x => item[x]) : !item[f]).map(f => [].concat(f).join(' or '));
          if (missing.length) problems.push(`${t}: missing ${missing.join(', ')}`);
        }
      }
      return !m.schemaItems.length ? null : problems.length ? warn(plural(problems.length, 'item') + ' incomplete', 'Add the missing properties so the item qualifies for rich results.', { items: problems }) : pass('Complete');
    } },
  { id: 'schema-org', cat: 'Structured data', sev: 'low', label: 'Organization / LocalBusiness schema',
    run: m => m.path !== '/' ? null : m.schemaTypes.some(t => /Organization|Corporation/.test(t) || LOCAL_TYPES.test(t)) ? pass('Found') : warn('Missing on homepage', 'Add Organization or LocalBusiness schema with logo, contact and social profiles.') },
  { id: 'schema-breadcrumb', cat: 'Structured data', sev: 'low', label: 'Breadcrumb schema',
    run: m => m.path === '/' ? null : m.schemaTypes.includes('BreadcrumbList') ? pass('Found') : info('Missing', 'BreadcrumbList schema shows your site path in Google results.') },

  // ---------------------------------------------------------------- Social
  { id: 'og-basic', cat: 'Social', sev: 'medium', label: 'Open Graph title, description, image',
    run: m => { const miss = ['title', 'description', 'image'].filter(k => !m.og[k]); return miss.length === 3 ? fail('Missing', 'Add og:title, og:description and og:image so shared links look good.') : miss.length ? warn(`Missing og:${miss.join(', og:')}`, 'Complete the Open Graph tags.') : pass('Complete'); } },
  { id: 'og-url', cat: 'Social', sev: 'low', label: 'og:url and og:type',
    run: m => m.og.url && m.og.type ? pass('Set') : warn(`Missing ${[!m.og.url && 'og:url', !m.og.type && 'og:type'].filter(Boolean).join(', ')}`, 'Add og:url and og:type.') },
  { id: 'twitter-card', cat: 'Social', sev: 'low', label: 'Twitter / X card',
    run: m => m.twitter.card ? pass(m.twitter.card) : warn('Missing', 'Add <meta name="twitter:card" content="summary_large_image">.') },

  // ---------------------------------------------------------------- Technical
  { id: 'viewport', cat: 'Technical', sev: 'high', label: 'Mobile viewport tag',
    run: m => !m.viewport ? fail('Missing', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.') : !/width\s*=\s*device-width/i.test(m.viewport) ? fail(m.viewport, 'The viewport must include width=device-width.') : pass('OK') },
  { id: 'doctype', cat: 'Technical', sev: 'low', label: 'Doctype declared',
    run: m => m.doctype ? pass('<!DOCTYPE html>') : warn('Missing', 'Add <!DOCTYPE html> at the top so browsers use standards mode.') },
  { id: 'charset', cat: 'Technical', sev: 'low', label: 'Character encoding declared',
    run: m => m.charset ? pass(m.charset) : warn('Missing', 'Add <meta charset="utf-8">.') },
  { id: 'lang', cat: 'Technical', sev: 'low', label: 'Language declared',
    run: m => !m.lang ? warn('Missing', 'Add lang="en" (or your language) to the <html> tag.') : VALID_LANG.test(m.lang) ? pass(m.lang) : warn(`Invalid: ${m.lang}`, 'Use a valid language code like en or en-US.') },
  { id: 'favicon', cat: 'Technical', sev: 'low', label: 'Favicon',
    run: m => m.favicon ? pass(m.touchIcon ? 'Favicon + Apple touch icon' : 'Present') : warn('Missing', 'Add a favicon; Google shows it next to your mobile results.') },
  { id: 'html-size', cat: 'Technical', sev: 'medium', label: 'HTML size',
    run: m => m.htmlBytes > 2 * 1024 * 1024 ? fail(kb(m.htmlBytes), 'Pages over 2 MB may be cut off by Google.') : m.htmlBytes > 500 * 1024 ? warn(kb(m.htmlBytes), 'Large HTML slows rendering. Remove inline bloat.') : pass(kb(m.htmlBytes)) },
  { id: 'dom-size', cat: 'Technical', sev: 'low', label: 'DOM size',
    run: m => m.domNodes > 3000 ? warn(`${m.domNodes} elements`, 'Huge DOMs slow down phones. Simplify page-builder sections.') : pass(`${m.domNodes} elements`) },
  { id: 'frames', cat: 'Technical', sev: 'medium', label: 'No frames or plugins',
    run: m => m.frames || m.plugins ? warn(`${m.frames ? 'frames ' : ''}${m.plugins ? plural(m.plugins, 'plugin embed') : ''}`, 'Frames, Flash and <object> embeds are not indexed well.') : pass('None') },
  { id: 'semantic', cat: 'Technical', sev: 'low', label: 'Semantic HTML (header, nav, main…)',
    run: m => m.semantic.length >= 4 ? pass(m.semantic.join(', ')) : warn(m.semantic.join(', ') || 'None', 'Use <header>, <nav>, <main> and <footer>; AI search and screen readers rely on them.') },
  { id: 'amp', cat: 'Technical', sev: 'low', label: 'AMP page has canonical',
    run: m => m.isAmp ? (m.canonical ? pass('OK') : fail('Missing canonical', 'AMP pages must link to their canonical version.')) : null },
  { id: 'compression', cat: 'Technical', sev: 'medium', label: 'Page is compressed (gzip/brotli)',
    run: m => m.htmlBytes < 4096 ? null : /gzip|br|deflate|zstd/.test(m.headers['content-encoding'] || '') ? pass(m.headers['content-encoding']) : warn('Not compressed', 'Enable gzip or Brotli on the server (or via Cloudflare).') },

  // ---------------------------------------------------------------- Performance
  { id: 'ttfb', cat: 'Performance', sev: 'medium', label: 'Server response time',
    run: m => m.timeMs < 800 ? pass(`${(m.timeMs / 1000).toFixed(2)} s`) : m.timeMs < 1800 ? warn(`${(m.timeMs / 1000).toFixed(2)} s`, 'Use page caching, a CDN or faster hosting.') : fail(`${(m.timeMs / 1000).toFixed(2)} s`, 'Very slow server. Add full-page caching and a CDN.') },
  { id: 'render-blocking', cat: 'Performance', sev: 'medium', label: 'No render-blocking scripts',
    run: m => { const n = m.scripts.filter(s => s.src && s.inHead && !s.async && !s.defer && !s.module && (!s.type || /javascript/.test(s.type))).length; return n ? warn(plural(n, 'script') + ' in <head> without defer', 'Add defer or async so the page renders first.') : pass('None'); } },
  { id: 'asset-count', cat: 'Performance', sev: 'low', label: 'Number of JS and CSS files',
    run: m => { const n = m.scripts.filter(s => s.src).length + m.stylesheets.length; return n > 40 ? warn(`${n} files`, 'Combine or remove unused scripts and styles (plugins add many).') : pass(`${n} files`); } },
  { id: 'asset-size', cat: 'Performance', sev: 'medium', label: 'Total JS + CSS size',
    run: (m, c) => { if (!c.probes?.assets.length) return null; const t = c.probes.assets.reduce((s, a) => s + (a.size || 0), 0); return t > 2 * 1024 * 1024 ? fail(kb(t), 'Too much code. Remove unused plugins and scripts.') : t > 1024 * 1024 ? warn(kb(t), 'Heavy JS/CSS. Trim unused code.') : pass(kb(t)); } },
  { id: 'asset-broken', cat: 'Performance', sev: 'high', label: 'No broken JS/CSS files',
    run: (m, c) => { if (!c.probes?.assets.length) return null; const b = c.probes.assets.filter(a => a.status >= 400 || a.status === 0); return b.length ? fail(plural(b.length, 'file'), 'These files fail to load and may break the page.', { items: b.map(a => `${a.status || 'ERR'} ${a.url}`) }) : pass(`${c.probes.assets.length} checked`); } },
  { id: 'asset-compression', cat: 'Performance', sev: 'low', label: 'JS/CSS are compressed',
    run: (m, c) => { const list = c.probes?.assets.filter(a => a.internal && a.status < 400 && a.size > 1500 && a.encoding !== undefined); if (!list?.length) return null; const n = list.filter(a => !/gzip|br|deflate|zstd/.test(a.encoding)); return n.length ? warn(`${n.length} of ${list.length} uncompressed`, 'Enable gzip/Brotli for JS and CSS.', { items: n.map(a => a.url) }) : pass('Compressed'); } },
  { id: 'asset-cache', cat: 'Performance', sev: 'low', label: 'JS/CSS are cached',
    run: (m, c) => { const list = c.probes?.assets.filter(a => a.internal && a.status < 400); if (!list?.length) return null; const n = list.filter(a => a.cache === null || a.cache < 86400); return n.length ? warn(`${n.length} of ${list.length} not cached`, 'Set Cache-Control max-age of at least 30 days for static files.', { items: n.map(a => a.url) }) : pass('Cached'); } },
  { id: 'asset-minified', cat: 'Performance', sev: 'low', label: 'JS/CSS are minified',
    run: (m, c) => { const list = c.probes?.assets.filter(a => a.minified !== null && a.minified !== undefined); if (!list?.length) return null; const n = list.filter(a => !a.minified); return n.length ? warn(`${n.length} of ${list.length} unminified`, 'Minify CSS and JS (most cache plugins can do this).', { items: n.map(a => a.url) }) : pass('Minified'); } },
  { id: 'inline-css', cat: 'Performance', sev: 'low', label: 'Inline CSS size',
    run: m => m.inlineCss > 100 * 1024 ? warn(kb(m.inlineCss), 'Move large inline styles to cached CSS files.') : pass(kb(m.inlineCss)) },

  // ---------------------------------------------------------------- Security
  { id: 'https', cat: 'Security', sev: 'high', label: 'Uses HTTPS',
    run: m => isHttps(m) ? pass('Secure') : fail('Not secure', 'Install SSL and redirect all traffic to https.') },
  { id: 'mixed-content', cat: 'Security', sev: 'high', label: 'No mixed content',
    run: m => { if (!isHttps(m)) return null; const list = [...m.images.map(i => i.src), ...m.scripts.map(s => s.src), ...m.stylesheets.map(s => s.href), ...m.iframes].filter(u => u?.startsWith('http://')); return list.length ? fail(plural(list.length, 'http:// resource'), 'Load every file over https or browsers will block it.', { items: list }) : pass('None'); } },
  { id: 'hsts', cat: 'Security', sev: 'low', label: 'HSTS header',
    run: m => !isHttps(m) ? null : m.headers['strict-transport-security'] ? pass('Enabled') : warn('Missing', 'Add Strict-Transport-Security to force https.') },
  { id: 'security-headers', cat: 'Security', sev: 'low', label: 'Security headers',
    run: m => { const miss = [['x-content-type-options', 'X-Content-Type-Options'], ['x-frame-options', 'X-Frame-Options'], ['referrer-policy', 'Referrer-Policy']].filter(([h]) => !m.headers[h] && !(h === 'x-frame-options' && /frame-ancestors/.test(m.headers['content-security-policy'] || ''))).map(([, n]) => n); return miss.length ? warn(`Missing ${miss.join(', ')}`, 'Add basic security headers (easy with Cloudflare or a security plugin).') : pass('Set'); } },
  { id: 'cert', cat: 'Security', sev: 'high', label: 'SSL certificate valid',
    run: (m, c) => { const x = c.site?.cert; if (!x?.tested) return null; if (!x.authorized) return fail(x.error || 'Invalid', 'Fix the SSL certificate (wrong name, expired or self-signed).'); if (x.daysLeft != null && x.daysLeft < 0) return fail('Expired', 'Renew the certificate now.'); if (x.daysLeft != null && x.daysLeft < 14) return warn(`Expires in ${x.daysLeft} days`, 'Renew soon or enable auto-renewal.'); return pass(`${x.issuer || 'Valid'}${x.daysLeft != null ? ` · ${x.daysLeft} days left` : ''}`); } },
  { id: 'tls', cat: 'Security', sev: 'medium', label: 'Modern TLS version',
    run: (m, c) => { const p = c.site?.cert?.protocol; if (!p) return null; return /TLSv1\.[23]/.test(p) ? pass(p) : fail(p, 'Disable old TLS 1.0/1.1; use TLS 1.2+.'); } },
  { id: 'server-leak', cat: 'Security', sev: 'low', label: 'Server version not exposed',
    run: m => { const v = [m.headers['x-powered-by'], /\d/.test(m.headers.server || '') ? m.headers.server : null].filter(Boolean); return v.length ? info(v.join(', '), 'Hide server/PHP versions to make attacks harder.') : pass('Hidden'); } },

  // ---------------------------------------------------------------- International
  { id: 'hreflang-valid', cat: 'International', sev: 'medium', label: 'Valid hreflang values',
    run: m => { if (!m.hreflang.length) return null; const bad = m.hreflang.filter(h => !VALID_LANG.test(h.lang) || !h.href); return bad.length ? fail(bad.map(b => b.lang).join(', '), 'Use ISO codes like en, en-GB, bn-BD or x-default.') : pass(m.hreflang.map(h => h.lang).join(', ')); } },
  { id: 'hreflang-self', cat: 'International', sev: 'low', label: 'hreflang includes this page',
    run: m => !m.hreflang.length ? null : m.hreflang.some(h => h.href?.replace(/\/$/, '') === m.url.replace(/\/$/, '')) ? pass('Self-reference found') : warn('No self-reference', 'Each hreflang set must include the page itself.') },
  { id: 'hreflang-default', cat: 'International', sev: 'low', label: 'hreflang x-default',
    run: m => !m.hreflang.length ? null : m.hreflang.some(h => h.lang.toLowerCase() === 'x-default') ? pass('Set') : info('Missing', 'Add x-default for visitors whose language you do not target.') },
  { id: 'hreflang-lang', cat: 'International', sev: 'low', label: 'hreflang matches page language',
    run: m => { if (!m.hreflang.length || !m.lang) return null; const self = m.hreflang.find(h => h.href?.replace(/\/$/, '') === m.url.replace(/\/$/, '')); return !self || self.lang === 'x-default' ? null : self.lang.slice(0, 2).toLowerCase() === m.lang.slice(0, 2).toLowerCase() ? pass('Matches') : warn(`hreflang ${self.lang} vs lang ${m.lang}`, 'Make the hreflang code match the page language.'); } },

  // ---------------------------------------------------------------- Site
  { id: 'robots-txt', cat: 'Site', sev: 'medium', label: 'robots.txt',
    run: (m, c) => { const r = c.site?.robots; if (!r) return null; if (!r.found) return warn('Not found', 'Add a robots.txt that points to your sitemap.'); const blocksAll = r.groups.some(g => g.agents.includes('*') && g.rules.some(x => !x.allow && x.path === '/')) && !robotsAllows(r, '/'); if (blocksAll) return fail('Blocks the whole site', 'Your robots.txt blocks Google from every page.'); return r.errors.length ? warn(plural(r.errors.length, 'format error'), 'Fix invalid lines in robots.txt.', { items: r.errors }) : pass('Found and valid'); } },
  { id: 'robots-sitemap', cat: 'Site', sev: 'low', label: 'Sitemap listed in robots.txt',
    run: (m, c) => { const r = c.site?.robots; if (!r?.found) return null; return r.sitemaps.length ? pass(r.sitemaps[0]) : warn('Not listed', 'Add "Sitemap: https://yoursite.com/sitemap.xml" to robots.txt.'); } },
  { id: 'robots-resources', cat: 'Site', sev: 'medium', label: 'CSS/JS not blocked by robots.txt',
    run: (m, c) => { const r = c.site?.robots; if (!r?.found) return null; const files = [...m.scripts.map(s => s.src), ...m.stylesheets.map(s => s.href)].filter(u => { try { return new URL(u).hostname.replace(/^www\./, '') === m.host; } catch { return false; } }); const blocked = files.filter(u => !robotsAllows(r, new URL(u).pathname)); return !files.length ? null : blocked.length ? fail(plural(blocked.length, 'file') + ' blocked', 'Google needs CSS/JS to render your page. Allow them in robots.txt.', { items: blocked }) : pass('Allowed'); } },
  { id: 'sitemap', cat: 'Site', sev: 'high', label: 'XML sitemap',
    run: (m, c) => { const s = c.site?.sitemap; if (!s) return null; if (!s.found) return fail('Not found', 'Create an XML sitemap and submit it in Google Search Console.'); if (!s.valid) return fail('Invalid XML', 'Fix the sitemap format.'); return pass(`${s.count} URLs${s.isIndex ? ` in ${s.children} sitemaps` : ''}`); } },
  { id: 'sitemap-size', cat: 'Site', sev: 'medium', label: 'Sitemap within limits',
    run: (m, c) => { const s = c.site?.sitemap; if (!s?.found || s.isIndex) return null; return s.count > 50000 || s.bytes > 50 * 1024 * 1024 ? fail(`${s.count} URLs, ${kb(s.bytes)}`, 'Split into multiple sitemaps (max 50,000 URLs / 50 MB each).') : pass(`${s.count} URLs · ${kb(s.bytes)}`); } },
  { id: 'sitemap-http', cat: 'Site', sev: 'medium', label: 'Sitemap uses https URLs',
    run: (m, c) => { const s = c.site?.sitemap; if (!s?.found || !isHttps(m)) return null; return s.httpUrls ? fail(plural(s.httpUrls, 'http:// URL'), 'List only the https versions in your sitemap.') : pass('All https'); } },
  { id: 'sitemap-urls', cat: 'Site', sev: 'medium', label: 'Sitemap URLs return 200',
    run: (m, c) => { const s = c.site?.sitemap; if (!s?.sample?.length) return null; const bad = s.sample.filter(x => x.status >= 300 || x.status === 0 || x.redirected); return bad.length ? warn(`${bad.length} of ${s.sample.length} sampled`, 'Sitemaps should only list live, non-redirecting pages.', { items: bad.map(b => `${b.redirected ? 'redirect' : b.status || 'ERR'} ${b.url}`) }) : pass(`${s.sample.length} sampled`); } },
  { id: 'http-redirect', cat: 'Site', sev: 'high', label: 'HTTP redirects to HTTPS',
    run: (m, c) => { const h = c.site?.https; if (!h?.tested || !isHttps(m)) return null; return h.redirects ? pass('Yes') : fail('No', 'Redirect http:// to https:// so visitors and Google always get the secure version.'); } },
  { id: 'www-resolve', cat: 'Site', sev: 'medium', label: 'www and non-www resolve to one URL',
    run: (m, c) => { const w = c.site?.www; if (!w?.tested) return null; return w.same ? pass(`Both go to ${w.aHost}`) : fail(`${w.aHost} and ${w.bHost} both load`, 'Redirect one version to the other to avoid duplicate sites.'); } },
  { id: 'soft-404', cat: 'Site', sev: 'medium', label: 'Missing pages return 404',
    run: (m, c) => { const n = c.site?.notFound; if (!n?.tested) return null; return n.status === 404 || n.status === 410 ? pass(`HTTP ${n.status}`) : n.redirectedHome ? warn('Redirects to homepage', 'Return a real 404 with helpful links instead of redirecting.') : fail(`HTTP ${n.status}`, 'Unknown URLs return 200 (soft 404). Configure a proper 404 page.'); } },

  // ---------------------------------------------------------------- AI search
  { id: 'llms-txt', cat: 'AI search', sev: 'low', label: 'llms.txt file',
    run: (m, c) => { const l = c.site?.llms; if (!l) return null; return l.found ? (l.formatted ? pass('Found') : warn('Found, unusual format', 'Start llms.txt with a "# Site name" heading and short sections.')) : info('Not found', 'An llms.txt helps AI assistants understand your site (optional, emerging standard).'); } },
  { id: 'ai-structure', cat: 'AI search', sev: 'low', label: 'Answer-friendly structure',
    run: m => { const q = m.headings.filter(h => h.level >= 2 && /\?$/.test(h.text)).length; const ok = m.lists > 3 || q > 0 || m.schemaTypes.includes('FAQPage'); return ok ? pass(`${q ? plural(q, 'question heading') + ', ' : ''}${m.lists} list items`) : info('Few lists or Q&A headings', 'Question-style headings, lists and FAQs get quoted more by AI search.'); } },
];
