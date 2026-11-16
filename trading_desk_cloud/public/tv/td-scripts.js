/* ============================================================================
 * td-scripts.js — TradingView Community "Indicators & strategies" browser
 *                 (open-source only) + Pine source viewer + local library
 *
 * Reverse-engineered (16 Nov 2026):
 *   Listing:  GET https://www.tradingview.com/scripts/[<category>/ | search/<q>/ | editors-picks/][page-N/]
 *                 ?script_type=indicators|strategies|libraries|all
 *                 &script_access=open|all          (default: open)
 *                 &sort=latest_popular|recent_extended
 *                 &component-data-only=1          → JSON
 *             reply.data.ideas.data = { total (capped at 1000), items[], next: "/scripts/page-2/" }
 *             item: { id, name, description, created_at, script_type: "indicator"|"strategy"|"library",
 *                     script_access: 1 (=open source), script_id_part: "PUB;<hex>", version,
 *                     image_url: "<key>", chart_url, likes_count, views_count, comments_count,
 *                     is_picked, is_hot, symbol:{name,full_name,short_name,exchange}, user:{username,...} }
 *             image:   https://s3.tradingview.com/<key[0]>/<key>_mid.png
 *             page:    https://www.tradingview.com/script/<key>-<slug>/
 *   Source:   GET https://pine-facade.tradingview.com/pine-facade/get/<encoded script_id_part>/<version>/?no_4xx=true
 *             → { scriptName, source, version, lastVersionMaj, scriptAccess, created, updated, extra }
 *             Open-source scripts are published under Mozilla Public License 2.0 (header in source).
 *
 * The listing endpoint is same-origin only (no CORS) → always goes through TD_CONFIG.proxyBase.
 *
 *   const sc = TD.Scripts.mount(document.getElementById('scripts'), { onApply: (script) => ... });
 * ========================================================================== */
