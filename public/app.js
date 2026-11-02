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
    ux: {
      label: 'AI UX / CRO review', expected: 40,
      steps: ['Capturing page screenshot', 'Reading page structure', 'Reviewing layout and copy', 'Checking trust signals and CTAs', 'Writing recommendations'],
    },
  };

  function renderTaskList() {
    $('#task-list').innerHTML = state.tests.map(k => `
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
      : TASKS[k].steps[Math.min(TASKS[k].steps.length - 1, Math.floor((t.pct / 95) * TASKS[k].steps.length))];
    $('.task-step', el).textContent = step + (t.status === 'running' ? '…' : '');
    $('.task-icon', el).textContent = t.status === 'done' ? '✓' : t.status === 'error' ? '!' : '';
    $('.task-pct', el).textContent = `${Math.round(t.pct)}%`;
    $('.mini span', el).style.width = `${t.pct}%`;
  }

  function tick() {
    const now = performance.now();
    let sum = 0;
    state.tests.forEach(k => {
      const t = state.tasks[k];
      if (t.status === 'running') {
        const elapsed = (now - t.startedAt) / 1000;
        t.pct = Math.min(95, 95 * (1 - Math.exp((-2 * elapsed) / TASKS[k].expected)));
        paintTask(k);
      }
      sum += t.pct;
    });
    const overall = Math.round(sum / state.tests.length);
    $('#progress-pct').textContent = `${overall}%`;
    $('#progress-bar span').style.width = `${overall}%`;
    $('#progress-bar').setAttribute('aria-valuenow', overall);

    const finished = state.tests.every(k => ['done', 'error'].includes(state.tasks[k].status));
    if (finished) finish();
  }

  function finish() {
    clearInterval(ticker);
    ticker = null;
    const card = $('#progress-card');
    card.classList.add('done');
    const failed = state.tests.filter(k => state.tasks[k].status === 'error').length;
    $('#progress-title').textContent = failed ? `Audit finished with ${failed} error${failed > 1 ? 's' : ''}` : 'Audit complete';
    $('#scan-btn').disabled = false;
    $('#cta-band').hidden = false;
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

  function startScan(url, tests, strategy) {
    if (ticker) clearInterval(ticker);
    state = {
      url, tests, strategy,
      startedAt: new Date(),
      tasks: Object.fromEntries(tests.map(k => [k, { status: 'queued', pct: 0, startedAt: 0 }])),
      results: {},
      psiPromise: null,
    };

    // Shareable link
    const params = new URLSearchParams({ url, tests: tests.join(','), device: strategy });
    history.replaceState(null, '', `?${params}`);

    $('#scan-btn').disabled = true;
    $('#results').hidden = false;
    $('#r-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('#r-meta').textContent = `${strategy === 'mobile' ? 'Mobile' : 'Desktop'} · ${state.startedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    $('#progress-card').classList.remove('done');
    $('#progress-title').textContent = 'Running your audit…';
    $('#cta-band').hidden = true;
    ['speed', 'seo', 'ux'].forEach(k => { const s = $(`#section-${k}`); s.hidden = true; s.innerHTML = ''; });
    $('#scores').hidden = true;
    renderTaskList();
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });

    ticker = setInterval(tick, 250);

    // PageSpeed runs when Speed is selected, and also for UX (it provides the screenshot).
    if (tests.includes('speed') || tests.includes('ux')) {
      state.psiPromise = api('/api/psi', { url, strategy });
      state.psiPromise.catch(() => {}); // handled below
    }
    if (tests.includes('speed')) runSpeed();
    if (tests.includes('seo')) runSeo();
    if (tests.includes('ux')) runUx();
  }

  async function runSpeed(retry = false) {
    const s = state;
    if (retry) s.psiPromise = api('/api/psi', { url: s.url, strategy: s.strategy });
    setTask('speed', 'running', { startedAt: performance.now(), pct: 0 });
    try {
      const data = await s.psiPromise;
      if (s !== state) return;
      s.results.psi = data;
      setTask('speed', 'done');
      renderSpeed(data);
      if (s.results.seo) renderSeo(s.results.seo); // adds the Lighthouse SEO score
    } catch (err) {
      if (s !== state) return;
      setTask('speed', 'error');
      renderError('speed', 'Speed test', err.message, () => runSpeed(true));
    }
    renderScores();
    resumeTicker();
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
    } catch (err) {
      if (s !== state) return;
      setTask('seo', 'error');
      renderError('seo', 'SEO checks', err.message, runSeo);
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
    if (s.psiPromise) {
      try { psi = await s.psiPromise; } catch { /* run without screenshot */ }
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
      $('#progress-card').classList.remove('done');
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
    const { psi, seo, ux } = state.results;
    const items = [];
    const failed = k => state.tasks[k]?.status === 'error';
    if (state.tests.includes('speed')) items.push(ring(psi?.scores.performance ?? null, 'Performance', failed('speed') ? 'Failed' : 'Google Lighthouse'));
    if (state.tests.includes('seo')) items.push(ring(seo?.score ?? null, 'SEO', seo ? `${seo.summary.failed} failed checks` : failed('seo') ? 'Failed' : 'Checking…'));
    if (state.tests.includes('ux')) items.push(ring(ux?.score ?? null, 'UX / Conversion', ux ? (ux.mode === 'ai' ? 'AI review' : 'Automatic checks') : failed('ux') ? 'Failed' : 'Reviewing…'));
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

  function renderSpeed(d) {
    const el = $('#section-speed');
    const mock = d.mock ? ' · <strong>sample data</strong>' : '';
    let html = panelHead('Speed', `Google PageSpeed Insights · ${d.strategy === 'mobile' ? 'Mobile' : 'Desktop'}${mock}`, d.scores.performance);

    html += `<h4 class="subhead">Lab metrics</h4><div class="metrics">${d.metrics.map(m => {
      const t = m.rating === 'good' ? 'good' : m.rating === 'average' ? 'avg' : m.rating === 'poor' ? 'poor' : 'na';
      return `<div class="metric"><div class="metric-label c-${t}"><i></i><span style="color:var(--ink-2)">${esc(m.label)}</span></div><div class="metric-value">${esc(m.value || '–')}</div></div>`;
    }).join('')}</div>`;

    if (d.field) {
      const verdict = d.field.passed === true ? 'passes' : d.field.passed === false ? 'does not pass' : 'has';
      html += `<h4 class="subhead">Real-user data (last 28 days)</h4>
        <p class="field-note">Based on Chrome users visiting this ${d.field.scope === 'origin' ? 'site' : 'page'}, it <strong>${verdict}</strong> the Core Web Vitals assessment.</p>
        <div class="metrics">${d.field.metrics.map(m => {
          const t = m.rating === 'good' ? 'good' : m.rating === 'average' ? 'avg' : m.rating === 'poor' ? 'poor' : 'na';
          return `<div class="metric"><div class="metric-label c-${t}"><i></i><span style="color:var(--ink-2)">${esc(m.label)}</span></div><div class="metric-value">${esc(m.value)}</div></div>`;
        }).join('')}</div>`;
    }

    if (d.opportunities.length) {
      html += `<h4 class="subhead">What's slowing it down</h4>${issueList(d.opportunities)}`;
    } else {
      html += `<h4 class="subhead">What's slowing it down</h4><p class="field-note">No major speed issues found. Nice work.</p>`;
    }
    if (d.a11yIssues?.length) {
      html += `<details class="more"><summary>Accessibility issues (${d.a11yIssues.length})</summary>${issueList(d.a11yIssues)}</details>`;
    }
    if (d.cached) html += `<p class="note">Showing a cached result from the last 30 minutes.</p>`;
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderSeo(d) {
    const el = $('#section-seo');
    const psi = state.results.psi;
    const icon = { pass: '✓', warn: '!', fail: '✕' };
    const row = c => `
      <li>
        <span class="status-icon ${c.status}" aria-label="${c.status}">${icon[c.status]}</span>
        <div>
          <div class="check-label">${esc(c.label)}</div>
          <div class="check-value">${esc(c.value)}</div>
          ${c.tip ? `<div class="check-tip">${esc(c.tip)}</div>` : ''}
        </div>
      </li>`;
    const problems = d.checks.filter(c => c.status !== 'pass');
    const passed = d.checks.filter(c => c.status === 'pass');

    let html = panelHead('SEO', `${d.checks.length} on-page checks`, d.score);
    html += `<div class="summary-row" style="margin-bottom:16px">
      <span class="pill c-poor">${d.summary.failed} failed</span>
      <span class="pill c-avg">${d.summary.warnings} warnings</span>
      <span class="pill c-good">${d.summary.passed} passed</span>
      ${psi?.scores.seo != null ? `<span class="pill c-${tone(psi.scores.seo)}">Lighthouse SEO ${psi.scores.seo}</span>` : ''}
    </div>`;
    if (problems.length) html += `<h4 class="subhead">Needs attention</h4><ul class="list checklist">${problems.map(row).join('')}</ul>`;
    if (passed.length) html += `<details class="more" ${problems.length ? '' : 'open'}><summary>Passed checks (${passed.length})</summary><ul class="list checklist">${passed.map(row).join('')}</ul></details>`;
    if (psi?.seoIssues?.length) html += `<details class="more"><summary>Google Lighthouse SEO findings (${psi.seoIssues.length})</summary>${issueList(psi.seoIssues)}</details>`;
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderUx(d, psi) {
    const el = $('#section-ux');
    const shot = psi?.screenshot || null;
    const desc = d.mode === 'ai'
      ? `AI review${d.usedScreenshot ? ' of your page screenshot and content' : ' of your page content'}`
      : 'Automatic conversion checks';

    const issueCard = i => `
      <article class="issue">
        <div class="issue-head"><span class="tag ${i.impact}">${esc(i.impact)} impact</span><span class="tag">${esc(i.area)}</span><h4>${esc(i.title)}</h4></div>
        <p>${esc(i.problem)}</p>
        <p class="fix"><b>Fix:</b> ${esc(i.fix)}</p>
      </article>`;

    let right = '';
    if (d.summary) right += `<p class="ux-summary">${esc(d.summary)}</p>`;
    if (d.categories?.length) {
      right += `<h4 class="subhead">Breakdown</h4><div class="cat-bars">${d.categories.map(c => `
        <div class="cat-bar c-${tone(c.score)}"><span style="color:var(--ink)">${esc(c.name)}</span><div class="track"><span style="width:${c.score}%"></span></div><span class="num">${c.score}</span></div>`).join('')}</div>`;
    }
    if (d.strengths?.length) right += `<h4 class="subhead">What's working</h4><div class="strengths">${d.strengths.map(s => `<span>${esc(s)}</span>`).join('')}</div>`;
    right += `<h4 class="subhead">Top issues</h4>`;
    right += d.issues.length ? d.issues.map(issueCard).join('') : '<p class="field-note">No major issues found.</p>';

    if (d.locked?.length) {
      const fake = d.locked.map(l => issueCard({ impact: l.impact, area: l.area, title: 'Upgrade to see this recommendation', problem: 'This issue and a step-by-step fix are included in the full audit report.', fix: 'Detailed instructions, mockup and priority.' })).join('');
      right += `
        <div class="locked-wrap">
          <div class="locked-list" aria-hidden="true">${fake}</div>
          <div class="locked-cta">
            <div>
              <strong>${d.locked.length} more issue${d.locked.length > 1 ? 's' : ''} found</strong>
              <p>${(h => h ? `${h} high impact. ` : '')(d.locked.filter(l => l.impact === 'high').length)}Get the full audit with a video walkthrough.</p>
              <button class="btn btn-primary" data-open-lead="Full Audit">Unlock full audit</button>
            </div>
          </div>
        </div>`;
    }
    if (d.aiError) right += `<p class="note">${esc(d.aiError)}.</p>`;

    el.innerHTML = panelHead('UX & Conversion', desc, d.score) +
      (shot ? `<div class="ux-grid"><div class="shot"><img src="${shot}" alt="Screenshot of the scanned page"></div><div>${right}</div></div>` : right);
    el.hidden = false;
  }

  function renderError(key, title, message, retry) {
    const el = $(`#section-${key}`);
    el.innerHTML = panelHead(title) + `<div class="error-box"><span>${esc(message)}</span><button class="btn btn-ghost btn-sm" type="button">Try again</button></div>`;
    $('button', el).addEventListener('click', () => { el.hidden = true; retry(); });
    el.hidden = false;
  }

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
        scores: { performance: r.psi?.scores.performance ?? null, seo: r.seo?.score ?? null, ux: r.ux?.score ?? null },
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
    urlInput.value = params.get('url').replace(/^https?:\/\//, '');
    const tests = (params.get('tests') || TEST_KEYS.join(',')).split(',').filter(t => TEST_KEYS.includes(t));
    TEST_KEYS.forEach(k => { chip(k).checked = tests.includes(k); });
    chip('all').checked = TEST_KEYS.every(k => chip(k).checked);
    const device = params.get('device') === 'desktop' ? 'desktop' : 'mobile';
    $(`input[name="strategy"][value="${device}"]`).checked = true;
    if (tests.length) form.requestSubmit();
  }
})();
