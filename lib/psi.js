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
const cut = (s, n = 300) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

const score100 = c => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);
const rating = score => (score == null ? 'na' : score >= 0.9 ? 'good' : score >= 0.5 ? 'average' : 'poor');

// ---------------------------------------------------------------------------
// Details trimming: keep what the report shows, drop debug data and huge blobs
// ---------------------------------------------------------------------------
const MAX_ROWS = 15;

function trimValue(v) {
  if (v == null || typeof v !== 'object') return cut(v);
  switch (v.type) {
    case 'node': return { type: 'node', snippet: cut(v.snippet, 200), selector: cut(v.selector, 160), nodeLabel: cut(v.nodeLabel, 160) };
    case 'source-location': return { type: 'source-location', url: cut(v.url, 300), line: v.line, column: v.column };
    case 'url': case 'text': case 'code': case 'numeric': case 'link': case 'ms': case 'bytes':
      return { ...v, value: cut(v.value), text: cut(v.text) };
    case 'subitems': return { type: 'subitems', items: (v.items || []).slice(0, 6).map(trimRow) };
    default: return null;
  }
}

function trimRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k === 'debugData') continue;
    const t = trimValue(v);
    if (t !== null && t !== undefined) out[k] = t;
  }
  return out;
}

function trimChains(chains, depth = 0) {
  if (!chains || depth > 6) return {};
  const out = {};
  Object.entries(chains).slice(0, 12).forEach(([id, c]) => {
    const req = c.request || c; // old criticalrequestchain vs new network-tree
    out[id] = {
      url: cut(req.url, 300),
      time: Math.round(c.navStartToEndTime ?? ((req.endTime - (req.startTime || 0)) * 1000) ?? 0),
      transferSize: req.transferSize ?? 0,
      isLongest: !!c.isLongest,
      children: trimChains(c.children, depth + 1),
    };
  });
  return out;
}

export function trimDetails(d, depth = 0) {
  if (!d || depth > 3) return null;
  switch (d.type) {
    case 'table':
    case 'opportunity':
      return {
        type: d.type,
        headings: (d.headings || []).filter(h => h.key).map(h => ({ key: h.key, valueType: h.valueType, label: h.label || h.text || '', granularity: h.granularity, sub: h.subItemsHeading ? { key: h.subItemsHeading.key, valueType: h.subItemsHeading.valueType } : null })),
        items: (d.items || []).slice(0, MAX_ROWS).map(trimRow),
        more: Math.max(0, (d.items || []).length - MAX_ROWS),
        savingsMs: d.overallSavingsMs, savingsBytes: d.overallSavingsBytes,
      };
    case 'list':
      return { type: 'list', items: (d.items || []).slice(0, 8).map(x => trimDetails(x, depth + 1)).filter(Boolean) };
    case 'list-section':
      return { type: 'list-section', title: d.title || '', description: cut(d.description, 400), value: trimDetails(d.value, depth + 1) };
    case 'network-tree':
    case 'criticalrequestchain':
      return { type: 'network-tree', chains: trimChains(d.chains), longest: d.longestChain?.duration ?? (d.longestChain?.length || null) };
    case 'checklist':
      return { type: 'checklist', items: Object.values(d.items || {}).map(i => ({ label: i.label, value: !!i.value })) };
    case 'node':
      return trimValue(d);
    case 'text':
      return { type: 'text', value: cut(d.value, 600) };
    default:
      return null; // debugdata, screenshot, filmstrip, treemap-data
  }
}

// ---------------------------------------------------------------------------
// Field data (CrUX)
// ---------------------------------------------------------------------------
const FIELD = [
  ['LARGEST_CONTENTFUL_PAINT_MS', 'LCP', 'Largest Contentful Paint', 'ms', true],
  ['INTERACTION_TO_NEXT_PAINT', 'INP', 'Interaction to Next Paint', 'ms', true],
  ['CUMULATIVE_LAYOUT_SHIFT_SCORE', 'CLS', 'Cumulative Layout Shift', 'cls', true],
  ['FIRST_CONTENTFUL_PAINT_MS', 'FCP', 'First Contentful Paint', 'ms', false],
  ['EXPERIMENTAL_TIME_TO_FIRST_BYTE', 'TTFB', 'Time to First Byte', 'ms', false],
];
const CAT = c => ({ FAST: 'good', AVERAGE: 'average', SLOW: 'poor' }[String(c || '').toUpperCase()] || 'na');

