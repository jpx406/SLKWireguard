/* ============================================================================
 * td-yieldcurve.js — Yield curve panel for Trading Desk (canvas, no deps)
 *
 *   const yc = TD.YieldCurve.mount(document.getElementById('yields'), {
 *     countries: ['US', 'DE', 'GB'],       // initial overlay
 *     compare: [7, 30, 365],               // "N days ago" ghost curves (from local snapshots / proxy history)
 *   });
 *   yc.setCountries(['US','SA']); yc.refresh(); yc.destroy();
 *
 * Data: TD.fetchCurve (TradingView TVC:<CC><tenor> symbols → official proxy → snapshot).
 * GCC sovereigns are derived from the bond scanner (see TD.fetchSovereignCurve below).
 * ========================================================================== */
(function (global) {
  'use strict';
  const TD = global.TD;
  if (!TD) throw new Error('td-data.js must load before td-yieldcurve.js');

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const PALETTE = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#e879f9'];
  const nf2 = (v) => v == null ? '—' : (Math.round(v * 1000) / 1000).toFixed(3) + '%';
  const sign = (v, d = 1, unit = '') => v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + unit;

  /* ---- GCC / sovereign curve from the bond scanner --------------------- */
  const SOVEREIGN_ISSUER = { SA: 'Saudi', AE: 'Abu Dhabi|Emirates|Dubai', QA: 'Qatar', BH: 'Bahrain', KW: 'Kuwait', OM: 'Oman' };
  async function fetchSovereignCurve(cc) {
    const body = {
      columns: ['name', 'bond_issuer.tr', 'yield_to_maturity', 'days_to_maturity', 'maturity_date', 'currency', 'current_coupon', 'close_net'],
      filter: [{ left: 'exchange', operation: 'in_range', right: ['BONDSCOM'] }],
      filter2: { operator: 'and', operands: [
        { expression: { left: 'country_code_fund', operation: 'in_range', right: [cc] } },
        { expression: { left: 'sector', operation: 'equal', right: 'Government' } },
        { expression: { left: 'yield_to_maturity', operation: 'greater', right: 0 } },
        { expression: { left: 'yield_to_maturity', operation: 'less', right: 25 } },
        { expression: { left: 'days_to_maturity', operation: 'greater', right: 30 } },
      ] },
      sort: { sortBy: 'days_to_maturity', sortOrder: 'asc' },
      range: [0, 300],
    };
    const reply = await TD.scan('bond', body, { label: 'yield-curve-sovereign', ttl: 10 * 60 * 1000 });
    const re = new RegExp(SOVEREIGN_ISSUER[cc] || cc, 'i');
    const usd = [], all = [];
    for (const { s, d } of reply.data) {
      const [name, issuer, ytm, days, mat, ccy] = d;
      if (ytm == null || !days) continue;
      if (issuer && !re.test(issuer)) continue;               // keep the sovereign itself, drop corporates
      const pt = { isin: name, issuer, years: days / 365.25, yield: ytm, maturity: mat, ccy };
      all.push(pt); if (ccy === 'USD') usd.push(pt);
    }
    const pts = (usd.length >= 3 ? usd : all).sort((a, b) => a.years - b.years);
    // Bucket into standard tenors (median YTM per bucket) so the curve is comparable with benchmarks.
    const buckets = [[0.5, '6M'], [1, '1Y'], [2, '2Y'], [3, '3Y'], [5, '5Y'], [7, '7Y'], [10, '10Y'], [15, '15Y'], [20, '20Y'], [30, '30Y'], [40, '40Y']];
    const points = [];
    for (const [yrs, tenor] of buckets) {
      const lo = yrs * 0.75, hi = yrs * 1.25;
      const ys = pts.filter(p => p.years >= lo && p.years <= hi).map(p => p.yield).sort((a, b) => a - b);
      if (ys.length) points.push({ tenor, years: yrs, yield: ys[Math.floor(ys.length / 2)], n: ys.length });
    }
    return { cc, label: TD.CURVES[cc].label, flag: TD.CURVES[cc].flag, points, bonds: pts, source: 'bond-scanner', derived: true, transport: reply.transport, stale: !!reply.stale, at: reply.at };
  }
  TD.fetchSovereignCurve = fetchSovereignCurve;
  const origFetchCurve = TD.fetchCurve;
  TD.fetchCurve = async function (cc) {
    if (TD.CURVES[cc] && TD.CURVES[cc].gcc) {
      try { const v = await origFetchCurve(cc); if (v.points.length >= 3) return v; } catch (e) { /* fall through */ }
      return fetchSovereignCurve(cc);
    }
    return origFetchCurve(cc);
  };

  /* ---- component ---------------------------------------------------------- */
  function mount(root, opts = {}) {
    const S = { countries: opts.countries || ['US'], compare: opts.compare || [7, 30, 365], curves: {}, ghosts: {}, hover: null, loading: false, error: null, logScale: false, reqId: 0 };
    const key = 'td:yc:ui:' + (opts.id || 'main');
    try { Object.assign(S, JSON.parse(localStorage.getItem(key) || '{}'), { curves: {}, ghosts: {}, hover: null, loading: false }); } catch (e) { /* ignore */ }
    const persist = () => { try { localStorage.setItem(key, JSON.stringify({ countries: S.countries, compare: S.compare, logScale: S.logScale })); } catch (e) { /* ignore */ } };

    root.classList.add('td-yc'); root.innerHTML = '';
    const el = {};
    el.pills = h('div', { class: 'td-yc__pills', role: 'group', 'aria-label': 'Countries' });
    el.compare = h('div', { class: 'td-yc__compare', role: 'group', 'aria-label': 'Compare with' });
    el.scale = h('label', { class: 'td-toggle' }, h('input', { type: 'checkbox', checked: S.logScale, onchange: (e) => { S.logScale = e.target.checked; persist(); draw(); } }), 'Log tenor axis');
    el.refresh = h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Refresh yields', title: 'Refresh', html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>', onclick: () => load(true) });
    el.toolbar = h('div', { class: 'td-toolbar' }, el.pills, h('div', { class: 'td-toolbar__right' }, el.compare, el.scale, el.refresh));
    el.canvas = h('canvas', { class: 'td-yc__canvas', role: 'img', 'aria-label': 'Yield curve chart' });
    el.tip = h('div', { class: 'td-yc__tip', hidden: true });
    el.chartWrap = h('div', { class: 'td-yc__chart' }, el.canvas, el.tip);
    el.spreads = h('div', { class: 'td-yc__spreads' });
    el.table = h('div', { class: 'td-tablewrap' });
    el.status = h('div', { class: 'td-footer' }, h('span', { class: 'td-status' }));
    root.append(el.toolbar, el.chartWrap, el.spreads, el.table, el.status);

    function renderPills() {
      el.pills.innerHTML = '';
      const groups = [['Benchmarks', Object.keys(TD.CURVES).filter(c => !TD.CURVES[c].gcc)], ['GCC', Object.keys(TD.CURVES).filter(c => TD.CURVES[c].gcc)]];
      for (const [label, ccs] of groups) {
        el.pills.append(h('span', { class: 'td-yc__grouplabel' }, label));
        for (const cc of ccs) {
          const on = S.countries.includes(cc), i = S.countries.indexOf(cc);
          el.pills.append(h('button', { class: 'td-chip td-chip--sm' + (on ? ' is-active' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', style: on ? `--chip-color:${PALETTE[i % PALETTE.length]}` : null, title: TD.CURVES[cc].label,
            onclick: () => { if (on) S.countries = S.countries.filter(c => c !== cc); else if (S.countries.length < 8) S.countries.push(cc); persist(); renderPills(); load(); } },
            h('span', { class: 'td-yc__swatch', 'aria-hidden': 'true' }), `${TD.CURVES[cc].flag} ${cc}`));
        }
      }
    }
    function renderCompare() {
      el.compare.innerHTML = '';
      el.compare.append(h('span', { class: 'td-muted' }, 'vs'));
      for (const [d, label] of [[1, '1D'], [7, '1W'], [30, '1M'], [90, '3M'], [365, '1Y']]) {
        const on = S.compare.includes(d);
        el.compare.append(h('button', { class: 'td-chip td-chip--sm' + (on ? ' is-active' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => { S.compare = on ? S.compare.filter(x => x !== d) : [...S.compare, d]; persist(); renderCompare(); loadGhosts().then(draw); } }, label));
      }
    }

    async function loadGhosts() {
      S.ghosts = {};
      const main = S.countries[0];
      if (!main) return;
      await Promise.all(S.compare.map(async (d) => { const g = await TD.fetchCurveHistory(main, d); if (g && g.points && g.points.length) S.ghosts[d] = g; }));
    }

    async function load(force) {
      const id = ++S.reqId;
      S.loading = true; S.error = null; status();
      if (force) TD.state.transport = null;
      const results = await Promise.allSettled(S.countries.map(cc => TD.fetchCurve(cc)));
      if (id !== S.reqId) return;
      S.curves = {};
      const errs = [];
      results.forEach((r, i) => { const cc = S.countries[i]; if (r.status === 'fulfilled') { S.curves[cc] = r.value; TD.saveCurveSnapshot(r.value); } else errs.push(`${cc}: ${r.reason && r.reason.message || r.reason}`); });
      if (errs.length) S.error = errs.join(' · ');
      await loadGhosts();
      S.loading = false;
      draw(); renderSpreads(); renderTable(); status();
      root.dispatchEvent(new CustomEvent('td:status', { detail: { curves: Object.keys(S.curves), error: S.error }, bubbles: true }));
    }

    function status() {
      const s = el.status.firstChild; s.innerHTML = '';
      if (S.loading) { s.append(h('span', { class: 'td-dot td-dot--busy' }), 'Loading yields…'); return; }
      const cs = Object.values(S.curves);
      if (!cs.length) { s.append(h('span', { class: 'td-dot td-dot--err' }), S.error || 'No data'); return; }
      const src = [...new Set(cs.map(c => c.source === 'tradingview' ? (c.transport === 'proxy' ? 'TradingView via proxy' : 'TradingView') : c.source === 'official' ? 'US Treasury' : 'bond quotes'))].join(' + ');
      const stale = cs.some(c => c.stale);
      s.append(h('span', { class: 'td-dot' + (stale ? ' td-dot--warn' : S.error ? ' td-dot--warn' : ' td-dot--ok') }), `${src}${stale ? ' (stale)' : ''} · ${new Date(Math.max(...cs.map(c => c.at || 0))).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      if (S.error) s.append(' · ', h('span', { class: 'down' }, S.error));
      if (cs.some(c => c.derived)) s.append(' · ', h('span', { class: 'td-muted' }, 'GCC curves derived from sovereign bond quotes (median YTM per tenor bucket)'));
    }

    /* ---- chart ---- */
    const X = (yrs, w, pad) => {
      const minY = 1 / 12, maxY = 30;
      if (S.logScale) return pad.l + (Math.log(Math.max(yrs, minY)) - Math.log(minY)) / (Math.log(maxY) - Math.log(minY)) * (w - pad.l - pad.r);
      return pad.l + Math.min(yrs, maxY) / maxY * (w - pad.l - pad.r);
    };
    function draw() {
      const c = el.canvas, dpr = window.devicePixelRatio || 1;
      const w = el.chartWrap.clientWidth, hgt = Math.max(220, Math.min(380, Math.round(w * 0.42)));
      c.width = w * dpr; c.height = hgt * dpr; c.style.height = hgt + 'px';
      const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(root);
      const ink = css.getPropertyValue('--td-ink').trim() || '#e5e7eb', muted = css.getPropertyValue('--td-muted').trim() || '#9ca3af', rule = css.getPropertyValue('--td-rule').trim() || '#2a3140';
      const pad = { l: 44, r: 16, t: 14, b: 28 };
      ctx.clearRect(0, 0, w, hgt);
      const all = [];
      Object.values(S.curves).forEach(cv => cv.points.forEach(p => all.push(p.yield)));
      Object.values(S.ghosts).forEach(g => g.points.forEach(p => all.push(p.yield)));
      if (!all.length) { ctx.fillStyle = muted; ctx.font = '13px ui-sans-serif, system-ui'; ctx.fillText(S.loading ? 'Loading…' : 'No yield data', pad.l, hgt / 2); return; }
      let lo = Math.min(...all), hi = Math.max(...all); const span = Math.max(0.5, hi - lo); lo -= span * 0.1; hi += span * 0.1;
      const Y = (v) => pad.t + (hi - v) / (hi - lo) * (hgt - pad.t - pad.b);
      // grid
      ctx.strokeStyle = rule; ctx.lineWidth = 1; ctx.fillStyle = muted; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right';
      const step = span > 3 ? 1 : span > 1.5 ? 0.5 : 0.25;
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(2), pad.l - 6, Y(v) + 4); }
      ctx.textAlign = 'center';
      for (const [, label, yrs] of TD.TENORS) { if (yrs > 30) continue; if (!S.logScale && yrs < 1 && label !== '3M') continue; const x = X(yrs, w, pad); ctx.fillText(label, x, hgt - 10); }
      // ghosts
      const main = S.countries[0];
      Object.entries(S.ghosts).forEach(([d, g]) => {
        const pts = g.points.filter(p => p.years != null).sort((a, b) => a.years - b.years);
        if (pts.length < 2) return;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = PALETTE[0]; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.beginPath();
        pts.forEach((p, i) => { const x = X(p.years, w, pad), y = Y(p.yield); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        const last = pts[pts.length - 1]; ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.fillText(`${main} −${d}d`, Math.min(X(last.years, w, pad) + 4, w - 50), Y(last.yield) + 3);
      });
      // curves
      S.countries.forEach((cc, i) => {
        const cv = S.curves[cc]; if (!cv) return;
        const color = PALETTE[i % PALETTE.length];
        const pts = cv.points.filter(p => p.years <= 30);
        ctx.strokeStyle = color; ctx.lineWidth = 2.25; ctx.lineJoin = 'round'; ctx.beginPath();
        pts.forEach((p, j) => { const x = X(p.years, w, pad), y = Y(p.yield); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
        ctx.fillStyle = color;
        pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p.years, w, pad), Y(p.yield), S.hover && S.hover.cc === cc && S.hover.tenor === p.tenor ? 5 : 3, 0, Math.PI * 2); ctx.fill(); });
      });
      c.setAttribute('aria-label', 'Yield curve: ' + S.countries.map(cc => { const cv = S.curves[cc]; if (!cv) return cc; const t = cv.points.find(p => p.tenor === '10Y'), s = cv.points.find(p => p.tenor === '2Y'); return `${cv.label} 10Y ${t ? nf2(t.yield) : '—'}, 2Y ${s ? nf2(s.yield) : '—'}`; }).join('; '));
      c._geom = { w, hgt, pad, Y };
    }
    function onMove(e) {
      const g = el.canvas._geom; if (!g) return;
      const r = el.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = null, bd = 18;
      S.countries.forEach((cc, i) => { const cv = S.curves[cc]; if (!cv) return; cv.points.forEach(p => { const d = Math.hypot(X(p.years, g.w, g.pad) - mx, g.Y(p.yield) - my); if (d < bd) { bd = d; best = { cc, tenor: p.tenor, p, color: PALETTE[i % PALETTE.length] }; } }); });
      if (!best) { if (S.hover) { S.hover = null; el.tip.hidden = true; draw(); } return; }
      if (S.hover && S.hover.cc === best.cc && S.hover.tenor === best.tenor) return;
      S.hover = best; draw();
      const ghost = S.ghosts[S.compare[0]]; const gp = ghost && best.cc === S.countries[0] ? ghost.points.find(q => q.tenor === best.tenor) : null;
      el.tip.innerHTML = `<b style="color:${best.color}">${TD.CURVES[best.cc].flag} ${best.cc} ${best.tenor}</b><div class="num">${nf2(best.p.yield)}</div>` +
        (best.p.chgAbs != null ? `<div class="${best.p.chgAbs > 0 ? 'up' : best.p.chgAbs < 0 ? 'down' : ''}">${sign(best.p.chgAbs * 100, 1, ' bp')} today</div>` : '') +
        (gp ? `<div class="td-muted">${sign((best.p.yield - gp.yield) * 100, 0, ' bp')} vs ${S.compare[0]}d ago</div>` : '') +
        (best.p.n ? `<div class="td-muted">${best.p.n} bond${best.p.n > 1 ? 's' : ''} in bucket</div>` : '');
      el.tip.hidden = false;
      el.tip.style.left = Math.min(mx + 12, g.w - el.tip.offsetWidth - 8) + 'px'; el.tip.style.top = Math.max(0, g.Y(best.p.yield) - el.tip.offsetHeight - 10) + 'px';
    }
    el.canvas.addEventListener('pointermove', onMove);
    el.canvas.addEventListener('pointerleave', () => { S.hover = null; el.tip.hidden = true; draw(); });

    function renderSpreads() {
      el.spreads.innerHTML = '';
      S.countries.forEach((cc, i) => {
        const cv = S.curves[cc]; if (!cv) return;
        const sp = TD.spreads(cv.points); if (!sp.length) return;
        const card = h('div', { class: 'td-card' }, h('div', { class: 'td-card__title' }, h('span', { class: 'td-yc__swatch', style: `--chip-color:${PALETTE[i % PALETTE.length]}` }), `${cv.flag} ${cv.label}`, cv.derived ? h('span', { class: 'td-badge' }, 'derived') : null));
        const grid = h('div', { class: 'td-spreadgrid' });
        for (const s of sp) {
          const ghost = S.ghosts[S.compare[0]]; let delta = null;
          if (ghost && cc === S.countries[0]) { const a = ghost.points.find(q => q.tenor === s.a), b = ghost.points.find(q => q.tenor === s.b); if (a && b) delta = s.bp - Math.round((b.yield - a.yield) * 100); }
          grid.append(h('div', { class: 'td-spread' + (s.inverted ? ' is-inverted' : '') }, h('span', { class: 'td-spread__label' }, s.label), h('span', { class: 'td-spread__val num' }, sign(s.bp, 0, ' bp')), h('span', { class: 'td-spread__note' }, s.inverted ? 'Inverted' : 'Normal', delta != null ? ` · ${sign(delta, 0)} vs ${S.compare[0]}d` : '')));
        }
        card.append(grid); el.spreads.append(card);
      });
    }
    function renderTable() {
      el.table.innerHTML = '';
      const ccs = S.countries.filter(cc => S.curves[cc]); if (!ccs.length) return;
      const tenors = [...new Set(ccs.flatMap(cc => S.curves[cc].points.map(p => p.tenor)))].sort((a, b) => (TD.TENORS.find(t => t[1] === a) || [0, 0, 99])[2] - (TD.TENORS.find(t => t[1] === b) || [0, 0, 99])[2]);
      const table = h('table', { class: 'td-table td-table--compact' });
      const thead = h('thead', null, h('tr', null, h('th', { class: 'td-th', scope: 'col' }, 'Tenor'), ...ccs.map((cc, i) => h('th', { class: 'td-th num', scope: 'col', style: `color:${PALETTE[S.countries.indexOf(cc) % PALETTE.length]}` }, `${TD.CURVES[cc].flag} ${cc}`)), h('th', { class: 'td-th num', scope: 'col' }, ccs.length > 1 ? `${ccs[0]}−${ccs[1]}` : 'Δ today')));
      const tbody = h('tbody');
      for (const t of tenors) {
        const cells = ccs.map(cc => S.curves[cc].points.find(p => p.tenor === t));
        const tr = h('tr', null, h('td', { class: 'td-th' }, t));
        cells.forEach(p => tr.append(h('td', { class: 'num' }, p ? nf2(p.yield) : '—')));
        if (ccs.length > 1) { const a = cells[0], b = cells[1]; tr.append(h('td', { class: 'num' + (a && b ? (a.yield - b.yield > 0 ? ' up' : ' down') : '') }, a && b ? sign((a.yield - b.yield) * 100, 0, ' bp') : '—')); }
        else { const p = cells[0]; tr.append(h('td', { class: 'num' + (p && p.chgAbs ? (p.chgAbs > 0 ? ' up' : ' down') : '') }, p && p.chgAbs != null ? sign(p.chgAbs * 100, 1, ' bp') : '—')); }
        tbody.append(tr);
      }
      table.append(thead, tbody); el.table.append(table);
    }

    const ro = new ResizeObserver(() => draw()); ro.observe(el.chartWrap);
    renderPills(); renderCompare(); load();
    return { setCountries: (cs) => { S.countries = cs.slice(0, 8); persist(); renderPills(); load(); }, refresh: () => load(true), destroy: () => { ro.disconnect(); root.innerHTML = ''; root.classList.remove('td-yc'); }, state: S };
  }

  global.TD.YieldCurve = { mount };
})(window);
