/* ===================== SUPABASE ===================== */
const CFG = window.APP_CONFIG || {};
const SUPA_URL = CFG.supabaseUrl || '';
const SUPA_KEY = CFG.supabaseKey || '';
if (!SUPA_URL || !SUPA_KEY) {
  document.body.className = '';
  document.body.innerHTML = '<div class="config-mancante"><h1>Configurazione mancante</h1><p>Gestione Stampi lavora solo online: crea <code>shared/js/config.js</code> partendo da <code>config.example.js</code> con URL e chiave publishable del progetto Supabase.</p></div>';
  throw new Error('Gestione Stampi: configurazione Supabase mancante');
}
const sb = supabase.createClient(SUPA_URL, SUPA_KEY);
let ruolo = '', utente = '';

/* ===================== DATI ===================== */
const STATI = {
  magazzino:      {label:'In magazzino',        short:'Magazzino'},
  pressa:         {label:'Alla pressa',         short:'Pressa'},
  manutenzione:   {label:'In manutenzione',     short:'Manutenzione'},
  partner:        {label:'Presso partner',      short:'Partner'},
  coproprietario: {label:'Dal coproprietario',  short:'Coproprietario'}
};
const ICO = {
  magazzino:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8M7 17h10"/></svg>',
  pressa:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="5" rx="1"/><path d="M12 7v4M7 11h10v3H7zM5 22h14M7 14v8M17 14v8"/></svg>',
  manutenzione:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.7 5.3a4 4 0 0 0 5 5L19 12l-8 8-3.5-3.5 6-6-1-1-6 6L3 12l8-8z"/></svg>',
  partner:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 21V10l6 4V10l6 4V6l8-3v18z"/><path d="M6 17h2M11 17h2M16 17h2"/></svg>',
  coproprietario:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h14v12H1zM15 9h4l3 3v4h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>',
  pin:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  close:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  cam:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  arrow:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted)"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  box:'<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  q:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>'
};

let DB = {stampi:[], movimenti:[], soggetti:[]};
let RAW = {stampi:[], movimenti:[], soggetti:[]};
let online = true, loaded = false;

const fromS = r => ({id:r.id, codice:r.codice||'', nome:r.nome||'', descrizione:r.descrizione||'', zona:r.zona||'', scaffale:r.scaffale||'',
  ripiano:r.ripiano||'', coproprietario:r.coproprietario||'', note:r.note||'', stato:r.stato||'magazzino', pressa:r.pressa||'',
  destinazione:r.destinazione||'', presse:r.presse_predisposte||'', statoDal:r.stato_dal, creato:r.creato, aggiornato:r.aggiornato});
const fromM = r => ({id:r.id, stampoId:r.stampo_id, nome:r.nome||'', codice:r.codice||'', tipo:r.tipo, da:r.da||'', daPressa:r.da_pressa||'',
  daDest:r.da_dest||'', a:r.a, pressa:r.pressa||'', dest:r.dest||'', dettaglio:r.dettaglio||'', utente:r.utente||'', data:r.data});

async function loadAll(){
  const [a, b, c] = await Promise.all([
    sb.from('stampi').select('*'),
    sb.from('stampi_movimenti').select('*').order('data', {ascending:false}).limit(3000),
    sb.from('stampi_soggetti').select('*').order('nome')
  ]);
  if(a.error || b.error){
    online = false; renderHome();
    toast('Connessione al database non riuscita', 'err');
    return;
  }
  online = true; loaded = true;
  RAW = {stampi:a.data, movimenti:b.data, soggetti:c.error ? [] : c.data};
  DB.soggetti = RAW.soggetti.map(r => ({id:r.id, tipo:r.tipo, nome:r.nome||'', referente:r.referente||'', telefono:r.telefono||'', email:r.email||'', note:r.note||''}));
  DB.stampi = a.data.map(fromS);
  DB.movimenti = b.data.map(fromM);
  renderAll();
  if(modalView === 'stampo' && cur) renderStampo();
  if(c.error) console.warn('anagrafiche', c.error);
}
let reloadT;
function scheduleReload(){ clearTimeout(reloadT); reloadT = setTimeout(loadAll, 400); }
let channel;
function subscribe(){
  if(channel) return;
  channel = sb.channel('gestione-stampi')
    .on('postgres_changes', {event:'*', schema:'public', table:'stampi'}, scheduleReload)
    .on('postgres_changes', {event:'*', schema:'public', table:'stampi_movimenti'}, scheduleReload)
    .on('postgres_changes', {event:'*', schema:'public', table:'stampi_soggetti'}, scheduleReload)
    .subscribe();
}

/* ===================== ACCESSO ===================== */
async function initAuth(){
  const {data:{session}} = await sb.auth.getSession();
  if(session) enter(session); else showLogin();
  sb.auth.onAuthStateChange((ev, s) => {
    if(ev === 'SIGNED_OUT') showLogin();
    if(ev === 'PASSWORD_RECOVERY' && s){ setTimeout(async () => { if(!ruolo) await enter(s); openPassword(true); }, 0); return; }
    if(ev === 'SIGNED_IN' && s && !ruolo) enter(s);
  });
}
function showLogin(msg=''){
  ruolo = ''; utente = '';
  if(channel){ sb.removeChannel(channel); channel = null; }
  document.body.classList.add('logged-out');
  $('#lerr').textContent = msg;
  setTimeout(() => $('#lemail').focus(), 50);
}
async function doLogin(e){
  e.preventDefault();
  const btn = $('#lbtn');
  btn.disabled = true; $('#lerr').textContent = '';
  const {data, error} = await sb.auth.signInWithPassword({email:$('#lemail').value.trim(), password:$('#lpass').value});
  btn.disabled = false;
  if(error){ $('#lerr').textContent = 'Email o password non corretti.'; return; }
  $('#lpass').value = '';
  enter(data.session);
}
async function enter(session){
  const r = (session.user.app_metadata || {}).ruolo || '';
  if(!['admin','operatore'].includes(r)){
    await sb.auth.signOut();
    showLogin('Questo utente non ha un ruolo abilitato (admin o operatore).');
    return;
  }
  ruolo = r; utente = session.user.email;
  document.body.classList.remove('logged-out');
  document.body.classList.toggle('is-admin', ruolo === 'admin');
  $('#who').innerHTML = `<b>${esc(utente)}</b><span>${ruolo === 'admin' ? 'Amministratore' : 'Operatore'}</span>`;
  await loadAll();
  subscribe();
}
async function logout(){ closeModal(); await sb.auth.signOut(); }

/* Cambio password: da utente collegato o dal link "reimposta password" ricevuto via email */
function openPassword(recovery=false){
  cur = null;
  openModal(`${head('Cambia password', esc(utente))}
    ${recovery ? '<div class="notice">Hai aperto il link di reimpostazione: scegli la nuova password.</div>' : ''}
    <div class="form" style="grid-template-columns:1fr">
      <div class="field"><label>Nuova password</label><input id="np1" type="password" autocomplete="new-password"></div>
      <div class="field"><label>Ripeti la nuova password</label><input id="np2" type="password" autocomplete="new-password"></div>
    </div>
    <p class="hint">Almeno 10 caratteri, con lettere e numeri. Vale per tutto l'ecosistema (produzione, collaudi, stampi).</p>
    <div class="err-text" id="nperr"></div>
    <div class="form-actions"><button class="btn ghost" onclick="closeModal()">Annulla</button><button class="btn primary" onclick="savePassword()">Salva password</button></div>`, 'password');
  setTimeout(() => $('#np1').focus(), 60);
}
async function savePassword(){
  const a = $('#np1').value, b = $('#np2').value, err = $('#nperr');
  if(a.length < 10 || !/[a-z]/i.test(a) || !/\d/.test(a)){ err.textContent = 'Usa almeno 10 caratteri, con lettere e numeri.'; return; }
  if(a !== b){ err.textContent = 'Le due password non coincidono.'; return; }
  busy(true);
  const {error} = await sb.auth.updateUser({password:a});
  if(error){ busy(false); err.textContent = /same|different/i.test(error.message) ? 'La nuova password deve essere diversa da quella attuale.' : errMsg(error); return; }
  if(location.hash) history.replaceState(null, '', location.pathname);
  toast('Password aggiornata', 'ok'); closeModal();
}

