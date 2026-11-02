// Runs a list of checks against a page model and scores the result.
//
// A check is a plain object:
//   { id, cat, label, sev: 'high'|'medium'|'low', weight?, run(model, ctx) => result | null }
// run() returns { status: 'pass'|'warn'|'fail'|'info', value?, tip? } or null when it doesn't apply.
// To add a check, add one object to a checks file. Nothing else changes.

const CREDIT = { pass: 1, warn: 0.5, fail: 0 };
const SEV_WEIGHT = { high: 3, medium: 2, low: 1 };

export function runChecks(checks, model, ctx = {}, { categories = [] } = {}) {
  const results = [];
  for (const c of checks) {
    let r = null;
    try { r = c.run(model, ctx); } catch (e) { r = null; if (process.env.DEBUG_CHECKS) console.error(c.id, e); }
    if (!r || !r.status) continue;
    results.push({
      id: c.id,
      cat: c.cat,
      label: c.label,
      sev: c.sev,
      weight: c.weight ?? SEV_WEIGHT[c.sev] ?? 1,
      status: r.status,
      value: r.value == null ? '' : String(r.value).slice(0, 300),
      tip: r.status === 'pass' ? '' : (r.tip || c.tip || ''),
      items: Array.isArray(r.items) ? r.items.slice(0, 25) : undefined,
    });
  }
  return summarize(results, categories);
}

export function summarize(results, categoryOrder = []) {
  const scored = results.filter(r => r.status in CREDIT);
  const score = (list) => {
    const w = list.reduce((s, r) => s + r.weight, 0);
    return w ? Math.round((list.reduce((s, r) => s + r.weight * CREDIT[r.status], 0) / w) * 100) : null;
  };
  const cats = [...new Set([...categoryOrder, ...results.map(r => r.cat)])].filter(cat => results.some(r => r.cat === cat));
  const statusOrder = { fail: 0, warn: 1, info: 2, pass: 3 };
  const sevOrder = { high: 0, medium: 1, low: 2 };
  return {
    score: score(scored) ?? 0,
    summary: {
      checks: results.length,
      passed: results.filter(r => r.status === 'pass').length,
      warnings: results.filter(r => r.status === 'warn').length,
      failed: results.filter(r => r.status === 'fail').length,
      info: results.filter(r => r.status === 'info').length,
    },
    categories: cats.map(name => {
      const list = results.filter(r => r.cat === name)
        .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || sevOrder[a.sev] - sevOrder[b.sev]);
      return {
        name,
        score: score(list.filter(r => r.status in CREDIT)),
        failed: list.filter(r => r.status === 'fail').length,
        warnings: list.filter(r => r.status === 'warn').length,
        checks: list.map(({ weight, cat, ...r }) => r),
      };
    }),
  };
}

// Helpers used by check files
export const pass = (value, extra) => ({ status: 'pass', value, ...extra });
export const warn = (value, tip, extra) => ({ status: 'warn', value, tip, ...extra });
export const fail = (value, tip, extra) => ({ status: 'fail', value, tip, ...extra });
export const info = (value, tip, extra) => ({ status: 'info', value, tip, ...extra });
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
export const short = u => { try { const x = new URL(u); return x.hostname + (x.pathname === '/' ? '' : x.pathname); } catch { return String(u); } };
export const kb = b => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
