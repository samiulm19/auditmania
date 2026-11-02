import { HttpError } from './http.js';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CACHE_TTL = 30 * 60 * 1000; // 30 min
const cache = new Map();

// Calls Google PageSpeed Insights and returns a trimmed, UI-friendly result.
export async function runPsi(url, strategy = 'mobile') {
  const key = `${strategy}:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.data, cached: true };

  const params = new URLSearchParams({ url, strategy });
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach(c => params.append('category', c));
  if (process.env.PSI_API_KEY) params.set('key', process.env.PSI_API_KEY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 58000);
  let res, json;
  try {
    res = await fetch(`${PSI_ENDPOINT}?${params}`, { signal: ctrl.signal });
    json = await res.json();
  } catch (e) {
    throw new HttpError(504, e.name === 'AbortError'
      ? 'Google PageSpeed took too long. Please try again.'
      : 'Could not reach Google PageSpeed Insights.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || json.error) {
    const msg = json?.error?.message || '';
    if (res.status === 429) throw new HttpError(429, 'Speed test quota reached. Please try again in a minute.');
    if (/FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|DNS_FAILURE/i.test(msg)) {
      throw new HttpError(422, 'Google could not load this page. Make sure the site is live and public.');
    }
    throw new HttpError(502, 'PageSpeed Insights returned an error. Please try again.');
  }

  const data = parsePsi(json, strategy);
  cache.set(key, { at: Date.now(), data });
  return data;
}

const stripMd = s => String(s || '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/`/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const score100 = c => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);

function metric(audits, id, label, unit) {
  const a = audits[id];
  if (!a) return null;
  return {
    id, label,
    value: a.displayValue || '',
    numeric: a.numericValue ?? null,
    unit,
    rating: a.score == null ? 'na' : a.score >= 0.9 ? 'good' : a.score >= 0.5 ? 'average' : 'poor',
  };
}

function savingsOf(a) {
  const d = a.details || {};
  if (typeof d.overallSavingsMs === 'number') return d.overallSavingsMs;
  if (a.metricSavings) return Object.values(a.metricSavings).reduce((s, v) => s + (typeof v === 'number' && v > 1 ? v : 0), 0);
  return 0;
}

// Failing audits referenced by a category (skips metric audits and informational ones)
function failingAudits(lh, catId, limit) {
  const cat = lh.categories?.[catId];
  if (!cat) return [];
  const skip = new Set(['notApplicable', 'informative', 'manual', 'error']);
  return cat.auditRefs
    .filter(r => r.group !== 'metrics' && r.group !== 'hidden')
    .map(r => lh.audits[r.id])
    .filter(a => a && a.score !== null && a.score < 0.9 && !skip.has(a.scoreDisplayMode))
    .map(a => ({
      id: a.id,
      title: stripMd(a.title),
      description: stripMd(a.description).slice(0, 280),
      savings: a.displayValue || '',
      savingsMs: Math.round(savingsOf(a)),
      severity: a.score < 0.5 ? 'high' : 'medium',
    }))
    .sort((x, y) => y.savingsMs - x.savingsMs || (x.severity === 'high' ? -1 : 1))
    .slice(0, limit);
}

const FIELD_LABELS = {
  LARGEST_CONTENTFUL_PAINT_MS: ['LCP', 'ms'],
  INTERACTION_TO_NEXT_PAINT: ['INP', 'ms'],
  CUMULATIVE_LAYOUT_SHIFT_SCORE: ['CLS', 'cls'],
  FIRST_CONTENTFUL_PAINT_MS: ['FCP', 'ms'],
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: ['TTFB', 'ms'],
};

function fieldData(exp) {
  if (!exp?.metrics) return null;
  const metrics = Object.entries(FIELD_LABELS)
    .filter(([k]) => exp.metrics[k])
    .map(([k, [label, unit]]) => {
      const m = exp.metrics[k];
      const v = unit === 'cls' ? (m.percentile / 100).toFixed(2) : (m.percentile / 1000).toFixed(1) + ' s';
      const cat = String(m.category || '').toUpperCase();
      return { label, value: v, rating: cat === 'FAST' ? 'good' : cat === 'AVERAGE' ? 'average' : cat === 'SLOW' ? 'poor' : 'na' };
    });
  if (!metrics.length) return null;
  const overall = String(exp.overall_category || '').toUpperCase();
  return {
    scope: exp.origin_fallback ? 'origin' : 'page',
    passed: overall === 'FAST' ? true : overall ? false : null,
    metrics,
  };
}

export function parsePsi(json, strategy) {
  const lh = json.lighthouseResult;
  if (!lh) throw new HttpError(502, 'Unexpected response from PageSpeed Insights.');
  const a = lh.audits || {};
  return {
    strategy,
    finalUrl: lh.finalDisplayedUrl || lh.finalUrl || json.id,
    fetchedAt: lh.fetchTime,
    lighthouseVersion: lh.lighthouseVersion,
    scores: {
      performance: score100(lh.categories?.performance),
      accessibility: score100(lh.categories?.accessibility),
      bestPractices: score100(lh.categories?.['best-practices']),
      seo: score100(lh.categories?.seo),
    },
    metrics: [
      metric(a, 'first-contentful-paint', 'First Contentful Paint', 's'),
      metric(a, 'largest-contentful-paint', 'Largest Contentful Paint', 's'),
      metric(a, 'total-blocking-time', 'Total Blocking Time', 'ms'),
      metric(a, 'cumulative-layout-shift', 'Cumulative Layout Shift', ''),
      metric(a, 'speed-index', 'Speed Index', 's'),
    ].filter(Boolean),
    field: fieldData(json.loadingExperience),
    opportunities: failingAudits(lh, 'performance', 10),
    seoIssues: failingAudits(lh, 'seo', 10),
    a11yIssues: failingAudits(lh, 'accessibility', 8),
    screenshot: a['final-screenshot']?.details?.data || null,
    fullPageScreenshot: lh.fullPageScreenshot?.screenshot?.data || null,
  };
}
