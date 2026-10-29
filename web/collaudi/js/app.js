(function () {
  'use strict';
  const C = window.SerialCore;
  const TPL = window.SERIAL_TEMPLATE;
  const $ = (s, r) => (r || document).querySelector(s);
  const nf = new Intl.NumberFormat('it-IT');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const range = (a, b) => (a === b ? String(a) : a + '–' + b);
  const isInt = Number.isInteger;
  const ICON = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor"><rect x="3" y="5" width="2" height="14"/><rect x="6.5" y="5" width="1" height="14"/><rect x="9" y="5" width="3" height="14"/><rect x="13.5" y="5" width="1" height="14"/><rect x="16" y="5" width="2" height="14"/><rect x="19.5" y="5" width="1.5" height="14"/></svg>';

  const today = new Date();
  let seq = 0;
  let dbh = null, dlh = null, view = null, noticeTimer = null;

  const state = {
    cfg: Object.assign({}, C.DEFAULT_CFG),
    avviso: '', mese: C.MESI[today.getMonth()], anno: String(today.getFullYear()).slice(-2),
    view: 'calendario', lines: [], confirming: false, busy: false, result: null, edit: null,
    cal: { y: today.getFullYear(), m: today.getMonth(), panel: null, confirmDel: null },
    ord: { edit: null, filter: 'open', tried: false, confirmDel: false },
    db: { mode: 'connecting', serials: {}, runs: [], orders: [], events: [], got: { serials: false, orders: false, events: false } }
  };
  /* ecosistema: turni letti da produzione.json, impostazioni in meta/eco, modello ricalcolato a ogni aggiornamento */
  const ECO = { prod: null, src: '', at: null, fileAt: null, err: '', cfg: {}, m: null, wasLinked: false, msg: '' };

  /* ---------- anagrafica ---------- */
  const rec = (m) => state.db.serials[m] || null;
  const visibleMats = () => Object.keys(state.db.serials).filter((m) => !state.db.serials[m].archived).sort();
  const destList = (r) => (r && Array.isArray(r.destinations) ? r.destinations.filter((x) => typeof x === 'string' && x.trim()) : []);
  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  /* ---------- scheda di una matricola nel lotto ---------- */
  function newLine(mat) {
    const r = rec(mat) || {};
    const names = destList(r);
    return {
      id: 'L' + (++seq), matricola: mat, oda: '', eventId: null,
      perPallet: boxOf(r) ? String(boxOf(r).per) : isInt(r.perPallet) ? String(r.perPallet) : '', perPalletManual: false, lotto: '',
      remainder: r.remainder === 'last' ? 'last' : 'separate', sheetName: '', optsOpen: false,
      startManual: false, startValue: '', reuse: false,
      palletManual: false, palletValue: '', palletReuse: false,
      dests: (names.length ? names : ['']).map((n) => ({ name: n, qty: '' }))
    };
  }

  /* ---------- calcolo ---------- */
  function sizeDesc(plan) {
    const m = new Map();
    plan.rows.forEach((r) => m.set(r.qty, (m.get(r.qty) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map((e) => e[1] + ' da ' + e[0]).join(' + ');
  }

  function compute() {
    const db = state.db;
    const V = { errors: [], lines: [], ok: false, waiting: false, bases: {} };
    if (!/^\d{2}$/.test(state.anno.trim())) V.errors.push('L’anno del barcode deve avere 2 cifre, per esempio 26.');
    const running = {}, runningPal = {};
    state.lines.forEach((line) => {
      const L = { line: line, errors: [], todo: [], warns: [], infos: [], plan: null, auto: null, base: null, registered: null, start: null, clash: false, per: NaN, dests: [], newDests: [], pAuto: null, pBase: null, pRegistered: null, pStart: null, pClash: false, sheet: '' };
      const mat = line.matricola, r = rec(mat);
      if (!r) L.errors.push('Questa matricola non è più in anagrafica.');
      else if (mat.length !== 6) L.warns.push('La matricola ha ' + mat.length + ' cifre invece di 6: cambia la lunghezza del barcode.');

      const odaRaw = line.oda.trim();
      if (odaRaw === '') L.todo.push('Indica il numero d’ordine (ODA).');
      else if (!/^\d+$/.test(odaRaw)) L.errors.push('L’ordine (ODA) deve contenere solo cifre.');

      const BOX = boxOf(r); L.box = BOX;
      if (r && r.scatole && !BOX) L.todo.push('Completa la confezione a scatole in Matricole: pezzi per scatola e scatole per pallet.');
      if (BOX) { L.lotto = String(line.lotto || '').trim() || defLot(r); if (/[;\r\n]/.test(L.lotto)) L.errors.push('Il lotto non può contenere il punto e virgola.'); }
      const perRaw = line.perPallet.trim(), per = C.toInt(perRaw);
      if (perRaw === '' && BOX) L.todo.push('Indica le scatole per pallet.');
      else if (perRaw === '') L.todo.push('Indica i pezzi per pallet (in “Opzioni di questo lotto”; se li salvi in anagrafica non te li chiedo più).');
      else if (!(per >= 1)) L.errors.push('I pezzi per pallet devono essere un numero intero da 1 in su.');
      L.per = per;

      /* Le destinazioni con quantità vuota non servono questo mese: si ignorano. */
      const active = []; let qtyBad = false;
      line.dests.forEach((d) => {
        const raw = d.qty.trim();
        if (raw === '') return;
        const qn = C.toInt(raw);
        if (!(qn >= 1)) qtyBad = true; else active.push({ name: d.name.trim(), qty: qn });
      });
      if (qtyBad) L.errors.push('Le quantità devono essere numeri interi da 1 in su (lascia vuote le destinazioni che questo mese non servono).');
      else if (!active.length) L.todo.push('Indica la quantità per almeno una destinazione.');
      const destsOk = !qtyBad && active.length > 0;
      L.dests = active;
      const known = destList(r);
      active.forEach((d) => {
        if (d.name && !known.some((k) => sameName(k, d.name)) && !L.newDests.some((k) => sameName(k, d.name))) L.newDests.push(d.name);
      });
      L.sheet = line.sheetName.trim() || String((r && r.sheetName) || '').trim() || state.cfg.sheetName;

      /* Seriali: ogni matricola ha la sua numerazione. */
      L.registered = r && isInt(r.last) ? r.last : null;
      const recPallet = r && isInt(r.lastPallet) ? r.lastPallet : null;
      if (r && V.bases[mat] === undefined) V.bases[mat] = { serial: L.registered, pallet: recPallet, byY: JSON.stringify(r.lastByYear || null) };
      /* Seriali per anno del barcode: ogni anno la matricola riparte da 1. I pianali continuano sempre. */
      const yNow = state.anno.trim(), yOk = /^\d{2}$/.test(yNow), yLast = r ? lastYearOf(mat) : null;
      L.yLast = yLast; L.year = yNow;
      const ys = r && yOk ? yearSerial(mat, yNow) : L.registered;
      L.yearBase = ys === undefined ? null : ys;
      if (r && yOk && running[mat] === undefined) {
        if (ys === undefined) L.todo.push('Non conosco l’ultimo seriale del 20' + yNow + ' per questa matricola: indica il primo seriale in “Opzioni di questo lotto”.');
        else if (ys === 0 && isInt(r.last) && r.last > 0 && yLast && +yNow > +yLast) L.infos.push('Anno nuovo nel barcode (' + yNow + ', prima ' + yLast + '): i seriali ripartono da 1. I pianali continuano' + (recPallet != null ? ' dopo il ' + recPallet : '') + '.');
        else if (yLast && +yNow < +yLast) L.infos.push('Collaudo del 20' + yNow + ': i seriali continuano dall’ultimo del 20' + yNow + ' (' + ys + '). I pianali continuano dopo il ' + (recPallet != null ? recPallet : '—') + '.');
      }
      L.base = !r ? null : (running[mat] !== undefined ? running[mat] : L.yearBase);
      L.auto = L.base == null ? null : L.base + 1;
      let start = null;
      if (line.startManual) {
        const raw = line.startValue.trim();
        if (raw === '') L.todo.push('Indica il primo seriale.');
        else {
          const v = C.toInt(raw);
          if (!isInt(v) || v < 1) L.errors.push('Il primo seriale deve essere un numero intero da 1 in su.'); else start = v;
        }
      } else if (L.auto != null) start = L.auto;
      else if (r) L.todo.push('Nessun seriale registrato per questa matricola: indica il primo (1 se è la prima volta).');
      if (start != null && start > C.MAX_SERIAL) { L.errors.push('I seriali superano il massimo di 10 cifre.'); start = null; }
      if (start != null && L.base != null && start <= L.base && !line.reuse) {
        L.clash = true;
        L.errors.push('I seriali fino al ' + L.base + ' risultano già assegnati a questa matricola.');
      }
      L.start = start;

      /* Pianali: per matricola. Prodotti a scatole: anno + progressivo comune a tutte le matricole a scatole. */
      if (BOX) {
        L.pRegistered = boxPalLast(state.anno.trim());
        L.pBase = runningPal.__box !== undefined ? runningPal.__box : L.pRegistered;
        L.pAuto = L.pBase + 1;
      } else {
      L.pRegistered = recPallet;
      L.pBase = !r ? null : (runningPal[mat] !== undefined ? runningPal[mat] : recPallet);
      L.pAuto = L.pBase == null ? null : L.pBase + 1;
      }
      let pStart = null;
      if (line.palletManual) {
        const raw = line.palletValue.trim();
        if (raw === '') L.todo.push('Indica il primo pianale.');
        else {
          const v = C.toInt(raw);
          if (!isInt(v) || v < 1) L.errors.push('Il primo pianale deve essere un numero intero da 1 in su.'); else pStart = v;
        }
      } else if (L.pAuto != null) pStart = L.pAuto;
      else if (r) L.todo.push('Nessun pianale registrato per questa matricola: indica il primo numero (1 se è la prima volta).');
      if (pStart != null && L.pBase != null && pStart <= L.pBase && !line.palletReuse) {
        L.pClash = true;
        L.errors.push(BOX ? 'I pallet fino al ' + palSer(L.pBase) + ' risultano già usati.' : 'I pianali fino al ' + L.pBase + ' risultano già assegnati a questa matricola.');
      }
      L.pStart = pStart;

      if (start != null && pStart != null && destsOk && per >= 1) {
        const plan = BOX ? C.boxPlan({ matricola: mat, oda: odaRaw, box: { pz: BOX.pz, per: per }, destinations: active }, start, pStart)
          : C.planLine({ matricola: mat, oda: odaRaw, perPallet: per, remainder: line.remainder, destinations: active }, start, pStart);
        L.plan = plan;
        if (r) { running[mat] = plan.lastSerial; if (BOX) runningPal.__box = plan.lastPallet; else runningPal[mat] = plan.lastPallet; }
        if (BOX) plan.blocks.forEach((b) => L.infos.push((b.name || 'Destinazione') + ': ' + nf.format(b.pcs) + ' pezzi = ' + C.boxComp(b.pcs, BOX.pz) + ' · pallet ' + C.palComp(b.sizes, per) + ' (' + C.palRange(state.anno.trim(), b.firstPallet, b.lastPallet) + ').'));
        if (!BOX) plan.blocks.forEach((b) => {
          const rem = b.qty % per;
          if (rem > 0 && b.qty >= per) {
            L.infos.push((b.name || 'Destinazione') + ': resto di ' + rem + (rem === 1 ? ' pezzo ' : ' pezzi ') +
              (line.remainder === 'last' ? 'sommato all’ultimo pallet (' + b.sizes[b.sizes.length - 1] + ' pezzi)' : 'in un ultimo pallet da ' + rem) + '.');
          }
        });
      }
      if (r && !line.eventId && /^\d+$/.test(odaRaw) && db.runs.some((x) => (x.lines || []).some((l) => l.matricola === mat && l.oda === odaRaw))) {
        L.warns.push('Esiste già un lotto registrato per la matricola ' + mat + ' con ODA ' + odaRaw + '. Controlla di non duplicarlo.');
      }
      V.lines.push(L);
    });

    V.waiting = db.mode === 'connecting' || (db.mode === 'on' && !db.got.serials);
    V.ok = !V.waiting && V.errors.length === 0 && V.lines.length > 0 && V.lines.every((L) => L.errors.length === 0 && L.todo.length === 0 && L.plan);
    return V;
  }

  /* anno (2 cifre) dell'ultimo seriale registrato: dato salvato, altrimenti ultimo lotto o ultima modifica */
  function lastYearOf(mat) {
    const r = rec(mat); if (!r) return null;
    if (/^\d{2}$/.test(String(r.lastYear || ''))) return String(r.lastYear);
    const run = state.db.runs.find((x) => /^\d{2}$/.test(String(x.anno || '')) && (x.lines || []).some((l) => l.matricola === mat));
    if (run) return String(run.anno);
    if (typeof r.updatedAt === 'string' && /^\d{4}-/.test(r.updatedAt)) return r.updatedAt.slice(2, 4);
    return null;
  }
  /* ultimo seriale usato nell'anno y: 0 se è un anno nuovo, undefined se è un anno vecchio mai registrato */
  function yearSerial(mat, y) {
    const r = rec(mat); if (!r) return null;
    if (r.lastByYear && isInt(r.lastByYear[y])) return r.lastByYear[y];
    if (!isInt(r.last)) return null;
    const ly = lastYearOf(mat);
    if (!ly || ly === y) return r.last;
    return +y > +ly ? 0 : undefined;
  }

  /* prodotto esterno: non passa dalla produzione, niente stima */
  const isExt = (m) => { const r = rec(m); return !!(r && r.esterno); };
  /* confezione a scatole: {pz, per, letter} oppure null */
  function boxOf(r) {
    if (!r || !r.scatole) return null;
    const pz = C.toInt(r.boxPz), per = C.toInt(r.boxPerPallet);
    return pz >= 1 && per >= 1 ? { pz: pz, per: per, letter: String(r.lottoLettera || 'M').trim() || 'M' } : null;
  }
  const defLot = (r) => { const b = boxOf(r); return (b ? b.letter : 'M') + (C.MESI.indexOf(state.mese) + 1) + '/' + state.anno.trim(); };
  const boxPalLast = (y) => (state.boxPal && isInt(state.boxPal[y]) ? state.boxPal[y] : 0);
  const palSer = (n) => C.palSerial(state.anno.trim(), n);
  /* righe del CSV: i prodotti a scatole diventano una riga per matricola + ODA + lotto con la quantità totale */
  function csvItems(list) {
    const out = [];
    list.forEach((it) => {
      if (it.qty == null) { out.push(it); return; }
      const k = out.find((x) => x.qty != null && x.matricola === it.matricola && x.oda === it.oda && x.lot === it.lot);
      if (k) k.qty += it.qty; else out.push(Object.assign({}, it));
    });
    return out;
  }

  const matPrefix = (m) => { const r = rec(m); return r && /^\d{1,12}$/.test(String(r.prefix || '')) ? String(r.prefix) : ''; };
  /* elenco dei prodotti della Gestione Produzione per abbinare codice cliente e codice di produzione */
  function matProdField(f) {
    const list = ECO.prod ? ECO.prod.prodotti.filter((p) => p && p.reparto !== 'stampaggio').slice().sort((a, b) => String(a.a).localeCompare(String(b.a), 'it', { numeric: true })) : [];
    const cur = String(f.prod || '');
    if (!list.length) return '<div class="field"><label class="l" for="e-prod">Prodotto della produzione</label><input type="text" id="e-prod" data-e="prod" class="num" autocomplete="off" placeholder="es. PF100200" value="' + esc(cur) + '"><span class="hint">Codice in Gestione Produzione. Vuoto = stesso codice della matricola.</span></div>';
    const opts = list.map((p) => '<option value="' + esc(p.a) + '"' + (String(p.a) === cur ? ' selected' : '') + '>' + esc(p.a) + ' — ' + esc(p.b || '') + '</option>').join('');
    const extra = cur && !list.some((p) => String(p.a) === cur) ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (non trovato in produzione)</option>' : '';
    return '<div class="field"><label class="l" for="e-prod">Prodotto della produzione</label><select id="e-prod" data-e="prod"><option value="">Automatico (stesso codice)</option>' + extra + opts + '</select><span class="hint">Abbina il codice cliente al codice di produzione, per esempio 1234567 → CLB1234567.</span></div>';
  }

  function syncPerPallet() {
    state.lines.forEach((l) => {
      if (l.perPalletManual) return;
      const r = rec(l.matricola);
      const b = boxOf(r); l.perPallet = b ? String(b.per) : r && isInt(r.perPallet) ? String(r.perPallet) : '';
    });
  }

  /* ---------- file ---------- */
  function filesForRun(run) {
    const cfg = { prefix: run.prefix, fixedDigit: run.fixedDigit };
    const items = [], out = [], bx = [];
    run.lines.forEach((l) => {
      if (l.box) {
        const plan = C.boxPlan(l, l.firstSerial, l.firstPallet);
        bx.push({ line: l, plan: plan }); items.push({ matricola: l.matricola, oda: l.oda, qty: plan.pcs, lot: l.lotto || '' });
        return;
      }
      const plan = C.planLine(l, l.firstSerial, l.firstPallet);
      items.push({ matricola: l.matricola, oda: l.oda, firstSerial: plan.firstSerial, lastSerial: plan.lastSerial, prefix: l.prefix || '' });
      out.push({ kind: 'Excel', dir: 'prod', sub: l.matricola, label: 'Excel ' + l.matricola, name: C.xlsxName(l, run.mese), build: () => C.buildXlsx(TPL, l, plan, l.sheetName) });
    });
    if (bx.length) {
      const mats = bx.map((x) => x.line.matricola), title = String(run.mese || '').slice(0, 3).toLowerCase() + '-' + run.anno;
      out.push({ kind: 'Excel', dir: 'prod', sub: mats.every((m) => m === mats[0]) ? mats[0] : 'scatole', label: 'Excel scatole e pallet', name: C.boxXlsxName(mats, run.mese),
        build: () => C.buildBoxXlsx(TPL, bx, title, run.anno, title) });
    }
    out.push({ kind: 'CSV', dir: 'csv', label: 'CSV portale cliente', name: C.csvName(run.avviso, run.lines.map((l) => l.matricola)), build: () => C.utf8Bom(C.buildCsvText(csvItems(items), run.anno, cfg)) });
    return out;
  }
  /* Restituisce 'saved', 'declined' o 'error'. */
  async function saveFile(file, statEl) {
    if (statEl) statEl.textContent = '';
    const via = await saveToFolder(file);
    if (via.ok) { if (statEl) statEl.textContent = via.same ? 'Già presente in ' + via.where : 'Salvato in ' + via.where + (via.renamed ? ' come “' + via.name + '” (esisteva già un file con quel nome)' : ''); return 'saved'; }
    const note = via.why ? ' · la cartella collegata non risponde (' + via.why + ')' : '';
    if (!dlh) { if (statEl) statEl.textContent = 'Il download non è disponibile in questa vista.' + note; return 'error'; }
    try {
      await dlh.save({ filename: file.name, data: file.build() });
      if (statEl) statEl.textContent = 'Salvato' + (via.why ? ' nei Download' + note : '');
      return 'saved';
    } catch (e) {
      const declined = e && e.code === 'declined';
      if (statEl) statEl.textContent = declined ? 'Non salvato' : 'Non riuscito: ' + ((e && (e.message || e.code)) || 'errore');
      return declined ? 'declined' : 'error';
    }
  }

  /* ---------- disegno: scelta delle matricole ---------- */
  function pickHtmlBase(m, act, on) {
    const r = rec(m) || {};
    const per = isInt(r.perPallet) ? r.perPallet + ' pezzi per pallet' : 'pezzi per pallet da indicare';
    const nums = 'ult. seriale ' + (isInt(r.last) ? r.last + (lastYearOf(m) ? ' (' + lastYearOf(m) + ')' : '') : '—') + ' · pianale ' + (isInt(r.lastPallet) ? r.lastPallet : '—') + (r.prodotto ? ' · produzione ' + r.prodotto : '') + (r.prefix ? ' · prefisso ' + r.prefix : '');
    return '<button type="button" class="pick' + (on ? ' on' : '') + (r.archived ? ' arch' : '') + '" data-act="' + act + '" data-mat="' + esc(m) + '"' +
      (act === 'pick' ? ' aria-pressed="' + (on ? 'true' : 'false') + '"' : '') + '>' +
      '<span class="ic">' + ICON + '</span><span class="pm mono">' + esc(m) + '</span>' +
      '<span class="pd">' + (r.descrizione ? esc(r.descrizione) : 'Senza descrizione') + '</span>' +
      '<span class="pn' + (isInt(r.perPallet) ? '' : ' warnx') + '">' + per + '</span>' +
      '<span class="pn mono' + (isInt(r.lastPallet) ? '' : ' warnx') + '">' + nums + '</span>' +
      (r.archived ? '<span class="pn">nascosta dal lotto</span>' : '') + '</button>';
  }
  const addCardHtml = '<button type="button" class="pick add" data-act="new-mat"><span class="plus" aria-hidden="true">+</span><span class="pm" style="font-size:15px">Nuova matricola</span></button>';

  function loadingAnag() { return state.db.mode === 'connecting' || (state.db.mode === 'on' && !state.db.got.serials); }

  /* Riscrive il contenuto solo se cambia: le schede si ridisegnano a ogni tasto, la scelta no. */
  function setHtml(host, html) { if (host._html !== html) { host._html = html; host.innerHTML = html; } }

  function paintPicker() {
    const host = $('#pickHost');
    if (loadingAnag()) { setHtml(host, '<p class="empty">Carico l’anagrafica…</p>'); return; }
    const mats = visibleMats();
    setHtml(host, '<div class="picks">' + mats.map((m) => pickHtml(m, 'pick', state.lines.some((l) => l.matricola === m))).join('') + addCardHtml + '</div>' +
      (mats.length ? '' : '<p class="empty" style="margin-top:12px">Nessuna matricola in anagrafica: aggiungine una per cominciare.</p>'));
  }

  function paintMatGrid() {
    const host = $('#matGrid');
    if (loadingAnag()) { setHtml(host, '<p class="empty">Carico l’anagrafica…</p>'); return; }
    const mats = Object.keys(state.db.serials).sort();
    setHtml(host, matDelBarHtml('grid') + '<div class="picks">' + mats.map((m) => pickHtml(m, 'edit-mat', !!(state.edit && state.edit.mat === m))).join('') + addCardHtml + '</div>');
  }

  /* ---------- disegno: schede del lotto ---------- */
  function lineHtml(l, i, n) {
    const id = l.id, r = rec(l.matricola) || {};
    const fld = (label, inner, cls) => '<div class="field' + (cls ? ' ' + cls : '') + '"><label class="l" for="' + inner.id + '">' + label + '</label>' + inner.html + '</div>';
    const input = (suffix, f, cls, ph, val, extra) => {
      const eid = id + '-' + suffix;
      return { id: eid, html: '<input type="text" id="' + eid + '" data-f="' + f + '" class="' + cls + '" autocomplete="off" spellcheck="false" placeholder="' + esc(ph) + '" value="' + esc(val) + '"' + (extra || '') + '>' };
    };
    const dests = l.dests.map((d, di) =>
      '<div class="dest" data-di="' + di + '">' +
      '<input type="text" id="' + id + '-d' + di + 'n" data-f="dname" autocomplete="off" aria-label="Destinazione ' + (di + 1) + '" placeholder="es. Milano" value="' + esc(d.name) + '">' +
      '<input type="text" id="' + id + '-d' + di + 'q" data-f="dqty" class="num" inputmode="numeric" autocomplete="off" aria-label="Quantità destinazione ' + (di + 1) + '" placeholder="pezzi" value="' + esc(d.qty) + '">' +
      (l.dests.length > 1 ? '<button type="button" class="x" data-act="remove-dest" aria-label="Rimuovi destinazione ' + (di + 1) + '">×</button>' : '<span></span>') + '</div>').join('');
    const BX = boxOf(r), needs = !BX && (!isInt(r.perPallet) || !isInt(r.lastPallet));
    return '<article class="line" data-id="' + id + '">' +
      '<div class="line-head"><div class="lh"><span class="ic sm">' + ICON + '</span><div><h3>Matricola <span class="mono">' + esc(l.matricola) + '</span></h3>' +
      '<p class="meta">' + (r.descrizione ? esc(r.descrizione) : 'Senza descrizione') + '</p></div></div>' +
      '<div class="row"><button type="button" class="btn ghost small" data-act="dup-line">+ Altro ordine</button>' +
      '<button type="button" class="btn ghost small danger" data-act="remove-line">Rimuovi</button></div></div>' +
      '<p class="meta" data-o="from"></p>' +
      '<div class="grid g3">' + fld('Ordine (ODA)', input('oda', 'oda', 'num', 'es. 6000132763', l.oda, ' inputmode="numeric"')) +
      (BX ? fld('Lotto (nel CSV)', input('lotto', 'lotto', '', defLot(r), l.lotto)) + '<p class="hint" style="align-self:end">Prodotto a scatole da ' + BX.pz + ' pezzi, ' + BX.per + ' scatole per pallet. Vuoto = lotto proposto.</p>' : '') + '</div>' +
      '<div class="dests"><div class="dest-head"><span>Destinazione</span><span>Pezzi</span><span></span></div>' + dests +
      '<div class="row"><button type="button" class="btn ghost small" data-act="add-dest">+ Destinazione</button>' +
      '<span class="hint">Lascia vuote le quantità delle destinazioni che questo mese non servono.</span></div></div>' +
      '<p class="summary" data-o="summary"></p><ul class="msgs" data-o="msgs"></ul>' +
      '<details class="pane" data-o="opts"' + (l.optsOpen || needs ? ' open' : '') + '><summary>Opzioni di questo lotto</summary><div class="in"><div class="grid g3">' +
      fld(BX ? 'Scatole per pallet' : 'Pezzi per pallet', input('per', 'perPallet', 'num', 'es. 7', l.perPallet, ' inputmode="numeric"')) +
      '<div class="field"><label class="l" for="' + id + '-rem">Resto dei pezzi</label>' +
      '<select id="' + id + '-rem" data-f="remainder"><option value="separate"' + (l.remainder === 'separate' ? ' selected' : '') + '>In un ultimo pallet parziale</option>' +
      '<option value="last"' + (l.remainder === 'last' ? ' selected' : '') + '>Sommati all’ultimo pallet pieno</option></select></div>' +
      fld('Nome del foglio Excel', input('sheet', 'sheetName', '', '', l.sheetName)) +
      '<div class="field"><label class="l" for="' + id + '-start">' + (BX ? 'Prima scatola (seriale)' : 'Primo seriale') + '</label>' +
      '<input type="text" id="' + id + '-start" data-f="start" class="num" inputmode="numeric" autocomplete="off" spellcheck="false">' +
      '<span class="hint"><span data-o="startHint"></span> <button type="button" class="auto-btn" data-act="start-auto" hidden>torna all’automatico</button></span>' +
      '<label class="reuse" data-o="reuseRow" hidden><input type="checkbox" id="' + id + '-reuse" data-f="reuse"> Li riuso comunque</label></div>' +
      '<div class="field"><label class="l" for="' + id + '-pal">' + (BX ? 'Primo pallet (progressivo dell’anno)' : 'Primo pianale') + '</label>' +
      '<input type="text" id="' + id + '-pal" data-f="pallet" class="num" inputmode="numeric" autocomplete="off" spellcheck="false">' +
      '<span class="hint"><span data-o="palletHint"></span> <button type="button" class="auto-btn" data-act="pallet-auto" hidden>torna all’automatico</button></span>' +
      '<label class="reuse" data-o="preuseRow" hidden><input type="checkbox" id="' + id + '-preuse" data-f="palletReuse"> Li riuso comunque</label></div>' +
      '</div></div></details></article>';
  }

  function renderLines() {
    $('#linesHost').innerHTML = state.lines.map((l, i) => lineHtml(l, i, state.lines.length)).join('');
  }

  function setVal(el, v) { if (el && el.value !== v && document.activeElement !== el) el.value = v; }

  function paintLines(V) {
    V.lines.forEach((L) => {
      const art = document.querySelector('.line[data-id="' + L.line.id + '"]');
      if (!art) return;
      const q = (sel) => art.querySelector(sel);
      setVal(q('[data-f=perPallet]'), L.line.perPallet);
      const st = q('[data-f=start]');
      setVal(st, L.line.startManual ? L.line.startValue : (L.auto == null ? '' : String(L.auto)));
      st.placeholder = L.auto == null ? 'indica il primo seriale' : '';
      q('[data-act=start-auto]').hidden = !L.line.startManual;
      const pi = q('[data-f=pallet]');
      setVal(pi, L.line.palletManual ? L.line.palletValue : (L.pAuto == null ? '' : String(L.pAuto)));
      pi.placeholder = L.pAuto == null ? 'indica il primo pianale' : '';
      q('[data-act=pallet-auto]').hidden = !L.line.palletManual;
      let ph = '';
      if (L.pRegistered != null) ph = 'Ultimo registrato: ' + L.pRegistered;
      else if (rec(L.line.matricola)) ph = 'Nessun pianale registrato per questa matricola';
      if (L.pBase != null && L.pBase !== L.pRegistered) ph = 'Dopo la scheda precedente (' + L.pBase + ')';
      q('[data-o=palletHint]').textContent = L.box ? (L.pBase ? 'Ultimo pallet usato: ' + palSer(L.pBase) : 'Primo pallet del 20' + state.anno.trim()) : ph;
      const lt = q('[data-f=lotto]'); if (lt) lt.placeholder = defLot(rec(L.line.matricola));
      q('[data-o=preuseRow]').hidden = !(L.pClash || L.line.palletReuse);
      let hint = '';
      if (L.registered != null) hint = 'Ultimo registrato: ' + L.registered + (L.yLast ? ' (' + L.yLast + ')' : '');
      if (L.yearBase != null && L.yearBase !== L.registered) hint = 'Ultimo del 20' + L.year + ': ' + L.yearBase + (L.yearBase === 0 ? ', si parte da 1' : '');
      else if (rec(L.line.matricola)) hint = 'Nessuno storico per questa matricola';
      if (L.base != null && L.base !== L.registered) hint = 'Dopo la scheda precedente (' + L.base + ')';
      q('[data-o=startHint]').textContent = hint;
      q('[data-o=reuseRow]').hidden = !(L.clash || L.line.reuse);
      q('[data-f=sheetName]').placeholder = String((rec(L.line.matricola) || {}).sheetName || '').trim() || state.cfg.sheetName;
      const from = q('[data-o=from]');
      from.textContent = L.start != null && L.pStart != null
        ? 'Parte dal seriale ' + L.start + ' e dal pianale ' + L.pStart + (L.registered != null ? ' (ultimi usati: ' + L.registered + (L.pRegistered != null ? ' e ' + L.pRegistered : '') + ').' : '.')
        : '';
      if (L.box && L.start != null && L.pStart != null) from.textContent = 'Parte dalla scatola ' + L.start + ' e dal pallet ' + palSer(L.pStart) + ' · lotto ' + L.lotto + '.';
      const sum = q('[data-o=summary]');
      if (L.plan && L.box) {
        const p = L.plan;
        sum.innerHTML = '<span class="mono">' + nf.format(p.pcs) + '</span> pezzi in <span class="mono">' + nf.format(p.total) + '</span> scatole · <span class="mono">' + p.rows.length + '</span> pallet · scatole <span class="mono">' + range(p.firstSerial, p.lastSerial) +
          '</span> · pallet <span class="mono">' + esc(C.palRange(state.anno.trim(), p.firstPallet, p.lastPallet)) + '</span>';
      } else if (L.plan) {
        const p = L.plan;
        sum.innerHTML = '<span class="mono">' + nf.format(p.total) + '</span> pezzi · <span class="mono">' + p.rows.length + '</span> pallet (' + sizeDesc(p) +
          ') · seriali <span class="mono">' + range(p.firstSerial, p.lastSerial) + '</span> · pianali <span class="mono">' + range(p.firstPallet, p.lastPallet) + '</span>';
      } else sum.textContent = '';
      q('[data-o=msgs]').innerHTML =
        L.errors.map((m) => '<li class="bad">' + esc(m) + '</li>').join('') +
        L.todo.map((m) => '<li class="todo">' + esc(m) + '</li>').join('') +
        L.warns.map((m) => '<li class="warn">' + esc(m) + '</li>').join('') +
        L.infos.map((m) => '<li class="info">' + esc(m) + '</li>').join('');
    });
    $('#lottoMsgs').innerHTML = V.errors.map((m) => '<li class="bad">' + esc(m) + '</li>').join('');
  }

  function validLines(V) {
    return V.lines.filter((L) => L.plan && rec(L.line.matricola) && /^\d+$/.test(L.line.oda.trim()));
  }

  function paintPreview(V) {
    $('#secPreview').hidden = !state.lines.length;
    const host = $('#preview');
    const VL = validLines(V);
    if (!VL.length) {
      host.innerHTML = '<p class="empty">L’anteprima compare qui appena ordine e quantità sono completi: pallet per destinazione, intervalli di seriali e le prime righe del CSV.</p>';
      return;
    }
    const cfg = state.cfg, anno = state.anno.trim();
    let html = '';
    const BXL = VL.filter((L) => L.box);
    if (BXL.length) {
      html += '<div class="pv"><div class="pv-file"><span class="tag">Excel</span><span class="fname">' + esc(C.boxXlsxName(BXL.map((L) => L.line.matricola), state.mese)) + '</span><span class="meta">tabella di etichettatura: scatole e pallet</span></div>' +
        '<div class="scroll"><table><thead><tr><th>Matricola</th><th>Destinazione</th><th class="r">Pezzi</th><th class="r">Scatole</th><th class="r">Seriali scatole</th><th class="r">Pallet</th><th class="r">Seriali pallet</th></tr></thead><tbody>' +
        BXL.map((L) => L.plan.blocks.map((b, i) => '<tr><td class="mono">' + (i ? '' : esc(L.line.matricola)) + '</td><td>' + (esc(b.name) || '—') + '</td><td class="r num">' + nf.format(b.pcs) + '</td><td class="r num">' + esc(C.boxComp(b.pcs, L.box.pz)) +
          '</td><td class="r num">' + range(b.firstSerial, b.lastSerial) + '</td><td class="r num">' + esc(C.palComp(b.sizes, L.per)) + '</td><td class="r num">' + esc(C.palRange(anno, b.firstPallet, b.lastPallet)) + '</td></tr>').join('')).join('') +
        '</tbody></table></div></div>';
    }
    VL.forEach((L) => {
      if (L.box) return;
      const p = L.plan, mat = L.line.matricola, oda = L.line.oda.trim();
      const odd = (b) => {
        const m = new Map();
        b.sizes.forEach((s) => { if (s !== L.per) m.set(s, (m.get(s) || 0) + 1); });
        return Array.from(m.entries()).map((e) => '<span class="badge">' + e[1] + ' da ' + e[0] + '</span>').join('');
      };
      html += '<div class="pv"><div class="pv-file"><span class="tag">Excel</span><span class="fname">' + esc(C.xlsxName({ matricola: mat, oda: oda }, state.mese)) +
        '</span><span class="meta">foglio «' + esc(C.sheetTitle(L.sheet)) + '» · ' + p.rows.length + ' righe di pallet</span></div>' +
        '<div class="scroll"><table><thead><tr><th>Destinazione</th><th class="r">Pezzi</th><th class="r">Pallet</th><th class="r">Pianali</th><th class="r">Seriali</th></tr></thead><tbody>' +
        p.blocks.map((b) => '<tr><td>' + (esc(b.name) || '—') + '</td><td class="r num">' + nf.format(b.qty) + '</td><td class="r num">' + b.pallets + odd(b) + '</td><td class="r num">' +
          range(b.firstPallet, b.lastPallet) + '</td><td class="r num">' + range(b.firstSerial, b.lastSerial) + '</td></tr>').join('') +
        '</tbody></table></div></div>';
    });
    const items = csvItems(VL.map((L) => L.box ? { matricola: L.line.matricola, oda: L.line.oda.trim(), qty: L.plan.pcs, lot: L.lotto } : { matricola: L.line.matricola, oda: L.line.oda.trim(), firstSerial: L.plan.firstSerial, lastSerial: L.plan.lastSerial, prefix: matPrefix(L.line.matricola) }));
    const cfgFor = (it) => it.prefix ? Object.assign({}, cfg, { prefix: it.prefix }) : cfg;
    const total = items.reduce((a, it) => a + (it.qty != null ? 1 : it.lastSerial - it.firstSerial + 1), 0);
    const at = (k) => {
      for (const it of items) {
        if (it.qty != null) { if (k === 0) return C.qtyRow(it); k -= 1; continue; }
        const n = it.lastSerial - it.firstSerial + 1;
        if (k < n) return C.csvRow(it.matricola, it.oda, it.firstSerial + k, anno, cfgFor(it));
        k -= n;
      }
      return '';
    };
    const idx = total <= 6 ? Array.from({ length: total }, (_, i) => i) : [0, 1, 2, null, total - 2, total - 1];
    const it0 = items.find((x) => x.qty == null), bp = it0 ? C.barcodeParts(it0.matricola, it0.firstSerial, anno, cfgFor(it0)) : null;
    const seg = (v, c) => '<div class="seg"><span class="v">' + esc(v) + '</span><span class="c">' + c + '</span></div>';
    html += '<div class="pv"><div class="pv-file"><span class="tag">CSV</span><span class="fname">' + esc(C.csvName(state.avviso.trim(), items.map((i) => i.matricola))) +
      '</span><span class="meta">' + nf.format(total) + ' righe + intestazione</span></div>' +
      (bp ? '<div class="bc" aria-label="Composizione del barcode cliente">' + seg(bp.prefix, 'prefisso') + seg(bp.mat, 'matricola') + seg(bp.year, 'anno') + seg(bp.fixed, 'cifra fissa') + seg(bp.serial, 'seriale') + '</div>' : '') +
      (items.some((x) => x.qty != null) ? '<p class="meta">Prodotti a scatole: una riga per ODA con lotto e quantità totale, senza seriali.</p>' : '') +
      '<pre class="csv">' + esc(C.CSV_HEADER.join(';')) + '\n' + idx.map((k) => (k === null ? '…' : esc(at(k)))).join('\n') + '</pre></div>';
    host.innerHTML = html;
  }

  function reviewHtml(V) {
    const on = state.db.mode === 'on';
    const files = V.lines.filter((L) => !L.box).map((L) => C.xlsxName({ matricola: L.line.matricola, oda: L.line.oda.trim() }, state.mese));
    if (V.lines.some((L) => L.box)) files.push(C.boxXlsxName(V.lines.filter((L) => L.box).map((L) => L.line.matricola), state.mese));
    files.push(C.csvName(state.avviso.trim(), V.lines.map((L) => L.line.matricola)));
    const nd = [];
    V.lines.forEach((L) => L.newDests.forEach((n) => { if (!nd.some((x) => sameName(x, n))) nd.push(n); }));
    return '<div class="review"><p><b>Controlla prima di ' + (on ? 'registrare' : 'creare i file') + '</b></p><ul>' +
      V.lines.map((L) => '<li>Matricola <b class="mono">' + esc(L.line.matricola) + '</b> · ODA <span class="mono">' + esc(L.line.oda.trim()) + '</span> · ' + (L.box ? 'scatole <span class="mono">' + range(L.plan.firstSerial, L.plan.lastSerial) + '</span> · pallet <span class="mono">' + esc(C.palRange(state.anno.trim(), L.plan.firstPallet, L.plan.lastPallet)) + '</span> (' + nf.format(L.plan.pcs) + ' pezzi, lotto ' + esc(L.lotto) + ')'
        : 'seriali <span class="mono">' + range(L.plan.firstSerial, L.plan.lastSerial) + '</span> · pianali <span class="mono">' + range(L.plan.firstPallet, L.plan.lastPallet) + '</span> (' + nf.format(L.plan.total) + ' pezzi)') + '</li>').join('') +
      '</ul><p class="hint">File: ' + files.map(esc).join(' · ') + '</p>' +
      (on ? '<p>Questi numeri diventano gli ultimi usati: il prossimo lotto riparte da qui.' + (nd.length ? ' Aggiungo all’anagrafica le nuove destinazioni: ' + nd.map(esc).join(', ') + '.' : '') + '</p>'
        : '<p>I dati non sono collegati: i numeri valgono solo finché tieni aperta la pagina.</p>') +
      '<div class="row"><button type="button" class="btn primary" data-act="confirm"' + (state.busy ? ' disabled' : '') + '>' + (on ? 'Conferma e crea i file' : 'Crea i file') +
      '</button><button type="button" class="btn" data-act="cancel">Annulla</button></div></div>';
  }

  function paintAction(V) {
    $('#secAction').hidden = !state.lines.length;
    const el = $('#action');
    if (state.confirming && V.ok) { el.innerHTML = reviewHtml(V); return; }
    state.confirming = false;
    const on = state.db.mode === 'on';
    let why = '';
    if (!V.ok) {
      if (V.waiting) why = 'Sto caricando i dati…';
      else if (V.errors.length || V.lines.some((L) => L.errors.length)) why = 'Correggi le segnalazioni in rosso per continuare.';
      else why = 'Completa i dati delle schede per continuare.';
    }
    el.innerHTML = '<div class="row"><button type="button" class="btn primary" data-act="review"' + (V.ok && !state.busy ? '' : ' disabled') + '>' +
      (on ? 'Registra i numeri e crea i file' : 'Crea i file') + '</button><span class="hint">' + esc(why) + '</span></div>' +
      (state.db.mode === 'off' ? '<p class="hint">I dati non sono collegati in questa vista: l’anagrafica e i numeri restano solo finché tieni aperta la pagina.</p>' : '');
  }

  function paintChip() {
    const c = $('#dbChip'), m = state.db.mode, ld = window.__localDb;
    if (ld && m !== 'connecting') {
      const k = ld.chip(); c.dataset.s = k.s; c.textContent = k.t; c.dataset.act = 'folder-go'; c.style.cursor = 'pointer'; c.title = 'Apri le impostazioni della cartella';
      return;
    }
    c.dataset.s = m;
    c.textContent = m === 'on' ? 'Dati collegati' : (m === 'off' ? 'Dati non collegati' : 'Collego i dati…');
  }

  function notice(kind, text, keep) {
    clearTimeout(noticeTimer);
    const sp = text ? /^(.{25,160}?[.!?])\s+(.{30,})$/s.exec(text) : null;
    $('#notice').innerHTML = text ? '<div class="notice ' + kind + '">' + (sp ? esc(sp[1]) + ' <button type="button" class="nmore" data-act="notice-more">Dettagli</button><span class="ndet" hidden> ' + esc(sp[2]) + '</span>' : esc(text)) + '</div>' : '';
    if (text && !keep) noticeTimer = setTimeout(() => { $('#notice').innerHTML = ''; }, 9000);
  }

  function renderResult() {
    const el = $('#secResult'), R = state.result;
    if (!R) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = '<div><h2>File pronti</h2><p class="sub">' + (R.saved ? 'Numeri registrati. ' : 'Numeri non salvati: i dati non sono collegati. ') + 'Salva i file qui sotto.</p></div>' +
      '<ul style="margin:0;padding-left:18px">' + R.run.lines.map((l) => '<li>Matricola <b class="mono">' + esc(l.matricola) + '</b> · seriali <span class="mono">' +
        range(l.firstSerial, l.lastSerial) + '</span> · pianali <span class="mono">' + range(l.firstPallet, l.lastPallet) + '</span></li>').join('') + '</ul>' +
      '<div class="row"><button type="button" class="btn primary" data-act="save-all">Salva tutti i file</button><span class="fstat" id="saveAllStat"></span></div>' +
      '<div>' + R.files.map((f, i) => '<div class="file"><span class="tag">' + esc(f.kind) + '</span><span class="fname">' + esc(f.name) + '</span>' +
        '<button type="button" class="btn small" data-act="save" data-i="' + i + '">Salva</button><span class="fstat" data-s="' + i + '"></span></div>').join('') + '</div>' +
      '<div class="row">' + (() => { const rr = state.db.runs.find((x) => x.createdAt === R.run.createdAt); return rr && rr.lines.some((l) => !l.box) ? '<button type="button" class="btn" data-act="lab-open" data-run="' + esc(rr.id) + '">Stampa le etichette sulla Zebra</button>' : ''; })() + '<button type="button" class="btn ghost small" data-act="close-result">Chiudi</button></div>';
  }

  function paintRuns() {
    const host = $('#runsHost'), runs = state.db.runs;
    if (state.db.mode !== 'on') { host.innerHTML = '<p class="empty">I dati non sono collegati in questa vista: lo storico non è disponibile.</p>'; return; }
    if (!runs.length) { host.innerHTML = '<p class="empty">Nessun lotto registrato finora. Il primo comparirà qui, con i pulsanti per scaricare di nuovo i file.</p>'; return; }
    host.innerHTML = runsToolsHtml() + '<ul class="runs">' + runs.map((r) => {
      const when = new Date(r.createdAt);
      const files = filesForRun(r);
      return '<li><div class="when">' + esc(isNaN(when) ? '' : when.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })) +
        (r.avviso ? ' · Avv. ' + esc(r.avviso) : '') + ' · ' + esc(r.mese) + '</div>' +
        r.lines.map((l) => '<div class="meta">' + esc(l.matricola) + ' · ODA ' + esc(l.oda) + (l.box ? ' · scatole ' + range(l.firstSerial, l.lastSerial) + ' · pallet ' + esc(C.palRange(r.anno, l.firstPallet, l.lastPallet)) + ' · lotto ' + esc(l.lotto || '') : ' · seriali ' + range(l.firstSerial, l.lastSerial) + ' · pianali ' + range(l.firstPallet, l.lastPallet) + ' · ' + nf.format(l.total) + ' pezzi') + '</div>').join('') +
        '<div class="row">' + files.map((f, i) => '<button type="button" class="btn small" data-act="run-save" data-run="' + esc(r.id) + '" data-i="' + i + '">' + esc(f.label) + '</button>').join('') + '<button type="button" class="btn small" data-act="lab-open" data-run="' + esc(r.id) + '">Stampa etichette</button><button type="button" class="btn ghost small" data-act="rp-open" data-run="' + esc(r.id) + '">Ristampa una parte…</button><span class="fstat"></span><button type="button" class="btn ghost small danger" data-act="run-del" data-run="' + esc(r.id) + '">Elimina…</button></div>' + (SD.one === r.id ? runDelHtml(r) : '') + '' + (RP.run === r.id ? rpHtml(r) : '') + '</li>';
    }).join('') + '</ul>';
  }

  function paintConfig() {
    const host = $('#configHost');
    if (host.contains(document.activeElement)) return;
    const c = state.cfg;
    host.innerHTML = '<div class="grid"><div class="field"><label class="l" for="cfgPrefix">Prefisso fisso</label><input type="text" id="cfgPrefix" class="num" autocomplete="off" value="' + esc(c.prefix) + '"></div>' +
      '<div class="field"><label class="l" for="cfgFixed">Cifra fissa dopo l’anno</label><input type="text" id="cfgFixed" class="num" maxlength="1" autocomplete="off" value="' + esc(c.fixedDigit) + '"></div>' +
      '<div class="field"><label class="l" for="cfgSheet">Nome predefinito del foglio</label><input type="text" id="cfgSheet" autocomplete="off" value="' + esc(c.sheetName) + '"></div></div>' +
      '<div class="row"><button type="button" class="btn small" data-act="save-config">Salva regole</button><span class="hint">Barcode cliente = prefisso + matricola + anno + cifra fissa + seriale a 10 cifre.</span></div>';
  }

  /* ---------- modifica anagrafica ---------- */
  function openEditor(mat) {
    const r = mat ? rec(mat) : null;
    state.edit = {
      mat: mat || null, dests: destList(r),
      origLast: r && isInt(r.last) ? r.last : null, origPal: r && isInt(r.lastPallet) ? r.lastPallet : null,
      f: {
        mat: mat || '', desc: (r && r.descrizione) || '', per: r && isInt(r.perPallet) ? String(r.perPallet) : '',
        rem: r && r.remainder === 'last' ? 'last' : 'separate', sheet: (r && r.sheetName) || '',
        last: r ? (isInt(r.last) ? String(r.last) : '') : '0', pal: r ? (isInt(r.lastPallet) ? String(r.lastPallet) : '') : '0', arch: !!(r && r.archived), prefix: (r && r.prefix) || '', prod: (r && r.prodotto) || '',
        ext: !!(r && r.esterno), box: !!(r && r.scatole), bpz: r && isInt(r.boxPz) ? String(r.boxPz) : '', bper: r && isInt(r.boxPerPallet) ? String(r.boxPerPallet) : '', blet: (r && r.lottoLettera) || ''
      }
    };
    showView('matricole');
    renderEditor();
    const el = $('#matEditor');
    el.scrollIntoView({ block: 'start' });
    const first = document.getElementById(mat ? 'e-desc' : 'e-mat'); if (first) first.focus({ preventScroll: true });
  }

  function syncDraft() {
    const E = state.edit; if (!E) return;
    document.querySelectorAll('#matEditor [data-e]').forEach((el) => { E.f[el.dataset.e] = el.type === 'checkbox' ? el.checked : el.value; });
  }

  function renderEditor() {
    const host = $('#matEditor'), E = state.edit;
    host.hidden = !E;
    paintMatGrid();
    if (!E) { host.innerHTML = ''; return; }
    const f = E.f, isNew = !E.mat;
    const field = (label, id, inner, hint, cls) => '<div class="field' + (cls ? ' ' + cls : '') + '"><label class="l" for="' + id + '">' + label + '</label>' + inner + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
    const inp = (key, cls, ph, extra) => '<input type="text" id="e-' + key + '" data-e="' + key + '" class="' + (cls || '') + '" autocomplete="off" spellcheck="false" placeholder="' + esc(ph || '') + '" value="' + esc(f[key]) + '"' + (extra || '') + '>';
    host.innerHTML =
      '<div><h2>' + (isNew ? 'Nuova matricola' : 'Matricola ' + esc(E.mat)) + '</h2><p class="sub">Questi dati vengono proposti da soli ogni volta che scegli la matricola in un nuovo lotto.</p></div>' +
      '<div class="grid g3">' +
      field('Matricola (codice prodotto)', 'e-mat', inp('mat', 'num', 'es. 100200', ' inputmode="numeric"'), isNew ? '' : 'Se la cambi, passano al nuovo codice anche ordini, collaudi e storico di questa matricola.') +
      field('Descrizione', 'e-desc', inp('desc', '', 'es. nome del prodotto'), '', 'span2') +
      (f.box ? '' : field('Pezzi per pallet', 'e-per', inp('per', 'num', 'es. 7', ' inputmode="numeric"'), 'Dipende dal volume del prodotto.')) +
      '<div class="field"><label class="l" for="e-rem">Resto dei pezzi</label><select id="e-rem" data-e="rem">' +
      '<option value="separate"' + (f.rem === 'separate' ? ' selected' : '') + '>In un ultimo pallet parziale</option>' +
      '<option value="last"' + (f.rem === 'last' ? ' selected' : '') + '>Sommati all’ultimo pallet pieno</option></select>' +
      '<span class="hint">300 pezzi a 7: 42 da 7 + 1 da 6, oppure 41 da 7 + 1 da 13.</span></div>' +
      field('Prefisso del barcode', 'e-prefix', inp('prefix', 'num', state.cfg.prefix, ' inputmode="numeric"'), 'Vuoto = quello generale (' + esc(state.cfg.prefix) + '), in Storico › Regole del codice a barre.') +
      (f.ext ? '' : matProdField(f)) +
      field('Nome del foglio Excel', 'e-sheet', inp('sheet', '', state.cfg.sheetName), 'Vuoto = predefinito (' + esc(state.cfg.sheetName) + ').') +
      '</div>' +
      '<div class="group"><h3>Produzione e confezione</h3>' +
      '<label class="reuse"><input type="checkbox" id="e-ext" data-e="ext" data-rerender="1"' + (f.ext ? ' checked' : '') + '> Prodotto esterno (non realizzato in officina)</label>' +
      '<span class="hint">Niente stima e niente avvisi dalla produzione: ordini, calendario, avviso e file funzionano come sempre. Se un giorno lo fate in casa, togli la spunta e collega il prodotto della produzione.</span>' +
      '<label class="reuse"><input type="checkbox" id="e-box" data-e="box" data-rerender="1"' + (f.box ? ' checked' : '') + '> Confezione a scatole: il seriale è della scatola</label>' +
      (f.box ? '<div class="grid g3">' +
        field('Pezzi per scatola', 'e-bpz', inp('bpz', 'num', 'es. 14', ' inputmode="numeric"')) +
        field('Scatole per pallet', 'e-bper', inp('bper', 'num', 'es. 30', ' inputmode="numeric"')) +
        field('Lettera del lotto', 'e-blet', inp('blet', '', 'M', ' maxlength="4"'), 'Lotto nel CSV = lettera + mese + / + anno, per esempio M7/26.') + '</div>' +
        '<span class="hint">Ogni destinazione parte con scatole e pallet nuovi; l’ultima scatola può essere parziale. Il pallet è anno + progressivo (2601, 2602…), comune a tutte le matricole a scatole. Nel CSV una riga per ODA con lotto e quantità.</span>' : '') +
      '</div>' +
      '<div class="group"><h3>Destinazioni abituali</h3>' +
      '<div class="chips">' + (E.dests.length ? E.dests.map((d, i) => '<span class="dchip">' + esc(d) + '<button type="button" class="x" data-act="rm-chip" data-i="' + i + '" aria-label="Togli ' + esc(d) + '">×</button></span>').join('')
        : '<span class="meta">Nessuna: le aggiungo da sola quando registri un lotto con una destinazione nuova.</span>') + '</div>' +
      '<div class="addrow"><input type="text" id="e-newdest" autocomplete="off" aria-label="Nuova destinazione" placeholder="es. Milano, Torino"><button type="button" class="btn" data-act="add-chip">Aggiungi</button></div>' +
      '<span class="hint">Nel nuovo lotto compaiono già in elenco: scrivi solo le quantità di quelle che servono.</span></div>' +
      '<div class="group"><h3>Numerazione</h3>' +
      '<p class="sub" style="margin:0">Si aggiorna da sola a ogni lotto registrato. Modificala solo per correggere. Il prossimo lotto parte dal numero successivo.</p>' +
      '<div class="grid g3">' +
      field(f.box ? 'Ultima scatola usata (seriale)' : 'Ultimo seriale usato', 'e-last', inp('last', 'num', '', ' inputmode="numeric"'), isNew ? '0 se la matricola non è mai stata usata.' : '') +
      (f.box ? field('Ultimo pallet a scatole del 20' + esc(state.anno.trim()), 'e-bpal', '<input type="text" id="e-bpal" class="num" readonly value="' + esc(boxPalLast(state.anno.trim()) ? palSer(boxPalLast(state.anno.trim())) : 'nessuno') + '">', 'Comune a tutte le matricole a scatole: si aggiorna con i lotti.') : '') +
      field('Ultimo pianale usato', 'e-pal', inp('pal', 'num', 'da indicare', ' inputmode="numeric"'), isNew ? '0 se non c’è ancora nessun pianale.' : 'Vuoto = lo chiedo nel prossimo lotto.') +
      '</div></div>' +
      '<label class="reuse"><input type="checkbox" id="e-arch" data-e="arch"' + (f.arch ? ' checked' : '') + '> Nascondi questa matricola dalle scelte del lotto</label>' +
      matDelBarHtml('editor') + numAskHtml(E) + '<div class="row"><button type="button" class="btn primary" data-act="save-mat">Salva matricola</button><button type="button" class="btn" data-act="cancel-mat">Annulla</button>' + (isNew ? '' : '<button type="button" class="btn ghost danger" data-act="del-mat" data-mat="' + esc(E.mat) + '">Elimina matricola…</button>') + '</div>';
  }

  function addChips() {
    syncDraft();
    const inp = $('#e-newdest'); if (!inp || !state.edit) return;
    inp.value.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => {
      if (!state.edit.dests.some((d) => sameName(d, n))) state.edit.dests.push(n);
    });
    renderEditor();
    const again = $('#e-newdest'); if (again) again.focus();
  }

  async function saveMat() {
    syncDraft();
    const E = state.edit; if (!E) return;
    const f = E.f, mat = f.mat.trim(), renaming = !!E.mat && mat !== E.mat;
    const bad = (m) => notice('bad', m, true);
    if (!/^\d+$/.test(mat)) return bad('Indica la matricola (solo cifre).');
    if ((!E.mat || renaming) && rec(mat)) return bad('La matricola ' + mat + ' esiste già: aprila dall’elenco per modificarla.');
    if (renaming && !dbh) return bad('Per cambiare il codice servono i dati collegati.');
    const perRaw = f.per.trim(); let per = null;
    if (perRaw !== '') { per = C.toInt(perRaw); if (!(per >= 1)) return bad('I pezzi per pallet devono essere un numero intero da 1 in su.'); }
    const last = C.toInt(f.last);
    if (!isInt(last) || last > C.MAX_SERIAL) return bad('Indica l’ultimo seriale usato (0 se la matricola non è mai stata usata).');
    const palRaw = f.pal.trim(); let pal = null;
    if (palRaw !== '') { pal = C.toInt(palRaw); if (!isInt(pal)) return bad('L’ultimo pianale deve essere un numero intero (0 se non è mai stato usato), oppure vuoto.'); }
    const next = Object.assign({}, rec(E.mat || mat) || {});
    const put = (k, v, empty) => { if (empty) delete next[k]; else next[k] = v; };
    put('descrizione', f.desc.trim(), !f.desc.trim());
    put('perPallet', per, per == null);
    next.remainder = f.rem === 'last' ? 'last' : 'separate';
    put('sheetName', f.sheet.trim(), !f.sheet.trim());
    put('destinations', E.dests.slice(), !E.dests.length);
    put('archived', true, !f.arch);
    const pre = String(f.prefix || '').trim();
    if (pre && !/^\d{1,12}$/.test(pre)) return bad('Il prefisso del barcode deve contenere solo cifre (oppure lascialo vuoto).');
    put('prefix', pre, !pre);
    put('prodotto', String(f.prod || '').trim(), !String(f.prod || '').trim());
    put('esterno', true, !f.ext);
    if (f.box) {
      const bpz = C.toInt(String(f.bpz || '').trim()), bper = C.toInt(String(f.bper || '').trim());
      if (!(bpz >= 1)) return bad('Indica i pezzi per scatola (numero intero da 1 in su).');
      if (!(bper >= 1)) return bad('Indica le scatole per pallet (numero intero da 1 in su).');
      const let_ = String(f.blet || '').trim();
      if (/[;\s\/]/.test(let_)) return bad('La lettera del lotto non può contenere spazi, barre o punto e virgola.');
      next.scatole = true; next.boxPz = bpz; next.boxPerPallet = bper; put('lottoLettera', let_, !let_);
    } else { delete next.scatole; }
    /* Correzione a mano degli ultimi numeri: serve una conferma esplicita. */
    if (E.mat && (last !== E.origLast || pal !== E.origPal)) {
      const key = last + '|' + pal;
      if (E.okKey !== key) { E.ask = { key: key, last: last, oLast: E.origLast, pal: pal, oPal: E.origPal }; renderEditor(); const n = document.querySelector('#matEditor .numask'); if (n) n.scrollIntoView({ block: 'center' }); return; }
    }
    E.ask = null;
    /* I numeri si toccano solo se li hai cambiati tu: un lotto registrato nel frattempo non viene sovrascritto. */
    if (!E.mat || last !== E.origLast) { const ly = (E.mat && lastYearOf(E.mat)) || String(new Date().getFullYear()).slice(-2); next.last = last; next.lastYear = ly; next.lastByYear = Object.assign({}, next.lastByYear || {}, { [ly]: last }); }
    if (!E.mat || pal !== E.origPal) put('lastPallet', pal, pal == null);
    next.updatedAt = new Date().toISOString();
    const ok = await writeDoc('serials/' + mat, next, renaming ? 'Matricola ' + E.mat + ' cambiata in ' + mat + '.' : 'Matricola ' + mat + ' salvata.');
    if (ok && renaming) await migrateMat(E.mat, mat);
    if (ok) { state.edit = null; renderEditor(); update(); }
  }

  /* ---------- scrittura dati ---------- */
  function applyLocal(path, data) {
    if (path.indexOf('serials/') === 0) state.db.serials[path.slice(8)] = data;
    else if (path === 'meta/config') state.cfg = Object.assign({}, state.cfg, { prefix: data.prefix, fixedDigit: data.fixedDigit, sheetName: data.sheetName });
    refreshAll();
  }
  async function writeDoc(path, data, okText) {
    if (!dbh) { applyLocal(path, data); notice('warn', okText + ' Solo per questa sessione: i dati non sono collegati.', true); return true; }
    try {
      await dbh.doc(path).set(data);
      if (path.indexOf('serials/') === 0) state.db.serials[path.slice(8)] = data;
      notice('ok', okText);
      return true;
    } catch (e) {
      notice('bad', 'Non sono riuscito a salvare' + ((e && e.message) ? ' (' + e.message + ')' : '') + '.', true);
      return false;
    }
  }

  const VIEWS = ['oggi', 'ordini', 'calendario', 'avanzamento', 'lotto', 'etichette', 'matricole', 'storico'];
  const startView = () => { const h = location.hash.slice(1); return VIEWS.includes(h) ? h : 'oggi'; };
  function showView(v) {
    state.view = v;
    try { if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v); } catch (e) { /* file locale */ }
    if (v === 'oggi') setTimeout(() => { try { paintOggi(); } catch (e) { /* nessuno */ } }, 0);
    if (v === 'calendario') setTimeout(() => { try { paintCal(); } catch (e) { /* nessuno */ } }, 0);
    document.querySelectorAll('.view[data-view]').forEach((el) => { el.hidden = el.dataset.view !== v; });
    document.querySelectorAll('.tabs [data-view]').forEach((b) => { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  }

  function update() {
    syncPerPallet();
    view = compute();
    paintLines(view); paintPicker(); paintPreview(view); paintAction(view); paintChip(); paintDays();
  }
  function refreshAll() { try { paintLab(); } catch (e) { /* etichette */ }
    try { paintRiep(); } catch (e) { /* riepilogo: non blocca il resto */ }
    try { paintOggi(); } catch (e) { /* pagina Oggi: non blocca il resto */ }
    ecoCompute(); update(); paintRuns(); paintMatGrid(); paintConfig(); paintOrders(false); paintCal(); paintBell(); maybeMonthToast(); opPaint(false); paintEco(); }

  /* ---------- registrazione ---------- */
  function nextDoc(cur, f, stamp) {
    const y = state.anno.trim(), ly = /^\d{2}$/.test(String(cur.lastYear || '')) ? String(cur.lastYear) : (f.mat ? lastYearOf(f.mat) : null);
    const byY = Object.assign({}, cur.lastByYear || {});
    if (ly && isInt(cur.last) && !isInt(byY[ly])) byY[ly] = cur.last;
    byY[y] = f.last;
    const newer = !ly || +y >= +ly;
    const next = Object.assign({}, cur, f.box ? {} : { lastPallet: f.lastPallet }, { lastByYear: byY, updatedAt: stamp }, newer ? { last: f.last, lastYear: y } : {});
    if (!f.box && !isInt(next.perPallet)) next.perPallet = f.per;
    const names = destList(cur);
    f.newDests.forEach((n) => { if (!names.some((k) => sameName(k, n))) names.push(n); });
    if (names.length) next.destinations = names;
    return next;
  }

  async function register() {
    const V = compute();
    if (!V.ok || state.busy) return;
    state.busy = true; state.confirming = false; paintAction(V);
    const stamp = new Date().toISOString();
    const run = {
      createdAt: stamp, avviso: state.avviso.trim(), mese: state.mese, anno: state.anno.trim(),
      prefix: state.cfg.prefix, fixedDigit: state.cfg.fixedDigit,
      lines: V.lines.map((L) => ({
        matricola: L.line.matricola, oda: L.line.oda.trim(), perPallet: L.per, remainder: L.line.remainder,
        sheetName: L.sheet,
        destinations: L.dests.map((d) => ({ name: d.name, qty: d.qty })),
        box: L.box ? { pz: L.box.pz, per: L.per } : null, lotto: L.box ? L.lotto : null,
        firstSerial: L.plan.firstSerial, lastSerial: L.plan.lastSerial, firstPallet: L.plan.firstPallet, lastPallet: L.plan.lastPallet, total: L.plan.total,
        prefix: matPrefix(L.line.matricola) || state.cfg.prefix,
        prevSerial: V.bases[L.line.matricola] ? V.bases[L.line.matricola].serial : null, prevYear: L.yLast || null, prevYearSerial: isInt(L.base) ? L.base : null
      }))
    };
    const BXR = V.lines.filter((L) => L.box);
    if (BXR.length) run.boxPal = { year: state.anno.trim(), prev: boxPalLast(state.anno.trim()), last: Math.max.apply(null, BXR.map((L) => L.plan.lastPallet)) };
    const finals = {};
    V.lines.forEach((L) => {
      const mat = L.line.matricola;
      const f = finals[mat] || (finals[mat] = { last: 0, lastPallet: 0, per: L.per, newDests: [], mat: mat });
      f.last = L.plan.lastSerial; f.box = !!L.box; f.lastPallet = L.box ? null : L.plan.lastPallet; f.per = L.per;
      L.newDests.forEach((n) => { if (!f.newDests.some((k) => sameName(k, n))) f.newDests.push(n); });
    });
    let saved = false, runId = null;
    if (state.db.mode === 'on' && dbh) {
      const cur = {}; let boxDoc = null;
      try {
        if (run.boxPal) {
          const bs = await dbh.doc('meta/scatole').get(), bd = bs.exists ? Object.assign({}, bs.data() || {}) : {};
          const by = Object.assign({}, bd.palByYear || {}), cv = isInt(by[run.boxPal.year]) ? by[run.boxPal.year] : 0;
          if (cv !== run.boxPal.prev) throw new Error('CONFLICT');
          by[run.boxPal.year] = Math.max(cv, run.boxPal.last);
          boxDoc = Object.assign(bd, { palByYear: by, updatedAt: stamp });
        }
        for (const mat of Object.keys(V.bases)) {
          const s = await dbh.doc('serials/' + mat).get();
          const d = s.exists ? Object.assign({}, s.data() || {}) : {};
          const cs = isInt(d.last) ? d.last : null, cp = isInt(d.lastPallet) ? d.lastPallet : null;
          if (cs !== V.bases[mat].serial || cp !== V.bases[mat].pallet || JSON.stringify(d.lastByYear || null) !== V.bases[mat].byY) throw new Error('CONFLICT');
          cur[mat] = d;
        }
        for (const mat of Object.keys(finals)) {
          const nd = nextDoc(cur[mat] || {}, finals[mat], stamp);
          await dbh.doc('serials/' + mat).set(nd);
          state.db.serials[mat] = nd;
        }
        if (boxDoc) { await dbh.doc('meta/scatole').set(boxDoc); state.boxPal = Object.assign({}, boxDoc.palByYear); }
        saved = true;
      } catch (e) {
        state.busy = false;
        if (e && e.message === 'CONFLICT') notice('bad', 'I numeri registrati sono cambiati mentre preparavi il lotto (un’altra persona o un’altra scheda). Non ho registrato nulla: ricontrolla l’anteprima e riprova.', true);
        else notice('bad', 'Non sono riuscito a salvare i numeri' + ((e && e.message) ? ' (' + e.message + ')' : '') + '. Controlla gli ultimi numeri in “Matricole” prima di riprovare.', true);
        update(); return;
      }
      try { const ref = await dbh.collection('runs').add(run); runId = ref && ref.id ? ref.id : null; }
      catch (e) { notice('warn', 'I numeri sono stati registrati, ma il lotto non è finito nell’elenco “Storico”. I file sono pronti comunque.', true); }
    } else {
      Object.keys(finals).forEach((mat) => { state.db.serials[mat] = nextDoc(state.db.serials[mat] || {}, finals[mat], stamp); });
      if (run.boxPal) state.boxPal = Object.assign({}, state.boxPal, { [run.boxPal.year]: Math.max(run.boxPal.prev, run.boxPal.last) });
    }
    /* I collaudi del calendario da cui arrivano le schede passano a "file creati". */
    let evFail = false;
    for (const L of V.lines) {
      const eid = L.line.eventId;
      if (!eid || !eventById(eid)) continue;
      try { await patchDoc('events', eid, { status: 'files', runId: runId, filesAt: stamp, lines: L.dests.map((d) => ({ name: d.name, qty: d.qty })), updatedAt: stamp }); }
      catch (e) { evFail = true; }
    }
    if (evFail) notice('warn', 'I file sono pronti, ma non sono riuscito ad aggiornare lo stato nel calendario.', true);
    state.busy = false;
    state.result = { run: run, files: filesForRun(run), saved: saved };
    state.lines = []; state.avviso = '';
    $('#avviso').value = '';
    renderLines(); refreshAll(); renderResult();
    $('#secResult').scrollIntoView({ block: 'start' });
  }

  /* ---------- eventi ---------- */
  $('#linesHost').addEventListener('input', (e) => {
    const t = e.target, art = t.closest('.line');
    if (!art || !t.dataset.f) return;
    const line = state.lines.find((l) => l.id === art.dataset.id);
    if (!line) return;
    const f = t.dataset.f;
    if (f === 'oda') line.oda = t.value;
    else if (f === 'lotto') line.lotto = t.value;
    else if (f === 'perPallet') { line.perPallet = t.value; line.perPalletManual = true; }
    else if (f === 'start') { line.startManual = true; line.startValue = t.value; }
    else if (f === 'sheetName') line.sheetName = t.value;
    else if (f === 'remainder') line.remainder = t.value;
    else if (f === 'reuse') line.reuse = t.checked;
    else if (f === 'pallet') { line.palletManual = true; line.palletValue = t.value; }
    else if (f === 'palletReuse') line.palletReuse = t.checked;
    else if (f === 'dname' || f === 'dqty') {
      const d = line.dests[Number(t.closest('.dest').dataset.di)];
      if (d) d[f === 'dname' ? 'name' : 'qty'] = t.value;
    }
    state.confirming = false;
    update();
  });
  /* Ricorda se hai aperto le opzioni di una scheda (il disegno si rifà quando cambi le destinazioni). */
  $('#linesHost').addEventListener('toggle', (e) => {
    const art = e.target.closest && e.target.closest('.line');
    const line = art && state.lines.find((l) => l.id === art.dataset.id);
    if (line && e.target.matches('details[data-o=opts]')) line.optsOpen = e.target.open;
  }, true);
  $('#avviso').addEventListener('input', (e) => { state.avviso = e.target.value; state.confirming = false; update(); });
  $('#anno').addEventListener('input', (e) => { state.anno = e.target.value; state.confirming = false; update(); });
  $('#mese').addEventListener('change', (e) => { state.mese = e.target.value; state.confirming = false; update(); });
  $('#matEditor').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'e-newdest') { e.preventDefault(); addChips(); }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const art = b.closest('.line');
    const line = art ? state.lines.find((l) => l.id === art.dataset.id) : null;
    if (act === 'nav') {
      showView(b.dataset.view);
    } else if (act === 'pick') {
      const mat = b.dataset.mat;
      if (state.lines.some((l) => l.matricola === mat)) state.lines = state.lines.filter((l) => l.matricola !== mat);
      else state.lines.push(newLine(mat));
      state.confirming = false; renderLines(); update();
      const ln = state.lines.find((l) => l.matricola === mat);
      if (ln) { const el = document.getElementById(ln.id + '-oda'); if (el) el.focus({ preventScroll: true }); if (el) el.scrollIntoView({ block: 'center' }); }
    } else if (act === 'dup-line' && line) {
      const idx = state.lines.map((l) => l.matricola).lastIndexOf(line.matricola);
      const nl = newLine(line.matricola); nl.remainder = line.remainder; nl.optsOpen = line.optsOpen;
      state.lines.splice(idx + 1, 0, nl); state.confirming = false; renderLines(); update();
      const el = document.getElementById(nl.id + '-oda'); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    } else if (act === 'remove-line' && line) {
      state.lines = state.lines.filter((l) => l !== line); state.confirming = false; renderLines(); update();
    } else if (act === 'add-dest' && line) {
      line.dests.push({ name: '', qty: '' }); renderLines(); update();
      const el = document.getElementById(line.id + '-d' + (line.dests.length - 1) + 'n'); if (el) el.focus();
    } else if (act === 'remove-dest' && line) {
      line.dests.splice(Number(b.closest('.dest').dataset.di), 1); renderLines(); update();
    } else if (act === 'start-auto' && line) {
      line.startManual = false; line.startValue = ''; line.reuse = false; update();
    } else if (act === 'pallet-auto' && line) {
      line.palletManual = false; line.palletValue = ''; line.palletReuse = false; update();
    } else if (act === 'review') {
      if (view && view.ok) { state.confirming = true; paintAction(view); }
    } else if (act === 'cancel') {
      state.confirming = false; update();
    } else if (act === 'confirm') {
      register();
    } else if (act === 'close-result') {
      state.result = null; renderResult();
    } else if (act === 'save' && state.result) {
      saveFile(state.result.files[Number(b.dataset.i)], b.parentElement.querySelector('.fstat'));
    } else if (act === 'save-all' && state.result) {
      const stat = $('#saveAllStat'); b.disabled = true;
      let n = 0;
      for (let i = 0; i < state.result.files.length; i++) {
        const res = await saveFile(state.result.files[i], document.querySelector('#secResult .fstat[data-s="' + i + '"]'));
        if (res === 'saved') n++; else if (res === 'declined') break;
      }
      stat.textContent = n + ' di ' + state.result.files.length + ' file salvati';
      b.disabled = false;
    } else if (act === 'run-save') {
      const run = state.db.runs.find((r) => r.id === b.dataset.run);
      if (run) saveFile(filesForRun(run)[Number(b.dataset.i)], b.parentElement.querySelector('.fstat'));
    } else if (act === 'new-mat') {
      openEditor(null);
    } else if (act === 'edit-mat') {
      openEditor(b.dataset.mat);
    } else if (act === 'add-chip') {
      addChips();
    } else if (act === 'rm-chip' && state.edit) {
      syncDraft(); state.edit.dests.splice(Number(b.dataset.i), 1); renderEditor();
    } else if (act === 'save-mat') {
      saveMat();
    } else if (act === 'cancel-mat') {
      state.edit = null; renderEditor();
    } else if (act === 'save-config') {
      const prefix = $('#cfgPrefix').value.trim(), fixed = $('#cfgFixed').value.trim(), sheet = $('#cfgSheet').value.trim();
      if (!/^\d+$/.test(prefix)) return notice('bad', 'Il prefisso deve essere composto da sole cifre.', true);
      if (!/^\d$/.test(fixed)) return notice('bad', 'La cifra fissa deve essere una sola cifra.', true);
      if (!sheet) return notice('bad', 'Indica un nome per il foglio.', true);
      writeDoc('meta/config', { prefix: prefix, fixedDigit: fixed, sheetName: sheet, updatedAt: new Date().toISOString() }, 'Regole salvate.');
    }
  });

  /* ---------- collegamento ai dati ---------- */
  async function initDb() {
    const cl = window.claude;
    if (!cl || typeof cl.use !== 'function') { state.db.mode = 'off'; refreshAll(); return; }
    try {
      const r = await Promise.all([cl.use('db').catch(() => null), cl.use('downloads').catch(() => null)]);
      dbh = r[0]; dlh = r[1];
    } catch (e) { dbh = null; dlh = null; }
    if (!dbh) { state.db.mode = 'off'; refreshAll(); return; }
    state.db.mode = 'on';
    const fail = (e) => {
      if (state.db.mode === 'off') return;
      state.db.mode = 'off';
      notice('warn', 'Ho perso il collegamento ai dati' + ((e && e.code) ? ' (' + e.code + ')' : '') + '. Puoi continuare, ma i numeri non vengono salvati.', true);
      refreshAll();
    };
    dbh.collection('serials').onSnapshot((snap) => {
      const m = {};
      snap.docs.forEach((d) => { m[d.id] = d.data() || {}; });
      state.db.serials = m; state.db.got.serials = true;
      /* Se una matricola scelta sparisce dall'anagrafica, la scheda esce dal lotto. */
      const before = state.lines.length;
      state.lines = state.lines.filter((l) => m[l.matricola]);
      if (state.lines.length !== before) renderLines();
      refreshAll();
    }, fail);
    dbh.doc('meta/config').onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : null;
      const c = Object.assign({}, C.DEFAULT_CFG);
      if (d && /^\d+$/.test(String(d.prefix || ''))) c.prefix = String(d.prefix);
      if (d && /^\d$/.test(String(d.fixedDigit || ''))) c.fixedDigit = String(d.fixedDigit);
      if (d && String(d.sheetName || '').trim()) c.sheetName = String(d.sheetName).trim();
      state.cfg = c; refreshAll();
    }, fail);
    dbh.collection('orders').onSnapshot((snap) => {
      state.db.orders = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      state.db.got.orders = true; refreshAll();
    }, fail);
    dbh.doc('meta/reminders').onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : null;
      state.rem.done = d && d.ordersDone && typeof d.ordersDone === 'object' ? Object.assign({}, d.ordersDone) : {};
      state.rem.got = true; refreshAll();
    }, fail);
    dbh.doc('meta/stampa').onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : null;
      LAB.cfg = Object.assign({ conn: 'ip', ip: '', share: 'ZEBRA', template: '' }, d && typeof d === 'object' ? { conn: d.conn === 'share' ? 'share' : 'ip', ip: d.ip || '', share: d.share || 'ZEBRA', template: d.template || '' } : {});
      paintLabCfg(); paintLab();
    }, fail);
    dbh.doc('meta/scatole').onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : null;
      state.boxPal = d && d.palByYear && typeof d.palByYear === 'object' ? Object.assign({}, d.palByYear) : {}; refreshAll();
    }, fail);
    dbh.doc('meta/eco').onSnapshot((snap) => {
      const d = snap.exists ? snap.data() : null;
      ECO.cfg = d && typeof d === 'object' ? Object.assign({}, d) : {}; refreshAll();
    }, fail);
    dbh.collection('events').onSnapshot((snap) => {
      state.db.events = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      state.db.got.events = true; refreshAll();
    }, fail);
    dbh.collection('runs').orderBy('createdAt', 'desc').limit(30).onSnapshot((snap) => {
      state.db.runs = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).filter((r) => Array.isArray(r.lines) && r.lines.length);
      refreshAll();
    }, fail);
    refreshAll();
  }

  /* =====================================================================
     ORDINI · CALENDARIO · COLLAUDI
     ===================================================================== */
  const pad2 = (n) => String(n).padStart(2, '0');
  const parseYmd = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12);
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
  const todayStr = () => ymd(new Date());
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
  const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const dayLabel = (s, full) => { const d = parseYmd(s); return (full ? WEEKDAYS[d.getDay()] : WEEKDAYS[d.getDay()].slice(0, 3)) + ' ' + d.getDate() + ' ' + C.MESI[d.getMonth()].toLowerCase(); };
  const sumOf = (a) => a.reduce((x, y) => x + y, 0);
  const lineKey = (n) => String(n == null ? '' : n).trim().toLowerCase();
  const nowIso = () => new Date().toISOString();
  const plural = (n, one, many) => nf.format(n) + ' ' + (n === 1 ? one : many);
  function relDays(n) { return n === 0 ? 'oggi' : n === 1 ? 'domani' : n === -1 ? 'ieri' : n > 0 ? 'tra ' + n + ' giorni' : (-n) + ' giorni fa'; }

  /* ---------- scritture su ordini e collaudi ---------- */
  function localPut(kind, id, data, replace) {
    const arr = state.db[kind], i = arr.findIndex((x) => x.id === id);
    if (i >= 0) arr[i] = replace ? Object.assign({ id: id }, data) : Object.assign({}, arr[i], data);
    else arr.push(Object.assign({ id: id }, data));
  }
  async function createDoc(kind, data) {
    if (!dbh) { const id = 'loc' + (++seq) + Date.now().toString(36); localPut(kind, id, data, true); return id; }
    const ref = await dbh.collection(kind).add(data);
    localPut(kind, ref.id, data, true);
    return ref.id;
  }
  async function patchDoc(kind, id, patch) {
    if (kind === 'events' && patch && isYmd(patch.date)) {
      const pe = state.db.events.find((x) => x.id === id);
      if (pe && isYmd(pe.date) && pe.date !== patch.date) patch = Object.assign({}, patch, { spostamenti: (pe.spostamenti || 0) + 1, dataOriginale: pe.dataOriginale || pe.date });
    }
    const prev = state.db[kind].find((x) => x.id === id);
    const backup = prev ? Object.assign({}, prev) : null;
    localPut(kind, id, patch);
    if (!dbh) return;
    try { await dbh.doc(kind + '/' + id).update(patch); }
    catch (e) { if (backup) localPut(kind, id, backup, true); throw e; }
  }
  async function dropDoc(kind, id) {
    if (dbh) await dbh.doc(kind + '/' + id).delete();
    state.db[kind] = state.db[kind].filter((x) => x.id !== id);
  }
  const errText = (e) => ((e && (e.message || e.code)) ? ' (' + (e.message || e.code) + ')' : '');

  /* ---------- ordini e quantità pianificate ---------- */
  const orderById = (id) => state.db.orders.find((o) => o.id === id) || null;
  const eventById = (id) => state.db.events.find((e) => e.id === id) || null;
  const evLines = (e) => (Array.isArray(e.lines) ? e.lines : []).filter((l) => l && isInt(l.qty) && l.qty > 0);
  const evTotal = (e) => sumOf(evLines(e).map((l) => l.qty));
  const orderLines = (o) => (Array.isArray(o.lines) ? o.lines : []).filter((l) => l && isInt(l.qty) && l.qty > 0);
  const ordersSorted = () => state.db.orders.slice().sort((a, b) =>
    (isYmd(a.due) ? a.due : '9999').localeCompare(isYmd(b.due) ? b.due : '9999') || String(a.createdAt).localeCompare(String(b.createdAt)));

  function plannedMap(orderId, excludeEv) {
    const m = new Map();
    state.db.events.forEach((e) => {
      if (e.orderId !== orderId || e.id === excludeEv || e.esito === 'respinto') return;
      evLines(e).forEach((l) => { const k = lineKey(l.name); m.set(k, (m.get(k) || 0) + l.qty); });
    });
    return m;
  }
  function orderStats(o, excludeEv) {
    const pm = plannedMap(o.id, excludeEv);
    const rows = orderLines(o).map((l) => { const p = Math.min(pm.get(lineKey(l.name)) || 0, l.qty); return { name: l.name, ordered: l.qty, planned: p, left: l.qty - p }; });
    const ordered = sumOf(rows.map((r) => r.ordered)), left = sumOf(rows.map((r) => r.left));
    return { rows: rows, ordered: ordered, left: left, planned: ordered - left };
  }
  function dueInfo(o, left) {
    if (!isYmd(o.due)) return null;
    const n = daysBetween(todayStr(), o.due);
    let cls = '';
    if (left > 0 && n < 0) cls = 'bad'; else if (left > 0 && n <= 10) cls = 'warn';
    return { n: n, cls: cls, text: 'Scadenza ' + dayLabel(o.due) + ' · ' + relDays(n) };
  }
  const flaggedEvents = () => state.db.events.filter((e) => e.portalToUpdate);
  const loadingNew = () => state.db.mode === 'connecting' || (state.db.mode === 'on' && (!state.db.got.orders || !state.db.got.events || !(state.rem && state.rem.got)));

  /* ---------- Ordini: elenco ---------- */
  function ordCardHtml(o) {
    const r = rec(o.matricola) || {}, st = orderStats(o), di = dueInfo(o, st.left);
    const evs = state.db.events.filter((e) => e.orderId === o.id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const pct = st.ordered ? Math.round(st.planned * 100 / st.ordered) : 0;
    return '<article class="ord' + (st.left === 0 ? ' done' : '') + '" data-id="' + esc(o.id) + '">' +
      '<div class="ord-head"><div class="lh"><span class="ic sm">' + ICON + '</span><div><h3><span class="mono">' + esc(o.matricola) + '</span><span class="meta">' + (r.descrizione ? esc(r.descrizione) : '') + '</span></h3>' +
      '<p class="meta">ODA <span class="mono">' + esc(o.oda) + '</span>' + (Array.isArray(o.pos) && o.pos.length ? ' · pos. ' + esc(o.pos.join(', ')) : '') + (o.note ? ' · ' + esc(o.note) : '') + '</p></div></div>' +
      (di ? '<span class="due ' + di.cls + '">' + esc(di.text) + '</span>' : '<span class="due">Senza scadenza</span>') + '</div>' +
      '<div class="bar" role="img" aria-label="' + pct + '% pianificato"><i style="width:' + pct + '%"></i></div>' +
      '<p class="summary">Ordinati <span class="mono">' + nf.format(st.ordered) + '</span> · pianificati <span class="mono">' + nf.format(st.planned) + '</span> · da pianificare <span class="mono">' + nf.format(st.left) + '</span></p>' +
      '<div class="scroll"><table><thead><tr><th>Destinazione</th><th class="r">Ordinati</th><th class="r">Pianificati</th><th class="r">Da pianificare</th></tr></thead><tbody>' +
      st.rows.map((x) => '<tr><td>' + esc(x.name) + '</td><td class="r num">' + nf.format(x.ordered) + '</td><td class="r num">' + nf.format(x.planned) + '</td><td class="r num">' + nf.format(x.left) + '</td></tr>').join('') + '</tbody></table></div>' +
      (evs.length ? '<div class="evs"><span class="meta">Collaudi:</span>' + evs.map((e) => '<button type="button" class="pill' + (e.portalToUpdate ? ' fl' : '') + '" data-act="ev-go" data-id="' + esc(e.id) + '">' +
        esc(isYmd(e.date) ? dayLabel(e.date) : '—') + ' · ' + nf.format(evTotal(e)) + ' pz' + (e.status === 'files' ? ' · file creati' : '') + '</button>').join('') + '</div>' : '') +
      '<div class="row">' + (st.left > 0 ? '<button type="button" class="btn primary small" data-act="plan-order" data-order="' + esc(o.id) + '">Pianifica collaudo</button>' : '<span class="meta">Tutto pianificato.</span>') +
      '<button type="button" class="btn small" data-act="ord-edit" data-id="' + esc(o.id) + '">Modifica</button>' +
      (ordState(o) === 'archive' ? '<button type="button" class="btn small" data-act="ord-unarch" data-id="' + esc(o.id) + '">Riapri</button>' : '<button type="button" class="btn small" data-act="ord-arch" data-id="' + esc(o.id) + '">Archivia</button>') +
      '<button type="button" class="btn ghost small danger" data-act="ord-del-card" data-id="' + esc(o.id) + '">Elimina…</button></div>' +
      (state.ord.delCard === o.id ? ordDelHtml(o, evs) : '') + '</article>';
  }
  function ordDelHtml(o, evs) {
    const planned = evs.filter((e) => e.status !== 'files'), withFiles = evs.length - planned.length;
    let t = '<b>Eliminare l’ordine <span class="mono">' + esc(o.oda) + '</span> della matricola ' + esc(o.matricola) + '?</b>';
    if (planned.length) t += ' Tolgo dal calendario anche ' + (planned.length === 1 ? 'il collaudo pianificato' : 'i ' + planned.length + ' collaudi pianificati') + '.';
    if (withFiles) t += ' ' + (withFiles === 1 ? 'Il collaudo con i file già creati resta' : 'I ' + withFiles + ' collaudi con i file già creati restano') + ' nel calendario (i numeri sono già registrati).';
    return '<div class="banner"><span>' + t + '</span><span class="row"><button type="button" class="btn small" data-act="ord-del-ok" data-id="' + esc(o.id) + '">' +
      (planned.length ? 'Elimina ordine e collaudi pianificati' : 'Elimina l’ordine') + '</button><button type="button" class="btn ghost small" data-act="ord-del-no">Annulla</button></span></div>';
  }
  async function deleteOrderCard(id) {
    const o = orderById(id); if (!o) return;
    const planned = state.db.events.filter((e) => e.orderId === id && e.status !== 'files');
    try {
      for (const e of planned) await dropDoc('events', e.id);
      await dropDoc('orders', id);
    } catch (er) { notice('bad', 'Non sono riuscito a eliminare l’ordine' + errText(er) + '.', true); return; }
    const ids = new Set(planned.map((e) => e.id));
    $('#toasts').querySelectorAll('.toast').forEach((t) => { if (ids.has(t.dataset.id)) t.remove(); });
    if (state.cal.panel && (ids.has(state.cal.panel.id) || state.cal.panel.orderId === id)) state.cal.panel = null;
    if (state.ord.edit && state.ord.edit.id === id) state.ord.edit = null;
    state.ord.delCard = null; refreshAll();
    notice('ok', 'Ordine ' + o.oda + ' eliminato' + (planned.length ? ' con ' + plural(planned.length, 'collaudo pianificato', 'collaudi pianificati') : '') + '.');
  }

  /* open = pezzi da pianificare · planned = tutto in calendario, collaudi ancora da fare · archive = chiuso (automatico o a mano) */
  function ordState(o) {
    if (o.archived === true) return 'archive';
    const st = orderStats(o); if (st.left > 0) return 'open';
    if (o.archived === false) return 'planned';
    const tod = todayStr(), evs = state.db.events.filter((e) => e.orderId === o.id);
    return evs.length && evs.every((e) => e.esito === 'collaudato' || (e.esito !== 'respinto' && isYmd(e.date) && e.date < tod)) ? 'archive' : 'planned';
  }
  const oqNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function applyQ(root, q) {
    if (!root) return;
    const t = oqNorm(q).trim();
    root.querySelectorAll('[data-s]').forEach((r) => { r.hidden = !!t && r.dataset.s.indexOf(t) < 0; });
    root.querySelectorAll('.ogrp').forEach((g) => { g.hidden = !g.querySelector('[data-s]:not([hidden])'); });
    const e = root.querySelector('.oq-empty'); if (e) e.hidden = !t || !!root.querySelector('[data-s]:not([hidden])');
  }
  const MESI_L = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  function ordRowHtml(o, mode) {
    const r = rec(o.matricola) || {}, st = orderStats(o), tod = todayStr();
    const evs = state.db.events.filter((e) => e.orderId === o.id && isYmd(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const next = evs.find((e) => e.date >= tod), last = evs[evs.length - 1];
    const s = oqNorm([o.matricola, r.descrizione, o.oda, o.note, (o.pos || []).join(' '), orderLines(o).map((l) => l.name).join(' ')].join(' '));
    const pct = st.ordered ? Math.round(st.planned * 100 / st.ordered) : 0;
    let due = '<span class="due">Senza scadenza</span>';
    if (isYmd(o.due)) { const n = daysBetween(tod, o.due), cls = st.left > 0 && n < 0 ? 'bad' : st.left > 0 && n <= 10 ? 'warn' : ''; due = '<span class="due ' + cls + '">' + esc(dayLabel(o.due)) + (mode === 'archive' ? '' : ' · ' + esc(relDays(n))) + '</span>'; }
    const info = mode === 'archive' ? (o.archived === true ? 'archiviato a mano' + (st.left ? ' · ' + nf.format(st.left) + ' pz non pianificati' : '') : last ? 'ultimo collaudo ' + dayLabel(last.date) : '')
      : mode === 'planned' ? (next ? 'prossimo collaudo ' + dayLabel(next.date) + (evs.length > 1 ? ' · ' + evs.length + ' collaudi' : '') : 'tutto pianificato')
      : mode === 'open' ? 'pianificati ' + nf.format(st.planned) + ' / ' + nf.format(st.ordered)
      : 'da pianificare ' + nf.format(st.left) + ' su ' + nf.format(st.ordered);
    const act = mode === 'pick' ? 'plan-pick' : mode === 'side' ? 'plan-order' : 'ord-toggle';
    const attr = mode === 'pick' || mode === 'side' ? ' data-order="' + esc(o.id) + '"' : ' data-id="' + esc(o.id) + '" aria-expanded="' + (state.ord.open === o.id) + '"';
    const exp = (mode === 'open' || mode === 'planned' || mode === 'archive') && state.ord.open === o.id;
    return '<div class="oitem" data-s="' + esc(s) + '"><div class="orow' + (exp ? ' on' : '') + '"><button type="button" class="orow-b" data-act="' + act + '"' + attr + '>' +
      '<span class="ot"><span><b class="mono">' + esc(o.matricola) + '</b>' + (r.esterno ? ' <span class="xtag">esterno</span>' : '') + ' <span class="meta">' + esc(r.descrizione || '') + '</span></span>' +
      '<span class="meta">ODA <span class="mono">' + esc(o.oda) + '</span>' + (Array.isArray(o.pos) && o.pos.length ? ' · pos. ' + esc(o.pos.join(', ')) : '') + (o.note ? ' · ' + esc(o.note) : '') + '</span></span>' +
      due + '<span class="pb"><span class="bar"><i style="width:' + pct + '%"></i></span><span class="meta">' + esc(info) + '</span></span></button>' +
      (mode === 'open' ? '<button type="button" class="btn primary small" data-act="plan-order" data-order="' + esc(o.id) + '">Pianifica</button>' : '') +
      '</div>' + (exp ? ordCardHtml(o) : '') + '</div>';
  }
  function ordListHtml(list, mode) {
    const tod = todayStr(), groups = [];
    if (mode === 'archive') {
      const by = new Map();
      list.slice().sort((a, b) => String(b.due || b.createdAt || '').localeCompare(String(a.due || a.createdAt || ''))).forEach((o) => {
        const d = isYmd(o.due) ? o.due : String(o.createdAt || '').slice(0, 10), k = isYmd(d) ? d.slice(0, 7) : '';
        if (!by.has(k)) by.set(k, []); by.get(k).push(o);
      });
      by.forEach((items, k) => groups.push({ name: k ? MESI_L[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4) : 'Senza data', cls: '', items: items }));
    } else {
      const g = [{ name: 'Scaduti', cls: 'bad', items: [] }, { name: 'Entro 10 giorni', cls: 'warn', items: [] }, { name: 'Più avanti', cls: '', items: [] }, { name: 'Senza scadenza', cls: '', items: [] }];
      list.forEach((o) => { if (!isYmd(o.due)) g[3].items.push(o); else { const n = daysBetween(tod, o.due); g[n < 0 ? 0 : n <= 10 ? 1 : 2].items.push(o); } });
      if (mode === 'planned') { g[0].name = 'Scadenza passata'; }
      groups.push(...g);
    }
    return groups.filter((x) => x.items.length).map((x) => '<div class="ogrp g-' + (x.cls || (mode === 'archive' ? 'arch' : mode === 'planned' ? 'ok' : 'n')) + '"><h3 class="' + x.cls + '">' + esc(x.name) + ' (' + x.items.length + ')</h3>' + x.items.map((o) => ordRowHtml(o, mode)).join('') + '</div>').join('') +
      '<p class="empty oq-empty" hidden>Nessun ordine trovato.</p>';
  }

  function paintOrders(force) {
    const host = $('#ordHost');
    if (!['open', 'planned', 'archive'].includes(state.ord.filter)) state.ord.filter = 'open';
    document.querySelectorAll('.seg-tabs [data-act=ord-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === state.ord.filter)));
    if (loadingNew()) { setHtml(host, '<p class="empty">Carico gli ordini…</p>'); }
    else {
      const by = { open: [], planned: [], archive: [] };
      ordersSorted().forEach((o) => by[ordState(o)].push(o));
      const lab = { open: 'Da pianificare', planned: 'Pianificati', archive: 'Archivio' };
      document.querySelectorAll('.seg-tabs [data-act=ord-filter]').forEach((b) => { b.textContent = lab[b.dataset.f] + ' (' + by[b.dataset.f].length + ')'; });
      const list = by[state.ord.filter];
      const empty = { open: state.db.orders.length ? 'Nessun ordine da pianificare: è tutto nel calendario.' : 'Nessun ordine. Aggiungi il primo: scegli il prodotto, indica l’OdA e le quantità per destinazione.',
        planned: 'Nessun ordine con collaudi ancora da fare.', archive: 'L’archivio è vuoto. Ci finiscono gli ordini con tutti i collaudi passati, oppure archiviati a mano.' }[state.ord.filter];
      setHtml(host, list.length ? ordListHtml(list, state.ord.filter) : '<p class="empty">' + empty + '</p>');
      applyQ(host, ($('#ordQ') || {}).value);
    }
    paintOrdEditor(force);
  }

  /* ---------- Ordini: inserimento e modifica ---------- */
  function openOrder(id) {
    const o = id ? orderById(id) : null;
    state.ord.tried = false; state.ord.confirmDel = false;
    if (o) {
      const r = rec(o.matricola);
      const dests = orderLines(o).map((l) => ({ name: l.name, qty: String(l.qty) }));
      destList(r).forEach((n) => { if (!dests.some((d) => sameName(d.name, n))) dests.push({ name: n, qty: '' }); });
      state.ord.edit = { id: o.id, mat: o.matricola, f: { oda: o.oda || '', due: isYmd(o.due) ? o.due : '', note: o.note || '' }, dests: dests };
    } else state.ord.edit = { id: null, mat: null, f: { oda: '', due: '', note: '' }, dests: [] };
    showView('ordini'); paintOrders(true);
    const el = $('#ordEditor'); el.scrollIntoView({ block: 'start' });
    const f = document.getElementById('o-oda'); if (f) f.focus({ preventScroll: true });
  }

  function ordCheck() {
    const E = state.ord.edit, out = { errors: [], lines: [], total: 0 };
    const oda = E.f.oda.trim();
    if (!oda) out.errors.push('Indica il numero d’ordine (ODA).');
    else if (!/^\d+$/.test(oda)) out.errors.push('L’ordine (ODA) deve contenere solo cifre.');
    else if (state.db.orders.some((o) => o.id !== E.id && o.oda === oda && o.matricola === E.mat && (o.due || '') === (E.f.due || ''))) out.errors.push('Esiste già un ordine ' + oda + ' per la matricola ' + E.mat + ' con la stessa scadenza: aprilo dall’elenco per modificarlo, oppure indica una scadenza diversa.');
    if (E.f.due && !isYmd(E.f.due)) out.errors.push('La scadenza non è una data valida.');
    let bad = false; const seen = new Set();
    E.dests.forEach((d) => {
      const raw = d.qty.trim(); if (raw === '') return;
      const n = C.toInt(raw), name = d.name.trim();
      if (!(n >= 1)) bad = true;
      else if (!name) out.errors.push('Indica il nome della destinazione per la quantità ' + raw + '.');
      else if (seen.has(lineKey(name))) out.errors.push('La destinazione ' + name + ' è scritta due volte.');
      else { seen.add(lineKey(name)); out.lines.push({ name: name, qty: n }); }
    });
    if (bad) out.errors.push('Le quantità devono essere numeri interi da 1 in su (lascia vuote le destinazioni non ordinate).');
    else if (!out.lines.length) out.errors.push('Indica la quantità per almeno una destinazione.');
    out.total = sumOf(out.lines.map((l) => l.qty));
    if (E.id) {
      const names = new Map();
      state.db.events.forEach((e) => { if (e.orderId === E.id) evLines(e).forEach((l) => names.set(lineKey(l.name), l.name)); });
      plannedMap(E.id).forEach((q, k) => {
        const l = out.lines.find((x) => lineKey(x.name) === k);
        if (!bad && (!l || l.qty < q)) out.errors.push('Per ' + names.get(k) + ' hai già pianificato ' + nf.format(q) + ' pezzi nel calendario: la quantità ordinata non può essere più bassa.');
      });
    }
    return out;
  }

  function ordEditorHtml() {
    const E = state.ord.edit, isNew = !E.id;
    const cancel = '<button type="button" class="btn ghost small" data-act="ord-cancel">Annulla</button>';
    if (!E.mat) {
      const mats = visibleMats();
      return '<div class="sec-head"><div><h2>Nuovo ordine</h2><p class="sub">Per quale prodotto è l’ordine?</p></div>' + cancel + '</div>' +
        '<div class="picks">' + mats.map((m) => pickHtml(m, 'ord-pick', false)).join('') + '</div>' +
        (mats.length ? '' : '<p class="empty">Prima aggiungi il prodotto in “Matricole”.</p>');
    }
    const r = rec(E.mat) || {};
    const field = (label, id, inner, hint, cls) => '<div class="field' + (cls ? ' ' + cls : '') + '"><label class="l" for="' + id + '">' + label + '</label>' + inner + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>';
    const dests = E.dests.map((d, i) =>
      '<div class="dest" data-di="' + i + '"><input type="text" data-od="name" aria-label="Destinazione ' + (i + 1) + '" autocomplete="off" placeholder="es. Milano" value="' + esc(d.name) + '">' +
      '<input type="text" data-od="qty" class="num" inputmode="numeric" aria-label="Quantità destinazione ' + (i + 1) + '" autocomplete="off" placeholder="pezzi" value="' + esc(d.qty) + '">' +
      '<button type="button" class="x" data-act="ord-rm-dest" aria-label="Rimuovi destinazione ' + (i + 1) + '">×</button></div>').join('');
    const hasEv = !isNew && state.db.events.some((e) => e.orderId === E.id);
    return '<div class="sec-head"><div><h2>' + (isNew ? 'Nuovo ordine' : 'Modifica ordine') + ' · <span class="mono">' + esc(E.mat) + '</span></h2><p class="sub">' + (r.descrizione ? esc(r.descrizione) : 'Senza descrizione') + '</p></div>' +
      (isNew ? '<button type="button" class="btn ghost small" data-act="ord-change-mat">Cambia prodotto</button>' : '') + '</div>' +
      '<div class="grid g3">' +
      field('Ordine (ODA)', 'o-oda', '<input type="text" id="o-oda" data-of="oda" class="num" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="es. 6000132763" value="' + esc(E.f.oda) + '">') +
      field('Scadenza', 'o-due', '<input type="date" id="o-due" data-of="due" value="' + esc(E.f.due) + '">', 'Ti serve a ricordare quando pianificare il collaudo.') +
      field('Note (facoltative)', 'o-note', '<input type="text" id="o-note" data-of="note" autocomplete="off" placeholder="es. consegna in due tranche" value="' + esc(E.f.note) + '">') +
      '</div>' +
      '<div class="dests"><div class="dest-head"><span>Destinazione</span><span>Pezzi ordinati</span><span></span></div>' + dests +
      '<div class="row"><button type="button" class="btn ghost small" data-act="ord-add-dest">+ Destinazione</button><span class="hint">Lascia vuote le quantità delle destinazioni che questo ordine non riguarda.</span></div></div>' +
      '<p class="summary" data-o="otot"></p><ul class="msgs" data-o="omsg"></ul>' +
      '<div class="row"><button type="button" class="btn primary" data-act="ord-save">Salva ordine</button><button type="button" class="btn" data-act="ord-cancel">Annulla</button>' +
      (!isNew && !hasEv ? '<button type="button" class="btn ghost danger" data-act="ord-delete">' + (state.ord.confirmDel ? 'Conferma: elimina ordine' : 'Elimina ordine') + '</button>' : '') +
      (!isNew && hasEv ? '<span class="hint">Ha collaudi in calendario: per eliminarlo togli prima quelli.</span>' : '') + '</div>';
  }

  function paintOrdMeta() {
    const E = state.ord.edit, host = $('#ordEditor'); if (!E || !E.mat) return;
    const chk = ordCheck();
    const t = host.querySelector('[data-o=otot]'), m = host.querySelector('[data-o=omsg]');
    if (t) t.innerHTML = chk.total ? 'Totale ordinato: <span class="mono">' + nf.format(chk.total) + '</span> pezzi' : '';
    if (m) m.innerHTML = state.ord.tried ? chk.errors.map((x) => '<li class="bad">' + esc(x) + '</li>').join('') : '';
  }

  function paintOrdEditor(force) {
    const host = $('#ordEditor'), E = state.ord.edit;
    host.hidden = !E;
    if (!E) { host._html = ''; host.innerHTML = ''; return; }
    const a = document.activeElement;
    if (!force && a && host.contains(a) && a.matches('input,select,textarea')) return;
    setHtml(host, ordEditorHtml());
    paintOrdMeta();
  }

  async function saveOrder() {
    const E = state.ord.edit; if (!E) return;
    state.ord.tried = true;
    const chk = ordCheck();
    if (chk.errors.length) { paintOrdMeta(); notice('bad', chk.errors[0], true); return; }
    const stamp = nowIso();
    const data = { oda: E.f.oda.trim(), matricola: E.mat, due: E.f.due || '', note: E.f.note.trim(), lines: chk.lines, updatedAt: stamp };
    try {
      if (E.id) await patchDoc('orders', E.id, data);
      else await createDoc('orders', Object.assign({ createdAt: stamp }, data));
    } catch (e) { notice('bad', 'Non sono riuscito a salvare l’ordine' + errText(e) + '.', true); return; }
    state.ord.edit = null; state.ord.filter = 'open';
    refreshAll();
    notice(dbh ? 'ok' : 'warn', 'Ordine ' + data.oda + ' salvato.' + (dbh ? '' : ' Solo per questa sessione: i dati non sono collegati.'), !dbh);
  }

  /* ---------- Calendario ---------- */
  const DRAG = { id: null, pid: null, sx: 0, sy: 0, on: false, ghost: null, over: null, el: null, dirty: false, suppress: false };

  function chipHtml(e) {
    const flag = !!e.portalToUpdate, files = e.status === 'files';
    const label = e.matricola + ', ODA ' + e.oda + ', ' + nf.format(evTotal(e)) + ' pezzi, ' + (files ? 'file creati' : 'pianificato') + (flag ? ', da aggiornare sul portale collaudi' : '') + (ecoRisk(e.id) ? ', a rischio per la produzione' : '') + (isExt(e.matricola) ? ', prodotto esterno' : '') + (e.esito ? ', ' + e.esito : '');
    const ext = isExt(e.matricola);
    return '<button type="button" class="ev' + (files ? ' files' : '') + (flag ? ' flag' : '') + (ext ? ' ext' : '') + (e.esito === 'collaudato' ? ' done' : e.esito === 'respinto' ? ' rej' : '') + (ecoRisk(e.id) ? ' risk' : '') + '" data-act="ev" data-id="' + esc(e.id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
      '<span class="m">' + esc(e.matricola) + '</span><span class="q">' + nf.format(evTotal(e)) + '</span></button>';
  }

  function paintCal() {
    if (DRAG.on) { DRAG.dirty = true; return; }
    const y = state.cal.y, m = state.cal.m, grid = $('#calGrid');
    $('#calTitle').textContent = C.MESI[m] + ' ' + y;
    const offset = (new Date(y, m, 1, 12).getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
    const weeks = Math.ceil((offset + dim) / 7), start = new Date(y, m, 1 - offset, 12), tod = todayStr();
    const byDate = {}, dueBy = {};
    state.db.events.forEach((e) => { if (isYmd(e.date)) (byDate[e.date] = byDate[e.date] || []).push(e); });
    state.db.orders.forEach((o) => { if (isYmd(o.due) && o.archived !== true && orderStats(o).left > 0) (dueBy[o.due] = dueBy[o.due] || []).push(o); });
    const P = state.cal.panel, selDate = P && (P.mode === 'day' ? P.date : P.mode === 'event' ? (eventById(P.id) || {}).date : P.mode === 'plan' ? P.date : null);
    let html = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'].map((d) => '<div class="cal-dow">' + d + '</div>').join('');
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12), s = ymd(d);
      const evs = (byDate[s] || []).slice().sort((a, b) => String(a.matricola).localeCompare(String(b.matricola)));
      const dues = dueBy[s] || [], wd = d.getDay();
      const n = evs.length;
      html += '<div class="cal-cell' + (d.getMonth() !== m ? ' out' : '') + (wd === 0 || wd === 6 ? ' we' : '') + (s === tod ? ' today' : '') + (s === selDate ? ' sel' : '') + '" data-act="day" data-date="' + s + '">' +
        '<button type="button" class="dn" data-act="day" data-date="' + s + '" aria-label="' + esc(dayLabel(s, true) + (n ? ', ' + plural(n, 'collaudo', 'collaudi') : '')) + '">' + d.getDate() + '</button>' +
        evs.map(chipHtml).join('') +
        (dues.length ? '<span class="cal-due" title="Scadenza: ' + esc(dues.map((o) => o.matricola + ' ODA ' + o.oda).join(', ')) + '">scad. ' + dues.map((o) => esc(o.matricola)).join(', ') + '</span>' : '') + '</div>';
    }
    setHtml(grid, html);
    const list = calListMode(), cl = $('#calList');
    grid.hidden = list; cl.hidden = !list; $('#calVista').textContent = list ? 'Mese' : 'Elenco';
    if (list) {
      let lh = '';
      for (let w = 0; w < weeks; w++) {
        const days = [];
        for (let k = 0; k < 7; k++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + k, 12), s = ymd(d);
          if (d.getMonth() !== m) continue;
          const evs = (byDate[s] || []).slice().sort((a, b) => String(a.matricola).localeCompare(String(b.matricola))), dues = dueBy[s] || [];
          if (!evs.length && !dues.length && s !== tod) continue;
          days.push('<div class="cl-day' + (s === tod ? ' today' : '') + '"><button type="button" class="cl-d" data-act="day" data-date="' + s + '">' + esc(dayLabel(s)) + '</button><div class="cl-evs">' +
            evs.map((e) => chipHtml(e).replace('<span class="q">', '<span class="cl-o">ODA ' + esc(e.oda) + '</span><span class="q">').replace(/(<span class="q">[^<]*)/, '$1 pz')).join('') + dues.map((o) => '<span class="cal-due">scadenza ' + esc(o.matricola) + ' · ODA ' + esc(o.oda) + '</span>').join('') + (!evs.length && !dues.length ? '<span class="meta">oggi · nessun collaudo</span>' : '') + '</div></div>');
        }
        const a = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7, 12), z = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6, 12);
        lh += '<div class="cl-week"><h3>' + esc(dayLabel(ymd(a)) + ' – ' + dayLabel(ymd(z))) + '</h3>' + (days.length ? days.join('') : '<div class="cl-empty meta">Nessun collaudo</div>') + '</div>';
      }
      setHtml(cl, lh);
    }
    const nfl = flaggedEvents().length, bd = $('#calBadge');
    bd.hidden = !nfl; bd.textContent = String(nfl);
    bd.setAttribute('aria-label', nplural(nfl));
    paintPanel(false); paintTodo();
  }
  const nplural = (n) => plural(n, 'richiesta da modificare sul portale collaudi', 'richieste da modificare sul portale collaudi');

  function paintTodo() {
    const host = $('#calTodo');
    if (loadingNew()) { setHtml(host, '<p class="empty">Carico gli ordini…</p>'); return; }
    const open = ordersSorted().filter((o) => ordState(o) === 'open');
    let list = host.querySelector('#todoList');
    if (!list) {
      host.innerHTML = '<div class="sec-head"><div><h2>Ordini da pianificare <span class="meta" data-o="todoN"></span></h2><p class="sub">Tocca un ordine per scegliere quanta parte prendere e il giorno del collaudo.</p></div>' +
        '<button type="button" class="btn small" data-act="nav" data-view="ordini">Tutti gli ordini</button></div>' +
        '<input type="search" id="todoQ" class="oq" placeholder="Cerca ODA, matricola…" aria-label="Cerca negli ordini da pianificare" autocomplete="off"><div id="todoList" class="oscroll"></div>';
      host._html = ''; list = host.querySelector('#todoList');
    }
    host.querySelector('[data-o=todoN]').textContent = open.length ? '(' + open.length + ')' : '';
    setHtml(list, open.length ? ordListHtml(open, 'side') : '<p class="empty">Nessun ordine in attesa. Inserisci un ordine nella sezione “Ordini”.</p>');
    applyQ(list, $('#todoQ').value);
  }

  /* ---------- Calendario: pannello giorno / collaudo / pianificazione ---------- */
  const closeBtn = '<button type="button" class="btn ghost small" data-act="panel-close">Chiudi</button>';

  function dayPanelHtml(P) {
    const evs = state.db.events.filter((e) => e.date === P.date).sort((a, b) => String(a.matricola).localeCompare(String(b.matricola)));
    const planned = evs.filter((e) => e.status !== 'files');
    const dues = state.db.orders.filter((o) => o.due === P.date && o.archived !== true && orderStats(o).left > 0);
    return '<div class="sec-head"><div><h2>' + esc(dayLabel(P.date, true)) + '</h2><p class="sub">' +
      (evs.length ? plural(evs.length, 'collaudo', 'collaudi') + ' · ' + plural(sumOf(evs.map(evTotal)), 'pezzo', 'pezzi') : 'Nessun collaudo in questo giorno.') + '</p></div>' + closeBtn + '</div>' +
      (evs.length ? '<div class="evrows">' + evs.map((e) => '<button type="button" class="evrow" data-act="ev" data-id="' + esc(e.id) + '"><b class="mono">' + esc(e.matricola) + '</b>' +
        '<span class="meta">ODA <span class="mono">' + esc(e.oda) + '</span> · ' + plural(evTotal(e), 'pezzo', 'pezzi') + '</span>' +
        '<span class="st' + (e.status === 'files' ? ' files' : '') + '">' + (e.status === 'files' ? 'File creati' : 'Pianificato') + '</span>' +
        (e.portalToUpdate ? '<span class="st flag">Portale da aggiornare</span>' : '') + '</button>').join('') + '</div>' : '') +
      (dues.length ? '<ul class="msgs">' + dues.map((o) => '<li class="warn">Scadenza ordine ' + esc(o.matricola) + ' · ODA ' + esc(o.oda) + ': restano da pianificare ' + nf.format(orderStats(o).left) + ' pezzi.</li>').join('') + '</ul>' : '') +
      '<div class="row"><button type="button" class="btn primary" data-act="plan-new" data-date="' + P.date + '">+ Aggiungi collaudo</button>' +
      (planned.length ? '<button type="button" class="btn" data-act="load-day" data-date="' + P.date + '">Crea i file del giorno (' + planned.length + ')</button>' : '') +
      (evs.length ? '<button type="button" class="btn" data-act="pdf-day" data-date="' + P.date + '">PDF del giorno</button>' : '') + '<span class="fstat"></span></div>';
  }

  function eventPanelHtml(P) {
    const e = eventById(P.id);
    if (!e) return '<div class="sec-head"><div><h2>Collaudo non trovato</h2></div>' + closeBtn + '</div><p class="empty">Potrebbe essere stato eliminato da un’altra persona.</p>';
    const r = rec(e.matricola) || {}, files = e.status === 'files', run = files && e.runId ? state.db.runs.find((x) => x.id === e.runId) : null;
    return '<div class="sec-head"><div class="lh"><span class="ic sm">' + ICON + '</span><div><h2><span class="mono">' + esc(e.matricola) + '</span> · ' + esc(dayLabel(e.date, true)) + '</h2>' +
      '<p class="sub">' + (r.descrizione ? esc(r.descrizione) + ' · ' : '') + 'ODA <span class="mono">' + esc(e.oda) + '</span> · ' + plural(evTotal(e), 'pezzo', 'pezzi') + '</p></div></div>' + closeBtn + '</div>' +
      (e.portalToUpdate ? '<div class="banner"><span><b>Modifica la richiesta di collaudo sul portale collaudi.</b>' + (e.movedFrom && isYmd(e.movedFrom) ? ' Il collaudo era il ' + esc(dayLabel(e.movedFrom)) + '.' : '') + '</span>' +
        '<button type="button" class="btn small" data-act="portal-done" data-id="' + esc(e.id) + '">Fatto, portale aggiornato</button></div>' : '') +
      '<div class="scroll"><table><thead><tr><th>Destinazione</th><th class="r">Pezzi</th></tr></thead><tbody>' +
      evLines(e).map((l) => '<tr><td>' + esc(l.name) + '</td><td class="r num">' + nf.format(l.qty) + '</td></tr>').join('') + '</tbody></table></div>' +
      evStatusHtml(e) + ecoEventHtml(e) +
      '<p class="meta">' + (files ? 'File creati' + (e.filesAt ? ' il ' + esc(new Date(e.filesAt).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })) : '') + '. I numeri sono già registrati.' : 'Pianificato: i file non sono ancora stati creati.') + '</p>' +
      (run ? '<div class="row">' + (() => { const fl = filesForRun(run), li = run.lines.findIndex((l) => l.matricola === e.matricola && l.oda === e.oda), pick = li >= 0 ? [li, fl.length - 1] : [fl.length - 1];
        return pick.map((i) => '<button type="button" class="btn small" data-act="run-save" data-run="' + esc(run.id) + '" data-i="' + i + '">Scarica ' + esc(fl[i].label) + '</button>').join(''); })() + '<span class="fstat"></span></div>' : '') +
      '<div class="row"><button type="button" class="btn small" data-act="pdf-ev" data-id="' + esc(e.id) + '">Scarica PDF del collaudo</button><span class="fstat"></span></div>' +
      '<div class="field" style="max-width:220px"><label class="l" for="ev-date">Sposta al giorno</label><input type="date" id="ev-date" data-evdate="' + esc(e.id) + '" value="' + esc(e.date) + '"></div>' +
      '<div class="row">' + (!files ? '<button type="button" class="btn primary" data-act="load-day" data-date="' + esc(e.date) + '" data-id="' + esc(e.id) + '">Crea i file</button>' +
        '<button type="button" class="btn" data-act="ev-edit" data-id="' + esc(e.id) + '">Modifica quantità e postazioni</button>' +
        '<button type="button" class="btn ghost danger" data-act="ev-del" data-id="' + esc(e.id) + '">' + (state.cal.confirmDel === e.id ? 'Conferma: elimina dal calendario' : 'Elimina dal calendario') + '</button>' :
        '<button type="button" class="btn ghost danger" data-act="ev-del" data-id="' + esc(e.id) + '">' + (state.cal.confirmDel === e.id ? 'Conferma: elimina dal calendario' : 'Elimina dal calendario…') + '</button>') + '</div>' +
      (files && state.cal.confirmDel === e.id ? '<div class="banner"><span>I file di questo collaudo sono già stati creati: tolgo solo il collaudo dal calendario. I numeri restano registrati e il lotto resta nello Storico' +
        (run ? ' (se vuoi annullare anche i numeri, usa “Elimina e riporta i numeri indietro” nello Storico <b>prima</b> di eliminare il collaudo)' : '') + '.</span>' +
        '<span class="row"><button type="button" class="btn ghost small" data-act="ev-del-no">Annulla</button></span></div>' : '');
  }

  function planPanelHtml(P) {
    const o = P.orderId ? orderById(P.orderId) : null, editing = !!P.eventId;
    const title = editing ? 'Modifica quantità del collaudo' : 'Nuovo collaudo';
    if (!o && P.free) return freePanelHtml(P);
    if (!o) {
      const open = ordersSorted().filter((x) => ordState(x) === 'open');
      return '<div class="sec-head"><div><h2>' + title + (isYmd(P.date) ? ' · ' + esc(dayLabel(P.date)) : '') + '</h2><p class="sub">Quale ordine vuoi collaudare?</p></div>' + closeBtn + '</div>' +
        '<div class="row" style="margin:0"><button type="button" class="btn small" data-act="plan-free">Collaudo senza ordine caricato…</button><span class="hint">Inserisci tu matricola, ODA e quantità: creo l’ordine insieme al collaudo.</span></div>' +
        (open.length ? '<input type="search" class="oq" data-pickq="1" placeholder="Cerca ODA, matricola…" aria-label="Cerca l’ordine" autocomplete="off"><div class="oscroll" data-o="picklist">' + ordListHtml(open, 'pick') + '</div>'
          : '<p class="empty">Non ci sono ordini con pezzi da pianificare. Inseriscine uno nella sezione “Ordini”, oppure usa “Collaudo senza ordine caricato”.</p>');
    }
    const r = rec(o.matricola) || {}, st = orderStats(o, P.eventId);
    return '<div class="sec-head"><div class="lh"><span class="ic sm">' + ICON + '</span><div><h2>' + title + '</h2><p class="sub"><span class="mono">' + esc(o.matricola) + '</span> ' + esc(r.descrizione || '') + ' · ODA <span class="mono">' + esc(o.oda) + '</span></p></div></div>' + closeBtn + '</div>' +
      '<div class="grid g3"><div class="field"><label class="l" for="pl-date">Giorno del collaudo</label><input type="date" id="pl-date" data-pf="date" value="' + esc(P.date || '') + '"></div>' +
      '<div class="field span2"><span class="l">&nbsp;</span><span class="hint">Scegli la data qui o tocca un giorno nel calendario.</span></div></div>' +
      ecoPlanFields(P, o) +
      '<div class="scroll"><table class="qt"><thead><tr><th>Destinazione</th><th class="r">Da pianificare</th><th class="r">Pezzi in questo collaudo</th></tr></thead><tbody>' +
      st.rows.map((x, i) => '<tr><td>' + esc(x.name) + '</td><td class="r num">' + nf.format(x.left) + '</td><td class="r"><input type="text" class="num" data-pq="' + i + '" inputmode="numeric" autocomplete="off" aria-label="Pezzi per ' + esc(x.name) + '" placeholder="0"' + (x.left === 0 ? ' disabled' : '') + ' value="' + esc(P.qty[i] == null ? '' : P.qty[i]) + '"></td></tr>').join('') + '</tbody></table></div>' +
      '<div class="row"><button type="button" class="btn small" data-act="plan-all">Prendi tutto il residuo</button><button type="button" class="btn ghost small" data-act="plan-none">Azzera</button></div>' +
      '<div class="ecobox" data-o="eco" hidden></div>' +
      '<p class="summary" data-o="ptotal"></p><ul class="msgs" data-o="pmsg"></ul>' +
      '<div class="row"><button type="button" class="btn primary" data-act="plan-save-files" data-o="psavef">' + (editing ? 'Salva e prepara i file' : 'Aggiungi al calendario e prepara i file') + '</button>' +
      '<button type="button" class="btn" data-act="plan-save" data-o="psave">' + (editing ? 'Salva senza file' : 'Solo in calendario') + '</button><button type="button" class="btn ghost" data-act="panel-close">Annulla</button></div>' +
      '<p class="hint" style="margin:0">Con “prepara i file” controlli seriali e pianali e crei subito l’Excel per etichettare i pezzi e il CSV per il portale del cliente.</p>';
  }

  function planCheck() {
    const P = state.cal.panel, out = { errors: [], lines: [], total: 0, o: null };
    const o = P.orderId ? orderById(P.orderId) : null; out.o = o;
    if (!o) { out.errors.push('Scegli l’ordine.'); return out; }
    const st = orderStats(o, P.eventId); let bad = false;
    st.rows.forEach((x, i) => {
      const raw = String(P.qty[i] == null ? '' : P.qty[i]).trim(); if (raw === '') return;
      const n = C.toInt(raw);
      if (!(n >= 1)) bad = true;
      else if (n > x.left) out.errors.push(x.name + ': al massimo ' + nf.format(x.left) + ' pezzi.');
      else out.lines.push({ name: x.name, qty: n });
    });
    if (bad) out.errors.push('Le quantità devono essere numeri interi da 1 in su (lascia vuote le destinazioni che non servono).');
    else if (!out.lines.length && !out.errors.length) out.errors.push('Indica i pezzi di almeno una destinazione.');
    out.total = sumOf(out.lines.map((l) => l.qty));
    if (!isYmd(P.date)) out.errors.push('Scegli il giorno del collaudo.');
    if (String(P.post || '').trim() && !ecoPostOk(P.post)) out.errors.push('Le postazioni devono essere un numero intero da 1 a 50 (vuoto = quelle normali del prodotto).');
    return out;
  }

  function paintPlanMeta() {
    if (state.cal.panel && state.cal.panel.mode === 'plan' && state.cal.panel.free && !state.cal.panel.orderId) return freeMeta();
    const P = state.cal.panel; if (!P || P.mode !== 'plan' || !P.orderId) return;
    const host = $('#calPanel'), chk = planCheck(), st = orderStats(chk.o, P.eventId);
    const t = host.querySelector('[data-o=ptotal]'), m = host.querySelector('[data-o=pmsg]'), b = host.querySelector('[data-o=psave]');
    if (t) t.innerHTML = chk.total ? 'Collaudo di <span class="mono">' + nf.format(chk.total) + '</span> pezzi su <span class="mono">' + nf.format(st.left) + '</span> ancora da pianificare' : '';
    if (m) m.innerHTML = chk.errors.map((x) => '<li class="' + (/^Scegli|^Indica/.test(x) ? 'todo' : 'bad') + '">' + esc(x) + '</li>').join('');
    if (b) b.disabled = chk.errors.length > 0;
    paintEcoPlan(chk);
  }

  function paintPanel(force) {
    const host = $('#calPanel'), P = state.cal.panel;
    host.hidden = !P;
    if (!P) { host._html = ''; host.innerHTML = ''; return; }
    const a = document.activeElement;
    if (!force && a && host.contains(a) && a.matches('input,select,textarea')) return;
    setHtml(host, P.mode === 'day' ? dayPanelHtml(P) : P.mode === 'event' ? eventPanelHtml(P) : planPanelHtml(P));
    paintPlanMeta();
  }

  function openPanel(P, scroll) {
    state.cal.panel = P; state.cal.confirmDel = null;
    paintCal(); paintPanel(true);
    if (scroll && window.matchMedia('(max-width: 1000px)').matches) $('#calPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function startPlan(orderId, date) {
    const o = orderId ? orderById(orderId) : null, qty = {};
    showView('calendario');
    const P = { mode: 'plan', orderId: orderId || null, eventId: null, date: date || '', qty: qty, post: '', op: '', avv: '' };
    if (o) orderStats(o).rows.forEach((x, i) => { if (x.left > 0) qty[i] = ''; });
    if (isYmd(date)) { const d = parseYmd(date); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth(); }
    openPanel(P, true);
    const el = document.getElementById('pl-date'); if (el) el.focus({ preventScroll: true });
  }

  async function savePlan(withFiles) {
    if (!(await freeToOrder())) return;
    const P = state.cal.panel; if (!P || P.mode !== 'plan') return;
    const chk = planCheck();
    if (chk.errors.length) { paintPlanMeta(); return; }
    const o = chk.o, stamp = nowIso();
    try {
      if (P.eventId) {
        const ev = eventById(P.eventId); if (!ev) return;
        const oldTot = evTotal(ev), sameDate = ev.date === P.date;
        const patch = Object.assign({ lines: chk.lines, updatedAt: stamp }, ecoPlanData(P));
        const changed = oldTot !== chk.total || !sameDate || JSON.stringify(evLines(ev).map((l) => [lineKey(l.name), l.qty])) !== JSON.stringify(chk.lines.map((l) => [lineKey(l.name), l.qty]));
        if (!sameDate) { patch.date = P.date; patch.movedFrom = ev.date; }
        if (changed) patch.portalToUpdate = true;
        await patchDoc('events', P.eventId, patch);
        if (changed) raiseToast(ev.id, o.matricola, o.oda, !sameDate ? 'dal ' + dayLabel(ev.date) + ' al ' + dayLabel(P.date) + (oldTot !== chk.total ? '; pezzi da ' + nf.format(oldTot) + ' a ' + nf.format(chk.total) : '') : 'pezzi da ' + nf.format(oldTot) + ' a ' + nf.format(chk.total));
        notice('ok', 'Collaudo aggiornato.');
        const d = parseYmd(P.date); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth();
        state.cal.panel = { mode: 'event', id: P.eventId };
      } else {
        const id = await createDoc('events', Object.assign({ orderId: o.id, oda: o.oda, matricola: o.matricola, date: P.date, lines: chk.lines, status: 'planned', portalToUpdate: false, createdAt: stamp, updatedAt: stamp }, ecoPlanData(P)));
        const d = parseYmd(P.date); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth();
        state.cal.panel = { mode: 'event', id: id };
        notice(dbh ? 'ok' : 'warn', 'Collaudo di ' + o.matricola + ' messo in calendario per ' + dayLabel(P.date) + '.' + (dbh ? '' : ' Solo per questa sessione: i dati non sono collegati.'), !dbh);
      }
    } catch (e) { notice('bad', 'Non sono riuscito a salvare il collaudo' + errText(e) + '.', true); return; }
    refreshAll(); paintPanel(true);
    if (withFiles && state.cal.panel && state.cal.panel.id) prepareFiles(state.cal.panel.id);
  }

  /* ---------- spostamento e avviso sul portale collaudi ---------- */
  function raiseToast(evId, mat, oda, what, kind) {
    const host = $('#toasts');
    host.querySelectorAll('.toast').forEach((t) => { if (evId && t.dataset.id === evId) t.remove(); });
    while (host.children.length >= 4) host.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'alert'); if (evId) el.dataset.id = evId;
    el.innerHTML = '<div class="tt">' + (kind === 'delete' ? 'Annulla la richiesta di collaudo sul portale collaudi' : 'Modifica la richiesta di collaudo sul portale collaudi') + '</div>' +
      '<div class="td"><span class="mono">' + esc(mat) + '</span> · ODA <span class="mono">' + esc(oda) + '</span> — ' + esc(what) + '.</div>' +
      '<div class="row">' + (evId ? '<button type="button" class="btn small primary" data-act="toast-done" data-id="' + esc(evId) + '">Fatto, portale aggiornato</button><button type="button" class="btn small" data-act="toast-close">Più tardi</button>'
        : '<button type="button" class="btn small primary" data-act="toast-close">Fatto</button>') + '</div>';
    host.appendChild(el);
  }

  async function moveEvent(id, date) {
    const ev = eventById(id);
    if (!ev || !isYmd(date) || ev.date === date) return;
    const from = ev.date;
    try { await patchDoc('events', id, { date: date, movedFrom: from, portalToUpdate: true, updatedAt: nowIso() }); }
    catch (e) { notice('bad', 'Non sono riuscito a spostare il collaudo' + errText(e) + '.', true); refreshAll(); return; }
    let what = 'spostato dal ' + dayLabel(from) + ' al ' + dayLabel(date);
    if (ev.status === 'files' && from.slice(0, 7) !== date.slice(0, 7)) what += '. I file sono già stati creati e il nome dell’Excel riporta il mese precedente';
    raiseToast(id, ev.matricola, ev.oda, what);
    refreshAll();
  }

  async function setPortalDone(id) {
    const ev = eventById(id); if (!ev) return;
    try { await patchDoc('events', id, { portalToUpdate: false, updatedAt: nowIso() }); }
    catch (e) { notice('bad', 'Non sono riuscito ad aggiornare il collaudo' + errText(e) + '.', true); return; }
    refreshAll(); paintPanel(true);
  }

  async function deleteEvent(id) {
    const ev = eventById(id); if (!ev) return;
    if (state.cal.confirmDel !== id) { state.cal.confirmDel = id; paintPanel(true); return; }
    try { await dropDoc('events', id); }
    catch (e) { notice('bad', 'Non sono riuscito a eliminare il collaudo' + errText(e) + '.', true); return; }
    $('#toasts').querySelectorAll('.toast').forEach((t) => { if (t.dataset.id === id) t.remove(); });
    raiseToast(null, ev.matricola, ev.oda, 'collaudo del ' + dayLabel(ev.date) + ' tolto dal calendario (' + plural(evTotal(ev), 'pezzo', 'pezzi') + ')', 'delete');
    state.cal.panel = { mode: 'day', date: ev.date }; state.cal.confirmDel = null;
    refreshAll(); paintPanel(true);
  }

  /* Trascinamento con mouse, dito o penna */
  function dropTargetAt(x, y) {
    const el = document.elementFromPoint(x, y), cell = el && el.closest ? el.closest('.cal-cell[data-date]') : null;
    return cell && $('#calGrid').contains(cell) ? cell : null;
  }
  function endDrag(e, cancel) {
    const was = DRAG.on, id = DRAG.id;
    let target = null;
    if (was && !cancel && e) { const c = dropTargetAt(e.clientX, e.clientY); target = c ? c.dataset.date : null; }
    if (DRAG.ghost) DRAG.ghost.remove();
    if (DRAG.el) { DRAG.el.classList.remove('dragging'); try { DRAG.el.releasePointerCapture(DRAG.pid); } catch (_) {} }
    document.querySelectorAll('.cal-cell.drop').forEach((c) => c.classList.remove('drop'));
    document.body.style.cursor = '';
    const dirty = DRAG.dirty;
    Object.assign(DRAG, { id: null, pid: null, on: false, ghost: null, over: null, el: null, dirty: false });
    if (was) { DRAG.suppress = true; setTimeout(() => { DRAG.suppress = false; }, 0); }
    if (target) moveEvent(id, target); else if (dirty) paintCal();
  }
  const grid0 = $('#calGrid');
  grid0.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const ev = e.target.closest('.ev'); if (!ev || DRAG.id) return;
    Object.assign(DRAG, { id: ev.dataset.id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, on: false, el: ev });
    try { ev.setPointerCapture(e.pointerId); } catch (_) {}
  });
  grid0.addEventListener('pointermove', (e) => {
    if (!DRAG.id || e.pointerId !== DRAG.pid) return;
    if (!DRAG.on) {
      if (Math.hypot(e.clientX - DRAG.sx, e.clientY - DRAG.sy) < 6) return;
      DRAG.on = true; DRAG.el.classList.add('dragging');
      const g = document.createElement('div'); g.className = 'ghost-ev'; g.textContent = DRAG.el.querySelector('.m').textContent; document.body.appendChild(g); DRAG.ghost = g;
      document.body.style.cursor = 'grabbing';
    }
    DRAG.ghost.style.left = e.clientX + 'px'; DRAG.ghost.style.top = e.clientY + 'px';
    const c = dropTargetAt(e.clientX, e.clientY);
    if (c !== DRAG.over) { if (DRAG.over) DRAG.over.classList.remove('drop'); if (c) c.classList.add('drop'); DRAG.over = c; }
  });
  grid0.addEventListener('pointerup', (e) => { if (DRAG.id && e.pointerId === DRAG.pid) endDrag(e, false); });
  grid0.addEventListener('pointercancel', (e) => { if (DRAG.id && e.pointerId === DRAG.pid) endDrag(e, true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && DRAG.on) endDrag(null, true); });

  /* ---------- Crea file: dal giorno del calendario al lotto ---------- */
  function paintDays() {
    const host = $('#daysHost');
    if (loadingNew()) { setHtml(host, '<p class="empty">Carico il calendario…</p>'); return; }
    const byDay = {};
    state.db.events.filter((e) => e.status !== 'files' && isYmd(e.date)).forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
    const days = Object.keys(byDay).sort(), tod = todayStr();
    if (!days.length) { setHtml(host, '<p class="empty">Nessun collaudo da preparare. Pianifica un ordine dal calendario e comparirà qui con i dati già pronti.</p>' +
      '<div class="row"><button type="button" class="btn small" data-act="nav" data-view="calendario">Apri il calendario</button></div>'); return; }
    setHtml(host, '<div class="day-cards">' + days.map((d) => {
      const evs = byDay[d], n = daysBetween(tod, d), loaded = evs.every((e) => state.lines.some((l) => l.eventId === e.id));
      return '<div class="day-card' + (n < 0 ? ' late' : '') + (loaded ? ' on' : '') + '"><div><b>' + esc(dayLabel(d, true)) + '</b> <span class="meta">' + esc(relDays(n)) + '</span></div>' +
        evs.map((e) => '<div class="meta"><span class="mono">' + esc(e.matricola) + '</span> · ODA <span class="mono">' + esc(e.oda) + '</span> · ' + plural(evTotal(e), 'pezzo', 'pezzi') + '</div>').join('') +
        '<div class="row"><button type="button" class="btn small primary" data-act="load-day" data-date="' + d + '"' + (loaded ? ' disabled' : '') + '>' + (loaded ? 'Già nelle schede' : 'Prepara i file') + '</button></div></div>';
    }).join('') + '</div>');
  }

  function loadDay(date, onlyId) {
    const evs = state.db.events.filter((e) => e.date === date && e.status !== 'files' && (!onlyId || e.id === onlyId))
      .sort((a, b) => String(a.matricola).localeCompare(String(b.matricola)) || String(a.oda).localeCompare(String(b.oda)));
    if (!evs.length) { notice('warn', 'Non ci sono collaudi da preparare in questo giorno.'); return; }
    let added = 0; const missing = [];
    evs.forEach((e) => {
      if (state.lines.some((l) => l.eventId === e.id)) return;
      if (!rec(e.matricola)) { missing.push(e.matricola); return; }
      const ln = newLine(e.matricola);
      ln.oda = e.oda; ln.eventId = e.id;
      ln.dests = evLines(e).map((l) => ({ name: l.name, qty: String(l.qty) }));
      state.lines.push(ln); added++;
    });
    if (missing.length) notice('bad', 'Matricola non in anagrafica: ' + missing.join(', ') + '. Aggiungila in “Matricole”.', true);
    const avs = evs.map((e) => String(e.avviso || '').trim()).filter(Boolean);
    if (avs.length && !state.avviso.trim()) { state.avviso = avs[0]; $('#avviso').value = avs[0]; }
    const d = parseYmd(date);
    state.mese = C.MESI[d.getMonth()]; state.anno = String(d.getFullYear()).slice(-2);
    $('#mese').value = state.mese; $('#anno').value = state.anno;
    state.confirming = false; state.result = null;
    showView('lotto'); renderResult(); renderLines(); update();
    if (added) { const a = $('#avviso'); a.scrollIntoView({ block: 'start' }); a.focus({ preventScroll: true }); notice('ok', 'Schede pronte per ' + dayLabel(date, true) + '. Indica il numero dell’avviso e controlla le quantità.'); }
  }

  /* ---------- eventi della nuova parte ---------- */
  $('#ordEditor').addEventListener('input', (e) => {
    const t = e.target, E = state.ord.edit; if (!E) return;
    if (t.dataset.of) E.f[t.dataset.of] = t.value;
    else if (t.dataset.od) { const d = E.dests[Number(t.closest('.dest').dataset.di)]; if (d) d[t.dataset.od] = t.value; }
    paintOrdMeta();
  });
  $('#calPanel').addEventListener('input', (e) => {
    const t = e.target, P = state.cal.panel;
    if (t.dataset.evdate) { /* spostamento dal campo data: parte al cambio, non a ogni tasto */ return; }
    if (!P || P.mode !== 'plan') return;
    if (t.dataset.pf === 'date') P.date = t.value;
    else if (t.dataset.pf === 'post' || t.dataset.pf === 'op' || t.dataset.pf === 'avv') P[t.dataset.pf] = t.value;
    else if (t.dataset.pq != null) P.qty[t.dataset.pq] = t.value;
    paintPlanMeta();
  });
  $('#calPanel').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.evdate) { if (isYmd(t.value)) { const d = parseYmd(t.value); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth(); moveEvent(t.dataset.evdate, t.value).then(() => paintPanel(true)); } }
    else if (t.dataset.pf === 'date' && state.cal.panel && isYmd(t.value)) { const d = parseYmd(t.value); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth(); paintCal(); }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, P = state.cal.panel;
    if (DRAG.suppress && (act === 'ev' || act === 'day')) return;
    if (act === 'new-order') openOrder(null);
    else if (act === 'ord-edit') openOrder(b.dataset.id);
    else if (act === 'ord-cancel') { state.ord.edit = null; paintOrdEditor(true); }
    else if (act === 'ord-pick' && state.ord.edit) {
      const r = rec(b.dataset.mat);
      state.ord.edit.mat = b.dataset.mat;
      state.ord.edit.dests = destList(r).map((n) => ({ name: n, qty: '' }));
      if (!state.ord.edit.dests.length) state.ord.edit.dests.push({ name: '', qty: '' });
      paintOrdEditor(true); const f = document.getElementById('o-oda'); if (f) f.focus();
    }
    else if (act === 'ord-change-mat' && state.ord.edit) { state.ord.edit.mat = null; paintOrdEditor(true); }
    else if (act === 'ord-add-dest' && state.ord.edit) { state.ord.edit.dests.push({ name: '', qty: '' }); paintOrdEditor(true); const i = state.ord.edit.dests.length - 1; const el = document.querySelector('#ordEditor .dest[data-di="' + i + '"] input'); if (el) el.focus(); }
    else if (act === 'ord-rm-dest' && state.ord.edit) { state.ord.edit.dests.splice(Number(b.closest('.dest').dataset.di), 1); paintOrdEditor(true); }
    else if (act === 'ord-save') saveOrder();
    else if (act === 'ord-delete' && state.ord.edit && state.ord.edit.id) {
      if (!state.ord.confirmDel) { state.ord.confirmDel = true; paintOrdEditor(true); return; }
      const id = state.ord.edit.id;
      dropDoc('orders', id).then(() => { state.ord.edit = null; state.ord.confirmDel = false; refreshAll(); notice('ok', 'Ordine eliminato.'); })
        .catch((er) => notice('bad', 'Non sono riuscito a eliminare l’ordine' + errText(er) + '.', true));
    }
    else if (act === 'ord-del-card') { state.ord.delCard = state.ord.delCard === b.dataset.id ? null : b.dataset.id; paintOrders(false); }
    else if (act === 'ord-del-no') { state.ord.delCard = null; paintOrders(false); }
    else if (act === 'ord-del-ok') deleteOrderCard(b.dataset.id);
    else if (act === 'ord-filter') { state.ord.filter = b.dataset.f; paintOrders(false); }
    else if (act === 'plan-order') startPlan(b.dataset.order, P && P.mode === 'plan' && isYmd(P.date) ? P.date : (P && P.mode === 'day' ? P.date : ''));
    else if (act === 'plan-new') startPlan(null, b.dataset.date);
    else if (act === 'plan-pick' && P && P.mode === 'plan') {
      const o = orderById(b.dataset.order); if (!o) return;
      P.orderId = o.id; P.qty = {}; orderStats(o).rows.forEach((x, i) => { if (x.left > 0) P.qty[i] = ''; });
      paintPanel(true); const el = document.getElementById('pl-date'); if (el) el.focus({ preventScroll: true });
    }
    else if (act === 'plan-all' && P && P.mode === 'plan' && P.orderId) { const o = orderById(P.orderId); orderStats(o, P.eventId).rows.forEach((x, i) => { P.qty[i] = x.left > 0 ? String(x.left) : ''; }); paintPanel(true); }
    else if (act === 'plan-none' && P && P.mode === 'plan') { Object.keys(P.qty).forEach((k) => { P.qty[k] = ''; }); paintPanel(true); }
    else if (act === 'plan-save') savePlan();
    else if (act === 'panel-close') { state.cal.panel = null; state.cal.confirmDel = null; paintCal(); }
    else if (act === 'cal-prev') { state.cal.m--; if (state.cal.m < 0) { state.cal.m = 11; state.cal.y--; } paintCal(); }
    else if (act === 'cal-next') { state.cal.m++; if (state.cal.m > 11) { state.cal.m = 0; state.cal.y++; } paintCal(); }
    else if (act === 'cal-today') { const n = new Date(); state.cal.y = n.getFullYear(); state.cal.m = n.getMonth(); paintCal(); }
    else if (act === 'day') {
      const date = b.dataset.date;
      if (P && P.mode === 'plan' && (P.orderId || P.free)) { P.date = date; const d = parseYmd(date); if (d.getMonth() !== state.cal.m) { state.cal.y = d.getFullYear(); state.cal.m = d.getMonth(); } paintCal(); paintPanel(true); }
      else openPanel({ mode: 'day', date: date }, true);
    }
    else if (act === 'ev') openPanel({ mode: 'event', id: b.dataset.id }, true);
    else if (act === 'ev-go') { const ev = eventById(b.dataset.id); if (ev && isYmd(ev.date)) { const d = parseYmd(ev.date); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth(); } showView('calendario'); openPanel({ mode: 'event', id: b.dataset.id }, true); }
    else if (act === 'ev-edit') {
      const ev = eventById(b.dataset.id), o = ev && orderById(ev.orderId);
      if (!ev || !o) return notice('bad', 'L’ordine di questo collaudo non esiste più: non posso modificare le quantità.', true);
      const qty = {}; const mine = new Map(evLines(ev).map((l) => [lineKey(l.name), l.qty]));
      orderStats(o, ev.id).rows.forEach((x, i) => { qty[i] = mine.has(lineKey(x.name)) ? String(mine.get(lineKey(x.name))) : ''; });
      openPanel({ mode: 'plan', orderId: o.id, eventId: ev.id, date: ev.date, qty: qty, post: ev.postazioni ? String(ev.postazioni) : '', op: ev.operatore || '', avv: ev.avviso || '' }, true);
    }
    else if (act === 'ev-del') deleteEvent(b.dataset.id);
    else if (act === 'ev-del-no') { state.cal.confirmDel = null; paintPanel(true); }
    else if (act === 'portal-done' || act === 'toast-done') {
      if (b.dataset.id) setPortalDone(b.dataset.id);
      const t = b.closest('.toast'); if (t) t.remove();
    }
    else if (act === 'toast-close') { const t = b.closest('.toast'); if (t) t.remove(); }
    else if (act === 'load-day') loadDay(b.dataset.date, b.dataset.id || null);
  });


  /* =====================================================================
     PROMEMORIA (campanella e avviso)
     1) Inizio mese: dal primo giorno lavorativo (mai sabato o domenica) compare
        "Inserisci gli ordini del mese", finché non lo segni come fatto.
     2) Scadenze: per ogni mese il promemoria parte 10 giorni prima della fine del
        mese (se cade di sabato o domenica, il venerdì prima) e riguarda gli ordini con
        scadenza in quel mese non ancora tutti in calendario. Resta acceso come arretrato.
     ===================================================================== */
  state.rem = { done: {}, got: false, toasted: false };
  const monthKey = (s) => s.slice(0, 7);
  function reminderDate(y, m) {
    const t = new Date(y, m + 1, 0, 12);
    t.setDate(t.getDate() - 10);
    const wd = t.getDay();
    if (wd === 6) t.setDate(t.getDate() - 1); else if (wd === 0) t.setDate(t.getDate() - 2);
    return ymd(t);
  }
  function monthStartDate(y, m) {
    const t = new Date(y, m, 1, 12), wd = t.getDay();
    if (wd === 6) t.setDate(3); else if (wd === 0) t.setDate(2);
    return ymd(t);
  }
  function monthReminder() {
    const tod = todayStr(), d = parseYmd(tod), k = monthKey(tod), from = monthStartDate(d.getFullYear(), d.getMonth());
    if (tod < from || state.rem.done[k]) return null;
    const n = state.db.orders.filter((o) => isYmd(o.due) && monthKey(o.due) === k).length;
    return { key: k, m: d.getMonth(), y: d.getFullYear(), from: from, inserted: n };
  }
  function pendingDeadlines() {
    const out = [];
    state.db.orders.forEach((o) => {
      if (!isYmd(o.due)) return;
      const st = orderStats(o); if (st.left <= 0 || o.archived === true) return;
      const d = parseYmd(o.due);
      out.push({ o: o, st: st, key: monthKey(o.due), y: d.getFullYear(), m: d.getMonth(), rd: reminderDate(d.getFullYear(), d.getMonth()) });
    });
    return out.sort((a, b) => a.o.due.localeCompare(b.o.due) || String(a.o.oda).localeCompare(String(b.o.oda)));
  }
  const dueReminders = () => { const t = todayStr(); return pendingDeadlines().filter((x) => x.rd <= t); };
  const reminderCount = () => (loadingNew() ? 0 : dueReminders().length + (monthReminder() ? 1 : 0) + evAlerts().length);

  let bellOpen = false;
  function bellPanelHtml() {
    const mr = monthReminder(), list = dueReminders(), EA = evAlerts(), count = list.length + (mr ? 1 : 0) + EA.length;
    const head = '<div class="sec-head"><div><h2>Promemoria</h2><p class="sub">' + (count ? plural(count, 'promemoria', 'promemoria') : 'Tutto sotto controllo.') + '</p></div>' +
      '<button type="button" class="btn ghost small" data-act="bell">Chiudi</button></div>';
    const rule = '<p class="hint">Inizio mese: compare il primo giorno lavorativo, mai di sabato o domenica. Scadenze: compare 10 giorni prima della fine del mese (se cade nel fine settimana, il venerdì prima) e resta acceso finché l’ordine non è tutto in calendario.</p>';
    let html = head + evAlertsHtml(EA);
    if (mr) {
      html += '<div class="bgrp"><h3>Ordini di ' + esc(C.MESI[mr.m].toLowerCase()) + '</h3><p class="meta">Promemoria dal ' + esc(dayLabel(mr.from, true)) + '</p><div class="todo-list"><div class="tr"><div class="grow"><b>Inserisci gli ordini del mese.</b><br><span class="meta">' +
        (mr.inserted ? 'Finora ' + plural(mr.inserted, 'ordine inserito', 'ordini inseriti') + ' con scadenza a ' + esc(C.MESI[mr.m].toLowerCase()) + '.' : 'Nessun ordine inserito con scadenza a ' + esc(C.MESI[mr.m].toLowerCase()) + '.') + '</span></div>' +
        '<button type="button" class="btn primary small" data-act="new-order">+ Nuovo ordine</button>' +
        '<button type="button" class="btn small" data-act="month-done">Fatto, sono tutti inseriti</button></div></div></div>';
    }
    if (list.length) {
      const groups = [];
      list.forEach((x) => { let g = groups.find((k) => k.key === x.key); if (!g) { g = { key: x.key, y: x.y, m: x.m, rd: x.rd, items: [] }; groups.push(g); } g.items.push(x); });
      html += groups.map((g) => '<div class="bgrp"><h3>Scadenze di ' + esc(C.MESI[g.m].toLowerCase() + ' ' + g.y) + ' non pianificate</h3><p class="meta">Promemoria dal ' + esc(dayLabel(g.rd, true)) + '</p><div class="todo-list">' +
        g.items.map((x) => { const di = dueInfo(x.o, x.st.left), r = rec(x.o.matricola) || {};
          return '<div class="tr"><div class="grow"><b class="mono">' + esc(x.o.matricola) + '</b> <span class="meta">' + esc(r.descrizione || '') + '</span><br><span class="meta">ODA <span class="mono">' + esc(x.o.oda) + '</span> · da pianificare <span class="mono">' + nf.format(x.st.left) + '</span> su ' + nf.format(x.st.ordered) + '</span></div>' +
            (di ? '<span class="due ' + di.cls + '">' + esc(di.text) + '</span>' : '') +
            '<button type="button" class="btn primary small" data-act="plan-order" data-order="' + esc(x.o.id) + '">Pianifica</button></div>'; }).join('') + '</div></div>').join('');
    }
    if (!count) {
      const up = pendingDeadlines().filter((x) => x.rd > todayStr()).sort((a, b) => a.rd.localeCompare(b.rd));
      const nm = new Date(); const nxt = monthStartDate(nm.getMonth() === 11 ? nm.getFullYear() + 1 : nm.getFullYear(), (nm.getMonth() + 1) % 12);
      let txt = 'Nessuna scadenza da pianificare. Prossimo promemoria di inizio mese: ' + dayLabel(nxt, true) + '.';
      if (up.length) {
        const n = up.filter((x) => x.key === up[0].key).length;
        txt = 'Prossimo promemoria: ' + dayLabel(up[0].rd, true) + ', per ' + plural(n, 'ordine', 'ordini') + ' con scadenza a ' + C.MESI[up[0].m].toLowerCase() + '.';
      }
      html += '<p class="empty">' + esc(txt) + '</p>';
    }
    return html + rule;
  }
  function paintBell() {
    const btn = $('#bellBtn'), nEl = $('#bellN'), panel = $('#bellPanel'), n = reminderCount();
    nEl.hidden = !n; nEl.textContent = String(n);
    btn.classList.toggle('has', n > 0);
    btn.setAttribute('aria-label', n ? 'Promemoria: ' + plural(n, 'avviso', 'avvisi') : 'Promemoria: nessun avviso');
    btn.setAttribute('aria-expanded', String(bellOpen));
    panel.hidden = !bellOpen;
    if (bellOpen) setHtml(panel, bellPanelHtml());
  }
  function setBell(open, focusBtn) {
    bellOpen = open; paintBell();
    if (open) { const c = document.querySelector('#bellPanel [data-act=bell]'); if (c) c.focus({ preventScroll: true }); }
    else if (focusBtn) $('#bellBtn').focus({ preventScroll: true });
  }

  /* Avviso a comparsa di inizio mese: una volta al giorno per browser, finché non lo segni come fatto. */
  const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) { /* nessun problema: si ripresenta */ } };
  function raiseMonthToast(mr) {
    const host = $('#toasts');
    if (host.querySelector('.toast[data-k=month]')) return;
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'alert'); el.dataset.k = 'month';
    el.innerHTML = '<div class="tt">Inserisci gli ordini del mese</div>' +
      '<div class="td">È iniziato ' + esc(C.MESI[mr.m].toLowerCase()) + ': aggiungi gli ordini con scadenza a ' + esc(C.MESI[mr.m].toLowerCase()) + ' (finora ' + nf.format(mr.inserted) + ').</div>' +
      '<div class="row"><button type="button" class="btn small primary" data-act="toast-orders">Inserisci gli ordini</button><button type="button" class="btn small" data-act="month-done">Fatto, sono tutti inseriti</button><button type="button" class="btn small" data-act="toast-close">Più tardi</button></div>';
    host.appendChild(el);
  }
  function maybeMonthToast() {
    if (state.rem.toasted || loadingNew()) return;
    const mr = monthReminder(); if (!mr) return;
    state.rem.toasted = true;
    if (lsGet('ss-month-toast') === todayStr()) return;
    raiseMonthToast(mr);
  }
  async function markMonthDone() {
    const k = todayStr().slice(0, 7), next = Object.assign({}, state.rem.done); next[k] = nowIso();
    try { if (dbh) await dbh.doc('meta/reminders').set({ ordersDone: next, updatedAt: nowIso() }); }
    catch (e) { notice('bad', 'Non sono riuscito a salvare il promemoria' + errText(e) + '.', true); return; }
    state.rem.done = next;
    document.querySelectorAll('#toasts .toast[data-k=month]').forEach((t) => t.remove());
    refreshAll();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), act = b && b.dataset.act;
    const inPanel = !!e.target.closest('#bellPanel');   /* prima di ridisegnare: i pulsanti vengono sostituiti */
    if (act === 'month-done') { markMonthDone(); }
    else if (act === 'toast-orders') { const t = b.closest('.toast'); if (t) t.remove(); lsSet('ss-month-toast', todayStr()); openOrder(null); }
    else if (act === 'toast-close') { const t = b.closest('.toast'); if (t && t.dataset.k === 'month') lsSet('ss-month-toast', todayStr()); }
    if (act === 'bell') { setBell(!bellOpen, true); return; }
    if (!bellOpen) return;
    if (inPanel) { if (act !== 'month-done') setBell(false, false); return; }
    setBell(false, false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bellOpen && !DRAG.on) setBell(false, true); });
  /* Se la pagina resta aperta per giorni, i promemoria scattano anche senza ricaricare. */
  const tick = () => { state.rem.toasted = false; paintBell(); paintCal(); paintOrders(false); maybeMonthToast(); };
  setInterval(tick, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  /* ---------- risorse: logo per il PDF e larghezze dei caratteri (generate) ---------- */
  const LOGO_PDF = window.LOGO_PDF_PNG;
  const PDF_W = { r: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 761, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500],
    b: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 761, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556] };
  /* =====================================================================
     PDF · SCHEDA COLLAUDO (scritto a mano: Helvetica + logo, nessuna libreria)
     ===================================================================== */
  const PDFX = (function () {
    const PW = 595.28, PH = 841.89, M = 40, CW = PW - 2 * M;
    const COL = { ink: [0.10, 0.16, 0.19], mute: [0.36, 0.42, 0.45], line: [0.82, 0.86, 0.88], zebra: [0.95, 0.965, 0.97], brand: [0.063, 0.161, 0.208], white: [1, 1, 1] };
    const CP = { 0x2019: 0x92, 0x2018: 0x91, 0x201C: 0x93, 0x201D: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x2022: 0x95, 0x20AC: 0x80, 0x2026: 0x85, 0x2212: 0x2D };
    const code = (ch) => { const c = ch.charCodeAt(0); if (c === 0xA0) return 32; if ((c >= 32 && c < 127) || (c >= 0xA1 && c <= 0xFF)) return c; return CP[c] || 63; };
    const width = (s, bold, size) => { const t = bold ? PDF_W.b : PDF_W.r; let w = 0; for (const ch of String(s)) w += t[code(ch) - 32] || 0; return w * size / 1000; };
    const lit = (s) => { let o = ''; for (const ch of String(s)) { const c = code(ch); o += (c === 40 || c === 41 || c === 92) ? '\\' + String.fromCharCode(c) : String.fromCharCode(c); } return o; };
    const n2 = (x) => (Math.round(x * 100) / 100).toString();
    const rgb = (c) => c.map((v) => n2(v)).join(' ');
    const latin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

    function wrap(s, bold, size, maxW) {
      const words = String(s).split(/\s+/).filter(Boolean), lines = []; let cur = '';
      const fitWord = (w) => { while (width(w, bold, size) > maxW && w.length > 1) { let k = w.length - 1; while (k > 1 && width(w.slice(0, k), bold, size) > maxW) k--; lines.push(w.slice(0, k)); w = w.slice(k); } return w; };
      words.forEach((w) => {
        const t = cur ? cur + ' ' + w : w;
        if (width(t, bold, size) <= maxW) cur = t; else { if (cur) lines.push(cur); cur = fitWord(w); }
      });
      if (cur) lines.push(cur);
      return lines.length ? lines : [''];
    }

    function pngRaw(b64) {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      let p = 8, w = 0, h = 0; const parts = []; let tot = 0;
      while (p + 8 <= u.length) {
        const n = ((u[p] << 24) | (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3]) >>> 0, t = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
        if (t === 'IHDR') { w = ((u[p + 8] << 24) | (u[p + 9] << 16) | (u[p + 10] << 8) | u[p + 11]) >>> 0; h = ((u[p + 12] << 24) | (u[p + 13] << 16) | (u[p + 14] << 8) | u[p + 15]) >>> 0; }
        else if (t === 'IDAT') { parts.push(u.subarray(p + 8, p + 8 + n)); tot += n; }
        p += 12 + n;
      }
      const data = new Uint8Array(tot); let o = 0; parts.forEach((x) => { data.set(x, o); o += x.length; });
      return { w: w, h: h, data: data };
    }

    /* ---- pagina: raccolta di comandi grafici ---- */
    function Page() { this.ops = []; }
    Page.prototype.text = function (x, y, s, o) {
      o = o || {}; const size = o.size || 10, bold = !!o.bold; let px = x;
      if (o.align === 'r') px = x - width(s, bold, size); else if (o.align === 'c') px = x - width(s, bold, size) / 2;
      this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + n2(size) + ' Tf ' + rgb(o.color || COL.ink) + ' rg 1 0 0 1 ' + n2(px) + ' ' + n2(y) + ' Tm (' + lit(s) + ') Tj ET');
    };
    Page.prototype.rect = function (x, y, w, h, o) {
      o = o || {};
      let s = '';
      if (o.fill) s += rgb(o.fill) + ' rg ';
      if (o.stroke) s += rgb(o.stroke) + ' RG ' + n2(o.lw || 0.7) + ' w ';
      this.ops.push(s + n2(x) + ' ' + n2(y) + ' ' + n2(w) + ' ' + n2(h) + ' re ' + (o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S'));
    };
    Page.prototype.line = function (x1, y1, x2, y2, o) {
      o = o || {};
      this.ops.push(rgb(o.color || COL.line) + ' RG ' + n2(o.lw || 0.7) + ' w ' + n2(x1) + ' ' + n2(y1) + ' m ' + n2(x2) + ' ' + n2(y2) + ' l S');
    };
    Page.prototype.image = function (x, y, w, h) { this.ops.push('q ' + n2(w) + ' 0 0 ' + n2(h) + ' ' + n2(x) + ' ' + n2(y) + ' cm /Im1 Do Q'); };

    /* ---- una scheda di collaudo (può occupare più pagine) ---- */
    function sheetPages(S, img, stamp) {
      const pages = [];
      let pg = null, y = 0;
      const head = (cont) => {
        pg = new Page(); pages.push(pg);
        const lw = cont ? 120 : 165, lh = lw * img.h / img.w;
        pg.image(M, PH - M - lh, lw, lh);
        pg.text(PW - M, PH - M - 14, cont ? 'SCHEDA DI COLLAUDO · segue' : 'SCHEDA DI COLLAUDO', { size: 15, bold: true, align: 'r', color: COL.brand });
        pg.text(PW - M, PH - M - 29, 'Generata il ' + stamp, { size: 8.5, align: 'r', color: COL.mute });
        y = PH - M - lh - 12; pg.line(M, y, PW - M, y, { color: COL.brand, lw: 1.2 });
        y -= 14;
        if (cont) { pg.text(M, y - 9, S.matricola + ' · ODA ' + S.oda + ' · ' + S.dateText, { size: 10, bold: true }); y -= 26; }
      };
      head(false);
      /* matricola e giorno */
      pg.text(M, y - 7, 'MATRICOLA', { size: 7.5, bold: true, color: COL.mute });
      pg.text(M, y - 36, S.matricola, { size: 28, bold: true, color: COL.brand });
      const dl = wrap(S.descrizione || '', false, 11, 300).slice(0, 2);
      dl.forEach((t, i) => pg.text(M, y - 52 - i * 13, t, { size: 11, color: COL.mute }));
      pg.text(PW - M, y - 7, 'DATA DEL COLLAUDO', { size: 7.5, bold: true, color: COL.mute, align: 'r' });
      wrap(S.dateText, true, 15, 230).slice(0, 2).forEach((t, i) => pg.text(PW - M, y - 26 - i * 17, t, { size: 15, bold: true, align: 'r', color: S.hasDate ? COL.ink : COL.mute }));
      y -= 52 + (dl.length ? dl.length * 13 : 0) + 10;
      /* riquadri con i dati principali */
      const cells = S.cells, cw = CW / 3, rows = Math.ceil(cells.length / 3), ch = 40;
      pg.rect(M, y - rows * ch, CW, rows * ch, { stroke: COL.line, lw: 0.7 });
      for (let r = 1; r < rows; r++) pg.line(M, y - r * ch, PW - M, y - r * ch);
      cells.forEach((c, i) => {
        const col = i % 3, r = Math.floor(i / 3), x = M + col * cw;
        if (col > 0 && i < cells.length) pg.line(x, y - r * ch, x, y - (r + 1) * ch);
        pg.text(x + 10, y - r * ch - 14, c[0].toUpperCase(), { size: 7, bold: true, color: COL.mute });
        pg.text(x + 10, y - r * ch - 30, c[1], { size: c[2] ? 10.5 : 13, bold: !c[2], color: c[2] ? COL.mute : COL.ink });
      });
      y -= rows * ch + 22;
      /* tabella per destinazione */
      pg.text(M, y, 'Destinazioni', { size: 11, bold: true, color: COL.brand }); y -= 10;
      const cols = S.cols; // [{k, label, w, align}]
      const drawHeader = () => {
        pg.rect(M, y - 20, CW, 20, { fill: COL.brand });
        let x = M;
        cols.forEach((c) => { pg.text(c.align === 'r' ? x + c.w - 8 : x + 8, y - 13.5, c.label, { size: 8.5, bold: true, color: COL.white, align: c.align === 'r' ? 'r' : 'l' }); x += c.w; });
        y -= 20;
      };
      drawHeader();
      const drawRow = (r, bold, i, total) => {
        const cellLines = cols.map((c) => wrap(r[c.k] == null ? '' : r[c.k], bold, 10, c.w - 16));
        const rh = Math.max(...cellLines.map((l) => l.length)) * 12.5 + 9;
        if (y - rh < M + 70) { head(true); drawHeader(); }
        if (total) pg.line(M, y, PW - M, y, { color: COL.brand, lw: 1 });
        else if (i % 2 === 1) pg.rect(M, y - rh, CW, rh, { fill: COL.zebra });
        let x = M;
        cols.forEach((c, k) => {
          cellLines[k].forEach((t, j) => {
            const ty = y - 14 - j * 12.5;
            if (c.align === 'r') pg.text(x + c.w - 8, ty, t, { size: 10, bold: bold, align: 'r' });
            else pg.text(x + 8, ty, t, { size: 10, bold: bold || c.bold });
          });
          x += c.w;
        });
        y -= rh;
        if (!total) pg.line(M, y, PW - M, y);
      };
      S.rows.forEach((r, i) => drawRow(r, false, i, false));
      drawRow(S.totalRow, true, 0, true);
      if (S.note) { y -= 12; wrap(S.note, false, 9, CW).forEach((t) => { pg.text(M, y - 9, t, { size: 9, color: COL.mute }); y -= 12; }); }
      /* note e firma */
      const boxH = 66;
      if (y - boxH - 56 < M + 28) head(true);
      y -= 20;
      pg.text(M, y, 'NOTE', { size: 7.5, bold: true, color: COL.mute });
      pg.rect(M, y - 8 - boxH, CW, boxH, { stroke: COL.line, lw: 0.7 });
      y -= 8 + boxH + 30;
      pg.line(M, y, M + 200, y, { color: COL.mute }); pg.text(M, y - 11, 'Data e firma', { size: 8, color: COL.mute });
      return pages;
    }

    /* sheets: elenco di schede; restituisce i byte del file PDF */
    function build(sheets, title) {
      const img = pngRaw(LOGO_PDF);
      const d = new Date(), stamp = pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      let pages = []; sheets.forEach((S) => { pages = pages.concat(sheetPages(S, img, stamp)); });
      pages.forEach((p, i) => {
        p.line(M, 38, PW - M, 38);
        p.text(M, 26, 'Officine Demo · Componenti industriali', { size: 8, color: COL.mute });
        p.text(PW - M, 26, 'Pagina ' + (i + 1) + ' di ' + pages.length, { size: 8, color: COL.mute, align: 'r' });
      });
      const chunks = [], offs = []; let len = 0;
      const put = (x) => { const b = typeof x === 'string' ? latin1(x) : x; chunks.push(b); len += b.length; };
      const obj = (n, dict, stream) => {
        offs[n] = len; put(n + ' 0 obj\n');
        if (stream) { put('<< ' + dict + ' /Length ' + stream.length + ' >>\nstream\n'); put(stream); put('\nendstream\nendobj\n'); }
        else put(dict + '\nendobj\n');
      };
      const N = 6 + pages.length * 2;
      put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, '<< /Type /Pages /Kids [' + pages.map((_, i) => (7 + i * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>');
      obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      obj(5, '/Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ' + img.w + ' >>', img.data);
      obj(6, '<< /Title (' + lit(title) + ') /Creator (Collaudi e Seriali) /Producer (Officine Demo) >>');
      pages.forEach((p, i) => {
        obj(8 + i * 2, '', latin1(p.ops.join('\n')));
        obj(7 + i * 2, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents ' + (8 + i * 2) + ' 0 R >>');
      });
      const xr = len;
      let x = 'xref\n0 ' + (N + 1) + '\n0000000000 65535 f \n';
      for (let i = 1; i <= N; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
      put(x + 'trailer\n<< /Size ' + (N + 1) + ' /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xr + '\n%%EOF\n');
      const out = new Uint8Array(len); let o = 0; chunks.forEach((c) => { out.set(c, o); o += c.length; });
      return out;
    }
    return { build: build };
  })();

  /* ---- dati della scheda da un collaudo del calendario ---- */
  function pairText(sizes) {
    const g = []; (sizes || []).forEach((s) => { const l = g[g.length - 1]; if (l && l.s === s) l.n++; else g.push({ s: s, n: 1 }); });
    return g.map((x) => x.n + ' × ' + x.s).join(' + ');
  }
  const spanText = (a, b) => (a === b ? String(a) : a + '–' + b);
  function sheetForEvent(e) {
    const r = rec(e.matricola) || {}, run = e.status === 'files' && e.runId ? state.db.runs.find((x) => x.id === e.runId) : null;
    const rl = run ? run.lines.find((l) => l.matricola === e.matricola && l.oda === e.oda) : null;
    const hasDate = isYmd(e.date), total = evTotal(e);
    const S = { matricola: e.matricola, descrizione: r.descrizione || '', oda: e.oda, hasDate: hasDate,
      dateText: hasDate ? dayLabel(e.date, true) + ' ' + parseYmd(e.date).getFullYear() : 'Da fissare' };
    if (rl) {
      const plan = C.planLine({ matricola: rl.matricola, oda: rl.oda, perPallet: rl.perPallet, remainder: rl.remainder, destinations: rl.destinations }, rl.firstSerial, rl.firstPallet);
      S.cols = [{ k: 'dest', label: 'Destinazione', w: 150 }, { k: 'qty', label: 'Pezzi', w: 50, align: 'r' }, { k: 'pal', label: 'Pallet n.', w: 85 }, { k: 'comp', label: 'Composizione', w: 100 }, { k: 'ser', label: 'Seriali da – a', w: 130 }];
      S.rows = plan.blocks.map((b) => ({ dest: b.name, qty: nf.format(b.qty), pal: spanText(b.firstPallet, b.lastPallet), comp: pairText(b.sizes), ser: spanText(b.firstSerial, b.lastSerial) }));
      S.totalRow = { dest: 'Totale', qty: nf.format(plan.total), pal: plural(plan.lastPallet - plan.firstPallet + 1, 'pallet', 'pallet'), comp: '', ser: spanText(plan.firstSerial, plan.lastSerial) };
      S.cells = [['ODA', e.oda], ['Pezzi totali', nf.format(plan.total)], ['Pallet', plural(plan.lastPallet - plan.firstPallet + 1, 'pallet', 'pallet') + ' · n. ' + spanText(plan.firstPallet, plan.lastPallet)],
        ['Seriali', spanText(plan.firstSerial, plan.lastSerial)], ['Pezzi per pallet', String(rl.perPallet)], ['Avviso portale', run.avviso || '—']];
      S.hasNumbers = true;
    } else {
      const per = isInt(r.perPallet) ? r.perPallet : 0, rem = r.remainder === 'last' ? 'last' : 'separate';
      let pallets = 0;
      S.cols = [{ k: 'dest', label: 'Destinazione', w: 240 }, { k: 'qty', label: 'Pezzi', w: 70, align: 'r' }, { k: 'comp', label: 'Pallet previsti', w: 205 }];
      S.rows = evLines(e).map((l) => { const sz = per ? C.palletSizes(l.qty, per, rem) : null; if (sz) pallets += sz.length; return { dest: l.name, qty: nf.format(l.qty), comp: sz ? plural(sz.length, 'pallet', 'pallet') + ' (' + pairText(sz) + ')' : '—' }; });
      S.totalRow = { dest: 'Totale', qty: nf.format(total), comp: per ? plural(pallets, 'pallet', 'pallet') : '' };
      S.cells = [['ODA', e.oda], ['Pezzi totali', nf.format(total)], ['Pezzi per pallet', per ? String(per) : '—'], ['Seriali', 'da assegnare', true], ['Numeri pallet', 'da assegnare', true], ['Avviso portale', '—', true]];
      S.note = 'Collaudo pianificato: seriali e numeri dei pallet vengono assegnati quando si creano i file.';
    }
    return S;
  }
  const slug = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  function pdfForEvents(evs, name, sub) {
    return { kind: 'PDF', label: 'PDF', name: name, dir: 'prod', sub: sub || '', build: () => PDFX.build(evs.map(sheetForEvent), name.replace(/\.pdf$/i, '')) };
  }
  function pdfForEvent(e) { return pdfForEvents([e], slug('Collaudo - ' + e.matricola + ' - ODA ' + e.oda + (isYmd(e.date) ? ' - ' + e.date : '')) + '.pdf', e.matricola); }
  function pdfForDay(date) {
    const evs = state.db.events.filter((e) => e.date === date).sort((a, b) => String(a.matricola).localeCompare(String(b.matricola)) || String(a.oda).localeCompare(String(b.oda)));
    return evs.length ? pdfForEvents(evs, 'Collaudi - ' + date + '.pdf', '') : null;
  }
  /* =====================================================================
     CARTELLA DEI FILE: Excel/PDF in «File produzione suddivisi per prodotto/<matricola>»,
     CSV in «File CSV collaudi». Usa l'accesso alle cartelle del browser, se disponibile.
     ===================================================================== */
  const FOLDER = { root: null, name: '', perm: 'none', err: '', blocked: false, subs: null };
  const FOLDER_PROD = 'File produzione suddivisi per prodotto', FOLDER_CSV = 'File CSV collaudi';
  const folderSupported = () => typeof window.showDirectoryPicker === 'function';

  function idb(mode, fn) {
    return new Promise((res, rej) => {
      let q; try { q = indexedDB.open('collaudi-seriali', 1); } catch (e) { rej(e); return; }
      q.onupgradeneeded = () => { q.result.createObjectStore('kv'); };
      q.onerror = () => rej(q.error);
      q.onsuccess = () => {
        const db = q.result;
        try {
          const tx = db.transaction('kv', mode), r = fn(tx.objectStore('kv'));
          tx.oncomplete = () => { db.close(); res(r && r.result); };
          tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
        } catch (e) { db.close(); rej(e); }
      };
    });
  }
  const idbGet = () => idb('readonly', (st) => st.get('root'));
  const idbSet = (h) => idb('readwrite', (st) => st.put(h, 'root'));
  const idbDel = () => idb('readwrite', (st) => st.delete('root'));

  async function findSub(root, re, fallback) {
    try { for await (const [name, h] of root.entries()) if (h.kind === 'directory' && re.test(name)) return h; } catch (e) { /* si crea sotto */ }
    return root.getDirectoryHandle(fallback, { create: true });
  }
  async function folderDirs() {
    const prod = await findSub(FOLDER.root, /produzion/i, FOLDER_PROD), csv = await findSub(FOLDER.root, /(^|[^a-z])(csv|cvs)([^a-z]|$)/i, FOLDER_CSV);
    FOLDER.subs = { prod: prod.name, csv: csv.name };
    return { prod: prod, csv: csv };
  }
  async function folderAccess() {
    if (!FOLDER.root) return false;
    if (FOLDER.perm === 'granted') return true;
    let p = await FOLDER.root.queryPermission({ mode: 'readwrite' });
    if (p === 'prompt') p = await FOLDER.root.requestPermission({ mode: 'readwrite' });
    FOLDER.perm = p;
    return p === 'granted';
  }
  async function sameContent(fh, data) {
    const f = await fh.getFile(), blob = data instanceof Blob ? data : new Blob([data]);
    if (f.size !== blob.size) return false;
    const a = new Uint8Array(await f.arrayBuffer()), b = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  /* Non sovrascrive mai: se esiste un file con lo stesso nome e contenuto diverso, aggiunge (2), (3)… */
  async function placeFile(dir, name, data) {
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 100; i++) {
      const nm = i === 1 ? name : base + ' (' + i + ')' + ext;
      let fh = null;
      try { fh = await dir.getFileHandle(nm); } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
      if (fh) { if (await sameContent(fh, data)) return { name: nm, same: true }; continue; }
      const w = await (await dir.getFileHandle(nm, { create: true })).createWritable();
      await w.write(data); await w.close();
      return { name: nm, same: false };
    }
    throw new Error('troppi file con lo stesso nome');
  }
  /* { ok, where, same } oppure { ok:false, why? }: why è presente solo se una cartella era collegata e non ha funzionato */
  async function saveToFolder(file) {
    if (!FOLDER.root) return { ok: false };
    try {
      if (!(await folderAccess())) { paintFolder(); return { ok: false, why: 'permesso da confermare' }; }
      const dirs = await folderDirs();
      let dir = file.dir === 'csv' ? dirs.csv : dirs.prod, where = dir.name;
      if (file.dir !== 'csv' && file.sub) { dir = await dir.getDirectoryHandle(slug(file.sub), { create: true }); where += ' / ' + dir.name; }
      const r = await placeFile(dir, file.name, await file.build());
      paintFolder();
      return { ok: true, where: where, same: r.same, name: r.name, renamed: r.name !== file.name };
    } catch (e) {
      FOLDER.perm = 'prompt'; paintFolder();
      return { ok: false, why: (e && (e.message || e.name)) || 'errore' };
    }
  }

  async function folderInit() {
    if (folderSupported()) {
      try {
        const h = await idbGet();
        if (h && h.kind === 'directory') { FOLDER.root = h; FOLDER.name = h.name; FOLDER.perm = await h.queryPermission({ mode: 'readwrite' }); }
      } catch (e) { /* nessuna cartella ricordata */ }
    }
    paintFolder();
  }
  async function folderLink() {
    FOLDER.err = '';
    try {
      const h = await window.showDirectoryPicker({ id: 'collaudi-seriali', mode: 'readwrite' });
      FOLDER.root = h; FOLDER.name = h.name; FOLDER.perm = 'granted';
      try { await idbSet(h); } catch (e) { FOLDER.err = 'Cartella collegata solo per questa sessione: il browser non permette di ricordarla.'; }
      try { await folderDirs(); } catch (e) { FOLDER.err = 'Cartella collegata, ma non riesco a creare le sottocartelle' + errText(e) + '.'; }
      if (window.__localDb) await window.__localDb.attach(FOLDER.root);
    } catch (e) {
      if (e && e.name === 'AbortError' && !/system|sistema/i.test(e.message || '')) { /* annullato */ }
      else if (e && e.name === 'SecurityError' && /cross|origin|frame/i.test(e.message || '')) { FOLDER.blocked = true; }
      else FOLDER.err = 'Non sono riuscito a collegare la cartella' + errText(e) + '. Se è una cartella di sistema (Documenti, Desktop, Download) scegline una dentro.';
    }
    paintFolder();
  }
  async function folderRegrant() {
    FOLDER.err = '';
    try { FOLDER.perm = await FOLDER.root.requestPermission({ mode: 'readwrite' }); if (FOLDER.perm === 'granted') { await folderDirs(); if (window.__localDb) await window.__localDb.attach(FOLDER.root); } }
    catch (e) { FOLDER.err = 'Permesso non concesso' + errText(e) + '.'; }
    paintFolder();
  }
  async function folderUnlink() {
    FOLDER.root = null; FOLDER.name = ''; FOLDER.perm = 'none'; FOLDER.subs = null; FOLDER.err = '';
    try { await idbDel(); } catch (e) { /* già vuoto */ }
    if (window.__localDb) window.__localDb.detach();
    paintFolder();
  }

  function paintFolder() {
    const host = $('#folderHost'), btn = $('#folderBtn');
    if (!host || !btn) return;
    const linked = !!FOLDER.root, ok = linked && FOLDER.perm === 'granted';
    const st = ok ? 'ok' : linked ? 'warn' : 'none';
    btn.dataset.s = st;
    btn.setAttribute('aria-label', ok ? 'Cartella dei file: collegata (' + FOLDER.name + ')' : linked ? 'Cartella dei file: serve il permesso' : 'Cartella dei file: non collegata');
    btn.title = btn.getAttribute('aria-label');
    const prod = (FOLDER.subs && FOLDER.subs.prod) || FOLDER_PROD, csv = (FOLDER.subs && FOLDER.subs.csv) || FOLDER_CSV;
    const where = '<ul class="fwhere"><li><b>Excel di produzione e PDF</b> → <span class="mono">' + esc(prod) + ' / &lt;matricola&gt;</span></li><li><b>CSV portale cliente</b> → <span class="mono">' + esc(csv) + '</span></li></ul>';
    let h;
    if (!folderSupported() || FOLDER.blocked) {
      h = '<div class="banner"><span><b>Da questa vista il browser non permette di collegare una cartella.</b> I file si scaricano nel modo normale: ogni volta il browser li mette nella cartella Download, oppure ti chiede dove salvarli se attivi “Chiedi dove salvare ogni file” nelle impostazioni dei download.</span></div>' + where +
        '<p class="hint">Per averli già divisi: Excel e PDF in “' + esc(FOLDER_PROD) + '” (una cartella per matricola), CSV in “' + esc(FOLDER_CSV) + '”. Il collegamento automatico funziona con Chrome o Edge da computer, quando la pagina lo consente.</p>';
    } else if (!linked) {
      h = '<p class="hint">Nessuna cartella collegata: i file vanno nella cartella Download del browser.</p>' + where +
        '<div class="row"><button type="button" class="btn primary" data-act="folder-link">Collega la cartella…</button><span class="hint">Scegli la cartella che contiene “' + esc(FOLDER_PROD) + '” e “' + esc(FOLDER_CSV) + '”. Se mancano le creo io.</span></div>';
    } else if (!ok) {
      h = '<p><b class="mono">' + esc(FOLDER.name) + '</b> · il browser chiede di nuovo il permesso di scrivere.</p>' + where +
        '<div class="row"><button type="button" class="btn primary" data-act="folder-regrant">Consenti di nuovo</button><button type="button" class="btn" data-act="folder-link">Scegli un’altra cartella…</button><button type="button" class="btn ghost danger" data-act="folder-unlink">Scollega</button></div>';
    } else {
      h = '<p><span class="okdot" aria-hidden="true"></span> Collegata: <b class="mono">' + esc(FOLDER.name) + '</b>. Tutti i file scaricati finiscono qui.</p>' + where +
        '<div class="row"><button type="button" class="btn" data-act="folder-link">Cambia cartella…</button><button type="button" class="btn ghost danger" data-act="folder-unlink">Scollega</button></div>';
    }
    if (FOLDER.err) h += '<ul class="msgs"><li class="warn">' + esc(FOLDER.err) + '</li></ul>';
    if (window.__localDb) h += localHtml();
    if (host.dataset.h === h) return;
    host.innerHTML = h; host.dataset.h = h;
  }

  /* ---- versione locale: dati nel file JSON, copia e ripristino a mano ---- */
  const LOCALUI = { imp: null, msg: '' };
  function localHtml() {
    const ld = window.__localDb, i = ld.info(), f = '<span class="mono">' + esc(ld.FILE) + '</span>';
    let s;
    if (ld.cloud) s = (i.err ? '<ul class="msgs"><li class="warn">' + esc(i.err) + '</li></ul>' : '<p><span class="okdot" aria-hidden="true"></span> I dati sono nel database online' + (i.email ? ' · accesso di <b>' + esc(i.email) + '</b>' : '') + (i.fileAt ? ' · aggiornati alle ' + esc(new Date(i.fileAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })) : '') + '. Le modifiche delle altre persone arrivano da sole entro 20 secondi.</p>') +
      '<div class="row"><a class="btn small" href="../">Apri Gestione Produzione</a><button type="button" class="btn small" data-act="cloud-logout">Esci</button></div>';
    else if (i.err) s = '<ul class="msgs"><li class="warn">' + esc(i.err) + '</li></ul>';
    else if (i.linked && i.perm === 'granted') s = '<p><span class="okdot" aria-hidden="true"></span> I dati sono salvati nel file ' + f + ' di questa cartella' + (i.fileAt ? ' · ultimo salvataggio ' + esc(new Date(i.fileAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })) : '') + '. Una copia di sicurezza al giorno va nella cartella “' + esc(ld.BACKUP) + '”.</p>';
    else if (i.linked) s = '<p>Per salvare nel file ' + f + ' serve il permesso sulla cartella: tocca “Consenti di nuovo”. Intanto le modifiche restano nel browser e vengono scritte nel file appena concedi il permesso.</p>';
    else s = '<p>Per ora i dati sono solo in questo browser. ' + (ld.supported() ? 'Collega la cartella del software: se contiene ' + f + ' lo carico, altrimenti lo creo.' : 'Questo browser non può scrivere nelle cartelle: usa Chrome o Edge, oppure salva e ricarica i dati a mano con i pulsanti qui sotto.') + '</p>';
    let imp = '';
    if (LOCALUI.imp) {
      const c = LOCALUI.imp.counts;
      imp = '<div class="banner"><span><b>' + esc(LOCALUI.imp.name) + '</b>: ' + c.matricole + ' matricole, ' + c.ordini + ' ordini, ' + c.collaudi + ' collaudi, ' + c.lotti + ' lotti. Sostituire i dati attuali?</span>' +
        '<span class="row"><button type="button" class="btn small primary" data-act="local-import-ok">Sostituisci i dati</button><button type="button" class="btn small" data-act="local-import-no">Annulla</button></span></div>';
    }
    return '<div class="localdb"><h3>Dati</h3>' + s + imp +
      '<div class="row"><button type="button" class="btn small" data-act="local-export">Scarica una copia dei dati</button><button type="button" class="btn small" data-act="local-import">Carica dati da un file…</button>' +
      '<input type="file" id="localImportInput" accept=".json,application/json" hidden><span class="fstat">' + esc(LOCALUI.msg) + '</span></div></div>';
  }
  document.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'localImportInput' || !window.__localDb) return;
    const file = e.target.files && e.target.files[0]; if (!file) return;
    file.text().then((t) => { LOCALUI.imp = Object.assign({ name: file.name }, window.__localDb.parseText(t)); LOCALUI.msg = ''; })
      .catch((err) => { LOCALUI.imp = null; LOCALUI.msg = 'File non caricato: ' + ((err && err.message) || 'non leggibile'); })
      .then(() => paintFolder());
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), act = b && b.dataset.act;
    if (!act) return;
    if (act === 'local-export' && window.__localDb) {
      const d = new Date(), nm = 'dati-collaudi-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '.json';
      (dlh ? dlh.save({ filename: nm, data: window.__localDb.exportText() }) : Promise.reject(new Error('download non disponibile')))
        .then(() => { LOCALUI.msg = 'Copia scaricata: ' + nm; }, (err) => { LOCALUI.msg = 'Non riuscito' + errText(err); }).then(() => paintFolder());
    } else if (act === 'local-import') { const inp = $('#localImportInput'); if (inp) { inp.value = ''; inp.click(); } }
    else if (act === 'local-import-no') { LOCALUI.imp = null; paintFolder(); }
    else if (act === 'local-import-ok' && LOCALUI.imp) {
      const p = LOCALUI.imp; LOCALUI.imp = null;
      window.__localDb.replace(p).then(() => { LOCALUI.msg = 'Dati sostituiti con quelli di ' + p.name; }, (err) => { LOCALUI.msg = 'Non riuscito' + errText(err); }).then(() => { paintFolder(); });
    }
    else if (act === 'folder-link') folderLink();
    else if (act === 'folder-regrant') folderRegrant();
    else if (act === 'folder-unlink') folderUnlink();
    else if (act === 'folder-go') { showView('storico'); const c = $('#folderCard'); if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    else if (act === 'pdf-ev') {
      const ev = eventById(b.dataset.id), stat = b.parentElement.querySelector('.fstat');
      if (ev) saveFile(pdfForEvent(ev), stat);
    } else if (act === 'pdf-day') {
      const f = pdfForDay(b.dataset.date), stat = b.parentElement.querySelector('.fstat');
      if (f) saveFile(f, stat);
    }
  });
  if (window.__localDb) window.__localDb.onStatus(() => { paintChip(); paintFolder(); });
  folderInit();
  /* =====================================================================
     TEMA: Automatico (segue il dispositivo) · Chiaro · Scuro
     ===================================================================== */
  const THEME_KEY = 'ss-theme';
  const THEMES = [['auto', 'Auto', 'automatico, segue il dispositivo'], ['light', 'Chiaro', 'chiaro'], ['dark', 'Scuro', 'scuro']];
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 1 0-17z" fill="currentColor" stroke="none"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
  };
  const hostTheme = window.__hostTheme == null ? null : window.__hostTheme;
  let themeMode = 'auto';
  try { const v = localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') themeMode = v; } catch (e) { /* senza memoria del browser: resta automatico */ }
  function themeApply() {
    const r = document.documentElement;
    const v = themeMode === 'auto' ? hostTheme : themeMode;
    if (v) r.setAttribute('data-theme', v); else r.removeAttribute('data-theme');
    const b = $('#themeBtn'); if (!b) return;
    const t = THEMES.find((x) => x[0] === themeMode);
    b.innerHTML = THEME_ICON[themeMode] + '<span>' + t[1] + '</span>';
    b.setAttribute('aria-label', 'Tema ' + t[2] + '. Tocca per cambiare tema');
    b.title = 'Tema ' + t[2];
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="theme"]'); if (!b) return;
    themeMode = THEMES[(THEMES.findIndex((x) => x[0] === themeMode) + 1) % THEMES.length][0];
    try { if (themeMode === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, themeMode); } catch (err) { /* resta solo per questa sessione */ }
    themeApply();
  });
  themeApply();

  /* =====================================================================
     STORICO: eliminare i lotti registrati dal front end
     - "Elimina…" su un lotto: solo dall'elenco, oppure annullandolo
       (la matricola torna ai numeri di prima del lotto, i collaudi collegati
       tornano "Pianificati")
     - "Svuota lo storico…": toglie tutti i lotti, i numeri registrati non cambiano
     I file già salvati nella cartella non vengono mai toccati.
     ===================================================================== */
  const SD = { one: null, all: false, busy: false };

  /* Si può annullare un lotto solo se i numeri della matricola finiscono proprio con quel lotto. */
  function runRestore(run) {
    const by = {};
    (run.lines || []).forEach((l) => {
      const b = by[l.matricola] || (by[l.matricola] = { mat: l.matricola, first: Infinity, firstP: Infinity, last: -1, lastP: -1, box: !!l.box });
      b.first = Math.min(b.first, l.firstSerial); b.firstP = Math.min(b.firstP, l.firstPallet);
      b.last = Math.max(b.last, l.lastSerial); b.lastP = Math.max(b.lastP, l.lastPallet);
      b.year = String(run.anno || '');
      if (b.prevY === undefined && isInt(l.prevYearSerial)) b.prevY = l.prevYearSerial;
      if (b.prev === undefined && isInt(l.prevSerial)) b.prev = l.prevSerial;
      if (/^\d{2}$/.test(String(l.prevYear || ''))) b.prevYear = String(l.prevYear);
    });
    const items = Object.keys(by).map((m) => {
      const b = by[m], r = rec(m);
      const cy = /^\d{2}$/.test(b.year) ? yearSerial(m, b.year) : r && r.last;
      b.ok = !!r && isInt(b.first) && isInt(b.firstP) && b.first >= 1 && b.firstP >= 1 && cy === b.last && (b.box || r.lastPallet === b.lastP);
      b.restore = isInt(b.prevY) ? b.prevY : b.first - 1;
      return b;
    });
    const bp = run.boxPal, boxOk = !bp || boxPalLast(bp.year) === Math.max(bp.prev, bp.last);
    return { items: items, boxPal: bp || null, ok: items.length > 0 && items.every((i) => i.ok) && boxOk };
  }

  function runsToolsHtml() {
    if (!state.db.runs.length) return '';
    if (SD.all) {
      return '<div class="banner runsbar"><span><b>Eliminare tutto lo storico?</b> I lotti spariscono dall’elenco. I numeri registrati (ultimo seriale e ultimo pianale di ogni matricola) non cambiano: se servono diversi li correggi da “Matricole”. I file già salvati nella cartella restano dove sono.</span>' +
        '<span class="row"><button type="button" class="btn small" data-act="runs-clear-ok"' + (SD.busy ? ' disabled' : '') + '>Sì, elimina tutto lo storico</button><button type="button" class="btn ghost small" data-act="runs-clear-no">Annulla</button></span></div>';
    }
    return '<div class="row runs-tools"><button type="button" class="btn ghost small danger" data-act="runs-clear">Svuota lo storico…</button></div>';
  }

  function runDelHtml(r) {
    const U = runRestore(r), dis = SD.busy ? ' disabled' : '';
    const evs = state.db.events.filter((e) => e.runId === r.id && e.status === 'files');
    let t = '<b>Eliminare questo lotto dallo storico?</b> ';
    if (U.ok) {
      t += 'Posso anche annullarlo: ' + U.items.map((i) => '<span class="mono">' + esc(i.mat) + '</span> tornerebbe all’ultimo seriale <span class="mono">' + nf.format(i.restore) + '</span>' + (i.year ? ' del 20' + esc(i.year) : '') + (i.box ? '' : ' e all’ultimo pianale <span class="mono">' + nf.format(i.firstP - 1) + '</span>')).join('; ') + '.' + (U.boxPal ? ' I pallet a scatole ripartono dopo il <span class="mono">' + esc(C.palSerial(U.boxPal.year, U.boxPal.prev) ) + '</span>.' : '') +
        (evs.length ? ' ' + (evs.length === 1 ? 'Il collaudo collegato torna' : 'I ' + evs.length + ' collaudi collegati tornano') + ' “Pianificato” nel calendario.' : '');
    } else {
      t += 'I numeri registrati restano come sono (non coincidono con la fine di questo lotto: dopo ci sono stati altri lotti o correzioni). Se serve li correggi da “Matricole”.';
    }
    return '<div class="banner runsbar"><span>' + t + '</span><span class="row">' +
      (U.ok ? '<button type="button" class="btn small" data-act="run-del-undo" data-run="' + esc(r.id) + '"' + dis + '>Elimina e riporta i numeri indietro</button>' : '') +
      '<button type="button" class="btn small" data-act="run-del-only" data-run="' + esc(r.id) + '"' + dis + '>' + (U.ok ? 'Elimina solo dallo storico' : 'Elimina dallo storico') + '</button>' +
      '<button type="button" class="btn ghost small" data-act="run-del-no">Annulla</button></span></div>';
  }

  async function deleteRun(id, undo) {
    const run = state.db.runs.find((r) => r.id === id);
    if (!run || !dbh || SD.busy) return;
    SD.busy = true; paintRuns();
    try {
      let msg = 'Lotto eliminato dallo storico. I numeri registrati non sono cambiati.';
      if (undo) {
        const U = runRestore(run);
        if (!U.ok) throw new Error('i numeri della matricola sono cambiati: non li tocco');
        const stamp = new Date().toISOString(), nds = {};
        /* controllo sui dati veri, come quando si registra un lotto */
        for (const i of U.items) {
          const s = await dbh.doc('serials/' + i.mat).get(), d = s.exists ? Object.assign({}, s.data() || {}) : {};
          const dly = /^\d{2}$/.test(String(d.lastYear || '')) ? String(d.lastYear) : null;
          const cy = d.lastByYear && isInt(d.lastByYear[i.year]) ? d.lastByYear[i.year] : (!dly || dly === i.year ? d.last : null);
          if (cy !== i.last || (!i.box && d.lastPallet !== i.lastP)) throw new Error('i numeri registrati sono cambiati nel frattempo: non ho toccato nulla');
          const byY = Object.assign({}, d.lastByYear || {}); if (i.year) byY[i.year] = i.restore;
          const patch = i.box ? { lastByYear: byY, updatedAt: stamp } : { lastByYear: byY, lastPallet: i.firstP - 1, updatedAt: stamp };
          if (!dly || dly === i.year) {
            if (i.prevYear && i.prevYear !== i.year && isInt(i.prev)) { patch.last = i.prev; patch.lastYear = i.prevYear; }
            else patch.last = i.restore;
          }
          nds[i.mat] = Object.assign(d, patch);
        }
        let bdoc = null;
        if (U.boxPal) {
          const bs = await dbh.doc('meta/scatole').get(), bd = bs.exists ? Object.assign({}, bs.data() || {}) : {}, by = Object.assign({}, bd.palByYear || {});
          if ((isInt(by[U.boxPal.year]) ? by[U.boxPal.year] : 0) !== Math.max(U.boxPal.prev, U.boxPal.last)) throw new Error('i pallet sono cambiati nel frattempo: non ho toccato nulla');
          by[U.boxPal.year] = U.boxPal.prev; bdoc = Object.assign(bd, { palByYear: by, updatedAt: stamp });
        }
        for (const m of Object.keys(nds)) { await dbh.doc('serials/' + m).set(nds[m]); state.db.serials[m] = nds[m]; }
        if (bdoc) { await dbh.doc('meta/scatole').set(bdoc); state.boxPal = Object.assign({}, bdoc.palByYear); }
        const evs = state.db.events.filter((e) => e.runId === id);
        for (const ev of evs) await patchDoc('events', ev.id, { status: 'planned', runId: null, filesAt: null, updatedAt: stamp });
        msg = 'Lotto annullato: ' + U.items.map((i) => i.mat + ' torna a seriale ' + nf.format(i.restore) + (i.box ? '' : ' e pianale ' + nf.format(i.firstP - 1))).join('; ') + '.' + (U.boxPal ? ' Pallet a scatole di nuovo dopo il ' + C.palSerial(U.boxPal.year, U.boxPal.prev) + '.' : '') +
          (evs.length ? ' ' + plural(evs.length, 'collaudo', 'collaudi') + ' di nuovo in calendario come pianificat' + (evs.length === 1 ? 'o' : 'i') + '.' : '');
      }
      await dropDoc('runs', id);
      SD.one = null; notice('ok', msg);
    } catch (e) { notice('bad', 'Non sono riuscito a eliminare il lotto' + errText(e) + '.', true); }
    SD.busy = false; refreshAll();
  }

  async function clearRuns() {
    if (!dbh || SD.busy) return;
    SD.busy = true; paintRuns();
    let n = 0, tot = 0;
    try {
      const snap = await dbh.collection('runs').get();   /* tutti, non solo i 30 mostrati */
      tot = snap.docs.length;
      for (const d of snap.docs) { await dbh.doc('runs/' + d.id).delete(); n++; }
      state.db.runs = []; SD.all = false; SD.one = null;
      notice('ok', 'Storico eliminato (' + plural(n, 'lotto', 'lotti') + '). I numeri registrati non sono cambiati.');
    } catch (e) {
      notice('bad', 'Non sono riuscito a eliminare tutto' + errText(e) + (tot ? ': ne ho tolti ' + n + ' su ' + tot + '. Riprova.' : '.'), true);
    }
    SD.busy = false; refreshAll();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), act = b && b.dataset.act;
    if (!act) return;
    if (act === 'run-del') { SD.one = SD.one === b.dataset.run ? null : b.dataset.run; SD.all = false; paintRuns(); }
    else if (act === 'run-del-no') { SD.one = null; paintRuns(); }
    else if (act === 'run-del-only') deleteRun(b.dataset.run, false);
    else if (act === 'run-del-undo') deleteRun(b.dataset.run, true);
    else if (act === 'runs-clear') { SD.all = true; SD.one = null; paintRuns(); }
    else if (act === 'runs-clear-no') { SD.all = false; paintRuns(); }
    else if (act === 'runs-clear-ok') clearRuns();
  });


  /* =====================================================================
     MATRICOLE: modifica visibile (anche il codice) ed eliminazione
     - sotto ogni scheda: "Modifica" e "Elimina…"
     - cambiando il codice si aggiornano ordini, collaudi e storico collegati
     - eliminando: conferma con l'elenco di cosa è collegato; in alternativa si può nascondere
     ===================================================================== */
  const MD = { mat: null, nOrd: 0, nEv: 0, nRun: 0, busy: false };

  function pickHtml(m, act, on) {
    const h = pickHtmlBase(m, act, on);
    if (act !== 'edit-mat') return h;
    return '<div class="pickwrap">' + h + '<div class="pickact"><button type="button" class="btn small" data-act="edit-mat" data-mat="' + esc(m) + '">Modifica</button>' +
      '<button type="button" class="btn small ghost danger" data-act="del-mat" data-mat="' + esc(m) + '">Elimina…</button></div></div>';
  }

  /* La conferma sta nel modulo di modifica se quella matricola è aperta, altrimenti sopra l'elenco. */
  function matDelBarHtml(where) {
    if (!MD.mat) return '';
    const inEditor = !!state.edit && state.edit.mat === MD.mat;
    if ((where === 'editor') !== inEditor) return '';
    const r = rec(MD.mat) || {}, linked = MD.nOrd + MD.nEv > 0, dis = MD.busy ? ' disabled' : '';
    const bits = [];
    if (MD.nOrd) bits.push(plural(MD.nOrd, 'ordine', 'ordini'));
    if (MD.nEv) bits.push(plural(MD.nEv, 'collaudo', 'collaudi') + ' in calendario');
    let t = '<b>Eliminare la matricola <span class="mono">' + esc(MD.mat) + '</span>?</b> Sparisce dall’anagrafica con i suoi numeri (ultimo seriale <span class="mono">' + (isInt(r.last) ? nf.format(r.last) : '—') +
      '</span>, ultimo pianale <span class="mono">' + (isInt(r.lastPallet) ? nf.format(r.lastPallet) : '—') + '</span>). Se la rifai dopo, la numerazione riparte da dove la imposti: attenzione a non ripetere seriali già usati.';
    if (linked) t += ' Collegati a questa matricola: ' + bits.join(' e ') + '.';
    if (MD.nRun) t += ' I ' + plural(MD.nRun, 'lotto', 'lotti') + ' dello storico restano (li togli dallo Storico).';
    return '<div class="banner matbar" id="matBar"><span>' + t + '</span><span class="row">' +
      (linked ? '<button type="button" class="btn small" data-act="del-mat-ok" data-all="1"' + dis + '>Elimina matricola' + (MD.nOrd && MD.nEv ? ', ordini e collaudi' : MD.nOrd ? ' e ordini' : ' e collaudi') + '</button>' +
        (r.archived ? '' : '<button type="button" class="btn small" data-act="del-mat-hide"' + dis + '>Nascondila soltanto</button>')
        : '<button type="button" class="btn small" data-act="del-mat-ok"' + dis + '>Elimina la matricola</button>') +
      '<button type="button" class="btn ghost small" data-act="del-mat-no">Annulla</button></span></div>';
  }

  function repaintMat() { renderEditor(); paintMatGrid(); const bar = $('#matBar'); if (bar) bar.scrollIntoView({ block: 'nearest' }); }

  async function askDelMat(m) {
    if (MD.mat === m) { MD.mat = null; repaintMat(); return; }
    syncDraft();
    let runs = state.db.runs.filter((r) => (r.lines || []).some((l) => l.matricola === m)).length;
    try { if (dbh) { const s = await dbh.collection('runs').get(); runs = s.docs.filter((d) => ((d.data() || {}).lines || []).some((l) => l.matricola === m)).length; } } catch (e) { /* resta il conteggio dell'elenco */ }
    Object.assign(MD, { mat: m, busy: false, nOrd: state.db.orders.filter((o) => o.matricola === m).length, nEv: state.db.events.filter((e) => e.matricola === m).length, nRun: runs });
    repaintMat();
  }

  async function doDelMat(withLinked) {
    const m = MD.mat;
    if (!m || MD.busy) return;
    if (!dbh) { MD.mat = null; repaintMat(); return notice('warn', 'Per eliminare una matricola servono i dati collegati.', true); }
    MD.busy = true; repaintMat();
    try {
      const nO = MD.nOrd, nE = MD.nEv;
      if (withLinked) {
        const evs = state.db.events.filter((e) => e.matricola === m), ids = new Set(evs.map((e) => e.id));
        for (const ev of evs) await dropDoc('events', ev.id);
        for (const o of state.db.orders.filter((x) => x.matricola === m)) await dropDoc('orders', o.id);
        $('#toasts').querySelectorAll('.toast').forEach((t) => { if (ids.has(t.dataset.id)) t.remove(); });
        if (state.cal.panel && (ids.has(state.cal.panel.id) || ids.has(state.cal.panel.eventId))) state.cal.panel = null;
      }
      await dbh.doc('serials/' + m).delete();
      delete state.db.serials[m];
      state.lines = state.lines.filter((l) => l.matricola !== m);
      if (state.edit && state.edit.mat === m) state.edit = null;
      MD.mat = null;
      notice('ok', 'Matricola ' + m + ' eliminata' + (withLinked && (nO || nE) ? ' con ' + [nO ? plural(nO, 'ordine', 'ordini') : '', nE ? plural(nE, 'collaudo', 'collaudi') : ''].filter(Boolean).join(' e ') : '') + '.');
    } catch (e) { notice('bad', 'Non sono riuscito a eliminare la matricola' + errText(e) + '. Controlla l’elenco prima di riprovare.', true); }
    MD.busy = false; renderLines(); refreshAll(); renderEditor();
  }

  async function hideMat() {
    const m = MD.mat, r = rec(m);
    if (!m || !r || MD.busy) return;
    MD.mat = null;
    await writeDoc('serials/' + m, Object.assign({}, r, { archived: true, updatedAt: new Date().toISOString() }), 'Matricola ' + m + ' nascosta dalle scelte del lotto: la ritrovi qui in Matricole.');
    renderEditor(); refreshAll();
  }

  /* Cambio del codice: anche ordini, collaudi e storico passano al nuovo codice, poi si toglie il vecchio. */
  async function migrateMat(from, to) {
    const stamp = new Date().toISOString();
    state.lines.forEach((l) => { if (l.matricola === from) l.matricola = to; });
    let nO = 0, nE = 0, nR = 0;
    try {
      for (const o of state.db.orders.filter((x) => x.matricola === from)) { await patchDoc('orders', o.id, { matricola: to, updatedAt: stamp }); nO++; }
      for (const ev of state.db.events.filter((x) => x.matricola === from)) { await patchDoc('events', ev.id, { matricola: to, updatedAt: stamp }); nE++; }
      const snap = await dbh.collection('runs').get();
      for (const d of snap.docs) {
        const r = d.data() || {};
        if (!(r.lines || []).some((l) => l.matricola === from)) continue;
        await dbh.doc('runs/' + d.id).update({ lines: r.lines.map((l) => l.matricola === from ? Object.assign({}, l, { matricola: to }) : l) }); nR++;
      }
      await dbh.doc('serials/' + from).delete();
      delete state.db.serials[from];
      const bits = [nO ? plural(nO, 'ordine', 'ordini') : '', nE ? plural(nE, 'collaudo', 'collaudi') : '', nR ? plural(nR, 'lotto', 'lotti') + ' nello storico' : ''].filter(Boolean);
      notice('ok', 'Matricola ' + from + ' cambiata in ' + to + (bits.length ? ' (aggiornati: ' + bits.join(', ') + ')' : '') + '.');
    } catch (e) {
      notice('bad', 'La nuova matricola ' + to + ' è stata creata, ma non sono riuscito ad aggiornare tutto' + errText(e) + '. La vecchia ' + from + ' è ancora in elenco: controlla ordini e storico prima di eliminarla.', true);
    }
    renderLines(); refreshAll();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), act = b && b.dataset.act;
    if (!act) return;
    if (act === 'del-mat') askDelMat(b.dataset.mat);
    else if (act === 'del-mat-no') { MD.mat = null; repaintMat(); }
    else if (act === 'del-mat-ok') doDelMat(!!b.dataset.all);
    else if (act === 'del-mat-hide') hideMat();
  });


  /* =====================================================================
     LETTORE PDF DEGLI ORDINI (OdA formato A, distributore di energia)
     - pdf.js è incorporato nella versione locale, compresso: si apre solo al primo uso
     - dal testo ricostruisco le righe e riconosco testata e posizioni dell'ordine
     ===================================================================== */
  const PDFR = (() => {
    let libP = null;
    const available = () => !!document.getElementById('pdfjs-main') && !!document.getElementById('pdfjs-worker') && typeof DecompressionStream === 'function';
    async function unpack(id) {
      const el = document.getElementById(id);
      let bin;
      if (el.dataset.src) {   /* versione online: il lettore sta in un file a parte, scaricato solo al primo PDF */
        const r = await fetch(el.dataset.src);
        if (!r.ok) throw new Error('lettore PDF non scaricato (' + r.status + ')');
        bin = new Uint8Array(await r.arrayBuffer());
      } else bin = Uint8Array.from(atob(el.textContent.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      return new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    function runScript(code) {
      return new Promise((res, rej) => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const s = document.createElement('script');
        s.src = url; s.onload = () => { URL.revokeObjectURL(url); res(); }; s.onerror = () => { URL.revokeObjectURL(url); rej(new Error('lettore PDF non avviabile')); };
        document.head.appendChild(s);
      });
    }
    function load() {
      if (!libP) {
        libP = (async () => {
          const [main, worker] = await Promise.all([unpack('pdfjs-main'), unpack('pdfjs-worker')]);
          /* il "worker" gira nella pagina stessa: niente file esterni, funziona anche aprendo l'HTML dal disco */
          await runScript(worker);
          const wk = globalThis['pdfjs-dist/build/pdf.worker'];
          if (!wk || !wk.WorkerMessageHandler) throw new Error('lettore PDF incompleto');
          globalThis.pdfjsWorker = wk;
          await runScript(main);
          const lib = globalThis['pdfjs-dist/build/pdf'];
          if (!lib || !lib.getDocument) throw new Error('lettore PDF incompleto');
          lib.GlobalWorkerOptions.workerSrc = 'pdf.worker.js';
          return lib;
        })();
        libP.catch(() => { libP = null; });
      }
      return libP;
    }

    /* Righe di testo, pagina per pagina, dall'alto in basso e da sinistra a destra */
    async function readLines(buf) {
      const lib = await load();
      const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
      const out = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p), tc = await page.getTextContent();
        const items = tc.items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '')
          .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 8 }));
        items.sort((a, b) => b.y - a.y || a.x - b.x);
        const rows = [];
        items.forEach((it) => {
          let r = null;
          for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) if (Math.abs(rows[k].y - it.y) <= Math.max(1.5, it.h * 0.3)) { r = rows[k]; break; }
          if (!r) { r = { y: it.y, items: [] }; rows.push(r); }
          r.items.push(it);
        });
        rows.forEach((r) => {
          r.items.sort((a, b) => a.x - b.x);
          let s = '', end = null;
          r.items.forEach((it) => {
            if (end !== null) { const gap = it.x - end; if (gap > it.h * 0.18) s += gap > it.h * 1.2 ? '   ' : ' '; }
            s += it.s; end = it.x + it.w;
          });
          out.push({ page: p, text: s.replace(/\s+$/, '') });
        });
        page.cleanup();
      }
      await doc.destroy();
      return out;
    }


    const toYmd = (s) => { const m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/.exec(s || ''); if (!m) return ''; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); };
    function qtyOf(s) {
      const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/.exec(s || ''); if (!m) return null;
      if (m[2] && /[1-9]/.test(m[2])) return null;              /* decimali veri: non è un numero di pezzi */
      return parseInt(m[1].replace(/\./g, ''), 10);
    }
    const NOISE = [/^_{4,}$/, /^Pag\.?$/i, /^\d+\s*\/\s*\d+$/, /^Pag\.?\s*\d+\s*\/\s*\d+$/i, /^DESCRIZIONE MATERIALI/i, /^Allegato Ordine/i, /^Pos\.?\s+Cod/i];
    const STOP = [/IMPORTO COMPLESSIVO/i, /^Nota$/i, /^Inviare fattura/i];
    const POS = /^(\d{4,6})\s+(\d{5,8})\s+(?:([A-Z][A-Z0-9]{2,4})\s+)?(?:(\d{3,4})\s+)?([A-Za-z]{1,4})\s+(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})\b/;
    const CAPLINE = /^(\d{5})\s+(.+?)\s+([A-Z]{2})$/;

    function cleanDesc(s) { return String(s || '').replace(/\s+ed\.?(\s.*)?$/i, '').replace(/\s+/g, ' ').trim(); }

    /* OdA formato B: "0010" sopra la riga "1234567 DESCRIZIONE N. 50 16/11/2026 EUR ...", consegna unica dalla "Resa" */
    function parseFormatoB(T, res) {
      const all = T.join('\n'), flat = T.join(' ');
      for (const t of T) { const m = /^(\d{8,12})\s*\/\s*([A-Z0-9]{1,6})\b(?:\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/.exec(t); if (m) { res.oda = m[1]; res.odaSuffix = m[2]; if (m[3]) res.issued = toYmd(m[3]); break; } }
      const cm = /CONVENZIONE[^\n]*\n\s*(\d{8,12})\s*\//i.exec(all); if (cm) res.contract = cm[1];
      if (/cliente b/i.test(all)) res.client = 'Cliente B';
      const rm = /franco\s+(magazzino\s+[a-zà-ú]+)\s*,\s*(via\s+[^,]+?)\s*,\s*([A-Za-zÀ-ú' ]+?)\s+di\s+/i.exec(flat);
      const city = rm ? rm[3].trim() : '';
      const dest = rm ? { name: rm[1].charAt(0).toUpperCase() + rm[1].slice(1).toLowerCase() + ' ' + city, street: rm[2].trim(), cap: '', city: city, prov: '' } : { name: res.client || 'Consegna', street: '', cap: '', city: '', prov: '' };
      const ROW = /^(?:(\d{4})\s+)?(\d{5,10})\s+(.+?)\s+([A-Za-z]{1,3}\.?)\s+(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s+(\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4})\s+EUR\b/;
      let lastPos = '';
      T.forEach((t) => {
        if (/^\d{4}$/.test(t)) { lastPos = t; return; }
        const m = ROW.exec(t); if (!m) return;
        const pos = m[1] || lastPos || String((res.positions.length + 1) * 10).padStart(4, '0'); lastPos = '';
        const qtyRaw = m[5] + (m[6] ? ',' + m[6] : ''), qty = qtyOf(qtyRaw);
        if (qty == null) res.warnings.push('Posizione ' + pos + ': quantità “' + qtyRaw + '” non intera.');
        res.positions.push({ pos: pos, mat: m[2], div: '', mag: '', um: m[4], qtyRaw: qtyRaw, qty: qty, due: toYmd(m[7]), desc: m[3].trim(), dest: Object.assign({}, dest) });
      });
      if (res.positions.length && !rm) res.warnings.push('Non trovo il luogo di consegna nella “Resa”: scegli tu la destinazione.');
      if (res.odaSuffix) res.note = 'OdA ' + res.oda + '/' + res.odaSuffix + (res.client ? ' · ' + res.client : '');
    }

    function parse(lines) {
      const T = lines.map((l) => String(l.text || '').replace(/\s+/g, ' ').trim());
      const all = T.join('\n');
      const pick = (re) => { const m = re.exec(all); return m ? m[1] : ''; };
      const res = {
        oda: pick(/Ordine\s+N\.?\s*:?\s*(\d{8,12})\b/i), issued: toYmd(pick(/Data\s+Emissione\s*:?\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})/i)),
        contract: pick(/Contratto\s+N\.?\s*:?\s*([A-Z0-9]{5,})/i), cig: pick(/\bCIG\s*:?\s*([A-Z0-9]{10})\b/i),
        client: /cliente a/i.test(all) ? 'Cliente A' : '', positions: [], warnings: []
      };
      const posIdx = [];
      T.forEach((t, i) => { if (POS.test(t)) posIdx.push(i); });
      posIdx.forEach((i, k) => {
        const m = POS.exec(T[i]);
        const blk = [];
        for (let j = i + 1; j < (k + 1 < posIdx.length ? posIdx[k + 1] : T.length); j++) {
          const t = T[j]; if (!t) continue;
          if (STOP.some((re) => re.test(t))) break;
          if (NOISE.some((re) => re.test(t))) continue;
          blk.push(t);
        }
        let a = -1;
        for (let j = blk.length - 1; j >= 0; j--) if (CAPLINE.test(blk[j])) { a = j; break; }
        const dest = { name: '', street: '', cap: '', city: '', prov: '' };
        let descEnd = blk.length;
        if (a >= 2) {
          const cm = CAPLINE.exec(blk[a]);
          dest.cap = cm[1]; dest.city = cm[2].split('#')[0].trim(); dest.prov = cm[3];
          dest.street = blk[a - 1]; dest.name = blk[a - 2];
          descEnd = a - 2;
          if (descEnd >= 1 && blk[descEnd - 1] === dest.name) descEnd--;
        } else {
          const n = blk.findIndex((t) => /^(Piattaforma|Magazzino|Deposito|Polo|Centro)\b/i.test(t));
          if (n >= 0) { dest.name = blk[n]; descEnd = n; }
        }
        const qty = qtyOf(m[6]);
        if (qty == null) res.warnings.push('Posizione ' + m[1] + ': quantità “' + m[6] + '” non intera.');
        if (!dest.name) res.warnings.push('Posizione ' + m[1] + ': non trovo la destinazione.');
        res.positions.push({ pos: m[1], mat: m[2], div: m[3] || '', mag: m[4] || '', um: m[5], qtyRaw: m[6], qty: qty, due: toYmd(m[7]), desc: cleanDesc(blk.slice(0, Math.max(1, Math.min(descEnd, 1))).join(' ')), dest: dest });
      });
      if (!res.positions.length) parseFormatoB(T, res);
      if (!res.positions.length) res.warnings.push(T.join('').length < 20 ? 'Il PDF non contiene testo leggibile: sembra una scansione o un’immagine.' : 'Non ho trovato righe d’ordine (posizione, codice materiale, quantità, data di consegna).');
      return res;
    }

    return { available, load, readLines, parse, toYmd, qtyOf };
  })();


  /* =====================================================================
     ORDINI DA PDF: anteprima da controllare, niente creato di testa propria
     - matricola assente → si suggerisce di crearla (modulo precompilato), poi "Rileggi il PDF"
     - destinazione assente → aggiungerla alla matricola o collegarla a una esistente (scelta tua, ricordata)
     - abbinamento automatico solo se nome della piattaforma o città coincidono con una destinazione della matricola
     ===================================================================== */
  const OP = { name: '', buf: null, lines: [], parsed: null, alias: {}, drafts: [], busy: false, err: '' };
  const opNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const opBase = (n) => opNorm(n).replace(/^(piattaforma|magazzino|deposito|polo logistico|polo|centro)\s+/, '');
  const opTitle = (s) => s.split(' ').filter(Boolean).map((w) => w.length <= 2 && /^[a-z]{2}$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const ymdIt = (s) => isYmd(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';

  /* destinazione della matricola per una piattaforma del PDF: { name, how } oppure null */
  function opResolve(mat, row) {
    const dests = destList(rec(mat));
    const find = (n) => dests.find((d) => opNorm(d) === opNorm(n)) || null;
    const a = OP.alias[row.key];
    if (a && find(a)) return { name: find(a), how: 'collegata da te' };
    const base = opBase(row.pdfName);
    let hit = find(base);
    if (hit) return { name: hit, how: 'stesso nome' };
    if (row.city) { hit = find(row.city); if (hit) return { name: hit, how: 'stessa città (' + opTitle(opNorm(row.city)) + ')' }; }
    return null;
  }
  const opSuggest = (row) => OP.alias[row.key] || (row.city ? opTitle(opNorm(row.city)) : '') || opTitle(opBase(row.pdfName).replace(/\s+[a-z]{2}$/, ''));

  function opBuild(parsed) {
    const by = new Map();
    parsed.positions.forEach((p) => {
      let d = by.get(p.mat);
      if (!d) { d = { mat: p.mat, desc: p.desc, note: parsed.note || '', rows: [], include: true }; by.set(p.mat, d); }
      d.rows.push({ key: opNorm(p.dest.name || p.dest.city), pdfName: p.dest.name || p.dest.city || '?', city: p.dest.city, prov: p.dest.prov,
        qty: p.qty == null ? 0 : p.qty, bad: p.qty == null, pos: [p.pos], pdfDue: p.due || '', due: p.due || '' });
    });
    return Array.from(by.values());
  }
  /* ordini che nascono da una matricola del PDF: uno per scadenza di consegna */
  const opDupeDue = (d, due) => state.db.orders.find((o) => o.oda === OP.oda && o.matricola === d.mat && (o.due || '') === (due || '')) || null;
  function opGroups(d) {
    const m = new Map();
    d.rows.forEach((r) => { const k = isYmd(r.due) ? r.due : ''; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return Array.from(m, ([due, rows]) => ({ due: due, rows: rows, dupe: opDupeDue(d, due) })).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  }
  const opDupe = (d) => { const g = opGroups(d); return g.length && g.every((x) => x.dupe) ? g[0].dupe : null; };

  /* stato di ogni bozza: pronta oppure cosa manca */
  function opStatus(d) {
    if (!rec(d.mat)) return { ready: false, why: 'matricola' };
    if (opDupe(d)) return { ready: false, why: 'dupe' };
    if (!/^\d+$/.test(OP.oda || '')) return { ready: false, why: 'oda' };
    const miss = d.rows.filter((r) => !opResolve(d.mat, r)), bad = d.rows.filter((r) => r.bad);
    if (bad.length) return { ready: false, why: 'qty', rows: bad };
    if (miss.length) return { ready: false, why: 'dest', rows: miss };
    return { ready: true };
  }

  async function opRead(file) {
    if (!PDFR.available()) return notice('warn', 'Il lettore PDF c’è solo nella versione da usare sul computer (il file HTML).', true);
    OP.busy = true; OP.err = ''; OP.name = file ? file.name : OP.name; opPaint(true);
    $('#pdfReview').scrollIntoView({ block: 'start' });
    try {
      if (file) OP.buf = await file.arrayBuffer();
      OP.lines = await PDFR.readLines(OP.buf.slice(0));
      OP.parsed = PDFR.parse(OP.lines);
      OP.oda = OP.parsed.oda;
      try { if (dbh) { const s = await dbh.doc('meta/destAlias').get(); OP.alias = s.exists ? Object.assign({}, (s.data() || {}).map || {}) : {}; } } catch (e) { /* senza collegamenti salvati */ }
      const prev = OP.drafts;
      OP.drafts = opBuild(OP.parsed);
      OP.drafts.forEach((d) => { const o = prev.find((x) => x.mat === d.mat); if (o) { d.note = o.note; d.include = o.include; d.rows.forEach((r) => { const q = o.rows.find((x) => x.pos[0] === r.pos[0]); if (q && q.dueTouched) { r.due = q.due; r.dueTouched = true; } }); } });
    } catch (e) { OP.parsed = null; OP.err = 'Non sono riuscito a leggere il PDF' + errText(e) + '.'; }
    OP.busy = false; opPaint(true);
  }

  function opRowHtml(d, r, i, j) {
    const res = rec(d.mat) ? opResolve(d.mat, r) : null;
    const src = '<b>Pos. ' + esc(r.pos.join(', ')) + '</b> · ' + esc(r.pdfName) + '<span class="meta">' + esc([r.city, r.prov].filter(Boolean).join(' ')) + '</span>';
    let dst;
    if (!rec(d.mat)) dst = '<span class="meta">—</span>';
    else if (res) dst = '<b>' + esc(res.name) + '</b><span class="meta">' + esc(res.how) + '</span>';
    else {
      const ds = destList(rec(d.mat));
      dst = '<span class="tagw">Manca</span>' +
        '<div class="opfix"><input type="text" data-opnew="' + i + ':' + j + '" aria-label="Nome della nuova destinazione" value="' + esc(r.newName != null ? r.newName : opSuggest(r)) + '">' +
        '<button type="button" class="btn small" data-act="op-adddest" data-k="' + i + ':' + j + '">Aggiungi a ' + esc(d.mat) + '</button></div>' +
        (ds.length ? '<div class="opfix"><select data-oplink="' + i + ':' + j + '" aria-label="Collega a una destinazione esistente"><option value="">…oppure è una di queste?</option>' +
          ds.map((n) => '<option>' + esc(n) + '</option>').join('') + '</select></div>' : '');
    }
    const due = '<input type="date" data-oprowdue="' + i + ':' + j + '" aria-label="Scadenza di consegna della posizione ' + esc(r.pos.join(', ')) + '" value="' + esc(r.due) + '">' +
      (r.pdfDue && r.due !== r.pdfDue ? '<span class="meta">nel PDF ' + esc(ymdIt(r.pdfDue)) + '</span>' : '') + (rec(d.mat) && opDupeDue(d, r.due) ? '<span class="tagw">ordine già creato</span>' : '');
    return '<tr><td>' + src + '</td><td>' + dst + '</td><td class="r num">' + (r.bad ? '<span class="tagw">?</span>' : nf.format(r.qty)) + '</td><td>' + due + '</td></tr>';
  }

  function opDraftHtml(d, i) {
    const r = rec(d.mat), st = opStatus(d), dupe = opDupe(d);
    const tot = sumOf(d.rows.map((x) => x.qty));
    let head = '<div class="ophead"><span class="ic sm">' + ICON + '</span><div><h3>Matricola <span class="mono">' + esc(d.mat) + '</span> · ' + plural(tot, 'pezzo', 'pezzi') + '</h3><p class="sub">' + esc((r && r.descrizione) || d.desc || '') + '</p></div></div>';
    let body = '';
    if (!r) {
      body = '<div class="banner"><span><b>La matricola ' + esc(d.mat) + ' non è in anagrafica.</b> Creala tu (ti preparo il modulo con codice e descrizione del PDF: controlla pezzi per pallet e ultimi numeri), poi premi “Rileggi il PDF”.</span>' +
        '<span class="row"><button type="button" class="btn small" data-act="op-newmat" data-i="' + i + '">Crea la matricola ' + esc(d.mat) + '…</button></span></div>';
    } else if (dupe) {
      body = '<div class="banner"><span>Esiste già l’ordine <span class="mono">' + esc(OP.oda) + '</span> per la matricola ' + esc(d.mat) + ': non lo creo di nuovo. Se va cambiato, aprilo dall’elenco degli ordini.</span></div>';
    }
    const gs = r ? opGroups(d) : [], todo = gs.filter((g) => !g.dupe);
    const fields = r && !dupe ? '<p class="summary">' + (todo.length === 1 ? 'Creo 1 ordine' : 'Creo ' + todo.length + ' ordini, uno per scadenza') + ': ' +
      gs.map((g) => (g.due ? 'consegna ' + ymdIt(g.due) : 'senza scadenza') + ' · ' + plural(sumOf(g.rows.map((x) => x.qty)), 'pezzo', 'pezzi') + (g.dupe ? ' (già creato)' : '')).join(' — ') + '</p>' +
      '<p class="hint" style="margin:0">Ogni posizione ha la sua scadenza di consegna: puoi cambiarla nella tabella. Le posizioni con la stessa scadenza vanno nello stesso ordine.</p>' +
      '<div class="grid g3"><div class="field span2"><label class="l" for="op-note-' + i + '">Note (facoltative)</label><input type="text" id="op-note-' + i + '" data-opnote="' + i + '" autocomplete="off" value="' + esc(d.note) + '"></div></div>' : '';
    const table = '<div class="scroll"><table class="optab"><thead><tr><th>Posizione nel PDF</th><th>Destinazione della matricola</th><th class="r">Pezzi</th><th>Scadenza di consegna</th></tr></thead><tbody>' +
      d.rows.map((x, j) => opRowHtml(d, x, i, j)).join('') + '</tbody></table></div>';
    let foot = '';
    if (r && !dupe) {
      if (st.ready) foot = '<label class="reuse"><input type="checkbox" data-opinc="' + i + '"' + (d.include ? ' checked' : '') + '> Crea questo ordine</label>';
      else if (st.why === 'dest') foot = '<p class="meta">' + (st.rows.length === 1 ? 'Manca 1 destinazione: aggiungila o collegala' : 'Mancano ' + st.rows.length + ' destinazioni: aggiungile o collegale') + ' qui sopra. L’ordine si crea quando sono tutte a posto.</p>';
      else if (st.why === 'qty') foot = '<p class="meta">Alcune quantità del PDF non sono numeri interi: controlla il PDF.</p>';
    }
    return '<div class="pdraft' + (st.ready ? ' ok' : '') + '">' + head + body + fields + table + foot + '</div>';
  }

  function opHtml() {
    if (OP.busy) return '<div class="sec-head"><div><h2>Leggo il PDF…</h2><p class="sub">' + esc(OP.name) + '</p></div></div><p class="empty">Un momento.</p>';
    const P = OP.parsed;
    const head = '<div class="sec-head"><div><h2>Ordine da PDF' + (P && P.oda ? ' · <span class="mono">' + esc(P.oda) + '</span>' : '') + '</h2><p class="sub">' + esc(OP.name) +
      (P && P.issued ? ' · emesso il ' + esc(ymdIt(P.issued)) : '') + (P && P.contract ? ' · contratto ' + esc(P.contract) : '') + '. Controlla e conferma: non salvo nulla finché non premi “Crea”.</p></div>' +
      '<div class="row" style="margin:0"><button type="button" class="btn small" data-act="op-reload"' + (OP.buf ? '' : ' disabled') + '>Rileggi il PDF</button><button type="button" class="btn ghost small" data-act="op-close">Chiudi</button></div></div>';
    if (OP.err || !P) return head + '<ul class="msgs"><li class="bad">' + esc(OP.err || 'PDF non letto.') + '</li></ul>';
    const ready = OP.drafts.filter((d) => opStatus(d).ready && d.include);
    const odaField = !P.oda || !/^\d+$/.test(OP.oda || '') ? '<div class="field" style="max-width:260px"><label class="l" for="op-oda">Ordine (ODA)</label><input type="text" id="op-oda" data-opoda="1" class="num" inputmode="numeric" value="' + esc(OP.oda || '') + '"><span class="hint">Non l’ho trovato nel PDF: scrivilo tu.</span></div>' : '';
    return head + odaField +
      (P.warnings.length ? '<ul class="msgs">' + P.warnings.map((w) => '<li class="warn">' + esc(w) + '</li>').join('') + '</ul>' : '') +
      OP.drafts.map(opDraftHtml).join('') +
      (OP.drafts.length ? '<div class="row"><button type="button" class="btn primary" data-act="op-create"' + (ready.length ? '' : ' disabled') + '>' +
        (ready.length ? (() => { const n = sumOf(ready.map((d) => opGroups(d).filter((g) => !g.dupe).length)); return 'Crea ' + (n === 1 ? 'l’ordine' : n + ' ordini'); })() : 'Niente da creare per ora') + '</button><button type="button" class="btn" data-act="op-close">Annulla</button>' +
        (ready.length && ready.length < OP.drafts.length ? '<span class="hint">Le altre matricole le crei dopo aver sistemato quello che manca e riletto il PDF.</span>' : '') + '</div>' : '') +
      '<details class="pane"><summary>Testo letto dal PDF</summary><pre class="optext">' + esc(OP.lines.map((l) => l.text).join('\n')) + '</pre></details>';
  }

  function opPaint(force) {
    const host = $('#pdfReview'); if (!host) return;
    const btn = $('#pdfOrderBtn'); if (btn) btn.hidden = !PDFR.available();
    const on = OP.busy || !!OP.parsed || !!OP.err;
    host.hidden = !on;
    if (!on) { host.innerHTML = ''; host._html = ''; return; }
    const a = document.activeElement;
    if (!force && a && host.contains(a) && a.matches('input,select,textarea')) return;
    setHtml(host, opHtml());
  }

  async function opSaveAlias(key, name) {
    OP.alias[key] = name;
    if (!dbh) return;
    try { await dbh.doc('meta/destAlias').set({ map: Object.assign({}, OP.alias), updatedAt: nowIso() }); } catch (e) { /* resta per questa lettura */ }
  }

  async function opCreate() {
    const ready = OP.drafts.filter((d) => opStatus(d).ready && d.include);
    if (!ready.length || OP.busy) return;
    OP.busy = true;
    const stamp = nowIso(), done = [];
    try {
      for (const d of ready) {
        for (const g of opGroups(d)) {
          if (g.dupe) continue;
          const sums = new Map();
          g.rows.forEach((r) => { const n = opResolve(d.mat, r).name; sums.set(n, (sums.get(n) || 0) + r.qty); });
          const lines = Array.from(sums, ([name, qty]) => ({ name: name, qty: qty }));
          await createDoc('orders', { createdAt: stamp, oda: OP.oda, matricola: d.mat, due: g.due, note: d.note.trim(), pos: g.rows.map((r) => r.pos[0]).filter(Boolean), lines: lines, updatedAt: stamp });
          done.push(d.mat + (g.due ? ' consegna ' + ymdIt(g.due) : '') + ': ' + plural(sumOf(lines.map((l) => l.qty)), 'pezzo', 'pezzi'));
        }
      }
    } catch (e) { notice('bad', 'Non sono riuscito a creare tutti gli ordini' + errText(e) + '.', true); }
    OP.busy = false;
    const left = OP.drafts.filter((d) => !opDupe(d)).length;
    if (!left) { OP.parsed = null; OP.err = ''; OP.drafts = []; OP.buf = null; }
    state.ord.filter = 'open'; refreshAll(); opPaint(true);
    if (done.length) notice('ok', 'Creat' + (done.length === 1 ? 'o 1 ordine' : 'i ' + done.length + ' ordini') + ' dall’OdA ' + OP.oda + ' (' + done.join('; ') + ').' + (left ? ' Restano matricole da sistemare: dopo, rileggi il PDF.' : ''));
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'), act = b && b.dataset.act;
    if (!act || act.indexOf('op-') !== 0 && act !== 'pdf-order') return;
    if (act === 'pdf-order') { const inp = $('#pdfOrderInput'); if (inp) { inp.value = ''; inp.click(); } }
    else if (act === 'op-close') { OP.parsed = null; OP.err = ''; OP.drafts = []; OP.buf = null; opPaint(true); }
    else if (act === 'op-reload' && OP.buf) opRead(null);
    else if (act === 'op-create') opCreate();
    else if (act === 'op-newmat') {
      const d = OP.drafts[Number(b.dataset.i)]; if (!d) return;
      openEditor(null);
      state.edit.f.mat = d.mat; state.edit.f.desc = d.desc || '';
      renderEditor();
      notice('warn', 'Completa la matricola ' + d.mat + ' e salvala, poi torna in Ordini e premi “Rileggi il PDF”.', true);
    } else if (act === 'op-adddest') {
      const [i, j] = b.dataset.k.split(':').map(Number), d = OP.drafts[i], r = d && d.rows[j];
      const inp = document.querySelector('[data-opnew="' + i + ':' + j + '"]'), name = (inp ? inp.value : '').trim();
      if (!d || !r || !rec(d.mat)) return;
      if (!name) return notice('bad', 'Scrivi il nome della destinazione da aggiungere.', true);
      const cur = rec(d.mat), list = destList(cur);
      const exists = list.find((n) => opNorm(n) === opNorm(name));
      if (!exists) {
        const ok = await writeDoc('serials/' + d.mat, Object.assign({}, cur, { destinations: list.concat([name]), updatedAt: nowIso() }), 'Destinazione ' + name + ' aggiunta alla matricola ' + d.mat + '.');
        if (!ok) return;
      }
      if (opNorm(name) !== opBase(r.pdfName) && opNorm(name) !== opNorm(r.city)) await opSaveAlias(r.key, exists || name);
      opPaint(true);
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'pdfOrderInput') { const f = t.files && t.files[0]; if (f) opRead(f); return; }
    if (t.dataset && t.dataset.oprowdue != null) { const [i, j] = t.dataset.oprowdue.split(':').map(Number), r = OP.drafts[i] && OP.drafts[i].rows[j]; if (r) { r.due = t.value; r.dueTouched = true; } opPaint(true); return; }
    if (t.dataset && t.dataset.oplink != null && t.value) {
      const [i, j] = t.dataset.oplink.split(':').map(Number), r = OP.drafts[i] && OP.drafts[i].rows[j];
      if (r) { await opSaveAlias(r.key, t.value); notice('ok', r.pdfName + ' collegata a ' + t.value + ': lo ricordo per i prossimi PDF.'); opPaint(true); }
    } else if (t.dataset && t.dataset.opinc != null) { const d = OP.drafts[Number(t.dataset.opinc)]; if (d) { d.include = t.checked; opPaint(true); } }
  });
  document.addEventListener('input', (e) => {
    const t = e.target; if (!t.dataset) return;
    if (t.dataset.opdue != null) { const d = OP.drafts[Number(t.dataset.opdue)]; if (d) { d.due = t.value; d.dueTouched = true; } }
    else if (t.dataset.opnote != null) { const d = OP.drafts[Number(t.dataset.opnote)]; if (d) d.note = t.value; }
    else if (t.dataset.oprowdue != null) { const [i, j] = t.dataset.oprowdue.split(':').map(Number), r = OP.drafts[i] && OP.drafts[i].rows[j]; if (r) { r.due = t.value; r.dueTouched = true; } }
    else if (t.dataset.opnew != null) { const [i, j] = t.dataset.opnew.split(':').map(Number), r = OP.drafts[i] && OP.drafts[i].rows[j]; if (r) r.newName = t.value; }
    else if (t.dataset.opoda != null) { OP.oda = t.value.trim(); }
  });
  document.addEventListener('focusout', (e) => { if (e.target && e.target.dataset && e.target.dataset.opoda != null) opPaint(true); });
  /* trascinare un PDF sulla sezione Ordini */
  document.addEventListener('dragover', (e) => { if (state.view === 'ordini' && PDFR.available() && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (state.view !== 'ordini' || !PDFR.available()) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return; e.preventDefault();
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return notice('bad', 'Trascina un file PDF.', true);
    opRead(f);
  });

  /* =====================================================================
     ECOSISTEMA CON LA GESTIONE PRODUZIONE
     Legge produzione.json dalla stessa cartella (o caricato a mano), stima quando
     i pezzi di ogni collaudo saranno pronti e suggerisce data e postazioni.
     ===================================================================== */
  const ecoInput = () => ({ prod: ECO.prod, cfg: ECO.cfg, col: { serials: state.db.serials, orders: state.db.orders, events: state.db.events, cfg: ECO.cfg } });
  function ecoCompute() { try { ECO.m = ECO.prod ? Eco.compute(ecoInput()) : null; } catch (e) { ECO.m = null; ECO.err = 'Errore nel calcolo: ' + e.message; } }
  const ecoRisk = (id) => !!(ECO.m && ECO.m.lots[id] && ECO.m.lots[id].status === 'rischio');
  const ecoPostOk = (v) => { const t = String(v == null ? '' : v).trim(); return /^\d+$/.test(t) && +t >= 1 && +t <= 50; };
  const ecoPlanData = (P) => ({ postazioni: ecoPostOk(P.post) ? +String(P.post).trim() : null, operatore: String(P.op || '').trim().slice(0, 80), avviso: String(P.avv || '').trim().slice(0, 30) });

  async function ecoLoad() {
    const ld = window.__localDb;
    if (ld) {
      const r = await ld.readFile('produzione.json');
      if (r.ok) {
        try { ECO.prod = Eco.fromProdFile(JSON.parse(r.text)); ECO.src = 'cartella'; ECO.at = new Date(); ECO.fileAt = r.at ? new Date(r.at) : null; ECO.err = ''; }
        catch (e) { ECO.err = 'produzione.json non è leggibile: ' + e.message; }
      } else if (ECO.src !== 'file') {
        ECO.prod = null;
        ECO.err = r.why === 'missing' ? 'Nella cartella collegata non c’è produzione.json: in Gestione Produzione collega questa stessa cartella (pulsante “Collega cartella”).'
          : r.why === 'nodir' ? 'Collega la cartella dei dati (icona della cartella in alto): deve essere la stessa usata da Gestione Produzione. In alternativa carica produzione.json a mano.'
          : r.why === 'perm' ? 'Consenti di nuovo l’accesso alla cartella per leggere produzione.json.'
          : 'Non riesco a leggere produzione.json' + (r.msg ? ' (' + r.msg + ')' : '') + '.';
      }
    } else if (!ECO.prod) ECO.err = 'Qui la cartella non è disponibile: carica a mano il file produzione.json della Gestione Produzione.';
    refreshAll();
  }

  function paintEco() {
    const m = ECO.m, bd = $('#ecoBadge');
    if (bd) { const n = m ? m.risk : 0; bd.hidden = !n; bd.textContent = String(n); bd.setAttribute('aria-label', n + (n === 1 ? ' collaudo a rischio' : ' collaudi a rischio')); }
    const src = $('#ecoSrc'), host = $('#ecoHost'), cfgHost = $('#ecoCfg');
    if (!src || !host) return;
    const t = (d) => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    if (ECO.prod) {
      const nr = ECO.prod.registrazioni.length, nRit = ECO.prod.prodotti.filter((p) => Number(p.ritmo) > 0).length;
      setHtml(src, '<p class="meta"><span class="okdot" aria-hidden="true"></span>Turni letti ' + (ECO.src === 'file' ? 'dal file caricato' : window.__localDb && window.__localDb.cloud ? 'dal database della produzione' : 'da produzione.json') + ' alle ' + t(ECO.at) +
        (ECO.fileAt ? ' · file aggiornato il ' + esc(ECO.fileAt.toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })) : '') + ' · ' + plural(nr, 'registrazione', 'registrazioni') + ' · ' + plural(nRit, 'prodotto con ritmo', 'prodotti con ritmo') + '</p>' +
        (ECO.err ? '<ul class="msgs"><li class="warn">' + esc(ECO.err) + '</li></ul>' : ''));
    } else setHtml(src, '<ul class="msgs"><li class="warn">' + esc(ECO.err || 'Leggo i turni della produzione…') + '</li></ul>');
    setHtml(host, m ? Eco.dashboard(m, { portal: true }) : (ECO.prod ? '' : '<p class="empty">Le stime compaiono quando i turni della produzione sono disponibili.</p>'));
    if (cfgHost) {
      const a = document.activeElement;
      if (!(a && cfgHost.contains(a) && a.matches('input'))) {
        const c = ECO.cfg || {};
        setHtml(cfgHost, '<div class="grid g3"><div class="field"><label class="l" for="eco-margine">Margine di sicurezza (giorni lavorativi)</label><input type="text" class="num" id="eco-margine" inputmode="numeric" autocomplete="off" placeholder="0" value="' + esc(c.margine || '') + '"><span class="hint">Aggiunto alla data suggerita.</span></div>' +
          '<div class="field"><label class="l" for="eco-dal">Conta i pezzi registrati dal</label><input type="date" id="eco-dal" value="' + esc(Eco.isYmd(c.contaDal) ? c.contaDal : '') + '"><span class="hint">Vuoto = dall’ultimo collaudo passato o dall’inserimento dell’ordine.</span></div></div>' +
          '<div class="row"><button type="button" class="btn primary small" data-act="eco-cfg-save">Salva impostazioni</button><span class="fstat">' + esc(ECO.msg) + '</span></div>' +
          '<p class="hint">Il ritmo, le postazioni normali e la matricola di ogni prodotto si impostano in Gestione Produzione › Anagrafiche › Prodotti. Giorni lavorativi: lunedì–venerdì, festività nazionali escluse.</p>');
      }
    }
  }

  async function ecoSaveCfg() {
    const mg = String(($('#eco-margine') || {}).value || '').trim(), dal = String(($('#eco-dal') || {}).value || '').trim();
    if (mg && !(/^\d+$/.test(mg) && +mg <= 30)) { ECO.msg = 'Il margine deve essere un numero intero da 0 a 30.'; paintEco(); return; }
    if (dal && !Eco.isYmd(dal)) { ECO.msg = 'La data non è valida.'; paintEco(); return; }
    const next = { margine: mg ? +mg : 0, contaDal: dal, updatedAt: nowIso() };
    try { if (dbh) await dbh.doc('meta/eco').set(next); ECO.cfg = next; ECO.msg = dbh ? 'Salvate.' : 'Valide solo per questa sessione: i dati non sono collegati.'; }
    catch (e) { ECO.msg = 'Non salvate' + errText(e) + '.'; }
    const el = document.activeElement; if (el && el.blur) el.blur();
    refreshAll();
  }

  function ecoPlanFields(P, o) {
    const p = ECO.prod ? Eco.productFor(ECO.prod, o.matricola, (rec(o.matricola) || {}).prodotto) : null, rate = Eco.rateOf(p), def = rate ? rate.post : 1;
    const ops = ECO.prod ? ECO.prod.operatori.filter((x) => x && x.reparto !== 'stampaggio').map((x) => (String(x.a || '') + ' ' + String(x.b || '')).trim()).filter(Boolean) : [];
    return '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="field"><label class="l" for="pl-post">Postazioni</label><input type="text" class="num" id="pl-post" data-pf="post" inputmode="numeric" autocomplete="off" placeholder="' + def + '" value="' + esc(P.post || '') + '"><span class="hint">Vuoto = ' + def + ', le normali del prodotto</span></div>' +
      '<div class="field"><label class="l" for="pl-avv">N. avviso (per il CSV)</label><input type="text" class="num" id="pl-avv" data-pf="avv" autocomplete="off" spellcheck="false" placeholder="es. 036" value="' + esc(P.avv || '') + '"><span class="hint">Serve per creare i file.</span></div>' +
      '<div class="field span2"><label class="l" for="pl-op">Operatore (nota per te)</label><input type="text" id="pl-op" data-pf="op" list="ecoOps" autocomplete="off" placeholder="es. Mario" value="' + esc(P.op || '') + '"><datalist id="ecoOps">' + ops.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist><span class="hint">Non entra nel calcolo e l’operatore non la vede.</span></div></div>';
  }

  function paintEcoPlan(chk) {
    const P = state.cal.panel, box = $('#calPanel').querySelector('[data-o=eco]');
    const bf = $('#calPanel').querySelector('[data-o=psavef]');
    if (bf && P) { bf.disabled = chk.errors.length > 0 || !String(P.avv || '').trim(); bf.title = String(P.avv || '').trim() ? '' : 'Indica il numero dell’avviso'; }
    if (!box || !P || !chk.o) return;
    const o = chk.o, mg = (ECO.cfg && ECO.cfg.margine) || 0, L = Eco.label;
    let cls = '', h = '';
    if (isExt(o.matricola)) h = '<p><b>Prodotto esterno</b>: non passa dalla produzione, la data del collaudo la decidi tu.</p>';
    else if (!ECO.prod) h = '<p>Per la data suggerita servono i turni della produzione. ' + esc(ECO.err || '') + '</p>';
    else if (!chk.total) h = '<p class="meta">Indica i pezzi: ti suggerisco la data del collaudo in base al ritmo della produzione.</p>';
    else {
      const post = ecoPostOk(P.post) ? +String(P.post).trim() : undefined;
      const h0 = { matricola: o.matricola, oda: o.oda, orderId: o.id, qty: chk.total, postazioni: post, excludeId: P.eventId || null, id: P.eventId || null };
      const sg = Eco.suggest(ecoInput(), h0);
      if (sg.issue === 'nolink' || sg.issue === 'noprod') h = '<p>La matricola <b class="mono">' + esc(o.matricola) + '</b> non è collegata a un prodotto della produzione: in Matricole apri la matricola e scegli il prodotto della produzione.</p>';
      else if (sg.issue === 'noritmo') h = '<p>Manca il ritmo giornaliero del prodotto <b class="mono">' + esc(sg.product.a) + '</b>: impostalo in Gestione Produzione › Anagrafiche › Prodotti.</p>';
      else {
        h = '<p>Ritmo ' + Eco.N1(sg.rate.one) + ' pz/giorno per postazione × ' + sg.post + ' = <b>' + Eco.N1(sg.R) + ' pz/giorno</b>.' + (sg.before ? ' Prima di questo ci sono ' + nf.format(sg.before) + ' pezzi di altri collaudi dello stesso prodotto.' : '') + '</p>' +
          '<p>' + (sg.rem > 0 ? 'Servono ' + Eco.N1(sg.dur) + ' giorni lavorativi' + (sg.start > 0 ? ', dopo quelli già in programma' : '') : 'I pezzi sono già pronti') +
          ': data suggerita <b>' + esc(L(sg.date)) + '</b>' + (mg ? ' (margine di ' + plural(mg, 'giorno', 'giorni') + ')' : '') +
          (P.date === sg.date ? '' : '<button type="button" class="btn small" data-act="eco-use-date" data-date="' + esc(sg.date) + '">Usa questa data</button>') + '</p>';
        if (isYmd(P.date)) {
          const c = Eco.check(ecoInput(), Object.assign({}, h0, { date: P.date }));
          if (c && c.L) {
            const x = c.L;
            if (x.status === 'rischio') {
              cls = 'bad';
              h += '<p><b>' + esc(L(P.date)) + ' è troppo presto</b>: i pezzi sono pronti solo per ' + esc(L(x.ready)) + '.' +
                (x.suggest && x.suggest !== x.ready ? ' Con il margine la prima data è ' + esc(L(x.suggest)) + '.' : '') +
                (x.postNeeded && x.postNeeded > x.post ? ' Per tenere questa data servono ' + x.postNeeded + ' postazioni (ora ' + x.post + ').' : x.byPrev ? ' Pesano i collaudi dello stesso prodotto già in programma prima di questo.' : '') + '</p>';
            } else { cls = 'ok'; h += '<p><b>' + esc(L(P.date)) + ': la data regge</b>, ' + (x.status === 'pronto' ? 'pezzi già pronti.' : 'pezzi pronti per ' + esc(L(x.ready)) + '.') + '</p>'; }
            if (c.hit.length) { cls = 'bad'; h += '<p>Così vanno a rischio: ' + c.hit.map((y) => 'collaudo di ' + esc(L(y.date)) + (y.oda ? ' (ODA ' + esc(y.oda) + ')' : '')).join(', ') + '.</p>'; }
          }
        }
      }
    }
    box.hidden = false; box.className = 'ecobox' + (cls ? ' ' + cls : ''); box.innerHTML = h;
  }

  function ecoEventHtml(e) {
    const bits = [];
    if (e.postazioni) bits.push(plural(e.postazioni, 'postazione', 'postazioni'));
    if (e.avviso) bits.push('avviso ' + e.avviso);
    if (e.operatore) bits.push('operatore: ' + e.operatore);
    let h = bits.length ? '<p class="meta">' + esc(bits.join(' · ')) + '</p>' : '';
    const x = ECO.m && ECO.m.lots[e.id];
    if (!x) return h;
    const L = Eco.label;
    let cls = '', t = 'Prodotti <span class="mono">' + nf.format(x.done) + '</span> di <span class="mono">' + nf.format(x.qty) + '</span> · ';
    if (x.status === 'pronto') { cls = 'ok'; t += 'pezzi già pronti.'; }
    else if (x.status === 'ok' || x.status === 'margine') { cls = 'ok'; t += 'pronti per ' + esc(L(x.ready)) + ', la data regge' + (x.status === 'margine' ? ' con margine (si può anticipare a ' + esc(L(x.suggest)) + ')' : '') + '.'; }
    else if (x.status === 'rischio') { cls = 'bad'; t += 'pronti solo per ' + esc(L(x.ready)) + '.' + (x.postNeeded && x.postNeeded > x.post ? ' Servono ' + x.postNeeded + ' postazioni (ora ' + x.post + ')' + (x.suggest ? ' oppure spostalo a ' + esc(L(x.suggest)) : '') + '.' : x.suggest ? ' Spostalo a ' + esc(L(x.suggest)) + '.' : ''); }
    else t += x.status === 'noritmo' ? 'manca il ritmo del prodotto in anagrafica produzione.' : 'matricola non collegata a un prodotto della produzione.';
    return h + '<div class="ecobox ' + cls + '"><p>' + t + '</p></div>';
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'eco-reload') ecoLoad();
    else if (act === 'eco-file') { const inp = $('#ecoFileInput'); if (inp) { inp.value = ''; inp.click(); } }
    else if (act === 'eco-cfg-save') ecoSaveCfg();
    else if (act === 'eco-use-date') {
      const P = state.cal.panel; if (!P || P.mode !== 'plan' || !isYmd(b.dataset.date)) return;
      P.date = b.dataset.date; const d = parseYmd(P.date); state.cal.y = d.getFullYear(); state.cal.m = d.getMonth();
      paintCal(); paintPanel(true);
    }
    else if (act === 'nav' && b.dataset.view === 'avanzamento') ecoLoad();
    else if (act === 'plan-save-files') savePlan(true);
  });
  document.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'ecoFileInput') return;
    const f = e.target.files && e.target.files[0]; if (!f) return;
    f.text().then((t) => { ECO.prod = Eco.fromProdFile(JSON.parse(t)); ECO.src = 'file'; ECO.at = new Date(); ECO.fileAt = f.lastModified ? new Date(f.lastModified) : null; ECO.err = ''; })
      .catch((er) => { ECO.err = 'File non valido: ' + ((er && er.message) || 'non leggibile'); })
      .then(() => refreshAll());
  });
  /* dopo il salvataggio in calendario: scheda del collaudo pronta in "Crea file", con il controllo finale già aperto */
  function prepareFiles(id) {
    const e = eventById(id); if (!e) return;
    if (!rec(e.matricola)) { notice('bad', 'Collaudo salvato, ma la matricola ' + e.matricola + ' non è in anagrafica: aggiungila in “Matricole” per creare i file.', true); return; }
    const ln = newLine(e.matricola); ln.oda = e.oda; ln.eventId = e.id;
    ln.dests = evLines(e).map((l) => ({ name: l.name, qty: String(l.qty) }));
    state.lines = [ln];
    state.avviso = String(e.avviso || ''); $('#avviso').value = state.avviso;
    const d = parseYmd(e.date); state.mese = C.MESI[d.getMonth()]; state.anno = String(d.getFullYear()).slice(-2);
    $('#mese').value = state.mese; $('#anno').value = state.anno;
    state.result = null; state.confirming = false;
    showView('lotto'); renderResult(); renderLines(); update();
    const V = compute();
    if (V.ok) {
      state.confirming = true; paintAction(V);
      notice('ok', 'Collaudo in calendario. Controlla seriali e pianali qui sotto e premi “Conferma e crea i file”.', true);
      $('#secAction').scrollIntoView({ block: 'center' });
    } else {
      notice('warn', 'Collaudo in calendario. Per creare i file completa i dati segnalati nella scheda della matricola.', true);
      $('#linesHost').scrollIntoView({ block: 'start' });
    }
  }

  function freePanelHtml(P) {
    const F = P.free, mats = visibleMats(), r = rec(F.mat) || {};
    const opts = '<option value="">Scegli la matricola…</option>' + mats.map((m) => '<option value="' + esc(m) + '"' + (m === F.mat ? ' selected' : '') + '>' + esc(m) + (rec(m).descrizione ? ' — ' + esc(rec(m).descrizione) : '') + '</option>').join('');
    const dests = F.dests.map((d, i) => '<tr><td><input type="text" data-fd="name" data-i="' + i + '" aria-label="Destinazione ' + (i + 1) + '" placeholder="es. Bologna" autocomplete="off" value="' + esc(d.name) + '"></td>' +
      '<td class="r"><input type="text" class="num" data-fd="qty" data-i="' + i + '" inputmode="numeric" aria-label="Pezzi per la destinazione ' + (i + 1) + '" placeholder="0" autocomplete="off" value="' + esc(d.qty) + '"></td></tr>').join('');
    return '<div class="sec-head"><div class="lh"><span class="ic sm">' + ICON + '</span><div><h2>Collaudo senza ordine caricato</h2><p class="sub">' + (F.mat ? '<span class="mono">' + esc(F.mat) + '</span> ' + esc(r.descrizione || '') : 'Creo l’ordine insieme al collaudo.') + '</p></div></div>' + closeBtn + '</div>' +
      '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="field span2"><label class="l" for="fr-mat">Matricola</label><select id="fr-mat" data-ff="mat">' + opts + '</select></div>' +
      '<div class="field"><label class="l" for="fr-oda">Ordine (ODA)</label><input type="text" id="fr-oda" class="num" data-ff="oda" inputmode="numeric" autocomplete="off" placeholder="es. 6000132763" value="' + esc(F.oda) + '"></div>' +
      '<div class="field"><label class="l" for="pl-date">Giorno del collaudo</label><input type="date" id="pl-date" data-pf="date" value="' + esc(P.date || '') + '"></div></div>' +
      (F.mat ? '<div class="scroll"><table class="qt"><thead><tr><th>Destinazione</th><th class="r">Pezzi in questo collaudo</th></tr></thead><tbody>' + dests + '</tbody></table></div>' +
        '<div class="row"><button type="button" class="btn ghost small" data-act="free-add-dest">+ Destinazione</button><span class="hint">Lascia vuote le destinazioni che non servono.</span></div>' +
        ecoPlanFields(P, { matricola: F.mat }) + '<div class="ecobox" data-o="eco" hidden></div>' : '') +
      '<p class="summary" data-o="ptotal"></p><ul class="msgs" data-o="pmsg"></ul>' +
      '<div class="row"><button type="button" class="btn primary" data-act="plan-save-files" data-o="psavef">Crea ordine e collaudo e prepara i file</button>' +
      '<button type="button" class="btn" data-act="plan-save" data-o="psave">Solo in calendario</button><button type="button" class="btn ghost" data-act="free-back">Indietro</button></div>' +
      '<p class="hint" style="margin:0">L’ordine si crea con scadenza uguale al giorno del collaudo; puoi completarlo dopo in Ordini.</p>';
  }
  function freeCheck(P) {
    const F = P.free, out = { errors: [], lines: [], total: 0, o: null }, oda = String(F.oda || '').trim();
    if (!F.mat || !rec(F.mat)) out.errors.push('Scegli la matricola.');
    if (!oda) out.errors.push('Indica il numero d’ordine (ODA).');
    else if (!/^\d+$/.test(oda)) out.errors.push('L’ordine (ODA) deve contenere solo cifre.');
    let bad = false; const seen = new Set();
    F.dests.forEach((d) => {
      const raw = String(d.qty || '').trim(); if (raw === '') return;
      const n = C.toInt(raw), name = String(d.name || '').trim();
      if (!(n >= 1)) bad = true;
      else if (!name) out.errors.push('Indica il nome della destinazione per la quantità ' + raw + '.');
      else if (seen.has(lineKey(name))) out.errors.push('La destinazione ' + name + ' è scritta due volte.');
      else { seen.add(lineKey(name)); out.lines.push({ name: name, qty: n }); }
    });
    if (bad) out.errors.push('Le quantità devono essere numeri interi da 1 in su.');
    else if (F.mat && !out.lines.length) out.errors.push('Indica i pezzi di almeno una destinazione.');
    if (!isYmd(P.date)) out.errors.push('Scegli il giorno del collaudo.');
    else if (F.mat && oda && state.db.orders.some((o) => o.oda === oda && o.matricola === F.mat && (o.due || '') === P.date)) out.errors.push('Esiste già l’ordine ' + oda + ' per ' + F.mat + ' con scadenza ' + dayLabel(P.date) + ': pianificalo dall’elenco degli ordini.');
    if (String(P.post || '').trim() && !ecoPostOk(P.post)) out.errors.push('Le postazioni devono essere un numero intero da 1 a 50 (vuoto = quelle normali del prodotto).');
    out.total = sumOf(out.lines.map((l) => l.qty));
    if (F.mat) out.o = { id: null, matricola: F.mat, oda: oda };
    return out;
  }
  function freeMeta() {
    const P = state.cal.panel, host = $('#calPanel'), chk = freeCheck(P);
    const t = host.querySelector('[data-o=ptotal]'), m = host.querySelector('[data-o=pmsg]'), b = host.querySelector('[data-o=psave]');
    if (t) t.innerHTML = chk.total ? 'Collaudo di <span class="mono">' + nf.format(chk.total) + '</span> pezzi · creo anche l’ordine' + (chk.o && chk.o.oda ? ' <span class="mono">' + esc(chk.o.oda) + '</span>' : '') : '';
    if (m) m.innerHTML = chk.errors.map((x) => '<li class="' + (/^Scegli|^Indica/.test(x) ? 'todo' : 'bad') + '">' + esc(x) + '</li>').join('');
    if (b) b.disabled = chk.errors.length > 0;
    const bf = host.querySelector('[data-o=psavef]'); if (bf) bf.disabled = chk.errors.length > 0 || !String(P.avv || '').trim();
    if (chk.o) paintEcoPlan(chk);
  }
  async function freeToOrder() {
    const P = state.cal.panel; if (!P || P.mode !== 'plan' || !P.free || P.orderId) return true;
    const chk = freeCheck(P);
    if (chk.errors.length) { freeMeta(); notice('bad', chk.errors[0], true); return false; }
    const stamp = nowIso();
    try { P.orderId = await createDoc('orders', { createdAt: stamp, oda: chk.o.oda, matricola: chk.o.matricola, due: P.date, note: 'Inserito dal calendario, senza ordine caricato', lines: chk.lines, updatedAt: stamp }); }
    catch (e) { notice('bad', 'Non sono riuscito a creare l’ordine' + errText(e) + '.', true); return false; }
    const o = orderById(P.orderId); P.qty = {};
    orderStats(o).rows.forEach((x, i) => { P.qty[i] = String(x.left); });
    P.free = null;
    return true;
  }
  $('#calPanel').addEventListener('input', (e) => {
    const t = e.target, P = state.cal.panel; if (!P || !P.free) return;
    if (t.dataset.ff === 'oda') P.free.oda = t.value;
    else if (t.dataset.fd) { const d = P.free.dests[Number(t.dataset.i)]; if (d) d[t.dataset.fd] = t.value; }
    else return;
    freeMeta();
  });
  $('#calPanel').addEventListener('change', (e) => {
    const t = e.target, P = state.cal.panel; if (!P || !P.free || t.dataset.ff !== 'mat') return;
    P.free.mat = t.value; P.post = '';
    P.free.dests = destList(rec(t.value)).map((n) => ({ name: n, qty: '' }));
    if (!P.free.dests.length) P.free.dests.push({ name: '', qty: '' });
    paintPanel(true);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, P = state.cal.panel;
    if (act === 'plan-free' && P && P.mode === 'plan') { P.free = { mat: '', oda: '', dests: [] }; P.orderId = null; P.qty = {}; paintPanel(true); const el = document.getElementById('fr-mat'); if (el) el.focus(); }
    else if (act === 'free-add-dest' && P && P.free) { P.free.dests.push({ name: '', qty: '' }); paintPanel(true); }
    else if (act === 'free-back' && P && P.free) { P.free = null; paintPanel(true); }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'ord-toggle') { state.ord.open = state.ord.open === b.dataset.id ? null : b.dataset.id; state.ord.delCard = null; paintOrders(false); }
    else if (act === 'ord-arch' || act === 'ord-unarch') {
      const id = b.dataset.id, o = orderById(id); if (!o) return;
      patchDoc('orders', id, { archived: act === 'ord-arch', updatedAt: nowIso() })
        .then(() => { refreshAll(); notice('ok', act === 'ord-arch' ? 'Ordine ' + o.oda + ' (' + o.matricola + ') archiviato.' : 'Ordine ' + o.oda + ' (' + o.matricola + ') riaperto.'); })
        .catch((er) => notice('bad', 'Non sono riuscito a salvare' + errText(er) + '.', true));
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'ordQ') applyQ($('#ordHost'), t.value);
    else if (t.id === 'todoQ') applyQ($('#todoList'), t.value);
    else if (t.dataset && t.dataset.pickq != null) applyQ($('#calPanel [data-o=picklist]'), t.value);
  });

  /* nell'anagrafica le spunte "prodotto esterno" e "a scatole" cambiano i campi mostrati */
  document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('#matEditor') && e.target.dataset.rerender) { syncDraft(); renderEditor(); } });

  /* ---------- backup notturno (solo online) ---------- */
  const BK = { st: null, busy: false, err: '' };
  const fmtTs = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  async function bkLoad() {
    const A = window.__cloudApi; if (!A) return;
    try { BK.st = await A.rpc('backup_stato'); BK.err = ''; } catch (e) { BK.err = e.message; }
    paintBk();
  }
  function paintBk() {
    const card = $('#bkCard'), host = $('#bkHost'), A = window.__cloudApi;
    if (!card) return; card.hidden = !A; if (!A) return;
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const st = BK.st;
    if (!st) { host.innerHTML = '<p class="meta">' + (BK.err ? 'Non riesco a leggere lo stato del backup: ' + esc(BK.err) : 'Carico lo stato…') + '</p>'; return; }
    const last = (st.esiti || [])[0], lastOk = (st.esiti || []).find((x) => x.ok);
    const head = !st.chiave ? '<span class="bkdot bad"></span><span><b>Non ancora attivo</b>: manca la chiave di Resend.</span>'
      : last ? '<span class="bkdot ' + (last.ok ? 'ok' : 'bad') + '"></span><span><b>' + (last.ok ? 'Attivo' : 'Ultimo invio non riuscito') + '</b> · ultimo tentativo ' + esc(fmtTs(last.ts)) + (lastOk && lastOk !== last ? ' · ultimo riuscito ' + esc(fmtTs(lastOk.ts)) : '') + '</span>'
      : '<span class="bkdot"></span><span><b>Pronto</b>: il primo backup parte questa notte (circa alle 2:30). Puoi provarlo subito con “Invia un backup ora”.</span>';
    host.innerHTML = '<div class="bkst">' + head + '</div>' +
      '<div class="grid g3">' +
      '<div class="field"><label class="l" for="bkKey">Chiave API di Resend</label><input type="password" id="bkKey" autocomplete="off" placeholder="' + (st.chiave ? 'salvata · scrivi solo per cambiarla' : 're_…') + '"><span class="hint">Da resend.com › API Keys. Resta salvata in modo cifrato nel database.</span></div>' +
      '<div class="field"><label class="l" for="bkTo">Destinatario</label><input type="email" id="bkTo" autocomplete="off" value="' + esc(st.destinatario || '') + '"></div>' +
      '<div class="field"><label class="l" for="bkFrom">Mittente (facoltativo)</label><input type="text" id="bkFrom" autocomplete="off" placeholder="Backup Officine Demo <onboarding@resend.dev>" value="' + esc(st.mittente || '') + '"><span class="hint">Vuoto = indirizzo di prova di Resend: funziona solo verso l’email con cui hai creato l’account.</span></div>' +
      '</div><div class="row"><button type="button" class="btn small" data-act="bk-save"' + (BK.busy ? ' disabled' : '') + '>Salva</button>' +
      '<button type="button" class="btn small primary" data-act="bk-now"' + (BK.busy || !st.chiave ? ' disabled' : '') + '>Invia un backup ora</button>' +
      '<span class="hint">L’email contiene due file: Collaudi e Seriali (Storico › Dati › Importa) e Produzione (Backup dati › Importa backup).</span></div>' +
      ((st.esiti || []).length ? '<details class="pane"><summary>Ultimi invii</summary><div class="in"><ul class="bklist">' + st.esiti.map((x) => '<li><span class="bkdot ' + (x.ok ? 'ok' : 'bad') + '"></span><span class="mono">' + esc(fmtTs(x.ts)) + '</span><span>' + esc(x.dettaglio) + ' <span class="meta">(' + esc(x.origine) + ')</span></span></li>').join('') + '</ul></div></details>' : '');
  }
  async function bkSave() {
    const A = window.__cloudApi; if (!A || BK.busy) return;
    const k = $('#bkKey').value.trim(), to = $('#bkTo').value.trim(), from = $('#bkFrom').value.trim();
    if (k && !/^re_\w{8,}/.test(k)) return notice('bad', 'La chiave di Resend comincia con “re_”: copiala di nuovo da resend.com › API Keys.', true);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return notice('bad', 'Indica un indirizzo email valido per il destinatario.', true);
    BK.busy = true; paintBk();
    try { BK.st = await A.rpc('backup_imposta', { chiave: k || null, destinatario: to, mittente: from }); notice('ok', 'Impostazioni del backup salvate.'); }
    catch (e) { notice('bad', 'Non sono riuscito a salvare' + errText(e) + '.', true); }
    BK.busy = false; document.activeElement && document.activeElement.blur && document.activeElement.blur(); paintBk();
  }
  async function bkNow() {
    const A = window.__cloudApi; if (!A || BK.busy) return;
    BK.busy = true; paintBk();
    try { const r = await A.invoke('backup-notturno', { origine: 'manuale' }); notice('ok', 'Backup inviato. ' + (r.dettaglio || '')); }
    catch (e) { notice('bad', 'Backup non inviato: ' + e.message, true); }
    BK.busy = false; await bkLoad();
  }

  /* ---------- registro delle modifiche (solo online) ---------- */
  const LOG = { rows: null, f: '', busy: false, err: '', more: true };
  const LOGF = { last: 'ultimo seriale', lastPallet: 'ultimo pianale', lastByYear: 'seriali per anno', lastYear: 'anno dell’ultimo seriale', prefix: 'prefisso',
    perPallet: 'pezzi per pallet', destinations: 'destinazioni', descrizione: 'descrizione', prodotto: 'prodotto di produzione', esterno: 'prodotto esterno', scatole: 'a scatole',
    boxPz: 'pezzi per scatola', boxPerPallet: 'scatole per pallet', lottoLettera: 'lettera del lotto', archived: 'archiviato', remainder: 'resto dei pezzi', sheetName: 'foglio Excel',
    oda: 'ODA', due: 'scadenza', lines: 'quantità', note: 'note', pos: 'posizioni', matricola: 'matricola', date: 'data', status: 'stato', avviso: 'avviso', postazioni: 'postazioni',
    operatore: 'operatore', portalToUpdate: 'da aggiornare sul portale', runId: 'lotto', palByYear: 'pallet a scatole', ritmo: 'ritmo', a: 'codice', b: 'descrizione', pezzi: 'pezzi',
    durata_sec: 'durata', causa: 'causa', ts: 'data e ora', prefix_: '', margine: 'margine', contaDal: 'conta dal', ordersDone: 'promemoria', fixedDigit: 'cifra fissa', esito: 'esito', esitoData: 'data effettiva', esitoNote: 'note dell’esito', avvisoInviato: 'avviso inviato', fornitoreData: 'consegna del fornitore', spostamenti: 'spostamenti', dataOriginale: 'data originale', movedFrom: 'spostato dal', filesAt: 'file creati il' };
  const STATI = { planned: 'pianificato', files: 'file creati', collaudato: 'collaudato', respinto: 'respinto' };
  function logVal(k, v) {
    if (v == null) return '—';
    if (k === 'lines' && Array.isArray(v)) return nf.format(v.reduce((a, l) => a + (Number(l && l.qty) || 0), 0)) + ' pz (' + v.map((l) => l && l.name).filter(Boolean).join(', ') + ')';
    if (k === 'status') return STATI[v] || String(v);
    if (k === 'remainder') return v === 'last' ? 'sommati all’ultimo pallet' : 'ultimo pallet parziale';
    if ((k === 'date' || k === 'due' || k === 'esitoData' || k === 'avvisoInviato' || k === 'fornitoreData' || k === 'dataOriginale' || k === 'movedFrom') && isYmd(v)) return dayLabel(v);
    if (typeof v === 'boolean') return v ? 'sì' : 'no';
    if (typeof v === 'number') return nf.format(v);
    if (Array.isArray(v)) return v.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(', ').slice(0, 120);
    if (typeof v === 'object') return Object.keys(v).map((x) => x + ': ' + (typeof v[x] === 'object' ? JSON.stringify(v[x]) : v[x])).join(', ').slice(0, 120);
    return String(v).slice(0, 120);
  }
  function logWhat(r) {
    const d = r.dopo || r.prima || {}, k = r.chiave;
    if (r.tabella === 'portale_doc') {
      const i = k.indexOf('/'), col = k.slice(0, i), id = k.slice(i + 1);
      if (col === 'serials') return 'Matricola <b class="mono">' + esc(id) + '</b>';
      if (col === 'orders') { const o = orderById(id) || d; return 'Ordine ODA <b class="mono">' + esc(o.oda || '?') + '</b>' + (o.matricola ? ' · ' + esc(o.matricola) : ''); }
      if (col === 'events') { const e = eventById(id) || d; return 'Collaudo' + (e.date ? ' del ' + esc(dayLabel(e.date)) : '') + (e.matricola ? ' · ' + esc(e.matricola) : '') + (e.oda ? ' · ODA ' + esc(e.oda) : ''); }
      if (col === 'runs') { const x = state.db.runs.find((y) => y.id === id) || d; return 'Lotto' + (x.avviso ? ' avviso ' + esc(x.avviso) : '') + (x.lines ? ' · ' + esc(x.lines.map((l) => l.matricola).join(', ')) : ''); }
      if (col === 'meta') return ({ config: 'Regole del codice a barre', scatole: 'Pallet a scatole', eco: 'Impostazioni della stima', reminders: 'Promemoria', destAlias: 'Nomi delle destinazioni' })[id] || 'Impostazioni (' + esc(id) + ')';
      return esc(k);
    }
    if (r.tabella === 'anagrafica') { const t = { prodotti: 'Prodotto', operatori: 'Operatore', scarti: 'Causa di scarto', fermi: 'Causa di fermo' }[d.tipo] || 'Anagrafica'; return t + ' <b class="mono">' + esc(d.a || k) + '</b>' + (d.b ? ' ' + esc(String(d.b).replace(/^\w+::/, '')) : ''); }
    if (r.tabella === 'registrazioni') return 'Registrazione ' + esc(d.tipo || '') + (d.operatore ? ' di ' + esc(d.operatore) : '') + (d.ts ? ' del ' + esc(fmtTs(d.ts)) : '');
    return esc(r.tabella + ' ' + k);
  }
  function logRowHtml(r) {
    const az = { INSERT: 'creato', UPDATE: 'modificato', DELETE: 'eliminato' }[r.azione] || r.azione;
    let ch = '';
    if (r.azione === 'UPDATE') {
      const keys = Object.keys(Object.assign({}, r.prima || {}, r.dopo || {})).filter((x) => (x !== 'lastByYear' || !(r.dopo || {}).last) && !(x === 'remainder' && (r.prima || {})[x] == null));
      ch = keys.slice(0, 6).map((x) => '<span><b>' + esc(LOGF[x] || x) + '</b>: ' + esc(logVal(x, (r.prima || {})[x])) + ' → ' + esc(logVal(x, (r.dopo || {})[x])) + '</span>').join(' · ') + (keys.length > 6 ? ' · …' : '');
    } else if (r.azione === 'INSERT' && r.tabella === 'portale_doc' && /^events\//.test(r.chiave)) ch = esc(logVal('lines', (r.dopo || {}).lines));
    else if (r.azione === 'DELETE' && r.tabella === 'registrazioni') ch = 'pezzi ' + esc(logVal('pezzi', (r.prima || {}).pezzi));
    const hot = r.azione === 'UPDATE' && /^serials\//.test(r.chiave) && r.prima && 'last' in r.prima && r.dopo && Number(r.dopo.last) < Number(r.prima.last);
    const s = oqNorm([r.utente, r.chiave, logWhat(r).replace(/<[^>]+>/g, ''), ch.replace(/<[^>]+>/g, '')].join(' '));
    return '<li class="' + esc(r.azione) + (hot ? ' hot' : '') + '" data-s="' + esc(s) + '"><span class="lt"><span>' + logWhat(r) + ' · <b>' + az + '</b></span><span class="meta">' + esc(fmtTs(r.ts)) + ' · ' + esc(r.utente || '') + '</span></span>' +
      (ch ? '<span class="lc">' + ch + '</span>' : '') + (hot ? '<span class="lc"><b>Seriali riportati indietro</b>: quei numeri potranno essere riassegnati.</span>' : '') + '</li>';
  }
  async function logLoad(more) {
    const A = window.__cloudApi; if (!A || LOG.busy) return;
    LOG.busy = true; paintLog();
    const f = LOG.f, flt = f === 'prod' ? '&tabella=in.(anagrafica,registrazioni)' : f ? '&tabella=eq.portale_doc&chiave=like.' + encodeURIComponent(f + '/*') : '';
    const before = more && LOG.rows && LOG.rows.length ? '&id=lt.' + LOG.rows[LOG.rows.length - 1].id : '';
    try {
      const rows = await A.select('registro_modifiche?select=*&order=id.desc&limit=100' + flt + before);
      LOG.rows = more ? (LOG.rows || []).concat(rows) : rows; LOG.more = rows.length === 100; LOG.err = '';
    } catch (e) { LOG.err = e.message; }
    LOG.busy = false; paintLog();
  }
  function paintLog() {
    const card = $('#logCard'), host = $('#logHost'), A = window.__cloudApi;
    if (!card) return; card.hidden = !A; if (!A) return;
    document.querySelectorAll('#logCard [data-act=log-f]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === LOG.f)));
    if (!LOG.rows) { host.innerHTML = '<p class="meta">' + (LOG.err ? 'Non riesco a leggere il registro: ' + esc(LOG.err) : 'Carico…') + '</p>'; return; }
    host.innerHTML = (LOG.rows.length ? '<ul class="logl">' + LOG.rows.map(logRowHtml).join('') + '</ul><p class="empty oq-empty" hidden>Nessuna modifica trovata.</p>' : '<p class="empty">Nessuna modifica registrata' + (LOG.f ? ' in questa sezione' : '') + '.</p>') +
      (LOG.rows.length && LOG.more ? '<div class="row"><button type="button" class="btn small" data-act="log-more"' + (LOG.busy ? ' disabled' : '') + '>Mostra le precedenti</button></div>' : '');
    applyLogQ();
  }
  function applyLogQ() {
    const host = $('#logHost'), t = oqNorm(($('#logQ') || {}).value || '').trim(); if (!host) return;
    host.querySelectorAll('[data-s]').forEach((x) => { x.hidden = !!t && x.dataset.s.indexOf(t) < 0; });
    const e = host.querySelector('.oq-empty'); if (e) e.hidden = !t || !!host.querySelector('[data-s]:not([hidden])');
  }
  function adminOpen() { if (!window.__cloudApi) return; bkLoad(); logLoad(false); }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'nav' && b.dataset.view === 'storico') setTimeout(adminOpen, 0);
    else if (a === 'bk-save') bkSave();
    else if (a === 'bk-now') bkNow();
    else if (a === 'log-load') logLoad(false);
    else if (a === 'log-more') logLoad(true);
    else if (a === 'log-f') { LOG.f = b.dataset.f; LOG.rows = null; logLoad(false); }
    else if (a === 'save-mat-ok') { if (state.edit && state.edit.ask) { state.edit.okKey = state.edit.ask.key; saveMat(); } }
    else if (a === 'save-mat-no') { if (state.edit) { syncDraft(); state.edit.ask = null; renderEditor(); } }
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'logQ') applyLogQ(); });

  /* ---------- conferma quando si cambiano a mano gli ultimi numeri di una matricola ---------- */
  function numAskHtml(E) {
    const q = E && E.ask; if (!q) return '';
    const parts = [];
    if (q.last !== q.oLast && q.oLast != null) parts.push(q.last < q.oLast
      ? 'L’ultimo seriale torna da <b class="mono">' + nf.format(q.oLast) + '</b> a <b class="mono">' + nf.format(q.last) + '</b>: i seriali da ' + nf.format(q.last + 1) + ' a ' + nf.format(q.oLast) + ' verranno <b>assegnati di nuovo</b>. Fallo solo se quei numeri non sono mai finiti su etichette o sul portale del cliente.'
      : 'L’ultimo seriale passa da <b class="mono">' + nf.format(q.oLast) + '</b> a <b class="mono">' + nf.format(q.last) + '</b>: i seriali da ' + nf.format(q.oLast + 1) + ' a ' + nf.format(q.last) + ' non verranno mai usati.');
    if (q.pal !== q.oPal && q.oPal != null && q.pal != null) parts.push(q.pal < q.oPal
      ? 'L’ultimo pianale torna da <b class="mono">' + nf.format(q.oPal) + '</b> a <b class="mono">' + nf.format(q.pal) + '</b>: quei pianali verranno riusati.'
      : 'L’ultimo pianale passa da <b class="mono">' + nf.format(q.oPal) + '</b> a <b class="mono">' + nf.format(q.pal) + '</b>.');
    if (!parts.length) parts.push('Stai cambiando a mano gli ultimi numeri di questa matricola.');
    return '<div class="numask" role="alert"><b>Confermi la correzione dei numeri?</b>' + parts.map((p) => '<span>' + p + '</span>').join('') +
      '<div class="row"><button type="button" class="btn small primary" data-act="save-mat-ok">Sì, salva i nuovi numeri</button><button type="button" class="btn small" data-act="save-mat-no">Annulla</button></div></div>';
  }

  /* ---------- esito, avviso e fornitore ---------- */
  const EV_DONE = (e) => e.esito === 'collaudato' || e.esito === 'respinto';
  const shiftYmd = (d, n) => { const t = parseYmd(d); t.setDate(t.getDate() + n); return Eco.ymd(t); };
  /* l'avviso di collaudo va inviato una settimana prima; se quel giorno è festivo o nel fine settimana, il giorno lavorativo prima */
  function avvisoEntro(d) { let x = shiftYmd(d, -7); for (let i = 0; i < 10 && !Eco.isWork(x); i++) x = shiftYmd(x, -1); return x; }
  const effDate = (e) => (EV_DONE(e) && isYmd(e.esitoData) ? e.esitoData : e.date);
  function evAlerts() {
    if (loadingNew()) return [];
    const tod = todayStr(), soon = shiftYmd(tod, 3), out = [];
    state.db.events.forEach((e) => {
      if (!isYmd(e.date) || EV_DONE(e)) return;
      if (e.date < tod) { out.push({ k: 'esito', e: e, sort: e.date }); return; }
      const en = avvisoEntro(e.date);
      if (!e.avvisoInviato && en <= soon) out.push({ k: 'avviso', e: e, entro: en, late: en < tod, sort: en });
      if (isExt(e.matricola) && isYmd(e.fornitoreData) && e.fornitoreData >= e.date) out.push({ k: 'forn', e: e, sort: e.date });
    });
    return out.sort((a, b) => a.sort.localeCompare(b.sort));
  }
  function evAlertsHtml(list) {
    if (!list.length) return '';
    const G = [['avviso', 'Avvisi di collaudo da inviare', 'Una settimana prima del collaudo (se cade nel fine settimana o in un festivo, il giorno lavorativo prima).'],
      ['esito', 'Collaudi passati: segna l’esito', 'Collaudato o respinto, con la data effettiva.'], ['forn', 'Prodotti esterni: il fornitore consegna tardi', 'La consegna prevista è nello stesso giorno del collaudo o dopo.']];
    return G.map((g) => {
      const it = list.filter((x) => x.k === g[0]); if (!it.length) return '';
      return '<div class="bgrp"><h3>' + esc(g[1]) + '</h3><p class="meta">' + esc(g[2]) + '</p><div class="todo-list">' + it.map((x) => {
        const e = x.e, r = rec(e.matricola) || {};
        const info = x.k === 'avviso' ? '<span class="due ' + (x.late ? 'bad' : 'warn') + '">entro ' + esc(dayLabel(x.entro, true)) + (x.late ? ' · in ritardo' : '') + '</span>'
          : x.k === 'forn' ? '<span class="due bad">fornitore ' + esc(dayLabel(e.fornitoreData)) + '</span>' : '';
        const btns = x.k === 'avviso' ? '<button type="button" class="btn small" data-act="ev-avv" data-id="' + esc(e.id) + '">Inviato</button>'
          : x.k === 'esito' ? '<button type="button" class="btn small" data-act="ev-esito" data-v="collaudato" data-id="' + esc(e.id) + '">Collaudato</button>' : '';
        return '<div class="tr"><div class="grow"><b class="mono">' + esc(e.matricola) + '</b> <span class="meta">' + esc(r.descrizione || '') + '</span><br><span class="meta">Collaudo ' + esc(dayLabel(e.date, true)) + ' · ODA <span class="mono">' + esc(e.oda) + '</span> · ' + nf.format(evTotal(e)) + ' pz</span></div>' +
          info + btns + '<button type="button" class="btn ghost small" data-act="ev-go" data-id="' + esc(e.id) + '">Apri</button></div>';
      }).join('') + '</div></div>';
    }).join('');
  }
  function evStatusHtml(e) {
    const tod = todayStr(), en = avvisoEntro(e.date), id = esc(e.id);
    let h = '<div class="evst">';
    h += '<div class="evr2' + (e.avvisoInviato ? ' ok' : !EV_DONE(e) && en < tod ? ' bad' : '') + '"><span><b>Avviso di collaudo</b> · ' + (e.avvisoInviato ? 'inviato il ' + esc(dayLabel(e.avvisoInviato)) : 'da inviare entro ' + esc(dayLabel(en, true)) + (!EV_DONE(e) && en < tod ? ' (in ritardo)' : '')) + '</span>' +
      (e.avvisoInviato ? '<button type="button" class="btn ghost small" data-act="ev-avv-undo" data-id="' + id + '">Annulla</button>' : EV_DONE(e) ? '' : '<button type="button" class="btn small" data-act="ev-avv" data-id="' + id + '">Segna come inviato</button>') + '</div>';
    if (isExt(e.matricola)) {
      const late = isYmd(e.fornitoreData) && e.fornitoreData >= e.date, near = isYmd(e.fornitoreData) && !late && Eco.workBetween(e.fornitoreData, e.date) <= 2;
      h += '<div class="evr2' + (late ? ' bad' : '') + '"><span><b>Consegna del fornitore</b> · ' + (isYmd(e.fornitoreData) ? (late ? 'il ' + esc(dayLabel(e.fornitoreData)) + ': arriva troppo tardi per il collaudo' : 'il ' + esc(dayLabel(e.fornitoreData)) + (near ? ', a ridosso del collaudo' : ', in tempo')) : 'data non indicata') + '</span>' +
        '<input type="date" id="ev-forn" data-evforn="' + id + '" value="' + esc(e.fornitoreData || '') + '" aria-label="Consegna prevista dal fornitore" style="min-height:38px"></div>';
    }
    if (EV_DONE(e)) {
      h += '<div class="evr2 ' + (e.esito === 'collaudato' ? 'ok' : 'bad') + '"><span><b>' + (e.esito === 'collaudato' ? 'Collaudato' : 'Respinto') + '</b> il ' + esc(dayLabel(e.esitoData || e.date)) + (e.esitoNote ? ': ' + esc(e.esitoNote) : '') + '</span>' +
        '<button type="button" class="btn ghost small" data-act="ev-esito-undo" data-id="' + id + '">Cambia esito</button></div>' +
        (e.esito === 'respinto' ? '<p class="hint" style="margin:0">I pezzi di questo collaudo sono tornati “da pianificare” nell’ordine: pianifica il nuovo collaudo (con “Solo in calendario” se le etichette sono già pronte).</p>' : '');
    } else if (e.date <= shiftYmd(tod, 7)) {
      h += '<div class="evesito"><b>Esito del collaudo</b>' +
        '<label class="l" for="ev-esd">Data effettiva</label><input type="date" id="ev-esd" value="' + esc(e.date <= tod ? e.date : tod) + '">' +
        '<label class="l" for="ev-esn">Note (se respinto)</label><input type="text" id="ev-esn" placeholder="es. vetroresina non conforme">' +
        '<div class="row" style="margin:0"><button type="button" class="btn small primary" data-act="ev-esito" data-v="collaudato" data-id="' + id + '">Collaudato</button><button type="button" class="btn small" data-act="ev-esito" data-v="respinto" data-id="' + id + '">Respinto</button></div></div>';
    }
    return h + '</div>';
  }
  async function evPatch(id, patch, ok) {
    try { await patchDoc('events', id, Object.assign({ updatedAt: nowIso() }, patch)); refreshAll(); paintPanel(true); if (ok) notice('ok', ok); }
    catch (e) { notice('bad', 'Non sono riuscito a salvare' + errText(e) + '.', true); }
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act, e = b.dataset.id ? eventById(b.dataset.id) : null;
    if (a === 'ev-avv' && e) evPatch(e.id, { avvisoInviato: todayStr() }, 'Avviso del collaudo ' + e.matricola + ' del ' + dayLabel(e.date) + ' segnato come inviato.');
    else if (a === 'ev-avv-undo' && e) evPatch(e.id, { avvisoInviato: null });
    else if (a === 'ev-esito' && e) {
      const din = document.getElementById('ev-esd'), d = din && b.closest('#calPanel') ? din.value : (e.date <= todayStr() ? e.date : todayStr());
      if (!isYmd(d) || d > todayStr()) return notice('bad', 'La data effettiva del collaudo non può essere nel futuro.', true);
      const nin = document.getElementById('ev-esn'), note = nin && b.closest('#calPanel') ? nin.value.trim() : '';
      evPatch(e.id, { esito: b.dataset.v, esitoData: d, esitoNote: note || null }, (b.dataset.v === 'collaudato' ? 'Collaudo segnato come collaudato.' : 'Collaudo segnato come respinto: i pezzi tornano da pianificare.'));
    } else if (a === 'ev-esito-undo' && e) evPatch(e.id, { esito: null, esitoData: null, esitoNote: null });
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.evforn) evPatch(t.dataset.evforn, { fornitoreData: isYmd(t.value) ? t.value : null });
    if (t.id === 'riepM') { RIEP.m = t.value; paintRiep(); }
  });

  /* ---------- riepilogo del mese ---------- */
  const RIEP = { m: '' };
  function riepCalc(ym) {
    const tod = todayStr(), by = new Map(), T = { n: 0, pz: 0, ok: 0, okPz: 0, rej: 0, rejPz: 0, senza: 0, spost: 0, late: 0, lateDays: 0 };
    state.db.events.forEach((e) => {
      if (!isYmd(e.date) || effDate(e).slice(0, 7) !== ym) return;
      const o = e.orderId ? orderById(e.orderId) : null, q = evTotal(e), d = effDate(e);
      const R = by.get(e.matricola) || { mat: e.matricola, n: 0, pz: 0, ok: 0, okPz: 0, rej: 0, rejPz: 0, senza: 0, spost: 0, late: 0, lateDays: 0 };
      [R, T].forEach((x) => {
        x.n++; x.pz += q;
        if (e.esito === 'collaudato') { x.ok++; x.okPz += q; }
        else if (e.esito === 'respinto') { x.rej++; x.rejPz += q; }
        else if (e.date < tod) x.senza++;
        if (e.spostamenti) x.spost++;
        if (o && isYmd(o.due) && d > o.due) { x.late++; x.lateDays += daysBetween(o.due, d); }
      });
      by.set(e.matricola, R);
    });
    return { T: T, rows: Array.from(by.values()).sort((a, b) => String(a.mat).localeCompare(String(b.mat))) };
  }
  function riepMonths() {
    const set = new Set(state.db.events.filter((e) => isYmd(e.date)).map((e) => effDate(e).slice(0, 7)));
    set.add(todayStr().slice(0, 7));
    return Array.from(set).sort().reverse();
  }
  const ymLabel = (ym) => C.MESI[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);
  function paintRiep() {
    const host = $('#riepHost'), sel = $('#riepM'); if (!host || !sel) return;
    const ms = riepMonths(); if (!RIEP.m || !ms.includes(RIEP.m)) RIEP.m = todayStr().slice(0, 7);
    const opts = ms.map((m) => '<option value="' + m + '"' + (m === RIEP.m ? ' selected' : '') + '>' + esc(ymLabel(m)) + '</option>').join('');
    if (sel._o !== opts) { sel._o = opts; sel.innerHTML = opts; }
    const R = riepCalc(RIEP.m), T = R.T;
    const k = (cls, n, t) => '<div class="' + cls + '"><b>' + n + '</b><span class="meta">' + t + '</span></div>';
    setHtml(host, !T.n ? '<p class="empty">Nessun collaudo in ' + esc(ymLabel(RIEP.m).toLowerCase()) + '.</p>' :
      '<div class="riep-k">' + k('', T.n, 'collaudi') + k('ok', nf.format(T.okPz), 'pezzi collaudati (' + T.ok + ')') + k(T.rej ? 'bad' : '', T.rej, 'respinti' + (T.rej ? ' · ' + nf.format(T.rejPz) + ' pz' : '')) +
      k(T.spost ? 'warn' : '', T.spost, 'spostati') + k(T.late ? 'bad' : '', T.late, 'oltre la scadenza' + (T.late ? ' · ' + Math.round(T.lateDays / T.late) + ' gg in media' : '')) + k(T.senza ? 'warn' : '', T.senza, 'senza esito') + '</div>' +
      '<div class="scroll"><table><thead><tr><th>Matricola</th><th class="r">Collaudi</th><th class="r">Pezzi</th><th class="r">Collaudati</th><th class="r">Respinti</th><th class="r">Spostati</th><th class="r">Oltre scadenza</th><th class="r">Senza esito</th></tr></thead><tbody>' +
      R.rows.map((x) => '<tr><td><b class="mono">' + esc(x.mat) + '</b> <span class="meta">' + esc((rec(x.mat) || {}).descrizione || '') + '</span></td><td class="r num">' + x.n + '</td><td class="r num">' + nf.format(x.pz) + '</td><td class="r num">' + nf.format(x.okPz) +
        '</td><td class="r num">' + (x.rej || '—') + '</td><td class="r num">' + (x.spost || '—') + '</td><td class="r num">' + (x.late ? x.late + ' (' + Math.round(x.lateDays / x.late) + ' gg)' : '—') + '</td><td class="r num">' + (x.senza || '—') + '</td></tr>').join('') + '</tbody></table></div>');
  }
  async function riepCsv() {
    const R = riepCalc(RIEP.m), q = (v) => typeof v === 'number' ? String(v) : '"' + String(v).replace(/"/g, '""') + '"';
    const head = ['Matricola', 'Descrizione', 'Collaudi', 'Pezzi', 'Collaudati', 'Pezzi collaudati', 'Respinti', 'Pezzi respinti', 'Spostati', 'Oltre scadenza', 'Giorni medi di ritardo', 'Senza esito'];
    const rows = R.rows.concat([Object.assign({ mat: 'Totale' }, R.T)]).map((x) => [x.mat, x.mat === 'Totale' ? '' : (rec(x.mat) || {}).descrizione || '', x.n, x.pz, x.ok, x.okPz, x.rej, x.rejPz, x.spost, x.late, x.late ? Math.round(x.lateDays / x.late) : 0, x.senza]);
    const text = [head].concat(rows).map((r) => r.map(q).join(';')).join('\r\n') + '\r\n';
    const name = 'Riepilogo collaudi - ' + ymLabel(RIEP.m) + '.csv';
    try { if (dlh) await dlh.save({ filename: name, data: C.utf8Bom(text) }); else throw new Error('download non disponibile'); notice('ok', 'Riepilogo scaricato: ' + name); }
    catch (e) { if (!(e && e.code === 'declined')) notice('bad', 'Non sono riuscito a scaricare il riepilogo' + errText(e) + '.', true); }
  }
  document.addEventListener('click', (ev) => { const b = ev.target.closest('[data-act=riep-csv]'); if (b) riepCsv(); });

  /* ---------- ristampa delle etichette di una destinazione o di un pallet ---------- */
  const RP = { run: null };
  function rpOptions(run) {
    const out = [];
    run.lines.forEach((l, li) => {
      if (l.box) {
        const p = C.boxPlan(l, l.firstSerial, l.firstPallet);
        p.blocks.forEach((b, bi) => out.push({ v: li + '|d|' + bi, t: l.matricola + ' · ' + (b.name || 'destinazione') + ' (scatole ' + range(b.firstSerial, b.lastSerial) + ')' }));
        p.rows.forEach((x, ri) => out.push({ v: li + '|p|' + ri, t: l.matricola + ' · pallet ' + C.palSerial(run.anno, x.pallet) + ' (' + (x.dest || '') + ', scatole ' + range(x.from, x.to) + ')' }));
      } else {
        const p = C.planLine(l, l.firstSerial, l.firstPallet);
        p.blocks.forEach((b, bi) => out.push({ v: li + '|d|' + bi, t: l.matricola + ' · ' + (b.name || 'destinazione') + ' (pianali ' + range(b.firstPallet, b.lastPallet) + ')' }));
        p.rows.forEach((x, ri) => out.push({ v: li + '|p|' + ri, t: l.matricola + ' · pianale ' + x.pallet + ' (' + (x.dest || '') + ', seriali ' + range(x.from, x.to) + ')' }));
      }
    });
    return out;
  }
  function rpFile(run, v) {
    const [li, kind, ix] = v.split('|'), l = run.lines[+li], i = +ix;
    const title = String(run.mese || '').slice(0, 3).toLowerCase() + '-' + run.anno;
    const clean = (x) => String(x).replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
    if (l.box) {
      const p = C.boxPlan(l, l.firstSerial, l.firstPallet);
      let blk;
      if (kind === 'd') blk = p.blocks[i];
      else {
        const x = p.rows[i], b = p.blocks.find((bb) => x.from >= bb.firstSerial && x.to <= bb.lastSerial), pz = l.box.pz;
        const nb = b.lastSerial - b.firstSerial + 1, lastBox = b.pcs - (nb - 1) * pz;
        blk = { name: x.dest, pcs: x.qty * pz - (x.to === b.lastSerial ? pz - lastBox : 0), firstSerial: x.from, lastSerial: x.to, firstPallet: x.pallet, lastPallet: x.pallet, sizes: [x.qty] };
      }
      const what = kind === 'd' ? blk.name : 'pallet ' + C.palSerial(run.anno, blk.firstPallet);
      return { kind: 'Excel', dir: 'prod', sub: l.matricola, name: clean(l.matricola + ' - ' + l.oda + ' - ' + what + ' - ' + run.mese) + '.xlsx', build: () => C.buildBoxXlsx(TPL, [{ line: l, plan: { blocks: [blk] } }], title, run.anno, title) };
    }
    const p = C.planLine(l, l.firstSerial, l.firstPallet);
    const rows = kind === 'd' ? p.rows.filter((x) => x.dest === p.blocks[i].name) : [p.rows[i]];
    const what = kind === 'd' ? p.blocks[i].name : 'pianale ' + p.rows[i].pallet;
    return { kind: 'Excel', dir: 'prod', sub: l.matricola, name: clean(l.matricola + ' - ' + l.oda + ' - ' + what + ' - ' + run.mese) + '.xlsx', build: () => C.buildXlsx(TPL, l, { rows: rows }, l.sheetName) };
  }
  function rpHtml(run) {
    const o = rpOptions(run);
    return '<div class="rpart"><div class="field" style="flex:1 1 320px;min-width:0"><label class="l" for="rp-sel">Cosa ristampare</label><select id="rp-sel">' +
      o.map((x) => '<option value="' + esc(x.v) + '">' + esc(x.t) + '</option>').join('') + '</select></div>' +
      '<button type="button" class="btn small primary" data-act="rp-go" data-run="' + esc(run.id) + '">Scarica Excel</button><button type="button" class="btn ghost small" data-act="rp-close">Chiudi</button><span class="fstat"></span></div>';
  }
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'rp-open') { RP.run = RP.run === b.dataset.run ? null : b.dataset.run; paintRuns(); const s = document.getElementById('rp-sel'); if (s) s.focus(); }
    else if (b.dataset.act === 'rp-close') { RP.run = null; paintRuns(); }
    else if (b.dataset.act === 'rp-go') {
      const run = state.db.runs.find((r) => r.id === b.dataset.run), v = (document.getElementById('rp-sel') || {}).value;
      if (!run || !v) return;
      await saveFile(rpFile(run, v), b.parentElement.querySelector('.fstat'));
    }
  });

  /* ---------- calendario: vista a elenco (predefinita sul telefono) ---------- */
  function calListMode() {
    const v = lsGet('ss-cal-vista');
    return v === 'elenco' ? true : v === 'mese' ? false : window.innerWidth < 700;
  }

  /* ---------- pagina Oggi ---------- */
  const nextWork = (d) => { let x = shiftYmd(d, 1); for (let i = 0; i < 10 && !Eco.isWork(x); i++) x = shiftYmd(x, 1); return x; };
  function ogRow(cls, main, sub, btns) {
    return '<div class="og-row ' + (cls || '') + '"><div class="grow">' + main + (sub ? '<br><span class="meta">' + sub + '</span>' : '') + '</div>' + (btns || '') + '</div>';
  }
  const evMain = (e) => '<b class="mono">' + esc(e.matricola) + '</b> <span class="meta">' + esc((rec(e.matricola) || {}).descrizione || '') + '</span>';
  function paintOggi() {
    const T = $('#oggiTodo'), R = $('#oggiRisk'), P = $('#oggiProd'); if (!T) return;
    if (loadingNew()) { setHtml(T, '<p class="empty">Carico…</p>'); return; }
    const tod = todayStr(), nx = nextWork(tod), EA = evAlerts(), dr = dueReminders(), mr = monthReminder();
    const live = state.db.events.filter((e) => isYmd(e.date) && !EV_DONE(e));
    const now = live.filter((e) => e.date === tod || e.date === nx).sort((a, b) => a.date.localeCompare(b.date));
    const toFiles = live.filter((e) => e.status !== 'files' && e.date >= tod && e.date <= shiftYmd(tod, 10)).sort((a, b) => a.date.localeCompare(b.date));
    const open = (id) => '<button type="button" class="btn ghost small" data-act="ev-go" data-id="' + esc(id) + '">Apri</button>';
    let h = '<div class="sec-head"><div><h2>Da fare oggi</h2><p class="sub">' + esc(dayLabel(tod, true)) + '</p></div></div>';
    const n = EA.length + toFiles.length + dr.length + (mr ? 1 : 0);
    if (now.length) h += '<p class="og-h">Collaudi di oggi e del ' + esc(dayLabel(nx)) + '</p><div class="og-list">' + now.map((e) => ogRow(e.date === tod ? 'warn' : '', evMain(e), esc(dayLabel(e.date, true)) + ' · ODA ' + esc(e.oda) + ' · ' + nf.format(evTotal(e)) + ' pz' + (e.status === 'files' ? ' · file creati' : ' · file da creare'), open(e.id))).join('') + '</div>';
    const av = EA.filter((x) => x.k === 'avviso'), es = EA.filter((x) => x.k === 'esito'), fo = EA.filter((x) => x.k === 'forn');
    if (av.length) h += '<p class="og-h">Avvisi di collaudo da inviare</p><div class="og-list">' + av.map((x) => ogRow(x.late ? 'bad' : 'warn', evMain(x.e), 'entro ' + esc(dayLabel(x.entro, true)) + (x.late ? ' · in ritardo' : '') + ' · collaudo ' + esc(dayLabel(x.e.date)) + ' · ODA ' + esc(x.e.oda), '<button type="button" class="btn small" data-act="ev-avv" data-id="' + esc(x.e.id) + '">Inviato</button>' + open(x.e.id))).join('') + '</div>';
    if (es.length) h += '<p class="og-h">Collaudi passati: segna l’esito</p><div class="og-list">' + es.map((x) => ogRow('warn', evMain(x.e), 'collaudo ' + esc(dayLabel(x.e.date, true)) + ' · ' + nf.format(evTotal(x.e)) + ' pz', '<button type="button" class="btn small" data-act="ev-esito" data-v="collaudato" data-id="' + esc(x.e.id) + '">Collaudato</button>' + open(x.e.id))).join('') + '</div>';
    if (toFiles.length) h += '<p class="og-h">File da creare (prossimi 10 giorni)</p><div class="og-list">' + toFiles.map((e) => ogRow(e.date <= nx ? 'bad' : '', evMain(e), 'collaudo ' + esc(dayLabel(e.date, true)) + ' · ODA ' + esc(e.oda) + ' · ' + nf.format(evTotal(e)) + ' pz', '<button type="button" class="btn small primary" data-act="load-day" data-date="' + esc(e.date) + '" data-id="' + esc(e.id) + '">Crea i file</button>' + open(e.id))).join('') + '</div>';
    if (fo.length) h += '<p class="og-h">Prodotti esterni in ritardo</p><div class="og-list">' + fo.map((x) => ogRow('bad', evMain(x.e), 'fornitore ' + esc(dayLabel(x.e.fornitoreData)) + ' · collaudo ' + esc(dayLabel(x.e.date)), open(x.e.id))).join('') + '</div>';
    if (dr.length) h += '<p class="og-h">Scadenze da pianificare</p><div class="og-list">' + dr.map((x) => { const di = dueInfo(x.o, x.st.left); return ogRow(di ? di.cls : '', '<b class="mono">' + esc(x.o.matricola) + '</b> <span class="meta">ODA ' + esc(x.o.oda) + '</span>', 'da pianificare ' + nf.format(x.st.left) + ' pz' + (di ? ' · ' + esc(di.text) : ''), '<button type="button" class="btn small primary" data-act="plan-order" data-order="' + esc(x.o.id) + '">Pianifica</button>'); }).join('') + '</div>';
    if (mr) h += '<p class="og-h">Inizio mese</p><div class="og-list">' + ogRow('warn', '<b>Inserisci gli ordini di ' + esc(C.MESI[mr.m].toLowerCase()) + '</b>', 'finora ' + nf.format(mr.inserted) + ' inseriti', '<button type="button" class="btn small primary" data-act="new-order">+ Nuovo ordine</button><button type="button" class="btn ghost small" data-act="month-done">Fatto</button>') + '</div>';
    if (!n && !now.length) h += '<p class="og-done"><span aria-hidden="true">✓</span> Niente da fare: avvisi inviati, file pronti, scadenze pianificate.</p>';
    setHtml(T, h);
    const bd = $('#oggiBadge'); if (bd) { bd.hidden = !n; bd.textContent = String(n); }
    // a rischio
    let r = '<div class="sec-head"><div><h2>A rischio</h2><p class="sub">Collaudi per cui i pezzi non saranno pronti in tempo.</p></div></div>';
    if (!ECO.prod) r += '<p class="meta">Le stime compaiono quando ci sono i dati della produzione (Avanzamento › Aggiorna).</p>';
    else {
      const risk = live.filter((e) => ECO.m && ECO.m.lots[e.id] && ECO.m.lots[e.id].status === 'rischio').sort((a, b) => a.date.localeCompare(b.date));
      r += risk.length ? '<div class="og-list">' + risk.map((e) => { const x = ECO.m.lots[e.id]; return ogRow('bad', evMain(e), 'collaudo ' + esc(dayLabel(e.date)) + ' · pronti per ' + esc(Eco.label(x.ready)) + (x.postNeeded && x.postNeeded > x.post ? ' · servono ' + x.postNeeded + ' postazioni' : ''), open(e.id)); }).join('') + '</div>'
        : '<p class="og-done"><span aria-hidden="true">✓</span> Nessun collaudo a rischio.</p>';
    }
    setHtml(R, r);
    // produzione dell'ultimo giorno lavorato
    let p = '<div class="sec-head"><div><h2>Produzione di ieri</h2></div></div>';
    const regs = ECO.prod && Array.isArray(ECO.prod.registrazioni) ? ECO.prod.registrazioni : null;
    if (!regs) p += '<p class="meta">I dati della produzione non sono ancora caricati (Avanzamento › Aggiorna).</p>';
    else {
      const dayOf = (t) => Eco.ymd(new Date(t)), days = Array.from(new Set(regs.map((x) => dayOf(x.ts)).filter((d) => d < tod))).sort();
      const last = days[days.length - 1];
      if (!last) p += '<p class="meta">Nessuna registrazione nei giorni scorsi.</p>';
      else {
        const by = new Map(), ops = new Map();
        regs.filter((x) => dayOf(x.ts) === last).forEach((x) => {
          const k = String(x.prodotto || ''), t = by.get(k) || { p: 0, s: 0 }; by.set(k, t);
          if (x.tipo === 'Produzione') { t.p += Number(x.pezzi) || 0; if (x.operatore) ops.set(x.operatore, (ops.get(x.operatore) || 0) + (Number(x.pezzi) || 0)); } else if (x.tipo === 'Scarto') t.s += Number(x.pezzi) || 0;
        });
        const lab = last === shiftYmd(tod, -1) ? 'ieri' : dayLabel(last, true);
        p = '<div class="sec-head"><div><h2>Produzione ' + (last === shiftYmd(tod, -1) ? 'di ieri' : 'del ' + esc(lab)) + '</h2><p class="sub">Pezzi buoni e scarti registrati in Gestione Produzione.</p></div></div>' +
          '<div class="scroll"><table><thead><tr><th>Prodotto</th><th class="r">Pezzi</th><th class="r">Scarti</th></tr></thead><tbody>' +
          Array.from(by.entries()).sort((a, b) => b[1].p - a[1].p).map(([k, t]) => '<tr><td>' + esc(k) + '</td><td class="r num">' + nf.format(t.p) + '</td><td class="r num">' + (t.s ? nf.format(t.s) : '—') + '</td></tr>').join('') + '</tbody></table></div>' +
          (ops.size ? '<p class="meta" style="margin:8px 0 0">' + Array.from(ops.entries()).map(([o, q]) => esc(o) + ' ' + nf.format(q)).join(' · ') + '</p>' : '');
      }
    }
    setHtml(P, p);
  }

  /* ---------- ricerca globale ---------- */
  function gsResults(q) {
    const t = oqNorm(q).trim(), out = []; if (!t) return out;
    const digits = q.replace(/\D/g, '');
    state.db.orders.forEach((o) => {
      const r = rec(o.matricola) || {};
      if (oqNorm([o.oda, o.matricola, r.descrizione, o.note, (o.pos || []).join(' '), orderLines(o).map((l) => l.name).join(' ')].join(' ')).includes(t))
        out.push({ k: 'Ordine', cls: '', t: '<b class="mono">ODA ' + esc(o.oda) + '</b> · ' + esc(o.matricola) + ' ' + esc(r.descrizione || ''), s: (isYmd(o.due) ? 'scadenza ' + dayLabel(o.due) + ' · ' : '') + { open: 'da pianificare', planned: 'pianificato', archive: 'archivio' }[ordState(o)], act: 'gs-ord', id: o.id });
    });
    state.db.events.forEach((e) => {
      if (oqNorm([e.oda, e.matricola, e.avviso, e.operatore].join(' ')).includes(t) || (e.avviso && digits && String(e.avviso).replace(/^0+/, '') === digits.replace(/^0+/, '')))
        out.push({ k: 'Collaudo', cls: 'ev', t: '<b>' + esc(dayLabel(e.date)) + '</b> · ' + esc(e.matricola) + ' · ODA ' + esc(e.oda), s: (e.avviso ? 'avviso ' + e.avviso + ' · ' : '') + nf.format(evTotal(e)) + ' pz' + (e.esito ? ' · ' + e.esito : ''), act: 'ev-go', id: e.id });
    });
    Object.keys(state.db.serials).forEach((m) => { const r = rec(m) || {}; if (oqNorm(m + ' ' + (r.descrizione || '')).includes(t)) out.push({ k: 'Matricola', cls: '', t: '<b class="mono">' + esc(m) + '</b> ' + esc(r.descrizione || ''), s: 'ultimo seriale ' + (isInt(r.last) ? nf.format(r.last) : '—'), act: 'edit-mat', mat: m }); });
    /* seriale (o barcode intero): in quale lotto, destinazione e pianale */
    if (digits && digits.length >= 1) {
      const n = Number(digits.length > 10 ? digits.slice(-10) : digits);
      state.db.runs.forEach((run) => (run.lines || []).forEach((l) => {
        if (digits.length > 10 && digits.indexOf(String(l.matricola)) < 0) return;
        if (!(n >= l.firstSerial && n <= l.lastSerial)) return;
        const p = l.box ? C.boxPlan(l, l.firstSerial, l.firstPallet) : C.planLine(l, l.firstSerial, l.firstPallet), row = p.rows.find((x) => n >= x.from && n <= x.to);
        out.push({ k: l.box ? 'Scatola' : 'Seriale', cls: 'ser', t: '<b class="mono">' + nf.format(n) + '</b> · ' + esc(l.matricola) + ' · ' + esc(row ? row.dest || '' : ''),
          s: (l.box ? 'pallet ' + C.palSerial(run.anno, row.pallet) : 'pianale ' + (row ? row.pallet : '?')) + ' · ODA ' + l.oda + ' · ' + (run.avviso ? 'avviso ' + run.avviso + ' · ' : '') + 'anno ' + run.anno + ' · ' + run.mese, act: 'gs-run', id: run.id });
      }));
    }
    return out.slice(0, 40);
  }
  function gsPaint() {
    const q = $('#gq').value, list = gsResults(q), host = $('#gres');
    host.innerHTML = !q.trim() ? '<p class="meta">Scrivi un ODA, una matricola, un numero di avviso o un seriale (anche il barcode intero).</p>'
      : list.length ? list.map((x, i) => '<button type="button" class="gr ' + x.cls + '" data-act="' + x.act + '" data-gs="1"' + (x.id ? ' data-id="' + esc(x.id) + '"' : '') + (x.mat ? ' data-mat="' + esc(x.mat) + '"' : '') + '><span class="k">' + esc(x.k) + '</span><span>' + x.t + '<br><span class="meta">' + esc(x.s) + '</span></span></button>').join('')
      : '<p class="meta">Nessun risultato.</p>' + (state.db.runs.length >= 30 ? '<p class="meta">I seriali si cercano negli ultimi 30 lotti dello Storico.</p>' : '');
  }
  function gsOpen(on) { const p = $('#searchPanel'); p.hidden = !on; if (on) { const i = $('#gq'); i.focus(); i.select(); gsPaint(); } }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'gs-open') gsOpen($('#searchPanel').hidden);
    else if (a === 'gs-close') gsOpen(false);
    else if (b.dataset.gs) {
      gsOpen(false);
      if (a === 'gs-ord') { const o = orderById(b.dataset.id); if (!o) return; state.ord.filter = ordState(o); state.ord.open = o.id; showView('ordini'); paintOrders(false); setTimeout(() => { const el = document.querySelector('#ordHost [data-act=ord-toggle][data-id="' + o.id + '"]'); if (el) el.scrollIntoView({ block: 'center' }); }, 50); }
      else if (a === 'gs-run') { showView('storico'); }
    } else if (a === 'cal-vista') { lsSet('ss-cal-vista', calListMode() ? 'mese' : 'elenco'); paintCal(); }
    else if (a === 'notice-more') { const d = b.parentElement.querySelector('.ndet'); if (d) { d.hidden = !d.hidden; b.textContent = d.hidden ? 'Dettagli' : 'Meno'; clearTimeout(noticeTimer); } }
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'gq') gsPaint(); });
  let rsT = null, rsW = window.innerWidth;
  window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if ((rsW < 700) !== (window.innerWidth < 700) && !lsGet('ss-cal-vista')) paintCal(); rsW = window.innerWidth; }, 150); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) { ev.preventDefault(); gsOpen(true); }
    else if (ev.key === 'Escape' && !$('#searchPanel').hidden) gsOpen(false);
    else if (ev.key === 'Enter' && ev.target.id === 'gq') { const f = document.querySelector('#gres .gr'); if (f) f.click(); }
  });

  /* ---------- etichette Zebra ---------- */
  /* etichetta di ZebraDesigner (sample.nlbl): 10x2,5 cm, Code 128 (set A) con barre da 2 punti a x=89 y=37 alto 80, sotto le 25 cifre centrate a 12 punti; velocità 6, scurezza 30 */
  const LAB_HEAD = '^XA\n~TA000\n~JSN\n^LT0\n^MNW\n^MTT\n^PON\n^PMN\n^LH0,0\n^JMA\n^PR6,6\n~SD30\n^LRN\n^CI27\n^PA0,1,1,0\n^XZ\n';
  const LAB_DEFAULT = '^XA\n^MMT\n^PW799\n^LL200\n^LS0\n^FO89,37^BY2^BCN,80,N,N,N,N^FD>9{BARCODE}^FS\n^FO0,126^A0N,34,30^FB799,1,0,C^FD{BARCODE}^FS\n^PQ{COPIE},0,1,Y\n^XZ';
  const LAB = { run: null, line: 0, what: 'all', from: '', to: '', copies: 1, cfg: { conn: 'ip', ip: '', share: 'ZEBRA', template: '' } };
  const labTpl = () => (String(LAB.cfg.template || '').trim() ? LAB.cfg.template : LAB_DEFAULT);
  const zplSafe = (v) => String(v == null ? '' : v).replace(/[\^~]/g, ' ');
  function labRows(run, l) {
    /* una riga per seriale, con destinazione e pianale */
    const p = C.planLine(l, l.firstSerial, l.firstPallet), out = [];
    p.rows.forEach((x) => { for (let n = x.from; n <= x.to; n++) out.push({ n: n, dest: x.dest || '', pal: x.pallet }); });
    return out;
  }
  function labPick(run, l) {
    const rows = labRows(run, l), w = LAB.what;
    if (w === 'all') return rows;
    if (w.indexOf('d:') === 0) return rows.filter((x) => x.dest === w.slice(2));
    if (w.indexOf('p:') === 0) return rows.filter((x) => String(x.pal) === w.slice(2));
    const a = C.toInt(LAB.from), b = C.toInt(LAB.to);
    return rows.filter((x) => isInt(a) && isInt(b) ? x.n >= Math.min(a, b) && x.n <= Math.max(a, b) : false);
  }
  function labZpl(run, l, rows) {
    const r = rec(l.matricola) || {}, cfg = { prefix: l.prefix || run.prefix, fixedDigit: run.fixedDigit }, tpl = labTpl();
    return LAB_HEAD.replace(/\n/g, '\r\n') + rows.map((x) => tpl
      .replace(/\{BARCODE\}/g, C.barcodeCliente(l.matricola, x.n, run.anno, cfg)).replace(/\{MATRICOLA\}/g, zplSafe(l.matricola))
      .replace(/\{DESCRIZIONE\}/g, zplSafe(String(r.descrizione || '').slice(0, 34))).replace(/\{SERIALE\}/g, String(x.n)).replace(/\{ANNO\}/g, zplSafe(run.anno))
      .replace(/\{DESTINAZIONE\}/g, zplSafe(x.dest)).replace(/\{PIANALE\}/g, String(x.pal)).replace(/\{ODA\}/g, zplSafe(l.oda)).replace(/\{AVVISO\}/g, zplSafe(run.avviso || '')).replace(/\{COPIE\}/g, String(labCopies()))).join('\r\n') + '\r\n';
  }
  const labCopies = () => { const n = C.toInt(String(LAB.copies)); return n >= 1 && n <= 99 ? n : 1; };
  const labRuns = () => state.db.runs.filter((r) => (r.lines || []).some((l) => !l.box));
  const rangesTxt = (list) => list.map((x) => range(x.from, x.to)).join(', ');
  function labPrinted(run, li) { return (run.stampe || []).filter((x) => x.l === li); }
  function paintLab(force) {
    const host = $('#labHost'); if (!host) return;
    if (!force && host.contains(document.activeElement) && document.activeElement.matches('input')) return;
    const runs = labRuns();
    if (state.db.mode !== 'on') { setHtml(host, '<p class="empty">I dati non sono collegati in questa vista.</p>'); return; }
    if (!runs.length) { setHtml(host, '<p class="empty">Nessun lotto registrato: le etichette si stampano dai lotti creati in “Crea file” o dal calendario.</p>'); return; }
    if (!runs.some((r) => r.id === LAB.run)) { LAB.run = runs[0].id; LAB.line = 0; LAB.what = 'all'; }
    const run = runs.find((r) => r.id === LAB.run), lines = run.lines.map((l, i) => ({ l: l, i: i })).filter((x) => !x.l.box);
    if (!lines.some((x) => x.i === LAB.line)) LAB.line = lines[0].i;
    const l = run.lines[LAB.line], rows = labRows(run, l), pick = labPick(run, l), pr = labPrinted(run, LAB.line);
    const dests = Array.from(new Set(rows.map((x) => x.dest))), pals = Array.from(new Set(rows.map((x) => x.pal)));
    const opt = (v, t) => '<option value="' + esc(v) + '"' + (LAB.what === v ? ' selected' : '') + '>' + esc(t) + '</option>';
    const first = pick[0], cfg = { prefix: l.prefix || run.prefix, fixedDigit: run.fixedDigit };
    let h = '<div class="lab-sel"><div class="field" style="flex:1 1 320px;min-width:0"><label class="l" for="labRun">Lotto</label><select id="labRun">' +
      runs.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === LAB.run ? ' selected' : '') + '>' + esc(new Date(r.createdAt).toLocaleDateString('it-IT')) + (r.avviso ? ' · Avv. ' + esc(r.avviso) : '') + ' · ' + esc(r.lines.filter((x) => !x.box).map((x) => x.matricola).join(', ')) + ' · ' + esc(r.mese) + '</option>').join('') + '</select></div></div>';
    h += '<div class="lab-lines">' + lines.map((x) => { const p = labPrinted(run, x.i), n = x.l.lastSerial - x.l.firstSerial + 1;
      return '<label class="lab-line' + (x.i === LAB.line ? ' on' : '') + (p.length ? ' done' : '') + '"><input type="radio" name="labLine" value="' + x.i + '"' + (x.i === LAB.line ? ' checked' : '') + '><span class="grow"><b class="mono">' + esc(x.l.matricola) + '</b> <span class="meta">' + esc((rec(x.l.matricola) || {}).descrizione || '') + '</span><br><span class="meta">ODA ' + esc(x.l.oda) + ' · seriali ' + range(x.l.firstSerial, x.l.lastSerial) + ' · ' + nf.format(n) + ' etichette' + (p.length ? ' · già inviati: ' + esc(rangesTxt(p)) : '') + '</span></span></label>'; }).join('') + '</div>';
    if (run.lines.some((x) => x.box)) h += '<p class="hint" style="margin:0">Le righe dei prodotti a scatole non hanno etichette per pezzo: per quelle c’è l’Excel delle scatole.</p>';
    h += '<div class="lab-sel"><div class="field" style="flex:1 1 280px;min-width:0"><label class="l" for="labWhat">Cosa stampare</label><select id="labWhat">' + opt('all', 'Tutto: ' + nf.format(rows.length) + ' etichette') +
      dests.map((d) => opt('d:' + d, 'Destinazione ' + (d || '—') + ' (' + rows.filter((x) => x.dest === d).length + ')')).join('') +
      pals.map((p) => opt('p:' + p, 'Pianale ' + p + ' (' + rows.filter((x) => x.pal === p).length + ')')).join('') + opt('r', 'Da un seriale a un altro…') + '</select></div>' +
      '<div class="field"><label class="l" for="labCopies">Copie per seriale</label><input type="number" id="labCopies" min="1" max="99" value="' + labCopies() + '" style="width:90px"></div>' +
      (LAB.what === 'r' ? '<div class="field"><label class="l" for="labFrom">Dal seriale</label><input type="text" id="labFrom" inputmode="numeric" value="' + esc(LAB.from) + '" placeholder="' + l.firstSerial + '" style="width:120px"></div><div class="field"><label class="l" for="labTo">al seriale</label><input type="text" id="labTo" inputmode="numeric" value="' + esc(LAB.to) + '" placeholder="' + l.lastSerial + '" style="width:120px"></div>' : '') + '</div>';
    h += '<div class="lab-sel" style="align-items:flex-start">' + (first ? labPrevHtml(run, l, first, cfg) : '') + '<div style="flex:1 1 240px;display:flex;flex-direction:column;gap:8px">' +
      '<p style="margin:0"><b>' + nf.format(pick.length * labCopies()) + '</b> etichette' + (labCopies() > 1 ? ' (' + nf.format(pick.length) + ' seriali × ' + labCopies() + ' copie)' : '') + (pick.length ? ' · seriali ' + range(pick[0].n, pick[pick.length - 1].n) : '') + '</p>' +
      (pr.length && pick.some((x) => pr.some((p) => x.n >= p.from && x.n <= p.to)) ? '<p class="hint" style="margin:0;color:var(--warn)">Una parte di queste etichette risulta già inviata alla stampa: va bene per una ristampa.</p>' : '') +
      '<div class="row" style="margin:0"><button type="button" class="btn primary" data-act="lab-go"' + (pick.length ? '' : ' disabled') + '>Scarica etichette per la Zebra</button><button type="button" class="btn small" data-act="lab-test"' + (pick.length ? '' : ' disabled') + '>Etichetta di prova</button><span class="fstat" id="labStat"></span></div>' +
      '<p class="hint" style="margin:0">Poi sul PC della stampante: doppio clic su “Stampa Zebra”. ' + (LAB.cfg.conn === 'ip' && !LAB.cfg.ip ? '<b>Prima imposta l’indirizzo IP della stampante qui sotto.</b>' : '') + '</p></div></div>';
    if (pr.length) h += '<details class="pane"><summary>Già inviate alla stampa (' + pr.length + ')</summary><div class="in"><ul class="lab-hist">' + pr.slice().reverse().map((x) => '<li>' + esc(new Date(x.at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })) + ' · seriali <span class="mono">' + range(x.from, x.to) + '</span> · ' + nf.format(x.n) + ' seriali' + (x.copie > 1 ? ' × ' + x.copie + ' copie' : '') + (x.who ? ' · ' + esc(x.who) : '') + '</li>').join('') + '</ul></div></details>';
    setHtml(host, h);
  }
  function labPrevHtml(run, l, x, cfg) {
    const bc = C.barcodeCliente(l.matricola, x.n, run.anno, cfg);   /* proporzioni dell'etichetta vera: 799 x 200 punti */
    return '<div class="lab-prev" aria-label="Anteprima etichetta">' +
      '<span class="bars" style="left:11.1%;top:18.5%;width:77.6%;height:40%"></span>' +
      '<span style="left:0;right:0;text-align:center;top:62%;font-size:clamp(9px,2.2vw,14px);letter-spacing:.02em">' + esc(bc) + '</span></div>';
  }
  async function labDownload(test) {
    const run = state.db.runs.find((r) => r.id === LAB.run); if (!run) return;
    const l = run.lines[LAB.line], pick = labPick(run, l); if (!pick.length) return;
    const rows = test ? [pick[0]] : pick;
    const name = 'etichette-' + l.matricola + '-' + rows[0].n + (rows.length > 1 ? '-' + rows[rows.length - 1].n : '') + (test ? '-prova' : '') + '.zpl';
    const st = $('#labStat');
    try {
      if (!dlh) throw new Error('download non disponibile');
      await dlh.save({ filename: name, data: new TextEncoder().encode(labZpl(run, l, rows)) });
      if (st) st.textContent = 'Scaricato: ' + name;
    } catch (e) { if (st) st.textContent = e && e.code === 'declined' ? 'Non scaricato' : 'Non riuscito' + errText(e); return; }
    if (test) return;
    const rec_ = { l: LAB.line, from: rows[0].n, to: rows[rows.length - 1].n, n: rows.length, copie: labCopies(), at: nowIso(), who: window.__cloudApi ? window.__cloudApi.email() : '' };
    try { await patchDoc('runs', run.id, { stampe: (run.stampe || []).concat([rec_]) }); paintLab(); notice('ok', nf.format(rows.length) + ' etichette pronte: ora doppio clic su “Stampa Zebra” sul PC della stampante.'); }
    catch (e) { notice('warn', 'File scaricato, ma non sono riuscito a segnare le etichette come inviate' + errText(e) + '.', true); }
  }
  /* script di Windows: prende l'ultimo file di etichette scaricato, lo manda alla Zebra e lo sposta in "Etichette stampate" */
  function labBat() {
    const c = LAB.cfg, send = c.conn === 'ip'
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference=\'Stop\';$c=New-Object Net.Sockets.TcpClient;$c.Connect(\'' + c.ip + '\',9100);$s=$c.GetStream();$b=[IO.File]::ReadAllBytes($env:ZFILE);$s.Write($b,0,$b.Length);$s.Flush();Start-Sleep -Milliseconds 300;$c.Close()"'
      : 'copy /b "%ZFILE%" "\\\\localhost\\' + (c.share || 'ZEBRA') + '" >nul';
    return ['@echo off', 'chcp 65001 >nul', 'title Stampa Zebra', 'setlocal', 'set "DL=%USERPROFILE%\\Downloads"', 'set "OUT=%DL%\\Etichette stampate"',
      'if not exist "%OUT%" mkdir "%OUT%"', 'set "F="', 'for /f "delims=" %%F in (\'dir /b /a-d /o-d "%DL%\\etichette-*.zpl" 2^>nul\') do if not defined F set "F=%%F"',
      'if not defined F (', '  echo Nessun file di etichette nella cartella Download.', '  echo Scarica prima le etichette dal portale: Etichette, Scarica etichette per la Zebra.', '  pause', '  exit /b 1', ')',
      'set "ZFILE=%DL%\\%F%"', 'echo Stampo: %F%', 'echo Stampante: ' + (c.conn === 'ip' ? c.ip + ' (rete)' : '\\\\localhost\\' + (c.share || 'ZEBRA') + ' (USB condivisa)'), send,
      'if errorlevel 1 (', '  echo.', '  echo STAMPA NON RIUSCITA. Controlla che la Zebra sia accesa e collegata, poi riprova.', '  pause', '  exit /b 1', ')',
      'move /y "%ZFILE%" "%OUT%\\" >nul', 'echo Fatto: etichette inviate alla stampante.', 'timeout /t 4 >nul', ''].join('\r\n');
  }
  function paintLabCfg() {
    const host = $('#labCfg'); if (!host || host.contains(document.activeElement)) return;
    const c = LAB.cfg;
    host.innerHTML = '<div class="lab-sel"><div class="field"><label class="l" for="labConn">Collegamento</label><select id="labConn"><option value="ip"' + (c.conn === 'ip' ? ' selected' : '') + '>In rete (indirizzo IP)</option><option value="share"' + (c.conn === 'share' ? ' selected' : '') + '>USB, stampante condivisa</option></select></div>' +
      (c.conn === 'ip' ? '<div class="field"><label class="l" for="labIp">Indirizzo IP della Zebra</label><input type="text" id="labIp" inputmode="decimal" placeholder="es. 192.168.1.50" value="' + esc(c.ip || '') + '" style="width:180px"><span class="hint">Porta 9100.</span></div>'
        : '<div class="field"><label class="l" for="labShare">Nome della condivisione</label><input type="text" id="labShare" value="' + esc(c.share || 'ZEBRA') + '" style="width:160px"><span class="hint">Stampanti e scanner › Zebra › Proprietà › Condivisione.</span></div>') +
      '<button type="button" class="btn small" data-act="lab-save">Salva</button></div>' +
      '<div class="row" style="margin:0"><button type="button" class="btn primary small" data-act="lab-bat"' + (c.conn === 'ip' && !c.ip ? ' disabled title="Indica prima l’IP"' : '') + '>Scarica “Stampa Zebra.bat”</button><span class="hint">Una volta sola, sul PC vicino alla stampante: mettilo sul desktop. Se Chrome lo segnala, scegli “Mantieni”.</span></div>' +
      '<details class="pane"><summary>Formato dell’etichetta (ZPL)</summary><div class="in"><p class="hint" style="margin:0">Etichetta di 799×200 punti (10×2,5 cm a 203 dpi), come in ZebraDesigner. Campi: {BARCODE} {MATRICOLA} {DESCRIZIONE} {SERIALE} {ANNO} {DESTINAZIONE} {PIANALE} {ODA} {AVVISO} {COPIE}. Cifre a 12 punti, velocità 6, scurezza 30.</p>' +
      '<textarea id="labTpl" spellcheck="false">' + esc(labTpl()) + '</textarea><div class="row" style="margin:0"><button type="button" class="btn small" data-act="lab-save">Salva formato</button><button type="button" class="btn ghost small" data-act="lab-tpl-reset">Torna al formato di ZebraDesigner</button></div></div></details>';
  }
  async function labSave(reset) {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : null; };
    const next = Object.assign({}, LAB.cfg);
    if (g('labConn') != null) next.conn = g('labConn');
    if (g('labIp') != null) next.ip = g('labIp');
    if (g('labShare') != null) next.share = g('labShare') || 'ZEBRA';
    if (reset) next.template = ''; else if (g('labTpl') != null) next.template = g('labTpl') === LAB_DEFAULT ? '' : document.getElementById('labTpl').value;
    if (next.conn === 'ip' && next.ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(next.ip)) return notice('bad', 'L’indirizzo IP deve essere come 192.168.1.50.', true);
    if (next.template && !/\^XA[\s\S]*\{BARCODE\}[\s\S]*\^XZ/.test(next.template)) return notice('bad', 'Il formato deve cominciare con ^XA, finire con ^XZ e contenere {BARCODE}.', true);
    LAB.cfg = next; document.activeElement && document.activeElement.blur && document.activeElement.blur();
    await writeDoc('meta/stampa', Object.assign({}, next, { updatedAt: nowIso() }), 'Impostazioni della stampante salvate.');
    paintLabCfg(); paintLab();
  }
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'labRun') { LAB.run = t.value; LAB.line = -1; LAB.what = 'all'; paintLab(true); }
    else if (t.name === 'labLine') { LAB.line = +t.value; LAB.what = 'all'; paintLab(true); }
    else if (t.id === 'labWhat') { LAB.what = t.value; paintLab(true); }
    else if (t.id === 'labConn') { LAB.cfg = Object.assign({}, LAB.cfg, { conn: t.value }); t.blur(); paintLabCfg(); }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'labCopies') { LAB.copies = t.value; clearTimeout(LAB.t); LAB.t = setTimeout(() => { t.blur(); paintLab(); const n = document.getElementById('labCopies'); if (n) n.focus(); }, 400); return; }
    if (t.id === 'labFrom' || t.id === 'labTo') { LAB[t.id === 'labFrom' ? 'from' : 'to'] = t.value; clearTimeout(LAB.t); LAB.t = setTimeout(() => { const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart; t.blur(); paintLab(); const n = id && document.getElementById(id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* nessuno */ } } }, 350); }
  });
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'lab-go') labDownload(false);
    else if (a === 'lab-test') labDownload(true);
    else if (a === 'lab-save') labSave(false);
    else if (a === 'lab-tpl-reset') labSave(true);
    else if (a === 'lab-bat') {
      try { if (!dlh) throw new Error('download non disponibile'); await dlh.save({ filename: 'Stampa Zebra.bat', data: new TextEncoder().encode(labBat()) }); notice('ok', 'Scaricato “Stampa Zebra.bat”: spostalo sul desktop del PC vicino alla Zebra.'); }
      catch (e) { if (!(e && e.code === 'declined')) notice('bad', 'Non sono riuscito a scaricarlo' + errText(e) + '.', true); }
    } else if (a === 'lab-open') { LAB.run = b.dataset.run; LAB.line = -1; LAB.what = 'all'; showView('etichette'); paintLab(); }
    else if (a === 'nav' && b.dataset.view === 'etichette') setTimeout(() => { paintLab(); paintLabCfg(); }, 0);
  });

  function ecoInit() {
    const ld = window.__localDb;
    if (ld) ld.onStatus(() => { const i = ld.info(), on = i.linked && i.perm === 'granted'; if (on && !ECO.wasLinked) setTimeout(ecoLoad, 0); ECO.wasLinked = on; });
    const go = () => ecoLoad();
    if (window.claude && typeof window.claude.use === 'function') window.claude.use('db').then(go, go); else go();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && ECO.src !== 'file') ecoLoad(); });
    setInterval(() => { if (!document.hidden && ECO.src === 'cartella') ecoLoad(); }, 60000);
  }

  /* ---------- avvio ---------- */
  $('#mese').innerHTML = C.MESI.map((m) => '<option>' + m + '</option>').join('');
  $('#mese').value = state.mese;
  $('#anno').value = state.anno;
  renderLines(); refreshAll(); renderResult(); showView(startView());
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (VIEWS.includes(h) && h !== state.view) showView(h); });
  if (window.__cloudApi && !document.querySelector('.tabs .tabsep')) document.querySelector('nav.tabs').insertAdjacentHTML('beforeend', '<span class="tabsep" aria-hidden="true"></span><span class="tablbl">Gestione Produzione</span><a class="tabx" href="../#setup">Anagrafiche</a><a class="tabx" href="../#report">Report</a>');
  initDb();
  ecoInit();
})();
