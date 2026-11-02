import * as cheerio from 'cheerio';
import { HttpError } from './http.js';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const uniq = arr => [...new Set(arr.filter(Boolean))];

// Pulls the parts of a page that matter for UX / conversion from raw HTML.
export function extractStructure(html, finalUrl) {
  const $ = cheerio.load(html);
  const $body = $('body').clone();
  $body.find('script,style,noscript,svg,template,iframe').remove();
  const text = clean($body.text());

  const ctaSel = 'button, a[role="button"], input[type="submit"], a[class*="btn"], a[class*="button"], a[class*="cta"], [class*="cta"] a';
  const ctas = uniq($(ctaSel).map((_, el) => clean($(el).text() || $(el).attr('value') || $(el).attr('aria-label')).slice(0, 60)).get())
    .filter(t => t.length > 1 && t.length < 60);

  const nav = uniq($('nav a, header a').map((_, el) => clean($(el).text()).slice(0, 40)).get()).filter(t => t.length > 1);

  const forms = $('form').map((_, f) => {
    const fields = $(f).find('input, select, textarea')
      .filter((_, el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(($(el).attr('type') || '').toLowerCase())).length;
    return fields;
  }).get();

  const lower = text.toLowerCase();
  const trustWords = ['testimonial', 'review', 'rated', 'stars', 'trusted by', 'clients', 'case stud', 'guarantee', 'certified', 'award', 'customers'];
  const trustSignals = trustWords.filter(w => lower.includes(w));

  return {
    url: finalUrl,
    title: clean($('title').first().text()),
    metaDescription: clean($('meta[name="description"]').attr('content')),
    h1: $('h1').map((_, el) => clean($(el).text())).get().filter(Boolean).slice(0, 3),
    h2: $('h2').map((_, el) => clean($(el).text())).get().filter(Boolean).slice(0, 12),
    ctas: ctas.slice(0, 15),
    nav: nav.slice(0, 15),
    forms,
    hasPhone: $('a[href^="tel:"]').length > 0,
    hasEmail: $('a[href^="mailto:"]').length > 0,
    hasWhatsapp: $('a[href*="wa.me"], a[href*="whatsapp"]').length > 0,
    trustSignals,
    images: $('img').length,
    videos: $('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length,
    hasViewport: $('meta[name="viewport"]').length > 0,
    textExcerpt: text.slice(0, 1800),
    wordCount: text.split(' ').length,
  };
}

// ---------------------------------------------------------------------------
// Rule-based audit: used when no AI key is set, or if the AI call fails.
// ---------------------------------------------------------------------------
export function heuristicAudit(s) {
  const issues = [];
  const add = (area, impact, title, problem, fix) => issues.push({ area, impact, title, problem, fix });

  if (!s.h1.length) add('Clarity', 'high', 'No main headline', 'Visitors cannot tell what you offer in the first 5 seconds.', 'Add one clear H1 that states what you do and for whom.');
  else if (s.h1[0].split(' ').length > 14) add('Clarity', 'medium', 'Headline is too long', `Your H1 has ${s.h1[0].split(' ').length} words, which slows down scanning.`, 'Cut the headline to under 10 words and move details to a subheadline.');

  if (!s.ctas.length) add('Call to action', 'high', 'No clear call-to-action', 'We could not find any buttons that tell visitors what to do next.', 'Add a high-contrast primary button like "Get a free quote" above the fold.');
  else if (s.ctas.length > 8) add('Call to action', 'medium', 'Too many competing buttons', `${s.ctas.length} different button labels split attention.`, 'Pick one primary action and repeat the same label down the page.');

  if (!s.hasPhone && !s.hasEmail && !s.hasWhatsapp) add('Trust', 'high', 'No visible contact option', 'No clickable phone, email or WhatsApp link was found.', 'Add a click-to-call or WhatsApp button in the header and footer.');
  if (s.trustSignals.length < 2) add('Trust', 'high', 'Weak social proof', 'Few or no testimonials, reviews or client logos were detected.', 'Show 3+ testimonials with names, star ratings or client logos near your CTA.');

  const longForm = Math.max(0, ...s.forms);
  if (longForm > 6) add('Friction', 'medium', 'Form asks for too much', `A form has ${longForm} fields. Each extra field lowers completions.`, 'Ask only for name, email/phone and one qualifying question.');
  if (!s.forms.length && !s.hasPhone && !s.hasWhatsapp) add('Friction', 'medium', 'No lead capture', 'There is no form or quick contact path to capture interested visitors.', 'Add a short enquiry form or booking widget.');

  if (s.nav.length > 9) add('Navigation', 'low', 'Crowded navigation', `${s.nav.length} menu links make it harder to find key pages.`, 'Keep 5–7 top-level menu items and group the rest.');
  if (!s.hasViewport) add('Mobile', 'high', 'Not mobile optimized', 'The page has no viewport tag, so it may render tiny on phones.', 'Add a responsive viewport meta tag and test on mobile.');
  if (s.wordCount < 150) add('Clarity', 'medium', 'Too little explanation', 'The page has very little text to explain the offer.', 'Add benefit-focused sections: problem, solution, proof, CTA.');
  if (!s.metaDescription) add('Clarity', 'low', 'No search snippet', 'Missing meta description, so Google writes its own preview.', 'Write a 150-character description with a clear benefit.');

  const weight = { high: 14, medium: 7, low: 3 };
  const score = Math.max(25, 100 - issues.reduce((s2, i) => s2 + weight[i.impact], 0));
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.impact] - order[b.impact]);

  const strengths = [];
  if (s.h1.length === 1 && s.h1[0].split(' ').length <= 14) strengths.push('Has a single, clear main headline');
  if (s.ctas.length && s.ctas.length <= 8) strengths.push('Focused set of calls-to-action');
  if (s.trustSignals.length >= 2) strengths.push('Shows social proof / trust signals');
  if (s.hasPhone || s.hasWhatsapp) strengths.push('Easy to contact by phone or WhatsApp');

  return {
    mode: 'rules',
    score,
    summary: issues.length
      ? `We found ${issues.length} conversion issue${issues.length === 1 ? '' : 's'}; ${issues.filter(i => i.impact === 'high').length} are high impact.`
      : 'No major conversion blockers found by the automatic checks.',
    categories: null,
    issues,
    strengths,
  };
}

