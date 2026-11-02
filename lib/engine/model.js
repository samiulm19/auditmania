import * as cheerio from 'cheerio';

// Parses a page ONCE into a plain "page model". Every SEO and CRO check reads from this
// object instead of re-parsing HTML, so adding a new check never adds parsing cost.

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const bare = h => String(h || '').replace(/^www\./i, '').toLowerCase();

function abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

// ---------- text statistics ----------
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

function textStats(text) {
  const words = text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  const sentences = text.split(/[.!?।]+\s/).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 3);
  const latinWords = words.filter(w => /^[a-z'’-]+[.,!?;:]*$/i.test(w));
  const isLatin = words.length > 0 && latinWords.length / words.length > 0.7;
  let flesch = null;
  if (isLatin && words.length >= 80 && sentences.length >= 3) {
    const syl = latinWords.reduce((s, w) => s + syllables(w), 0);
    flesch = Math.round(206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syl / latinWords.length));
  }
  const lower = ` ${text.toLowerCase()} `;
  const count = re => (lower.match(re) || []).length;
  return {
    words: words.length,
    sentences: sentences.length,
    avgSentence: sentences.length ? Math.round(words.length / sentences.length) : 0,
    flesch,
    isLatin,
    you: count(/\b(you|your|yours|you're|you’ll|you'll)\b/g),
    we: count(/\b(we|our|ours|us|we're|we’re)\b/g),
  };
}

// MinHash signature for near-duplicate content detection across pages
function fnv(str, seed) {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function minhash(text, k = 48) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 50) return null;
  const sig = new Array(k).fill(0xffffffff);
  for (let i = 0; i + 5 <= words.length; i++) {
    const sh = words.slice(i, i + 5).join(' ');
    for (let j = 0; j < k; j++) { const h = fnv(sh, j * 0x9e3779b1); if (h < sig[j]) sig[j] = h; }
  }
  return sig;
}
export function similarity(a, b) {
  if (!a || !b) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

// ---------- detectors ----------
const PLATFORMS = [
  ['WordPress', /wp-content\/|wp-includes\//i],
  ['Shopify', /cdn\.shopify\.com|Shopify\.theme/i],
  ['Webflow', /webflow\.(js|com)|data-wf-page/i],
  ['Wix', /static\.wixstatic\.com|wix-code/i],
  ['Squarespace', /squarespace\.com|static1\.squarespace/i],
  ['Framer', /framerusercontent\.com|framer\.com\/m\//i],
  ['Next.js', /\/_next\/static\//i],
  ['Elementor', /elementor/i],
  ['WooCommerce', /woocommerce/i],
];
const TRACKERS = {
  analytics: [['Google Analytics', /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i], ['Google Tag Manager', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/], ['Plausible', /plausible\.io\/js/i], ['Matomo', /matomo|piwik/i], ['Fathom', /usefathom\.com/i], ['Mixpanel', /mixpanel/i], ['Segment', /cdn\.segment\.com/i]],
  heatmap: [['Microsoft Clarity', /clarity\.ms/i], ['Hotjar', /hotjar/i], ['FullStory', /fullstory/i], ['Mouseflow', /mouseflow/i], ['Lucky Orange', /luckyorange/i], ['Crazy Egg', /crazyegg/i]],
  ads: [['Meta Pixel', /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(/i], ['Google Ads', /AW-\d{6,}/], ['TikTok Pixel', /analytics\.tiktok\.com/i], ['LinkedIn Insight', /snap\.licdn\.com/i]],
  chat: [['Tawk.to', /tawk\.to/i], ['Crisp', /client\.crisp\.chat/i], ['Intercom', /intercom/i], ['Drift', /js\.driftt\.com|drift\.com/i], ['Tidio', /tidio/i], ['HubSpot', /js\.hs-scripts\.com|hs-scripts/i], ['Zendesk', /zdassets\.com|zopim/i], ['LiveChat', /livechatinc\.com/i], ['Messenger', /xfbml\.customerchat/i], ['Freshchat', /freshchat|wchat\.freshchat/i]],
  popup: [['OptinMonster', /optinmonster|omappapi/i], ['Sumo', /sumo\.com|load\.sumo/i], ['Privy', /privy\.com/i], ['Popup Maker', /popup-maker|pum-/i], ['Klaviyo', /klaviyo/i], ['Elementor Popup', /elementor-popup|elementor-location-popup/i]],
  consent: [['Cookiebot', /cookiebot/i], ['OneTrust', /onetrust|optanon/i], ['CookieYes', /cookieyes/i], ['Complianz', /complianz/i], ['Termly', /termly/i]],
  booking: [['Calendly', /calendly\.com/i], ['Cal.com', /cal\.com\//i], ['Acuity', /acuityscheduling/i], ['SimplyBook', /simplybook/i]],
};
function detect(html, list) { return list.filter(([, re]) => re.test(html)).map(([n]) => n); }

const GENERIC_CTA = /^(submit|send|click here|click|here|learn more|read more|more|go|ok|continue|details|view|see more|next)$/i;
const CTA_HINT = /btn|button|cta|wp-block-button|elementor-button|shopify-payment|add-to-cart|hero/i;

// ---------- main ----------
export function buildModel(page) {
  const html = page.html || '';
  const $ = cheerio.load(html);
  const url = page.finalUrl || page.url;
  const u = new URL(url);
  const host = bare(u.hostname);
  const H = Object.fromEntries(Object.entries(page.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

  // DOM order index so we can approximate "near the top of the page"
  let order = 0;
  const pos = new Map();
  $('body *').each((_, el) => { pos.set(el, order++); });
  const totalNodes = order || 1;
  const firstH2 = $('body h2').first().get(0);
  const firstH2Pos = firstH2 ? pos.get(firstH2) : Math.round(totalNodes * 0.35);
  const early = el => (pos.get(el) ?? totalNodes) <= Math.max(firstH2Pos, Math.round(totalNodes * 0.15));

  // Text
  const $main = $('body').clone();
  $main.find('script,style,noscript,svg,template,iframe').remove();
  const bodyText = clean($main.text());
  const $content = $main.clone();
  $content.find('nav,header,footer,aside,form').remove();
  const contentText = clean($content.text()) || bodyText;
  const stats = textStats(contentText);

  const metaContent = sel => $(sel).map((_, el) => clean($(el).attr('content'))).get();
  const titles = $('head title, title').filter((_, el) => !$(el).closest('svg').length).map((_, el) => clean($(el).text())).get();

  const headings = $('h1,h2,h3,h4,h5,h6').map((_, el) => ({ level: Number(el.tagName[1]), text: clean($(el).text()), early: early(el) })).get();

  // Links
  const links = $('a').map((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();
    const a = href && !/^(javascript:|mailto:|tel:|#|sms:|data:)/i.test(href) ? abs(href, url) : null;
    let internal = false;
    if (a) { try { internal = bare(new URL(a).hostname) === host; } catch { /* ignore */ } }
    const text = clean($a.text());
    const label = text || clean($a.attr('aria-label')) || clean($a.attr('title')) || clean($a.find('img').attr('alt'));
    return {
      href, abs: a, internal, text, label,
      rel: ($a.attr('rel') || '').toLowerCase(),
      target: $a.attr('target') || '',
      hasImg: $a.find('img,svg').length > 0,
      malformed: !!href && !a && !/^(javascript:|mailto:|tel:|#|sms:)/i.test(href),
      early: early(el),
      cls: ($a.attr('class') || '') + ' ' + ($a.parent().attr('class') || ''),
    };
  }).get();

  // Images
  const images = $('img').map((_, el) => {
    const $i = $(el);
    const src = $i.attr('src') || $i.attr('data-src') || $i.attr('data-lazy-src') || '';
    return {
      src: src && !src.startsWith('data:') ? abs(src, url) : null,
      inline: src.startsWith('data:'),
      alt: $i.attr('alt'),
      width: $i.attr('width'), height: $i.attr('height'),
      loading: ($i.attr('loading') || '').toLowerCase(),
      srcset: !!($i.attr('srcset') || $i.attr('data-srcset')),
      early: early(el),
    };
  }).get();

  // Scripts & styles
  const scripts = $('script').map((_, el) => {
    const $s = $(el);
    const src = $s.attr('src');
    return {
      src: src ? abs(src, url) : null,
      inHead: $s.parents('head').length > 0,
      async: $s.attr('async') !== undefined,
      defer: $s.attr('defer') !== undefined,
      module: ($s.attr('type') || '') === 'module',
      type: ($s.attr('type') || '').toLowerCase(),
      inlineLength: src ? 0 : ($s.html() || '').length,
    };
  }).get();
  const stylesheets = $('link[rel~="stylesheet"]').map((_, el) => ({
    href: abs($(el).attr('href') || '', url),
    inHead: $(el).parents('head').length > 0,
    media: $(el).attr('media') || '',
  })).get().filter(s => s.href);
  const inlineCss = $('style').map((_, el) => ($(el).html() || '').length).get().reduce((a, b) => a + b, 0);

  // Structured data
  const jsonld = $('script[type="application/ld+json"]').map((_, el) => {
    const raw = $(el).contents().text();
    try {
      const data = JSON.parse(raw);
      const items = [];
      const walk = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n['@type']) items.push(n);
        if (n['@graph']) walk(n['@graph']);
      };
      walk(data);
      return { ok: true, items };
    } catch (e) {
      return { ok: false, error: e.message, items: [] };
    }
  }).get();
  const schemaItems = jsonld.flatMap(j => j.items);
  const schemaTypes = [...new Set(schemaItems.flatMap(i => [].concat(i['@type'])).filter(Boolean))];

  // Forms
  const forms = $('form').map((_, f) => {
    const $f = $(f);
    const fields = $f.find('input, select, textarea').filter((_, el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(($(el).attr('type') || '').toLowerCase())).map((_, el) => {
      const $el = $(el);
      const id = $el.attr('id');
      const name = ($el.attr('name') || '').toLowerCase();
      const hasLabel = !!(($el.attr('aria-label') || '').trim() || $el.attr('aria-labelledby') || (id && $f.find(`label[for="${id.replace(/"/g, '')}"]`).length) || $el.closest('label').length);
      return {
        tag: el.tagName,
        type: ($el.attr('type') || (el.tagName === 'input' ? 'text' : el.tagName)).toLowerCase(),
        name,
        hint: `${name} ${$el.attr('id') || ''} ${$el.attr('placeholder') || ''} ${$el.attr('autocomplete') || ''}`.toLowerCase(),
        required: $el.attr('required') !== undefined || $el.attr('aria-required') === 'true',
        hasLabel,
        placeholder: !!$el.attr('placeholder'),
        autocomplete: !!$el.attr('autocomplete'),
      };
    }).get();
    const submit = clean($f.find('button, input[type="submit"]').map((_, b) => $(b).text() || $(b).attr('value')).get()[0] || '');
    const isSearch = ($f.attr('role') || '') === 'search' || fields.some(x => x.type === 'search') || /search/i.test($f.attr('action') || '') || (fields.length === 1 && /\bs\b|q\b|search/.test(fields[0].name));
    const isNewsletter = !isSearch && fields.length <= 2 && fields.some(x => x.type === 'email' || /email/.test(x.hint)) && /subscribe|newsletter|sign up|join/i.test(submit + ' ' + $f.text());
    return {
      fields, submit, isSearch, isNewsletter,
      captcha: /g-recaptcha|h-captcha|cf-turnstile/i.test($f.html() || ''),
      privacyNote: /privacy|spam|never share|unsubscribe/i.test($f.text()),
      early: early(f),
    };
  }).get();

  // CTAs (buttons and button-styled links)
  const ctaEls = $('button, a, input[type="submit"]').filter((_, el) => {
    const $e = $(el);
    if (el.tagName === 'button' || el.tagName === 'input') return !$e.closest('nav').length;
    return CTA_HINT.test(`${$e.attr('class') || ''} ${$e.parent().attr('class') || ''} ${$e.attr('role') || ''}`);
  });
  const ctas = ctaEls.map((_, el) => {
    const $e = $(el);
    const text = clean($e.text() || $e.attr('value') || $e.attr('aria-label'));
    return { text, early: early(el), generic: GENERIC_CTA.test(text), pos: pos.get(el) ?? 0, inForm: $e.closest('form').length > 0 };
  }).get().filter(c => c.text && c.text.length <= 60 && !/^(×|x|close|menu|toggle|search|prev|previous|next|›|‹|»|«)$/i.test(c.text));

  // Contact & trust
  const tel = $('a[href^="tel:"]');
  const lowerText = bodyText.toLowerCase();
  const hasText = re => re.test(lowerText);
  const linkTo = re => links.some(l => re.test(`${l.abs || ''} ${l.text}`.toLowerCase()));

  const viewport = $('meta[name="viewport"]').attr('content') || null;
  const charsetMeta = $('meta[charset]').attr('charset') || ($('meta[http-equiv="Content-Type" i]').attr('content') || '').match(/charset=([\w-]+)/i)?.[1] || null;
  const headerCharset = (H['content-type'] || '').match(/charset=([\w-]+)/i)?.[1] || null;

  return {
    url, host, origin: u.origin, protocol: u.protocol, path: u.pathname, search: u.search,
    status: page.status, timeMs: page.timeMs || 0, chain: page.chain || [], headers: H,
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    textRatio: html.length ? Math.round((contentText.length / html.length) * 1000) / 10 : 0,
    doctype: /^\s*(<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html),
    charset: charsetMeta || headerCharset,
    lang: $('html').attr('lang') || null,
    titles, title: titles[0] || '',
    descriptions: metaContent('meta[name="description" i]'),
    robotsMeta: metaContent('meta[name="robots" i], meta[name="googlebot" i]').join(',').toLowerCase(),
    xRobots: (H['x-robots-tag'] || '').toLowerCase(),
    viewport,
    metaRefresh: $('meta[http-equiv="refresh" i]').attr('content') || null,
    canonicals: $('link[rel="canonical"]').map((_, el) => $(el).attr('href') || '').get(),
    canonical: (() => { const c = $('link[rel="canonical"]').first().attr('href'); return c ? abs(c, url) : null; })(),
    hreflang: $('link[rel="alternate"][hreflang]').map((_, el) => ({ lang: ($(el).attr('hreflang') || '').trim(), href: abs($(el).attr('href') || '', url) })).get(),
    amp: $('link[rel="amphtml"]').attr('href') || null,
    isAmp: $('html').is('[amp], [⚡]'),
    headings, h1: headings.filter(h => h.level === 1).map(h => h.text),
    text: contentText.slice(0, 20000), stats, minhash: minhash(contentText),
    paragraphs: $('p').map((_, el) => clean($(el).text()).split(/\s+/).filter(Boolean).length).get(),
    lists: $('ul li, ol li').length,
    links, images, scripts, stylesheets, inlineCss,
    iframes: $('iframe').map((_, el) => abs($(el).attr('src') || '', url)).get().filter(Boolean),
    frames: $('frameset, frame').length,
    plugins: $('object, embed, applet').length,
    deprecatedTags: $('font, center, marquee, blink').length,
    domNodes: $('*').length,
    semantic: ['header', 'nav', 'main', 'article', 'section', 'footer', 'aside'].filter(t => $(t).length),
    jsonld, schemaItems, schemaTypes,
    microdata: $('[itemscope]').length,
    og: Object.fromEntries(['title', 'description', 'image', 'url', 'type', 'site_name'].map(k => [k, $(`meta[property="og:${k}"]`).attr('content') || null])),
    twitter: Object.fromEntries(['card', 'title', 'description', 'image'].map(k => [k, $(`meta[name="twitter:${k}"]`).attr('content') || null])),
    favicon: $('link[rel~="icon"]').length > 0,
    touchIcon: $('link[rel="apple-touch-icon"]').length > 0,
    generator: $('meta[name="generator"]').attr('content') || null,
    platforms: detect(html, PLATFORMS),
    trackers: Object.fromEntries(Object.entries(TRACKERS).map(([k, list]) => [k, detect(html, list)])),
    forms, ctas,
    nav: { exists: $('nav').length > 0, items: [...new Set($('nav a, header a').map((_, el) => clean($(el).text())).get().filter(t => t && t.length < 40))] },
    logoHome: $('header a, nav a, a').filter((_, el) => /^(\/|#|\.\/?)?$/.test(($(el).attr('href') || '').replace(u.origin, '')) && $(el).find('img, svg').length > 0).length > 0,
    searchBox: $('input[type="search"], form[role="search"]').length > 0,
    breadcrumb: schemaTypes.includes('BreadcrumbList') || $('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]').length > 0,
    contact: {
      tel: tel.length, telEarly: tel.filter((_, el) => early(el)).length > 0,
      email: $('a[href^="mailto:"]').length,
      whatsapp: $('a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="whatsapp://"]').length,
      contactLink: linkTo(/\/contact|contact us|get in touch|যোগাযোগ/),
      contactEarly: links.some(l => l.early && /contact|get in touch|call/i.test(`${l.abs} ${l.text}`)),
      address: $('address').length > 0 || schemaItems.some(i => i.address) || hasText(/\b(road|street|st\.|avenue|ave\.|suite|floor|house\s*#|dhaka|gazipur)\b.{0,40}\d|\d{3,5}\s+\w+\s+(road|street|ave)/),
      map: $('iframe[src*="google.com/maps"], iframe[src*="maps.google"], a[href*="maps.app.goo.gl"], a[href*="google.com/maps"]').length > 0,
      hours: hasText(/\b(opening hours|business hours|mon\s*[-–]\s*(fri|sat)|monday\s*[-–]|open\s+(daily|24))/),
    },
    trust: {
      testimonials: hasText(/testimonial|what (our )?(clients|customers) say|reviews?\b|client stories|happy (clients|customers)/),
      ratings: /★|⭐|\b[45](\.\d)?\s*(\/\s*5|out of 5|stars?)\b/i.test(bodyText) || schemaItems.some(i => i.aggregateRating || [].concat(i['@type']).includes('AggregateRating')) || /trustpilot|google-reviews|elfsight|yotpo|judge\.me|reviews\.io|stamped/i.test(html),
      logos: hasText(/trusted by|our clients|clients include|as seen (on|in)|featured (in|on)|our partners|brands we/),
      guarantee: hasText(/guarantee|money[- ]back|refund|risk[- ]free|no questions asked/),
      certifications: hasText(/certified|accredited|licensed|award|iso \d|member of|partner badge/),
      numbers: /\b\d[\d,]*\+?\s*(happy\s+)?(clients|customers|projects|reviews|students|patients|years|businesses|users|orders)\b/i.test(bodyText) || /\bsince (19|20)\d{2}\b/i.test(bodyText),
      caseStudies: linkTo(/case-stud|case stud|portfolio|our work|success stor/),
      about: linkTo(/\/about|about us|our story|who we are/),
      privacy: linkTo(/privacy/),
      terms: linkTo(/terms|conditions/),
      team: hasText(/our team|meet the team|meet our/),
    },
    offer: {
      free: hasText(/\bfree\b/),
      discount: hasText(/\d+\s?% off|discount|save \$?\d|coupon|promo/),
      urgency: hasText(/limited time|today only|ends (soon|tonight|today)|only \d+ (left|spots)|last chance|hurry|offer ends|countdown/),
      pricing: /[$€£৳]\s?\d|\d\s?(usd|bdt|tk)\b/i.test(bodyText) || linkTo(/pricing|price|plans|packages/),
      faq: headings.some(h => /faq|frequently asked|questions/i.test(h.text)) || schemaTypes.includes('FAQPage'),
    },
    media: {
      video: $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="wistia"], iframe[src*="loom.com"]').length,
      heroMedia: images.some(i => i.early) || $('video').filter((_, el) => early(el)).length > 0,
    },
    commerce: {
      isStore: /shopify|woocommerce|add[- ]to[- ]cart|add to bag/i.test(html) || schemaTypes.includes('Product'),
      addToCart: /add[- ]to[- ]cart|add to bag|buy now/i.test(bodyText),
      shipping: hasText(/free shipping|shipping|delivery/),
      returns: hasText(/return policy|returns|refund|exchange/),
      payments: /visa|mastercard|paypal|apple pay|google pay|stripe|bkash|nagad|amex|cash on delivery/i.test(html),
      secure: hasText(/secure (checkout|payment)|ssl secured|100% secure/),
    },
    a11y: {
      emptyButtons: $('button').filter((_, el) => !clean($(el).text()) && !$(el).attr('aria-label') && !$(el).attr('title') && !$(el).find('img[alt]').length).length,
      emptyLinks: links.filter(l => l.abs && !l.label).length,
      zoomBlocked: /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport || ''),
      skipLink: $('a[href="#main"], a[href="#content"], a.skip-link, .skip-link a').length > 0,
    },
  };
}
