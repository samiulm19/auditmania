(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tone = n => (n == null ? 'na' : n >= 90 ? 'good' : n >= 50 ? 'avg' : 'poor');

  const form = $('#scan-form');
  const urlInput = $('#url');
  const formError = $('#form-error');
  const TEST_KEYS = ['speed', 'seo', 'ux'];

  let state = null;
  let ticker = null;

  $('#year').textContent = new Date().getFullYear();

  // ---------------------------------------------------------------------------
  // Test chips: "All tests" <-> individual tests
  // ---------------------------------------------------------------------------
  const chip = v => $(`input[name="test"][value="${v}"]`);
  $$('input[name="test"]').forEach(input => input.addEventListener('change', () => {
    if (input.value === 'all') TEST_KEYS.forEach(k => { chip(k).checked = input.checked; });
    chip('all').checked = TEST_KEYS.every(k => chip(k).checked);
  }));

  function selectedTests() { return TEST_KEYS.filter(k => chip(k).checked); }

  function normalizeUrl(raw) {
    let v = raw.trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      if (!u.hostname.includes('.')) return null;
      return u.toString();
    } catch { return null; }
  }

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = !msg;
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error('Network error. Check your connection and try again.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(data.error || (res.status === 504 ? 'The scan timed out. Please try again.' : `Request failed (${res.status})`));
    return data;
  }

  // Reads an NDJSON stream: progress events, then {type:"result"} or {type:"error"}
  async function apiStream(path, body, onProgress) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error('Network error. Check your connection and try again.');
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch { /* non-JSON */ }
      throw new Error(data.error || (res.status === 504 ? 'The crawl timed out. Please try again.' : `Request failed (${res.status})`));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'progress') onProgress(msg);
        else if (msg.type === 'result') return msg.data;
        else if (msg.type === 'error') throw new Error(msg.error);
      }
      if (done) break;
    }
    throw new Error('The crawl stopped unexpectedly. Please try again.');
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------
  const TASKS = {
    speed: {
      label: 'Speed test', expected: 28,
      steps: ['Connecting to Google PageSpeed', 'Loading your page', 'Measuring Core Web Vitals', 'Analyzing scripts and images', 'Building speed report'],
    },
    seo: {
      label: 'SEO checks', expected: 6,
      steps: ['Fetching page HTML', 'Checking title and meta tags', 'Checking headings and content', 'Checking robots.txt and sitemap', 'Scoring'],
    },
    crawl: {
      label: 'Full site SEO crawl', expected: 30,
      steps: ['Finding your sitemap', 'Discovering pages', 'Checking every page', 'Comparing titles and descriptions', 'Building site report'],
    },
    ux: {
      label: 'AI UX / CRO review', expected: 40,
      steps: ['Capturing page screenshot', 'Reading page structure', 'Reviewing layout and copy', 'Checking trust signals and CTAs', 'Writing recommendations'],
    },
  };

  function renderTaskList() {
    $('#task-list').innerHTML = state.taskKeys.map(k => `
      <li class="task queued" id="task-${k}">
        <span class="task-icon" aria-hidden="true"></span>
        <div><div class="task-name">${TASKS[k].label}</div><div class="task-step">Queued</div></div>
        <span class="task-pct">0%</span>
        <div class="mini"><span></span></div>
      </li>`).join('');
  }

  function setTask(k, status, extra = {}) {
    const t = state.tasks[k];
    Object.assign(t, { status }, extra);
    if (status === 'running' && !t.startedAt) t.startedAt = performance.now();
    if (status === 'done' || status === 'error') t.pct = 100;
    paintTask(k);
  }

  function paintTask(k) {
    const t = state.tasks[k];
    const el = $(`#task-${k}`);
    if (!el) return;
    el.className = `task ${t.status}`;
    const step = t.status === 'done' ? 'Complete'
      : t.status === 'error' ? 'Failed'
      : t.status === 'queued' ? 'Queued'
      : t.stepText || TASKS[k].steps[Math.min(TASKS[k].steps.length - 1, Math.floor((t.pct / 95) * TASKS[k].steps.length))];
    $('.task-step', el).textContent = step + (t.status === 'running' ? '…' : '');
    $('.task-icon', el).textContent = t.status === 'done' ? '✓' : t.status === 'error' ? '!' : '';
    $('.task-pct', el).textContent = `${Math.round(t.pct)}%`;
    $('.mini span', el).style.width = `${t.pct}%`;
  }

  function tick() {
    const now = performance.now();
    let sum = 0;
    state.taskKeys.forEach(k => {
      const t = state.tasks[k];
      if (t.status === 'running' && !t.real) {
        const elapsed = (now - t.startedAt) / 1000;
        t.pct = Math.min(95, 95 * (1 - Math.exp((-2 * elapsed) / TASKS[k].expected)));
        paintTask(k);
      }
      sum += t.pct;
    });
    const overall = Math.round(sum / state.taskKeys.length);
    $('#progress-pct').textContent = `${overall}%`;
    $('#progress-bar span').style.width = `${overall}%`;
    $('#progress-bar').setAttribute('aria-valuenow', overall);

    const finished = state.taskKeys.every(k => ['done', 'error'].includes(state.tasks[k].status));
    if (finished) finish();
  }

  function finish() {
    clearInterval(ticker);
    ticker = null;
    const card = $('#progress-card');
    card.classList.add('done');
    // Collapse the progress card shortly after everything finishes
    clearTimeout(finish.hideTimer);
    finish.hideTimer = setTimeout(() => {
      card.classList.add('collapsing');
      setTimeout(() => { if (card.classList.contains('collapsing')) card.hidden = true; }, 450);
    }, 1200);
    const failed = state.taskKeys.filter(k => state.tasks[k].status === 'error').length;
    $('#progress-title').textContent = failed ? `Audit finished with ${failed} error${failed > 1 ? 's' : ''}` : 'Audit complete';
    $('#scan-btn').disabled = false;
    $('#cta-band').hidden = false;
    $('#download-pdf').disabled = !Object.keys(state.results).length;
  }

  // ---------------------------------------------------------------------------
  // Run scan
  // ---------------------------------------------------------------------------
  form.addEventListener('submit', e => {
    e.preventDefault();
    showFormError('');
    const url = normalizeUrl(urlInput.value);
    if (!url) return showFormError('Please enter a valid website, like example.com');
    const tests = selectedTests();
    if (!tests.length) return showFormError('Pick at least one test.');
    const strategy = $('input[name="strategy"]:checked').value;
    startScan(url, tests, strategy);
  });

  const DEVICE_LABEL = { mobile: 'Mobile', desktop: 'Desktop', both: 'Mobile + Desktop' };
  const TAB_LABEL = { speed: 'Speed', seo: 'Page SEO', crawl: 'Full site SEO', ux: 'UX & CRO' };

  // First device's PageSpeed result (used for scores, Lighthouse SEO, screenshots)
  const primaryPsi = () => state?.results.psi?.[state.devices[0]] || state?.results.psi?.[state.devices[1]] || null;

  function startScan(url, tests, strategy) {
    if (ticker) clearInterval(ticker);
    // SEO = this page's detailed checks + a crawl of the whole site
    const taskKeys = tests.flatMap(k => (k === 'seo' ? ['seo', 'crawl'] : [k]));
    const devices = strategy === 'both' ? ['mobile', 'desktop'] : [strategy];
    state = {
      url, tests, strategy, devices, taskKeys,
      tabs: tests.flatMap(k => (k === 'seo' ? ['seo', 'crawl'] : [k])),
      activeTab: null,
      startedAt: new Date(),
      tasks: Object.fromEntries(taskKeys.map(k => [k, { status: 'queued', pct: 0, startedAt: 0 }])),
      results: {},
      psiPromises: {},
      psiErrors: {},
      speedView: { device: devices[0], mode: 'short' },
      previewDevice: devices[0],
    };

    // Shareable link
    const params = new URLSearchParams({ url, tests: tests.join(','), device: strategy });
    history.replaceState(null, '', `?${params}`);

    $('#scan-btn').disabled = true;
    $('#download-pdf').disabled = true;
    $('#results').hidden = false;
    $('#r-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('#r-meta').textContent = `${DEVICE_LABEL[strategy]} · ${state.startedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    clearTimeout(finish.hideTimer);
    $('#progress-card').hidden = false;
    $('#progress-card').classList.remove('done', 'collapsing');
    $('#progress-title').textContent = 'Running your audit…';
    $('#cta-band').hidden = true;
    $('#hero').classList.add('compact');
    ['speed', 'seo', 'crawl', 'ux'].forEach(k => {
      const sec = $(`#section-${k}`);
      sec.innerHTML = state.tabs.includes(k) ? panelHead(TAB_LABEL[k]) + `<div class="loading-box"><span class="spinner"></span>Running ${TAB_LABEL[k].toLowerCase()}… results appear here automatically.</div>` : '';
      sec.hidden = !state.tabs.includes(k);
    });
    $('#scores').hidden = true;
    renderTaskList();
    renderTabs();
    setTab(state.tabs[0]);
    initPreview();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });

    ticker = setInterval(tick, 250);

    // PageSpeed runs when Speed is selected, and also for UX (it provides the screenshot).
    if (tests.includes('speed') || tests.includes('ux')) devices.forEach(dev => startPsi(dev));
    if (tests.includes('speed')) runSpeed();
    if (tests.includes('seo')) { runSeo(); runCrawl(); }
    if (tests.includes('ux')) runUx();
  }

  function startPsi(dev) {
    const s = state;
    delete s.psiErrors[dev];
    const p = api('/api/psi', { url: s.url, strategy: dev });
    s.psiPromises[dev] = p;
    p.then(data => {
      if (s !== state) return;
      s.results.psi = { ...(s.results.psi || {}), [dev]: data };
      updatePreview();
      renderSpeed();
      if (s.results.seo) renderSeo(s.results.seo); // adds the Lighthouse SEO score
      renderScores();
      renderTabs();
    }, err => {
      if (s !== state) return;
      s.psiErrors[dev] = err.message;
      renderSpeed();
      updatePreview();
    });
    return p;
  }

  async function runSpeed(retryDevice) {
    const s = state;
    if (retryDevice) startPsi(retryDevice);
    setTask('speed', 'running', { startedAt: performance.now(), pct: retryDevice ? 0 : 0 });
    renderSpeed();
    const results = await Promise.allSettled(s.devices.map(d => s.psiPromises[d]));
    if (s !== state) return;
    const ok = results.some(r => r.status === 'fulfilled');
    setTask('speed', ok ? 'done' : 'error');
    renderSpeed();
    renderScores();
    renderTabs();
    resumeTicker();
  }

  function renderSpeed() {
    if (!state?.tests.includes('speed')) return;
    const el = $('#section-speed');
    window.SpeedReport.render(el, {
      psi: state.results.psi || {},
      errors: state.psiErrors,
      devices: state.devices,
      view: state.speedView,
      onChange: change => {
        Object.assign(state.speedView, change);
        if (change.device) { state.previewDevice = change.device; updatePreview(); }
        renderSpeed();
      },
      onRetry: dev => runSpeed(dev),
    });
    el.hidden = false;
  }

  async function runSeo() {
    const s = state;
    setTask('seo', 'running', { startedAt: performance.now(), pct: 0 });
    try {
      const data = await api('/api/seo', { url: s.url });
      if (s !== state) return;
      s.results.seo = data;
      setTask('seo', 'done');
      renderSeo(data);
      updatePreview();
    } catch (err) {
      if (s !== state) return;
      setTask('seo', 'error');
      renderError('seo', 'SEO checks', err.message, runSeo);
    }
    renderScores();
    resumeTicker();
  }

  async function runCrawl() {
    const s = state;
    setTask('crawl', 'running', { startedAt: performance.now(), pct: 0, real: false, stepText: '' });
    try {
      const data = await apiStream('/api/crawl', { url: s.url }, p => {
        if (s !== state) return;
        const t = s.tasks.crawl;
        t.real = true;
        const total = Math.max(p.total || 1, p.done || 0, 1);
        t.pct = Math.max(t.pct, Math.min(95, 4 + (91 * (p.done || 0)) / total));
        t.stepText = p.done ? `Checked ${p.done} of ${total} pages` : `Found ${total} page${total > 1 ? 's' : ''} via ${p.source === 'sitemap' ? 'sitemap' : 'links'}`;
        paintTask('crawl');
        tick();
      });
      if (s !== state) return;
      s.results.crawl = data;
      setTask('crawl', 'done', { stepText: '' });
      renderCrawl(data);
    } catch (err) {
      if (s !== state) return;
      setTask('crawl', 'error', { stepText: '' });
      renderError('crawl', 'Full site SEO', err.message, runCrawl);
    }
    renderScores();
    resumeTicker();
  }

  function pickScreenshots(psi) {
    if (!psi) return [];
    const shots = [];
    if (psi.screenshot) shots.push(psi.screenshot);
    if (psi.fullPageScreenshot && psi.fullPageScreenshot.length < 3_000_000) shots.push(psi.fullPageScreenshot);
    return shots;
  }

  async function runUx() {
    const s = state;
    setTask('ux', 'running', { startedAt: performance.now(), pct: 0 });
    let psi = null;
    const firstDev = s.devices[0];
    if (s.psiPromises[firstDev]) {
      try { psi = await s.psiPromises[firstDev]; } catch { /* run without screenshot */ }
    }
    if (s !== state) return;
    try {
      const data = await api('/api/ux', { url: s.url, screenshots: pickScreenshots(psi) });
      if (s !== state) return;
      s.results.ux = data;
      setTask('ux', 'done');
      renderUx(data, psi);
    } catch (err) {
      if (s !== state) return;
      setTask('ux', 'error');
      renderError('ux', 'AI UX / CRO review', err.message, runUx);
    }
    renderScores();
    resumeTicker();
  }

  function resumeTicker() {
    if (!ticker && state) {
      clearTimeout(finish.hideTimer);
      $('#progress-card').hidden = false;
      $('#progress-card').classList.remove('done', 'collapsing');
      $('#progress-title').textContent = 'Running your audit…';
      ticker = setInterval(tick, 250);
    }
    tick();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function ring(score, label, sub = '') {
    const r = 40, c = 2 * Math.PI * r;
    const t = tone(score);
    const off = score == null ? c : c * (1 - score / 100);
    return `
      <div class="score">
        <div class="ring c-${t}">
          <svg viewBox="0 0 96 96" aria-hidden="true">
            <circle class="track" cx="48" cy="48" r="${r}"/>
            <circle class="val" cx="48" cy="48" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
          </svg>
          <b>${score == null ? '–' : score}</b>
        </div>
        <div class="score-label">${esc(label)}</div>
        ${sub ? `<div class="score-sub">${esc(sub)}</div>` : ''}
      </div>`;
  }

  function renderScores() {
    const { seo, ux } = state.results;
    const psi = primaryPsi();
    const both = state.devices.length > 1;
    const items = [];
    const failed = k => state.tasks[k]?.status === 'error';
    if (state.tests.includes('speed')) {
      state.devices.forEach(dev => {
        const p = state.results.psi?.[dev];
        items.push(ring(p?.scores.performance ?? null, both ? `Performance · ${DEVICE_LABEL[dev]}` : 'Performance', state.psiErrors[dev] ? 'Failed' : both ? 'Google Lighthouse' : `Google Lighthouse · ${DEVICE_LABEL[dev]}`));
      });
    }
    if (state.tests.includes('seo')) items.push(ring(seo?.score ?? null, 'Page SEO', seo ? `${seo.summary.failed} failed of ${seo.summary.checks}` : failed('seo') ? 'Failed' : 'Checking…'));
    if (state.tests.includes('seo')) items.push(ring(state.results.crawl?.score ?? null, 'Full site SEO', state.results.crawl ? `${state.results.crawl.crawled} pages checked` : failed('crawl') ? 'Failed' : 'Crawling…'));
    if (state.tests.includes('ux')) items.push(ring(ux?.score ?? null, 'UX / Conversion', ux ? (ux.ai ? 'Checklist + AI' : `${ux.checks.checks} checks`) : failed('ux') ? 'Failed' : 'Reviewing…'));
    if (state.tests.includes('speed')) {
      items.push(ring(psi?.scores.accessibility ?? null, 'Accessibility'));
      items.push(ring(psi?.scores.bestPractices ?? null, 'Best practices'));
    }
    const box = $('#scores');
    box.innerHTML = items.join('');
    box.hidden = !Object.keys(state.results).length;
  }

  function panelHead(title, desc, score) {
    return `
      <div class="panel-head">
        <div><h3>${esc(title)}</h3>${desc ? `<p>${desc}</p>` : ''}</div>
        ${score != null ? `<span class="pill c-${tone(score)}">${score}/100</span>` : ''}
      </div>`;
  }

  function issueList(items) {
    return `<ul class="list">${items.map(o => `
      <li>
        <div class="item-top">
          <div class="item-title"><span class="sev ${o.severity}"></span>${esc(o.title)}</div>
          ${o.savings ? `<span class="saving">${esc(o.savings.replace(/^Est savings of /i, '−'))}</span>` : ''}
        </div>
        ${o.description ? `<p class="item-desc">${esc(o.description)}</p>` : ''}
      </li>`).join('')}</ul>`;
  }

  // ---------- shared checklist renderer (Page SEO + CRO) ----------
  const ICON = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

  function catBars(categories, anchorPrefix) {
    return `<div class="cat-bars">${categories.filter(c => c.score != null).map(c => `
      <a class="cat-bar c-${tone(c.score)}" href="#${anchorPrefix}-${slug(c.name)}">
        <span class="cat-name">${esc(c.name)}</span>
        <div class="track"><span style="width:${c.score}%"></span></div>
        <span class="num">${c.score}</span>
      </a>`).join('')}</div>`;
  }

  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  function checkRow(c) {
    return `
      <li>
        <span class="status-icon ${c.status}" aria-label="${c.status}">${ICON[c.status]}</span>
        <div>
          <div class="check-label">${esc(c.label)}${c.sev === 'high' && c.status === 'fail' ? ' <span class="tag high">Critical</span>' : ''}</div>
          ${c.value ? `<div class="check-value">${esc(c.value)}</div>` : ''}
          ${c.tip ? `<div class="check-tip">${esc(c.tip)}</div>` : ''}
          ${c.items?.length ? `<details class="items"><summary>Show ${c.items.length} item${c.items.length > 1 ? 's' : ''}</summary><ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
        </div>
      </li>`;
  }

  function checklist(categories, anchorPrefix) {
    return categories.map(c => {
      const bad = c.failed + c.warnings;
      const open = c.failed > 0;
      return `
        <details class="cat-block" id="${anchorPrefix}-${slug(c.name)}" ${open ? 'open' : ''}>
          <summary>
            <span class="cat-title">${esc(c.name)}</span>
            ${c.failed ? `<span class="pill c-poor">${c.failed} failed</span>` : ''}
            ${c.warnings ? `<span class="pill c-avg">${c.warnings} warn</span>` : ''}
            ${!bad ? '<span class="pill c-good">All good</span>' : ''}
            ${c.score != null ? `<span class="pill c-${tone(c.score)} cat-score">${c.score}</span>` : ''}
          </summary>
          <ul class="list checklist">${c.checks.map(checkRow).join('')}</ul>
        </details>`;
    }).join('');
  }

  function renderSeo(d) {
    const el = $('#section-seo');
    const psi = primaryPsi();
    let html = panelHead('Page SEO', `${d.summary.checks} checks on the page you entered${d.platforms?.length ? ` · Built with ${esc(d.platforms.slice(0, 2).join(' + '))}` : ''}`, d.score);
    html += `<div class="summary-row" style="margin-bottom:18px">
      <span class="pill c-poor">${d.summary.failed} failed</span>
      <span class="pill c-avg">${d.summary.warnings} warnings</span>
      <span class="pill c-good">${d.summary.passed} passed</span>
      ${d.summary.info ? `<span class="pill">${d.summary.info} notices</span>` : ''}
      ${psi?.scores.seo != null ? `<span class="pill c-${tone(psi.scores.seo)}">Lighthouse SEO ${psi.scores.seo}</span>` : ''}
    </div>`;
    html += `<h4 class="subhead">Score by category</h4>${catBars(d.categories, 'seo')}`;
    html += `<h4 class="subhead">All checks</h4><div class="cat-blocks">${checklist(d.categories, 'seo')}</div>`;
    if (psi?.seoIssues?.length) html += `<details class="more"><summary>Google Lighthouse SEO findings (${psi.seoIssues.length})</summary>${issueList(psi.seoIssues)}</details>`;
    if (d.checked?.partial) html += `<p class="note">Some links and files were skipped to keep the scan fast.</p>`;
    el.innerHTML = html;
    el.hidden = false;
    renderTabs();
  }

  function renderCrawl(d) {
    const el = $('#section-crawl');
    const short = u => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
    const sevLabel = { high: 'High', medium: 'Medium', low: 'Low' };
    const filters = ['All', ...new Set(d.groups.map(g => g.cat))];

    let html = panelHead('Full site SEO', `${d.crawled} pages · ${d.checksRun} checks · via ${esc(d.source)} · ${d.seconds}s`, d.score);
    html += `<div class="summary-row" style="margin-bottom:16px">
      <span class="pill c-poor">${d.summary.high} high</span>
      <span class="pill c-avg">${d.summary.medium} medium</span>
      <span class="pill">${d.summary.low} low</span>
      <span class="pill c-good">${d.pages.filter(p => !p.issues && p.status && p.status < 400 && !p.redirected).length} clean pages</span>
    </div>`;
    if (d.crawled >= d.limit && d.discovered > d.limit) {
      html += `<p class="field-note">Checked the first ${d.limit} of ${d.discovered}+ pages found. The full audit covers every page.</p>`;
    } else if (d.timedOut) {
      html += `<p class="field-note">The site responded slowly, so we stopped after ${d.crawled} pages.</p>`;
    }

    if (d.groups.length) {
      html += `<h4 class="subhead">Issues across the site</h4>
        <div class="filter-row" role="tablist">${filters.map((f, i) => `<button type="button" class="filter${i ? '' : ' active'}" data-filter="${esc(f)}">${esc(f)}${i ? ` <span>${d.groups.filter(g => g.cat === f).length}</span>` : ''}</button>`).join('')}</div>
        <div class="groups">${d.groups.map(g => `
        <details class="group" data-cat="${esc(g.cat)}">
          <summary>
            <span class="sev ${g.severity}"></span>
            <span class="g-label">${esc(g.label)}</span>
            <span class="tag ${g.severity}">${sevLabel[g.severity]}</span>
            <span class="g-count mono">${g.siteWide ? 'Site-wide' : `${g.count} page${g.count > 1 ? 's' : ''}`}</span>
          </summary>
          ${g.siteWide && g.detail ? `<p class="check-value">${esc(g.detail)}</p>` : ''}
          <p class="check-tip">${esc(g.tip)}</p>
          ${g.pages.length ? `<ul class="url-list">${g.pages.map(p => p.url
            ? `<li><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${esc(short(p.url))}</a>${p.detail ? `<span>${esc(p.detail)}</span>` : ''}</li>`
            : `<li><span class="plain">${esc(p.detail)}</span></li>`).join('')}
            ${g.count > g.pages.length ? `<li class="muted">+ ${g.count - g.pages.length} more</li>` : ''}</ul>` : ''}
        </details>`).join('')}</div>`;
    } else {
      html += `<p class="field-note">No site-wide SEO problems found. 🎉</p>`;
    }

    html += `<details class="more"><summary>All pages checked (${d.pages.length})</summary>
      <div class="table-wrap"><table class="pages-table">
        <thead><tr><th>Page</th><th>Status</th><th>Score</th><th>Words</th><th>Depth</th><th>Load</th><th>Issues</th></tr></thead>
        <tbody>${d.pages.map(p => `<tr>
          <td><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow" title="${esc(p.title)}">${esc(short(p.url))}</a></td>
          <td class="mono ${p.status >= 400 || !p.status ? 'bad' : p.redirected ? 'warnc' : ''}">${!p.status ? 'ERR' : p.redirected ? 'Redirect' : p.status}</td>
          <td class="mono ${p.score != null ? 'c-' + tone(p.score) : ''}">${p.score ?? '–'}</td>
          <td class="mono">${p.words ?? '–'}</td>
          <td class="mono">${p.depth ?? '–'}</td>
          <td class="mono">${p.timeMs ? (p.timeMs / 1000).toFixed(1) + 's' : '–'}</td>
          <td class="mono">${p.issues || (p.redirected ? '–' : '✓')}</td>
        </tr>`).join('')}</tbody>
      </table></div></details>`;

    el.innerHTML = html;
    $$('.filter', el).forEach(b => b.addEventListener('click', () => {
      $$('.filter', el).forEach(x => x.classList.toggle('active', x === b));
      const f = b.dataset.filter;
      $$('.group', el).forEach(g => { g.hidden = f !== 'All' && g.dataset.cat !== f; });
    }));
    el.hidden = false;
    renderTabs();
  }

  function renderUx(d, psi) {
    const el = $('#section-ux');
    const shot = psi?.screenshot || null;
    const ai = d.ai;
    const desc = `${d.checks.checks} conversion checks${ai ? ` + AI review${ai.usedScreenshot ? ' of your screenshot' : ''}` : ''}`;

    const issueCard = i => `
      <article class="issue">
        <div class="issue-head"><span class="tag ${i.impact}">${esc(i.impact)} impact</span><span class="tag">${esc(i.area)}</span><h4>${esc(i.title)}</h4></div>
        <p>${esc(i.problem)}</p>
        <p class="fix"><b>Fix:</b> ${esc(i.fix)}</p>
      </article>`;

    let top = `<p class="ux-summary">${esc(d.summary)}</p>
      <div class="summary-row" style="margin:10px 0 4px">
        <span class="pill c-poor">${d.checks.failed} blockers</span>
        <span class="pill c-avg">${d.checks.warnings} improvements</span>
        <span class="pill c-good">${d.checks.passed} passed</span>
      </div>
      <h4 class="subhead">Score by category</h4>${catBars(d.categories, 'cro')}`;

    let aiHtml = '';
    if (ai) {
      aiHtml += `<h4 class="subhead">AI review</h4>`;
      if (ai.summary) aiHtml += `<p class="ux-summary">${esc(ai.summary)}</p>`;
      if (ai.strengths?.length) aiHtml += `<div class="strengths" style="margin-bottom:14px">${ai.strengths.map(s => `<span>${esc(s)}</span>`).join('')}</div>`;
      aiHtml += ai.issues.map(issueCard).join('');
      if (ai.locked?.length) {
        const fake = ai.locked.map(l => issueCard({ impact: l.impact, area: l.area, title: 'Upgrade to see this recommendation', problem: 'This issue and a step-by-step fix are included in the full audit report.', fix: 'Detailed instructions, mockup and priority.' })).join('');
        aiHtml += `
          <div class="locked-wrap">
            <div class="locked-list" aria-hidden="true">${fake}</div>
            <div class="locked-cta">
              <div>
                <strong>${ai.locked.length} more AI finding${ai.locked.length > 1 ? 's' : ''}</strong>
                <p>${(h => h ? `${h} high impact. ` : '')(ai.locked.filter(l => l.impact === 'high').length)}Get the full audit with a video walkthrough.</p>
                <button class="btn btn-primary" data-open-lead="Full Audit">Unlock full audit</button>
              </div>
            </div>
          </div>`;
      }
    }

    const head = panelHead('UX & Conversion', desc, d.score);
    const upper = shot ? `<div class="ux-grid"><div class="shot"><img src="${shot}" alt="Screenshot of the scanned page"></div><div>${top}${aiHtml}</div></div>` : top + aiHtml;
    el.innerHTML = head + upper +
      `<h4 class="subhead">Conversion checklist</h4><div class="cat-blocks">${checklist(d.categories, 'cro')}</div>` +
      (d.aiError ? `<p class="note">${esc(d.aiError)}</p>` : '');
    el.hidden = false;
    renderTabs();
  }

  function renderError(key, title, message, retry) {
    const el = $(`#section-${key}`);
    el.innerHTML = panelHead(title) + `<div class="error-box"><span>${esc(message)}</span><button class="btn btn-ghost btn-sm" type="button">Try again</button></div>`;
    $('button', el).addEventListener('click', () => { el.innerHTML = panelHead(title) + '<div class="loading-box"><span class="spinner"></span>Retrying…</div>'; retry(); });
    el.hidden = false;
    renderTabs();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function tabScore(k) {
    const r = state.results;
    if (k === 'speed') {
      const vals = state.devices.map(d => r.psi?.[d]?.scores.performance).filter(v => v != null);
      return vals.length ? vals : null;
    }
    const v = k === 'seo' ? r.seo?.score : k === 'crawl' ? r.crawl?.score : r.ux?.score;
    return v != null ? [v] : null;
  }

  function renderTabs() {
    if (!state) return;
    const bar = $('#report-tabs');
    bar.hidden = state.tabs.length < 2;
    bar.innerHTML = state.tabs.map(k => {
      const t = state.tasks[k];
      const sc = tabScore(k);
      const status = sc ? sc.map(v => `<b class="c-${tone(v)}">${v}</b>`).join('<i>/</i>')
        : t?.status === 'error' ? '<b class="c-poor">!</b>'
        : '<span class="spinner sm"></span>';
      return `<button type="button" role="tab" class="report-tab${state.activeTab === k ? ' active' : ''}" data-tab="${k}" aria-selected="${state.activeTab === k}" aria-controls="section-${k}">${TAB_LABEL[k]}<span class="tab-score">${status}</span></button>`;
    }).join('');
    $$('.report-tab', bar).forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  }

  function setTab(k) {
    if (!state || !k) return;
    state.activeTab = k;
    ['speed', 'seo', 'crawl', 'ux'].forEach(x => $(`#section-${x}`).classList.toggle('tab-off', x !== k));
    renderTabs();
  }

  // ---------------------------------------------------------------------------
  // Website preview (PageSpeed screenshot, or a live iframe when the site allows it)
  // ---------------------------------------------------------------------------
  function initPreview() {
    let host = state.url;
    try { host = new URL(state.url).hostname; } catch { /* ignore */ }
    $('#preview-host').textContent = host;
    $('#preview-open').href = state.url;
    $('#preview-devices').hidden = true;
    $('#preview').dataset.device = state.previewDevice;
    $('#preview-body').innerHTML = `<div class="preview-empty"><span class="spinner"></span>Capturing preview…</div>`;
  }

  function updatePreview() {
    if (!state) return;
    const psi = state.results.psi || {};
    const shots = state.devices.filter(d => psi[d]?.screenshot || psi[d]?.fullPageScreenshot);
    const devBox = $('#preview-devices');
    devBox.hidden = shots.length < 2;
    devBox.innerHTML = shots.map(d => `<button type="button" class="${d === state.previewDevice ? 'active' : ''}" data-pdev="${d}">${DEVICE_LABEL[d]}</button>`).join('');
    $$('[data-pdev]', devBox).forEach(b => b.addEventListener('click', () => { state.previewDevice = b.dataset.pdev; updatePreview(); }));

    const dev = shots.includes(state.previewDevice) ? state.previewDevice : shots[0] || state.previewDevice;
    const p = psi[dev];
    const preview = $('#preview');
    preview.dataset.device = dev;
    const body = $('#preview-body');
    const img = p?.fullPageScreenshot || p?.screenshot;
    if (img) {
      if (body.dataset.src !== img) {
        body.dataset.src = img;
        body.innerHTML = `<img src="${img}" alt="${esc(DEVICE_LABEL[dev])} screenshot of ${esc(state.url)}">`;
      }
      return;
    }
    body.dataset.src = '';
    const embed = state.results.seo?.embed;
    if (embed?.allowed) {
      if (!body.querySelector('iframe')) {
        body.innerHTML = `<div class="iframe-wrap ${dev}"><iframe src="${esc(embed.url)}" title="Live preview of ${esc(state.url)}" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe></div>`;
      }
      return;
    }
    const waiting = Object.values(state.psiPromises).length && state.devices.some(d => !psi[d] && !state.psiErrors[d]);
    body.innerHTML = waiting || (!Object.keys(state.psiPromises).length && !state.results.seo && state.tests.includes('seo'))
      ? `<div class="preview-empty"><span class="spinner"></span>Capturing preview…</div>`
      : `<div class="preview-empty">Preview not available.<br><small>Run the Speed test to capture a screenshot.</small></div>`;
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------
  $('#download-pdf').addEventListener('click', async () => {
    if (!state) return;
    const btn = $('#download-pdf');
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparing PDF…';
    try {
      await window.PdfReport.download({
        url: state.url,
        startedAt: state.startedAt,
        devices: state.devices,
        tests: state.tests,
        results: state.results,
        deviceLabel: DEVICE_LABEL,
      });
    } catch (e) {
      console.error(e);
      toast('Could not create the PDF. Please try again.');
    } finally {
      btn.innerHTML = label;
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  $('#new-scan').addEventListener('click', () => {
    $('#hero').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => urlInput.focus(), 400);
  });

  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Report link copied'); }
    catch { toast('Copy failed. Copy the address bar instead.'); }
  });

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------------------------------------------------------------------------
  // Lead modal
  // ---------------------------------------------------------------------------
  const modal = $('#lead-modal');
  const leadForm = $('#lead-form');
  const leadError = $('#lead-error');

  document.addEventListener('click', e => {
    const opener = e.target.closest('[data-open-lead]');
    if (opener) {
      leadForm.hidden = false;
      $('#lead-done').hidden = true;
      leadError.hidden = true;
      $('#l-plan').value = opener.dataset.openLead;
      if (state?.url && !$('#l-site').value) $('#l-site').value = state.url;
      modal.showModal();
      setTimeout(() => $('#l-name').focus(), 50);
    }
    if (e.target.closest('[data-close]')) modal.close();
  });
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

  leadForm.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(leadForm));
    if (!fd.name.trim()) return showLeadError('Please add your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fd.email)) return showLeadError('Please enter a valid email.');
    const btn = $('button[type="submit"]', leadForm);
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const r = state?.results || {};
      await api('/api/lead', {
        ...fd,
        scores: { performance: primaryPsi()?.scores.performance ?? null, seo: r.seo?.score ?? null, siteSeo: r.crawl?.score ?? null, ux: r.ux?.score ?? null },
      });
      leadForm.hidden = true;
      $('#lead-done').hidden = false;
      leadForm.reset();
    } catch (err) {
      showLeadError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send request';
    }
  });

  function showLeadError(msg) { leadError.textContent = msg; leadError.hidden = false; }

  // ---------------------------------------------------------------------------
  // Auto-run from shared link: ?url=...&tests=speed,seo&device=mobile
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('url')) {
    urlInput.value = params.get('url').replace(/^https:\/\//, ''); // keep http:// so http-only sites still work
    const tests = (params.get('tests') || TEST_KEYS.join(',')).split(',').filter(t => TEST_KEYS.includes(t));
    TEST_KEYS.forEach(k => { chip(k).checked = tests.includes(k); });
    chip('all').checked = TEST_KEYS.every(k => chip(k).checked);
    const device = ['desktop', 'both'].includes(params.get('device')) ? params.get('device') : 'mobile';
    $(`input[name="strategy"][value="${device}"]`).checked = true;
    if (tests.length) form.requestSubmit();
  }
})();
