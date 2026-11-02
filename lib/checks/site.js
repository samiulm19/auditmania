import { similarity } from '../engine/model.js';

// Cross-page checks for a full-site crawl. Each one gets every crawled page (P)
// plus crawl context, and returns the pages it flags (with a short detail) or [].

const norm = u => String(u || '').replace(/\/$/, '');
const dupGroups = (pages, key) => {
  const m = new Map();
  pages.forEach(p => { const k = (p[key] || '').trim().toLowerCase(); if (k) m.set(k, [...(m.get(k) || []), p]); });
  return [...m.values()].filter(g => g.length > 1);
};

export const SITE_CHECKS = [
  { id: 'broken-pages', cat: 'Indexability', sev: 'high', label: 'Broken pages (4xx/5xx)',
    tip: 'Fix or 301-redirect these URLs and update links pointing to them.',
    run: (P, x) => P.filter(p => p.status >= 400).map(p => ({ url: p.url, detail: `HTTP ${p.status}${x.incoming(p.url) ? ` · linked from ${x.incoming(p.url)} page${x.incoming(p.url) > 1 ? 's' : ''}` : ''}` })) },
  { id: 'uncrawlable', cat: 'Indexability', sev: 'high', label: "Pages that couldn't be crawled",
    tip: 'These URLs timed out or refused the connection.',
    run: P => P.filter(p => !p.status).map(p => ({ url: p.url, detail: p.error || 'No response' })) },
  { id: 'redirect-chains', cat: 'Indexability', sev: 'medium', label: 'Redirect chains and loops',
    tip: 'Redirect in a single step straight to the final URL.',
    run: P => P.filter(p => p.chain.length > 1 || p.loop).map(p => ({ url: p.url, detail: p.loop ? 'Redirect loop' : p.chain.map(h => h.status).join(' → ') })) },
  { id: 'temp-redirects', cat: 'Indexability', sev: 'low', label: 'Temporary redirects (302/307)',
    tip: 'Use 301 for permanent moves so ranking signals transfer.',
    run: P => P.filter(p => p.chain.some(h => h.status === 302 || h.status === 307)).map(p => ({ url: p.url, detail: `→ ${p.redirected || ''}` })) },
  { id: 'internal-redirects', cat: 'Links', sev: 'low', label: 'Internal links to redirecting URLs',
    tip: 'Update these links to point straight at the final URL (saves crawl budget and a round trip).',
    run: (P, x) => P.filter(p => p.redirected && x.rawIncoming(p.url)).map(p => ({ url: p.url, detail: `→ ${x.path(p.redirected)} · ${x.rawIncoming(p.url)} link${x.rawIncoming(p.url) > 1 ? 's' : ''}` })) },
  { id: 'dup-title', cat: 'On-page', sev: 'medium', label: 'Duplicate titles',
    tip: 'Pages with the same title compete with each other. Make every title unique.',
    run: (P, x) => dupGroups(x.indexable, 'title').flat().map(p => ({ url: p.url, detail: p.title.slice(0, 70) })) },
  { id: 'dup-desc', cat: 'On-page', sev: 'low', label: 'Duplicate meta descriptions',
    tip: 'Each page should describe its own content.',
    run: (P, x) => dupGroups(x.indexable, 'desc').flat().map(p => ({ url: p.url, detail: p.desc.slice(0, 70) })) },
  { id: 'dup-h1', cat: 'On-page', sev: 'low', label: 'Duplicate H1 headings',
    tip: 'Use a unique H1 on each page.',
    run: (P, x) => dupGroups(x.indexable, 'h1').flat().map(p => ({ url: p.url, detail: p.h1.slice(0, 70) })) },
  { id: 'dup-content', cat: 'Content', sev: 'high', label: 'Duplicate or near-duplicate content',
    tip: 'Merge these pages, rewrite them, or point a canonical to the main version.',
    run: (P, x) => {
      const list = x.indexable.filter(p => p.minhash);
      const flagged = new Map();
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const s = similarity(list[i].minhash, list[j].minhash);
        if (s >= 0.85) {
          flagged.set(list[i].url, `${Math.round(s * 100)}% same as ${x.path(list[j].url)}`);
          if (!flagged.has(list[j].url)) flagged.set(list[j].url, `${Math.round(s * 100)}% same as ${x.path(list[i].url)}`);
        }
      }
      return [...flagged].map(([url, detail]) => ({ url, detail }));
    } },
  { id: 'orphans', cat: 'Links', sev: 'medium', label: 'Orphan pages (no internal links found)',
    tip: 'These pages are in your sitemap but no crawled page links to them. Link to them from related pages.',
    run: (P, x) => x.ok.filter(p => p.fromSitemap && p.url !== x.home && !x.incoming(p.url)).map(p => ({ url: p.url, detail: 'In sitemap only' })) },
  { id: 'one-link', cat: 'Links', sev: 'low', label: 'Pages with only one internal link',
    tip: 'Add more internal links to important pages.',
    run: (P, x) => x.ok.filter(p => p.url !== x.home && x.incoming(p.url) === 1).map(p => ({ url: p.url, detail: '1 incoming link' })) },
  { id: 'deep-pages', cat: 'Links', sev: 'low', label: 'Pages more than 3 clicks from home',
    tip: 'Important pages should be reachable within 3 clicks.',
    run: (P, x) => x.ok.filter(p => p.depth > 3 && p.depth < 99).map(p => ({ url: p.url, detail: `${p.depth} clicks` })) },
  { id: 'sitemap-noindex', cat: 'Indexability', sev: 'medium', label: 'Noindex or broken pages in sitemap',
    tip: 'Only list indexable, live pages in your sitemap.',
    run: P => P.filter(p => p.fromSitemap && (p.noindex || p.status >= 400 || p.redirected)).map(p => ({ url: p.url, detail: p.noindex ? 'noindex' : p.redirected ? 'redirects' : `HTTP ${p.status}` })) },
  { id: 'sitemap-canonical', cat: 'Indexability', sev: 'low', label: 'Canonicalized pages in sitemap',
    tip: 'List the canonical version only.',
    run: P => P.filter(p => p.fromSitemap && p.canonical && norm(p.canonical) !== norm(p.url)).map(p => ({ url: p.url, detail: `canonical → ${p.canonical}` })) },
  { id: 'canonical-broken', cat: 'Indexability', sev: 'high', label: 'Canonical points to a broken or redirected URL',
    tip: 'Point canonicals at live, final URLs.',
    run: (P, x) => P.filter(p => p.canonical && norm(p.canonical) !== norm(p.url)).map(p => {
      const t = x.byUrl.get(p.canonical) || x.byUrl.get(p.canonical + '/') || x.byUrl.get(norm(p.canonical));
      return t && (t.status >= 400 || t.redirected) ? { url: p.url, detail: `${p.canonical} (${t.redirected ? 'redirects' : t.status})` } : null;
    }).filter(Boolean) },
];
