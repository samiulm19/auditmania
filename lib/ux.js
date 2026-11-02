import { buildModel } from './engine/model.js';
import { runChecks } from './engine/run.js';
import { CRO_CHECKS, CRO_CATEGORIES } from './checks/cro.js';

// UX / CRO audit = rule-based CRO checklist (always runs, free)
//                + optional AI review of the screenshot (needs ANTHROPIC_API_KEY).

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

// Compact summary of the page model for the AI prompt
function aiContext(m, cro) {
  return {
    url: m.url,
    title: m.title,
    h1: m.h1.slice(0, 2),
    h2: m.headings.filter(h => h.level === 2).map(h => h.text).slice(0, 12),
    ctas: [...new Set(m.ctas.map(c => c.text))].slice(0, 15),
    nav: m.nav.items.slice(0, 15),
    forms: m.forms.map(f => ({ fields: f.fields.length, submit: f.submit, type: f.isSearch ? 'search' : f.isNewsletter ? 'newsletter' : 'lead' })),
    contact: m.contact,
    trust: m.trust,
    offer: m.offer,
    platform: m.platforms,
    tracking: m.trackers,
    words: m.stats.words,
    textExcerpt: m.text.slice(0, 1800),
    failedChecks: cro.categories.flatMap(c => c.checks).filter(k => k.status === 'fail').map(k => k.label),
  };
}

const SYSTEM = `You are a senior conversion-rate-optimization (CRO) and UX auditor for small and mid-size business websites.
You receive a screenshot of a page (top of page) plus data extracted from its HTML, including automatic checks that already failed.
Judge ONLY what is visible in the screenshot or present in the data. Never invent elements, numbers or facts.
Focus on what automatic checks cannot see: visual hierarchy, contrast, spacing, clarity of the offer, CTA visibility and wording, imagery, emotional tone, mobile layout.
Write for a business owner: plain language, specific to this page, focused on leads and sales.

Score these categories 0-100: "Clarity", "Call to action", "Trust", "Visual hierarchy", "Mobile", "Friction".

Return ONLY valid JSON, no markdown, in exactly this shape:
{"score":0-100,"summary":"2 sentences max","categories":[{"name":"Clarity","score":0}],"issues":[{"area":"one category name","impact":"high|medium|low","title":"max 8 words","problem":"1-2 sentences, specific to this page","fix":"1-2 sentences, concrete action"}],"strengths":["short phrase"]}
Give 6 to 10 issues sorted by impact (high first) and 2 to 4 strengths.`;

function parseDataUri(uri) {
  const x = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(uri || '');
  return x ? { media_type: x[1], data: x[2] } : null;
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

export async function aiAudit(context, screenshots) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const content = [];
  for (const s of screenshots) {
    const img = usableImage(s);
    if (img) content.push({ type: 'image', source: { type: 'base64', ...img } });
  }
  content.push({
    type: 'text',
    text: `Audit this page for UX and conversions.\nPage data (from HTML):\n${JSON.stringify(context, null, 1)}\n${content.length ? '' : 'No screenshot is available; base the audit on the page data only.'}`,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
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
    if (!issues.length) throw new Error('AI returned no issues');

    return {
      usedScreenshot: content.some(c => c.type === 'image'),
      score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))),
      summary: clean(out.summary),
      categories: Array.isArray(out.categories) ? out.categories.map(c => ({ name: clean(c.name), score: Math.round(Number(c.score) || 0) })).slice(0, 6) : null,
      issues,
      strengths: (out.strengths || []).map(clean).filter(Boolean).slice(0, 4),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Free report shows the first N AI issues in full; the rest only as locked teasers.
export function lockIssues(result, freeCount = Number(process.env.FREE_UX_ISSUES || 3)) {
  return {
    ...result,
    issues: result.issues.slice(0, freeCount),
    locked: result.issues.slice(freeCount).map(i => ({ area: i.area, impact: i.impact })),
  };
}

export async function runUx(page, screenshots = []) {
  const m = buildModel(page);
  const cro = runChecks(CRO_CHECKS, m, {}, { categories: CRO_CATEGORIES });

  let ai = null;
  let aiError = null;
  try {
    ai = await aiAudit(aiContext(m, cro), screenshots);
  } catch (e) {
    aiError = 'AI review unavailable right now; showing the automatic checklist.';
    console.error('AI audit failed:', e.message);
  }

  // Overall UX score: checklist score, blended with the AI score when available
  const score = ai ? Math.round(cro.score * 0.6 + ai.score * 0.4) : cro.score;
  const fails = cro.categories.flatMap(c => c.checks).filter(k => k.status === 'fail');
  return {
    finalUrl: m.url,
    score,
    checklistScore: cro.score,
    summary: fails.length
      ? `${cro.summary.failed} conversion blockers and ${cro.summary.warnings} improvements found across ${cro.summary.checks} checks.`
      : `No major conversion blockers; ${cro.summary.warnings} improvements found across ${cro.summary.checks} checks.`,
    checks: cro.summary,
    categories: cro.categories,
    platforms: m.platforms,
    ai: ai ? lockIssues(ai) : null,
    aiError,
  };
}
