/* Speed report: Short Report + Expandable (Google PageSpeed style) report.
   Both views render from the SAME parsed PageSpeed result; switching views or devices never calls the API. */
(() => {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tone = n => (n == null ? 'na' : n >= 90 ? 'good' : n >= 50 ? 'avg' : 'poor');
  const rTone = r => ({ good: 'good', average: 'avg', poor: 'poor' }[r] || 'na');
  const md = s => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const plain = s => String(s || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '');
  const firstSentence = s => (plain(s).match(/^.*?[.!?](\s|$)/) || [plain(s)])[0].trim();
  const kib = b => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`);
  const shortUrl = u => { try { const x = new URL(u); return (x.pathname + x.search).replace(/^\/$/, x.hostname + '/') || x.hostname; } catch { return String(u); } };
  const DEVICE = { mobile: 'Mobile', desktop: 'Desktop' };

  // Plain-language fixes for the most common PageSpeed findings
  const RECS = {
    'render-blocking-insight': 'Defer non-critical JavaScript (defer/async) and inline the critical CSS so the page can paint sooner.',
    'render-blocking-resources': 'Defer non-critical JavaScript (defer/async) and inline the critical CSS so the page can paint sooner.',
    'unused-javascript': 'Remove or delay scripts the page does not need on load (unused plugins, sliders, chat widgets).',
    'unused-css-rules': 'Remove unused CSS or generate critical CSS (most cache plugins can do this).',
    'cache-insight': 'Serve static files with a long cache lifetime (Cache-Control max-age of 1 year for versioned assets).',
    'uses-long-cache-ttl': 'Serve static files with a long cache lifetime (Cache-Control max-age of 1 year for versioned assets).',
    'image-delivery-insight': 'Compress images, serve WebP/AVIF, and size them to how large they are displayed.',
    'modern-image-formats': 'Convert images to WebP or AVIF.',
    'uses-optimized-images': 'Compress images (ShortPixel, TinyPNG, Squoosh).',
    'uses-responsive-images': 'Serve smaller images to phones with srcset/sizes.',
    'offscreen-images': 'Lazy-load images below the fold (loading="lazy").',
    'unminified-css': 'Minify CSS files.',
    'unminified-javascript': 'Minify JavaScript files.',
    'bootup-time': 'Cut JavaScript execution: remove heavy plugins and split large bundles.',
    'mainthread-work-breakdown': 'Reduce main-thread work: less JavaScript, simpler page-builder layouts.',
    'long-tasks': 'Break up long JavaScript tasks so the page stays responsive.',
    'server-response-time': 'Speed up the server: full-page caching, faster hosting or a CDN.',
    'document-latency-insight': 'Reduce first-request latency: avoid redirects, enable compression and page caching.',
    'redirects': 'Link straight to the final URL to avoid redirect hops.',
    'font-display-insight': 'Add font-display: swap so text shows while web fonts load.',
    'lcp-discovery-insight': 'Make the LCP image discoverable: no lazy-loading on it, add fetchpriority="high".',
    'lcp-breakdown-insight': 'Shorten the slowest LCP phase shown in the breakdown.',
    'third-parties-insight': 'Delay or remove heavy third-party scripts (chat, trackers, embeds).',
    'third-party-summary': 'Delay or remove heavy third-party scripts (chat, trackers, embeds).',
    'dom-size-insight': 'Simplify the page structure; huge DOMs slow down rendering.',
    'dom-size': 'Simplify the page structure; huge DOMs slow down rendering.',
    'cls-culprits-insight': 'Reserve space for images, ads and late content so the layout does not jump.',
    'layout-shifts': 'Reserve space for images, ads and late content so the layout does not jump.',
    'unsized-images': 'Add width and height to images to prevent layout shifts.',
    'total-byte-weight': 'Reduce total page weight: compress images and remove unused code.',
    'legacy-javascript-insight': 'Stop shipping legacy polyfills to modern browsers.',
    'duplicated-javascript-insight': 'Remove duplicated JavaScript modules from bundles.',
    'modern-http-insight': 'Serve the site over HTTP/2 or HTTP/3.',
    'network-dependency-tree-insight': 'Shorten critical request chains and preconnect to key origins.',
    'critical-request-chains': 'Shorten critical request chains and preconnect to key origins.',
    'forced-reflow-insight': 'Avoid reading layout right after changing styles in JavaScript.',
    'viewport-insight': 'Use a proper mobile viewport meta tag.',
    'non-composited-animations': 'Animate only transform and opacity.',
  };
  const recommendation = a => RECS[a.id] || firstSentence(a.description);

  // ---------------------------------------------------------------- details renderer
  function fmt(v, type, granularity) {
    if (v == null || v === '') return '';
    if (typeof v === 'object') {
      switch (v.type) {
        case 'node': return `<div class="lh-node">${v.nodeLabel ? `<div>${esc(v.nodeLabel)}</div>` : ''}${v.snippet ? `<code>${esc(v.snippet)}</code>` : ''}</div>`;
        case 'source-location': return `<span class="lh-url" title="${esc(v.url)}">${esc(shortUrl(v.url))}${v.line != null ? `:${v.line + 1}` : ''}</span>`;
        case 'url': return fmt(v.value, 'url');
        case 'link': return esc(v.text || v.url || '');
        case 'code': return `<code>${esc(v.value)}</code>`;
        case 'numeric': return fmt(v.value, 'numeric', v.granularity);
        case 'text': return esc(v.value);
        default: return '';
      }
    }
    switch (type) {
      case 'url': return /^https?:/.test(v) ? `<a class="lh-url" href="${esc(v)}" target="_blank" rel="noopener nofollow" title="${esc(v)}">${esc(shortUrl(v))}</a>` : esc(v);
      case 'bytes': return esc(kib(Number(v)));
      case 'ms': case 'timespanMs': return `${Math.round(Number(v)).toLocaleString()} ms`;
      case 'numeric': {
        const n = Number(v);
        const g = granularity || (Math.abs(n) < 1 ? 0.001 : 1);
        const d = Math.max(0, -Math.floor(Math.log10(g)));
        return n.toFixed(Math.min(d, 3));
      }
      case 'code': return `<code>${esc(v)}</code>`;
      case 'thumbnail': return '';
      default: return esc(v);
    }
  }

  function renderTable(d) {
    if (!d.items?.length) return '';
    const heads = d.headings.filter(h => h.valueType !== 'thumbnail');
    const rows = d.items.map(it => {
      let html = `<tr>${heads.map(h => `<td class="lh-${h.valueType || 'text'}">${fmt(it[h.key], h.valueType, h.granularity)}</td>`).join('')}</tr>`;
      if (it.subItems?.items?.length) {
        html += it.subItems.items.map(sub => `<tr class="lh-sub">${heads.map(h => h.sub ? `<td class="lh-${h.sub.valueType || h.valueType || 'text'}">${fmt(sub[h.sub.key], h.sub.valueType || h.valueType)}</td>` : '<td></td>').join('')}</tr>`).join('');
      }
      return html;
    }).join('');
    return `<div class="lh-table-wrap"><table class="lh-table"><thead><tr>${heads.map(h => `<th>${esc(h.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${d.more ? `<p class="lh-more">+ ${d.more} more rows</p>` : ''}`;
  }

  function renderTree(chains, depth = 0) {
    const items = Object.values(chains || {});
    if (!items.length) return '';
    return `<ul class="lh-tree${depth ? '' : ' root'}">${items.map(c => `
      <li class="${c.isLongest ? 'longest' : ''}">
        <span class="lh-url" title="${esc(c.url)}">${esc(shortUrl(c.url))}</span>
        <span class="lh-tree-meta">${c.time ? `${Math.round(c.time).toLocaleString()} ms` : ''}${c.transferSize ? ` · ${kib(c.transferSize)}` : ''}</span>
        ${renderTree(c.children, depth + 1)}
      </li>`).join('')}</ul>`;
  }

  function renderDetails(d) {
    if (!d) return '';
    switch (d.type) {
      case 'table': case 'opportunity': return renderTable(d);
      case 'list': return d.items.map(renderDetails).join('');
      case 'list-section': return `${d.title ? `<h5 class="lh-sec-title">${esc(d.title)}</h5>` : ''}${d.description ? `<p class="lh-desc">${md(d.description)}</p>` : ''}${renderDetails(d.value)}`;
      case 'network-tree': return `${d.longest ? `<p class="lh-desc">Maximum critical path latency: <b>${Math.round(d.longest).toLocaleString()} ms</b></p>` : ''}${renderTree(d.chains)}`;
      case 'checklist': return `<ul class="lh-check">${d.items.map(i => `<li class="${i.value ? 'ok' : 'bad'}"><span>${i.value ? '✓' : '✕'}</span>${esc(i.label)}</li>`).join('')}</ul>`;
      case 'node': return fmt(d);
      case 'text': return `<p class="lh-desc">${esc(d.value)}</p>`;
      default: return '';
    }
  }

  // ---------------------------------------------------------------- building blocks
  function ring(score, size = 120) {
    const r = 52, c = 2 * Math.PI * r;
    const off = score == null ? c : c * (1 - score / 100);
    return `<div class="sp-ring c-${tone(score)}" style="--size:${size}px">
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="${r}"/><circle class="val" cx="60" cy="60" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>
      <b>${score ?? '–'}</b></div>`;
  }

  const legend = `<div class="sp-legend"><span><i class="tri"></i>0–49</span><span><i class="sq"></i>50–89</span><span><i class="dot"></i>90–100</span></div>`;

  function metricCards(d, withDesc) {
    return `<div class="sp-metrics">${d.metrics.map(m => `
      <div class="sp-metric">
        <div class="sp-metric-label c-${rTone(m.rating)}"><i class="shape ${rTone(m.rating)}"></i><span>${esc(m.label)}</span>${m.acronym ? `<em>${esc(m.acronym)}</em>` : ''}</div>
        <div class="sp-metric-value c-${rTone(m.rating)}">${esc(m.value)}</div>
        ${withDesc && m.description ? `<p class="lh-desc">${esc(m.description)}</p>` : ''}
      </div>`).join('')}</div>`;
  }

  function assessmentBadge(d) {
    const a = d.field?.assessment;
    if (!a) return '<span class="sp-badge na">Core Web Vitals: No Data</span>';
    return `<span class="sp-badge ${a.passed ? 'good' : 'poor'}">Core Web Vitals Assessment: ${a.passed ? 'Passed' : 'Failed'}</span>`;
  }

  function fieldBlock(f, title) {
    if (!f) return '';
    return `<div class="sp-field">
      <div class="sp-field-head"><strong>${esc(title)}</strong>${f.passed ? '<span class="sp-badge good">Passed</span>' : '<span class="sp-badge poor">Failed</span>'}</div>
      <div class="sp-field-grid">${f.metrics.map(m => `
        <div class="sp-fmetric">
          <div class="sp-metric-label c-${rTone(m.rating)}"><i class="shape ${rTone(m.rating)}"></i><span>${esc(m.label)}</span><em>${esc(m.acronym)}</em>${m.core ? '<span class="cwv">CWV</span>' : ''}</div>
          <div class="sp-metric-value c-${rTone(m.rating)}">${esc(m.value)}</div>
          ${m.distribution?.length === 3 ? `<div class="sp-dist" title="Good ${m.distribution[0]}% · Needs improvement ${m.distribution[1]}% · Poor ${m.distribution[2]}%"><span class="g" style="width:${m.distribution[0]}%"></span><span class="a" style="width:${m.distribution[1]}%"></span><span class="p" style="width:${m.distribution[2]}%"></span></div>
          <div class="sp-dist-legend">${m.distribution[0]}% good · ${m.distribution[1]}% ok · ${m.distribution[2]}% poor</div>` : ''}
        </div>`).join('')}</div>
    </div>`;
  }

  function fieldSummary(d) {
    const f = d.field || {};
    if (!f.page && !f.origin) {
      return `<p class="sp-note"><b>Real-user data: Not available.</b> Google's Chrome UX Report doesn't have enough real visitor data for this site yet. The scores below come from a lab test.</p>`;
    }
    return fieldBlock(f.page, 'This URL (real users, last 28 days)') + fieldBlock(f.origin, 'Whole site / origin (real users, last 28 days)');
  }

  function auditItem(a) {
    const icon = a.status === 'fail' ? `<span class="sev ${a.severity}"></span>` : a.status === 'pass' ? '<span class="sp-pass">✓</span>' : '<span class="sp-neutral">○</span>';
    return `<details class="sp-audit" data-metrics="${esc(a.metrics.join(' '))}">
      <summary>${icon}<span class="sp-audit-title">${esc(a.title)}</span>${a.displayValue ? `<span class="sp-audit-val ${a.status === 'fail' ? 'bad' : ''}">${esc(a.displayValue)}</span>` : ''}
        ${a.metrics.length ? `<span class="sp-tags">${a.metrics.map(m => `<em>${m}</em>`).join('')}</span>` : ''}</summary>
      <div class="sp-audit-body">
        <p class="lh-desc">${md(a.description)}</p>
        ${a.status === 'fail' && RECS[a.id] ? `<p class="sp-fix"><b>How to fix:</b> ${esc(RECS[a.id])}</p>` : ''}
        ${renderDetails(a.details)}
      </div>
    </details>`;
  }

  const section = (id, title, body, open = false, extra = '') => `
    <details class="sp-section" data-sec="${id}" ${open ? 'open' : ''}>
      <summary><span>${title}</span>${extra}</summary>
      <div class="sp-section-body">${body}</div>
    </details>`;

  // ---------------------------------------------------------------- Short report
  function shortReport(d, all) {
    const top = d.audits.filter(a => a.status === 'fail').slice(0, 5);
    const both = all.mobile && all.desktop;
    return `
      <div class="sp-short">
        <div class="sp-hero">
          <div class="sp-hero-score">
            ${ring(d.scores.performance)}
            <div>
              <div class="sp-hero-label">Performance</div>
              ${both ? `<div class="sp-devices">${['mobile', 'desktop'].map(k => `<span class="pill c-${tone(all[k].scores.performance)}">${DEVICE[k]} ${all[k].scores.performance}</span>`).join('')}</div>` : `<div class="sp-devices"><span class="pill">${DEVICE[d.strategy]}</span></div>`}
              ${assessmentBadge(d)}
              <p class="sp-avail">Field data: <b>${d.field?.page ? 'Available for this URL' : d.field?.origin ? 'Origin only' : 'Not available'}</b></p>
            </div>
          </div>
          ${d.screenshot ? `<img class="sp-shot" src="${d.screenshot}" alt="Final screenshot of the page (${DEVICE[d.strategy]})">` : '<div class="sp-shot sp-shot-empty">No screenshot</div>'}
        </div>

        <h4 class="subhead">Metrics</h4>
        ${metricCards(d, false)}

        <h4 class="subhead">Core Web Vitals</h4>
        <div class="sp-cwv">
          ${['LCP', 'INP', 'CLS'].map(k => {
            const fm = (d.field?.page || d.field?.origin)?.metrics.find(m => m.acronym === k);
            const lab = d.metrics.find(m => m.acronym === (k === 'INP' ? 'TBT' : k));
            const m = fm || lab;
            return `<div class="sp-cwv-item c-${rTone(m?.rating)}"><span>${k}${!fm && k === 'INP' ? ' <small>(lab: TBT)</small>' : ''}</span><b>${esc(m?.value ?? 'No Data')}</b><small>${fm ? 'Real users' : m ? 'Lab test' : ''}</small></div>`;
          }).join('')}
        </div>

        <h4 class="subhead">Top issues</h4>
        ${top.length ? `<ol class="sp-top">${top.map(a => `
          <li><div class="sp-top-head"><span class="sev ${a.severity}"></span><b>${esc(a.title)}</b>${a.displayValue ? `<span class="sp-audit-val bad">${esc(a.displayValue)}</span>` : ''}</div>
          ${a.metrics.length ? `<span class="sp-tags">${a.metrics.map(m => `<em>${m}</em>`).join('')}</span>` : ''}</li>`).join('')}</ol>`
          : '<p class="sp-note">No major performance issues found. 🎉</p>'}

        ${top.length ? `<h4 class="subhead">Recommendations</h4><ul class="sp-recs">${[...new Set(top.map(recommendation))].map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <p class="sp-note">Want every detail? Switch to <button type="button" class="linkish" data-view="full">Expandable Report</button>.</p>
      </div>`;
  }

  // ---------------------------------------------------------------- Expandable report
  function fullReport(d) {
    const pick = (...ids) => d.audits.find(a => ids.includes(a.id));
    const byGroup = (g, statuses) => d.audits.filter(a => a.group === g && statuses.includes(a.status));
    const insights = byGroup('insights', ['fail', 'info']);
    const diagnostics = byGroup('diagnostics', ['fail', 'info']);
    const passed = d.audits.filter(a => a.status === 'pass');
    const na = d.audits.filter(a => a.status === 'na');
    const manual = d.audits.filter(a => a.status === 'manual');
    const env = d.environment || {};

    const filter = `<div class="sp-filter" role="group" aria-label="Show audits relevant to"><span>Show audits relevant to:</span>${['All', 'FCP', 'LCP', 'TBT', 'CLS'].map((k, i) => `<button type="button" class="filter${i ? '' : ' active'}" data-metric="${k}">${k}</button>`).join('')}</div>`;
    const list = (arr, empty) => arr.length ? `<div class="sp-audits">${arr.map(auditItem).join('')}</div>` : `<p class="lh-empty">${empty}</p>`;

    const net = pick('network-dependency-tree-insight', 'critical-request-chains');
    const lcp = pick('lcp-breakdown-insight', 'largest-contentful-paint-element');
    const cls = [pick('cls-culprits-insight'), pick('layout-shifts')].filter(Boolean);
    const third = pick('third-parties-insight', 'third-party-summary');
    const totalRes = d.resources.find(r => r.type === 'total');
    const maxTree = Math.max(1, ...d.treemap.map(t => t.bytes));

    return `
      <div class="sp-full">
        ${section('overview', 'Performance overview', `
          <div class="sp-overview">
            ${ring(d.scores.performance, 140)}
            <div>
              <p class="lh-desc">Values are estimated and may vary. The performance score is calculated directly from these metrics.</p>
              ${legend}
              <div class="summary-row" style="margin-top:12px">
                <span class="pill c-poor">${d.counts.failed} to improve</span>
                <span class="pill c-good">${d.counts.passed} passed</span>
                <span class="pill">${d.counts.info} informative</span>
                <span class="pill">${d.counts.na} not applicable</span>
              </div>
              <div class="sp-cat-scores">${[['Accessibility', d.scores.accessibility], ['Best practices', d.scores.bestPractices], ['SEO', d.scores.seo]].map(([n, v]) => `<span class="pill c-${tone(v)}">${n} ${v ?? '–'}</span>`).join('')}</div>
            </div>
          </div>`, true)}

        ${section('metrics', 'Lab metrics', metricCards(d, true), true)}

        ${section('cwv', 'Core Web Vitals & real-user data', `<div style="margin-bottom:12px">${assessmentBadge(d)}</div>${fieldSummary(d)}`, true)}

        ${section('screens', 'Screenshots', `
          ${d.thumbnails.length ? `<h5 class="lh-sec-title">Page load filmstrip</h5><div class="sp-filmstrip">${d.thumbnails.map(t => `<figure><img src="${t.data}" alt="Page at ${t.timing} ms" loading="lazy"><figcaption>${(t.timing / 1000).toFixed(1)} s</figcaption></figure>`).join('')}</div>` : '<p class="lh-empty">No thumbnails available.</p>'}
          ${d.screenshot ? `<h5 class="lh-sec-title">Final screenshot</h5><img class="sp-final" src="${d.screenshot}" alt="Final screenshot">` : ''}`)}

        ${section('audits', 'Diagnose performance issues', `
          ${filter}
          <h5 class="lh-sec-title">Insights <span class="count">${insights.length}</span></h5>${list(insights, 'No insights to show.')}
          <h5 class="lh-sec-title">Diagnostics <span class="count">${diagnostics.length}</span></h5>${list(diagnostics, 'No diagnostics to show.')}
          <details class="sp-sub"><summary>Passed audits <span class="count">${passed.length}</span></summary>${list(passed, 'None.')}</details>
          <details class="sp-sub"><summary>Not applicable <span class="count">${na.length}</span></summary>${list(na, 'None.')}</details>
          <details class="sp-sub"><summary>Manual audits <span class="count">${manual.length}</span></summary>${list(manual, 'No manual audits in this report.')}</details>`, true,
          `<span class="pill c-poor">${d.counts.failed}</span>`)}

        ${section('network', 'Network dependency tree', net ? `<p class="lh-desc">${md(net.description)}</p>${renderDetails(net.details)}` : '<p class="lh-empty">Not available.</p>')}

        ${section('resources', 'Resource analysis', `
          ${d.resources.length ? `<div class="lh-table-wrap"><table class="lh-table"><thead><tr><th>Resource type</th><th>Requests</th><th>Transfer size</th></tr></thead><tbody>${d.resources.filter(r => r.requests || r.type === 'total').map(r => `<tr class="${r.type === 'total' ? 'total' : ''}"><td>${esc(r.label)}</td><td class="lh-numeric">${r.requests}</td><td class="lh-bytes">${kib(r.bytes)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="lh-empty">Not available.</p>'}
          <h5 class="lh-sec-title">JavaScript treemap ${totalRes ? `<span class="count">${kib(d.treemap.reduce((s, t) => s + t.bytes, 0))} JS</span>` : ''}</h5>
          ${d.treemap.length ? `<div class="sp-treemap">${d.treemap.map(t => `
            <div class="sp-tm-row" title="${esc(t.name)}">
              <span class="lh-url">${esc(shortUrl(t.name))}</span>
              <div class="sp-tm-bar"><span class="used" style="width:${(t.bytes / maxTree) * 100}%"><span class="unused" style="width:${t.bytes ? (t.unused / t.bytes) * 100 : 0}%"></span></span></div>
              <span class="sp-tm-num">${kib(t.bytes)}${t.unused ? ` · ${Math.round((t.unused / t.bytes) * 100)}% unused` : ''}</span>
            </div>`).join('')}</div><p class="lh-more">Dark = used code, striped = unused code.</p>` : '<p class="lh-empty">Treemap not supported for this page.</p>'}`)}

        ${section('lcp', 'LCP breakdown', lcp ? `<p class="lh-desc">${md(lcp.description)}</p>${renderDetails(lcp.details)}` : '<p class="lh-empty">Not available.</p>')}

        ${section('cls', 'Layout shift analysis', cls.length ? cls.map(a => `<h5 class="lh-sec-title">${esc(a.title)} ${a.displayValue ? `<span class="count">${esc(a.displayValue)}</span>` : ''}</h5><p class="lh-desc">${md(a.description)}</p>${renderDetails(a.details)}`).join('') : '<p class="lh-empty">No layout shifts detected.</p>')}

        ${section('third', 'Third-party resources', `
          ${third ? `<p class="lh-desc">${md(third.description)}</p>${renderDetails(third.details) || '<p class="lh-empty">No third-party code found.</p>'}` : '<p class="lh-empty">Not available.</p>'}
          ${d.entities.length ? `<p class="lh-more">Origins seen: ${d.entities.map(e => `${esc(e.name)}${e.firstParty ? ' (1st party)' : ''}`).join(', ')}</p>` : ''}`)}

        ${section('env', 'Test environment', `
          <dl class="sp-env">
            ${[['Device', `${env.device || ''}${env.screen ? ` · ${env.screen}` : ''}`], ['Network throttling', env.network], ['CPU throttling', env.cpu], ['Session', env.session], ['Lighthouse version', env.lighthouseVersion], ['Captured', env.fetchTime ? new Date(env.fetchTime).toLocaleString() : null], ['Test duration', env.totalTime ? `${(env.totalTime / 1000).toFixed(1)} s` : null], ['CPU benchmark', env.benchmarkIndex], ['User agent', env.userAgent]].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
          </dl>
          ${env.warnings?.length ? `<div class="sp-warn"><b>Warnings:</b><ul>${env.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}`)}
      </div>`;
  }

  // ---------------------------------------------------------------- public render
  function render(el, ctx) {
    const { psi, errors, devices, view, onChange, onRetry, mock } = ctx;
    const dev = devices.includes(view.device) ? view.device : devices[0];
    const d = psi[dev];
    const err = errors[dev];

    const deviceSwitch = devices.length > 1 ? `<div class="seg" role="tablist" aria-label="Device">${devices.map(k => `<button type="button" role="tab" class="${k === dev ? 'active' : ''}" data-device="${k}" aria-selected="${k === dev}">${DEVICE[k]}${psi[k] ? ` <b class="c-${tone(psi[k].scores.performance)}">${psi[k].scores.performance}</b>` : errors[k] ? ' <b class="c-poor">!</b>' : ' <span class="spinner sm"></span>'}</button>`).join('')}</div>` : `<span class="pill">${DEVICE[dev]}</span>`;
    const viewSwitch = `<div class="seg seg-view" role="tablist" aria-label="Report view">${[['short', 'Short Report'], ['full', 'Expandable Report']].map(([k, label]) => `<button type="button" role="tab" class="${view.mode === k ? 'active' : ''}" data-view="${k}" aria-selected="${view.mode === k}">${label}</button>`).join('')}</div>`;

    let body;
    if (d) body = view.mode === 'full' ? fullReport(d) : shortReport(d, psi);
    else if (err) body = `<div class="error-box"><span>${esc(err)}</span><button class="btn btn-ghost btn-sm" type="button" data-retry="${dev}">Try again</button></div>`;
    else body = `<div class="loading-box"><span class="spinner"></span>Running Google PageSpeed on ${DEVICE[dev].toLowerCase()}… this takes 15–40 seconds.</div>`;

    el.innerHTML = `
      <div class="panel-head">
        <div><h3>Speed</h3><p>Google PageSpeed Insights · ${DEVICE[dev]}${d?.mock || mock ? ' · <strong>sample data</strong>' : ''}${d?.cached ? ' · cached' : ''}</p></div>
        ${d ? `<span class="pill c-${tone(d.scores.performance)}">${d.scores.performance}/100</span>` : ''}
      </div>
      <div class="sp-controls">${deviceSwitch}${viewSwitch}</div>
      ${body}`;

    el.querySelectorAll('[data-device]').forEach(b => b.addEventListener('click', () => onChange({ device: b.dataset.device })));
    el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => onChange({ mode: b.dataset.view })));
    el.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => onRetry(b.dataset.retry)));
    el.querySelectorAll('.sp-filter .filter').forEach(b => b.addEventListener('click', () => {
      el.querySelectorAll('.sp-filter .filter').forEach(x => x.classList.toggle('active', x === b));
      const k = b.dataset.metric;
      el.querySelectorAll('.sp-section[data-sec="audits"] .sp-audit').forEach(a => {
        a.hidden = k !== 'All' && !a.dataset.metrics.split(' ').includes(k);
      });
    }));
  }

  window.SpeedReport = { render, recommendation, DEVICE };
})();