/* ===================== UTILITY ===================== */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
function esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(iso, withTime=true){
  if(!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'});
  return withTime ? date + ' ' + d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}) : date;
}
function getS(id){ return DB.stampi.find(s => s.id === id); }
function posizione(s){
  const p = [];
  if(s.zona) p.push('Zona ' + s.zona);
  if(s.scaffale) p.push('Scaffale ' + s.scaffale);
  if(s.ripiano) p.push('Ripiano ' + s.ripiano);
  return p.length ? p.join(' · ') : '—';
}
function statoLabel(s){
  switch(s.stato){
    case 'pressa': return 'Installato alla pressa ' + s.pressa;
    case 'manutenzione': return 'In manutenzione' + (s.destinazione ? ' · ' + s.destinazione : '');
    case 'coproprietario': return 'Spedito a ' + (s.destinazione || 'coproprietario');
    case 'partner': return 'Presso il partner ' + (s.destinazione || '');
    default: return 'In magazzino';
  }
}
function badgeFor(stato, pressa, dest){
  let t = STATI[stato] ? STATI[stato].short : stato;
  if(stato === 'pressa' && pressa) t = 'Pressa ' + pressa;
  if((stato === 'coproprietario' || stato === 'partner') && dest) t = dest;
  return `<span class="badge st-${stato}">${esc(t)}</span>`;
}
function presseList(v){ return [...new Set(String(v||'').split(/[^0-9]+/).filter(Boolean).map(x => String(+x)))]; }
function presseTxt(s){ const l = presseList(s.presse); return l.length ? (l.length === 1 ? 'Pressa ' : 'Presse ') + l.join(', ') : ''; }
function nomeMov(m){ const s = getS(m.stampoId); return s ? s.nome : m.nome; }
function coproprietari(){
  const set = new Set(DB.soggetti.filter(x => x.tipo === 'coproprietario').map(x => x.nome));
  DB.stampi.forEach(s => s.coproprietario && set.add(s.coproprietario));
  DB.movimenti.forEach(m => m.a === 'coproprietario' && m.dest && set.add(m.dest));
  return [...set].sort((a,b) => a.localeCompare(b,'it'));
}
function genCode(){
  let max = 0;
  DB.stampi.forEach(s => { const m = /^ST(\d+)$/i.exec(s.codice || ''); if(m) max = Math.max(max, +m[1]); });
  return 'ST' + String(max + 1).padStart(6,'0');
}
let toastT;
function toast(msg, type=''){
  const t = $('#toast');
  t.textContent = msg; t.className = 'show ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3000);
}
function errMsg(e){
  if(!e) return 'Errore sconosciuto';
  if(e.code === '23505') return 'Codice già associato a un altro stampo.';
  if(e.code === '42501') return 'Operazione non consentita per il tuo profilo.';
  if(/fetch|network/i.test(e.message || '')) return 'Connessione assente: riprova.';
  return e.message || String(e);
}
function busy(on){ $('#sheet').classList.toggle('busy', on); }
let audioCtx;
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1320; g.gain.value = .08;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + .09);
  }catch(e){}
  if(navigator.vibrate) navigator.vibrate(50);
}

