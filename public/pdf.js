/* PDF report: built from the same results shown on screen (no extra API calls).
   Uses self-hosted jsPDF + AutoTable from /vendor, loaded only when the user clicks Download. */
(() => {
  'use strict';

  const C = {
    ink: [21, 22, 26], ink2: [74, 76, 85], muted: [125, 127, 136], line: [228, 226, 219], bg: [246, 245, 241],
    accent: [255, 90, 31], good: [12, 157, 88], avg: [217, 138, 0], poor: [224, 54, 44],
  };
  const toneColor = n => (n == null ? C.muted : n >= 90 ? C.good : n >= 50 ? C.avg : C.poor);
  const ratingColor = r => ({ good: C.good, average: C.avg, poor: C.poor }[r] || C.muted);
  const ratingText = r => ({ good: 'Good', average: 'Needs improvement', poor: 'Poor' }[r] || 'No data');
  const STATUS = { fail: 'Fail', warn: 'Warning', info: 'Notice', pass: 'Pass' };

  // Standard PDF fonts only cover Latin-1; map common symbols and drop the rest.
  const T = s => String(s ?? '')
    .replace(/[→↗]/g, '->').replace(/←/g, '<-').replace(/[✓✔]/g, 'OK').replace(/[✕✖×]/g, 'x')
    .replace(/[★⭐]/g, '*').replace(/[−–—]/g, '-').replace(/…/g, '...').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/ /g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '')
    .replace(/[^\x00-\xFF•]/g, '');

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function ensureLibs() {
    if (!window.jspdf) await loadScript('/vendor/jspdf.umd.min.js');
    if (!window.jspdf?.jsPDF?.API?.autoTable) await loadScript('/vendor/jspdf.plugin.autotable.min.js');
  }

  async function download(ctx) {
    await ensureLibs();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 40;
    let y = M;
    const host = (() => { try { return new URL(ctx.url).hostname; } catch { return ctx.url; } })();
    const r = ctx.results;
    const psiList = ctx.devices.map(d => r.psi?.[d]).filter(Boolean);
    const primary = psiList[0];

    const space = h => { if (y + h > H - 50) { doc.addPage(); y = M; } };
    const text = (s, x, size = 10, color = C.ink, style = 'normal', maxW = W - M * 2) => {
      doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(T(s), maxW);
      space(lines.length * size * 1.3);
      doc.text(lines, x, y + size);
      y += lines.length * size * 1.3;
      return lines.length;
    };
    const heading = (title, sub) => {
      space(60);
      y += 10;
      doc.setFillColor(...C.ink); doc.rect(M, y, 4, 22, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...C.ink);
      doc.text(T(title), M + 12, y + 16);
      y += 28;
      if (sub) { text(sub, M, 9.5, C.muted); }
      y += 6;
    };
    const subheading = s => { space(30); y += 6; text(s.toUpperCase(), M, 8.5, C.muted, 'bold'); y += 2; };
    const table = (head, body, opts = {}) => {
      if (!body.length) return;
      space(60); // never leave a table header alone at the bottom of a page
      doc.autoTable({
        rowPageBreak: 'avoid',
        startY: y, head: [head.map(T)], body: body.map(row => row.map(c => (typeof c === 'object' && c !== null ? { ...c, content: T(c.content) } : T(c)))),
        margin: { left: M, right: M, bottom: 50 },
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5, textColor: C.ink, lineColor: C.line, lineWidth: 0.5, overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: C.bg, textColor: C.muted, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: [252, 251, 249] },
        ...opts,
      });
      y = doc.lastAutoTable.finalY + 12;
    };
    const statusCell = st => ({ content: STATUS[st] || st, styles: { textColor: st === 'fail' ? C.poor : st === 'warn' ? C.avg : st === 'pass' ? C.good : C.muted, fontStyle: 'bold' } });
    const sevCell = sv => ({ content: sv[0].toUpperCase() + sv.slice(1), styles: { textColor: sv === 'high' ? C.poor : sv === 'medium' ? C.avg : C.muted, fontStyle: 'bold' } });

    // ------------------------------------------------------------ cover band
    doc.setFillColor(...C.ink); doc.rect(0, 0, W, 118, 'F');
    doc.setFillColor(...C.accent); doc.circle(M + 6, 34, 5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(255, 255, 255);
    doc.text('AuditLab', M + 18, 38);
    doc.setFontSize(22); doc.text('Website Audit Report', M, 72);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(200, 201, 208);
    doc.text(T(`${ctx.url}`), M, 92);
    doc.text(T(`${ctx.devices.map(d => ctx.deviceLabel[d]).join(' + ')} · ${new Date(ctx.startedAt).toLocaleString()}`), M, 107);
    y = 140;

    // ------------------------------------------------------------ score summary
    const boxes = [];
    if (ctx.tests.includes('speed')) ctx.devices.forEach(d => boxes.push([`Performance${ctx.devices.length > 1 ? ` (${ctx.deviceLabel[d]})` : ''}`, r.psi?.[d]?.scores.performance]));
    if (ctx.tests.includes('seo')) { boxes.push(['Page SEO', r.seo?.score]); boxes.push(['Full site SEO', r.crawl?.score]); }
    if (ctx.tests.includes('ux')) boxes.push(['UX / Conversion', r.ux?.score]);
    if (primary) { boxes.push(['Accessibility', primary.scores.accessibility]); boxes.push(['Best practices', primary.scores.bestPractices]); }
    const perRow = Math.min(4, boxes.length) || 1;
    const bw = (W - M * 2 - (perRow - 1) * 10) / perRow;
    boxes.forEach(([label, score], i) => {
      const col = i % perRow;
      if (col === 0 && i) y += 74;
      const x = M + col * (bw + 10);
      doc.setDrawColor(...C.line); doc.setFillColor(255, 255, 255); doc.roundedRect(x, y, bw, 64, 6, 6, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(...toneColor(score));
      doc.text(score == null ? '-' : String(score), x + 12, y + 32);
      doc.setFontSize(8.5); doc.setTextColor(...C.ink2); doc.setFont('helvetica', 'normal');
      doc.text(doc.splitTextToSize(T(label), bw - 20), x + 12, y + 48);
    });
    y += boxes.length ? 82 : 0;

    // ------------------------------------------------------------ top priorities + screenshot
    const priorities = [];
    if (primary) primary.audits.filter(a => a.status === 'fail').slice(0, 3).forEach(a => priorities.push(`Speed: ${a.title}${a.displayValue ? ` (${a.displayValue})` : ''}`));
    if (r.seo) r.seo.categories.flatMap(c => c.checks).filter(k => k.status === 'fail' && k.sev === 'high').slice(0, 3).forEach(k => priorities.push(`SEO: ${k.label} - ${k.value}`));
    if (r.crawl) r.crawl.groups.filter(g => g.severity === 'high').slice(0, 2).forEach(g => priorities.push(`Site: ${g.label}${g.siteWide ? '' : ` (${g.count} pages)`}`));
    if (r.ux) r.ux.categories.flatMap(c => c.checks).filter(k => k.status === 'fail').slice(0, 3).forEach(k => priorities.push(`Conversion: ${k.label} - ${k.value}`));

    const shot = primary?.screenshot;
    const startY = y;
    const textW = shot ? W - M * 2 - 150 : W - M * 2;
    if (priorities.length) {
      text('Top priorities', M, 13, C.ink, 'bold', textW);
      y += 4;
      priorities.slice(0, 10).forEach((p, i) => {
        space(16); doc.setFillColor(...C.accent); doc.circle(M + 4, y + 7, 2.2, 'F');
        const n = doc.splitTextToSize(T(p), textW - 14);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C.ink);
        doc.text(n, M + 14, y + 10);
        y += n.length * 12.5 + 3;
      });
    }
    if (shot) {
      try {
        const props = doc.getImageProperties(shot);
        const iw = 130;
        const ih = Math.min(260, (props.height / props.width) * iw);
        doc.setDrawColor(...C.line);
        doc.addImage(shot, 'JPEG', W - M - iw, startY, iw, ih, undefined, 'FAST');
        doc.rect(W - M - iw, startY, iw, ih);
        y = Math.max(y, startY + ih + 10);
      } catch { /* skip image */ }
    }

    // ------------------------------------------------------------ Speed
    if (ctx.tests.includes('speed')) {
      ctx.devices.forEach(dev => {
        const d = r.psi?.[dev];
        heading(`Speed - ${ctx.deviceLabel[dev]}`, d ? `Google PageSpeed Insights · Lighthouse ${d.lighthouseVersion || ''}${d.mock ? ' · sample data' : ''}` : 'Not available');
        if (!d) return;
        text(`Performance score: ${d.scores.performance}/100`, M, 12, toneColor(d.scores.performance), 'bold');
        const a = d.field?.assessment;
        text(a ? `Core Web Vitals assessment: ${a.passed ? 'Passed' : 'Failed'} (${a.scope === 'origin' ? 'whole site' : 'this URL'}, real users)` : 'Core Web Vitals assessment: No Data (not enough real-user traffic)', M, 9.5, a ? (a.passed ? C.good : C.poor) : C.muted);
        y += 4;
        subheading('Lab metrics');
        table(['Metric', 'Value', 'Rating'], d.metrics.map(m => [`${m.label}${m.acronym ? ` (${m.acronym})` : ''}`, m.value, { content: ratingText(m.rating), styles: { textColor: ratingColor(m.rating), fontStyle: 'bold' } }]), { columnStyles: { 1: { cellWidth: 90 }, 2: { cellWidth: 110 } } });
        const fm = d.field?.page || d.field?.origin;
        if (fm) {
          subheading(`Real-user data (${d.field.page ? 'this URL' : 'origin'})`);
          table(['Metric', '75th percentile', 'Rating', 'Good / OK / Poor'], fm.metrics.map(m => [`${m.label} (${m.acronym})`, m.value, { content: ratingText(m.rating), styles: { textColor: ratingColor(m.rating), fontStyle: 'bold' } }, m.distribution?.length === 3 ? `${m.distribution[0]}% / ${m.distribution[1]}% / ${m.distribution[2]}%` : '-']));
        }
        const fails = d.audits.filter(x => x.status === 'fail');
        subheading(`Issues to fix (${fails.length})`);
        if (fails.length) {
          table(['Issue', 'Est. savings', 'Affects', 'How to fix'], fails.slice(0, 15).map(x => [{ content: x.title, styles: { fontStyle: 'bold' } }, x.displayValue || '-', x.metrics.join(', ') || '-', window.SpeedReport.recommendation(x)]), { columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 80 }, 2: { cellWidth: 55 } } });
        } else text('No performance issues found.', M, 9.5, C.good);
        const env = d.environment || {};
        text(`Test environment: ${[env.device, env.network, env.cpu].filter(Boolean).join(' · ')}`, M, 8.5, C.muted);
      });
    }

    // ------------------------------------------------------------ Page SEO
    if (r.seo) {
      heading('Page SEO', `${r.seo.summary.checks} checks · ${r.seo.summary.failed} failed · ${r.seo.summary.warnings} warnings · ${r.seo.summary.passed} passed`);
      text(`Score: ${r.seo.score}/100`, M, 12, toneColor(r.seo.score), 'bold');
      table(['Category', 'Score', 'Failed', 'Warnings'], r.seo.categories.filter(c => c.score != null).map(c => [c.name, { content: String(c.score), styles: { textColor: toneColor(c.score), fontStyle: 'bold' } }, String(c.failed), String(c.warnings)]), { columnStyles: { 1: { cellWidth: 60 }, 2: { cellWidth: 60 }, 3: { cellWidth: 70 } } });
      const rows = r.seo.categories.flatMap(c => c.checks.filter(k => k.status !== 'pass').map(k => [c.name, statusCell(k.status), { content: k.label, styles: { fontStyle: 'bold' } }, k.value, k.tip]));
      subheading('Checks that need attention');
      if (rows.length) table(['Category', 'Status', 'Check', 'Finding', 'How to fix'], rows, { columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 50 }, 2: { cellWidth: 100 }, 3: { cellWidth: 110 } } });
      else text('All checks passed.', M, 9.5, C.good);
    }

    // ------------------------------------------------------------ Full site SEO
    if (r.crawl) {
      heading('Full site SEO', `${r.crawl.crawled} pages crawled via ${r.crawl.source} · ${r.crawl.checksRun} checks`);
      text(`Score: ${r.crawl.score}/100 · ${r.crawl.summary.high} high, ${r.crawl.summary.medium} medium, ${r.crawl.summary.low} low priority issues`, M, 11, toneColor(r.crawl.score), 'bold');
      y += 4;
      if (r.crawl.groups.length) {
        table(['Priority', 'Issue', 'Category', 'Pages', 'Examples'], r.crawl.groups.map(g => [
          sevCell(g.severity), { content: g.label, styles: { fontStyle: 'bold' } }, g.cat, g.siteWide ? 'Site-wide' : String(g.count),
          g.siteWide ? (g.detail || '') : g.pages.slice(0, 3).map(p => { try { return new URL(p.url).pathname; } catch { return p.url; } }).join('\n'),
        ]), { columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 140 }, 2: { cellWidth: 75 }, 3: { cellWidth: 48 } } });
      } else text('No site-wide issues found.', M, 9.5, C.good);
    }

    // ------------------------------------------------------------ UX / CRO
    if (r.ux) {
      heading('UX & Conversion', r.ux.summary);
      text(`Score: ${r.ux.score}/100`, M, 12, toneColor(r.ux.score), 'bold');
      table(['Category', 'Score', 'Failed', 'Warnings'], r.ux.categories.filter(c => c.score != null).map(c => [c.name, { content: String(c.score), styles: { textColor: toneColor(c.score), fontStyle: 'bold' } }, String(c.failed), String(c.warnings)]), { columnStyles: { 1: { cellWidth: 60 }, 2: { cellWidth: 60 }, 3: { cellWidth: 70 } } });
      if (r.ux.ai?.issues?.length) {
        subheading('AI review');
        if (r.ux.ai.summary) text(r.ux.ai.summary, M, 9.5, C.ink2);
        table(['Impact', 'Issue', 'Problem', 'Fix'], r.ux.ai.issues.map(i => [sevCell(i.impact), { content: i.title, styles: { fontStyle: 'bold' } }, i.problem, i.fix]), { columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 110 } } });
        if (r.ux.ai.locked?.length) text(`+ ${r.ux.ai.locked.length} more AI findings are included in the full manual audit.`, M, 9, C.accent, 'bold');
      }
      const rows = r.ux.categories.flatMap(c => c.checks.filter(k => k.status !== 'pass').map(k => [c.name, statusCell(k.status), { content: k.label, styles: { fontStyle: 'bold' } }, k.value, k.tip]));
      subheading('Conversion checklist - needs attention');
      if (rows.length) table(['Category', 'Status', 'Check', 'Finding', 'How to fix'], rows, { columnStyles: { 0: { cellWidth: 75 }, 1: { cellWidth: 50 }, 2: { cellWidth: 100 }, 3: { cellWidth: 95 } } });
      else text('All conversion checks passed.', M, 9.5, C.good);
    }

    // ------------------------------------------------------------ CTA + footer
    space(90);
    y += 10;
    doc.setFillColor(...C.bg); doc.roundedRect(M, y, W - M * 2, 70, 8, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...C.ink);
    doc.text('Want a human to fix this?', M + 16, y + 26);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...C.ink2);
    doc.text(T('Get a manual UX/CRO audit with a video walkthrough and a prioritized fix list, delivered in 72 hours.'), M + 16, y + 44, { maxWidth: W - M * 2 - 32 });
    y += 80;

    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setDrawColor(...C.line); doc.line(M, H - 34, W - M, H - 34);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.muted);
      doc.text(T(`AuditLab · ${host}`), M, H - 20);
      doc.text(`Page ${i} of ${pages}`, W - M, H - 20, { align: 'right' });
    }

    const date = new Date(ctx.startedAt).toISOString().slice(0, 10);
    doc.save(`audit-${host.replace(/[^a-z0-9.-]/gi, '')}-${date}.pdf`);
    return doc;
  }

  window.PdfReport = { download };
})();