// ---------------------------------------------------------------------------
// AI audit (Claude vision). Needs ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------
const SYSTEM = `You are a senior conversion-rate-optimization (CRO) and UX auditor for small and mid-size business websites.
You receive a screenshot of a page (top of page on a mobile or desktop viewport) plus data extracted from its HTML.
Judge ONLY what is visible in the screenshot or present in the data. Never invent elements, numbers or facts.
Write for a business owner: plain language, specific to this page, focused on leads and sales.

Score these categories 0-100: "Clarity" (can a visitor tell what is offered, for whom, within 5 seconds),
"Call to action" (visibility, wording, placement), "Trust" (reviews, logos, guarantees, contact info),
"Visual hierarchy" (layout, contrast, readability, spacing), "Mobile" (tap targets, text size, layout on small screens),
"Friction" (form length, distractions, steps to convert).

Return ONLY valid JSON, no markdown, in exactly this shape:
{"score":0-100,"summary":"2 sentences max","categories":[{"name":"Clarity","score":0}],"issues":[{"area":"one category name","impact":"high|medium|low","title":"max 8 words","problem":"1-2 sentences, specific to this page","fix":"1-2 sentences, concrete action"}],"strengths":["short phrase"]}
Give 6 to 10 issues sorted by impact (high first) and 2 to 4 strengths.`;

function parseDataUri(uri) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(uri || '');
  return m ? { media_type: m[1], data: m[2] } : null;
}

// Reads JPEG dimensions so we never send an image the API would reject.
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const size = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + size;
  }
  return null;
}

function usableImage(uri) {
  const img = parseDataUri(uri);
  if (!img || img.data.length > 4.5 * 1024 * 1024) return null;
  if (img.media_type === 'image/jpeg') {
    const dim = jpegSize(Buffer.from(img.data, 'base64'));
    if (dim && (dim.w > 7900 || dim.h > 7900)) return null;
  }
  return img;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON in AI response');
  return JSON.parse(text.slice(start, end + 1));
}

export async function aiAudit(structure, screenshots) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const content = [];
  for (const s of screenshots) {
    const img = usableImage(s);
    if (img) content.push({ type: 'image', source: { type: 'base64', ...img } });
  }
  content.push({
    type: 'text',
    text: `Audit this page for UX and conversions.\nPage data (from HTML):\n${JSON.stringify(structure, null, 1)}\n${content.length ? '' : 'No screenshot is available; base the audit on the page data only.'}`,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-5-5',
        max_tokens: 2500,
        temperature: 0.2,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `AI request failed (${res.status})`);
    const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const out = extractJson(text);

    const impacts = ['high', 'medium', 'low'];
    const issues = (Array.isArray(out.issues) ? out.issues : [])
      .filter(i => i && i.title)
      .map(i => ({
        area: clean(i.area) || 'General',
        impact: impacts.includes(i.impact) ? i.impact : 'medium',
        title: clean(i.title),
        problem: clean(i.problem),
        fix: clean(i.fix),
      }))
      .sort((a, b) => impacts.indexOf(a.impact) - impacts.indexOf(b.impact));

    return {
      mode: 'ai',
      usedScreenshot: content.some(c => c.type === 'image'),
      score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))),
      summary: clean(out.summary),
      categories: Array.isArray(out.categories)
        ? out.categories.map(c => ({ name: clean(c.name), score: Math.round(Number(c.score) || 0) })).slice(0, 6)
        : null,
      issues,
      strengths: (out.strengths || []).map(clean).filter(Boolean).slice(0, 4),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Free report shows the first N issues in full; the rest only as locked teasers.
export function lockIssues(result, freeCount = Number(process.env.FREE_UX_ISSUES || 3)) {
  const open = result.issues.slice(0, freeCount);
  const locked = result.issues.slice(freeCount).map(i => ({ area: i.area, impact: i.impact }));
  return { ...result, issues: open, locked };
}

export async function runUx(structure, screenshots) {
  let result = null;
  let aiError = null;
  try {
    result = await aiAudit(structure, screenshots);
  } catch (e) {
    aiError = e.message;
    console.error('AI audit failed, falling back to rules:', e.message);
  }
  if (!result) result = heuristicAudit(structure);
  if (!result.issues.length && result.mode === 'ai') throw new HttpError(502, 'The AI audit returned no results. Please try again.');
  return lockIssues({ ...result, aiError: aiError ? 'AI unavailable, showing automatic checks' : null });
}
