/* Modulo condiviso da Gestione Produzione e Collaudi e Seriali (prima era duplicato in entrambe le pagine). */
/* ===== ECOSISTEMA collaudi + produzione: calcolo condiviso (stesso codice nei due software) =====
   Legge: anagrafica prodotti e turni della produzione (produzione.json) e ordini/collaudi del portale (dati-collaudi.json).
   Regole (documento "Ecosistema collaudo e produzione"):
   - ritmo del prodotto = totale pezzi al giorno su N postazioni di riferimento; il ritmo cresce in proporzione alle postazioni;
   - i collaudi dello stesso prodotto si fanno uno dopo l'altro in ordine di data, prodotti diversi in parallelo;
   - solo giorni lavorativi (lun-ven, festività nazionali escluse); si conta da oggi compreso;
   - i pezzi registrati in produzione scalano dai collaudi in ordine di data, e dentro il collaudo destinazione per destinazione. */
(function (root) {
  'use strict';
  /* Nella produzione l'operatore inserisce i "pezzi prodotti: solo pezzi buoni, scarti esclusi":
     gli scarti sono già fuori dal conteggio, quindi non si sottraggono una seconda volta.
     Se i pezzi prodotti venissero registrati compresi gli scarti, basta mettere true. */
  const SCARTI_DA_DETRARRE = false;
  const MARGINE_GIORNI = 3;        /* da quanti giorni lavorativi di anticipo il collaudo si segnala come anticipabile */
  const FINESTRA_REALE = 20;       /* giorni lavorativi guardati per il ritmo reale */
  const SCOSTAMENTO = 0.25;        /* oltre il 25% di differenza dal ritmo impostato: suggerisce di rivedere l'anagrafica */
  const EPS = 1e-9;

  /* ---------- date ---------- */
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12);
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parse(s)) === s;
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const dayOfTs = (ts) => { const d = new Date(ts); return isNaN(d) ? '' : ymd(d); };
  const HOL = {};
  function holidays(y) {
    if (HOL[y]) return HOL[y];
    /* Pasqua (calcolo gregoriano) e Pasquetta */
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mon = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    const pasquetta = addDays(y + '-' + p2(mon) + '-' + p2(day), 1);
    const s = new Set(['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'].map((x) => y + '-' + x));
    s.add(pasquetta);
    return (HOL[y] = s);
  }
  function isWork(s) { const wd = parse(s).getDay(); return wd !== 0 && wd !== 6 && !holidays(+s.slice(0, 4)).has(s); }
  function nextWork(s) { let x = s; while (!isWork(x)) x = addDays(x, 1); return x; }
  /* giorni lavorativi d con a <= d < b */
  function workBetween(a, b) { if (b <= a) return 0; let n = 0, x = a; while (x < b) { if (isWork(x)) n++; x = addDays(x, 1); } return n; }
  /* k-esimo giorno lavorativo (0 = il primo) a partire da s compreso */
  function nthWork(s, k) { let x = nextWork(s); for (let i = 0; i < k; i++) x = nextWork(addDays(x, 1)); return x; }
  /* ultimi n giorni lavorativi prima di s (s escluso) */
  function lastWorkDays(s, n) { const out = []; let x = addDays(s, -1); while (out.length < n) { if (isWork(x)) out.push(x); x = addDays(x, -1); } return out; }

  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const GG = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const label = (s) => { const d = parse(s); return GG[d.getDay()] + ' ' + d.getDate() + ' ' + MESI[d.getMonth()]; };
  function rel(n) { return n === 0 ? 'oggi' : n === 1 ? 'domani' : n > 1 ? 'tra ' + n + ' giorni' : n === -1 ? 'ieri' : (-n) + ' giorni fa'; }
  const nf = new Intl.NumberFormat('it-IT'), nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
  const N = (n) => nf.format(Math.round(n)), N1 = (n) => nf1.format(n);

  /* ---------- lettura dei file ---------- */
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  function fromPortalFile(o) {
    if (!isObj(o) || o.formato !== 'collaudi-seriali' || !isObj(o.dati)) throw new Error('non è il file dati del portale Collaudi e Seriali');
    const d = o.dati, list = (c) => Object.keys(isObj(d[c]) ? d[c] : {}).map((id) => Object.assign({ id: id }, d[c][id]));
    return { serials: isObj(d.serials) ? d.serials : {}, orders: list('orders'), events: list('events'), cfg: isObj(d.meta) && isObj(d.meta.eco) ? d.meta.eco : {}, salvato: o.salvato || null };
  }
  function fromProdFile(o) {
    if (!isObj(o) || !Array.isArray(o.prodotti) || !Array.isArray(o.registrazioni)) throw new Error('non è il file dati della gestione produzione');
    return indexProd({ prodotti: o.prodotti, registrazioni: o.registrazioni, operatori: Array.isArray(o.operatori) ? o.operatori : [] });
  }
  /* somme giornaliere per codice prodotto (il codice è la prima parola di "CODICE descrizione") */
  const codeOf = (label) => { const s = String(label || '').trim(), k = s.indexOf(' '); return k < 0 ? s : s.slice(0, k); };
  function indexProd(p) {
    const byCode = new Map();
    (p.registrazioni || []).forEach((r) => {
      if (!r || (r.tipo !== 'Produzione' && r.tipo !== 'Scarto')) return;
      const c = codeOf(r.prodotto), day = dayOfTs(r.ts); if (!c || !day) return;
      const m = byCode.get(c) || new Map(); byCode.set(c, m);
      const x = m.get(day) || { prod: 0, scr: 0 }; m.set(day, x);
      if (r.tipo === 'Produzione') x.prod += Number(r.pezzi) || 0; else x.scr += Number(r.pezzi) || 0;
    });
    return Object.assign({}, p, { byCode: byCode });
  }
  const netOf = (x) => SCARTI_DA_DETRARRE ? Math.max(0, x.prod - x.scr) : x.prod;

  /* ---------- anagrafica: matricola del portale -> prodotto della produzione ---------- */
  const matOf = (p) => String((p && (p.matricola || p.a)) || '').trim();
  function productFor(prod, mat, link) {
    /* abbinamento scelto nel portale (Matricole › Prodotto della produzione), poi matricola indicata in produzione o stesso codice */
    if (link) { const l = (prod && prod.prodotti || []).find((p) => String(p.a).trim() === String(link).trim()); if (l) return l; }
    const all = (prod && prod.prodotti || []).filter((p) => matOf(p) === String(mat).trim());
    return all.find((p) => p.reparto === 'officina') || all.find((p) => !p.reparto) || all[0] || null;
  }
  function rateOf(p) {
    const rit = Number(p && p.ritmo), post = Math.max(1, Math.floor(Number(p && p.postazioni)) || 1);
    return rit > 0 ? { tot: rit, post: post, one: rit / post } : null;
  }

  const evQty = (e) => (Array.isArray(e.lines) ? e.lines : []).filter((l) => l && Number.isInteger(l.qty) && l.qty > 0);
  const evTotal = (e) => evQty(e).reduce((s, l) => s + l.qty, 0);
  const postOf = (e, rate) => { const n = Math.floor(Number(e.postazioni)); return n >= 1 ? n : (rate ? rate.post : 1); };

  /* ---------- calcolo ---------- */
  function compute(input) {
    const today = input.today || ymd(new Date()), cfg = input.cfg || {}, prod = input.prod, col = input.col;
    const margine = Math.max(0, Math.floor(Number(cfg.margine)) || 0), contaDal = isYmd(cfg.contaDal) ? cfg.contaDal : '';
    const orders = new Map((col.orders || []).map((o) => [o.id, o]));
    const events = (col.events || []).filter((e) => e && isYmd(e.date) && evTotal(e) > 0);
    /* i prodotti esterni (fatti fuori) non passano dalla produzione: restano fuori dalla stima */
    const ext = (m) => { const r = (col.serials || {})[m]; return !!(r && r.esterno); };
    const mats = Array.from(new Set(events.filter((e) => e.date >= today && !e.esito).map((e) => String(e.matricola || '').trim()).filter((m) => m && !ext(m)))).sort();
    const out = { today: today, margine: margine, products: [], alerts: [], lots: {}, hasProd: !!prod };
    mats.forEach((mat) => {
      const rec = (col.serials || {})[mat] || {};
      const lotsIn = events.filter((e) => String(e.matricola).trim() === mat && e.date >= today && !e.esito)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      /* collaudi già fatti: passati, oppure segnati collaudati o respinti (conta la data effettiva) */
      const past = events.filter((e) => String(e.matricola).trim() === mat && (e.date < today || e.esito)).map((e) => (e.esito && isYmd(e.esitoData) ? e.esitoData : e.date)).filter((d) => d <= today).sort();
      const p = prod ? productFor(prod, mat, rec.prodotto) : null, rate = rateOf(p);
      const P = { mat: mat, desc: rec.descrizione || (p ? p.b : ''), product: p, rate: rate, lots: [], countFrom: '', produced: 0, extra: 0, issue: '' };
      if (!prod) P.issue = 'noprod';
      else if (!p) P.issue = 'nolink';
      else if (!rate) P.issue = 'noritmo';

      /* da quando contare i pezzi: dopo l'ultimo collaudo passato, e non prima che l'ordine fosse inserito (o dalla data impostata a mano) */
      const lastPast = past.length ? addDays(past[past.length - 1], 1) : '';
      let from;
      if (contaDal) from = [lastPast, contaDal].sort().pop();
      else {
        const created = lotsIn.map((e) => { const o = orders.get(e.orderId); return dayOfTs((o && o.createdAt) || e.createdAt); }).filter(Boolean).sort()[0] || '';
        from = [lastPast, created].sort().pop();
      }
      P.countFrom = from || '';
      let pool = 0;
      const days = p && prod.byCode ? prod.byCode.get(String(p.a).trim()) : null;
      if (days) days.forEach((x, d) => { if ((!from || d >= from) && d <= today) pool += netOf(x); });
      P.produced = pool;

      /* ritmo reale degli ultimi giorni lavorati */
      if (days && rate) {
        const win = lastWorkDays(addDays(today, 1), FINESTRA_REALE), worked = win.map((d) => days.get(d)).filter((x) => x && x.prod > 0);
        if (worked.length >= 5) {
          const avg = worked.reduce((s, x) => s + netOf(x), 0) / worked.length;
          P.real = { avg: avg, days: worked.length };
          if (Math.abs(avg - rate.tot) / rate.tot > SCOSTAMENTO) P.realOff = true;
        }
      }

      let t = 0;
      lotsIn.forEach((e) => {
        const qty = evTotal(e), done = Math.min(qty, pool); pool -= done;
        let left = done;
        const dests = evQty(e).map((l) => { const d = Math.min(l.qty, left); left -= d; return { name: l.name, qty: l.qty, done: d, left: l.qty - d }; });
        const post = postOf(e, rate), R = rate ? rate.one * post : 0, rem = qty - done;
        const L = { id: e.id, ev: e, date: e.date, oda: e.oda || '', orderId: e.orderId, qty: qty, done: done, rem: rem, dests: dests, post: post, op: String(e.operatore || '').trim(),
          inDays: Math.round((parse(e.date) - parse(today)) / 864e5), workLeft: workBetween(today, e.date) };
        if (!rate) { L.status = P.issue || 'noritmo'; }
        else {
          const start = t, dur = rem / R, fin = start + dur; t = fin;
          L.R = R; L.start = start; L.fin = fin; L.dur = dur;
          const avail = L.workLeft - start;
          L.needed = rem <= 0 ? 0 : avail > EPS ? rem / avail : Infinity;
          L.postNeeded = rem <= 0 ? 0 : avail > EPS ? Math.ceil(L.needed / rate.one - EPS) : null;
          if (rem > 0) {
            const lastDay = nthWork(today, Math.max(0, Math.ceil(fin - EPS) - 1));
            L.ready = nextWork(addDays(lastDay, 1));
            L.suggest = nthWork(addDays(lastDay, 1), margine);
          }
          if (rem <= 0) L.status = 'pronto';
          else if (fin <= L.workLeft + EPS) { L.slack = L.workLeft - fin; L.status = L.slack >= MARGINE_GIORNI ? 'margine' : 'ok'; }
          else { L.status = 'rischio'; L.byPrev = dur <= L.workLeft + EPS; }
          if (post > rate.post) L.overPost = true;
        }
        P.lots.push(L); out.lots[e.id] = L;
      });
      P.extra = pool;
      P.current = P.lots.find((L) => L.rem > 0) || null;
      out.products.push(P);
    });

    /* avvisi, i più gravi prima */
    const A = out.alerts, who = (L, P) => P.mat + ' · collaudo di ' + label(L.date) + (L.oda ? ' (ODA ' + L.oda + ')' : '');
    out.products.forEach((P) => {
      if (P.issue === 'nolink') A.push({ k: 'warn', mat: P.mat, t: 'La matricola ' + P.mat + ' non è collegata a un prodotto della produzione: nel portale, in Matricole, scegli il prodotto della produzione (oppure indica la matricola nel ritmo del prodotto).' });
      else if (P.issue === 'noritmo') A.push({ k: 'warn', mat: P.mat, t: 'Manca il ritmo giornaliero del prodotto ' + P.product.a + ': impostalo in Anagrafiche › Prodotti per avere le stime.' });
      P.lots.forEach((L) => {
        if (L.status === 'rischio') {
          const alt = [];
          if (L.postNeeded && L.postNeeded > L.post) alt.push('servono ' + L.postNeeded + ' postazioni (ora ' + L.post + ')');
          if (L.suggest) alt.push('spostalo a ' + label(L.suggest));
          const t1 = alt.length ? alt.join(' oppure ') : '';
          A.push({ k: 'bad', mat: P.mat, id: L.id, t: who(L, P) + ': ' + (L.ready ? 'pezzi pronti solo per ' + label(L.ready) : 'non c’è tempo') + (L.byPrev ? ', per effetto dei collaudi precedenti dello stesso prodotto' : '') + '.' + (t1 ? ' ' + t1.charAt(0).toUpperCase() + t1.slice(1) + '.' : '') });
        }
      });
      P.lots.forEach((L) => { if (L.overPost) A.push({ k: 'info', mat: P.mat, id: L.id, t: who(L, P) + ': ' + L.post + ' postazioni, sopra il normale (' + P.rate.post + ').' }); });
      if (P.realOff) A.push({ k: 'info', mat: P.mat, t: 'Il ' + P.product.a + ' negli ultimi ' + P.real.days + ' giorni lavorati ha fatto in media ' + N(P.real.avg) + ' pezzi al giorno contro ' + N(P.rate.tot) + ' impostati: controlla il ritmo in anagrafica.' });
      P.lots.forEach((L) => { if (L.status === 'margine') A.push({ k: 'info', mat: P.mat, id: L.id, t: who(L, P) + ': ' + N1(L.slack) + ' giorni lavorativi di margine, si può anticipare a ' + label(L.suggest) + '.' }); });
    });
    const ord = { bad: 0, warn: 1, info: 2 };
    A.sort((a, b) => ord[a.k] - ord[b.k]);
    out.risk = out.products.reduce((n, P) => n + P.lots.filter((L) => L.status === 'rischio').length, 0);
    out.count = out.products.reduce((n, P) => n + P.lots.length, 0);
    out.remTot = out.products.reduce((n, P) => n + P.lots.reduce((s, L) => s + L.rem, 0), 0);
    const all = [].concat.apply([], out.products.map((P) => P.lots.map((L) => ({ L: L, P: P })))).sort((a, b) => a.L.date.localeCompare(b.L.date));
    out.next = all[0] || null;
    return out;
  }

  /* collaudo ipotetico: aggiunto (o al posto di excludeId) e ricalcolato */
  function hypo(input, h) {
    const id = h.id || '__nuovo__';
    const ev = { id: id, matricola: h.matricola, oda: h.oda || '', orderId: h.orderId, date: h.date, postazioni: h.postazioni, lines: [{ name: 'tot', qty: h.qty }], createdAt: '9999' };
    const events = (input.col.events || []).filter((e) => e.id !== h.excludeId && e.id !== id).concat([ev]);
    return { id: id, m: compute(Object.assign({}, input, { col: Object.assign({}, input.col, { events: events }) })) };
  }
  /* data suggerita per un nuovo collaudo messo in coda dopo quelli già in programma */
  function suggest(input, h) {
    const base = compute(input), P0 = base.products.find((P) => P.mat === String(h.matricola).trim());
    const r = hypo(input, Object.assign({}, h, { date: '9999-12-31' })), L = r.m.lots[r.id], P = r.m.products.find((x) => x.mat === String(h.matricola).trim());
    if (!L || !P) return { issue: 'noprod' };
    if (!P.rate) return { issue: P.issue, product: P.product };
    const before = P.lots.filter((x) => x.id !== r.id).reduce((s, x) => s + x.rem, 0);
    return { rate: P.rate, R: L.R, post: L.post, dur: L.dur, start: L.start, before: before, date: L.rem > 0 ? L.suggest : nextWork(addDays(input.today || ymd(new Date()), 0)), ready: L.ready, rem: L.rem, produced: P.produced, prevRisk: P0 ? P0.lots.filter((x) => x.status === 'rischio').length : 0 };
  }
  /* verifica di una data scelta: stato del collaudo e collaudi dello stesso prodotto che diventano a rischio */
  function check(input, h) {
    const base = compute(input), r = hypo(input, h), L = r.m.lots[r.id];
    if (!L) return null;
    const hit = [];
    r.m.products.filter((P) => P.mat === String(h.matricola).trim()).forEach((P) => P.lots.forEach((x) => {
      if (x.id === r.id || x.status !== 'rischio') return;
      const was = base.lots[x.id]; if (!was || was.status !== 'rischio') hit.push(x);
    }));
    return { L: L, hit: hit };
  }

  /* ---------- quadro (stesso aspetto nei due software) ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ST = { pronto: ['ok', 'Pezzi pronti'], ok: ['ok', 'In linea'], margine: ['info', 'In anticipo'], rischio: ['bad', 'A rischio'], noritmo: ['muted', 'Senza ritmo'], nolink: ['muted', 'Prodotto non collegato'], noprod: ['muted', 'Dati produzione mancanti'] };
  const CSS = '.eco{--e-line:var(--line,var(--b,#d9e0e4));--e-mut:var(--muted,var(--mut,#64748b));--e-ok:var(--ok,#1b7647);--e-okbg:var(--ok-bg,#dcf1e4);--e-bad:var(--bad,var(--red,#ae2a22));--e-badbg:var(--bad-bg,#fbe5e2);--e-warn:var(--warn,#8a5200);--e-warnbg:var(--warn-bg,#fff0d2);--e-acc:var(--action,var(--p,#15657e));--e-accbg:var(--action-soft,#dcebf0);--e-surf:var(--surface,var(--card,#fff));--e-surf2:var(--surface-2,var(--bg,#f4f7f8));display:flex;flex-direction:column;gap:16px;min-width:0}'
    + '.eco *{box-sizing:border-box}.eco-mono{font-family:var(--mono,ui-monospace,Menlo,Consolas,monospace);font-variant-numeric:tabular-nums}'
    + '.eco-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.eco-kpi{border:1px solid var(--e-line);border-radius:10px;padding:12px 14px;background:var(--e-surf);display:flex;flex-direction:column;gap:2px;min-width:0}.eco-kpi span{font-size:13px;color:var(--e-mut)}.eco-kpi b{font-size:26px;line-height:1.15;font-variant-numeric:tabular-nums}.eco-kpi small{font-size:12.5px;color:var(--e-mut);overflow-wrap:anywhere}.eco-kpi.bad{border-color:var(--e-bad)}.eco-kpi.bad b{color:var(--e-bad)}'
    + '.eco-alerts{display:flex;flex-direction:column;gap:6px}.eco-al{padding:8px 12px;border-radius:8px;font-size:14px;display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}.eco-al.bad{background:var(--e-badbg);color:var(--e-bad)}.eco-al.warn{background:var(--e-warnbg);color:var(--e-warn)}.eco-al.info{background:var(--e-accbg)}'
    + '.eco-al button{border:1px solid currentColor;background:none;color:inherit;border-radius:6px;padding:2px 10px;font:inherit;font-size:13px;cursor:pointer;min-height:30px}'
    + '.eco-prod{border:1px solid var(--e-line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--e-surf);min-width:0}.eco-ph{display:flex;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;align-items:baseline}.eco-ph h3{margin:0;font-size:16px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.eco-ph h3 span{font-weight:400;font-size:13.5px;color:var(--e-mut)}.eco-meta{font-size:13px;color:var(--e-mut);margin:0}'
    + '.eco-today{font-size:14px;background:var(--e-surf2);border-radius:8px;padding:8px 12px;margin:0}'
    + '.eco-tw{overflow-x:auto}.eco table{border-collapse:collapse;width:100%;font-size:13.5px}.eco th,.eco td{text-align:left;padding:8px 8px;border-top:1px solid var(--e-line);vertical-align:top;white-space:nowrap}.eco th{font-size:12px;font-weight:500;color:var(--e-mut);border-top:0}.eco td.r,.eco th.r{text-align:right}.eco td .eco-meta{display:block;white-space:normal;min-width:160px}'
    + '.eco-bar{height:6px;border-radius:999px;background:var(--e-line);overflow:hidden;min-width:90px;margin-top:4px}.eco-bar i{display:block;height:100%;background:var(--e-acc)}'
    + '.eco-st{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap}.eco-st.ok{background:var(--e-okbg);color:var(--e-ok)}.eco-st.bad{background:var(--e-badbg);color:var(--e-bad)}.eco-st.info{background:var(--e-accbg);color:var(--e-acc)}.eco-st.muted{background:var(--e-surf2);color:var(--e-mut)}'
    + '.eco-link{border:0;background:none;padding:0;color:var(--e-acc);text-decoration:underline;cursor:pointer;font:inherit}.eco-empty{color:var(--e-mut);margin:0}';

  function dashboard(m, opt) {
    opt = opt || {};
    if (!m.count) return '<div class="eco"><p class="eco-empty">Nessun collaudo in calendario da oggi in poi.</p></div>';
    const go = (L) => opt.portal ? '<button type="button" class="eco-link" data-act="ev-go" data-id="' + esc(L.id) + '">' + esc(label(L.date)) + '</button>' : esc(label(L.date));
    const nx = m.next;
    let h = '<div class="eco"><div class="eco-kpis">' +
      '<div class="eco-kpi"><span>Collaudi in programma</span><b>' + N(m.count) + '</b><small>' + N(m.remTot) + ' pezzi ancora da produrre</small></div>' +
      '<div class="eco-kpi' + (m.risk ? ' bad' : '') + '"><span>A rischio</span><b>' + N(m.risk) + '</b><small>' + (m.risk ? 'vedi gli avvisi qui sotto' : 'tutte le date reggono') + '</small></div>' +
      (nx ? '<div class="eco-kpi"><span>Prossimo collaudo</span><b>' + esc(rel(nx.L.inDays)) + '</b><small>' + esc(nx.P.mat + ' · ' + label(nx.L.date) + ' · ' + N(nx.L.qty) + ' pz') + '</small></div>' : '') + '</div>';
    if (m.alerts.length) h += '<div class="eco-alerts" role="list">' + m.alerts.map((a) => '<div class="eco-al ' + a.k + '" role="listitem"><span>' + esc(a.t) + '</span>' + (opt.portal && a.id ? '<button type="button" data-act="ev-go" data-id="' + esc(a.id) + '">Apri</button>' : '') + '</div>').join('') + '</div>';
    m.products.forEach((P) => {
      const r = P.rate;
      h += '<article class="eco-prod"><div class="eco-ph"><h3><span class="eco-mono" style="font-weight:600;font-size:16px;color:inherit">' + esc(P.mat) + '</span><span>' + esc(P.desc || '') + '</span></h3>' +
        '<p class="eco-meta">' + (r ? 'Ritmo ' + N1(r.tot) + ' pz/giorno su ' + r.post + (r.post === 1 ? ' postazione' : ' postazioni') + (r.post > 1 ? ' (' + N1(r.one) + ' per postazione)' : '') : 'Ritmo non impostato') +
        (P.product ? ' · pezzi prodotti' + (P.countFrom ? ' dal ' + esc(label(P.countFrom)) : '') + ': <b>' + N(P.produced) + '</b>' : '') + (P.real ? ' · media reale ' + N(P.real.avg) + ' pz/g' : '') + '</p></div>';
      const c = P.current;
      if (c && r) {
        const d = c.dests.find((x) => x.left > 0);
        h += '<p class="eco-today">Adesso: ' + (d ? '<b>' + esc(d.name) + '</b> (mancano ' + N(d.left) + ' pz) del collaudo di ' + esc(label(c.date)) : 'collaudo di ' + esc(label(c.date))) +
          (isFinite(c.needed) ? ' · obiettivo <b>' + N(Math.ceil(c.needed)) + ' pz al giorno</b> contro ' + N1(c.R) + ' del ritmo' : ' · non c’è più tempo per questa data') + (c.op ? ' · assegnato a ' + esc(c.op) : '') + '</p>';
      }
      if (P.extra > 0) h += '<p class="eco-meta">' + N(P.extra) + ' pezzi prodotti in più rispetto ai collaudi in calendario.</p>';
      h += '<div class="eco-tw"><table><thead><tr><th>Collaudo</th><th>Stato</th><th class="r">Pezzi fatti</th><th>Pronti per</th><th class="r">Ritmo necessario</th><th>Destinazioni</th><th class="r">Postazioni</th><th>Operatore</th></tr></thead><tbody>' +
        P.lots.map((L) => {
          const st = ST[L.status] || ST.noritmo, pct = L.qty ? Math.round(L.done * 100 / L.qty) : 0;
          return '<tr><td>' + go(L) + '<span class="eco-meta">' + esc(rel(L.inDays)) + (L.oda ? ' · ODA ' + esc(L.oda) : '') + '</span></td>' +
            '<td><span class="eco-st ' + st[0] + '">' + st[1] + '</span></td>' +
            '<td class="r eco-mono">' + N(L.done) + ' / ' + N(L.qty) + '<div class="eco-bar"><i style="width:' + pct + '%"></i></div></td>' +
            '<td>' + (L.status === 'pronto' ? 'già pronti' : L.ready ? esc(label(L.ready)) : '—') + '</td>' +
            '<td class="r eco-mono">' + (L.R == null ? '—' : L.rem <= 0 ? '—' : isFinite(L.needed) ? N(Math.ceil(L.needed)) + ' / ' + N1(L.R) : 'nessun giorno') + '</td>' +
            '<td><span class="eco-meta" style="color:inherit">' + L.dests.map((d) => esc(d.name) + ' ' + N(d.done) + '/' + N(d.qty)).join(' · ') + '</span></td>' +
            '<td class="r eco-mono">' + L.post + (L.overPost ? ' ↑' : '') + '</td><td>' + (L.op ? esc(L.op) : '<span class="eco-meta">—</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div></article>';
    });
    return h + '<p class="eco-meta">Ritmo necessario = pezzi che mancano diviso i giorni lavorativi rimasti per quel collaudo, contro il ritmo con le postazioni assegnate. Giorni lavorativi: lunedì–venerdì, festività nazionali escluse.</p></div>';
  }

  root.Eco = { compute: compute, suggest: suggest, check: check, dashboard: dashboard, CSS: CSS, fromPortalFile: fromPortalFile, fromProdFile: fromProdFile, indexProd: indexProd,
    label: label, rel: rel, ymd: ymd, isYmd: isYmd, isWork: isWork, workBetween: workBetween, nthWork: nthWork, N: N, N1: N1, matOf: matOf, rateOf: rateOf, productFor: productFor, evTotal: evTotal };
})(typeof window !== 'undefined' ? window : globalThis);

/* stili dei pannelli ecosistema, uguali nelle due app */
document.head.insertAdjacentHTML('beforeend', '<style>' + Eco.CSS + '</style>');
