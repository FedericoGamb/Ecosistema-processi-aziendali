/* VERSIONE ONLINE (Supabase). Stesso "database" della versione locale, ma i dati stanno nella tabella portale_doc
   del progetto Supabase della Gestione Produzione. Login condiviso: stessa sessione della produzione (stesso sito).
   Ogni salvataggio controlla la versione del dato: se un'altra persona l'ha cambiato nel frattempo non sovrascrive. */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {}, SUPABASE_URL = CFG.supabaseUrl || '', SUPABASE_KEY = CFG.supabaseKey || '';
  if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.indexOf('__') === 0) return;
  if (window.claude && typeof window.claude.use === 'function') return;
  const LSS = 'produzione-sessione', T = 'portale_doc', POLL = 20000;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const store = new Map();               /* "collezione/id" -> { data, ver } */
  const subs = new Set(), listeners = new Set();
  const S = { sess: null, err: '', at: null };
  const status = () => listeners.forEach((f) => { try { f(); } catch (e) { /* nessuno */ } });
  const notify = () => Array.from(subs).forEach((s) => { try { s(); } catch (e) { /* nessuno */ } });
  const readSess = () => { try { return JSON.parse(localStorage.getItem(LSS)); } catch (e) { return null; } };
  const writeSess = (s) => { try { localStorage.setItem(LSS, JSON.stringify(s)); } catch (e) { /* nessuno */ } };
  const enc = encodeURIComponent;
  const keyOf = (p) => { const i = p.indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };

  /* ---------- accesso (stessa sessione della Gestione Produzione) ---------- */
  async function auth(grant, body) {
    const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || j.message || ('errore ' + r.status)), { http: r.status, auth: true });
    const u = j.user || {};
    S.sess = { token: j.access_token, refresh: j.refresh_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000, role: (u.app_metadata && u.app_metadata.ruolo) || '', email: u.email || '' };
    writeSess(S.sess);
  }
  let refreshing = null;
  function refresh() {
    /* se la produzione (o un'altra scheda) ha già rinnovato la sessione, si usa quella */
    const s2 = readSess();
    if (s2 && s2.token && S.sess && s2.token !== S.sess.token && s2.exp > Date.now() + 30000) { S.sess = s2; return Promise.resolve(); }
    return refreshing || (refreshing = auth('refresh_token', { refresh_token: S.sess.refresh }).finally(() => { refreshing = null; }));
  }
  async function api(path, opts, retry) {
    opts = opts || {};
    if (Date.now() > S.sess.exp) await refresh();
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, opts, { headers: Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + S.sess.token, 'Content-Type': 'application/json' }, opts.headers || {}) }));
    if (r.status === 401 && retry !== false) { await refresh(); return api(path, opts, false); }
    if (!r.ok) {
      const raw = await r.text().catch(() => ''); let m = raw;
      try { m = JSON.parse(raw).message || raw; } catch (e) { /* testo semplice */ }
      throw Object.assign(new Error(String(m || ('errore ' + r.status)).slice(0, 200)), { http: r.status });
    }
    return r;
  }
  async function getAll(path) {
    let out = [];
    for (let from = 0; ; from += 1000) {
      let rows;
      try { rows = await (await api(path, { headers: { 'Range-Unit': 'items', Range: from + '-' + (from + 999) } })).json(); }
      catch (e) { if (e.http === 416) break; throw e; }
      out = out.concat(rows); if (rows.length < 1000) break;
    }
    return out;
  }

  /* ---------- lettura periodica ---------- */
  const sigNow = () => Array.from(store.keys()).sort().map((k) => k + ':' + store.get(k).ver).join('|');
  let sig = '';
  async function pull() {
    const rows = await getAll(T + '?select=col,id,data,ver&order=col.asc,id.asc');
    S.at = new Date().toISOString(); S.err = '';
    const s = rows.map((r) => r.col + '/' + r.id + ':' + r.ver).sort().join('|');
    if (s !== sig) { store.clear(); rows.forEach((r) => store.set(r.col + '/' + r.id, { data: r.data || {}, ver: r.ver })); sig = s; notify(); }
    status();
  }
  const pullQuiet = () => { if (S.sess) pull().catch((e) => { S.err = e.auth || e.http === 401 ? 'Sessione scaduta: esci e accedi di nuovo' : (e instanceof TypeError ? 'Connessione assente' : e.message); status(); }); };

  /* ---------- scrittura con controllo della versione ---------- */
  function conflict() { setTimeout(pullQuiet, 0); throw Object.assign(new Error('CONFLICT'), { code: 'conflict' }); }
  async function writeRow(p, data, ver) {
    const [c, id] = keyOf(p);
    let rows;
    if (ver != null) {
      rows = await (await api(T + '?col=eq.' + enc(c) + '&id=eq.' + enc(id) + '&ver=eq.' + ver, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ data: data }) })).json();
      if (!rows.length) conflict();
    } else {
      try { rows = await (await api(T, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ col: c, id: id, data: data }]) })).json(); }
      catch (e) { if (e.http === 409) conflict(); throw e; }
    }
    store.set(p, { data: rows[0].data, ver: rows[0].ver }); sig = sigNow(); S.at = new Date().toISOString(); notify(); status();
  }

  /* ---------- stessa interfaccia della versione locale ---------- */
  const snapDoc = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.has(p) ? Object.freeze(clone(store.get(p).data)) : undefined });
  const colDocs = (c) => Array.from(store.keys()).filter((p) => p.startsWith(c + '/') && p.split('/').length === 2).map(snapDoc);
  function mkQuery(col, order, lim) {
    const q = {
      orderBy: (f, d) => mkQuery(col, [f, d || 'asc'], lim), limit: (n) => mkQuery(col, order, n),
      _docs() {
        let d = colDocs(col);
        if (order) d.sort((a, b) => { const x = a.data()[order[0]], y = b.data()[order[0]]; return (x < y ? -1 : x > y ? 1 : 0) * (order[1] === 'desc' ? -1 : 1); });
        return lim ? d.slice(0, lim) : d;
      },
      get: async () => { const d = q._docs(); return { docs: d, size: d.length, empty: !d.length }; },
      onSnapshot(next) { const s = () => { const d = q._docs(); next({ docs: d, size: d.length, empty: !d.length }); }; subs.add(s); setTimeout(s, 0); return () => subs.delete(s); }
    };
    return q;
  }
  const newId = () => { let s = ''; while (s.length < 20) s += Math.random().toString(36).slice(2); return s.slice(0, 20); };
  const db = {
    doc: (path) => ({
      id: path.split('/').pop(), path: path,
      get: async () => {   /* lettura fresca dal database: serve al controllo dei seriali */
        const [c, id] = keyOf(path);
        const rows = await (await api(T + '?select=data,ver&col=eq.' + enc(c) + '&id=eq.' + enc(id))).json();
        const before = store.has(path) ? store.get(path).ver : null;
        if (rows.length) store.set(path, { data: rows[0].data || {}, ver: rows[0].ver }); else store.delete(path);
        if ((rows.length ? rows[0].ver : null) !== before) { sig = sigNow(); setTimeout(notify, 0); }   /* cambiato da altri: si aggiorna la pagina */
        return snapDoc(path);
      },
      set: async (d) => { const cur = store.get(path); await writeRow(path, clone(d), cur ? cur.ver : null); },
      update: async (d) => { const cur = store.get(path); await writeRow(path, Object.assign(clone(cur ? cur.data : {}), clone(d)), cur ? cur.ver : null); },
      delete: async () => { const [c, id] = keyOf(path); await api(T + '?col=eq.' + enc(c) + '&id=eq.' + enc(id), { method: 'DELETE' }); store.delete(path); sig = sigNow(); notify(); status(); },
      onSnapshot(next) { const s = () => next(snapDoc(path)); subs.add(s); setTimeout(s, 0); return () => subs.delete(s); }
    }),
    collection: (col) => Object.assign(mkQuery(col), { add: async (d) => { const id = newId(); await writeRow(col + '/' + id, clone(d), null); return { id: id }; } })
  };
  const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv;charset=utf-8', pdf: 'application/pdf', json: 'application/json' };
  const dl = {
    save: async (r) => {
      const ext = String(r.filename).split('.').pop().toLowerCase(), a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.data], { type: MIME[ext] || 'application/octet-stream' })); a.download = r.filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return { status: 'saved' };
    }
  };

  /* ---------- copia e ripristino (stesso formato del file locale) ---------- */
  function exportText() {
    const dati = {};
    store.forEach((v, p) => { const [c, id] = keyOf(p); (dati[c] = dati[c] || {})[id] = v.data; });
    return JSON.stringify({ formato: 'collaudi-seriali', versione: 1, salvato: new Date().toISOString(), dati: dati }, null, 2);
  }
  function parseText(txt) {
    let o; try { o = JSON.parse(txt); } catch (e) { throw new Error('non è un file JSON valido'); }
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (!isObj(o) || o.formato !== 'collaudi-seriali' || !isObj(o.dati)) throw new Error('non è un file dati di Collaudi e Seriali');
    const m = new Map();
    Object.keys(o.dati).forEach((c) => {
      if (!isObj(o.dati[c])) throw new Error('struttura non valida (' + c + ')');
      Object.keys(o.dati[c]).forEach((id) => { if (!isObj(o.dati[c][id])) throw new Error('documento non valido: ' + c + '/' + id); m.set(c + '/' + id, o.dati[c][id]); });
    });
    const cnt = (c) => Object.keys(o.dati[c] || {}).length;
    return { salvato: o.salvato || null, map: m, counts: { matricole: cnt('serials'), ordini: cnt('orders'), collaudi: cnt('events'), lotti: cnt('runs') } };
  }
  async function replaceAll(parsed) {
    await api(T + '?col=neq.__nessuna__', { method: 'DELETE' });
    const rows = []; parsed.map.forEach((v, k) => { const [c, id] = keyOf(k); rows.push({ col: c, id: id, data: v }); });
    for (let i = 0; i < rows.length; i += 200) await api(T, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200)) });
    sig = ''; await pull();
  }

  /* ---------- turni e prodotti della produzione, nello stesso formato di produzione.json ---------- */
  async function prodJson() {
    try {
      const since = new Date(Date.now() - 200 * 864e5).toISOString();
      const res = await Promise.all([getAll('anagrafica?select=*&tipo=in.(prodotti,operatori)&order=id.asc'),
        getAll('registrazioni?select=ts,prodotto,tipo,pezzi,operatore&tipo=in.(Produzione,Scarto)&ts=gte.' + enc(since) + '&order=ts.asc')]);
      const REP = /^(stampaggio|officina|entrambi)::([\s\S]*)$/;
      const conv = (x) => {
        const m = REP.exec(String(x.b || '')), o = { id: x.id, a: x.a, b: m ? m[2] : x.b };
        if (m) o.reparto = m[1];
        if (x.ritmo != null) o.ritmo = Number(x.ritmo);
        if (x.postazioni != null) o.postazioni = Number(x.postazioni);
        if (x.matricola) o.matricola = x.matricola;
        return o;
      };
      const out = { prodotti: res[0].filter((x) => x.tipo === 'prodotti').map(conv), operatori: res[0].filter((x) => x.tipo === 'operatori').map(conv), registrazioni: res[1] };
      return { ok: true, text: JSON.stringify(out), at: Date.now() };
    } catch (e) { return { ok: false, why: 'err', msg: e.message }; }
  }

  /* ---------- schermata di accesso ---------- */
  const domReady = new Promise((r) => { if (document.readyState !== 'loading') r(); else document.addEventListener('DOMContentLoaded', r); });
  function loginUi(msg) {
    return new Promise((resolve) => {
      const el = document.createElement('div'); el.id = 'cloudLogin';
      el.setAttribute('style', 'position:fixed;inset:0;z-index:100;background:#102935;display:grid;place-items:center;padding:16px;font-family:IBM Plex Sans,system-ui,sans-serif');
      el.innerHTML = '<form style="background:#fff;color:#102935;padding:28px;border-radius:14px;width:100%;max-width:360px;display:grid;gap:12px;box-shadow:0 20px 50px rgba(0,0,0,.35)">' +
        '<h1 style="margin:0;font-size:22px">Collaudi e Seriali</h1><p style="margin:0;color:#566B75;font-size:14px">Accedi con l’account amministratore della Gestione Produzione.</p>' +
        '<input id="clU" type="email" placeholder="Email" autocomplete="username" required style="min-height:44px;padding:8px 11px;border:1px solid #B1C0C7;border-radius:8px;font:inherit">' +
        '<input id="clP" type="password" placeholder="Password" autocomplete="current-password" required style="min-height:44px;padding:8px 11px;border:1px solid #B1C0C7;border-radius:8px;font:inherit">' +
        '<p id="clE" role="alert" style="margin:0;color:#AE2A22;font-size:14px;min-height:1em"></p>' +
        '<button style="min-height:46px;border:0;border-radius:8px;background:#15657E;color:#fff;font:inherit;font-weight:600;cursor:pointer">Accedi</button>' +
        '<a href="../" style="color:#15657E;font-size:14px;text-align:center">Vai alla Gestione Produzione</a></form>' +
        '<p style="margin:14px 0 0;text-align:center;font-size:12.5px;color:rgba(255,255,255,.78)">© ' + new Date().getFullYear() + ' · Software realizzato e di proprietà di <a href="https://www.linkedin.com/in/federicogambina/" target="_blank" rel="noopener author" style="color:inherit;font-weight:600">Federico Gambina</a></p>';
      el.style.gridTemplateRows = '1fr auto';
      document.body.appendChild(el);
      const err = el.querySelector('#clE'); if (msg) err.textContent = msg;
      el.querySelector('#clU').focus();
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault(); err.textContent = '';
        try { await auth('password', { email: el.querySelector('#clU').value.trim(), password: el.querySelector('#clP').value }); }
        catch (x) { err.textContent = x.auth && [400, 401, 422].includes(x.http) ? 'Credenziali non valide' : 'Impossibile collegarsi: ' + x.message; return; }
        if (S.sess.role !== 'admin') { err.textContent = 'Accesso riservato all’amministratore.'; S.sess = null; return; }
        el.remove(); resolve();
      };
    });
  }

  const ready = (async () => {
    S.sess = readSess();
    let msg = '';
    if (S.sess && S.sess.role === 'admin') {
      try { if (Date.now() > S.sess.exp) await refresh(); await pull(); return; }
      catch (e) { if (!(e.auth || e.http === 401)) { S.err = 'Database non raggiungibile: ' + e.message; return; } S.sess = null; }
    } else if (S.sess && S.sess.role) { msg = 'Sei collegato come operatore: per il portale serve l’account amministratore.'; S.sess = null; }
    await domReady;
    await loginUi(msg);
    try { await pull(); } catch (e) { S.err = 'Database non raggiungibile: ' + e.message + (e.http === 404 ? ' (manca la tabella portale_doc: esegui lo script SQL)' : ''); }
  })();
  /* ---------- tempo reale: le modifiche degli altri arrivano subito; se il canale non si apre, resta il controllo periodico ---------- */
  const RT = { ws: null, live: false, ref: 0, hb: null, wait: 1000, timer: null, tok: '' };
  const rtSend = (topic, event, payload) => { if (RT.ws && RT.ws.readyState === 1) RT.ws.send(JSON.stringify({ topic: topic, event: event, payload: payload, ref: String(++RT.ref), join_ref: topic === 'phoenix' ? undefined : '1' })); };
  let rtPull = null;
  function rtOpen() {
    if (!S.sess || typeof WebSocket === 'undefined' || (RT.ws && RT.ws.readyState <= 1)) return;
    if (Date.now() > S.sess.exp) { refresh().then(rtOpen, () => {}); return; }
    let ws;
    try { ws = new WebSocket(SUPABASE_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + enc(SUPABASE_KEY) + '&vsn=1.0.0'); } catch (e) { return; }
    RT.ws = ws;
    ws.onopen = () => {
      RT.tok = S.sess.token;
      rtSend('realtime:portale', 'phx_join', { config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: '*', schema: 'public', table: T }] }, access_token: S.sess.token });
      clearInterval(RT.hb); RT.hb = setInterval(() => rtSend('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = (m) => {
      let x; try { x = JSON.parse(m.data); } catch (e) { return; }
      if (x.event === 'phx_reply' && x.topic === 'realtime:portale') {
        const ok = x.payload && x.payload.status === 'ok';
        if (ok && !RT.live) { RT.live = true; RT.wait = 1000; status(); pullQuiet(); }
        if (!ok && x.payload && x.payload.response && x.payload.response.reason) { RT.live = false; status(); }
      } else if (x.event === 'postgres_changes') {
        clearTimeout(rtPull); rtPull = setTimeout(pullQuiet, 300);   /* più modifiche insieme: una sola lettura */
      } else if (x.event === 'phx_error' || x.event === 'phx_close' || (x.event === 'system' && x.payload && x.payload.status === 'error')) {
        RT.live = false; status();
      }
    };
    ws.onclose = () => {
      clearInterval(RT.hb); const was = RT.live; RT.live = false; RT.ws = null; if (was) status();
      clearTimeout(RT.timer); RT.timer = setTimeout(rtOpen, RT.wait); RT.wait = Math.min(RT.wait * 2, 60000);
    };
    ws.onerror = () => { /* chiusura gestita sopra */ };
  }
  /* la sessione si rinnova ogni ora: il canale riceve il nuovo permesso */
  setInterval(() => {
    if (RT.live && S.sess && Date.now() > S.sess.exp - 90000) refresh().catch(() => {});
    if (RT.live && S.sess && S.sess.token !== RT.tok) { RT.tok = S.sess.token; rtSend('realtime:portale', 'access_token', { access_token: S.sess.token }); } }, 30000);
  ready.then(() => { if (S.sess) rtOpen(); });
  let lastPull = 0;
  const pullTimed = () => { lastPull = Date.now(); pullQuiet(); };
  /* con il tempo reale attivo basta un controllo ogni 2 minuti, come rete di sicurezza */
  setInterval(() => { if (!document.hidden && Date.now() - lastPull >= (RT.live ? 120000 : POLL) - 500) pullTimed(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pullTimed(); if (!RT.ws) rtOpen(); } });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act="cloud-logout"]'); if (!b) return;
    try { localStorage.removeItem(LSS); } catch (x) { /* nessuno */ }
    location.reload();
  });

  /* accesso diretto per i pannelli dell'amministratore (backup, registro delle modifiche) */
  window.__cloudApi = {
    email: () => (S.sess ? S.sess.email : ''),
    rpc: async (name, args) => (await api('rpc/' + name, { method: 'POST', body: JSON.stringify(args || {}) })).json(),
    select: async (path) => (await api(path)).json(),
    invoke: async (fn, body) => {
      if (Date.now() > S.sess.exp) await refresh();
      const r = await fetch(SUPABASE_URL + '/functions/v1/' + fn, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + S.sess.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.errore || j.message || ('errore ' + r.status));
      return j;
    }
  };
  window.claude = { use: async (n) => { if (n === 'db') { await ready; return db; } return n === 'downloads' ? dl : null; } };
  window.__localDb = {
    cloud: true, FILE: 'database online', BACKUP: '', supported: () => false, onStatus: (f) => { listeners.add(f); },
    attach: async () => true, detach: () => {}, parseText: parseText, exportText: exportText, replace: replaceAll,
    info: () => ({ linked: !!S.sess, perm: 'granted', err: S.err, fileAt: S.at, pending: false, count: store.size, email: S.sess ? S.sess.email : '' }),
    chip: () => S.err ? { s: 'off', t: 'Database non raggiungibile' } : { s: 'on', t: 'Online' + (RT.live ? ' · in tempo reale' : '') + (S.sess && S.sess.email ? ' · ' + S.sess.email : '') },
    live: () => RT.live,
    readFile: async (name) => name === 'produzione.json' ? prodJson() : { ok: false, why: 'missing' }
  };
})();
