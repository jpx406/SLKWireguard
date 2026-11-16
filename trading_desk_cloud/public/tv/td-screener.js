/* ============================================================================
 * td-screener.js — Screener panel for Trading Desk (vanilla JS, no deps)
 *
 *   const s = TD.Screener.mount(document.getElementById('screener'), {
 *     product: 'stocks',                 // stocks | etf | crypto | forex | bonds
 *     pageSize: 50,
 *     onSymbol: (row) => loadChart(row._symbol),      // row click
 *     onWatch:  (row) => watchlist.add(row._symbol),  // "+" button
 *   });
 *   s.setProduct('bonds'); s.applyPreset('Highest YTM'); s.refresh(); s.destroy();
 *
 * Also dispatches DOM events on the mount node:
 *   'td:symbol'  { detail: row }       'td:watchlist-add' { detail: row }
 *   'td:status'  { detail: {total, transport, stale, at} }
 * ========================================================================== */
(function (global) {
  'use strict';
  const TD = global.TD;
  if (!TD) throw new Error('td-data.js must load before td-screener.js');

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const ICON = {
    search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    sortAsc: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 6l5 7H7z"/></svg>',
    sortDesc: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 18l-5-7h10z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  };
  const svg = (name) => { const s = document.createElement('span'); s.className = 'td-ic'; s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name]; return s; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const timeAgo = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

  function mount(root, opts = {}) {
    const S = {
      product: opts.product || 'stocks',
      set: 'overview',
      market: null,
      filters: {},
      sort: null,
      page: 0,
      pageSize: opts.pageSize || 50,
      search: '',
      preset: null,
      loading: false,
      rows: [], total: 0, columns: [],
      meta: {},
      openPop: null,
      reqId: 0,
    };
    const persistKey = 'td:screener:' + (opts.id || 'main');
    try { Object.assign(S, JSON.parse(localStorage.getItem(persistKey) || '{}'), { loading: false, rows: [], openPop: null }); } catch (e) { /* ignore */ }
    const persist = () => { try { localStorage.setItem(persistKey, JSON.stringify({ product: S.product, set: S.set, market: S.market, filters: S.filters, sort: S.sort, preset: S.preset })); } catch (e) { /* ignore */ } };

    root.classList.add('td-screener');
    root.innerHTML = '';
    const el = {};

    /* ---------- toolbar: product tabs + market + preset + search ---------- */
    el.productTabs = h('div', { class: 'td-tabs td-tabs--product', role: 'tablist', 'aria-label': 'Screener product' });
    el.market = h('select', { class: 'td-select', 'aria-label': 'Market', onchange: (e) => { S.market = e.target.value; S.page = 0; persist(); load(); } });
    el.preset = h('select', { class: 'td-select', 'aria-label': 'Preset screen', onchange: (e) => applyPreset(e.target.value || null) });
    el.search = h('input', { class: 'td-input td-search', type: 'search', placeholder: 'Symbol or name', 'aria-label': 'Search symbol or name', autocomplete: 'off', spellcheck: 'false',
      oninput: debounce((e) => { S.search = e.target.value; S.page = 0; load(); }, 350) });
    el.refresh = h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load(true) }, svg('refresh'));
    const searchWrap = h('label', { class: 'td-searchwrap' }, svg('search'), el.search);
    el.toolbar = h('div', { class: 'td-toolbar' }, el.productTabs, h('div', { class: 'td-toolbar__right' }, el.market, el.preset, searchWrap, el.refresh));

    /* ---------- filter chips ---------- */
    el.chips = h('div', { class: 'td-chips', role: 'group', 'aria-label': 'Quick filters' });

    /* ---------- column-set tabs ---------- */
    el.setTabs = h('div', { class: 'td-tabs td-tabs--sets', role: 'tablist', 'aria-label': 'Column set' });

    /* ---------- table ---------- */
    el.thead = h('thead'); el.tbody = h('tbody');
    el.table = h('table', { class: 'td-table', 'aria-live': 'polite', 'aria-busy': 'false' }, el.thead, el.tbody);
    el.tableWrap = h('div', { class: 'td-tablewrap', tabindex: '0' }, el.table);

    /* ---------- footer ---------- */
    el.status = h('span', { class: 'td-status' });
    el.prev = h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Previous page', onclick: () => { if (S.page > 0) { S.page--; load(); } } }, svg('prev'));
    el.next = h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Next page', onclick: () => { if ((S.page + 1) * S.pageSize < S.total) { S.page++; load(); } } }, svg('next'));
    el.pageInfo = h('span', { class: 'td-pageinfo' });
    el.footer = h('div', { class: 'td-footer' }, el.status, h('div', { class: 'td-pager' }, el.prev, el.pageInfo, el.next));

    root.append(el.toolbar, el.chips, el.setTabs, el.tableWrap, el.footer);

    /* ---------- renderers ---------- */
    function renderProductTabs() {
      el.productTabs.innerHTML = '';
      for (const [id, p] of Object.entries(TD.PRODUCTS)) {
        el.productTabs.append(h('button', { class: 'td-tab' + (id === S.product ? ' is-active' : ''), role: 'tab', type: 'button', 'aria-selected': id === S.product ? 'true' : 'false', onclick: () => setProduct(id) }, p.label));
      }
    }
    function renderMarket() {
      const p = TD.PRODUCTS[S.product];
      el.market.innerHTML = '';
      if (!p.marketChoices) { el.market.hidden = true; return; }
      el.market.hidden = false;
      if (!S.market || !p.marketChoices.some(([v]) => v === S.market)) S.market = p.market;
      for (const [v, label] of p.marketChoices) el.market.append(h('option', { value: v, selected: v === S.market }, label));
    }
    function renderPreset() {
      const p = TD.PRODUCTS[S.product];
      el.preset.innerHTML = '';
      el.preset.append(h('option', { value: '' }, 'Custom screen'));
      for (const name of Object.keys(p.presets || {})) el.preset.append(h('option', { value: name, selected: name === S.preset }, name));
    }
    function renderSetTabs() {
      const p = TD.PRODUCTS[S.product];
      el.setTabs.innerHTML = '';
      if (!p.sets[S.set]) S.set = 'overview';
      for (const [id, s] of Object.entries(p.sets)) {
        el.setTabs.append(h('button', { class: 'td-tab td-tab--sm' + (id === S.set ? ' is-active' : ''), role: 'tab', type: 'button', 'aria-selected': id === S.set ? 'true' : 'false', onclick: () => { S.set = id; persist(); renderSetTabs(); load(); } }, s.label));
      }
    }
    function chipLabel(q, val) {
      if (q.kind === 'in') return `${q.label}: ${val.length > 2 ? val.length + ' selected' : val.join(', ')}`;
      const f = q.unit === 'big' ? (v) => TD.fmt.big(v) : (v) => String(v);
      const [lo, hi] = val;
      const preset = (q.presets || []).find(([, a, b]) => a === lo && b === hi);
      if (preset) return `${q.label}: ${preset[0]}`;
      if (lo != null && hi != null) return `${q.label}: ${f(lo)}–${f(hi)}`;
      if (lo != null) return `${q.label} ≥ ${f(lo)}`;
      return `${q.label} ≤ ${f(hi)}`;
    }
    function renderChips() {
      const p = TD.PRODUCTS[S.product];
      el.chips.innerHTML = '';
      for (const q of p.quick) {
        const val = S.filters[q.id];
        const active = val != null;
        const chip = h('button', { class: 'td-chip' + (active ? ' is-active' : ''), type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: (e) => openPopover(q, e.currentTarget) },
          h('span', null, active ? chipLabel(q, val) : q.label), svg('chev'));
        if (active) {
          const clear = h('button', { class: 'td-chip__clear', type: 'button', 'aria-label': `Clear ${q.label} filter`, onclick: (e) => { e.stopPropagation(); delete S.filters[q.id]; S.preset = null; S.page = 0; persist(); renderPreset(); renderChips(); load(); } }, svg('x'));
          chip.append(clear);
        }
        el.chips.append(chip);
      }
      const n = Object.keys(S.filters).length;
      if (n) el.chips.append(h('button', { class: 'td-chip td-chip--ghost', type: 'button', onclick: () => { S.filters = {}; S.preset = null; S.page = 0; persist(); renderPreset(); renderChips(); load(); } }, `Clear all (${n})`));
    }

    function closePopover() { if (S.openPop) { S.openPop.remove(); S.openPop = null; document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('keydown', onDocKey, true); } }
    function onDocDown(e) { if (S.openPop && !S.openPop.contains(e.target) && !e.target.closest('.td-chip')) closePopover(); }
    function onDocKey(e) { if (e.key === 'Escape') { closePopover(); } }
    function openPopover(q, anchor) {
      closePopover();
      const pop = h('div', { class: 'td-pop', role: 'dialog', 'aria-label': `${q.label} filter` });
      const cur = S.filters[q.id];
      const commit = (val) => { if (val == null) delete S.filters[q.id]; else S.filters[q.id] = val; S.preset = null; S.page = 0; persist(); renderPreset(); renderChips(); closePopover(); load(); };
      if (q.kind === 'range') {
        const list = h('div', { class: 'td-pop__list' });
        for (const [label, lo, hi] of q.presets) {
          const on = cur && cur[0] === lo && cur[1] === hi;
          list.append(h('button', { class: 'td-pop__item' + (on ? ' is-on' : ''), type: 'button', onclick: () => commit([lo, hi]) }, label));
        }
        const lo = h('input', { class: 'td-input', type: 'number', step: 'any', placeholder: 'min', 'aria-label': `${q.label} minimum`, value: cur && cur[0] != null ? cur[0] : '' });
        const hi = h('input', { class: 'td-input', type: 'number', step: 'any', placeholder: 'max', 'aria-label': `${q.label} maximum`, value: cur && cur[1] != null ? cur[1] : '' });
        const apply = h('button', { class: 'td-btn td-btn--primary', type: 'button', onclick: () => { const a = lo.value === '' ? null : +lo.value, b = hi.value === '' ? null : +hi.value; commit(a == null && b == null ? null : [a, b]); } }, 'Apply');
        const form = h('form', { class: 'td-pop__range', onsubmit: (e) => { e.preventDefault(); apply.click(); } }, lo, h('span', { class: 'td-muted' }, '–'), hi, apply);
        pop.append(list, h('div', { class: 'td-pop__hint' }, q.unit === 'big' ? 'Custom range (raw numbers, e.g. 2000000000)' : 'Custom range'), form);
      } else {
        const sel = new Set(cur || []);
        const list = h('div', { class: 'td-pop__list td-pop__list--cols' });
        for (const o of q.options) {
          const id = `td-opt-${q.id}-${o.replace(/\W+/g, '')}`;
          const cb = h('input', { type: 'checkbox', id, checked: sel.has(o), onchange: (e) => { e.target.checked ? sel.add(o) : sel.delete(o); } });
          list.append(h('label', { class: 'td-pop__check', for: id }, cb, o));
        }
        pop.append(list, h('div', { class: 'td-pop__actions' },
          h('button', { class: 'td-btn', type: 'button', onclick: () => commit(null) }, 'Clear'),
          h('button', { class: 'td-btn td-btn--primary', type: 'button', onclick: () => commit(sel.size ? [...sel] : null) }, 'Apply')));
      }
      anchor.setAttribute('aria-expanded', 'true');
      root.append(pop);
      const r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
      pop.style.top = (r.bottom - rr.top + 6) + 'px';
      pop.style.left = Math.max(0, Math.min(r.left - rr.left, rr.width - pop.offsetWidth - 8)) + 'px';
      S.openPop = pop;
      const first = pop.querySelector('button, input'); if (first) first.focus();
      setTimeout(() => { document.addEventListener('pointerdown', onDocDown, true); document.addEventListener('keydown', onDocKey, true); }, 0);
    }

    function renderHead() {
      el.thead.innerHTML = '';
      const tr = h('tr');
      tr.append(h('th', { class: 'td-th td-th--sym', scope: 'col' }, 'Symbol'));
      for (const c of S.columns) {
        const m = TD.FIELDS[c] || { label: c };
        if (m.fmt === 'hidden') continue;
        const isSort = S.sort && S.sort.sortBy === c;
        const numeric = ['pct', 'num', 'num2', 'big', 'price', 'fx', 'int'].includes(m.fmt);
        const th = h('th', { class: 'td-th' + (numeric ? ' num' : '') + (isSort ? ' is-sorted' : ''), scope: 'col', 'aria-sort': isSort ? (S.sort.sortOrder === 'asc' ? 'ascending' : 'descending') : 'none' },
          h('button', { class: 'td-th__btn', type: 'button', onclick: () => { S.sort = { sortBy: c, sortOrder: isSort && S.sort.sortOrder === 'desc' ? 'asc' : 'desc' }; S.preset = null; S.page = 0; persist(); renderPreset(); load(); } },
            m.label || c, isSort ? svg(S.sort.sortOrder === 'asc' ? 'sortAsc' : 'sortDesc') : null));
        tr.append(th);
      }
      tr.append(h('th', { class: 'td-th td-th--act', scope: 'col' }, h('span', { class: 'td-sr' }, 'Actions')));
      el.thead.append(tr);
    }
    function renderRows() {
      el.tbody.innerHTML = '';
      if (!S.rows.length) {
        const msg = S.loading ? 'Loading…' : S.meta.error ? `Could not load: ${S.meta.error}` : 'No matches. Loosen a filter or clear the search.';
        el.tbody.append(h('tr', null, h('td', { class: 'td-empty', colspan: S.columns.length + 2 }, msg)));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const row of S.rows) {
        const tr = h('tr', { class: 'td-row', tabindex: '0', role: 'button', 'aria-label': `${row._ticker} ${row._name}`,
          onclick: () => emit('td:symbol', row, opts.onSymbol),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('td:symbol', row, opts.onSymbol); } } });
        const logo = row._logo ? h('img', { class: 'td-logo', src: `https://s3-symbol-logo.tradingview.com/${row._logo}.svg`, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : h('span', { class: 'td-logo td-logo--ph' }, (row._ticker || '?').slice(0, 2));
        tr.append(h('td', { class: 'td-sym' }, logo, h('div', { class: 'td-sym__text' }, h('b', null, row._ticker), h('small', null, row._name))));
        for (const c of S.columns) {
          const m = TD.FIELDS[c] || {};
          if (m.fmt === 'hidden') continue;
          const v = row[c];
          const text = TD.formatCell(c, v, row);
          const td = h('td', { class: TD.cellClass(c, v) });
          if (m.fmt === 'rating' || m.fmt === 'techrating') td.append(h('span', { class: 'td-pill' }, text)); else td.textContent = text;
          tr.append(td);
        }
        tr.append(h('td', { class: 'td-act' }, h('button', { class: 'td-btn td-btn--icon td-btn--ghost', type: 'button', 'aria-label': `Add ${row._ticker} to watchlist`, title: 'Add to watchlist', onclick: (e) => { e.stopPropagation(); emit('td:watchlist-add', row, opts.onWatch); } }, svg('plus'))));
        frag.append(tr);
      }
      el.tbody.append(frag);
    }
    function renderFooter() {
      const from = S.total ? S.page * S.pageSize + 1 : 0, to = Math.min(S.total, (S.page + 1) * S.pageSize);
      el.pageInfo.textContent = S.total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${S.total.toLocaleString()}` : '—';
      el.prev.disabled = S.page === 0; el.next.disabled = to >= S.total;
      const src = S.meta.transport === 'direct' ? 'TradingView' : S.meta.transport === 'proxy' ? 'TradingView via proxy' : S.meta.transport === 'snapshot' ? 'last saved snapshot' : '';
      el.status.innerHTML = '';
      if (S.loading) el.status.append(h('span', { class: 'td-dot td-dot--busy' }), 'Loading…');
      else if (S.meta.error) el.status.append(h('span', { class: 'td-dot td-dot--err' }), S.meta.error);
      else if (S.meta.at) el.status.append(h('span', { class: 'td-dot' + (S.meta.stale ? ' td-dot--warn' : ' td-dot--ok') }), `${src}${S.meta.stale ? ' (stale)' : ''} · ${timeAgo(S.meta.at)}`);
    }
    function emit(name, row, cb) { root.dispatchEvent(new CustomEvent(name, { detail: row, bubbles: true })); if (typeof cb === 'function') cb(row); }

    /* ---------- data ---------- */
    async function load(force) {
      const id = ++S.reqId;
      S.loading = true; el.table.setAttribute('aria-busy', 'true'); renderFooter();
      if (force) TD.state.transport = null;
      try {
        const p = TD.PRODUCTS[S.product];
        const res = await TD.runScreener(S.product, { set: S.set, market: S.market, filters: S.filters, sort: S.sort || p.sort, range: [S.page * S.pageSize, (S.page + 1) * S.pageSize], search: S.search });
        if (id !== S.reqId) return;
        S.rows = res.rows; S.total = res.total; S.columns = res.columns; S.meta = { transport: res.transport, stale: res.stale, at: res.at, error: null };
      } catch (e) {
        if (id !== S.reqId) return;
        S.rows = []; S.total = 0; S.meta = { error: e.message || String(e) };
        if (!S.columns.length) S.columns = TD.PRODUCTS[S.product].sets[S.set].cols;
      }
      S.loading = false; el.table.setAttribute('aria-busy', 'false');
      renderHead(); renderRows(); renderFooter();
      root.dispatchEvent(new CustomEvent('td:status', { detail: Object.assign({ total: S.total }, S.meta) }));
    }

    /* ---------- public API ---------- */
    function setProduct(id) {
      if (!TD.PRODUCTS[id]) return;
      S.product = id; S.set = 'overview'; S.filters = {}; S.sort = null; S.page = 0; S.preset = null; S.search = ''; el.search.value = ''; S.columns = [];
      persist(); renderProductTabs(); renderMarket(); renderPreset(); renderChips(); renderSetTabs(); load();
    }
    function applyPreset(name) {
      const p = TD.PRODUCTS[S.product];
      S.preset = name;
      if (name && p.presets[name]) {
        const pr = p.presets[name];
        S.filters = Object.assign({}, pr.filters || {}); S.sort = pr.sort || p.sort; S.page = 0;
      } else if (!name) { S.filters = {}; S.sort = null; }
      persist(); renderPreset(); renderChips(); load();
    }
    function destroy() { closePopover(); root.innerHTML = ''; root.classList.remove('td-screener'); }

    renderProductTabs(); renderMarket(); renderPreset(); renderChips(); renderSetTabs(); renderHead(); renderRows(); renderFooter();
    load();
    return { setProduct, applyPreset, refresh: () => load(true), destroy, state: S, el };
  }

  global.TD.Screener = { mount };
})(window);