/* ===================== NAVIGAZIONE ===================== */
let filtro = 'tutti', cerca = '';
function show(v){
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  document.querySelectorAll('.nav button[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  renderAll();
  window.scrollTo(0,0);
}
function renderAll(){ renderHome(); renderStampi(); renderSoggetti(); renderMovimenti(); renderBackup(); }

/* ===================== HOME ===================== */
function counts(){
  const c = {tutti:DB.stampi.length, magazzino:0, pressa:0, manutenzione:0, partner:0, coproprietario:0};
  DB.stampi.forEach(s => c[s.stato] = (c[s.stato]||0) + 1);
  return c;
}
function renderHome(){
  const c = counts();
  $('#tiles').innerHTML = Object.keys(STATI).map(k =>
    `<button class="tile ${k}" onclick="openStato('${k}')"><b>${c[k]}</b><span>${STATI[k].label}</span></button>`).join('');
  $('#home-mov').innerHTML = movRows(DB.movimenti.slice(0,6)) ||
    `<div class="empty">${loaded ? 'Nessun movimento registrato. Crea il primo stampo o spara un codice.' : 'Caricamento…'}</div>`;
  $('#storage-warn').innerHTML = online ? '' :
    `<div class="notice err">Connessione al database assente. Controlla la rete del tablet.<button class="btn ghost" style="min-height:42px;padding:8px 14px" onclick="loadAll()">Riprova</button></div>`;
}

/* ---- Dettaglio stato (dai riquadri della dashboard) ---- */
function giorni(iso){
  if(!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return d <= 0 ? 'oggi' : d === 1 ? 'da 1 giorno' : 'da ' + d + ' giorni';
}
function openStato(k){
  cur = null;
  let list = DB.stampi.filter(s => s.stato === k);
  if(k === 'pressa') list.sort((a,b) => (+a.pressa||0) - (+b.pressa||0) || a.nome.localeCompare(b.nome,'it',{numeric:true}));
  else if(k === 'magazzino') list.sort((a,b) => posizione(a).localeCompare(posizione(b),'it',{numeric:true}) || a.nome.localeCompare(b.nome,'it',{numeric:true}));
  else list.sort((a,b) => new Date(a.statoDal) - new Date(b.statoDal));
  const colTit = {pressa:'Pressa', magazzino:'Posizione', manutenzione:'Presso', partner:'Partner', coproprietario:'Coproprietario'}[k];
  const det = s => k === 'pressa' ? '<span class="press-num">' + esc(s.pressa) + '</span>'
    : k === 'magazzino' ? esc(posizione(s))
    : esc(s.destinazione || '—');
  const ultimo = s => { const m = DB.movimenti.find(m => m.stampoId === s.id && m.a === s.stato); return m && m.dettaglio && m.tipo !== 'nuovo' ? m.dettaglio : ''; };
  openModal(`${head(STATI[k].label + ' · ' + list.length, k === 'pressa' ? 'Ordinati per numero di pressa' : k === 'magazzino' ? 'Ordinati per posizione' : 'I più vecchi in alto')}
    ${list.length ? `<div class="d-list">
      <div class="d-row d-headrow"><span>Stampo</span><span>${colTit}</span><span>Dal</span></div>
      ${list.map(s => `<button class="d-row st-row-${k}" onclick="openStampo('${s.id}')">
        <span><b>${esc(s.nome)}</b><small>${s.codice ? esc(s.codice) : 'senza codice'}${ultimo(s) && k !== 'pressa' ? ' · ' + esc(ultimo(s)) : ''}</small></span>
        <span>${det(s)}</span>
        <span>${fmt(s.statoDal,false)}<small>${giorni(s.statoDal)}</small></span>
      </button>`).join('')}
    </div>` : `<div class="empty">Nessuno stampo ${STATI[k].label.toLowerCase()}.</div>`}
    <div class="form-actions"><button class="btn ghost" onclick="closeModal();filtro='${k}';show('stampi')">Apri nell'elenco stampi</button></div>`, 'stato');
}

/* ===================== ELENCO STAMPI ===================== */
function renderStampi(){
  const c = counts();
  const chipsDef = [['tutti','Tutti'],['magazzino','In magazzino'],['pressa','Alla pressa'],['manutenzione','In manutenzione'],['partner','Presso partner'],['coproprietario','Dal coproprietario']];
  $('#chips').innerHTML = chipsDef.map(([k,l]) =>
    `<button class="chip ${filtro===k?'active':''}" onclick="filtro='${k}';renderStampi()">${l}<em>${c[k]||0}</em></button>`).join('');
  const q = cerca.trim().toLowerCase();
  const list = DB.stampi
    .filter(s => filtro === 'tutti' || s.stato === filtro)
    .filter(s => !q || [s.nome,s.codice,s.descrizione,s.zona,s.scaffale,s.ripiano,s.coproprietario,s.destinazione,s.stato==='pressa'?'pressa '+s.pressa:'',presseList(s.presse).map(n=>'pressa '+n).join(' ')]
        .some(v => String(v||'').toLowerCase().includes(q)))
    .sort((a,b) => a.nome.localeCompare(b.nome,'it',{numeric:true}));
  $('#grid').innerHTML = list.length ? list.map(s => `
    <button class="s-card ${s.stato}" onclick="openStampo('${s.id}')">
      <div class="top"><div><div class="name">${esc(s.nome)}</div><div class="code">${s.codice ? esc(s.codice) : 'senza codice'}</div></div>${badgeFor(s.stato,s.pressa,s.destinazione)}</div>
      ${s.descrizione ? `<div style="font-size:14px">${esc(s.descrizione.slice(0,90))}</div>` : ''}
      <div class="loc">${ICO.pin}${esc(posizione(s))}</div>
      ${presseTxt(s) ? `<div class="loc">${ICO.pressa.replace(/26/g,'16')}Predisposto: ${esc(presseList(s.presse).join(', '))}</div>` : ''}
    </button>`).join('')
    : `<div class="empty card" style="grid-column:1/-1">${ICO.box}<div>${DB.stampi.length ? 'Nessuno stampo corrisponde alla ricerca.' : 'Nessuno stampo in anagrafica. Inizia con "Nuovo stampo".'}</div></div>`;
}

/* ===================== ANAGRAFICHE MANUTENTORI / COPROPRIETARI ===================== */
const TIPI = {coproprietario:{plur:'Coproprietari', sing:'coproprietario', nuovo:'Nuovo coproprietario', stato:'coproprietario'},
              partner:{plur:'Partner', sing:'partner', nuovo:'Nuovo partner', stato:'partner'},
              manutentore:{plur:'Manutentori', sing:'manutentore', nuovo:'Nuovo manutentore', stato:'manutenzione'}};
let sogTipo = 'coproprietario';
const norm = v => String(v || '').trim().toLowerCase();
function stampiDi(x){
  return x.tipo === 'coproprietario'
    ? DB.stampi.filter(s => norm(s.coproprietario) === norm(x.nome) || (s.stato === 'coproprietario' && norm(s.destinazione) === norm(x.nome)))
    : DB.stampi.filter(s => s.stato === TIPI[x.tipo].stato && norm(s.destinazione) === norm(x.nome));
}
function renderSoggetti(){
  if(!$('#sog-grid')) return;
  $('#sog-tabs').innerHTML = Object.keys(TIPI).map(k =>
    `<button class="chip ${sogTipo===k?'active':''}" onclick="sogTipo='${k}';renderSoggetti()">${TIPI[k].plur}<em>${DB.soggetti.filter(x => x.tipo===k).length}</em></button>`).join('');
  $('#sog-new-lbl').textContent = TIPI[sogTipo].nuovo;
  const q = norm($('#qs').value);
  const list = DB.soggetti.filter(x => x.tipo === sogTipo)
    .filter(x => !q || [x.nome, x.referente, x.telefono, x.email, x.note].some(v => norm(v).includes(q)))
    .sort((a,b) => a.nome.localeCompare(b.nome, 'it', {numeric:true}));
  $('#sog-grid').innerHTML = list.length ? list.map(x => {
    const n = stampiDi(x).length;
    const lab = x.tipo === 'coproprietario' ? (n === 1 ? '1 stampo' : n + ' stampi')
      : x.tipo === 'partner' ? (n ? (n === 1 ? '1 stampo' : n + ' stampi') + ' da lui ora' : 'nessuno stampo ora')
      : (n ? n + ' in manutenzione ora' : 'nessuno stampo in manutenzione');
    return `<button class="s-card sog-card ${x.tipo}" onclick="openSoggetto('${x.id}')">
      <div class="top"><div class="name">${esc(x.nome)}</div><span class="badge st-${TIPI[x.tipo].stato}">${esc(lab)}</span></div>
      ${x.referente ? `<div class="loc">${esc(x.referente)}</div>` : ''}
      ${(x.telefono || x.email) ? `<div class="loc">${[x.telefono, x.email].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </button>`; }).join('')
    : `<div class="empty card" style="grid-column:1/-1">${ICO.box}<div>${q ? 'Nessuna società corrisponde alla ricerca.' : 'Nessun ' + TIPI[sogTipo].sing + ' in anagrafica. Aggiungilo con il pulsante qui sopra, oppure scrivilo la prima volta che invii uno stampo: viene salvato in automatico.'}</div></div>`;
}
function openSoggetto(id, tipo){
  const x = id ? DB.soggetti.find(y => y.id === id) : {tipo:tipo || sogTipo, nome:'', referente:'', telefono:'', email:'', note:''};
  if(!x) return;
  cur = null;
  const coll = id ? stampiDi(x) : [];
  openModal(`${head(id ? esc(x.nome) : TIPI[x.tipo].nuovo, id ? TIPI[x.tipo].sing.charAt(0).toUpperCase() + TIPI[x.tipo].sing.slice(1) : 'Anagrafica società')}
    ${id ? '' : `<div class="seg" id="sg-tipo">${Object.keys(TIPI).map(k => `<button type="button" class="${x.tipo===k?'on':''}" data-t="${k}" onclick="this.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===this))">${TIPI[k].sing.charAt(0).toUpperCase()+TIPI[k].sing.slice(1)}</button>`).join('')}</div>`}
    <div class="form">
      <div class="field full"><label>Ragione sociale <i>*</i></label><input id="sg-nome" value="${esc(x.nome)}" placeholder="Es. Rossi Stampi Srl"></div>
      <div class="field"><label>Referente</label><input id="sg-ref" value="${esc(x.referente)}" placeholder="Facoltativo"></div>
      <div class="field"><label>Telefono</label><input id="sg-tel" type="tel" value="${esc(x.telefono)}" placeholder="Facoltativo"></div>
      <div class="field"><label>Email</label><input id="sg-mail" type="email" value="${esc(x.email)}" placeholder="Facoltativo"></div>
      <div class="field full"><label>Note</label><input id="sg-note" value="${esc(x.note)}" placeholder="Es. indirizzo di spedizione, orari"></div>
    </div>
    ${id ? `<h4 style="margin-top:20px">${x.tipo==='coproprietario' ? 'Stampi in comproprietà' : x.tipo==='partner' ? 'Stampi presso il partner ora' : 'Stampi in manutenzione ora'} (${coll.length})</h4>
      ${coll.length ? `<div class="d-list">${coll.map(s => `<button class="d-row sog-row" onclick="openStampo('${s.id}')"><span><b>${esc(s.nome)}</b><small>${esc(s.codice || 'senza codice')}</small></span><span>${badgeFor(s.stato, s.pressa, s.destinazione)}</span><span>${fmt(s.statoDal,false)}</span></button>`).join('')}</div>` : '<p class="hint">Nessuno.</p>'}` : ''}
    <div class="err-text" id="sgerr"></div>
    <div class="form-actions">
      ${id ? (ruolo === 'admin' ? `<button class="btn danger" onclick="delSoggetto('${id}')">Elimina</button>` : '') : `<button class="btn ghost" onclick="closeModal()">Annulla</button>`}
      <button class="btn primary" onclick="saveSoggetto(${id ? `'${id}'` : 'null'}, '${x.tipo}')">${id ? 'Salva modifiche' : 'Aggiungi'}</button>
    </div>`, 'soggetto');
  if(!id) setTimeout(() => $('#sg-nome').focus(), 60);
}
async function saveSoggetto(id, tipoOrig){
  const v = k => $(k).value.trim();
  const tipo = id ? tipoOrig : ($('#sg-tipo .on') || {}).dataset?.t || tipoOrig;
  const data = {tipo, nome:v('#sg-nome'), referente:v('#sg-ref'), telefono:v('#sg-tel'), email:v('#sg-mail'), note:v('#sg-note')};
  const err = $('#sgerr');
  if(!data.nome){ err.textContent = 'Inserisci la ragione sociale.'; return; }
  const dup = DB.soggetti.find(y => y.id !== id && y.tipo === tipo && norm(y.nome) === norm(data.nome));
  if(dup){ err.textContent = '"' + dup.nome + '" è già tra i ' + TIPI[tipo].plur.toLowerCase() + '.'; return; }
  busy(true);
  const now = new Date().toISOString();
  let error;
  if(id){
    const old = DB.soggetti.find(y => y.id === id);
    ({error} = await sb.from('stampi_soggetti').update({...data, aggiornato:now}).eq('id', id));
    // ragione sociale corretta: aggiorna anche gli stampi che la usano
    if(!error && old && old.nome !== data.nome){
      if(tipo === 'coproprietario') await sb.from('stampi').update({coproprietario:data.nome}).eq('coproprietario', old.nome);
      await sb.from('stampi').update({destinazione:data.nome}).eq('destinazione', old.nome).eq('stato', TIPI[tipo].stato);
    }
  } else {
    ({error} = await sb.from('stampi_soggetti').insert(data));
  }
  if(error){ busy(false); err.textContent = error.code === '23505' ? 'Società già presente.' : errMsg(error); return; }
  sogTipo = tipo;
  await loadAll(); toast(id ? 'Anagrafica aggiornata' : data.nome + ' aggiunto ai ' + TIPI[tipo].plur.toLowerCase(), 'ok'); closeModal();
}
async function delSoggetto(id){
  const x = DB.soggetti.find(y => y.id === id); if(!x) return;
  if(!confirm('Eliminare "' + x.nome + '" dai ' + TIPI[x.tipo].plur.toLowerCase() + '? Gli stampi e lo storico non cambiano.')) return;
  busy(true);
  const {error} = await sb.from('stampi_soggetti').delete().eq('id', id);
  if(error){ busy(false); toast(errMsg(error), 'err'); return; }
  await loadAll(); toast('Eliminato'); closeModal();
}
/* aggiunge in silenzio un nome nuovo all'anagrafica (se c'è già, non fa nulla) */
async function ensureSoggetto(tipo, nome){
  nome = String(nome || '').trim();
  if(!nome || DB.soggetti.some(x => x.tipo === tipo && norm(x.nome) === norm(nome))) return;
  const {error} = await sb.from('stampi_soggetti').insert({tipo, nome});
  if(error && error.code !== '23505') console.warn(error);
}

/* ---- Suggerimenti mentre si scrive ---- */
let acBox = null, acInput = null, acIdx = -1, acItems = [];
function acMatches(tipo, q){
  q = norm(q);
  const list = DB.soggetti.filter(x => x.tipo === tipo);
  if(!q) return list.sort((a,b) => a.nome.localeCompare(b.nome,'it')).slice(0, 8);
  const score = x => { const n = norm(x.nome); return n.startsWith(q) ? 0 : n.split(/[\s.\-&]+/).some(w => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : (norm(x.referente).includes(q) ? 3 : 9); };
  return list.map(x => [score(x), x]).filter(a => a[0] < 9).sort((a,b) => a[0]-b[0] || a[1].nome.localeCompare(b[1].nome,'it')).slice(0, 8).map(a => a[1]);
}
function acHi(nome, q){
  const i = norm(nome).indexOf(norm(q));
  if(!q || i < 0) return esc(nome);
  return esc(nome.slice(0,i)) + '<b>' + esc(nome.slice(i, i + q.length)) + '</b>' + esc(nome.slice(i + q.length));
}
function acShow(inp){
  const tipo = inp.dataset.suggest, q = inp.value.trim();
  acInput = inp; acIdx = -1;
  const res = acMatches(tipo, q);
  const exact = res.some(x => norm(x.nome) === norm(q));
  acItems = res.map(x => ({nome:x.nome, sub:x.referente}));
  if(q && !exact) acItems.push({nuovo:true, nome:q});
  if(!acBox){ acBox = document.createElement('div'); acBox.className = 'ac-list'; acBox.setAttribute('role','listbox'); }
  if(!acItems.length){ acHide(); return; }
  acBox.innerHTML = acItems.map((it, i) => it.nuovo
    ? `<div class="ac-item ac-new" data-i="${i}">+ Aggiungi «${esc(it.nome)}» ai ${TIPI[tipo].plur.toLowerCase()}</div>`
    : `<div class="ac-item" data-i="${i}"><span>${acHi(it.nome, q)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`).join('');
  const wrap = inp.parentNode; wrap.classList.add('ac-wrap');
  if(acBox.parentNode !== wrap) wrap.appendChild(acBox);
  acBox.style.top = (inp.offsetTop + inp.offsetHeight + 4) + 'px';
  acBox.style.left = inp.offsetLeft + 'px'; acBox.style.width = inp.offsetWidth + 'px';
  acBox.hidden = false;
}
function acHide(){ if(acBox){ acBox.hidden = true; } acIdx = -1; }
function acPick(i){
  const it = acItems[i]; if(!it || !acInput) return;
  acInput.value = it.nome;
  if(it.nuovo){ ensureSoggetto(acInput.dataset.suggest, it.nome).then(() => { toast(it.nome + ' aggiunto ai ' + TIPI[acInput ? acInput.dataset.suggest : 'manutentore'].plur.toLowerCase(), 'ok'); scheduleReload(); }); }
  acHide();
}
document.addEventListener('input', e => { if(e.target.dataset && e.target.dataset.suggest) acShow(e.target); });
document.addEventListener('focusin', e => { if(e.target.dataset && e.target.dataset.suggest) acShow(e.target); else if(!e.target.closest('.ac-list')) acHide(); });
document.addEventListener('pointerdown', e => {
  const it = e.target.closest('.ac-item');
  if(it){ e.preventDefault(); acPick(+it.dataset.i); return; }
  if(acBox && !acBox.hidden && e.target !== acInput) acHide();
});
document.addEventListener('keydown', e => {
  if(!acBox || acBox.hidden || e.target !== acInput) return;
  const n = acItems.length;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    acBox.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('on', i === acIdx));
  } else if(e.key === 'Enter' && acIdx >= 0){ e.preventDefault(); acPick(acIdx); }
  else if(e.key === 'Escape'){ acHide(); }
}, true);

/* ===================== GUIDA OPERATORE ===================== */
const UI = (t, cls='') => `<span class="g-ui ${cls}">${t}</span>`;
const GUIDA = [
 ['accesso', 'Primo accesso', `
  <p class="lead">L'app si usa da telefono, tablet o PC con lo stesso account dell'ecosistema.</p>
  <ol class="g-steps">
   <li>Apri l'app dall'icona <b>Stampi</b> o dall'indirizzo che ti è stato dato.</li>
   <li>Inserisci <b>email</b> e <b>password</b> e tocca ${UI('Accedi','dark')}.</li>
   <li>Per averla sempre a portata, installala: su PC e Android tocca ${UI('Installa app','green')} nella barra in alto (sul telefono è nel menu ☰). Su iPhone, in Safari: <b>Condividi</b> → <b>Aggiungi a schermata Home</b>.</li>
  </ol>
  <div class="g-tip"><b>Password</b><span>Per cambiarla tocca l'icona a forma di chiave (sul telefono: menu ☰ → Password). Vale per tutte le app dell'ecosistema.</span></div>`],
 ['lettura', 'Leggere un codice', `
  <p class="lead">Ogni stampo ha un QR code o un barcode. Leggendolo si apre subito la sua scheda.</p>
  <div class="g-ways">
   <div class="g-way"><b>Lettore barcode</b><span>Dalla pagina <b>Scansiona</b> spara il codice: la scheda si apre da sola, non serve toccare nessun campo.</span></div>
   <div class="g-way"><b>Fotocamera</b><span>Tocca ${UI('Scansiona','dark')} (sul telefono è il pulsante in basso a destra) e inquadra il codice dentro il riquadro.</span></div>
   <div class="g-way"><b>A mano</b><span>Tocca ${UI('Inserisci il codice')}, scrivilo e tocca <b>Apri scheda</b>.</span></div>
  </div>
  <div class="g-tip"><b>Suono</b><span>Quando il codice viene letto senti un breve bip (e il telefono vibra).</span></div>`],
 ['nuovo', 'Nuovo stampo', `
  <p class="lead">Se leggi un codice che non esiste ancora, l'app ti propone di creare l'anagrafica con il codice già inserito.</p>
  <ol class="g-steps">
   <li>Tocca ${UI('Crea anagrafica con questo codice','dark')}, oppure ${UI('+ Nuovo stampo')} dalla home o dall'elenco.</li>
   <li><b>Codice</b>: spara il codice già presente sullo stampo, usa la fotocamera, oppure tocca ${UI('Genera')} se lo stampo non ha un codice (poi stampa l'etichetta, vedi <b>Etichetta QR</b>).</li>
   <li>Compila <b>Nome</b> e <b>Zona del magazzino</b> (obbligatori). Scaffale, ripiano, descrizione e note sono facoltativi.</li>
   <li><b>Predisposto per pressa</b>: scrivi il numero, o più numeri separati da virgola (es. <b>4, 7</b>).</li>
   <li><b>Coproprietario</b>: scrivi le prime lettere e scegli la società dai suggerimenti.</li>
   <li>Tocca ${UI('Crea stampo','dark')}.</li>
  </ol>
  <div class="g-tip"><b>Stampo senza codice?</b><span>Se leggi un codice nuovo e lo stampo è già in anagrafica senza codice, scegli lo stampo nella lista <b>Associa a uno stampo senza codice</b>.</span></div>`],
 ['stato', 'Aggiornare lo stato', `
  <p class="lead">Leggi il codice dello stampo e tocca lo stato nuovo nella scheda. Ogni cambio viene registrato con data, ora e nome di chi l'ha fatto.</p>
  <div class="g-states">
   <div class="g-state st-pressa"><b>${ICO.pressa}Installato alla pressa</b><span>Scegli il numero della pressa con il tastierino. Se lo stampo è predisposto, trovi le presse già pronte da toccare. Se la pressa è occupata da un altro stampo puoi riportare quello in magazzino con un tocco.</span></div>
   <div class="g-state st-manutenzione"><b>${ICO.manutenzione}Inviato in manutenzione</b><span>Scrivi le prime lettere dell'officina e scegli dai suggerimenti. Nel motivo puoi indicare il lavoro da fare.</span></div>
   <div class="g-state st-partner"><b>${ICO.partner}Inviato a partner</b><span>Quando un partner stampa per noi con il nostro stampo. Scegli il partner dai suggerimenti (viene proposto l'ultimo usato) e annota ordine o DDT.</span></div>
   <div class="g-state st-coproprietario"><b>${ICO.coproprietario}Spedito a coproprietario</b><span>Indica la società (obbligatoria) e, se vuoi, il numero del DDT nelle note.</span></div>
   <div class="g-state st-magazzino"><b>${ICO.magazzino}Rientrato in magazzino</b><span>Conferma la posizione in cui lo riponi. Se lo metti in un posto diverso, correggi zona, scaffale o ripiano.</span></div>
  </div>
  <div class="g-tip warn"><b>Ho sbagliato</b><span>Registra subito lo stato corretto: nel registro restano entrambi i passaggi e si capisce cosa è successo.</span></div>`],
 ['cerca', 'Trovare uno stampo', `
  <ul class="g-list">
   <li>Apri <b>Stampi</b> e scrivi nella ricerca: nome, codice, zona, coproprietario o <b>pressa 7</b> per vedere cosa c'è (o può andare) sulla pressa 7.</li>
   <li>Usa i filtri <b>In magazzino</b>, <b>Alla pressa</b>, <b>In manutenzione</b>, <b>Presso partner</b>, <b>Dal coproprietario</b>.</li>
   <li>In home, tocca uno dei riquadri colorati: si apre l'elenco di quello stato. Manutenzione, partner e coproprietari mostrano da quanti giorni lo stampo è fuori (i più vecchi in alto).</li>
  </ul>`],
 ['etichetta', 'Etichetta QR', `
  <ol class="g-steps">
   <li>Apri la scheda dello stampo e tocca ${UI('Etichetta QR')}.</li>
   <li>Tocca ${UI('Stampa etichetta','dark')} e scegli la stampante.</li>
   <li>Attacca l'etichetta in un punto visibile, pulito e lontano da zone calde o da sfregamenti.</li>
  </ol>
  <div class="g-tip"><b>Consiglio</b><span>Prova a leggere l'etichetta appena attaccata: se si apre la scheda giusta, è tutto a posto.</span></div>`],
 ['societa', 'Manutentori, partner e coproprietari', `
  <p class="lead">Nella voce <b>Anagrafiche</b> trovi le società: officine di manutenzione, partner che stampano per noi e coproprietari degli stampi.</p>
  <ul class="g-list">
   <li>Mentre scrivi in un campo società, bastano le prime lettere per vedere i suggerimenti.</li>
   <li>Se la società non c'è, tocca <b>+ Aggiungi «…»</b>: viene salvata e la ritrovi la volta dopo.</li>
   <li>Aprendo una società vedi referente, telefono e gli stampi collegati.</li>
  </ul>`],
 ['registro', 'Movimenti', `
  <p>In <b>Movimenti</b> c'è il registro di tutti i passaggi, dal più recente: stampo, da dove a dove, chi e quando. Puoi cercare per stampo, pressa o società.</p>
  <p>Nella scheda di ogni stampo, in fondo, trovi il suo <b>Storico movimenti</b>.</p>`],
 ['problemi', 'Problemi frequenti', `
  <details class="g-faq"><summary>La fotocamera non si apre</summary><div>Quando il browser lo chiede, tocca <b>Consenti</b>. Se l'avevi negato: impostazioni del browser → Impostazioni sito → Fotocamera → consenti per questa app. Usa Chrome su Android, Safari su iPhone. In alternativa usa <b>Inserisci il codice</b>.</div></details>
  <details class="g-faq"><summary>Sparo con il lettore ma non succede nulla</summary><div>Probabilmente è selezionato un campo di testo: tocca uno spazio vuoto della pagina <b>Scansiona</b> e riprova. Il lettore deve essere impostato per inviare <b>Invio</b> alla fine del codice.</div></details>
  <details class="g-faq"><summary>«Codice già associato a un altro stampo»</summary><div>Quel codice è già su un altro stampo. Cercalo in <b>Stampi</b> per capire quale: se è un errore, correggi l'anagrafica dello stampo sbagliato.</div></details>
  <details class="g-faq"><summary>«Connessione assente» o dati che non si aggiornano</summary><div>Controlla Wi-Fi o rete dati e tocca <b>Riprova</b>. I dati sono online: quello che registri si vede subito anche sugli altri dispositivi.</div></details>
  <details class="g-faq"><summary>Non vedo il pulsante Elimina</summary><div>Eliminare stampi e società è riservato all'amministratore.<span class="g-role">admin</span></div></details>
  <details class="g-faq"><summary>Il riquadro o la pressa mostrano uno stato vecchio</summary><div>Qualcuno non ha registrato un passaggio. Leggi il codice dello stampo e registra lo stato attuale: il registro tiene traccia della correzione.</div></details>`]
];
const GUIDA_DA_VISTA = {scan:'lettura', stampi:'cerca', anagrafiche:'societa', movimenti:'registro', backup:'problemi'};
function openGuida(sez){
  toggleMenu(false);
  if(!sez){ const v = (document.querySelector('.view.active') || {}).id || ''; sez = GUIDA_DA_VISTA[v.replace('view-','')] || 'accesso'; }
  cur = null;
  openModal(`${head('Guida all\'uso', 'Gestione Stampi · per chi lavora in reparto e in magazzino')}
    <div class="g-layout">
      <nav class="g-toc" id="g-toc">${GUIDA.map(([id,t],i) => `<button data-g="${id}" onclick="guidaVai('${id}')"><em>${i+1}</em>${t}</button>`).join('')}</nav>
      <div class="g-body">${GUIDA.map(([id,t,body],i) => `<section class="g-sec" id="g-${id}"><h3><em>${i+1}</em>${t}</h3>${body}</section>`).join('')}</div>
    </div>`, 'guida');
  const sh = $('#sheet'); sh.classList.add('guida');
  sh.style.setProperty('--gh', $('.sheet.guida .m-head').offsetHeight + 'px');
  sh.onscroll = guidaSpy;
  requestAnimationFrame(() => guidaVai(sez, true));
}
function guidaVai(id, istant){
  const el = $('#g-' + id); if(!el) return;
  const sh = $('#sheet');
  const off = el.getBoundingClientRect().top - sh.getBoundingClientRect().top + sh.scrollTop - parseFloat(getComputedStyle(el).scrollMarginTop || 0);
  sh.scrollTo({top: Math.max(0, off), behavior: istant ? 'auto' : 'smooth'});
  guidaAttiva(id);
}
function guidaAttiva(id){
  document.querySelectorAll('#g-toc button').forEach(b => {
    const on = b.dataset.g === id; b.classList.toggle('on', on);
    const toc = $('#g-toc');
    if(on && getComputedStyle(toc).flexDirection === 'row') toc.scrollTo({left: b.offsetLeft - (toc.clientWidth - b.offsetWidth) / 2, behavior:'smooth'});
  });
}
let guidaT;
function guidaSpy(){
  clearTimeout(guidaT);
  guidaT = setTimeout(() => {
    const sh = $('#sheet'); if(!sh.classList.contains('guida')) return;
    const top = sh.scrollTop + parseFloat(getComputedStyle(sh).getPropertyValue('--gh') || 80) + 80;
    let curId = GUIDA[0][0];
    const base = sh.getBoundingClientRect().top - sh.scrollTop;
    GUIDA.forEach(([id]) => { const el = $('#g-' + id); if(el && el.getBoundingClientRect().top - base <= top) curId = id; });
    if(sh.scrollTop + sh.clientHeight >= sh.scrollHeight - 4) curId = GUIDA[GUIDA.length-1][0];
    guidaAttiva(curId);
  }, 60);
}

/* ===================== MOVIMENTI ===================== */
function movTarget(m){
  if(m.a === 'pressa') return badgeFor('pressa', m.pressa);
  if(m.a === 'coproprietario' || m.a === 'partner') return badgeFor(m.a, null, m.dest);
  return badgeFor(m.a);
}
function movRows(list){
  return list.map(m => `
    <div class="mov">
      <div class="when">${fmt(m.data,false)}<br>${new Date(m.data).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}</div>
      <div class="what"><b>${esc(nomeMov(m))}</b><small>${m.codice ? esc(m.codice) + ' · ' : ''}${m.tipo==='nuovo' ? 'Anagrafica creata' : esc(m.dettaglio)}${m.utente ? ' · ' + esc(m.utente.split('@')[0]) : ''}</small></div>
      <div class="flow">${m.da ? (m.da==='pressa' ? badgeFor('pressa', m.daPressa) : badgeFor(m.da, null, m.daDest)) + ICO.arrow : ''}${movTarget(m)}</div>
    </div>`).join('');
}
function renderMovimenti(){
  const q = ($('#qm').value || '').trim().toLowerCase();
  const list = DB.movimenti.filter(m => !q || [nomeMov(m),m.codice,m.dettaglio,m.dest,m.utente,m.pressa?'pressa '+m.pressa:'',STATI[m.a]?.label]
      .some(v => String(v||'').toLowerCase().includes(q))).slice(0,400);
  $('#mov-list').innerHTML = movRows(list) || `<div class="empty">Nessun movimento.</div>`;
}
function lastBackup(){ try{ return localStorage.getItem('stampi_lastbackup'); }catch(e){ return null; } }
function renderBackup(){
  const lb = lastBackup();
  $('#last-backup').textContent = lb ? 'Ultimo export da questo dispositivo: ' + fmt(lb) : '';
}

/* ===================== MODALE ===================== */
let cur = null, modalView = '', pressaVal = '';
/* blocca lo scorrimento della pagina sotto le finestre (anche su iPhone) */
let lockY = 0, locks = 0;
function lockScroll(){
  if(locks++) return;
  lockY = window.scrollY;
  document.documentElement.classList.add('lock');
  Object.assign(document.body.style, {position:'fixed', top:-lockY + 'px', left:'0', right:'0', width:'100%'});
}
function unlockScroll(){
  if(!locks || --locks) return;
  document.documentElement.classList.remove('lock');
  Object.assign(document.body.style, {position:'', top:'', left:'', right:'', width:''});
  window.scrollTo(0, lockY);
}
function toggleMenu(force){
  const open = typeof force === 'boolean' ? force : !document.body.classList.contains('menu-open');
  if(open === document.body.classList.contains('menu-open')) return;
  document.body.classList.toggle('menu-open', open);
  $('#menu-btn').setAttribute('aria-expanded', open);
  open ? lockScroll() : unlockScroll();
}
document.addEventListener('click', e => { if(e.target.closest('#nav button')) toggleMenu(false); });
function openModal(html, view=''){ const shx = $('#sheet'); shx.classList.remove('guida'); shx.onscroll = null; acHide(); if(acBox && acBox.parentNode) acBox.remove(); if(!$('#modal').classList.contains('open')) lockScroll(); modalView = view; $('#sheet').classList.remove('busy'); $('#sheet').innerHTML = html; $('#modal').classList.add('open'); $('#sheet').scrollTop = 0; }
function closeModal(){ if($('#modal').classList.contains('open')) unlockScroll(); $('#modal').classList.remove('open'); cur = null; modalView = ''; renderAll(); }
function head(title, sub, back){
  return `<div class="m-head">
    ${back ? `<button class="icon-btn" onclick="${back}">${ICO.back}</button>` : ''}
    <div class="grow"><div class="m-title">${title}</div>${sub ? `<div class="m-code">${sub}</div>` : ''}</div>
    <button class="icon-btn" onclick="closeModal()">${ICO.close}</button></div>`;
}
const jsq = v => JSON.stringify(v).replace(/'/g, '&#39;');

/* ---- Scansione ---- */
function onScan(raw){
  if(!ruolo) return;
  const code = String(raw || '').trim();
  if(!code) return;
  beep();
  const s = DB.stampi.find(x => (x.codice||'').toLowerCase() === code.toLowerCase());
  if(s){ openStampo(s.id); return; }
  const liberi = DB.stampi.filter(x => !x.codice).sort((a,b) => a.nome.localeCompare(b.nome,'it',{numeric:true}));
  cur = null;
  openModal(`${head('Codice non associato', esc(code))}
    <div class="state-banner st-manutenzione">${ICO.q}<div><b>Nessuno stampo ha questo codice</b><span>Crea una nuova anagrafica oppure associalo a uno stampo esistente senza codice.</span></div></div>
    <button class="btn primary block" onclick='openForm(null, ${jsq(code)})'>Crea anagrafica con questo codice</button>
    ${liberi.length ? `<h4 style="margin-top:22px">Associa a uno stampo senza codice</h4>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
      ${liberi.map(x => `<button class="s-card ${x.stato}" onclick='assocCode(${jsq(x.id)}, ${jsq(code)})'><div class="name">${esc(x.nome)}</div><div class="loc">${ICO.pin}${esc(posizione(x))}</div></button>`).join('')}
      </div>` : ''}`, 'scan');
}
async function assocCode(id, code){
  busy(true);
  const {error} = await sb.from('stampi').update({codice:code, aggiornato:new Date().toISOString()}).eq('id', id);
  if(error){ busy(false); toast(errMsg(error), 'err'); return; }
  await loadAll();
  toast('Codice associato a ' + getS(id).nome, 'ok');
  openStampo(id);
}
function openManual(){
  cur = null;
  openModal(`${head('Inserisci il codice')}
    <div class="field"><label>Codice QR o barcode</label>
    <input id="manual" data-scan="1" autocomplete="off" autocapitalize="characters" placeholder="Es. ST000012"></div>
    <p class="hint">Puoi anche sparare il codice con il lettore mentre il campo è selezionato.</p>
    <div class="form-actions"><button class="btn ghost" onclick="closeModal()">Annulla</button><button class="btn primary" onclick="onScan($('#manual').value)">Apri scheda</button></div>`, 'manual');
  setTimeout(() => $('#manual').focus(), 50);
}

/* ---- Scheda stampo ---- */
function openStampo(id){ cur = id; renderStampo(); }
function renderStampo(){
  const s = getS(cur); if(!s){ closeModal(); return; }
  const storico = DB.movimenti.filter(m => m.stampoId === s.id);
  const st = s.stato;
  openModal(`${head(esc(s.nome), s.codice ? esc(s.codice) : 'Nessun codice associato')}
    <div class="state-banner st-${st}">${ICO[st]}<div><b>${esc(statoLabel(s))}</b><span>dal ${fmt(s.statoDal)}</span></div></div>
    <div class="info-grid">
      <div class="full"><label>Descrizione</label><p>${esc(s.descrizione) || '—'}</p></div>
      <div><label>Posizione in magazzino</label><p>${esc(posizione(s))}</p></div>
      <div><label>Coproprietario</label><p>${esc(s.coproprietario) || '—'}</p></div>
      <div><label>Predisposto per pressa</label><p>${esc(presseList(s.presse).join(', ')) || '—'}</p></div>
      ${s.note ? `<div class="full"><label>Note</label><p>${esc(s.note)}</p></div>` : ''}
    </div>
    <h4>Aggiorna stato</h4>
    <div class="actions">
      <button class="act st-pressa" onclick="stepPressa()">${ICO.pressa}<span>Installato alla pressa</span><small>${st==='pressa' ? 'Ora sulla pressa ' + esc(s.pressa) + ' · tocca per cambiarla' : (presseTxt(s) ? 'Predisposto: ' + esc(presseList(s.presse).join(', ')) : 'Indica il numero della pressa')}</small></button>
      <button class="act st-manutenzione" ${st==='manutenzione'?'disabled':''} onclick="stepManut()">${ICO.manutenzione}<span>Inviato in manutenzione</span><small>Fornitore e motivo facoltativi</small></button>
      <button class="act st-partner" ${st==='partner'?'disabled':''} onclick="stepPartner()">${ICO.partner}<span>Inviato a partner</span><small>Stampaggio presso terzi</small></button>
      <button class="act st-coproprietario" ${st==='coproprietario'?'disabled':''} onclick="stepCopro()">${ICO.coproprietario}<span>Spedito a coproprietario</span><small>${s.coproprietario ? esc(s.coproprietario) : 'Indica a chi'}</small></button>
      <button class="act st-magazzino" ${st==='magazzino'?'disabled':''} onclick="stepRientro()">${ICO.magazzino}<span>Rientrato in magazzino</span><small>${esc(posizione(s))}</small></button>
    </div>
    <div class="m-foot">
      <button class="btn ghost" onclick="openForm('${s.id}')">Modifica anagrafica</button>
      <button class="btn ghost" onclick="openLabel('${s.id}')">Etichetta QR</button>
    </div>
    <details class="storico"><summary>Storico movimenti (${storico.length})</summary>
      ${storico.slice(0,30).map(m => `<div class="h-row"><div>${movTarget(m)} <small>${m.tipo==='nuovo' ? 'Anagrafica creata' : esc(m.dettaglio)}</small></div><small>${fmt(m.data)}${m.utente ? '<br>' + esc(m.utente.split('@')[0]) : ''}</small></div>`).join('') || '<p class="hint">Nessun movimento.</p>'}
    </details>`, 'stampo');
}

/* cambio di stato: aggiornamento stampo + movimento in un'unica operazione sul database */
async function cambiaStato(id, stato, o = {}){
  const {error} = await sb.rpc('stampi_cambia_stato', {
    p_id:id, p_stato:stato, p_pressa:o.pressa || '', p_dest:o.dest || '', p_dettaglio:o.dettaglio || '',
    p_zona:o.zona ?? null, p_scaffale:o.scaffale ?? null, p_ripiano:o.ripiano ?? null, p_copro:o.copro ?? null
  });
  if(error) throw error;
}
async function run(fn, okMsg){
  busy(true);
  try{ await fn(); await loadAll(); toast(okMsg, 'ok'); closeModal(); }
  catch(e){ busy(false); toast(errMsg(e), 'err'); }
}

/* ---- Step: pressa ---- */
function stepPressa(){
  const s = getS(cur);
  pressaVal = '';
  openModal(`${head('Installato alla pressa', esc(s.nome), 'renderStampo()')}
    <div class="kp-wrap">
      <div>
        <div class="kp-display"><small>Numero pressa</small><b id="pv">–</b></div>
        ${presseList(s.presse).length ? `<div class="kp-quick"><span>Predisposto per</span>${presseList(s.presse).map(n => `<button class="chip" onclick="pressaVal='${n}';updPressa()">Pressa ${n}</button>`).join('')}</div>` : ''}
        <div class="warn" id="pwarn"></div>
        <button class="btn primary block" id="pok" style="margin-top:14px" disabled onclick="confirmPressa(false)">Conferma installazione</button>
      </div>
      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button onclick="kp('${n}')">${n}</button>`).join('')}
        <button class="fn" onclick="kp('C')">C</button><button onclick="kp('0')">0</button><button class="fn" onclick="kp('B')">⌫</button>
      </div>
    </div>`, 'step');
}
function kp(d){
  if(d === 'C') pressaVal = '';
  else if(d === 'B') pressaVal = pressaVal.slice(0,-1);
  else if(pressaVal.length < 4) pressaVal = (pressaVal === '0' ? '' : pressaVal) + d;
  updPressa();
}
function occupante(n){ return DB.stampi.find(x => x.id !== cur && x.stato === 'pressa' && String(x.pressa) === String(n)); }
function updPressa(){
  const s = getS(cur);
  $('#pv').textContent = pressaVal || '–';
  const w = $('#pwarn'), ok = $('#pok');
  const same = s.stato === 'pressa' && String(s.pressa) === pressaVal;
  ok.disabled = !pressaVal || same;
  ok.style.display = '';
  w.className = 'warn';
  if(same){ w.className = 'warn show'; w.innerHTML = 'Lo stampo risulta già installato su questa pressa.'; return; }
  const pl = presseList(s.presse);
  const fuori = pressaVal && pl.length && !pl.includes(String(+pressaVal));
  const o = pressaVal && occupante(pressaVal);
  if(fuori){
    w.className = 'warn show';
    w.innerHTML = `Attenzione: lo stampo è predisposto per ${pl.length === 1 ? 'la pressa' : 'le presse'} <b>${esc(pl.join(', '))}</b>, non per la <b>${esc(pressaVal)}</b>.` + (o ? '<br><br>' : '');
    if(!o) return;
  }
  if(o){
    w.className = 'warn show';
    w.innerHTML = (fuori ? w.innerHTML : '') + `Sulla pressa <b>${esc(pressaVal)}</b> risulta già installato <b>${esc(o.nome)}</b>.
      <button class="btn primary" onclick="confirmPressa(true)">Riporta ${esc(o.nome)} in magazzino e conferma</button>
      <button class="btn outline" onclick="confirmPressa(false)">Conferma lasciando entrambi</button>`;
    ok.style.display = 'none';
  }
}
function confirmPressa(riporta){
  const s = getS(cur), n = pressaVal;
  if(!n) return;
  const o = occupante(n);
  run(async () => {
    if(o && riporta) await cambiaStato(o.id, 'magazzino', {dettaglio:'Smontato dalla pressa ' + n});
    await cambiaStato(s.id, 'pressa', {pressa:n, dettaglio:'Installato alla pressa ' + n});
  }, s.nome + ' installato alla pressa ' + n);
}

/* ---- Step: manutenzione ---- */
function stepManut(){
  const s = getS(cur);
  openModal(`${head('Inviato in manutenzione', esc(s.nome), 'renderStampo()')}
    <div class="form" style="grid-template-columns:1fr">
      <div class="field"><label>Fornitore / officina (facoltativo)</label><input id="mf" data-suggest="manutentore" autocomplete="off" placeholder="Scrivi le prime lettere…"></div>
      <div class="field"><label>Motivo / note (facoltativo)</label><textarea id="mn" placeholder="Es. sostituzione estrattori, lucidatura…"></textarea></div>
    </div>
    <div class="form-actions"><button class="btn ghost" onclick="renderStampo()">Indietro</button><button class="btn primary" onclick="confirmManut()">Conferma invio</button></div>`, 'step');
}
function confirmManut(){
  const s = getS(cur);
  const f = $('#mf').value.trim(), n = $('#mn').value.trim();
  if(f) ensureSoggetto('manutentore', f);
  run(() => cambiaStato(s.id, 'manutenzione', {dest:f, dettaglio:[f && 'Presso ' + f, n].filter(Boolean).join(' · ') || 'Inviato in manutenzione'}),
      s.nome + ' inviato in manutenzione');
}

/* ---- Step: coproprietario ---- */
function stepCopro(){
  const s = getS(cur);
  openModal(`${head('Spedito a coproprietario', esc(s.nome), 'renderStampo()')}
    <div class="form" style="grid-template-columns:1fr">
      <div class="field"><label>Coproprietario <i>*</i></label><input id="cp" data-suggest="coproprietario" autocomplete="off" value="${esc(s.coproprietario)}" placeholder="Scrivi le prime lettere…"></div>
      <div class="field"><label>DDT / note (facoltativo)</label><input id="cn" placeholder="Es. DDT 1234 del 28/10"></div>
      ${!s.coproprietario ? `<label style="display:flex;gap:10px;align-items:center;font-size:15px"><input type="checkbox" id="cps" checked style="width:22px;height:22px"> Salva come coproprietario nell'anagrafica dello stampo</label>` : ''}
    </div>
    <div class="err-text" id="cperr"></div>
    <div class="form-actions"><button class="btn ghost" onclick="renderStampo()">Indietro</button><button class="btn primary" onclick="confirmCopro()">Conferma spedizione</button></div>`, 'step');
}
function confirmCopro(){
  const s = getS(cur);
  const c = $('#cp').value.trim(), n = $('#cn').value.trim();
  if(!c){ $('#cperr').textContent = 'Indica il coproprietario.'; return; }
  const salva = $('#cps') && $('#cps').checked;
  ensureSoggetto('coproprietario', c);
  run(() => cambiaStato(s.id, 'coproprietario', {dest:c, copro:salva ? c : null, dettaglio:['Spedito a ' + c, n].filter(Boolean).join(' · ')}),
      s.nome + ' spedito a ' + c);
}

/* ---- Step: partner (stampaggio presso terzi) ---- */
function stepPartner(){
  const s = getS(cur);
  const ultimo = (DB.movimenti.find(m => m.stampoId === s.id && m.a === 'partner' && m.dest) || {}).dest || '';
  openModal(`${head('Inviato a partner', esc(s.nome), 'renderStampo()')}
    <p class="sub">Il partner stampa per noi con questo stampo.</p>
    <div class="form" style="grid-template-columns:1fr">
      <div class="field"><label>Partner <i>*</i></label><input id="pt" data-suggest="partner" autocomplete="off" value="${esc(ultimo)}" placeholder="Scrivi le prime lettere…"></div>
      ${ultimo ? '<span class="hint" style="margin-top:-8px">Proposto l\'ultimo partner usato con questo stampo.</span>' : ''}
      <div class="field"><label>Ordine / DDT / note (facoltativo)</label><input id="ptn" placeholder="Es. ordine 245, 3.000 pz, DDT 1540"></div>
    </div>
    <div class="err-text" id="pterr"></div>
    <div class="form-actions"><button class="btn ghost" onclick="renderStampo()">Indietro</button><button class="btn primary" onclick="confirmPartner()">Conferma invio</button></div>`, 'step');
  if(!ultimo) setTimeout(() => $('#pt').focus(), 60);
}
function confirmPartner(){
  const s = getS(cur);
  const c = $('#pt').value.trim(), n = $('#ptn').value.trim();
  if(!c){ $('#pterr').textContent = 'Indica il partner.'; return; }
  ensureSoggetto('partner', c);
  run(() => cambiaStato(s.id, 'partner', {dest:c, dettaglio:['Inviato al partner ' + c, n].filter(Boolean).join(' · ')}),
      s.nome + ' inviato a ' + c);
}

/* ---- Step: rientro ---- */
function stepRientro(){
  const s = getS(cur);
  openModal(`${head('Rientrato in magazzino', esc(s.nome), 'renderStampo()')}
    <p class="sub">Conferma la posizione in cui viene riposto. Modificala se cambia.</p>
    <div class="form">
      <div class="field"><label>Zona <i>*</i></label><input id="rz" value="${esc(s.zona)}"></div>
      <div class="field"><label>Scaffale</label><input id="rs" value="${esc(s.scaffale)}"></div>
      <div class="field"><label>Ripiano</label><input id="rr" value="${esc(s.ripiano)}"></div>
      <div class="field full"><label>Note (facoltativo)</label><input id="rn" placeholder="Es. rientrato da manutenzione, controllato"></div>
    </div>
    <div class="err-text" id="rerr"></div>
    <div class="form-actions"><button class="btn ghost" onclick="renderStampo()">Indietro</button><button class="btn primary" onclick="confirmRientro()">Conferma rientro</button></div>`, 'step');
}
function confirmRientro(){
  const s = getS(cur);
  const z = $('#rz').value.trim(), sc = $('#rs').value.trim(), r = $('#rr').value.trim(), n = $('#rn').value.trim();
  if(!z){ $('#rerr').textContent = 'Indica almeno la zona del magazzino.'; return; }
  const cambiata = z !== s.zona || sc !== s.scaffale || r !== s.ripiano;
  const pos = posizione({zona:z, scaffale:sc, ripiano:r});
  run(() => cambiaStato(s.id, 'magazzino', {zona:z, scaffale:sc, ripiano:r,
        dettaglio:[cambiata ? 'Nuova posizione: ' + pos : 'Riposto in ' + pos, n].filter(Boolean).join(' · ')}),
      s.nome + ' rientrato in magazzino');
}

/* ===================== ANAGRAFICA ===================== */
function openForm(id=null, presetCode=''){
  const s = id ? getS(id) : {codice:presetCode, nome:'', descrizione:'', zona:'', scaffale:'', ripiano:'', coproprietario:'', note:'', presse:''};
  cur = id;
  openModal(`${head(id ? 'Modifica anagrafica' : 'Nuovo stampo', id ? esc(s.nome) : 'Compila i dati e associa il codice', id ? 'renderStampo()' : '')}
    <div class="form">
      <div class="field full"><label>Codice QR / barcode</label>
        <div class="with-btn">
          <input id="f-codice" data-scan="1" value="${esc(s.codice)}" autocomplete="off" placeholder="Seleziona il campo e spara il codice">
          <button class="icon-btn" title="Fotocamera" onclick="openCam(v => { $('#f-codice').value = v; })">${ICO.cam}</button>
          <button class="btn ghost" style="min-height:46px;padding:0 14px" onclick="$('#f-codice').value = genCode()">Genera</button>
        </div>
        <span class="hint">Spara il codice già presente sullo stampo, oppure tocca "Genera" e stampa l'etichetta QR.</span></div>
      <div class="field span2"><label>Nome / codice stampo <i>*</i></label><input id="f-nome" value="${esc(s.nome)}" placeholder="Es. ST-100210 coperchio"></div>
      <div class="field"><label>Coproprietario</label><input id="f-copro" data-suggest="coproprietario" autocomplete="off" value="${esc(s.coproprietario)}" placeholder="Facoltativo · prime lettere"></div>
      <div class="field full"><label>Descrizione</label><textarea id="f-desc" placeholder="Prodotto stampato, n. impronte, materiale…">${esc(s.descrizione)}</textarea></div>
      <div class="field"><label>Zona magazzino <i>*</i></label><input id="f-zona" value="${esc(s.zona)}" placeholder="Es. A"></div>
      <div class="field"><label>Scaffale</label><input id="f-scaff" value="${esc(s.scaffale)}" placeholder="Es. 3"></div>
      <div class="field"><label>Ripiano</label><input id="f-rip" value="${esc(s.ripiano)}" placeholder="Es. 2"></div>
      <div class="field"><label>Predisposto per pressa</label><input id="f-presse" value="${esc(presseList(s.presse).join(', '))}" inputmode="decimal" placeholder="Es. 4 oppure 4, 7"></div>
      <div class="field span2"><label>Note</label><input id="f-note" value="${esc(s.note)}" placeholder="Facoltativo"></div>
    </div>
    <div class="err-text" id="ferr"></div>
    <div class="form-actions">
      ${id ? (ruolo === 'admin' ? `<button class="btn danger" onclick="delStampo('${id}')">Elimina</button>` : '') : `<button class="btn ghost" onclick="closeModal()">Annulla</button>`}
      <button class="btn primary" onclick="saveForm(${id ? `'${id}'` : 'null'})">${id ? 'Salva modifiche' : 'Crea stampo'}</button>
    </div>`, 'form');
  if(!id) setTimeout(() => (presetCode ? $('#f-nome') : $('#f-codice')).focus(), 60);
}
async function saveForm(id){
  const v = k => $(k).value.trim();
  const data = {codice:v('#f-codice') || null, nome:v('#f-nome'), descrizione:v('#f-desc'), zona:v('#f-zona'),
                scaffale:v('#f-scaff'), ripiano:v('#f-rip'), coproprietario:v('#f-copro'), note:v('#f-note'),
                presse_predisposte:presseList(v('#f-presse')).join(',')};
  const err = $('#ferr');
  if(!data.nome){ err.textContent = 'Inserisci il nome o codice dello stampo.'; return; }
  if(!data.zona){ err.textContent = 'Indica almeno la zona del magazzino.'; return; }
  if(data.codice){
    const dup = DB.stampi.find(x => x.id !== id && (x.codice||'').toLowerCase() === data.codice.toLowerCase());
    if(dup){ err.textContent = 'Codice già associato allo stampo "' + dup.nome + '".'; return; }
  }
  if(data.coproprietario) ensureSoggetto('coproprietario', data.coproprietario);
  busy(true);
  const now = new Date().toISOString();
  let newId = id, error;
  if(id){
    ({error} = await sb.from('stampi').update({...data, aggiornato:now}).eq('id', id));
  } else {
    newId = uid();
    ({error} = await sb.from('stampi').insert({id:newId, ...data, stato:'magazzino', stato_dal:now, creato:now, aggiornato:now}));
    if(!error){
      const r = await sb.from('stampi_movimenti').insert({stampo_id:newId, nome:data.nome, codice:data.codice || '', tipo:'nuovo', a:'magazzino', dettaglio:'Anagrafica creata'});
      if(r.error) console.warn(r.error);
    }
  }
  if(error){ busy(false); err.textContent = errMsg(error); return; }
  await loadAll();
  toast(id ? 'Anagrafica aggiornata' : 'Stampo creato', 'ok');
  openStampo(newId);
}
async function delStampo(id){
  const s = getS(id);
  if(!confirm('Eliminare lo stampo "' + s.nome + '"? Lo storico dei movimenti resta nel registro.')) return;
  busy(true);
  const {error} = await sb.from('stampi').delete().eq('id', id);
  if(error){ busy(false); toast(errMsg(error), 'err'); return; }
  await loadAll(); toast('Stampo eliminato'); closeModal();
}

/* ===================== ETICHETTA QR ===================== */
function qrDataURL(text){
  const tmp = document.createElement('div');
  new QRCode(tmp, {text, width:400, height:400, correctLevel:QRCode.CorrectLevel.M});
  const c = tmp.querySelector('canvas');
  return c ? c.toDataURL('image/png') : (tmp.querySelector('img') || {}).src;
}
async function generaEApri(id){
  busy(true);
  const {error} = await sb.from('stampi').update({codice:genCode(), aggiornato:new Date().toISOString()}).eq('id', id);
  if(error){ busy(false); toast(errMsg(error), 'err'); return; }
  await loadAll(); openLabel(id);
}
function openLabel(id){
  const s = getS(id); cur = id;
  if(!s.codice){
    openModal(`${head('Etichetta QR', esc(s.nome), 'renderStampo()')}
      <p>Lo stampo non ha ancora un codice. Generane uno per stampare l'etichetta.</p>
      <button class="btn primary block" onclick="generaEApri('${id}')">Genera codice e continua</button>`, 'label');
    return;
  }
  if(!window.QRCode){
    openModal(`${head('Etichetta QR', esc(s.nome), 'renderStampo()')}<div class="notice err">Generatore QR non disponibile: ricarica la pagina con la connessione attiva.</div>`, 'label');
    return;
  }
  const url = qrDataURL(s.codice);
  openModal(`${head('Etichetta QR', esc(s.nome), 'renderStampo()')}
    <div class="label-prev"><img src="${url}" alt="QR"><div><div class="l-name">${esc(s.nome)}</div><div class="l-code">${esc(s.codice)}</div><div class="l-loc">${esc(posizione(s))}</div></div></div>
    <button class="btn primary block" onclick="window.print()">Stampa etichetta</button>`, 'label');
  $('#print-area').innerHTML = `<div class="p-label"><img src="${url}"><div><b>${esc(s.nome)}</b><code>${esc(s.codice)}</code><span>${esc(posizione(s))}</span></div></div>`;
}

/* ===================== FOTOCAMERA ===================== */
/* Android/Chrome: lettore integrato del browser (BarcodeDetector).
   iPhone/Safari e altri browser: libreria ZXing caricata solo al primo uso. */
let camStream = null, camOn = false, zxReader = null;
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';
let zxLoading;
function loadZXing(){
  if(window.ZXing) return Promise.resolve();
  if(!zxLoading) zxLoading = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = ZXING_URL;
    s.onload = () => window.ZXing ? res() : rej(); s.onerror = () => { zxLoading = null; rej(); };
    document.head.appendChild(s);
  });
  return zxLoading;
}
function camFound(val, cb){ if(!camOn) return; closeCam(); beep(); cb(val); }
async function openCam(cb){
  toggleMenu(false);
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    toast(location.protocol === 'file:' ? 'Fotocamera disponibile solo dall\'app online' : 'Fotocamera non disponibile: usa il lettore o inserisci il codice','err'); return;
  }
  const v = $('#video');
  $('#cam').classList.add('open'); camOn = true; lockScroll();
  if('BarcodeDetector' in window){
    let det;
    try{
      const sup = await BarcodeDetector.getSupportedFormats();
      const want = ['qr_code','code_128','code_39','code_93','ean_13','ean_8','upc_a','upc_e','itf','data_matrix','codabar'].filter(f => sup.includes(f));
      det = new BarcodeDetector(want.length ? {formats:want} : undefined);
    }catch(e){ det = null; }
    if(det){
      try{ camStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}, audio:false}); }
      catch(e){ closeCam(); toast('Permesso fotocamera negato o non disponibile','err'); return; }
      if(!camOn){ closeCam(); return; }
      v.srcObject = camStream; v.setAttribute('playsinline',''); v.muted = true;
      try{ await v.play(); }catch(e){}
      const tick = async () => {
        if(!camOn) return;
        try{ const r = await det.detect(v); if(r.length && r[0].rawValue){ camFound(r[0].rawValue, cb); return; } }catch(e){}
        setTimeout(tick, 160);
      };
      tick(); return;
    }
  }
  try{ await loadZXing(); }
  catch(e){ closeCam(); toast('Lettore fotocamera non disponibile: controlla la connessione o inserisci il codice','err'); return; }
  if(!camOn) return;
  try{
    zxReader = new ZXing.BrowserMultiFormatReader();
    const onRes = (res) => { if(res && camOn) camFound(res.getText ? res.getText() : res.text, cb); };
    const constraints = {video:{facingMode:{ideal:'environment'}}, audio:false};
    if(typeof zxReader.decodeFromConstraints === 'function') await zxReader.decodeFromConstraints(constraints, v, onRes);
    else await zxReader.decodeFromVideoDevice(null, v, onRes);
  }catch(e){ closeCam(); toast('Permesso fotocamera negato o non disponibile','err'); }
}
function closeCam(){
  const wasOpen = $('#cam').classList.contains('open');
  camOn = false;
  if(zxReader){ try{ zxReader.reset(); }catch(e){} zxReader = null; }
  if(camStream){ camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  const v = $('#video'); if(v && v.srcObject){ try{ v.srcObject.getTracks().forEach(t => t.stop()); }catch(e){} v.srcObject = null; }
  $('#cam').classList.remove('open');
  if(wasOpen) unlockScroll();
}

/* ===================== LETTORE (tastiera) ===================== */
/* I lettori barcode/QR collegati al tablet "scrivono" il codice molto velocemente e chiudono con Invio. */
let buf = '', lastKey = 0;
document.addEventListener('keydown', e => {
  const t = e.target;
  const inField = t.matches && t.matches('input,textarea,select');
  if(inField){
    if(t.dataset.scan && (e.key === 'Enter' || e.key === 'Tab')){
      e.preventDefault();
      if(t.id === 'manual') onScan(t.value);
      else { beep(); t.blur(); }
    }
    return;
  }
  if(camOn || !ruolo) return;
  const now = Date.now();
  if(now - lastKey > 100) buf = '';
  lastKey = now;
  if(e.key === 'Enter' || e.key === 'Tab'){
    if(buf.length >= 3){ e.preventDefault(); const c = buf; buf = ''; onScan(c); }
    buf = ''; return;
  }
  if(e.key.length === 1) buf += e.key;
});

/* ===================== BACKUP ===================== */
function download(name, content, type){
  const blob = new Blob([content], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function stamp(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
async function exportJSON(){
  await loadAll();
  const bk = {formato:'gestione-stampi', versione:1, salvato:new Date().toISOString(), stampi:RAW.stampi, movimenti:RAW.movimenti, soggetti:RAW.soggetti};
  download('stampi-backup-' + stamp() + '.json', JSON.stringify(bk, null, 1), 'application/json');
  try{ localStorage.setItem('stampi_lastbackup', bk.salvato); }catch(e){}
  toast('Backup esportato', 'ok'); renderBackup();
}
function importJSON(inp){
  const f = inp.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = async () => {
    inp.value = '';
    let d;
    try{ d = JSON.parse(r.result); if(!Array.isArray(d.stampi) || !Array.isArray(d.movimenti)) throw 0; }
    catch(e){ toast('File non valido', 'err'); return; }
    if(!confirm('Importare ' + d.stampi.length + ' stampi e ' + d.movimenti.length + ' movimenti? Gli stampi con lo stesso identificativo vengono sovrascritti, gli altri restano.')) return;
    try{
      for(let i = 0; i < d.stampi.length; i += 500){
        const {error} = await sb.from('stampi').upsert(d.stampi.slice(i, i + 500)); if(error) throw error;
      }
      for(let i = 0; i < d.movimenti.length; i += 500){
        const {error} = await sb.from('stampi_movimenti').upsert(d.movimenti.slice(i, i + 500), {ignoreDuplicates:true}); if(error) throw error;
      }
      if(Array.isArray(d.soggetti) && d.soggetti.length){
        const {error} = await sb.from('stampi_soggetti').upsert(d.soggetti); if(error) throw error;
      }
      await loadAll(); toast('Backup importato', 'ok');
    }catch(e){ toast('Importazione non riuscita: ' + errMsg(e), 'err'); }
  };
  r.readAsText(f);
}
function exportCSV(){
  const cols = ['Codice','Stampo','Descrizione','Zona','Scaffale','Ripiano','Coproprietario','Predisposto per pressa','Stato','Pressa','Presso','Dal','Note'];
  const q = v => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  const rows = DB.stampi.map(s => [s.codice,s.nome,s.descrizione,s.zona,s.scaffale,s.ripiano,s.coproprietario,presseList(s.presse).join(', '),
    STATI[s.stato].label, s.pressa, s.destinazione, fmt(s.statoDal), s.note].map(q).join(';'));
  download('elenco-stampi-' + stamp() + '.csv', '\ufeff' + cols.join(';') + '\n' + rows.join('\n'), 'text/csv;charset=utf-8');
  toast('Elenco esportato', 'ok');
}

/* ===================== INSTALLAZIONE APP ===================== */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); installEvt = e;
  if(!isStandalone()) $('#install-btn').classList.add('show');
});
window.addEventListener('appinstalled', () => {
  installEvt = null; $('#install-btn').classList.remove('show');
  toast('App installata: la trovi sul desktop o tra le app', 'ok');
});
async function installApp(){
  if(!installEvt){
    toast('Usa il menu di Chrome o Edge › "Installa app" (sul tablet: "Aggiungi a schermata Home")');
    return;
  }
  installEvt.prompt();
  await installEvt.userChoice.catch(() => null);
  installEvt = null; $('#install-btn').classList.remove('show');
}
if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e)));
}

/* ===================== AVVIO ===================== */
renderAll();
initAuth();
