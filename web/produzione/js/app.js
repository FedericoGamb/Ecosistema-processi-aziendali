const $ = s => document.querySelector(s);
/* ===== CONFIGURAZIONE ONLINE (Supabase): valori in shared/js/config.js, vedi README. Se mancano il programma lavora in locale ===== */
const SUPABASE_URL = (window.APP_CONFIG || {}).supabaseUrl || "";
const SUPABASE_KEY = (window.APP_CONFIG || {}).supabaseKey || "";
/* PROVA ECOSISTEMA: true = lavora in locale nella stessa cartella del portale Collaudi e Seriali (Supabase spento).
   Per tornare online rimetti false: i campi nuovi dei prodotti (ritmo, postazioni, matricola) online non sono ancora salvati. */
const PROVA_LOCALE = false;
const CLOUD = !PROVA_LOCALE && !!(SUPABASE_URL && SUPABASE_KEY);
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const LS = "produzione-data-v1";
let data = {operatori:[],prodotti:[],scarti:[],fermi:[],registrazioni:[]};
let role = null, dir = null;
const canViewReports = r => r === "admin";
let notificationTimer;
function showSuccess(message) {
  clearTimeout(notificationTimer);
  const box = $("#successAlert");
  box.innerHTML = `<span class="check" aria-hidden="true">✓</span><div><strong>Registrazione aggiunta</strong><span>${esc(message)}</span>${role === "operatore" && lastGet() ? `<button type="button" class="corr-go" style="margin-top:8px;background:#fff;color:var(--ok);border:0;border-radius:6px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer">Correggi</button>` : ""}</div><button type="button" aria-label="Chiudi conferma">×</button>`;
  const cg = box.querySelector(".corr-go"); if (cg) cg.onclick = () => { box.classList.add("hidden"); box.replaceChildren(); corrStart(); };
  box.classList.remove("hidden");
  box.querySelector("button").onclick = () => { clearTimeout(notificationTimer); box.classList.add("hidden"); box.replaceChildren(); };
  notificationTimer = setTimeout(() => { box.classList.add("hidden"); box.replaceChildren(); }, 6000);
}

/* ---------- IndexedDB per ricordare la cartella ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("produzione", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const kvSet = async (k, v) => { const db = await idb(); db.transaction("kv", "readwrite").objectStore("kv").put(v, k); };
const kvGet = async k => { const db = await idb(); return new Promise(r => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); };

/* ---------- Salvataggio ---------- */
async function readFolder() {
  try {
    const fh = await dir.getFileHandle("produzione.json", {create: false});
    const txt = await (await fh.getFile()).text();
    data = {...data, ...JSON.parse(txt)};
  } catch { await writeFolder(); }
}
async function writeFolder() {
  if (!dir) return;
  const fh = await dir.getFileHandle("produzione.json", {create: true});
  const w = await fh.createWritable(); await w.write(JSON.stringify(data, null, 2)); await w.close();
  const ch = await dir.getFileHandle("registrazioni.csv", {create: true});
  const w2 = await ch.createWritable(); await w2.write("\ufeff" + csv()); await w2.close();
  const eh = await dir.getFileHandle("ERP_scarti_fermi.xlsx", {create: true});
  const w3 = await eh.createWritable(); await w3.write(erpXlsx(data.registrazioni)); await w3.close();
}
async function save() {
  localStorage.setItem(LS, JSON.stringify(data));
  if (CLOUD) { render(); cloudStatus(); pushCloud(); return; }
  try { await writeFolder(); if (dir) folderStatus("ok", dir.name); } catch (e) { folderStatus("err", dir && dir.name); alert("Impossibile salvare nella cartella: ricollega la cartella.\n" + e.message); }
  render();
}
function fsDiag() {
  if (window.showDirectoryPicker) return "";
  const ua = navigator.userAgent, m = ua.match(/(EdgA|Edg|Chrome|CriOS|SamsungBrowser|Firefox|FxiOS)\/(\d+)/), br = m ? m[1] + " " + m[2] : "sconosciuto";
  if (!window.isSecureContext) return `La pagina non è aperta da un indirizzo sicuro (indirizzo attuale: ${location.protocol}//…). Aprila da un indirizzo che inizia con https://\nBrowser rilevato: ${br}`;
  if (/; wv\)/.test(ua) || /FB_IAB|Instagram|Line\//.test(ua)) return `La pagina è aperta dentro un'altra app. Copia l'indirizzo e aprilo direttamente in Chrome.\nBrowser rilevato: ${br}`;
  if (/SamsungBrowser|Firefox|FxiOS|CriOS/.test(ua) || (/Safari\//.test(ua) && !/Chrome\/|EdgA|Edg\//.test(ua))) return `Questo browser non permette di collegare le cartelle: serve Chrome o Edge.\nBrowser rilevato: ${br}`;
  return `Il browser non offre il collegamento alle cartelle: su tablet Android serve Chrome o Edge versione 132 o successiva (aggiornalo dal Play Store).\nBrowser rilevato: ${br}`;
}
function folderStatus(state, name = "") {
  if (CLOUD) return;
  if (state === "none" && !window.showDirectoryPicker) state = "local";
  let t = {ok: ["Cartella collegata correttamente", `I dati vengono salvati in «${name}»`],
    need: ["Cartella scollegata: riattiva l'accesso", `Premi «Riattiva accesso» per tornare a salvare in «${name}»`],
    err: ["Salvataggio nella cartella non riuscito: ricollega la cartella", "Controlla che la cartella esista ancora, poi premi «Ricollega cartella»"],
    local: ["Dati salvati solo in questo browser", "Questo dispositivo non può collegare una cartella: scarica il backup a fine turno per non perdere i dati"],
    none: ["Cartella non collegata: collega la cartella", "Finché non la colleghi, i dati restano solo in questo browser"]}[state];
  
  $("#folderBox").dataset.state = state; $("#fstat").textContent = t[0]; $("#fsub").textContent = t[1];
  $("#pick").textContent = state === "ok" ? "Cambia cartella" : state === "err" ? "Ricollega cartella" : "Collega cartella";
  $("#reauth").classList.toggle("hidden", state !== "need"); $("#pick").classList.toggle("hidden", state === "local");
}
document.addEventListener("visibilitychange", async () => { if (!dir || document.hidden) return; try { if (await dir.queryPermission({mode: "readwrite"}) !== "granted") folderStatus("need", dir.name); } catch { folderStatus("err", dir.name); } });
async function connect(h) { dir = h; await readFolder(); folderStatus("ok", h.name); render(); if (page === "collaudi") ecoLoad(); }

$("#pick").onclick = async () => {
  if (CLOUD) return syncNow();
  if (!window.showDirectoryPicker) return alert(fsDiag());
  try { const h = await window.showDirectoryPicker({mode: "readwrite"}); await kvSet("dir", h); await connect(h); } catch {}
};
$("#reauth").onclick = async () => { const h = await kvGet("dir"); if (h && await h.requestPermission({mode: "readwrite"}) === "granted") connect(h); };

function setLogo(src) { document.querySelectorAll("[data-logo]").forEach(e => e.innerHTML = `<img src="${src}" alt="Logo">`); }

/* ---------- Online (Supabase) ---------- */
const LSS = "produzione-sessione", LSY = "produzione-sincronizzati", KEYS = ["operatori", "prodotti", "scarti", "fermi", "registrazioni"];
let sess = null, pushing = false;
const synced = Object.fromEntries(KEYS.map(k => [k, new Set()]));
const isAdm = () => !!sess && sess.role === "admin";
const cols = () => KEYS.filter(k => isAdm() || k === "registrazioni");
const pendingOf = k => data[k].filter(x => !synced[k].has(x.id));
const delOf = k => { const have = new Set(data[k].map(x => x.id)); return [...synced[k]].filter(id => !have.has(id)); };
const cloudPending = () => cols().reduce((n, k) => n + pendingOf(k).length + delOf(k).length, 0);
const saveSync = () => { try { localStorage.setItem(LSY, JSON.stringify(Object.fromEntries(KEYS.map(k => [k, [...synced[k]]])))); } catch {} };
function loadSess() { try { sess = JSON.parse(localStorage.getItem(LSS)); const y = JSON.parse(localStorage.getItem(LSY)) || {}; KEYS.forEach(k => synced[k] = new Set(y[k] || [])); } catch { sess = null; } }
async function auth(grant, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {method: "POST", headers: {apikey: SUPABASE_KEY, "Content-Type": "application/json"}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || j.message || "errore " + r.status), {http: r.status, auth: true});
  const u = j.user || {};
  sess = {token: j.access_token, refresh: j.refresh_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000, role: (u.app_metadata && u.app_metadata.ruolo) || "", email: u.email || ""};
  localStorage.setItem(LSS, JSON.stringify(sess));
}
let refreshing = null;
const refresh = () => { try { const s2 = JSON.parse(localStorage.getItem(LSS)); if (s2 && s2.token && sess && s2.token !== sess.token && s2.exp > Date.now() + 30000) { sess = s2; return Promise.resolve(); } } catch {} return refreshing || (refreshing = auth("refresh_token", {refresh_token: sess.refresh}).finally(() => { refreshing = null; })); };
async function api(path, opts = {}, retry = true) {
  if (Date.now() > sess.exp) await refresh();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {...opts, headers: {apikey: SUPABASE_KEY, Authorization: "Bearer " + sess.token, "Content-Type": "application/json", ...opts.headers}});
  if (r.status === 401 && retry) { await refresh(); return api(path, opts, false); }
  if (!r.ok) { const raw = await r.text().catch(() => ""); let m = raw; try { m = JSON.parse(raw).message || raw; } catch {} throw Object.assign(new Error((m || "errore " + r.status).slice(0, 160)), {http: r.status}); }
  return r;
}
/* Nel database il reparto di prodotti, cause di scarto e operatori sta nel secondo campo, con prefisso "stampaggio::", "officina::" (e, solo per gli operatori, "entrambi::"): nessuna colonna in più. */
const REPTAG = /^(stampaggio|officina|entrambi)::([\s\S]*)$/;
const toRow = (k, x) => k === "registrazioni" ? {id: x.id, ts: x.ts, operatore: x.operatore, prodotto: x.prodotto, tipo: x.tipo, causa: x.causa || "", pezzi: x.pezzi ?? null, durata_sec: x.durataSec ?? null} : Object.assign({id: x.id, tipo: k, a: x.a, b: CON_REP(k) && x.reparto ? x.reparto + "::" + x.b : x.b}, k === "prodotti" ? {ritmo: Number(x.ritmo) > 0 ? Number(x.ritmo) : null, postazioni: Number.isInteger(x.postazioni) ? x.postazioni : null, matricola: x.matricola || null} : {});
const fromAna = (k, x) => { const m = CON_REP(k) && REPTAG.exec(x.b); const o = m && REP_VALIDI(k).includes(m[1]) ? {id: x.id, a: x.a, b: m[2], reparto: m[1]} : {id: x.id, a: x.a, b: x.b}; if (k === "prodotti") { if (x.ritmo != null && Number(x.ritmo) > 0) o.ritmo = Number(x.ritmo); if (x.postazioni != null) o.postazioni = Number(x.postazioni); if (x.matricola) o.matricola = x.matricola; } return o; };
const fromReg = r => { const o = {id: r.id, ts: new Date(r.ts).toISOString(), operatore: r.operatore, prodotto: r.prodotto, tipo: r.tipo, causa: r.causa || ""}; if (r.pezzi != null) o.pezzi = r.pezzi; if (r.durata_sec != null) o.durataSec = r.durata_sec; return o; };
async function getAll(table, order) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    let rows;
    try { rows = await (await api(`${table}?select=*&order=${order}`, {headers: {"Range-Unit": "items", Range: `${from}-${from + 999}`}})).json(); }
    catch (e) { if (e.http === 416) break; throw e; }
    out = out.concat(rows); if (rows.length < 1000) break;
  }
  return out;
}
async function pullCloud() {
  const adm = isAdm(), ana = await getAll("anagrafica", "creato.asc,id.asc"), srv = {registrazioni: adm ? (await getAll("registrazioni", "id")).map(fromReg) : []};
  KEYS.slice(0, 4).forEach(k => srv[k] = ana.filter(x => x.tipo === k).map(x => fromAna(k, x)));
  KEYS.forEach(k => { const have = new Set(srv[k].map(x => x.id)), pend = adm || k === "registrazioni" ? data[k].filter(x => !synced[k].has(x.id) && !have.has(x.id)) : []; data[k] = [...srv[k], ...pend]; synced[k] = have; });
  data.registrazioni.sort((a, b) => b.ts.localeCompare(a.ts));
  localStorage.setItem(LS, JSON.stringify(data)); saveSync();
}
/* Inserimento semplice (il ruolo reparto non può usare ON CONFLICT). Un doppione dà 409: si riprova riga per riga e quelle già presenti valgono come inviate. */
async function postRows(table, rows) {
  const send = part => api(table, {method: "POST", headers: {Prefer: "return=minimal"}, body: JSON.stringify(part)});
  try { await send(rows); }
  catch (e) {
    if (e.http !== 409) throw e;
    if (rows.length === 1) return;
    for (const row of rows) { try { await send([row]); } catch (e2) { if (e2.http !== 409) throw e2; } }
  }
}
let pushP = null;
const pushCloud = () => pushP || (pushP = pushLoop().finally(() => { pushP = null; }));
async function pushLoop() {
  if (!sess) return;
  for (let round = 0; round < 6; round++) {
    let err = "";
    for (const k of cols()) {
      const table = k === "registrazioni" ? "registrazioni" : "anagrafica";
      try {
        const add = pendingOf(k), del = delOf(k);
        for (let i = 0; i < add.length; i += 200) { const part = add.slice(i, i + 200); await postRows(table, part.map(x => toRow(k, x))); part.forEach(x => synced[k].add(x.id)); saveSync(); }
        for (let i = 0; i < del.length; i += 50) { const part = del.slice(i, i + 50); await api(`${table}?id=in.(${part.join(",")})`, {method: "DELETE"}); part.forEach(id => synced[k].delete(id)); saveSync(); }
      } catch (e) { err = e.auth || e.http === 401 ? "Sessione scaduta: esci e accedi di nuovo" : e instanceof TypeError ? "connessione assente" : e.message; }
    }
    cloudStatus(err);
    if (err || !cloudPending()) return;
  }
}
function cloudStatus(err = "") {
  const n = cloudPending(), st = err ? "err" : n ? "need" : "ok", fm = n === 1 ? "1 elemento" : n + " elementi", exp = err.startsWith("Sessione scaduta");
  const t = {ok: ["Collegato al database", "Dati sincronizzati alle " + new Date().toLocaleTimeString("it-IT", {hour: "2-digit", minute: "2-digit"})],
    need: ["Invio in corso", fm + " da inviare al database"],
    err: [exp ? "Sessione scaduta" : "Database non raggiungibile: riprovo da solo", (n ? fm + " da inviare. " : "") + err]}[st];
  $("#folderBox").dataset.state = st; $("#fstat").textContent = t[0]; $("#fsub").textContent = t[1];
  $("#pick").textContent = "Aggiorna dati"; $("#pick").classList.remove("hidden"); $("#reauth").classList.add("hidden");
}
async function syncNow(quiet) {
  try { await pushCloud(); await pullCloud(); cloudStatus(); } catch (e) { cloudStatus(e.message); }
  const busy = role === "operatore" ? opBusy() : page !== "report";
  if (!quiet || !busy) render();
}
async function cloudLogin() {
  const err = $("#lerr"); err.textContent = "";
  try { await auth("password", {email: $("#u").value.trim(), password: $("#pw").value}); }
  catch (e) { return err.textContent = e.auth && [400, 401, 422].includes(e.http) ? "Credenziali non valide" : "Impossibile collegarsi al database: " + e.message; }
  const out = m => { sess = null; localStorage.removeItem(LSS); err.textContent = m; };
  if (!["admin", "operatore"].includes(sess.role)) return out("Utente senza ruolo assegnato: vedi il README");
  try { await pullCloud(); } catch (e) { return out("Accesso riuscito, ma la lettura dei dati non è riuscita: " + e.message + " (hai eseguito lo script SQL?)"); }
  cloudStatus(); start(sess.role); pushCloud();
}