function fieldBlock(exp) {
  if (!exp?.metrics || !Object.keys(exp.metrics).length) return null;
  const metrics = FIELD.filter(([k]) => exp.metrics[k]).map(([k, acronym, label, unit, core]) => {
    const m = exp.metrics[k];
    const value = unit === 'cls' ? (m.percentile / 100).toFixed(2) : m.percentile >= 1000 ? `${(m.percentile / 1000).toFixed(1)} s` : `${Math.round(m.percentile)} ms`;
    return { acronym, label, value, rating: CAT(m.category), core, distribution: (m.distributions || []).map(d => Math.round((d.proportion || 0) * 100)) };
  });
  const core = metrics.filter(m => m.core);
  const passed = core.length >= 2 && core.every(m => m.rating === 'good');
  return { overall: CAT(exp.overall_category), passed, metrics, originFallback: !!exp.origin_fallback };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------
const HIDDEN_SKIP = new Set(['network-requests', 'network-rtt', 'network-server-latency', 'main-thread-tasks', 'diagnostics', 'metrics', 'screenshot-thumbnails', 'final-screenshot', 'script-treemap-data', 'resource-summary', 'interactive', 'max-potential-fid', 'full-page-screenshot']);
const METRIC_KEYS = ['FCP', 'LCP', 'TBT', 'CLS', 'INP'];

function auditStatus(a) {
  switch (a.scoreDisplayMode) {
    case 'notApplicable': return 'na';
    case 'manual': return 'manual';
    case 'error': return 'error';
    case 'informative': return 'info';
    default: return a.score == null ? 'info' : a.score >= 0.9 ? 'pass' : 'fail';
  }
}

function failingAudits(lh, catId, limit) {
  const cat = lh.categories?.[catId];
  if (!cat) return [];
  const skip = new Set(['notApplicable', 'informative', 'manual', 'error']);
  return cat.auditRefs
    .filter(r => r.group !== 'metrics' && r.group !== 'hidden')
    .map(r => lh.audits[r.id])
    .filter(a => a && a.score !== null && a.score < 0.9 && !skip.has(a.scoreDisplayMode))
    .map(a => ({ id: a.id, title: stripMd(a.title), description: stripMd(a.description).slice(0, 280), savings: a.displayValue || '', savingsMs: 0, severity: a.score < 0.5 ? 'high' : 'medium' }))
    .slice(0, limit);
}

export function parsePsi(json, strategy) {
  const lh = json.lighthouseResult;
  if (!lh) throw new HttpError(502, 'Unexpected response from PageSpeed Insights.');
  const A = lh.audits || {};
  const perf = lh.categories?.performance;

  // Metrics (lab)
  const metricRefs = (perf?.auditRefs || []).filter(r => r.group === 'metrics');
  const metrics = metricRefs.map(r => {
    const a = A[r.id];
    if (!a) return null;
    return {
      id: r.id, acronym: r.acronym || '', label: a.title, value: a.displayValue || '–',
      numeric: a.numericValue ?? null, unit: a.numericUnit || '', score: a.score, rating: rating(a.score),
      weight: r.weight, description: stripMd(a.description),
    };
  }).filter(Boolean);

  // All performance audits, classified like the Lighthouse report
  const audits = (perf?.auditRefs || [])
    .filter(r => r.group !== 'metrics' && !(r.group === 'hidden' && HIDDEN_SKIP.has(r.id)))
    .map(r => {
      const a = A[r.id];
      if (!a) return null;
      const status = auditStatus(a);
      if (r.group === 'hidden' && (status === 'pass' || status === 'na' || status === 'info')) return null;
      const ms = a.metricSavings || {};
      const savingsMs = a.details?.overallSavingsMs ?? Math.max(0, ...['LCP', 'FCP', 'TBT'].map(k => ms[k] || 0));
      return {
        id: r.id,
        group: r.group === 'insights' ? 'insights' : 'diagnostics',
        title: a.title,
        description: cut(a.description, 700),
        status,
        score: a.score,
        mode: a.scoreDisplayMode,
        displayValue: a.displayValue || '',
        metrics: METRIC_KEYS.filter(k => k in ms),
        savingsMs: Math.round(savingsMs || 0),
        savingsBytes: a.details?.overallSavingsBytes || 0,
        severity: status === 'fail' ? (a.score < 0.5 ? 'high' : 'medium') : 'low',
        details: trimDetails(a.details),
      };
    })
    .filter(Boolean)
    .sort((x, y) => (y.savingsMs - x.savingsMs) || (x.score ?? 1) - (y.score ?? 1));

  // Top issues (Short Report uses these; same objects as the Expandable Report)
  const opportunities = audits.filter(a => a.status === 'fail').map(a => ({
    id: a.id, title: a.title, description: stripMd(a.description).slice(0, 280), savings: a.displayValue, savingsMs: a.savingsMs, severity: a.severity, metrics: a.metrics,
  }));

  const thumbs = A['screenshot-thumbnails']?.details?.items || [];
  const treemap = (A['script-treemap-data']?.details?.nodes || [])
    .map(n => ({ name: cut(n.name, 200), bytes: n.resourceBytes || 0, unused: n.unusedBytes ?? (n.children || []).reduce((s, c) => s + (c.unusedBytes || 0), 0) }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  const resources = (A['resource-summary']?.details?.items || []).map(i => ({ type: i.resourceType, label: i.label, requests: i.requestCount, bytes: i.transferSize }));

  const cs = lh.configSettings || {};
  const thr = cs.throttling || {};
  const env = lh.environment || {};
  const environment = {
    lighthouseVersion: lh.lighthouseVersion,
    fetchTime: lh.fetchTime,
    formFactor: cs.formFactor || strategy,
    device: cs.formFactor === 'desktop' ? 'Emulated Desktop' : `Emulated ${/moto g power/i.test(env.networkUserAgent || '') ? 'Moto G Power' : 'mobile device'}`,
    screen: cs.screenEmulation ? `${cs.screenEmulation.width}×${cs.screenEmulation.height} @${cs.screenEmulation.deviceScaleFactor}x` : null,
    network: thr.rttMs != null ? `${thr.rttMs} ms RTT, ${(thr.throughputKbps / 1024).toFixed(1)} Mbps${cs.formFactor === 'desktop' ? '' : ' (Slow 4G)'}` : null,
    cpu: thr.cpuSlowdownMultiplier ? `${thr.cpuSlowdownMultiplier}x slowdown` : null,
    userAgent: env.networkUserAgent || lh.userAgent || null,
    benchmarkIndex: env.benchmarkIndex ? Math.round(env.benchmarkIndex) : null,
    session: 'Single page session · Initial page load',
    totalTime: lh.timing?.total ? Math.round(lh.timing.total) : null,
    warnings: (lh.runWarnings || []).map(w => cut(stripMd(w), 300)),
  };

  const page = fieldBlock(json.loadingExperience);
  const origin = fieldBlock(json.originLoadingExperience);
  const fieldMain = page && !page.originFallback ? page : origin || page;

  return {
    strategy,
    finalUrl: lh.finalDisplayedUrl || lh.finalUrl || json.id,
    fetchedAt: lh.fetchTime,
    lighthouseVersion: lh.lighthouseVersion,
    scores: {
      performance: score100(perf),
      accessibility: score100(lh.categories?.accessibility),
      bestPractices: score100(lh.categories?.['best-practices']),
      seo: score100(lh.categories?.seo),
    },
    metrics,
    field: {
      page: page && !page.originFallback ? page : null,
      origin,
      assessment: fieldMain ? { scope: fieldMain === origin ? 'origin' : 'page', passed: fieldMain.passed } : null,
    },
    audits,
    opportunities,
    counts: {
      failed: audits.filter(a => a.status === 'fail').length,
      passed: audits.filter(a => a.status === 'pass').length,
      info: audits.filter(a => a.status === 'info').length,
      na: audits.filter(a => a.status === 'na').length,
      manual: audits.filter(a => a.status === 'manual').length,
    },
    thumbnails: thumbs.map(t => ({ timing: Math.round(t.timing), data: t.data })),
    treemap,
    resources,
    entities: (lh.entities || []).slice(0, 20).map(e => ({ name: e.name, firstParty: !!e.isFirstParty })),
    environment,
    seoIssues: failingAudits(lh, 'seo', 10),
    a11yIssues: failingAudits(lh, 'accessibility', 8),
    screenshot: A['final-screenshot']?.details?.data || null,
    fullPageScreenshot: lh.fullPageScreenshot?.screenshot?.data || null,
  };
}
