/* VERSIONE LOCALE. Se la pagina non gira dentro Claude, offre lo stesso "database" e lo salva nel file
   dati-collaudi.json della cartella collegata (più una copia nel browser). Nessun dato esce dal computer. */
(function () {
  'use strict';
  if (window.claude && typeof window.claude.use === 'function') return;
  const FILE = 'dati-collaudi.json', BACKUP = 'Backup dati', KEY = 'collaudi-seriali:dati';
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const nowIso = () => new Date().toISOString();
  const p2 = (n) => String(n).padStart(2, '0');
  const dayStr = () => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
  const stampStr = () => { const d = new Date(); return dayStr() + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()); };
  const supported = () => typeof window.showDirectoryPicker === 'function';
  const store = new Map(), subs = new Set(), listeners = new Set();
  const L = { dir: null, perm: 'none', savedAt: null, fileAt: null, pending: false, err: '', noWrite: false };
  const status = () => listeners.forEach((f) => { try { f(); } catch (e) { /* nessuno */ } });
  const notify = () => Array.from(subs).forEach((s) => s());

  /* ---------- formato del file ---------- */
  function exportObj() {
    const dati = {};
    store.forEach((v, p) => { const i = p.indexOf('/'); if (i < 0 || p.indexOf('/', i + 1) >= 0) return; (dati[p.slice(0, i)] = dati[p.slice(0, i)] || {})[p.slice(i + 1)] = v; });
    return { formato: 'collaudi-seriali', versione: 1, salvato: L.savedAt, dati: dati };
  }
  const toText = () => JSON.stringify(exportObj(), null, 2);
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
    return { salvato: typeof o.salvato === 'string' ? o.salvato : null, map: m, counts: { matricole: cnt('serials'), ordini: cnt('orders'), collaudi: cnt('events'), lotti: cnt('runs') } };
  }
  const canon = (x) => (x && typeof x === 'object') ? (Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}') : JSON.stringify(x);
  const sameAs = (map) => canon(exportObj().dati) === canon((() => { const d = {}; map.forEach((v, p) => { const i = p.indexOf('/'); (d[p.slice(0, i)] = d[p.slice(0, i)] || {})[p.slice(i + 1)] = v; }); return d; })());

  /* ---------- copia nel browser ---------- */
  function mirrorSave() { try { localStorage.setItem(KEY, JSON.stringify({ salvato: L.savedAt, pending: L.pending, dati: exportObj().dati })); } catch (e) { /* browser senza memoria */ } }
  function mirrorLoad() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!o || !o.dati) return;
      L.savedAt = o.salvato || null; L.pending = !!o.pending;
      Object.keys(o.dati).forEach((c) => Object.keys(o.dati[c]).forEach((id) => store.set(c + '/' + id, o.dati[c][id])));
    } catch (e) { /* copia illeggibile: si riparte da zero */ }
  }

  /* ---------- scrittura del file ---------- */
  let timer = null, chain = Promise.resolve();
  async function writeNow() {
    if (!L.dir || L.perm !== 'granted' || L.noWrite) return;
    const at = L.savedAt;
    try {
      const w = await (await L.dir.getFileHandle(FILE, { create: true })).createWritable();
      await w.write(toText()); await w.close();
      L.fileAt = nowIso(); if (L.savedAt === at) L.pending = false; L.err = ''; mirrorSave();
    } catch (e) {
      L.err = 'Non riesco a scrivere ' + FILE + ' (' + ((e && (e.message || e.name)) || 'errore') + ')';
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError')) L.perm = 'prompt';
    }
    status();
  }
  const scheduleFile = () => { if (!L.dir || L.perm !== 'granted' || L.noWrite) return; clearTimeout(timer); timer = setTimeout(() => { chain = chain.then(writeNow, writeNow); }, 250); };
  async function backupFile(name, txt) {
    try {
      const d = await L.dir.getDirectoryHandle(BACKUP, { create: true });
      try { await d.getFileHandle(name); return; } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
      const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(txt); await w.close();
    } catch (e) { /* la copia di sicurezza è un di più */ }
  }
  function touch() { L.savedAt = nowIso(); if (L.dir && !L.noWrite) L.pending = true; mirrorSave(); notify(); scheduleFile(); status(); }
  function setStore(map, savedAt) { store.clear(); map.forEach((v, k) => store.set(k, clone(v))); L.savedAt = savedAt; mirrorSave(); notify(); }

  /* ---------- cartella ---------- */
  async function attach(root) {
    L.dir = root; L.err = ''; L.noWrite = false;
    try {
      L.perm = await root.queryPermission({ mode: 'readwrite' });
      if (L.perm !== 'granted') { status(); return false; }
      let txt = null;
      try { txt = await (await (await root.getFileHandle(FILE)).getFile()).text(); } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
      if (txt == null) { await writeNow(); status(); return true; }          // nessun file: lo creo con i dati attuali
      let parsed; try { parsed = parseText(txt); } catch (e) { L.err = FILE + ' ' + e.message + ': non lo sovrascrivo.'; L.noWrite = true; status(); return false; }
      await backupFile('dati-collaudi-' + dayStr() + '.json', txt);          // una copia al giorno, prima di toccare qualcosa
      if (L.pending && store.size) {                                          // modifiche fatte mentre il file non era raggiungibile: vincono quelle
        await backupFile('dati-collaudi-prima-' + stampStr() + '.json', txt);
        await writeNow();
      } else {
        if (store.size && !sameAs(parsed.map)) await backupFile('browser-' + stampStr() + '.json', toText());
        setStore(parsed.map, parsed.salvato); L.pending = false; L.fileAt = parsed.salvato; mirrorSave();
      }
      status(); return true;
    } catch (e) { L.err = 'Cartella dati non raggiungibile (' + ((e && (e.message || e.name)) || 'errore') + ')'; status(); return false; }
  }
  function detach() { L.dir = null; L.perm = 'none'; L.err = ''; L.noWrite = false; L.pending = false; mirrorSave(); status(); }

  function idbGet() {
    return new Promise((res) => {
      let q; try { q = indexedDB.open('collaudi-seriali', 1); } catch (e) { res(null); return; }
      q.onupgradeneeded = () => { q.result.createObjectStore('kv'); };
      q.onerror = () => res(null);
      q.onsuccess = () => { const db = q.result; try { const r = db.transaction('kv', 'readonly').objectStore('kv').get('root'); r.onsuccess = () => { db.close(); res(r.result || null); }; r.onerror = () => { db.close(); res(null); }; } catch (e) { db.close(); res(null); } };
    });
  }

  /* ---------- "database" con la stessa interfaccia usata dalla pagina ---------- */
  const snapDoc = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.has(p) ? Object.freeze(clone(store.get(p))) : undefined });
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
      get: async () => snapDoc(path),
      set: async (d) => { store.set(path, clone(d)); touch(); },
      update: async (d) => { store.set(path, Object.assign(clone(store.get(path) || {}), clone(d))); touch(); },
      delete: async () => { store.delete(path); touch(); },
      onSnapshot(next) { const s = () => next(snapDoc(path)); subs.add(s); setTimeout(s, 0); return () => subs.delete(s); }
    }),
    collection: (col) => Object.assign(mkQuery(col), { add: async (d) => { const id = newId(); store.set(col + '/' + id, clone(d)); touch(); return { id: id }; } })
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

  mirrorLoad();
  const ready = (async () => {
    try { const h = await idbGet(); if (h && h.kind === 'directory') { L.dir = h; await attach(h); } } catch (e) { /* si parte dal browser */ }
  })();
  window.claude = { use: async (n) => { if (n === 'db') { await Promise.race([ready, new Promise((r) => setTimeout(r, 2500))]); return db; } return n === 'downloads' ? dl : null; } };

  window.__localDb = {
    FILE: FILE, BACKUP: BACKUP, supported: supported, onStatus: (f) => { listeners.add(f); },
    attach: attach, detach: detach, parseText: parseText, exportText: toText,
    info: () => ({ linked: !!L.dir, perm: L.perm, err: L.err, fileAt: L.fileAt, pending: L.pending, count: store.size }),
    chip: () => {
      if (L.err) return { s: 'off', t: 'Problema con il file dati' };
      if (L.dir && L.perm === 'granted') return { s: 'on', t: 'Dati salvati in ' + FILE };
      if (L.dir) return { s: 'connecting', t: 'Consenti l’accesso alla cartella' };
      return { s: 'connecting', t: supported() ? 'Dati solo nel browser: collega la cartella' : 'Dati solo nel browser' };
    },
    readFile: async (name) => {
      if (!L.dir || L.perm !== 'granted') return { ok: false, why: L.dir ? 'perm' : 'nodir' };
      try { const f = await (await L.dir.getFileHandle(name)).getFile(); return { ok: true, text: await f.text(), at: f.lastModified }; }
      catch (e) { return { ok: false, why: e && e.name === 'NotFoundError' ? 'missing' : 'err', msg: (e && (e.message || e.name)) || '' }; }
    },
    replace: async (parsed) => {
      if (L.dir && L.perm === 'granted') await backupFile('prima-del-caricamento-' + stampStr() + '.json', toText());
      store.clear(); parsed.map.forEach((v, k) => store.set(k, clone(v))); touch();
    }
  };
})();