/* ---------- Login ---------- */
function login(u, p) { if (u === "admin" && p === "1234") return "admin"; if (u === "user" && p === "1234") return "operatore"; return null; }
$("#loginForm").onsubmit = e => { e.preventDefault(); if (CLOUD) return cloudLogin(); const r = login($("#u").value.trim(), $("#pw").value); if (!r) return $("#lerr").textContent = "Credenziali non valide"; sessionStorage.setItem("ruolo", r); start(r); };
$("#logout").onclick = async () => {
  if (role === "operatore" && !(await dialog({title: "Vuoi uscire?", html: `<p style="margin:0">${CLOUD ? "Dovrai inserire di nuovo email e password del reparto." : "Dovrai inserire di nuovo utente e password."}</p>`, ok: "Esci", cancel: "Resta", focus: "cancel"}))) return;
  if (CLOUD) { const n = cloudPending(); if (n && !confirm(`Ci sono ${n} elementi non ancora inviati al database: verranno inviati al prossimo accesso.\nUscire comunque?`)) return; if (!n) { localStorage.removeItem(LS); localStorage.removeItem(LSY); } localStorage.removeItem(LSS); }
  sessionStorage.removeItem("ruolo"); location.reload();
};
function start(r) {
  role = r; document.body.classList.toggle("adm", r === "admin");
  themeP(); $("#themeBtn").onclick = () => themeP(true);
  const hp = location.hash.slice(1); if (["setup", "report", "collaudi"].includes(hp)) page = hp;
  if (CLOUD && r === "admin" && !$("#navPortal")) $("#nav").insertAdjacentHTML("beforeend", `<span class="navsep" id="navPortal"></span><span class="navlbl">Collaudi e Seriali</span>${[["calendario", "Calendario"], ["ordini", "Ordini"], ["lotto", "Crea file"], ["matricole", "Matricole"], ["storico", "Storico"]].map(([v, t]) => `<a class="nv" href="./collaudi/#${v}">${t}</a>`).join("")}`); $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#who").textContent = (r === "admin" ? "Amministratore" : "Operatore") + " · " + new Date().toLocaleDateString("it-IT", {weekday:"long",day:"numeric",month:"long",year:"numeric"});
  render();
}

/* ---------- Utility ---------- */
const fmt = (sec = 0) => { const p = n => String(n).padStart(2, "0"); return `${p(Math.floor(sec/3600))}:${p(Math.floor(sec%3600/60))}:${p(sec%60)}`; };
const iso = d => d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
function csv(list = data.registrazioni) {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Data/Ora","Tipo","Operatore","Prodotto","Causa","Pezzi","Durata (hh:mm:ss)"];
  return [head.map(q).join(";"), ...list.map(r => [new Date(r.ts).toLocaleString("it-IT"), r.tipo, r.operatore, r.prodotto, r.causa, r.pezzi ?? "", r.tipo === "Fermo" ? fmt(r.durataSec) : ""].map(q).join(";"))].join("\n");
}
let tipoF = "";
let reportMode = "summary", page = "setup";
function filtro() {
  const d = $("#fd").value, a = $("#fa").value, o = $("#fo").value, p = $("#fp").value, c = $("#fc").value, rp = $("#fr").value;
  const list = data.registrazioni.filter(r => {
    const g = iso(new Date(r.ts));
    if (d && g < d) return false; if (a && g > a) return false;
    if (tipoF && r.tipo !== tipoF) return false;
    if (o && r.operatore !== o) return false; if (p && r.prodotto !== p) return false;
    if (rp && repOf(r.prodotto) !== rp) return false;
    if (c && r.causa !== c) return false;
    return true;
  });
  return {list, attivo: !!(d || a || o || p || c || rp || tipoF)};
}
function filtroBase() { const t = tipoF; tipoF = ""; const f = filtro(); tipoF = t; return f.list; }
const stamp = () => { const p = [$("#fd").value && "dal_" + $("#fd").value, $("#fa").value && "al_" + $("#fa").value].filter(Boolean).join("_"); return (p ? p + "_" : "") + new Date().toISOString().slice(0,10); };
const dl = (blob, name) => { if (!canViewReports(role)) return; const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };

/* ---------- Writer XLSX (senza librerie, funziona offline) ---------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = -1; for (const b of u) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const [name, txt] of files) {
    const n = enc.encode(name), d = enc.encode(txt), c = crc32(d);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint32(14, c, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    parts.push(h, n, d);
    const e = new DataView(new ArrayBuffer(46)); e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x800, true); e.setUint32(16, c, true); e.setUint32(20, d.length, true); e.setUint32(24, d.length, true); e.setUint16(28, n.length, true); e.setUint32(42, off, true);
    cen.push(e, n); off += 30 + n.length + d.length;
  }
  const size = cen.reduce((s, x) => s + x.byteLength, 0), z = new DataView(new ArrayBuffer(22));
  z.setUint32(0, 0x06054b50, true); z.setUint16(8, files.length, true); z.setUint16(10, files.length, true); z.setUint32(12, size, true); z.setUint32(16, off, true);
  return new Blob([...parts, ...cen, z], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
function xlsx(sheets) {
  const x = v => String(v ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const col = i => { let s = ""; i++; while (i) { s = String.fromCharCode(65 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheet = rows => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri+1}">${r.map((v, ci) => { const ref = col(ci) + (ri+1), st = ri ? "" : ' s="1"'; return typeof v === "number" ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t>${x(v)}</t></is></c>`; }).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const f = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i+1}.xml`, sheet(s.rows)]),
  ];
  return zip(f);
}
/* Reparti: prodotti e cause di scarto hanno il reparto "stampaggio" o "officina"; gli operatori anche "entrambi" (campo opzionale: gli elementi vecchi senza reparto compaiono in tutti i reparti) */
const REPARTI = [["stampaggio", "Stampaggio"], ["officina", "Officina"]];
const CON_REP = k => k === "prodotti" || k === "scarti" || k === "operatori";
const REP_OPZ = k => k === "operatori" ? [...REPARTI, ["entrambi", "Entrambi"]] : REPARTI;
const REP_VALIDI = k => REP_OPZ(k).map(r => r[0]);
const repName = k => (REP_OPZ("operatori").find(r => r[0] === k) || [])[1] || "";
const opInRep = (x, rep) => !x.reparto || x.reparto === "entrambi" || x.reparto === rep;
const repOf = label => (data.prodotti.find(p => p.a + " " + p.b === label) || {}).reparto || "";
/* Separa codice e descrizione salvati come "CODICE descrizione" */
const split = (txt, list) => { const it = list.find(i => i.a + " " + i.b === txt); if (it) return [it.a, it.b]; const k = String(txt).indexOf(" "); return k < 0 ? [txt, ""] : [txt.slice(0, k), txt.slice(k + 1)]; };
const dataIt = r => new Date(r.ts).toLocaleDateString("it-IT"), oraIt = r => new Date(r.ts).toLocaleTimeString("it-IT");
function reportXlsx(list) {
  return xlsx([{name: "Report", rows: [["Data","Ora","Tipo","Operatore","Codice prodotto","Descrizione prodotto","Causa","Pezzi","Durata (hh:mm:ss)","Durata (minuti)"],
    ...list.map(r => [dataIt(r), oraIt(r), r.tipo, r.operatore, ...split(r.prodotto, data.prodotti), r.causa, r.pezzi ?? "", r.tipo === "Fermo" ? fmt(r.durataSec) : "", r.tipo === "Fermo" ? Math.round(r.durataSec / 6) / 10 : ""])]}]);
}
function erpXlsx(list) {
  const sc = list.filter(r => r.tipo === "Scarto"), fe = list.filter(r => r.tipo === "Fermo");
  return xlsx([
    {name: "Scarti", rows: [["Data","Ora","Operatore","Codice prodotto","Descrizione prodotto","Codice causa scarto","Descrizione causa scarto","Quantita scartata"],
      ...sc.map(r => [dataIt(r), oraIt(r), r.operatore, ...split(r.prodotto, data.prodotti), ...split(r.causa, data.scarti), r.pezzi ?? 0])]},
    {name: "Fermi", rows: [["Data","Ora","Operatore","Codice prodotto","Descrizione prodotto","Codice causa fermo","Descrizione causa fermo","Durata (hh:mm:ss)","Durata (secondi)","Durata (minuti)"],
      ...fe.map(r => [dataIt(r), oraIt(r), r.operatore, ...split(r.prodotto, data.prodotti), ...split(r.causa, data.fermi), fmt(r.durataSec), r.durataSec || 0, Math.round((r.durataSec || 0) / 6) / 10])]},
  ]);
}
const prodList = () => filtroBase().filter(r => r.tipo === "Produzione");
/* Codice Articolo e Pezzi per primi e vicini: il file si importa così com'è */
const PROD_HEAD = ["Codice Articolo", "Pezzi", "Descrizione", "Data", "Ora", "Operatore"];
const prodRow = r => { const [c, d] = split(r.prodotto, data.prodotti); return [c, Number(r.pezzi) || 0, d, dataIt(r), oraIt(r), r.operatore]; };
function prodCsv(list) {
  const q = v => typeof v === "number" ? String(v) : `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [PROD_HEAD.map(q).join(";"), ...list.map(r => prodRow(r).map(q).join(";"))].join("\r\n") + "\r\n";
}
const prodXlsx = list => xlsx([{name: "Produzione", rows: [PROD_HEAD, ...list.map(prodRow)]}]);
$("#exp").onclick = () => dl(new Blob(["\ufeff" + prodCsv(prodList())], {type: "text/csv;charset=utf-8"}), `produzione_${stamp()}.csv`);
$("#expx").onclick = () => dl(prodXlsx(prodList()), `produzione_${stamp()}.xlsx`);
$("#erp").onclick = () => dl(erpXlsx(filtroBase()), `ERP_scarti_fermi_${stamp()}.xlsx`);
["#fd","#fa","#fo","#fp","#fr","#fc"].forEach(id => $(id).onchange = $(id).oninput = render);
$("#tabs").onclick = e => { const t = e.target.closest("[data-t]"); if (!t) return; tipoF = t.dataset.t; $("#fc").value = ""; document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b === t)); render(); };
$("#clr").onclick = () => { ["#fd","#fa","#fo","#fp","#fr","#fc"].forEach(id => $(id).value = ""); tipoF = ""; document.querySelectorAll(".tab").forEach((b, i) => b.classList.toggle("on", !i)); render(); };
$("#reportMenu").onclick = e => { const button = e.target.closest("[data-report]"); if (!button || !canViewReports(role)) return; reportMode = button.dataset.report; render(); };
$("#chartGroup").onchange = $("#sumGroup").onchange = render;
const LSB = "produzione-last-backup";
function backupStatus() {
  const last = localStorage.getItem(LSB) || "", n = data.registrazioni.filter(r => r.ts > last).length, tot = data.registrazioni.length;
  $("#bkBox").dataset.state = n ? "due" : "ok";
  $("#bkSub").textContent = (last ? `Ultimo backup: ${new Date(last).toLocaleString("it-IT", {dateStyle: "short", timeStyle: "short"})}. ` : "Nessun backup scaricato da questo dispositivo. ")
    + (n ? `${n} registrazion${n === 1 ? "e" : "i"} non ancora nel backup.` : tot ? "Tutte le registrazioni sono nel backup." : "Nessuna registrazione da salvare.");
}
$("#bkExp").onclick = () => {
  const d = new Date(), p2 = n => String(n).padStart(2, "0"), name = `produzione-backup-${iso(d)}-${p2(d.getHours())}${p2(d.getMinutes())}.json`, a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"})); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  localStorage.setItem(LSB, d.toISOString()); backupStatus();
  alert("Backup scaricato: " + name + "\nLo trovi nella cartella Download del dispositivo.");
};
/* ---------- Importazione prodotti da Excel (.xlsx) o CSV ---------- */
async function readXlsx(buf) {
  if (typeof DecompressionStream === "undefined") throw new Error("Questo browser non legge i file Excel: salvalo come CSV e riprova.");
  const u8 = new Uint8Array(buf), dv = new DataView(buf), dec = new TextDecoder();
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("zip");
  const cnt = dv.getUint16(e + 10, true), files = {}; let p = dv.getUint32(e + 16, true);
  for (let i = 0; i < cnt; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip");
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    files[dec.decode(u8.subarray(p + 46, p + 46 + nl))] = {method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true)};
    p += 46 + nl + xl + cl;
  }
  const get = async name => {
    const f = files[name]; if (!f) return null;
    const s0 = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true), raw = u8.subarray(s0, s0 + f.size);
    if (f.method === 0) return dec.decode(raw);
    if (f.method !== 8) throw new Error("zip");
    const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(); w.write(raw); w.close();
    return dec.decode(await new Response(ds.readable).arrayBuffer());
  };
  const xml = t => new DOMParser().parseFromString(t, "application/xml"), tag = (d, n) => [...d.getElementsByTagNameNS("*", n)];
  let sheet = null;
  try {
    const wb = xml(await get("xl/workbook.xml")), rid = tag(wb, "sheet")[0].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const rel = tag(xml(await get("xl/_rels/workbook.xml.rels")), "Relationship").find(r => r.getAttribute("Id") === rid), tg = rel && rel.getAttribute("Target");
    if (tg) sheet = await get(tg.startsWith("/") ? tg.slice(1) : "xl/" + tg);
  } catch (err) { sheet = null; }
  if (!sheet) { const nm = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0]; if (!nm) throw new Error("zip"); sheet = await get(nm); }
  const ss = await get("xl/sharedStrings.xml"), shared = ss ? tag(xml(ss), "si").map(si => tag(si, "t").filter(t => t.parentNode.localName !== "rPh").map(t => t.textContent).join("")) : [];
  return tag(xml(sheet), "row").map(r => { const row = []; tag(r, "c").forEach(c => {
    const col = (c.getAttribute("r") || "").replace(/\d+/g, "").split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, t = c.getAttribute("t"), v = tag(c, "v")[0];
    let val = ""; if (t === "inlineStr") val = tag(c, "t").map(x => x.textContent).join(""); else if (v) val = t === "s" ? (shared[+v.textContent] ?? "") : t === "e" ? "" : v.textContent;
    if (col >= 0) row[col] = val;
  }); return Array.from(row, x => x ?? ""); });
}
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0], delim = [";", "\t", ","].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0], rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function leggiFile(f) {
  const buf = await f.arrayBuffer();
  if (/\.xlsx$/i.test(f.name)) return readXlsx(buf);
  let text; try { text = new TextDecoder("utf-8", {fatal: true}).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
  return parseCsv(text);
}
const repKey = t => { const x = norm(t); return x.startsWith("stamp") ? "stampaggio" : x.startsWith("offic") ? "officina" : ""; };
/* Colonne: codice, descrizione, reparto (facoltativo). La riga di intestazione, se c'è, viene riconosciuta. */
function prodottiDaRighe(rows) {
  rows = rows.map(r => r.map(c => String(c ?? "").trim())).filter(r => r.some(Boolean));
  const h = rows[0] ? rows[0].map(norm) : [], fi = re => h.findIndex(x => re.test(x));
  const hc = fi(/^(cod|code|articolo|sku)/), hd = fi(/^(descr|nome|name|denominaz)/), hr = fi(/^reparto/);
  const conInt = hc >= 0 || hd >= 0 || hr >= 0, ci = hc >= 0 && hd >= 0 ? hc : 0, di = hc >= 0 && hd >= 0 ? hd : 1, ri = hc >= 0 && hd >= 0 ? hr : 2;
  const have = new Set(data.prodotti.map(p => norm(p.a))), seen = new Set(), out = {nuovi: [], esistenti: 0, doppi: 0, invalidi: 0};
  rows.slice(conInt ? 1 : 0).forEach(r => {
    const a = r[ci] || "", b = r[di] || "";
    if (!a || !b || a.length > 40 || b.length > 200) return out.invalidi++;
    if (have.has(norm(a))) return out.esistenti++;
    if (seen.has(norm(a))) return out.doppi++;
    seen.add(norm(a)); out.nuovi.push({a, b, reparto: ri >= 0 ? repKey(r[ri]) : ""});
  });
  return out;
}
async function importProdotti(f) {
  if (role !== "admin" || $("#dlg")) return;
  let rows; try { rows = await leggiFile(f); } catch (e) { return alert(e && /^Questo browser/.test(e.message) ? e.message : "Non riesco a leggere il file. Usa un file Excel (.xlsx) o CSV con codice e descrizione."); }
  const r = prodottiDaRighe(rows);
  if (!r.nuovi.length) return alert(r.esistenti || r.doppi ? "Nessun prodotto nuovo: i codici del file ci sono già." : "Non ho trovato prodotti nel file. Servono due colonne: codice e descrizione (la terza, il reparto, è facoltativa).");
  if (r.nuovi.length > 2000) return alert("Il file ha troppi prodotti: importane al massimo 2000 per volta.");
  const senza = r.nuovi.filter(x => !x.reparto).length, riga = (l, val) => `<dt>${l}</dt><dd>${val}</dd>`;
  const html = `<p style="margin:0" class="mut">File: <b>${esc(f.name)}</b></p><dl class="sum">${riga("Prodotti nuovi", r.nuovi.length)}${r.esistenti ? riga("Già presenti (stesso codice)", r.esistenti) : ""}${r.doppi ? riga("Codici ripetuti nel file", r.doppi) : ""}${r.invalidi ? riga("Righe non valide", r.invalidi) : ""}</dl>`
    + `<table class="pv"><tbody>${r.nuovi.slice(0, 5).map(x => `<tr><td><b>${esc(x.a)}</b></td><td>${esc(x.b)}</td><td class="mut">${x.reparto ? esc(repName(x.reparto)) : "—"}</td></tr>`).join("")}</tbody></table>${r.nuovi.length > 5 ? `<p class="mut" style="margin:0">…e altri ${r.nuovi.length - 5}</p>` : ""}`
    + (senza ? `<label class="fl">Reparto per i ${senza} prodotti senza reparto nel file<select class="field" id="impRep"><option value="">Scegli il reparto…</option>${REPARTI.map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label>` : "");
  let def = "";
  if (!(await dialog({title: "Importa prodotti", html, ok: "Importa", cancel: "Annulla", check: () => { def = $("#impRep") ? $("#impRep").value : ""; return senza && !def ? "Scegli il reparto per i prodotti senza reparto." : ""; }}))) return;
  data.prodotti.push(...r.nuovi.map(x => ({id: uid(), a: x.a, b: x.b, reparto: x.reparto || def})));
  await save(); alert(`Importati ${r.nuovi.length} prodotti.`);
}
$("#bkImp").onclick = () => $("#bkFile").click();
$("#bkFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || role !== "admin") return;
  let inc; try { inc = JSON.parse(await f.text()); } catch { return alert("Il file non è un backup valido."); }
  const L = ["operatori", "prodotti", "scarti", "fermi", "registrazioni"];
  if (!inc || typeof inc !== "object" || !L.some(k => Array.isArray(inc[k]))) return alert("Il file non è un backup valido.");
  const okAna = x => x && typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) && typeof x.a === "string" && typeof x.b === "string";
  const okReg = x => x && typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) && typeof x.ts === "string" && !isNaN(new Date(x.ts)) && ["Produzione", "Scarto", "Fermo"].includes(x.tipo) && typeof x.operatore === "string" && typeof x.prodotto === "string";
  const nuovi = {}, pulisci = (k, x) => { const o = {id: x.id, a: x.a, b: x.b}; if (CON_REP(k) && REP_VALIDI(k).includes(x.reparto)) o.reparto = x.reparto; if (k === "prodotti") { if (Number(x.ritmo) > 0) o.ritmo = Number(x.ritmo); if (Number.isInteger(x.postazioni) && x.postazioni >= 1) o.postazioni = x.postazioni; if (typeof x.matricola === "string" && x.matricola.trim()) o.matricola = x.matricola.trim(); } return o; };
  L.forEach(k => { const have = new Set((data[k] || []).map(x => x.id)); nuovi[k] = (Array.isArray(inc[k]) ? inc[k] : []).filter(x => (k === "registrazioni" ? okReg(x) : okAna(x)) && !have.has(x.id)); if (k !== "registrazioni") nuovi[k] = nuovi[k].map(x => pulisci(k, x)); });
  if (!L.some(k => nuovi[k].length)) return alert("Nessun dato nuovo: tutto quello che c'è nel file è già presente.");
  const riga = `${nuovi.operatori.length} operatori, ${nuovi.prodotti.length} prodotti, ${nuovi.scarti.length} cause di scarto, ${nuovi.fermi.length} cause di fermo, ${nuovi.registrazioni.length} registrazioni`;
  if (!confirm(`Dati nuovi da aggiungere:\n${riga}.\nNulla verrà cancellato. Procedere?`)) return;
  L.forEach(k => { if (nuovi[k].length) data[k] = [...(data[k] || []), ...nuovi[k]]; });
  data.registrazioni.sort((a, b) => b.ts.localeCompare(a.ts));
  await save(); alert("Backup importato: " + riga + ".");
};
$("#nav").onclick = e => { const b = e.target.closest("[data-page]"); if (b) { page = b.dataset.page; render(); if (CLOUD && page === "report") syncNow(); if (page === "collaudi") ecoLoad(); } };
$("#presets").onclick = e => { const b = e.target.closest("[data-range]"); if (!b) return; const t = new Date(), x = new Date(t); if (b.dataset.range === "7") x.setDate(x.getDate() - 6); if (b.dataset.range === "month") x.setDate(1); $("#fd").value = iso(x); $("#fa").value = iso(t); render(); };
function fillSel(id, label, vals) { const el = $(id), cur = el.value; el.innerHTML = `<option value="">${label}</option>` + [...new Set(vals)].filter(Boolean).sort().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(""); el.value = [...el.options].some(o => o.value === cur) ? cur : ""; }
const opts = (list, label) => `<option value="">${label}</option>` + list.map(i => `<option value="${esc(i.a + " " + i.b)}">${esc(i.a)} — ${esc(i.b)}</option>`).join("");

/* ---------- Render ---------- */
const REG = [["operatori","Operatori","Nome","Cognome"],["prodotti","Prodotti","Codice","Descrizione"],["scarti","Cause di scarto","Codice","Descrizione"],["fermi","Cause di fermo","Codice","Descrizione"]];
let opState = {op:"", rep:"", prod:""};
const opBusy = () => !!(opState.rep || opState.op || opState.prod);
const SVG = d => `<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON_USER = SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>');
const ICON_CALC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="2.5"/><rect x="8" y="5.5" width="8" height="3.5" rx=".8"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"/></svg>';
const ICON_STAMP = SVG('<rect x="5" y="3" width="14" height="5" rx="1"/><rect x="5" y="16" width="14" height="5" rx="1"/><path d="M12 8v8M9.5 13.5L12 16l2.5-2.5"/>');
const ICON_TOOL = SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>');
const REP_ICON = {stampaggio: ICON_STAMP, officina: ICON_TOOL};
const ICON_BOX = SVG('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5L12 12l8-4.5M12 12v9"/>');
/* ---------- Finestre di conferma ---------- */
function dialog({title, html = "", ok = "Conferma", cancel = "Annulla", check, focus = "ok"}) {
  return new Promise(res => {
    const back = document.createElement("div"); back.id = "dlg"; back.className = "kp-back";
    back.innerHTML = `<div class="kp dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="dlg-b">${html}</div><p class="err dlg-err" id="dlgErr" role="alert"></p><div class="kp-a"${cancel ? "" : ' style="grid-template-columns:1fr"'}>${cancel ? `<button type="button" class="btn kp-x" data-d="0">${esc(cancel)}</button>` : ""}<button type="button" class="btn" data-d="1">${esc(ok)}</button></div></div>`;
    document.body.appendChild(back);
    const done = v => { document.removeEventListener("keydown", key, true); back.remove(); res(v); };
    const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } };
    back.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { if (b.dataset.d === "1" && check) { const m = check(); if (m) { $("#dlgErr").textContent = m; return; } } done(b.dataset.d === "1"); });
    back.onclick = e => { if (e.target === back) done(false); };
    document.addEventListener("keydown", key, true);
    (back.querySelector(focus === "cancel" && cancel ? '[data-d="0"]' : '[data-d="1"]')).focus();
  });
}
/* ---------- Operatore inattivo: dopo IDLE_SEC secondi senza tocchi si torna alla scelta del reparto (primo passo) ---------- */
const IDLE_SEC = 180, IDLE_AVVISO = 15; let idleAt = Date.now();
function idleBar(left) {
  let b = $("#idleBar");
  if (left == null) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("div"); b.id = "idleBar"; b.className = "idle"; document.body.appendChild(b); }
  b.textContent = `Ritorno alla scelta del reparto tra ${left} s · tocca lo schermo per restare`;
}
["pointerdown", "keydown"].forEach(ev => document.addEventListener(ev, () => { idleAt = Date.now(); idleBar(); }, true));
setInterval(() => {
  if (role !== "operatore" || !opBusy()) return idleBar();
  if ($("#kp") || $("#dlg")) { idleAt = Date.now(); return idleBar(); }
  const left = IDLE_SEC - Math.floor((Date.now() - idleAt) / 1000);
  if (left <= 0) { opState = {op: "", rep: "", prod: ""}; idleBar(); render(); }
  else idleBar(left <= IDLE_AVVISO ? left : undefined);
}, 1000);
/* ---------- Prodotti più usati (conteggio per dispositivo) e ricerca ---------- */
const RICERCA_MIN = 8, USO_K = "produzione-uso";
const usi = () => { try { return JSON.parse(localStorage.getItem(USO_K)) || {}; } catch { return {}; } };
const addUso = label => { try { const u = usi(), x = u[label] || {n: 0, t: 0}; u[label] = {n: x.n + 1, t: Date.now()}; localStorage.setItem(USO_K, JSON.stringify(u)); } catch {} };
const norm = t => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
function openKeypad(input, title, max) {
  if ($("#kp")) return;
  let buf = input.value, fresh = true;
  const back = document.createElement("div");
  back.id = "kp"; back.className = "kp-back";
  back.innerHTML = `<div class="kp" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mut">${esc(title)}</div><div class="kp-d" id="kpd" aria-live="polite"></div><div class="kp-g">${[1,2,3,4,5,6,7,8,9,"C",0,"⌫"].map(k => `<button type="button" class="kp-k" data-k="${k}"${k === "⌫" ? ' aria-label="Cancella ultima cifra"' : k === "C" ? ' aria-label="Azzera"' : ""}>${k}</button>`).join("")}</div><div class="kp-a"><button type="button" class="btn kp-x" data-k="x">Annulla</button><button type="button" class="btn" data-k="ok">Conferma</button></div></div>`;
  document.body.appendChild(back);
  const show = () => $("#kpd").textContent = buf || "0";
  const close = () => { document.removeEventListener("keydown", key); back.remove(); input.focus(); };
  const press = k => {
    if (k === "x") return close();
    if (k === "ok") { input.value = buf; return close(); }
    if (k === "C") buf = "";
    else if (k === "⌫") buf = buf.slice(0, -1);
    else { if (fresh) buf = ""; buf = (buf + k).replace(/^0+(?=\d)/, "").slice(0, max ? String(max).length : 6); if (max && +buf > max) buf = String(max); }
    fresh = false; show();
  };
  const key = e => {
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === "Backspace") press("⌫"); else if (e.key === "Enter") press("ok"); else if (e.key === "Escape") press("x"); else return;
    e.preventDefault();
  };
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelectorAll("[data-k]").forEach(b => b.onclick = () => press(b.dataset.k));
  document.addEventListener("keydown", key);
  show(); back.querySelector('[data-k="ok"]').focus();
}
function renderOperatore(v) {
  const o = opState, step = !o.rep ? 1 : !o.op ? 2 : !o.prod ? 3 : 4, sc = data.scarti.filter(x => !x.reparto || x.reparto === o.rep), plist = data.prodotti.filter(p => !p.reparto || p.reparto === o.rep), pLabel = i => `<b>${esc(i.a)}</b><span>${esc(i.b)}</span>`;
  const cards = (list, icon, label, vuoto) => list.length ? `<div class="pick">${list.map(i => `<button type="button" class="pc" data-pick="${i.id}">${icon}<span class="pn">${label(i)}</span></button>`).join("")}</div>` : `<p class="mut">${vuoto}</p>`;
  const [pc, pd] = o.prod ? split(o.prod, data.prodotti) : ["", ""];
  const chips = (o.rep ? `<div class="chip">${REP_ICON[o.rep]}<b>${esc(repName(o.rep))}</b><button type="button" class="chg" data-back="rep">Cambia</button></div>` : "") + (o.op ? `<div class="chip">${ICON_USER}<b>${esc(o.op)}</b><button type="button" class="chg" data-back="op">Cambia</button></div>` : "") + (o.prod ? `<div class="chip">${ICON_BOX}<span><b>${esc(pc)}</b> ${esc(pd)}</span><button type="button" class="chg" data-back="prod">Cambia</button></div>` : "");
  const stepper = (m, id, p, val, ph) => `<div class="row"><button type="button" class="btn st" id="${m}">−</button><span class="kf"><input class="field" id="${id}" type="number" min="0" value="${val}" placeholder="${ph}" readonly inputmode="none" aria-haspopup="dialog" style="text-align:center;font-weight:700;font-size:24px;min-height:52px;padding:0 38px;cursor:pointer">${ICON_CALC}</span><button type="button" class="btn st" id="${p}">+</button></div>`;
  const opList = data.operatori.filter(x => opInRep(x, o.rep));
  if (step === 1) { const nProd = k => data.prodotti.filter(p => !p.reparto || p.reparto === k).length, nOp = k => data.operatori.filter(x => opInRep(x, k)).length, usabile = k => nProd(k) && nOp(k); v.innerHTML = `<section class="card">${chips ? `<div class="sel" style="margin-bottom:16px">${chips}</div>` : ""}<h2>In quale reparto hai lavorato?</h2><div class="pick rep">${REPARTI.map(([k, n]) => `<button type="button" class="pc" data-rep-pick="${k}"${usabile(k) ? "" : " disabled"}>${REP_ICON[k]}<span class="pn"><b>${n}</b><span>${!nProd(k) ? "Nessun prodotto" : !nOp(k) ? "Nessun operatore" : nProd(k) === 1 ? "1 prodotto" : nProd(k) + " prodotti"}</span></span></button>`).join("")}</div>${REPARTI.some(([k]) => usabile(k)) ? "" : `<p class="mut" style="margin-top:14px">${REPARTI.some(([k]) => nProd(k)) ? "Nessun operatore assegnato ai reparti. Chiedi all'amministratore di completare gli operatori." : "Nessun prodotto in elenco. Chiedi all'amministratore di crearne."}</p>`}</section>`; }
  else if (step === 2) v.innerHTML = `<section class="card"><div class="sel" style="margin-bottom:16px">${chips}</div><h2>Chi sei?</h2>${cards(opList, ICON_USER, i => `${esc(i.a)} ${esc(i.b)}`, "Nessun operatore in questo reparto. Chiedi all'amministratore di assegnarlo o di crearne uno.")}</section>`;
  else if (step === 3) v.innerHTML = `<section class="card"><div class="sel" style="margin-bottom:16px">${chips}</div><h2>Che prodotto hai lavorato?</h2>${plist.length > RICERCA_MIN ? `<input class="field" id="q" type="search" placeholder="Cerca codice o descrizione…" autocomplete="off" aria-label="Cerca prodotto" style="margin-bottom:16px;min-height:52px;font-size:16px"><div id="pl"></div>` : cards(plist, ICON_BOX, pLabel, "Nessun prodotto in questo reparto. Chiedi all'amministratore di crearne uno.")}</section>`;
  else v.innerHTML = `<section class="card"><div class="sel">${chips}</div></section>
    <div class="grid2">
      <section class="card"><h2>Pezzi prodotti</h2>${stepper("minusP", "pzp", "plusP", "", "0")}<small class="mut hint">Solo pezzi buoni, scarti esclusi</small></section>
      <section class="card"><h2>Scarto</h2>${stepper("minus", "pz", "plus", 0, "0")}
        <select class="field" id="cs" style="margin-top:12px">${opts(sc, "Causa scarto")}</select><small class="mut hint">${sc.length ? "Compila solo se ci sono scarti" : "Nessuna causa di scarto per questo reparto: chiedi all'amministratore di crearla"}</small></section>
      <section class="card"><h2>Fermo macchina</h2>
        <div class="row">${[["h", "Ore", 99], ["m", "Minuti", 59], ["s", "Secondi", 59]].map(([id, l, mx]) => `<label class="n">${l}<span class="kf"><input class="field" id="${id}" type="number" min="0" max="${mx}" value="0" readonly inputmode="none" aria-haspopup="dialog" style="text-align:center;font-weight:700;font-size:20px;min-height:48px;padding:0 30px;cursor:pointer">${ICON_CALC}</span></label>`).join("")}</div>
        <select class="field" id="cf" style="margin-top:12px">${opts(data.fermi, "Causa fermo")}</select><small class="mut hint">Compila solo se c'è stato un fermo</small></section>
    </div>
    <button type="button" class="btn" id="regT" style="width:100%;padding:14px;font-size:16px">Registra turno</button>`;
  const bindPick = root => root.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { const it = (step === 2 ? data.operatori : data.prodotti).find(x => x.id === b.dataset.pick); if (!it) return; o[step === 2 ? "op" : "prod"] = it.a + " " + it.b; render(); });
  bindPick(v);
  if (step === 3 && plist.length > RICERCA_MIN) {
    const draw = () => {
      const t = norm($("#q").value);
      if (t) { const f = plist.filter(p => norm(p.a + " " + p.b).includes(t)); $("#pl").innerHTML = cards(f, ICON_BOX, pLabel, "Nessun prodotto trovato."); }
      else { const u = usi(), key = p => p.a + " " + p.b, rec = plist.filter(p => u[key(p)]).sort((x, y) => (u[key(y)].n - u[key(x)].n) || (u[key(y)].t - u[key(x)].t)).slice(0, 4), resto = plist.filter(p => !rec.includes(p)); $("#pl").innerHTML = (rec.length ? `<h3 class="sh" style="margin-bottom:10px">Più usati</h3>${cards(rec, ICON_BOX, pLabel, "")}<h3 class="sh" style="margin:20px 0 10px">Altri prodotti</h3>` : "") + cards(resto, ICON_BOX, pLabel, ""); }
      bindPick($("#pl"));
    };
    $("#q").oninput = draw; draw();
  }
  v.querySelectorAll("[data-rep-pick]").forEach(b => b.onclick = () => { o.rep = b.dataset.repPick; o.prod = ""; const cur = o.op && data.operatori.find(x => x.a + " " + x.b === o.op); if (o.op && !(cur && opInRep(cur, o.rep))) o.op = ""; render(); });
  v.querySelectorAll("[data-back]").forEach(b => b.onclick = () => { o[b.dataset.back] = ""; if (b.dataset.back === "rep") o.prod = ""; render(); });
  if (step !== 4) return;
  [["minusP", "plusP", "#pzp"], ["minus", "plus", "#pz"]].forEach(([m, p, id]) => { $("#" + m).onclick = () => $(id).value = Math.max(0, (+$(id).value || 0) - 1); $("#" + p).onclick = () => $(id).value = (+$(id).value || 0) + 1; });
  [["#pzp", "Pezzi prodotti"], ["#pz", "Pezzi scartati"], ["#h", "Ore di fermo", 99], ["#m", "Minuti di fermo", 59], ["#s", "Secondi di fermo", 59]].forEach(([id, t, mx]) => { const el = $(id); el.onclick = () => openKeypad(el, t, mx); el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openKeypad(el, t, mx); } }; });
  $("#regT").onclick = async () => {
    if ($("#dlg")) return;
    const n = id => Math.max(0, parseInt($(id).value) || 0), c = (id, max) => Math.min(max, n(id));
    const prd = n("#pzp"), scr = n("#pz"), cs = $("#cs").value, cf = $("#cf").value, dur = c("#h", 99) * 3600 + c("#m", 59) * 60 + c("#s", 59);
    if (!prd && !scr && !dur) return alert("Inserisci almeno i pezzi prodotti, uno scarto o un fermo.");
    if (scr && !cs) return alert("Seleziona la causa di scarto.");
    if (!scr && cs) return alert("Hai scelto una causa di scarto: inserisci anche i pezzi scartati.");
    if (dur && !cf) return alert("Seleziona la causa di fermo.");
    if (!dur && cf) return alert("Hai scelto una causa di fermo: inserisci anche la durata.");
    const warns = [];
    if (prd && scr > prd) warns.push(`Gli scarti (${scr}) sono più dei pezzi prodotti (${prd}).`);
    if (prd >= 10000) warns.push(`Pezzi prodotti molto alti (${prd.toLocaleString("it-IT")}): controlla di aver digitato bene.`);
    if (scr >= 1000) warns.push(`Scarti molto alti (${scr.toLocaleString("it-IT")}): controlla di aver digitato bene.`);
    if (dur > 12 * 3600) warns.push(`Fermo di oltre 12 ore (${fmt(dur)}): controlla ore e minuti.`);
    const riga = (l, val) => `<dt>${l}</dt><dd>${val}</dd>`;
    const html = `<dl class="sum">${riga("Reparto", esc(repName(o.rep)))}${riga("Operatore", esc(o.op))}${riga("Prodotto", esc(o.prod))}${riga("Pezzi prodotti", prd ? prd.toLocaleString("it-IT") : "—")}${scr ? riga("Scarti", `${scr.toLocaleString("it-IT")} · ${esc(cs)}`) : ""}${dur ? riga("Fermo", `${fmt(dur)} · ${esc(cf)}`) : ""}</dl>${warns.length ? `<div class="warn" role="alert">${warns.map(w => `<span>⚠ ${esc(w)}</span>`).join("")}</div>` : ""}`;
    const base = {operatore: o.op, prodotto: o.prod};
    if (!(await dialog({title: "Controlla e conferma", html, ok: "Conferma e salva", cancel: "Modifica"}))) return;
    if (!CLOUD && !dir && window.showDirectoryPicker && !confirm("La cartella non è collegata: il turno verrà salvato solo in questo browser.\nRegistrare comunque?")) return;
    const ts = new Date().toISOString(), recs = [];
    if (prd) recs.push({tipo: "Produzione", causa: "", pezzi: prd});
    if (scr) recs.push({tipo: "Scarto", causa: cs, pezzi: scr});
    if (dur) recs.push({tipo: "Fermo", causa: cf, durataSec: dur});
    const nuove = recs.map(r => ({id: uid(), ts, ...base, ...r}));
    if (CORR && !(await corrRemove(CORR))) return;
    data.registrazioni.unshift(...nuove);
    lastSet({ids: nuove.map(x => x.id), at: Date.now(), ts, rep: o.rep, op: o.op, prod: o.prod, prd, scr, cs, cf, dur});
    todayAdd(o.op);
    const eraCorr = !!CORR; CORR = null;
    const msg = [prd && `${prd} prodotti`, scr && `${scr} scartati`, dur && `fermo ${fmt(dur)}`].filter(Boolean).join(", ");
    addUso(base.prodotto);
    opState = {op: "", rep: "", prod: ""};
    save().then(() => showSuccess((eraCorr ? "Correzione salvata: " : "") + msg));
  };
}
/* ---------- Anagrafiche: riquadri e finestra con l'elenco ---------- */
const ICON_SCRAP = SVG('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>');
const ICON_STOP = SVG('<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>');
const REG_ICON = {operatori: ICON_USER, prodotti: ICON_BOX, scarti: ICON_SCRAP, fermi: ICON_STOP};
let anag = null, winMsgT;
const cmpAna = k => (x, y) => k === "operatori" ? (x.b + " " + x.a).localeCompare(y.b + " " + y.a, "it", {sensitivity: "base"}) : x.a.localeCompare(y.a, "it", {numeric: true, sensitivity: "base"});
function repCount(k) { const c = {tot: data[k].length, none: data[k].filter(x => !x.reparto).length}; REP_OPZ(k).forEach(([r]) => c[r] = data[k].filter(x => x.reparto === r).length); return c; }
const ritTxt = i => Number(i.ritmo) > 0 ? `${Eco.N1(Number(i.ritmo))} pz/g · ${Math.max(1, i.postazioni || 1)} post.` + (i.matricola && i.matricola !== i.a ? ` · ${i.matricola}` : "") : "Ritmo…";
const anaRow = (k, i) => `<li><span><b>${esc(i.a)}</b> ${esc(i.b)}</span><span class="row">${k === "prodotti" && i.reparto !== "stampaggio" ? `<button type="button" class="chg" data-rit="${i.id}" title="Ritmo giornaliero, postazioni e matricola per i collaudi">${esc(ritTxt(i))}</button>` : ""}${CON_REP(k) ? `<select class="field mini" data-rep="${k}:${i.id}" aria-label="Reparto di ${esc(i.a)}">${i.reparto ? "" : `<option value="" selected disabled>Senza reparto</option>`}${REP_OPZ(k).map(([v, n]) => `<option value="${v}"${i.reparto === v ? " selected" : ""}>${n}</option>`).join("")}</select>` : ""}<button type="button" class="link" data-del="${k}:${i.id}" aria-label="Elimina ${esc(i.a)}">Elimina</button></span></li>`;
function refreshAnag() {
  if (!anag || !$("#win")) return;
  const k = anag.k, all = data[k], c = repCount(k), t = norm(anag.q);
  if (anag.rep === "none" && !c.none) anag.rep = "";
  let items = [...all].sort(cmpAna(k));
  if (anag.rep) items = items.filter(x => anag.rep === "none" ? !x.reparto : x.reparto === anag.rep);
  if (t) items = items.filter(x => norm(x.a + " " + x.b).includes(t));
  $("#winN").textContent = `(${all.length})`;
  $("#wchips").innerHTML = CON_REP(k) ? [["", "Tutti", c.tot], ...REP_OPZ(k).map(([r, n]) => [r, n, c[r]]), ...(c.none ? [["none", "Senza reparto", c.none]] : [])].map(([v, n, num]) => `<button type="button" class="wchip${anag.rep === v ? " on" : ""}" data-chip="${v}">${n} (${num})</button>`).join("") : "";
  const shown = items.slice(0, anag.limit);
  $("#wlist").innerHTML = shown.map(i => anaRow(k, i)).join("") || `<li class="mut">${all.length ? "Nessun risultato." : "Nessun elemento: aggiungine uno qui sopra."}</li>`;
  $("#wmore").innerHTML = items.length > shown.length ? `<button type="button" class="btn sec" data-more>Mostra altri (${items.length - shown.length})</button>` : "";
}
function openAnag(k) {
  const def = REG.find(x => x[0] === k); if (!def || $("#win")) return;
  const [, t, pa, pb] = def;
  anag = {k, q: "", rep: "", limit: 100};
  const back = document.createElement("div"); back.id = "win"; back.className = "kp-back";
  back.innerHTML = `<div class="kp win" role="dialog" aria-modal="true" aria-label="${esc(t)}" tabindex="-1">
    <div class="win-h"><h2>${esc(t)} <span class="mut" id="winN"></span></h2><div class="row">${k === "prodotti" ? `<button type="button" class="btn sec" id="impBtn">Importa da file</button><input type="file" id="impFile" accept=".csv,.txt,.xlsx,text/csv" hidden>` : ""}<button type="button" class="btn" data-close>Chiudi</button></div></div>
    <form class="row wrap" data-add="${k}"><input class="field" name="a" placeholder="${pa}" required autocomplete="off"><input class="field" name="b" placeholder="${pb}" required autocomplete="off">${CON_REP(k) ? `<select class="field" name="rep" required aria-label="Reparto"><option value="">Reparto…</option>${REP_OPZ(k).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>` : ""}<button class="btn">Aggiungi</button></form>
    <p class="win-m" id="winMsg" role="status"></p>
    <div class="win-t"><input class="field" id="wq" type="search" placeholder="Cerca…" autocomplete="off" aria-label="Cerca in ${esc(t)}"><div class="tabs" id="wchips" style="margin:0"></div></div>
    <ul id="wlist"></ul><div id="wmore"></div></div>`;
  document.body.appendChild(back);
  const onKey = e => { if (e.key === "Escape" && !$("#dlg") && !$("#kp")) close(); };
  const close = () => { document.removeEventListener("keydown", onKey); back.remove(); anag = null; const tile = document.querySelector(`[data-open="${k}"]`); if (tile) tile.focus(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("click", async e => {
    const x = e.target;
    if (x === back || x.closest("[data-close]")) return close();
    const chip = x.closest("[data-chip]"); if (chip) { anag.rep = chip.dataset.chip; anag.limit = 100; return refreshAnag(); }
    if (x.closest("[data-more]")) { anag.limit += 100; return refreshAnag(); }
    if (x.closest("#impBtn")) return $("#impFile").click();
    const rit = x.closest("[data-rit]"); if (rit) return editRitmo(rit.dataset.rit);
    const del = x.closest("[data-del]");
    if (del) {
      const [kk, id] = del.dataset.del.split(":"), it = data[kk].find(y => y.id === id); if (!it) return;
      if (!(await dialog({title: "Eliminare?", html: `<p style="margin:0"><b>${esc(it.a)}</b> ${esc(it.b)} verrà tolto dall'elenco. Le registrazioni già fatte restano nel report.</p>`, ok: "Elimina", cancel: "Annulla", focus: "cancel"}))) return;
      data[kk] = data[kk].filter(y => y.id !== id); save();
    }
  });
  back.addEventListener("input", e => { if (e.target.id === "wq") { anag.q = e.target.value; anag.limit = 100; refreshAnag(); } });
  back.addEventListener("change", e => {
    const f = e.target;
    if (f.id === "impFile") { const file = f.files[0]; f.value = ""; if (file) importProdotti(file); return; }
    /* Cambio reparto: l'elemento viene ricreato con un nuovo id (le registrazioni lo citano per nome, quindi lo storico resta valido) */
    if (f.dataset && f.dataset.rep) { const [kk, id] = f.dataset.rep.split(":"), old = data[kk].find(y => y.id === id); if (!old || !f.value) return; data[kk] = data[kk].map(y => y === old ? {...old, id: uid(), reparto: f.value} : y); save(); }
  });
  back.addEventListener("submit", e => {
    const f = e.target.closest("[data-add]"); if (!f) return; e.preventDefault();
    const a = f.a.value.trim(), b = f.b.value.trim(), reparto = f.rep ? f.rep.value : ""; if (!a || !b) return;
    if (f.rep && !reparto) return alert(k === "operatori" ? "Scegli in quale reparto opera l'operatore (Stampaggio, Officina o Entrambi)." : "Scegli il reparto " + (k === "scarti" ? "della causa di scarto." : "del prodotto."));
    data[k].push(reparto ? {id: uid(), a, b, reparto} : {id: uid(), a, b});
    f.a.value = ""; f.b.value = ""; f.a.focus();
    $("#winMsg").textContent = `Aggiunto: ${a} ${b}`; clearTimeout(winMsgT); winMsgT = setTimeout(() => { const m = $("#winMsg"); if (m) m.textContent = ""; }, 4000);
    save();
  });
  refreshAnag(); back.firstElementChild.focus();
}
/* ---------- operatore: ultima registrazione, correzione, fine turno ---------- */
/* turno: 8:00–17:00, pausa 12:00–13:00. Il tablet ricorda di registrare mezz'ora prima della fine; per l'amministratore chi manca diventa arancio a fine turno. */
const TURNO = {inizio: "08:00", pausa: ["12:00", "13:00"], fine: "17:00", promemoria: "16:30"};
const LAST_K = "produzione-ultima", TODAY_K = "produzione-oggi", CORR_MIN = 10;
let CORR = null;
const lsJ = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsW = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function lastGet() { const l = lsJ(LAST_K); return l && Date.now() - l.at < CORR_MIN * 60000 ? l : null; }
function lastSet(l) { lsW(LAST_K, l); }
function todayAdd(op) { const d = iso(new Date()), t = lsJ(TODAY_K); const x = t && t.day === d ? t : {day: d, ops: []}; if (!x.ops.includes(op)) x.ops.push(op); lsW(TODAY_K, x); }
function todayOps() { const t = lsJ(TODAY_K); return t && t.day === iso(new Date()) ? t.ops : []; }
const minLeft = l => Math.max(1, Math.ceil((l.at + CORR_MIN * 60000 - Date.now()) / 60000));
async function corrRemove(c) {
  const ids = c.ids;
  if (CLOUD) {
    if (typeof pushP !== "undefined" && pushP) { try { await pushP; } catch {} }
    const local = ids.filter(id => data.registrazioni.some(r => r.id === id) && !synced.registrazioni.has(id));
    const remote = ids.filter(id => !local.includes(id));
    if (remote.length) {
      let n = 0;
      try { n = await (await api("rpc/correggi_registrazioni", {method: "POST", body: JSON.stringify({ids: remote})})).json(); }
      catch (e) { alert("Non riesco a correggere adesso (" + e.message + "). La registrazione resta com'è: riprova tra poco."); return false; }
      if (n < remote.length) { alert("Sono passati più di 15 minuti: questa registrazione non si può più correggere dal tablet. Chiedi all'amministratore."); lastSet(null); return false; }
      remote.forEach(id => synced.registrazioni.delete(id));
    }
  }
  data.registrazioni = data.registrazioni.filter(r => !ids.includes(r.id));
  return true;
}
function corrStart() {
  const l = lastGet(); if (!l) { render(); return; }
  CORR = Object.assign({}, l, {filled: false});
  opState = {rep: l.rep, op: l.op, prod: l.prod};
  render();
}
async function corrDelete() {
  const l = lastGet(); if (!l) return render();
  const ok = await dialog({title: "Eliminare la registrazione?", html: `<p style="margin:0">${esc(l.op)} · ${esc(l.prod)} · ${esc(regTxt(l))}. Non verrà conteggiata.</p>`, ok: "Elimina", cancel: "Lascia com'è", focus: "cancel"});
  if (!ok) return;
  if (!(await corrRemove(l))) return;
  lastSet(null); CORR = null; opState = {op: "", rep: "", prod: ""};
  save().then(() => showSuccess("Registrazione eliminata"));
}
const regTxt = l => [l.prd && `${l.prd} prodotti`, l.scr && `${l.scr} scartati`, l.dur && `fermo ${fmt(l.dur)}`].filter(Boolean).join(", ");
function opExtras(v) {
  const o = opState, step = !o.rep ? 1 : !o.op ? 2 : !o.prod ? 3 : 4, l = lastGet();
  if (CORR && step !== 4) CORR = null;
  if (CORR && step === 4) {
    v.insertAdjacentHTML("afterbegin", `<section class="card lastreg corr"><div><b>Stai correggendo la registrazione delle ${new Date(CORR.ts).toLocaleTimeString("it-IT", {hour: "2-digit", minute: "2-digit"})}</b><div class="mut">Quando salvi, quella vecchia viene sostituita da questa.</div></div><div class="row"><button type="button" class="btn sec" id="corrNo">Annulla correzione</button><button type="button" class="btn sec" id="corrDel" style="color:var(--red);border-color:var(--red)">Elimina registrazione</button></div></section>`);
    $("#corrNo").onclick = () => { CORR = null; opState = {op: "", rep: "", prod: ""}; render(); };
    $("#corrDel").onclick = corrDelete;
    if (!CORR.filled) {
      CORR.filled = true;
      const set = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };
      set("#pzp", CORR.prd || ""); set("#pz", CORR.scr || 0); set("#cs", CORR.cs || ""); set("#cf", CORR.cf || "");
      if (CORR.dur) { set("#h", Math.floor(CORR.dur / 3600)); set("#m", Math.floor(CORR.dur % 3600 / 60)); set("#s", CORR.dur % 60); }
    }
  } else if (l && step <= 2) {
    v.insertAdjacentHTML("afterbegin", `<section class="card lastreg"><div><b>Ultima registrazione: ${esc(l.op)}</b><div class="mut">${esc(l.prod)} · ${esc(regTxt(l))} · puoi correggerla ancora per ${minLeft(l)} min</div></div><div class="row"><button type="button" class="btn" id="corrGo">Correggi</button><button type="button" class="btn sec" id="corrDel">Elimina</button></div></section>`);
    $("#corrGo").onclick = corrStart; $("#corrDel").onclick = corrDelete;
  }
  const hm = new Date().toTimeString().slice(0, 5), done = todayOps();
  if (step === 1 && hm >= TURNO.promemoria && !done.length) v.insertAdjacentHTML("afterbegin", `<section class="card turno"><b>Sono le ${hm}: hai registrato il turno?</b><div class="mut">Il turno finisce alle ${TURNO.fine.replace(":00", "")} e da questo tablet oggi non è ancora stato registrato nulla. Prima di andare inserisci pezzi prodotti, scarti ed eventuali fermi.</div></section>`);
  if (step === 2) v.querySelectorAll(".pc[data-pick]").forEach(b => { const it = data.operatori.find(x => x.id === b.dataset.pick); if (it && done.includes(it.a + " " + it.b)) b.insertAdjacentHTML("beforeend", `<span class="done">✓ registrato oggi</span>`); });
  if (step === 4) [["#pzp"], ["#pz"]].forEach(([id]) => {
    const inp = $(id), row = inp && inp.closest(".row"); if (!row) return;
    row.insertAdjacentHTML("afterend", `<div class="quick" data-for="${id}"><button type="button" data-q="10">+10</button><button type="button" data-q="50">+50</button><button type="button" data-q="100">+100</button><button type="button" class="zero" data-q="0">Azzera</button></div>`);
  });
  v.querySelectorAll(".quick [data-q]").forEach(b => b.onclick = () => { const el = $(b.closest(".quick").dataset.for), q = +b.dataset.q; el.value = q ? Math.max(0, (+el.value || 0) + q) : (el.id === "pzp" ? "" : 0); });
}
/* amministratore: chi ha registrato oggi */
function oggiHtml() {
  const d = iso(new Date()), hm = new Date().toTimeString().slice(0, 5), tot = {};
  data.registrazioni.forEach(r => { if (iso(new Date(r.ts)) !== d) return; const t = tot[r.operatore] || (tot[r.operatore] = {p: 0, s: 0, f: 0}); if (r.tipo === "Produzione") t.p += r.pezzi || 0; else if (r.tipo === "Scarto") t.s += r.pezzi || 0; else t.f += r.durataSec || 0; });
  const ops = data.operatori.map(x => x.a + " " + x.b).concat(Object.keys(tot).filter(n => !data.operatori.some(x => x.a + " " + x.b === n)));
  if (!ops.length) return "";
  const late = hm >= TURNO.fine, nReg = ops.filter(n => tot[n]).length;
  return `<section class="card oggi"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2>Registrazioni di oggi</h2><span class="mut">${nReg} di ${ops.length} operatori${late && nReg < ops.length ? ` · turno finito alle ${TURNO.fine}` : ""}</span></div><div class="oggi-l">${ops.map(n => { const t = tot[n]; return `<div class="${t ? "" : late ? "late" : "no"}"><b>${esc(n)}</b><span>${t ? [t.p && `${t.p.toLocaleString("it-IT")} pz`, t.s && `${t.s} scarti`, t.f && `fermo ${fmt(t.f)}`].filter(Boolean).join(" · ") || "registrato" : late ? "manca" : "—"}</span></div>`; }).join("")}</div>${CLOUD ? `<small class="mut">Aggiornato all'ultima lettura dei dati: premi “Aggiorna dati” per rileggere.</small>` : ""}</section>`;
}
/* tema: stessa scelta del portale (auto, chiaro, scuro) */
const THEMES_P = [["auto", "Auto"], ["light", "Chiaro"], ["dark", "Scuro"]];
function themeP(next) {
  let m = "auto"; try { const v = localStorage.getItem("ss-theme"); if (v === "light" || v === "dark") m = v; } catch {}
  if (next) { m = THEMES_P[(THEMES_P.findIndex(x => x[0] === m) + 1) % 3][0]; try { if (m === "auto") localStorage.removeItem("ss-theme"); else localStorage.setItem("ss-theme", m); } catch {} }
  if (m === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", m);
  const b = $("#themeBtn"); if (b) { b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/></svg>${THEMES_P.find(x => x[0] === m)[1]}`; b.title = "Tema: tocca per cambiare"; }
}
function render() {
  if (!role) return;
  $("#reports").classList.toggle("hidden", !(canViewReports(role) && page === "report"));
  $("#ecoPage").classList.toggle("hidden", !(role === "admin" && page === "collaudi"));
  if (role === "admin" && page === "collaudi") ecoPaint();
  $("#nav").classList.toggle("hidden", role !== "admin"); backupStatus(); $("#bkImp").classList.toggle("hidden", role !== "admin"); $("#bkBox").classList.toggle("hidden", CLOUD && role !== "admin");
  document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("on", b.dataset.page === page));
  const v = $("#view"); v.classList.toggle("hidden", role === "admin" && page !== "setup");
  if (role === "admin") {
    v.innerHTML = `<div class="tiles">${REG.map(([k, t]) => { const c = repCount(k), sub = CON_REP(k) ? REP_OPZ(k).map(([r, n]) => `${n} ${c[r]}`).join(" · ") + (c.none ? ` · <b>${c.none} senza reparto</b>` : "") : "Motivi del fermo macchina"; return `<button type="button" class="tile" data-open="${k}">${REG_ICON[k]}<span class="tn">${t}</span><span class="tc">${c.tot}</span><span class="ts">${sub}</span><span class="tg">Gestisci ›</span></button>`; }).join("")}</div>`;
    v.insertAdjacentHTML("afterbegin", oggiHtml());
    v.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openAnag(b.dataset.open));
    refreshAnag();
  } else {
    renderOperatore(v); opExtras(v);
  }
  if (!canViewReports(role)) { ["#rows", "#tot", "#chartVolume", "#chartScraps", "#chartStops"].forEach(id => $(id).replaceChildren()); return; }
  if (page !== "report") return;
  document.querySelectorAll("[data-report]").forEach(b => { const selected = b.dataset.report === reportMode; b.classList.toggle("on", selected); b.setAttribute("aria-selected", String(selected)); });
  document.querySelectorAll("#tabs [data-t]").forEach(b => b.classList.toggle("on", b.dataset.t === tipoF));
  [["summary", "#reportSummary"], ["data", "#reportTable"], ["charts", "#reportCharts"]].forEach(([m, id]) => $(id).classList.toggle("hidden", reportMode !== m));
  const R = data.registrazioni, cn = c => tipoF === "Scarto" ? c.tipo === "Scarto" : tipoF === "Fermo" ? c.tipo === "Fermo" : c.tipo !== "Produzione";
  fillSel("#fo", "Tutti gli operatori", [...data.operatori.map(i => i.a + " " + i.b), ...R.map(r => r.operatore)]);
  fillSel("#fp", "Tutti i prodotti", [...data.prodotti.map(i => i.a + " " + i.b), ...R.map(r => r.prodotto)]);
  fillSel("#fc", tipoF === "Scarto" ? "Tutte le cause di scarto" : tipoF === "Fermo" ? "Tutte le cause di fermo" : "Tutte le cause", [...(tipoF !== "Fermo" ? data.scarti : []).map(i => i.a + " " + i.b), ...(tipoF !== "Scarto" ? data.fermi : []).map(i => i.a + " " + i.b), ...R.filter(cn).map(r => r.causa)]);
  $("#fcw").classList.toggle("hidden", tipoF === "Produzione");
  const f = filtro(), sum = t => f.list.filter(r => r.tipo === t);
  if (reportMode === "charts") {
    const charts = ReportCharts.aggregate(f.list, $("#chartGroup").value);
    ReportCharts.draw($("#chartVolume"), charts.volume, [{key:"produced",label:"Prodotti",className:"chart-produced"},{key:"scrap",label:"Scartati",className:"chart-scrap"}], "pezzi", "Pezzi prodotti e scartati");
    ReportCharts.draw($("#chartScraps"), charts.scraps, [{key:"value",label:"Scarti",className:"chart-scrap"}], "pezzi", "Scarti per causa");
    ReportCharts.draw($("#chartStops"), charts.stops, [{key:"value",label:"Fermi",className:"chart-stop"}], "secondi", "Fermi per causa");
  }
  const prd = sum("Produzione").reduce((s, r) => s + (r.pezzi || 0), 0), scr = sum("Scarto").reduce((s, r) => s + (r.pezzi || 0), 0), fer = sum("Fermo").reduce((s, r) => s + (r.durataSec || 0), 0);
  const N = n => n.toLocaleString("it-IT"), pct = (a, b) => a + b ? (a / (a + b) * 100).toFixed(1).replace(".", ",") + "%" : "–";
  $("#tot").innerHTML = [["Pezzi prodotti", N(prd), `${N(f.list.length)} registrazioni`], ["Pezzi scartati", N(scr), "&nbsp;"], ["% scarto", pct(scr, prd), "scarti su prodotti + scarti"], ["Tempo di fermo", fmt(fer), `${sum("Fermo").length} fermi`]].map(([l, v, n]) => `<div class="kpi"><span>${l}</span><b>${v}</b><small>${n}</small></div>`).join("");
  if (reportMode === "summary") {
    const g = $("#sumGroup").value, rows = new Map(), dh = {giorno: "Giorno", operatore: "Operatore", prodotto: "Prodotto", reparto: "Reparto"};
    for (const r of f.list) {
      const d = new Date(r.ts), k = g === "operatore" ? r.operatore : g === "prodotto" ? r.prodotto : g === "reparto" ? (repName(repOf(r.prodotto)) || "Senza reparto") : iso(d);
      const o = rows.get(k) || {k, lab: g === "giorno" ? d.toLocaleDateString("it-IT", {weekday: "short", day: "2-digit", month: "2-digit", year: "numeric"}) : k, prd: 0, scr: 0, fer: 0, nf: 0};
      if (r.tipo === "Produzione") o.prd += r.pezzi || 0; else if (r.tipo === "Scarto") o.scr += r.pezzi || 0; else { o.fer += r.durataSec || 0; o.nf++; }
      rows.set(k, o);
    }
    const lab = o => { if (g !== "prodotto") return esc(o.lab); const [c, d] = split(o.k, data.prodotti); return `<b>${esc(c)}</b> <span class="mut">${esc(d)}</span>`; };
    $("#sumHead").textContent = dh[g];
    $("#sumRows").innerHTML = [...rows.values()].sort(g === "giorno" ? (a, b) => b.k.localeCompare(a.k) : (a, b) => b.prd - a.prd).map(o => `<tr><td>${lab(o)}</td><td class="num">${N(o.prd)}</td><td class="num">${N(o.scr)}</td><td class="num">${pct(o.scr, o.prd)}</td><td class="num">${o.nf}</td><td class="num">${fmt(o.fer)}</td></tr>`).join("") || `<tr><td colspan="6" class="mut">Nessun dato con i filtri selezionati</td></tr>`;
    const cau = (tipo, val, fv, list) => {
      const m = new Map(); sum(tipo).forEach(r => m.set(r.causa, (m.get(r.causa) || 0) + val(r)));
      const tot = [...m.values()].reduce((a, b) => a + b, 0);
      return [...m].sort((a, b) => b[1] - a[1]).map(([c, v]) => { const q = tot ? Math.round(v / tot * 100) : 0, [cc, cd] = split(c, list); return `<tr><td><b>${esc(cc)}</b> <span class="mut">${esc(cd)}</span></td><td class="num">${fv(v)}</td><td><div class="bar ${tipo === "Fermo" ? "f" : ""}"><i style="width:${q}%"></i></div></td><td class="num">${q}%</td></tr>`; }).join("") || `<tr><td colspan="4" class="mut">Nessun dato</td></tr>`;
    };
    $("#sumScraps").innerHTML = cau("Scarto", r => r.pezzi || 0, N, data.scarti);
    $("#sumStops").innerHTML = cau("Fermo", r => r.durataSec || 0, fmt, data.fermi);
  }
  const MAXR = 300, pill = {Produzione: "ok", Scarto: "sc", Fermo: "fe"};
  $("#rows").innerHTML = f.list.slice(0, MAXR).map(r => { const d = new Date(r.ts), [pc, pd] = split(r.prodotto, data.prodotti); return `<tr><td>${d.toLocaleDateString("it-IT")}<br><span class="mut">${d.toLocaleTimeString("it-IT", {hour: "2-digit", minute: "2-digit"})}</span></td><td><span class="pill ${pill[r.tipo]}">${r.tipo}</span></td><td>${esc(r.operatore)}</td><td><b>${esc(pc)}</b><br><span class="mut">${esc(pd)}${repName(repOf(r.prodotto)) ? " · " + repName(repOf(r.prodotto)) : ""}</span></td><td>${esc(r.causa)}</td><td class="num">${r.tipo === "Fermo" ? fmt(r.durataSec) : N(r.pezzi || 0)}</td><td>${role === "admin" ? `<button class="link" data-rdel="${r.id}">Elimina</button>` : ""}</td></tr>`; }).join("") + (f.list.length > MAXR ? `<tr><td colspan="7" class="mut">Mostrate le ultime ${MAXR} registrazioni su ${N(f.list.length)}: restringi il periodo o esporta in Excel.</td></tr>` : "") || `<tr><td colspan="7" class="mut">Nessuna registrazione${f.attivo ? " con i filtri selezionati" : ""}</td></tr>`;
  document.querySelectorAll("[data-rdel]").forEach(b => b.onclick = () => { if (confirm("Eliminare la registrazione?")) { data.registrazioni = data.registrazioni.filter(x => x.id !== b.dataset.rdel); save(); } });
  const prod = prodList();
  $("#exp").disabled = $("#expx").disabled = !prod.length;
  $("#erp").disabled = !filtroBase().some(r => r.tipo !== "Produzione");
  $("#clr").classList.toggle("hidden", !f.attivo);
  $("#exp").textContent = `CSV prodotti (${prod.length})`; $("#expx").textContent = `Excel prodotti (${prod.length})`;
}

/* ---------- Ecosistema: ritmo del prodotto e collaudi del portale ---------- */
async function editRitmo(id) {
  if (role !== "admin" || $("#dlg")) return;
  const p = data.prodotti.find(x => x.id === id); if (!p) return;
  const f = (lab, idf, val, ph, hint) => `<label class="fl">${lab}<input class="field" id="${idf}" value="${esc(val)}" placeholder="${esc(ph)}" autocomplete="off"${idf === "rMat" ? "" : ' inputmode="decimal"'}>${hint ? `<small class="mut">${hint}</small>` : ""}</label>`;
  const html = `<p style="margin:0"><b>${esc(p.a)}</b> ${esc(p.b)}</p>`
    + f("Pezzi al giorno (totale del prodotto)", "rRit", p.ritmo || "", "es. 100", "Lo storico: quanti pezzi si fanno in un giorno con le postazioni normali.")
    + f("Postazioni di riferimento", "rPost", p.postazioni || 1, "1", "Con le postazioni normali si fa il totale qui sopra. Ogni postazione in più aggiunge la sua parte.")
    + f("Matricola nei collaudi", "rMat", p.matricola || "", p.a, "Lascia vuoto se è uguale al codice prodotto.")
    + `<p class="mut" id="rOut" style="margin:0"></p>`;
  let val = null;
  const read = () => { const rit = parseFloat(String($("#rRit").value).replace(",", ".")), post = parseInt($("#rPost").value, 10), mat = $("#rMat").value.trim(); return {rit, post, mat}; };
  const ok = await dialog({title: "Ritmo per i collaudi", html, ok: "Salva", cancel: "Annulla", check: () => {
    const v = read();
    if ($("#rRit").value.trim() === "" ) { val = {rit: null, post: Number.isInteger(v.post) && v.post >= 1 ? v.post : 1, mat: v.mat}; return ""; }
    if (!(v.rit > 0) || v.rit > 100000) return "Indica i pezzi al giorno: un numero maggiore di zero (o lascia vuoto per toglierlo).";
    if (!(Number.isInteger(v.post) && v.post >= 1 && v.post <= 50)) return "Le postazioni devono essere un numero intero da 1 a 50.";
    if (v.mat && !/^[\w.\-\/]{1,40}$/.test(v.mat)) return "La matricola può contenere solo lettere, cifre e . - /";
    val = v; return "";
  }});
  if (!ok || !val) return;
  const next = {...p}; delete next.ritmo; delete next.postazioni; delete next.matricola;
  if (val.rit) next.ritmo = Math.round(val.rit * 10) / 10;
  if (val.post > 1 || val.rit) next.postazioni = val.post;
  if (val.mat && val.mat !== p.a) next.matricola = val.mat;
  data.prodotti = data.prodotti.map(x => x.id === id ? {...next, id: uid()} : x);
  await save();
}
const ECO = {col: null, err: "", at: null, src: ""};
async function ecoLoad() {
  if (role !== "admin") return;
  if (CLOUD) {
    try {
      const rows = await getAll("portale_doc", "col.asc,id.asc"), dati = {};
      rows.forEach(r => { (dati[r.col] = dati[r.col] || {})[r.id] = r.data || {}; });
      ECO.col = Eco.fromPortalFile({formato: "collaudi-seriali", versione: 1, salvato: null, dati}); ECO.err = ""; ECO.at = new Date(); ECO.src = "database";
    } catch (e) { ECO.col = null; ECO.err = "Non riesco a leggere i collaudi dal database: " + e.message + (e.http === 404 ? " (manca la tabella portale_doc: esegui lo script SQL)" : ""); }
    return ecoPaint();
  }
  if (!dir) { if (!ECO.col || ECO.src !== "file") { ECO.col = null; ECO.err = window.showDirectoryPicker ? "Collega la cartella in alto: deve essere la stessa del portale Collaudi e Seriali, dove c'è il file dati-collaudi.json. In alternativa carica il file a mano." : "Questo dispositivo non può collegare cartelle: carica a mano il file dati-collaudi.json del portale."; } return ecoPaint(); }
  try {
    const txt = await (await (await dir.getFileHandle("dati-collaudi.json")).getFile()).text();
    ECO.col = Eco.fromPortalFile(JSON.parse(txt)); ECO.err = ""; ECO.at = new Date(); ECO.src = "cartella";
  } catch (e) {
    ECO.col = null;
    ECO.err = e && e.name === "NotFoundError" ? `Nella cartella «${dir.name}» non c'è dati-collaudi.json: collega la stessa cartella usata dal portale Collaudi e Seriali.` : "Non riesco a leggere dati-collaudi.json: " + ((e && e.message) || "errore");
  }
  ecoPaint();
}
function ecoPaint() {
  const st = $("#ecoStat"), host = $("#ecoHost"); if (!st || !host) return;
  if (!ECO.col) { st.textContent = ECO.err || "Leggo i collaudi del portale…"; host.innerHTML = ""; return; }
  const m = Eco.compute({prod: Eco.indexProd(data), col: ECO.col, cfg: ECO.col.cfg});
  const t = d => d.toLocaleString("it-IT", {dateStyle: "short", timeStyle: "short"});
  st.textContent = `Collaudi letti ${ECO.src === "file" ? "dal file caricato" : ECO.src === "database" ? "dal database" : "da dati-collaudi.json"} alle ${ECO.at.toLocaleTimeString("it-IT", {hour: "2-digit", minute: "2-digit"})}` + (ECO.col.salvato ? ` (salvato dal portale il ${t(new Date(ECO.col.salvato))})` : "") + ". La pianificazione si fa nel portale; qui vedi l'avanzamento con i turni registrati.";
  host.innerHTML = Eco.dashboard(m, {portal: false});
}
$("#ecoRefresh").onclick = () => { if (dir || CLOUD) ecoLoad(); else ecoPaint(); };
if (CLOUD) { $("#ecoFileBtn").classList.add("hidden"); $("#ecoPortal").classList.remove("hidden"); }
$("#ecoFileBtn").onclick = () => $("#ecoFile").click();
$("#ecoFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { ECO.col = Eco.fromPortalFile(JSON.parse(await f.text())); ECO.err = ""; ECO.at = new Date(); ECO.src = "file"; }
  catch (er) { ECO.col = null; ECO.err = "File non valido: " + er.message; }
  ecoPaint();
};
document.addEventListener("visibilitychange", () => { if (!document.hidden && role === "admin" && page === "collaudi" && (dir || CLOUD)) ecoLoad(); });

/* ---------- Avvio ---------- */
(async () => {
  if (CLOUD) {
    try { const c = localStorage.getItem(LS); if (c) data = {...data, ...JSON.parse(c)}; } catch {}
    $("#u").placeholder = "Email"; loadSess();
    setInterval(() => { if (sess && cloudPending()) pushCloud(); }, 30000);
    addEventListener("online", () => sess && pushCloud());
    document.addEventListener("visibilitychange", () => { if (sess && !document.hidden) syncNow(true); });
    if (!sess || !["admin", "operatore"].includes(sess.role)) { document.documentElement.classList.remove("sess"); return; }
    /* subito con gli ultimi dati salvati sul dispositivo: niente schermata di accesso mentre si scaricano quelli nuovi */
    start(sess.role); cloudStatus();
    let err = "";
    try { if (Date.now() > sess.exp) await refresh(); await pullCloud(); }
    catch (e) { if (e.auth || e.http === 401) { sess = null; role = null; localStorage.removeItem(LSS); document.documentElement.classList.remove("sess"); $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); return; } err = e.message; }
    cloudStatus(err); if (!(role === "operatore" && opBusy())) render(); pushCloud(); return;
  }
  folderStatus("none");
  if (!sessionStorage.getItem("ruolo")) document.documentElement.classList.remove("sess");
  try { const s = localStorage.getItem(LS); if (s) data = {...data, ...JSON.parse(s)}; } catch {}
  const h = await kvGet("dir").catch(() => null);
  if (h) {
    if (await h.queryPermission({mode: "readwrite"}) === "granted") await connect(h);
    else folderStatus("need", h.name);
  }
  const r = sessionStorage.getItem("ruolo"); if (r) start(r);
})();