(function (global) {
  'use strict';
  const TD = global.TD;
  if (!TD) throw new Error('td-data.js must load before td-scripts.js');

  const CATEGORIES = [
    ['', 'All'], ['trend-analysis', 'Trend analysis'], ['oscillators', 'Oscillators'], ['volatility', 'Volatility'], ['volume', 'Volume'],
    ['moving-average', 'Moving averages'], ['momentum', 'Momentum'], ['support-and-resistance', 'Support & resistance'], ['candlestick-analysis', 'Candlesticks'],
    ['chart-patterns', 'Chart patterns'], ['trend-following', 'Trend following'], ['cycles', 'Cycles'], ['statistics', 'Statistics'], ['volume-profile', 'Volume profile'],
    ['harmonic-patterns', 'Harmonic'], ['fibonacci', 'Fibonacci'], ['pivot-points-and-levels', 'Pivots & levels'], ['bands-and-channels', 'Bands & channels'], ['wave-analysis', 'Waves'], ['educational', 'Educational'],
  ];
  const TYPES = [['all', 'All types'], ['indicators', 'Indicators'], ['strategies', 'Strategies'], ['libraries', 'Libraries']];
  const SORTS = [['latest_popular', 'Popular'], ['recent_extended', 'Recent']];

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const big = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const ago = (iso) => { const d = (Date.now() - new Date(iso)) / 864e5; return d < 1 ? 'today' : d < 30 ? `${Math.floor(d)}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ---- data -------------------------------------------------------------- */
  function listingPath({ feed = '', category = '', search = '', page = 1 } = {}) {
    let p = '/scripts/';
    if (search) p += `search/${encodeURIComponent(search.trim())}/`;
    else if (feed === 'editors-picks') p += 'editors-picks/';
    else if (category) p += `${category}/`;
    if (page > 1) p += `page-${page}/`;
    return p;
  }
  async function fetchListing(o = {}) {
    const q = new URLSearchParams({ script_type: o.type || 'all', script_access: 'open', sort: o.sort || 'latest_popular' });
    const path = listingPath(o);
    const url = `${TD.config.proxyBase}/tv/scripts?path=${encodeURIComponent(path)}&${q}`;
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const d = j && j.data && j.data.ideas && j.data.ideas.data;
    if (!d) throw new Error('Unexpected listing shape');
    return { total: d.total, next: d.next, items: d.items.filter(i => i.script_access === 1).map(normalize) };
  }
  function normalize(i) {
    return {
      id: i.id, key: i.image_url, name: i.name, description: i.description, type: i.script_type, version: i.version, scriptId: i.script_id_part,
      createdAt: i.created_at, likes: i.likes_count, views: i.views_count, comments: i.comments_count, picked: !!i.is_picked, hot: !!i.is_hot,
      author: i.user && i.user.username, symbol: i.symbol && (i.symbol.full_name || i.symbol.name),
      image: i.image_url ? `https://s3.tradingview.com/${i.image_url[0]}/${i.image_url}_mid.png` : null,
      url: i.chart_url || `https://www.tradingview.com/script/${i.image_url}/`,
    };
  }
  async function fetchSource(script) {
    const direct = `https://pine-facade.tradingview.com/pine-facade/get/${encodeURIComponent(script.scriptId)}/${script.version || 1}/?no_4xx=true`;
    const proxied = `${TD.config.proxyBase}/tv/pine/${encodeURIComponent(script.scriptId)}/${script.version || 1}`;
    let err;
    void direct; for (const url of [proxied]) { // desk build: always through the desk's own API
      try { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json(); if (j && typeof j.source === 'string') return j; throw new Error('No source'); }
      catch (e) { err = e; }
    }
    throw err;
  }

  /* ---- local library (IndexedDB, localStorage fallback) ------------------ */
  const Library = (() => {
    const DB = 'td-scripts', STORE = 'scripts';
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        if (!global.indexedDB) return rej(new Error('no idb'));
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('type', 'type'); s.createIndex('savedAt', 'savedAt'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction(STORE, mode); const s = t.objectStore(STORE); const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }));
    const ls = { key: 'td:scripts:lib', read() { try { return JSON.parse(localStorage.getItem(this.key) || '{}'); } catch (e) { return {}; } }, write(o) { try { localStorage.setItem(this.key, JSON.stringify(o)); } catch (e) { /* full */ } } };
    return {
      async put(s) { try { return await tx('readwrite', st => st.put(s)); } catch (e) { const o = ls.read(); o[s.id] = s; ls.write(o); } },
      async get(id) { try { return await new Promise((res, rej) => open().then(db => { const r = db.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }).catch(rej)); } catch (e) { return ls.read()[id]; } },
      async all() { try { return await new Promise((res, rej) => open().then(db => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }).catch(rej)); } catch (e) { return Object.values(ls.read()); } },
      async remove(id) { try { return await tx('readwrite', st => st.delete(id)); } catch (e) { const o = ls.read(); delete o[id]; ls.write(o); } },
      async clear() { try { return await tx('readwrite', st => st.clear()); } catch (e) { ls.write({}); } },
    };
  })();

  /* ---- component ----------------------------------------------------------- */
  function mount(root, opts = {}) {
    const S = { view: 'browse', feed: '', type: 'all', sort: 'latest_popular', category: '', search: '', page: 1, items: [], total: 0, next: null, loading: false, error: null, lib: [], libIds: new Set(), reqId: 0, importing: null };
    const key = 'td:scripts:ui:' + (opts.id || 'main');
    try { Object.assign(S, JSON.parse(localStorage.getItem(key) || '{}'), { items: [], loading: false, importing: null, lib: [], libIds: new Set() }); } catch (e) { /* ignore */ }
    const persist = () => { try { localStorage.setItem(key, JSON.stringify({ feed: S.feed, type: S.type, sort: S.sort, category: S.category })); } catch (e) { /* ignore */ } };

    root.classList.add('td-scripts'); root.innerHTML = '';
    const el = {};
    el.viewTabs = h('div', { class: 'td-tabs', role: 'tablist', 'aria-label': 'Scripts view' });
    el.type = h('select', { class: 'td-select', 'aria-label': 'Script type', onchange: (e) => { S.type = e.target.value; S.page = 1; persist(); load(); } }, ...TYPES.map(([v, l]) => h('option', { value: v, selected: v === S.type }, l)));
    el.sort = h('select', { class: 'td-select', 'aria-label': 'Sort', onchange: (e) => { S.sort = e.target.value; S.page = 1; persist(); load(); } }, ...SORTS.map(([v, l]) => h('option', { value: v, selected: v === S.sort }, l)));
    el.search = h('input', { class: 'td-input td-search', type: 'search', placeholder: 'Search scripts (e.g. VWAP, supertrend)', 'aria-label': 'Search scripts', oninput: debounce((e) => { S.search = e.target.value; S.page = 1; load(); }, 400) });
    el.importBtn = h('button', { class: 'td-btn', type: 'button', title: 'Save every open-source script in the current listing (up to 1,000) to your local library, with Pine source', onclick: () => importAll() }, 'Import all');
    el.toolbar = h('div', { class: 'td-toolbar' }, el.viewTabs, h('div', { class: 'td-toolbar__right' }, el.type, el.sort, h('label', { class: 'td-searchwrap' }, h('span', { class: 'td-ic', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }), el.search), el.importBtn));
    el.cats = h('div', { class: 'td-chips', role: 'group', 'aria-label': 'Categories' });
    el.grid = h('div', { class: 'td-cards', 'aria-live': 'polite' });
    el.status = h('span', { class: 'td-status' });
    el.pager = h('div', { class: 'td-pager' });
    el.footer = h('div', { class: 'td-footer' }, el.status, el.pager);
    el.modal = null;
    root.append(el.toolbar, el.cats, el.grid, el.footer);

    const OPEN_SRC_NOTE = 'Open-source Pine scripts on TradingView are published under the Mozilla Public License 2.0. Keep the license header when you reuse code, and credit the author.';

    function renderViewTabs() {
      el.viewTabs.innerHTML = '';
      for (const [id, label] of [['browse', 'Popular'], ['editors-picks', "Editors' picks"], ['library', `My library (${S.lib.length})`]]) {
        const on = (S.view === 'library' && id === 'library') || (S.view === 'browse' && (id === 'editors-picks' ? S.feed === 'editors-picks' : id === 'browse' && S.feed !== 'editors-picks'));
        el.viewTabs.append(h('button', { class: 'td-tab' + (on ? ' is-active' : ''), role: 'tab', type: 'button', 'aria-selected': on ? 'true' : 'false', onclick: () => { if (id === 'library') { S.view = 'library'; renderAll(); } else { S.view = 'browse'; S.feed = id === 'editors-picks' ? 'editors-picks' : ''; S.page = 1; persist(); load(); } } }, label));
      }
    }
    function renderCats() {
      el.cats.innerHTML = '';
      el.cats.hidden = S.view === 'library';
      for (const [slug, label] of CATEGORIES) el.cats.append(h('button', { class: 'td-chip td-chip--sm' + (slug === S.category ? ' is-active' : ''), type: 'button', 'aria-pressed': slug === S.category ? 'true' : 'false', onclick: () => { S.category = slug; S.feed = ''; S.page = 1; persist(); load(); } }, label));
    }
    function card(s, inLib) {
      const typeCls = s.type === 'strategy' ? 'td-badge--strat' : s.type === 'library' ? 'td-badge--lib' : 'td-badge--ind';
      const c = h('article', { class: 'td-card td-card--script' },
        h('a', { class: 'td-card__img', href: s.url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${s.name} on TradingView` }, s.image ? h('img', { src: s.image, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null, h('span', { class: 'td-badge ' + typeCls }, s.type)),
        h('div', { class: 'td-card__body' },
          h('h3', { class: 'td-card__name' }, s.name, s.picked ? h('span', { class: 'td-badge td-badge--pick', title: "Editors' pick" }, '★') : null, s.hot ? h('span', { class: 'td-badge td-badge--hot', title: 'Hot' }, '🔥') : null),
          h('p', { class: 'td-card__desc' }, (s.description || '').replace(/\s+/g, ' ').slice(0, 180)),
          h('div', { class: 'td-card__meta' }, h('span', null, 'by ', h('b', null, s.author || '—')), h('span', null, `♥ ${big(s.likes)}`), s.comments ? h('span', null, `💬 ${s.comments}`) : null, h('span', null, ago(s.createdAt)), s.symbol ? h('span', { class: 'td-muted' }, s.symbol) : null),
          h('div', { class: 'td-card__actions' },
            h('button', { class: 'td-btn td-btn--primary', type: 'button', onclick: () => openSource(s) }, 'View source'),
            h('button', { class: 'td-btn' + (inLib ? ' is-on' : ''), type: 'button', 'aria-pressed': inLib ? 'true' : 'false', onclick: async (e) => { if (inLib) { await Library.remove(s.id); } else { e.currentTarget.disabled = true; await saveToLibrary(s); } await refreshLib(); renderAll(); } }, inLib ? 'Saved' : 'Save'),
            h('a', { class: 'td-btn td-btn--ghost', href: s.url, target: '_blank', rel: 'noopener' }, 'TradingView ↗'),
            typeof opts.onApply === 'function' ? h('button', { class: 'td-btn td-btn--ghost', type: 'button', onclick: () => opts.onApply(s) }, 'Use on chart') : null)));
      return c;
    }
    function renderGrid() {
      el.grid.innerHTML = '';
      const list = S.view === 'library' ? S.lib.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).filter(s => !S.search || (s.name + ' ' + s.author + ' ' + (s.description || '')).toLowerCase().includes(S.search.toLowerCase())).filter(s => S.type === 'all' || s.type === S.type.replace(/ies$|s$/, (m) => m === 'ies' ? 'y' : '')) : S.items;
      if (!list.length) { el.grid.append(h('div', { class: 'td-empty' }, S.loading ? 'Loading…' : S.error ? `Could not load: ${S.error}` : S.view === 'library' ? 'Nothing saved yet. Use Save on any script, or Import all.' : 'No open-source scripts match.')); return; }
      const frag = document.createDocumentFragment();
      for (const s of list) frag.append(card(s, S.libIds.has(s.id)));
      el.grid.append(frag);
    }
    function renderFooter() {
      el.status.innerHTML = ''; el.pager.innerHTML = '';
      if (S.importing) { el.status.append(h('span', { class: 'td-dot td-dot--busy' }), `Importing… ${S.importing.done}/${S.importing.total} (${S.importing.withSource} with source)`, ' ', h('button', { class: 'td-btn td-btn--ghost', type: 'button', onclick: () => { S.importing.cancel = true; } }, 'Stop')); return; }
      if (S.view === 'library') { el.status.append(`${S.lib.length} saved · ${S.lib.filter(s => s.source).length} with source`); el.pager.append(h('button', { class: 'td-btn', type: 'button', onclick: exportLibrary }, 'Export JSON'), h('button', { class: 'td-btn td-btn--ghost', type: 'button', onclick: async () => { if (confirm('Clear the whole local script library?')) { await Library.clear(); await refreshLib(); renderAll(); } } }, 'Clear')); return; }
      if (S.loading) el.status.append(h('span', { class: 'td-dot td-dot--busy' }), 'Loading…');
      else if (S.error) el.status.append(h('span', { class: 'td-dot td-dot--err' }), S.error);
      else el.status.append(h('span', { class: 'td-dot td-dot--ok' }), `${S.total >= 1000 ? '1,000+' : S.total} open-source scripts · page ${S.page}`);
      el.pager.append(h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Previous page', disabled: S.page <= 1, html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>', onclick: () => { S.page--; load(); } }),
        h('span', { class: 'td-pageinfo' }, `${S.page} / ${Math.max(1, Math.ceil(Math.min(S.total, 1000) / 24))}`),
        h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Next page', disabled: !S.next, html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>', onclick: () => { S.page++; load(); } }));
    }
    function renderAll() { renderViewTabs(); renderCats(); renderGrid(); renderFooter(); }

    async function load() {
      S.view = 'browse';
      const id = ++S.reqId; S.loading = true; S.error = null; renderAll();
      try { const r = await fetchListing({ feed: S.feed, category: S.category, search: S.search, page: S.page, type: S.type, sort: S.sort }); if (id !== S.reqId) return; S.items = r.items; S.total = r.total; S.next = r.next; }
      catch (e) { if (id !== S.reqId) return; S.items = []; S.total = 0; S.next = null; S.error = e.message || String(e); }
      S.loading = false; renderAll();
    }
    async function refreshLib() { S.lib = await Library.all(); S.libIds = new Set(S.lib.map(s => s.id)); }
    async function saveToLibrary(s, withSource = true) {
      const rec = Object.assign({}, s, { savedAt: Date.now() });
      if (withSource) { try { const src = await fetchSource(s); rec.source = src.source; rec.sourceVersion = src.version; rec.updated = src.updated; } catch (e) { rec.sourceError = e.message; } }
      await Library.put(rec); return rec;
    }

    async function importAll() {
      if (S.importing) return;
      const pages = Math.ceil(Math.min(S.total || 1000, 1000) / 24);
      if (!confirm(`Import every open-source script in this listing (${S.total >= 1000 ? 'up to 1,000' : S.total} scripts, ${pages} pages) with Pine source into your local library?\n\nThis fetches one page every ~1.5 s and sources two at a time to stay polite to TradingView.`)) return;
      S.importing = { done: 0, total: Math.min(S.total || 1000, 1000), withSource: 0, cancel: false }; renderFooter();
      try {
        for (let p = 1; p <= pages && !S.importing.cancel; p++) {
          let r; try { r = await fetchListing({ feed: S.feed, category: S.category, search: S.search, page: p, type: S.type, sort: S.sort }); } catch (e) { await sleep(3000); continue; }
          const queue = r.items.slice();
          const worker = async () => { while (queue.length && !S.importing.cancel) { const s = queue.shift(); if (!S.libIds.has(s.id)) { const rec = await saveToLibrary(s, true); S.libIds.add(s.id); if (rec.source) S.importing.withSource++; } S.importing.done++; renderFooter(); await sleep(400); } };
          await Promise.all([worker(), worker()]);
          if (!r.next) break;
          await sleep(1500);
        }
      } finally { S.importing = null; await refreshLib(); renderAll(); }
    }
    async function exportLibrary() {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), license: OPEN_SRC_NOTE, scripts: S.lib }, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `tradingview-open-source-scripts-${new Date().toISOString().slice(0, 10)}.json` }); document.body.append(a); a.click(); a.remove();
    }

    async function openSource(s) {
      closeModal();
      const pre = h('pre', { class: 'td-code', tabindex: '0' }, 'Loading source…');
      const copy = h('button', { class: 'td-btn', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(pre.textContent).then(() => { copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1500); }); } }, 'Copy');
      const dl = h('button', { class: 'td-btn', type: 'button', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([pre.textContent], { type: 'text/plain' })), download: (s.name || 'script').replace(/[^\w.-]+/g, '_') + '.pine' }); document.body.append(a); a.click(); a.remove(); } }, 'Download .pine');
      const save = h('button', { class: 'td-btn td-btn--primary', type: 'button', onclick: async () => { save.disabled = true; await saveToLibrary(s); await refreshLib(); renderAll(); save.textContent = 'Saved'; } }, S.libIds.has(s.id) ? 'Saved' : 'Save to library');
      const dialog = h('div', { class: 'td-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${s.name} source` },
        h('div', { class: 'td-modal__head' }, h('div', null, h('h3', null, s.name), h('div', { class: 'td-muted' }, `${s.type} · by ${s.author} · v${s.version} · ♥ ${big(s.likes)}`)), h('button', { class: 'td-btn td-btn--icon', type: 'button', 'aria-label': 'Close', html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: closeModal })),
        h('div', { class: 'td-modal__note' }, OPEN_SRC_NOTE),
        pre,
        h('div', { class: 'td-modal__actions' }, copy, dl, h('a', { class: 'td-btn td-btn--ghost', href: s.url, target: '_blank', rel: 'noopener' }, 'Open on TradingView ↗'), save));
      el.modal = h('div', { class: 'td-modal__backdrop', onclick: (e) => { if (e.target === el.modal) closeModal(); } }, dialog);
      root.append(el.modal); document.addEventListener('keydown', escClose);
      dialog.querySelector('button').focus();
      try { const src = await fetchSource(s); pre.textContent = src.source; }
      catch (e) { pre.textContent = `Could not fetch source (${e.message}). Open the script on TradingView to read it.`; }
    }
    function escClose(e) { if (e.key === 'Escape') closeModal(); }
    function closeModal() { if (el.modal) { el.modal.remove(); el.modal = null; document.removeEventListener('keydown', escClose); } }

    refreshLib().then(() => { renderAll(); load(); });
    return { refresh: load, showLibrary: () => { S.view = 'library'; renderAll(); }, importAll, destroy: () => { closeModal(); root.innerHTML = ''; root.classList.remove('td-scripts'); }, state: S, Library };
  }

  global.TD.Scripts = { mount, fetchListing, fetchSource, Library, CATEGORIES };
})(window);
