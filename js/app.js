/* Adam Nokia Electronics SMS — UI. Data lives in Google Sheets behind the Apps Script API; IndexedDB only holds the offline queue and a last-synced read-only copy. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const slsh = n => Math.round(n).toLocaleString('en-US') + ' SLSH';
  const dt = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const DEVICE = localStorage.ane_device || (localStorage.ane_device = 'DEV-' + Math.random().toString(36).slice(2, 8).toUpperCase());

  /* ---- local storage layer (IndexedDB) ---- */
  const IDB = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('ane-sms', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const d = await this.open(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
    async del(k) { const d = await this.open(); return new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; }); }
  };
  let token = localStorage.getItem('ane_token'), S = null, D = null, route = 'dashboard', queue = [];
  let deferredInstallPrompt = null, appInstalled = false;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; bindInstallButton(); });
  window.addEventListener('appinstalled', () => { appInstalled = true; deferredInstallPrompt = null; bindInstallButton(); });
  function installHelp() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const body = ios
      ? '<p>On your iPhone or iPad:</p><ol><li>Open this website in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (the square with an upward arrow).</li><li>Scroll down and choose <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol>'
      : '<p>On Android:</p><ol><li>Open this website in <b>Chrome</b>.</li><li>Tap the three-dot menu in the top-right corner.</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Confirm the installation.</li></ol><p class="muted sm">If you do not see the option, refresh the page and try again in Chrome.</p>';
    modal('<h2>Install Adam Nokia Electronics</h2>' + body + '<button class="btn" data-close style="width:100%;margin-top:12px">Got it</button>');
  }
  async function installApp() {
    if (standalone() || appInstalled) { toast('Adam Nokia is already installed on this device.', 'ok'); return; }
    if (deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt; deferredInstallPrompt = null;
      try { await promptEvent.prompt(); const choice = await promptEvent.userChoice; if (choice && choice.outcome === 'accepted') toast('Installation started.', 'ok'); }
      catch (e) { installHelp(); }
      bindInstallButton(); return;
    }
    installHelp();
  }
  function bindInstallButton() {
    const b = $('#install'); if (!b) return;
    b.textContent = standalone() || appInstalled ? 'App installed' : 'Install app';
    b.disabled = standalone() || appInstalled;
    b.onclick = installApp;
  }
  const CFG = window.ANE_CONFIG || {};
  const net = { reachable: true, syncing: false, lastSync: null, stale: false, snapAt: null };
  const state = { cart: {}, cust: 'CUS-WALKIN', method: 'ZAAD_USD', txn: null, q: '', cat: '', branch: 'BR-1', showDone: false, invQ: '', invCat: '' };

  /* ---- API: the Google Apps Script web app is the only source of truth. Text/plain avoids a CORS preflight (Apps Script cannot answer one). ---- */
  async function remote(action, payload, txn, tok) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 30000); let r;
    try { r = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal, body: JSON.stringify({ action, token: tok === undefined ? token : tok, payload: payload || {}, client_txn_id: txn, device_id: DEVICE }) }); }
    catch (e) { net.reachable = false; const x = new Error('No connection. This action needs the internet.'); x.network = true; throw x; }
    finally { clearTimeout(to); }
    let j; try { j = await r.json(); } catch (e) { net.reachable = false; const x = new Error('The server did not answer correctly. Try again.'); x.network = true; throw x; }
    net.reachable = true; return j;
  }
  async function api(action, payload, txn) {
    const j = await remote(action, payload, txn);
    if (!j.ok) { const e = new Error(j.error.message); e.code = j.error.code; if (['UNAUTHENTICATED', 'SESSION_EXPIRED'].includes(e.code)) logoutLocal(); throw e; }
    return j;
  }
  /* Only sales and customer payments may be queued offline. The same client_txn_id is reused on every retry, so the server can never record one twice. */
  const QUEUEABLE = ['sales.create', 'payments.recordRepayment'];
  async function apiQ(action, payload, txn) {
    try { return await api(action, payload, txn); }
    catch (e) { if (!e.network || !QUEUEABLE.includes(action)) throw e; await enqueue(action, payload, txn); return { queued: true, data: null }; }
  }
  async function saveQueue() { try { await IDB.set('queue', queue); } catch (e) { toast('Could not save the offline queue on this device!', 'err'); } updateStatus(); }
  async function enqueue(action, payload, txn) {
    if (!queue.some(q => q.txn === txn)) queue.push({ txn, action, payload: Object.assign({}, payload, { client_at: new Date().toISOString() }), queued_at: new Date().toISOString(), queued_by: S ? S.me.id : null, status: 'PENDING' });
    await saveQueue();
  }
  const SYNC_CONFLICT = ['INSUFFICIENT_STOCK', 'CREDIT_LIMIT_EXCEEDED', 'CREDIT_NOT_APPROVED', 'RATE_NOT_SET'];
  async function syncQueue() {
    if (net.syncing || !token || !S) return;
    const mine = queue.filter(q => q.status === 'PENDING' && q.queued_by === S.me.id); if (!mine.length) return;
    net.syncing = true; updateStatus();
    try {
      for (const q of mine) {
        let j; try { j = await remote(q.action, q.payload, q.txn); } catch (e) { break; }          /* still offline: keep everything */
        if (j.ok) queue = queue.filter(x => x !== q);                                                  /* applied, or recognised as a duplicate */
        else if (['UNAUTHENTICATED', 'SESSION_EXPIRED'].includes(j.error.code)) { logoutLocal(); break; }
        else if (['LOCKED_RETRY', 'INTERNAL'].includes(j.error.code)) break;                          /* transient: retry later */
        else {                                                                                         /* rejected: never dropped, flagged for review */
          q.status = SYNC_CONFLICT.includes(j.error.code) ? 'CONFLICT' : 'FAILED'; q.error = j.error;
          try { await remote('sync.flag', { txn: q.txn, action: q.action, error_code: j.error.code, message: j.error.message }, 'FLAG-' + q.txn); } catch (e) { }
        }
        await saveQueue();
      }
    } finally { net.syncing = false; await saveQueue(); }
  }
  async function refresh() {
    try { const r = await api('data.snapshot'); S = r.data; net.stale = false; net.lastSync = Date.now(); IDB.set('snapshot', { at: Date.now(), S }).catch(() => { }); }
    catch (e) { if (!e.network) throw e; const c = await IDB.get('snapshot'); if (!c) throw e; S = c.S; net.stale = true; net.snapAt = c.at; }
    updateStatus();
  }
  function can(p) { return S && S.me.perms.includes(p); }
  function toast(m, k) { const t = document.createElement('div'); t.className = 'toast ' + (k || ''); t.textContent = m; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3800); }
  function modal(html, bind) { const d = $('#dlg'); d.innerHTML = '<div class="dbody">' + html + '</div>'; if (!d.open) d.showModal(); if (bind) bind(d); d.querySelectorAll('[data-close]').forEach(b => b.onclick = () => d.close()); }
  const closeModal = () => $('#dlg').close();
  async function act(fn, okMsg) { try { const m = await fn(); const t = typeof m === 'string' ? m : okMsg; if (t) toast(t, 'ok'); await refresh(); render(); } catch (e) { toast(e.message, 'err'); } }
  const P = id => S.products.find(p => p.id === id);
  const C = id => S.customers.find(c => c.id === id);
  const PE = id => S.people.find(p => p.id === id);

  /* ---- sync status pill: Online / Offline / Synchronizing / Synced / Pending / Failed / Conflict ---- */
  function statusInfo() {
    const n = s => queue.filter(q => q.status === s).length, pend = n('PENDING'), fail = n('FAILED'), conf = n('CONFLICT');
    if (!navigator.onLine || !net.reachable) return ['Offline' + (pend + fail + conf ? ` · ${pend + fail + conf} waiting` : ''), 'warn'];
    if (net.syncing) return ['Synchronizing…', ''];
    if (conf) return [`Conflict — review (${conf})`, 'bad'];
    if (fail) return [`Sync failed (${fail})`, 'bad'];
    if (pend) return [`Pending sync (${pend})`, 'warn'];
    return ['Online · Synced' + (net.lastSync ? ' ' + new Date(net.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''), 'ok'];
  }
  function updateStatus() { const el = $('#net'); if (!el) return; const [t, k] = statusInfo(); el.textContent = t; el.className = 'pill ' + k; }
  function describe(q) {
    if (q.action === 'sales.create') return 'Sale: ' + (q.payload.items || []).map(i => ((S && P(i.product_id)) ? P(i.product_id).name : i.product_id) + ' ×' + i.qty).join(', ');
    if (q.action === 'payments.recordRepayment') return 'Customer payment: ' + ((S && C(q.payload.customer_id)) ? C(q.payload.customer_id).name : q.payload.customer_id) + ' · ' + esc(String(q.payload.amount)) + ' ' + esc(q.payload.method_id);
    return q.action;
  }
  function syncModal() {
    const rows = queue.map((q, i) => `<tr><td class="sm">${esc(describe(q))}<br><span class="muted sm">${dt(q.queued_at)} · ${esc(q.txn.slice(-8))}</span>${q.error ? `<br><span class="sm" style="color:var(--bad)">${esc(q.error.message)}</span>` : ''}</td>
      <td><span class="badge ${q.status === 'PENDING' ? 'warn' : 'bad'}">${q.status === 'PENDING' ? 'Saved on this device' : q.status === 'CONFLICT' ? 'Conflict — review' : 'Failed'}</span></td>
      <td>${q.status !== 'PENDING' ? `<button class="btn sec sm" data-rt="${i}">Retry</button> <button class="btn bad sm" data-dc="${i}">Discard</button>` : ''}</td></tr>`).join('');
    modal(`<h2>Sync status</h2><p class="muted sm">${statusInfo()[0]}. Everything here is saved on this device but <b>not yet confirmed by the shared system</b>. Nothing is deleted automatically.</p>
      ${queue.length ? `<table>${rows}</table>` : '<p>Nothing waiting — all your work is confirmed on the server.</p>'}
      <div class="row" style="margin-top:14px"><button class="btn f" id="syn">Sync now</button><button class="btn sec" data-close>Close</button></div>`, d => {
      d.querySelector('#syn').onclick = async () => { await syncQueue(); try { await refresh(); render(); } catch (e) { } syncModal(); };
      d.querySelectorAll('[data-rt]').forEach(b => b.onclick = async () => { queue[b.dataset.rt].status = 'PENDING'; queue[b.dataset.rt].error = null; await saveQueue(); await syncQueue(); try { await refresh(); render(); } catch (e) { } syncModal(); });
      d.querySelectorAll('[data-dc]').forEach(b => b.onclick = () => { const q = queue[b.dataset.dc]; modal(`<h2>Discard this item?</h2><p>${esc(describe(q))}</p><p class="muted sm">It will be removed from this device and recorded in the audit log as discarded. It was never applied on the server.</p><div class="row"><button class="btn bad f" id="y">Yes, discard</button><button class="btn sec" data-close>Cancel</button></div>`, d2 => d2.querySelector('#y').onclick = async () => { try { await remote('sync.flag', { kind: 'DISCARDED', txn: q.txn, action: q.action, error_code: (q.error || {}).code, message: (q.error || {}).message, note: 'Discarded by user on device' }, 'FLAG-DISCARD-' + q.txn); } catch (e) { } queue = queue.filter(x => x !== q); await saveQueue(); closeModal(); }); });
    });
  }
  async function tick() {
    if (!token || !S) return; await syncQueue();
    const busy = document.hidden || $('#dlg').open || /INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || ''); if (busy) { updateStatus(); return; }
    try { await refresh(); render(); } catch (e) { updateStatus(); }
  }

  /* ---- boot ---- */
  async function boot() {
    try { queue = (await IDB.get('queue')) || []; } catch (e) { queue = []; }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
    window.addEventListener('hashchange', () => { route = (location.hash.slice(1) || 'dashboard'); if (S) render(); });
    window.addEventListener('online', () => { net.reachable = true; tick(); }); window.addEventListener('offline', updateStatus);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); }); setInterval(tick, 45000);
    route = location.hash.slice(1) || 'dashboard';
    if (!CFG.API_URL) { $('#app').innerHTML = '<div class="login"><div class="box"><h2>Not configured</h2><p class="muted">This copy of the app has no server address yet. Set API_URL in js/config.js (see the deployment guide).</p></div></div>'; return; }
    if (token) { try { await refresh(); return render(); } catch (e) { } }
    loginView();
  }
  function logoutLocal() { token = null; localStorage.removeItem('ane_token'); S = null; IDB.del('snapshot').catch(() => { }); loginView(); }   /* the offline queue is kept */

  /* ---- login (first password needs a one-time setup code issued by an owner) ---- */
  function loginView(mode) {
    const setup = mode === 'setup';
    $('#app').innerHTML = `<div class="login"><div class="box"><img src="assets/logo/AdamNokia_Primary_FullColor.svg" width="150" alt="Adam Nokia Electronics">
      <h2 style="text-align:center">${setup ? 'Create your password' : 'Sign in'}</h2><p class="muted sm" style="text-align:center">${setup ? 'First time here? Ask an owner for your one-time setup code.' : 'Smart Management System'}</p>
      <label>Username</label><input id="u" autocapitalize="off" autocomplete="username">
      ${setup ? '<label>Setup code</label><input id="sc" autocapitalize="characters" autocomplete="one-time-code" placeholder="XXXXX-XXXXX">' : ''}
      <label>${setup ? 'New password (8+ characters)' : 'Password'}</label><input id="p" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}">
      ${setup ? '<label>Repeat password</label><input id="p2" type="password" autocomplete="new-password">' : ''}
      <button class="btn" id="go" style="width:100%;margin-top:16px">${setup ? 'Save & sign in' : 'Sign in'}</button>
      <p class="sm" style="text-align:center;margin-top:14px"><a href="#" id="sw">${setup ? '← Back to sign in' : 'First time? I have a setup code'}</a></p>
      <button class="btn sec" id="install" style="width:100%;margin-top:10px">Install app</button></div></div>`;
    bindInstallButton();
    $('#sw').onclick = e => { e.preventDefault(); loginView(setup ? null : 'setup'); };
    const go = async () => {
      const username = $('#u').value.trim().toLowerCase(), password = $('#p').value; $('#go').disabled = true;
      try {
        let j;
        if (setup) { if (password !== $('#p2').value) throw new Error('Passwords do not match'); j = await remote('auth.setup', { username, password, setup_code: $('#sc').value }, undefined, ''); }
        else j = await remote('auth.login', { username, password }, undefined, '');
        if (!j.ok) throw new Error(j.error.message);
        token = j.data.token; localStorage.setItem('ane_token', token); await refresh(); location.hash = '#dashboard'; route = 'dashboard'; render(); syncQueue();
      } catch (e) { toast(e.network ? 'Cannot reach the server. Check your internet connection.' : e.message, 'err'); $('#go').disabled = false; }
    };
    $('#go').onclick = go; $('#app').querySelectorAll('input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') go(); });
  }

  /* ---- shell ---- */
  const NAV = [['dashboard', 'Dashboard', '▦', null], ['pos', 'Sell', '🛒', 'sales.create'], ['inventory', 'Inventory', '📦', 'inventory.view'], ['branches', 'Branches', '🏢', 'branch.view'], ['customers', 'Customers', '👥', 'customers.view'], ['audit', 'Audit', '🧾', 'audit.view'], ['settings', 'Settings', '⚙', null]];
  function render() {
    const nav = NAV.filter(n => !n[3] || can(n[3])); if (!nav.find(n => n[0] === route)) route = 'dashboard';
    const pg = PAGES[route];
    $('#app').innerHTML = `<div class="shell"><aside class="side"><div class="brand"><img src="assets/logo/AdamNokia_Secondary_Horizontal_Reversed_White.svg" width="190" alt="Adam Nokia Electronics"></div>
      ${nav.map(n => `<a href="#${n[0]}" class="${n[0] === route ? 'on' : ''}"><span class="ic">${n[2]}</span>${n[1]}</a>`).join('')}<div class="grow"></div><div class="me">${esc(S.me.name)}<br>${esc(S.me.role)}</div><a href="#" id="lo"><span class="ic">⎋</span>Sign out</a></aside>
      <div class="main"><div class="top"><h1>${pg.title}</h1><button class="btn sec sm" id="install" type="button">Install app</button><span class="pill" id="net" role="button" tabindex="0" title="Sync status" style="cursor:pointer"></span></div>${net.stale ? `<div class="notice" style="margin:10px 14px 0">⚠ <b>Offline</b> — showing data last synced ${dt(new Date(net.snapAt).toISOString())}. Stock and balances may be out of date. Sales and payments you record are saved on this device and sent automatically when you are back online.</div>` : ''}<div class="page" id="page">${pg.html()}</div></div>
      <nav class="bottom">${nav.slice(0, 5).map(n => `<a href="#${n[0]}" class="${n[0] === route ? 'on' : ''}"><span class="ic">${n[2]}</span>${n[1]}</a>`).join('')}<a href="#settings" class="${route === 'settings' ? 'on' : ''}"><span class="ic">⚙</span>More</a></nav></div>`;
    $('#lo').onclick = async e => { e.preventDefault(); try { await api('auth.logout'); } catch (x) { } if (token) logoutLocal(); };
    bindInstallButton(); updateStatus(); $('#net').onclick = syncModal;
    if (pg.bind) pg.bind();
  }

  /* ---- pages ---- */
  const PAGES = {};
  PAGES.dashboard = {
    title: 'Dashboard', html() {
      D = S.dashboard; const fin = D.month_gross_profit_usd != null;
      const k = (v, l, c) => `<div class="card kpi ${c || ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
      return `${D.overdue_items ? `<div class="notice">⚠ <b>${D.overdue_items} branch item(s) overdue — review required.</b> <a href="#branches">Open Branches</a></div>` : ''}
      <div class="grid kpis">${k(usd(D.today_sales_usd), "Today's sales")}${k(D.today_txns, "Today's transactions")}${k(usd(D.month_sales_usd), 'Sales this month')}${fin ? k(usd(D.month_gross_profit_usd), 'Gross profit (month)') : ''}${fin ? k(usd(D.stock_value_usd), 'Available stock value (cost)') : ''}
      ${k(D.low_stock.length, 'Low-stock products', D.low_stock.length ? 'warn' : '')}${k(D.out_of_stock.length, 'Out of stock', D.out_of_stock.length ? 'bad' : '')}${k(usd(D.customer_owed_usd), 'Customers owe us')}${k(D.branch_held_units, 'Units held by branches')}${k(D.pending_items, 'Pending branch units')}${k(D.overdue_items, 'Overdue (review)', D.overdue_items ? 'bad' : '')}</div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><h3>Recent sales</h3>${D.recent_sales.length ? `<table>${D.recent_sales.map(s => `<tr><td>${dt(s.at)}</td><td>${esc(s.customer)}${s.source !== 'POS' ? ' <span class="badge">Branch</span>' : ''}</td><td class="right">${usd(s.total_usd_cents)}</td><td><span class="badge ${s.status === 'PAID' ? 'ok' : 'warn'}">${s.status}</span></td></tr>`).join('')}</table>` : '<div class="empty">No sales yet. Make the first one in Sell.</div>'}</div>
      <div class="card"><h3>Needs attention</h3>${D.out_of_stock.length + D.low_stock.length ? `<table>${D.out_of_stock.map(p => `<tr><td>${esc(p.name)}</td><td><span class="badge bad">Out of stock</span></td></tr>`).join('')}${D.low_stock.slice(0, 12).map(p => `<tr><td>${esc(p.name)}</td><td><span class="badge warn">${p.available} left (min ${p.min})</span></td></tr>`).join('')}</table>` : '<div class="empty">Stock levels are all healthy.</div>'}</div></div>`;
    }
  };

  PAGES.pos = {
    title: 'Sell (Point of Sale)', html() {
      const cats = [...new Set(S.products.map(p => p.category))].sort();
      return `<div class="pos"><div><div class="row"><div class="f"><input id="q" placeholder="Search name, model or SKU…" value="${esc(state.q)}"></div><div class="f"><select id="cat"><option value="">All categories</option>${cats.map(c => `<option ${state.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div><div class="pgrid" id="pg" style="margin-top:10px"></div></div>
      <div class="card" id="cart"></div></div>`;
    },
    bind() {
      const draw = () => {
        const q = state.q.toLowerCase();
        const list = S.products.filter(p => p.status === 'active' && (!state.cat || p.category === state.cat) && (!q || (p.name + ' ' + (p.model || '') + ' ' + p.sku).toLowerCase().includes(q)));
        $('#pg').innerHTML = list.map(p => `<button class="pitem ${p.available < 1 ? 'out' : ''}" data-id="${p.id}"><b>${esc(p.name)}</b><span class="muted sm">${esc(p.category)}</span><div class="pr">${usd(p.price_usd_cents)}</div><span class="sm ${p.available < 1 ? '' : 'muted'}">${p.available < 1 ? 'Out of stock' : p.available + ' in stock'}</span></button>`).join('') || '<div class="empty">No products match.</div>';
        $('#pg').querySelectorAll('.pitem').forEach(b => b.onclick = () => { const p = P(b.dataset.id), n = (state.cart[p.id] || 0) + 1; if (n > p.available) return toast(`Only ${p.available} available`, 'err'); state.cart[p.id] = n; cart(); });
      };
      const cart = () => {
        const ids = Object.keys(state.cart), total = ids.reduce((s, id) => s + P(id).price_usd_cents * state.cart[id], 0), m = S.methods.find(x => x.id === state.method) || S.methods[0], rate = S.rates.USD_SLSH;
        $('#cart').innerHTML = `<h3>Cart</h3>${ids.length ? ids.map(id => `<div class="cartline"><div class="n">${esc(P(id).name)}<br><span class="muted sm">${usd(P(id).price_usd_cents)} each</span></div><div class="qty"><button data-d="-1" data-id="${id}">−</button><b>${state.cart[id]}</b><button data-d="1" data-id="${id}">+</button></div><div class="right nowrap" style="min-width:64px">${usd(P(id).price_usd_cents * state.cart[id])}</div></div>`).join('') : '<div class="empty">Tap a product to add it.</div>'}
        <label>Customer</label><select id="cu">${S.customers.filter(c => c.status === 'active').map(c => `<option value="${c.id}" ${state.cust === c.id ? 'selected' : ''}>${esc(c.name)}${c.credit_approved ? ' (credit)' : ''}</option>`).join('')}</select>
        <label>Payment method</label><select id="me">${S.methods.map(x => `<option value="${x.id}" ${m.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div style="margin:14px 0"><div class="total">${usd(total)}</div><div class="muted">${slsh(total * rate / 100)} <span class="sm">(1 USD = ${rate.toLocaleString()} SLSH)</span></div>${m.currency === 'SLSH' && m.id !== 'CREDIT' ? `<div class="badge ok" style="margin-top:6px">Customer pays ${slsh(total * rate / 100)}</div>` : ''}</div>
        <div class="row"><button class="btn f" id="chg" ${ids.length ? '' : 'disabled'}>Complete sale</button><button class="btn sec" id="clr" ${ids.length ? '' : 'disabled'}>Clear</button></div>`;
        $('#cart').querySelectorAll('[data-d]').forEach(b => b.onclick = () => { const id = b.dataset.id, n = state.cart[id] + Number(b.dataset.d); if (n < 1) delete state.cart[id]; else if (n > P(id).available) toast(`Only ${P(id).available} available`, 'err'); else state.cart[id] = n; cart(); });
        $('#cu').onchange = e => state.cust = e.target.value; $('#me').onchange = e => { state.method = e.target.value; cart(); }; $('#clr').onclick = () => { state.cart = {}; state.txn = null; cart(); };
        $('#chg').onclick = () => act(async () => {
          if (!state.txn) state.txn = 'TXN-' + DEVICE + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); /* same id on retry => never a duplicate sale */
          const r = await apiQ('sales.create', { customer_id: state.cust, method_id: state.method, items: ids.map(id => ({ product_id: id, qty: state.cart[id] })) }, state.txn);
          if (r.queued) { state.cart = {}; state.txn = null; modal('<h2>Saved on this device</h2><p>No connection right now. This sale is <b>not yet confirmed</b> by the shared system. It will be sent automatically when you are online. If the stock was sold elsewhere meanwhile, it will be flagged for review — never silently changed.</p><button class="btn" data-close style="width:100%">OK</button>'); return; }
          const s = r.data.sale; state.cart = {}; state.txn = null;
          modal(`<h2>✓ Sale recorded</h2><p class="muted">${esc(s.id)} · ${dt(s.at)}</p><div class="total">${usd(s.total_usd_cents)}</div>${r.data.payment ? `<p>Paid via ${esc(r.data.payment.method_id.replace('_', ' '))}: <b>${r.data.payment.currency === 'USD' ? usd(r.data.payment.amount_minor) : slsh(r.data.payment.amount_minor)}</b></p>` : '<p><span class="badge warn">On credit</span></p>'}<button class="btn" data-close style="width:100%">New sale</button>`);
        });
      };
      $('#q').oninput = e => { state.q = e.target.value; draw(); }; $('#cat').onchange = e => { state.cat = e.target.value; draw(); }; draw(); cart();
    }
  };

  PAGES.inventory = {
    title: 'Inventory', html() {
      const cats = [...new Set(S.products.map(p => p.category))].sort(), fin = can('finance.view');
      return `<div class="row" style="margin-bottom:10px"><div class="f"><input id="iq" placeholder="Search products…" value="${esc(state.invQ)}"></div><div class="f"><select id="ic"><option value="">All categories</option>${cats.map(c => `<option ${state.invCat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>${can('inventory.manage') ? '<button class="btn" id="addp">+ Product</button>' : ''}</div>
      <div class="tablewrap"><table><thead><tr><th>ID</th><th>Product</th><th>Category</th><th class="right">Available</th><th class="right">With branches</th><th class="right">Price</th>${fin ? '<th class="right">Cost</th><th class="right">Markup</th>' : ''}<th></th></tr></thead><tbody id="ib"></tbody></table></div>`;
    },
    bind() {
      const fin = can('finance.view'), draw = () => {
        const q = state.invQ.toLowerCase(), list = S.products.filter(p => (!state.invCat || p.category === state.invCat) && (!q || (p.name + ' ' + (p.model || '') + ' ' + p.sku + ' ' + p.category).toLowerCase().includes(q)));
        $('#ib').innerHTML = list.map(p => `<tr class="click" data-id="${p.id}"><td class="muted nowrap">${p.id}</td><td>${esc(p.name)}${p.status !== 'active' ? ' <span class="badge">inactive</span>' : ''}</td><td>${esc(p.category)}</td><td class="right"><b>${p.available}</b></td><td class="right">${p.held || ''}</td><td class="right">${usd(p.price_usd_cents)}</td>${fin ? `<td class="right muted">${usd(p.cost_usd_cents)}</td><td class="right muted">${p.cost_usd_cents ? Math.round((p.price_usd_cents / p.cost_usd_cents - 1) * 100) + '%' : ''}</td>` : ''}<td>${p.available < 1 ? '<span class="badge bad">Out</span>' : p.available <= p.min_stock ? '<span class="badge warn">Low</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No products found.</td></tr>';
        $('#ib').querySelectorAll('tr.click').forEach(r => r.onclick = () => productDlg(r.dataset.id));
      };
      $('#iq').oninput = e => { state.invQ = e.target.value; draw(); }; $('#ic').onchange = e => { state.invCat = e.target.value; draw(); }; draw();
      if ($('#addp')) $('#addp').onclick = () => modal(`<h2>New product</h2><label>Name</label><input id="n"><label>Category</label><input id="c" list="cl"><datalist id="cl">${[...new Set(S.products.map(p => p.category))].map(c => `<option>${esc(c)}</option>`).join('')}</datalist><div class="row"><div class="f"><label>Cost (AED)</label><input id="co" type="number" step="0.01"></div><div class="f"><label>Selling price (USD)</label><input id="pr" type="number" step="0.01"></div></div><div class="row" style="margin-top:14px"><button class="btn f" id="ok">Save</button><button class="btn sec" data-close>Cancel</button></div><p class="muted sm">Opening quantity is added afterwards with a stock adjustment, so every unit has a recorded reason.</p>`, d => d.querySelector('#ok').onclick = () => act(async () => { await api('products.create', { name: $('#n').value, category: $('#c').value, cost_aed: $('#co').value, price_usd: $('#pr').value }); closeModal(); }, 'Product added'));
    }
  };
  async function productDlg(id) {
    const p = P(id), mv = (await api('stock.movements', { product_id: id })).data, fin = can('finance.view');
    const nm = { OPENING: 'Opening stock', SALE: 'Sale', ADJUSTMENT: 'Adjustment', BRANCH_COLLECTION: 'Collected by branch', BRANCH_SOLD: 'Branch sold', RETURN_APPROVED: 'Return approved' };
    modal(`<h2>${esc(p.name)}</h2><p class="muted">${p.id} · ${esc(p.category)}${p.model ? ' · ' + esc(p.model) + ' <span class="badge">derived</span>' : ''}</p>
      <div class="grid kpis"><div class="card kpi"><div class="v">${p.available}</div><div class="l">Available</div></div><div class="card kpi"><div class="v">${p.held}</div><div class="l">With branches</div></div><div class="card kpi"><div class="v">${usd(p.price_usd_cents)}</div><div class="l">Price${fin ? ' · cost ' + usd(p.cost_usd_cents) : ''}</div></div></div>
      ${can('price.update') ? `<label>Change selling price (USD) — logged in audit</label><div class="row"><input class="f" id="np" type="number" step="0.01" value="${(p.price_usd_cents / 100).toFixed(2)}"><input class="f" id="npr" placeholder="Reason"><button class="btn" id="sp">Update</button></div>` : '<p class="muted sm">Prices are fixed. Only a manager or owner can change them.</p>'}
      ${can('stock.adjust') ? `<label>Adjust stock (+ adds, − removes) — reason required</label><div class="row"><input class="f" id="ad" type="number" placeholder="e.g. -2"><input class="f" id="ar" placeholder="Reason (e.g. damaged)"><button class="btn amber" id="sa">Adjust</button></div>` : ''}
      <h3 style="margin-top:16px">Stock history</h3><div class="tablewrap" style="max-height:220px;overflow:auto"><table>${mv.map(m => `<tr><td class="nowrap sm">${dt(m.at)}</td><td>${nm[m.type] || m.type}</td><td class="right"><b>${m.to === 'AVAILABLE' ? '+' : m.from === 'AVAILABLE' ? '−' : ''}${m.qty}</b></td><td class="muted sm">${esc(m.reason || m.ref || '')}</td></tr>`).join('')}</table></div><button class="btn sec" data-close style="margin-top:12px;width:100%">Close</button>`,
      d => {
        if (d.querySelector('#sp')) d.querySelector('#sp').onclick = () => act(async () => { await api('products.setPrice', { product_id: id, price_usd_cents: Math.round(Number(d.querySelector('#np').value) * 100), reason: d.querySelector('#npr').value }); closeModal(); }, 'Price updated');
        if (d.querySelector('#sa')) d.querySelector('#sa').onclick = () => act(async () => { await api('stock.adjust', { product_id: id, delta: Number(d.querySelector('#ad').value), reason: d.querySelector('#ar').value }); closeModal(); }, 'Stock adjusted');
      });
  }

  PAGES.customers = {
    title: 'Customers', html() {
      const cat = { WALK_IN: 'Walk-in', TECHNICIAN: 'Technician / Repair Shop', BUSINESS: 'Business Account' };
      return `<div class="row" style="margin-bottom:10px"><div class="f"></div>${can('customers.create') ? '<button class="btn" id="addc">+ Customer</button>' : ''}</div><div class="tablewrap"><table><thead><tr><th>Name</th><th>Category</th><th>Credit</th><th class="right">Owes</th><th></th></tr></thead><tbody>
      ${S.customers.map(c => `<tr><td>${esc(c.name)}<br><span class="muted sm">${esc(c.phone || '')}</span></td><td>${cat[c.category]}</td><td>${c.credit_approved ? `<span class="badge ok">Approved${c.credit_limit_usd_cents ? ' · limit ' + usd(c.credit_limit_usd_cents) : ''}</span>` : '<span class="badge">Not approved</span>'}</td><td class="right"><b>${c.outstanding_usd_cents ? usd(c.outstanding_usd_cents) : '—'}</b></td>
      <td class="right nowrap">${can('credit.approve') && c.id !== 'CUS-WALKIN' ? `<button class="btn sm sec" data-cr="${c.id}">Credit…</button> ` : ''}${can('payments.record') && c.outstanding_usd_cents > 0 ? `<button class="btn sm" data-pay="${c.id}">Record payment</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
    },
    bind() {
      if ($('#addc')) $('#addc').onclick = () => modal(`<h2>New customer</h2><label>Name</label><input id="n"><label>Phone</label><input id="ph"><label>Category</label><select id="ct"><option value="WALK_IN">Walk-in</option><option value="TECHNICIAN">Technician / Repair Shop</option><option value="BUSINESS">Business Account</option></select><div class="row" style="margin-top:14px"><button class="btn f" id="ok">Save</button><button class="btn sec" data-close>Cancel</button></div><p class="muted sm">Category does not grant credit. Credit is approved separately.</p>`, d => d.querySelector('#ok').onclick = () => act(async () => { await api('customers.create', { name: $('#n').value, phone: $('#ph').value, category: $('#ct').value }); closeModal(); }, 'Customer added'));
      document.querySelectorAll('[data-cr]').forEach(b => b.onclick = () => { const c = C(b.dataset.cr); modal(`<h2>Credit — ${esc(c.name)}</h2><label>Credit approved</label><select id="ap"><option value="0">No</option><option value="1" ${c.credit_approved ? 'selected' : ''}>Yes</option></select><label>Credit limit (USD, 0 = no limit)</label><input id="lm" type="number" value="${c.credit_limit_usd_cents / 100}"><label>Reason</label><input id="rs"><div class="row" style="margin-top:14px"><button class="btn f" id="ok">Save</button><button class="btn sec" data-close>Cancel</button></div>`, d => d.querySelector('#ok').onclick = () => act(async () => { await api('customers.setCredit', { customer_id: c.id, approved: $('#ap').value === '1', limit_usd: $('#lm').value, reason: $('#rs').value }); closeModal(); }, 'Credit updated')); });
      document.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => { const c = C(b.dataset.pay); modal(`<h2>Payment from ${esc(c.name)}</h2><p>Outstanding: <b>${usd(c.outstanding_usd_cents)}</b></p><label>Method</label><select id="m">${S.methods.filter(m => m.id !== 'CREDIT').map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><label>Amount (in the method's currency)</label><input id="a" type="number" step="0.01"><label>Reference (optional)</label><input id="rf"><div class="row" style="margin-top:14px"><button class="btn f" id="ok">Record</button><button class="btn sec" data-close>Cancel</button></div>`, d => d.querySelector('#ok').onclick = () => act(async () => { const r = await apiQ('payments.recordRepayment', { customer_id: c.id, method_id: $('#m').value, amount: $('#a').value, reference: $('#rf').value }, 'TXN-' + DEVICE + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)); closeModal(); return r.queued ? 'Saved on this device — will be confirmed when online' : 'Payment recorded'; })); });
    }
  };

  const ST = { PENDING: ['Pending', ''], SOLD: ['Sold', 'ok'], RETURN_REPORTED: ['Return — awaiting inspection', 'warn'], RETURN_INSPECTED: ['Inspected — awaiting approval', 'warn'], RETURNED_APPROVED: ['Returned to stock', 'ok'], RETURN_REJECTED: ['Return rejected', 'bad'] };
  PAGES.branches = {
    title: 'Branch Collections', html() {
      const brs = S.branches, b = state.branch, its = S.collItems.filter(i => i.branch_id === b), open = i => ['PENDING', 'RETURN_REPORTED', 'RETURN_INSPECTED'].includes(i.status), shown = (state.showDone ? its : its.filter(open)).slice().reverse();
      const pend = its.filter(i => i.status === 'PENDING').reduce((s, i) => s + i.qty, 0), over = its.filter(i => i.overdue).reduce((s, i) => s + i.qty, 0), held = S.products.reduce((s, p) => s, 0);
      return `<p class="muted sm" style="margin-top:0">Customer account: <b>${esc(S.settings.credit_customer_name)}</b> — an independent business. Collected stock leaves Available immediately but is <b>not a sale</b> until the branch confirms it sold.</p>
      <div class="tabs">${brs.map(x => `<button data-b="${x.id}" class="${x.id === b ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
      <div class="grid kpis" style="margin-bottom:12px"><div class="card kpi"><div class="v">${pend}</div><div class="l">Pending units</div></div><div class="card kpi ${over ? 'bad' : ''}"><div class="v">${over}</div><div class="l">Overdue (48h+)</div></div><div class="card kpi"><div class="v">${brs.find(x => x.id === b).cycle === 'WEEKLY' ? 'Weekly' : 'Daily'}</div><div class="l">Reconciliation cycle</div></div></div>
      <div class="row" style="margin-bottom:10px">${can('branch.collect') ? '<button class="btn" id="nc">+ New collection</button>' : ''}<label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="sd" style="width:auto;min-height:0" ${state.showDone ? 'checked' : ''}> Show completed</label></div>
      <div class="tablewrap"><table><thead><tr><th>Product</th><th class="right">Qty</th><th>Technician / Assistant</th><th>Collected</th><th>Status</th><th></th></tr></thead><tbody>${shown.map(i => `<tr><td>${esc((P(i.product_id) || {}).name)}</td><td class="right"><b>${i.qty}</b></td><td>${esc(i.technician)}<br><span class="muted sm">by ${esc(i.assistant)}</span></td><td class="sm nowrap">${dt(i.collected_at)}<br><span class="muted">${i.age_hours}h ago</span></td>
      <td>${i.overdue ? '<span class="badge bad">Overdue — Review Required</span>' : `<span class="badge ${ST[i.status][1]}">${ST[i.status][0]}</span>`}${i.inspection ? `<br><span class="sm muted">${i.inspection.result === 'RESTOCK' ? 'Restock' : 'Reject'} · ${esc(i.inspection.by_name)}</span>` : ''}</td>
      <td class="right nowrap">${actions(i)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No open items for this branch.</td></tr>'}</tbody></table></div>`;
    },
    bind() {
      document.querySelectorAll('[data-b]').forEach(x => x.onclick = () => { state.branch = x.dataset.b; render(); });
      $('#sd').onchange = e => { state.showDone = e.target.checked; render(); }; if ($('#nc')) $('#nc').onclick = collectDlg;
      document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => itemAction(b.dataset.a, b.dataset.id));
    }
  };
  function actions(i) {
    const b = (a, t, c) => `<button class="btn sm ${c || 'sec'}" data-a="${a}" data-id="${i.id}">${t}</button> `;
    if (i.status === 'PENDING') return i.overdue ? (can('branch.approve') ? b('review', 'Review', 'amber') : '<span class="muted sm">Manager review</span>') : (can('branch.setStatus') ? b('sold', 'Sold', '') + b('ret', 'Returned') : '');
    if (i.status === 'RETURN_REPORTED' && can('branch.inspect')) return b('insp', 'Inspect', 'amber');
    if (i.status === 'RETURN_INSPECTED' && can('branch.approve')) return b('appr', 'Approve', '');
    return '';
  }
  function itemAction(a, id) {
    const i = S.collItems.find(x => x.id === id), name = esc((P(i.product_id) || {}).name), qtyF = `<label>Quantity (of ${i.qty})</label><input id="q" type="number" min="1" max="${i.qty}" value="${i.qty}">`;
    const dlg = (title, body, btn, fn) => modal(`<h2>${title}</h2><p class="muted">${name} · ${esc(i.technician)}</p>${body}<div class="row" style="margin-top:14px"><button class="btn f" id="ok">${btn}</button><button class="btn sec" data-close>Cancel</button></div>`, d => d.querySelector('#ok').onclick = () => act(async () => { await fn(d); closeModal(); }, 'Saved'));
    if (a === 'sold') dlg('Confirm SOLD', qtyF + '<p class="muted sm">Creates a billable sale at the current price. Stock is not deducted again.</p>', 'Confirm sold', () => api('branch.setItemStatus', { item_id: id, status: 'SOLD', qty: Number($('#q').value) }));
    if (a === 'ret') dlg('Item RETURNED', qtyF + '<p class="muted sm">Stock is NOT restored until it is inspected and approved.</p>', 'Mark returned', () => api('branch.setItemStatus', { item_id: id, status: 'RETURN_REPORTED', qty: Number($('#q').value) }));
    if (a === 'insp') dlg('Inspect return', '<label>Result</label><select id="r"><option value="RESTOCK">Good — can go back to stock</option><option value="REJECT">Damaged / not resalable</option></select><label>Notes</label><input id="nt">', 'Save inspection', () => api('branch.inspectReturn', { item_id: id, result: $('#r').value, notes: $('#nt').value }));
    if (a === 'appr') dlg('Approve return', `<p>Inspection result: <b>${i.inspection ? i.inspection.result : ''}</b></p><label>Notes</label><input id="nt">`, 'Approve', () => api('branch.approveReturn', { item_id: id, notes: $('#nt').value }));
    if (a === 'review') dlg('Overdue review', `<div class="notice">Pending ${i.age_hours} hours. Nothing is changed automatically. Choose a decision and give a reason — it is permanently recorded.</div><label>Decision</label><select id="dc"><option value="SOLD">Classify as SOLD</option><option value="RETURN_REPORTED">Classify as RETURNED (needs inspection)</option><option value="KEEP_PENDING">Keep pending</option></select>${qtyF}<label>Reason (required)</label><input id="rs">`, 'Record decision', () => api('branch.reviewOverdue', { item_id: id, decision: $('#dc').value, qty: Number($('#q').value), reason: $('#rs').value }));
  }
  function collectDlg() {
    const b = state.branch, asst = S.people.filter(p => p.branch_id === b && p.role === 'ASSISTANT'), tech = S.people.filter(p => p.branch_id === b && p.role === 'TECHNICIAN'), opts = S.products.filter(p => p.status === 'active').map(p => `<option value="${p.id}">${esc(p.name)} (${p.available})</option>`).join('');
    const row = () => `<div class="row" style="margin-top:6px"><select class="f ln-p"><option value="">Product…</option>${opts}</select><input class="ln-q" type="number" min="1" value="1" style="width:70px"></div>`;
    modal(`<h2>New collection — ${esc(S.branches.find(x => x.id === b).name)}</h2><label>Assistant collecting</label><select id="as">${asst.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><label>Technician it is for</label><select id="te">${tech.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><label>Products</label><div id="lines">${row()}</div><button class="btn sm sec" id="more" style="margin-top:8px">+ Add product</button>
      <div class="row" style="margin-top:14px"><button class="btn f" id="ok">Confirm collection</button><button class="btn sec" data-close>Cancel</button></div>`, d => {
      d.querySelector('#more').onclick = () => d.querySelector('#lines').insertAdjacentHTML('beforeend', row());
      d.querySelector('#ok').onclick = () => act(async () => { const items = [...d.querySelectorAll('.ln-p')].map((s, k) => ({ product_id: s.value, qty: Number(d.querySelectorAll('.ln-q')[k].value) })).filter(x => x.product_id); await api('branch.collect', { branch_id: b, assistant_id: $('#as').value, technician_id: $('#te').value, items }); closeModal(); }, 'Collection recorded — stock moved to branch');
    });
  }

  PAGES.audit = {
    title: 'Audit Log', html() { const a = S.audit || []; return `<div class="tablewrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Change</th><th>Reason</th></tr></thead><tbody>${a.map(x => `<tr><td class="nowrap sm">${dt(x.at)}</td><td>${esc(x.user)}</td><td><span class="badge">${esc(x.action)}</span></td><td class="sm">${esc(x.entity_id)}</td><td class="sm">${x.old != null || x.new != null ? esc(JSON.stringify(x.old)) + ' → ' + esc(JSON.stringify(x.new)) : ''}</td><td class="sm">${esc(x.reason || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing yet.</td></tr>'}</tbody></table></div>`; }
  };

  PAGES.settings = {
    title: 'Settings', html() {
      const r = S.rates, ru = can('rates.update');
      return `<div class="grid g2"><div class="card"><h3>Exchange rates</h3><p class="muted sm">Every sale and payment keeps the rate it was made with. Changing a rate never changes old records.</p>
        <label>USD → SLSH (shillings per 1 USD) — update daily</label><div class="row"><input class="f" id="r1" type="number" value="${r.USD_SLSH}" ${ru ? '' : 'disabled'}>${ru ? '<button class="btn" data-rate="USD_SLSH">Save</button>' : ''}</div>
        <label>AED per 1 USD — purchasing</label><div class="row"><input class="f" id="r2" type="number" step="0.0001" value="${r.AED_USD}" ${ru ? '' : 'disabled'}>${ru ? '<button class="btn" data-rate="AED_USD">Save</button>' : ''}</div>
        <h3 style="margin-top:14px">Rate history</h3><table>${S.rateHistory.map(x => `<tr><td class="sm">${dt(x.effective_at)}</td><td>${x.pair.replace('_', '→')}</td><td class="right">${x.previous == null ? '' : x.previous + ' → '}<b>${x.rate}</b></td><td class="sm muted">${esc(x.by)}</td></tr>`).join('')}</table></div>
      <div class="card"><h3>Business</h3><p>${esc(S.settings.business_name)}<br><span class="muted">${esc(S.settings.address)}<br>${esc(S.settings.phone)} · ${esc(S.settings.email)}<br>${esc(S.settings.website)}</span></p><p class="sm muted">Default low-stock level: ${S.settings.default_min_stock} units</p>
        <h3>Shared data</h3><p class="muted sm">All devices use the same online records. Work done offline waits in the sync queue until the server confirms it.</p><div class="row"><button class="btn sec" id="sy">Sync status</button></div></div>
      ${can('users.manage') ? `<div class="card"><h3>Staff</h3><table>${S.users.map(u => `<tr><td>${esc(u.full_name)}<br><span class="muted sm">${esc(u.username)}</span></td><td><span class="badge">${u.role}</span></td><td>${u.has_password ? '<span class="badge ok">Active</span>' : '<span class="badge warn">Not signed in yet</span>'}</td><td><button class="btn sec sm" data-code="${esc(u.username)}">${u.has_password ? 'Reset password' : 'Setup code'}</button></td></tr>`).join('')}</table></div>` : ''}</div>`;
    },
    bind() {
      document.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => act(() => api('rates.set', { pair: b.dataset.rate, rate: $(b.dataset.rate === 'USD_SLSH' ? '#r1' : '#r2').value }), 'Rate updated'));
      if ($('#sy')) $('#sy').onclick = syncModal;
      document.querySelectorAll('[data-code]').forEach(b => b.onclick = () => modal(`<h2>New setup code for ${esc(b.dataset.code)}?</h2><p class="muted sm">${esc(b.dataset.code)} will be signed out and must create a new password with the code. The code works once and expires in 72 hours.</p><div class="row"><button class="btn f" id="y">Create code</button><button class="btn sec" data-close>Cancel</button></div>`, d => d.querySelector('#y').onclick = async () => { try { const r = await api('users.issueSetupCode', { username: b.dataset.code }); modal(`<h2>Setup code</h2><div class="total" style="letter-spacing:2px">${esc(r.data.code)}</div><p class="muted sm">Give this to ${esc(r.data.username)} privately (not in a group chat). It is shown only once.</p><button class="btn" data-close style="width:100%">Done</button>`); await refresh(); } catch (e) { toast(e.message, 'err'); } }));
    }
  };
  boot();
})();
