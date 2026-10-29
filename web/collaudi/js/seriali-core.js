/* Seriali e Pallet: logica di calcolo, CSV e XLSX. Nessuna dipendenza esterna. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SerialCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
  var DEFAULT_CFG = { prefix: '000000', fixedDigit: '1', sheetName: 'Seriali' };
  var MAX_SERIAL = 9999999999;
  var SOFT_HYPHEN = '­';

  function pad(n, w) { return String(n).padStart(w, '0'); }

  /* Intero non negativo da stringa o numero; NaN se non valido. */
  function toInt(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : NaN;
    var s = String(v == null ? '' : v).trim();
    return /^\d{1,15}$/.test(s) ? Number(s) : NaN;
  }

  /* Dimensione dei pallet di una destinazione. Regola predefinita: il resto va in un ultimo
     pallet parziale (300 pezzi a 7 per pallet = 42 da 7 + 1 da 6). In alternativa, mode 'last'
     aggiunge il resto all'ultimo pallet pieno (come Caserta nel file di ottobre: 400 = 56 da 7 + 1 da 8). */
  function palletSizes(qty, perPallet, mode) {
    var n = Math.floor(qty / perPallet);
    var r = qty - n * perPallet;
    if (n === 0) return [qty];
    var sizes = new Array(n).fill(perPallet);
    if (r > 0) {
      if (mode === 'last') sizes[n - 1] += r; else sizes.push(r);
    }
    return sizes;
  }

  /* line: {matricola, oda, perPallet, remainder, destinations:[{name, qty}]} */
  function planLine(line, startSerial, firstPallet) {
    var serial = startSerial, pallet = firstPallet, rows = [], blocks = [];
    line.destinations.forEach(function (d) {
      var sizes = palletSizes(d.qty, line.perPallet, line.remainder);
      var block = { name: d.name, qty: d.qty, pallets: sizes.length, firstPallet: pallet, firstSerial: serial, sizes: sizes };
      sizes.forEach(function (s) {
        rows.push({ pallet: pallet, qty: s, from: serial, to: serial + s - 1, dest: d.name });
        serial += s; pallet += 1;
      });
      block.lastPallet = pallet - 1; block.lastSerial = serial - 1;
      blocks.push(block);
    });
    return {
      rows: rows, blocks: blocks,
      firstSerial: startSerial, lastSerial: serial - 1,
      firstPallet: firstPallet, lastPallet: pallet - 1,
      total: serial - startSerial
    };
  }

  /* ---------- CSV portale cliente ---------- */
  var CSV_HEADER = ['Material Code', 'Serial Number Customer', 'Serial Number Supplier', 'Lot Number', 'Barcode', 'Barcode Customer',
    'Barcode Child', 'Barcode Coil', 'Barcode Coil From', 'Barcode Coil To', 'Oda', 'Repaired Component', 'Material Quantity'];

  function barcodeParts(mat, serial, year2, cfg) {
    return { prefix: cfg.prefix, mat: mat, year: year2, fixed: cfg.fixedDigit, serial: pad(serial, 10) };
  }
  function barcodeCliente(mat, serial, year2, cfg) {
    var p = barcodeParts(mat, serial, year2, cfg);
    return p.prefix + p.mat + p.year + p.fixed + p.serial;
  }
  function csvRow(mat, oda, serial, year2, cfg) {
    var s4 = pad(serial, 4);
    return [mat, pad(serial, 10), s4, '', s4, barcodeCliente(mat, serial, year2, cfg), '', '', '', '', oda, '', ''].join(';');
  }
  /* items: [{matricola, oda, firstSerial, lastSerial}] nell'ordine in cui compaiono nel file */
  function buildCsvText(items, year2, cfg) {
    var out = [CSV_HEADER.join(';')];
    items.forEach(function (it) {
      if (it.qty != null) { out.push(qtyRow(it)); return; }   /* prodotti a scatole: una riga per ODA con lotto e quantità */
      var c = it.prefix ? { prefix: it.prefix, fixedDigit: cfg.fixedDigit } : cfg;   /* prefisso proprio della matricola */
      for (var s = it.firstSerial; s <= it.lastSerial; s++) out.push(csvRow(it.matricola, it.oda, s, year2, c));
    });
    return out.join('\r\n') + '\r\n';
  }
  function utf8Bom(text) {
    var body = new TextEncoder().encode(text);
    var out = new Uint8Array(body.length + 3);
    out.set([0xEF, 0xBB, 0xBF], 0); out.set(body, 3);
    return out;
  }

  /* ---------- nomi file ---------- */
  function cleanName(s) { return String(s).replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim(); }
  function xlsxName(line, mese) { return cleanName(line.matricola + ' - ' + line.oda + ' - ' + mese) + '.xlsx'; }
  function csvName(avviso, matricole) {
    var uniq = matricole.filter(function (m, i) { return matricole.indexOf(m) === i; });
    var a = cleanName(avviso || '');
    return cleanName((a ? 'Avv. ' + a : 'Portale') + ' - ' + uniq.join(' - ')) + '.csv';
  }

  /* ---------- ZIP (senza compressione) ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files, date) {
    var enc = new TextEncoder();
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      var crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, p) { return a + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var total = all.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------- XLSX ---------- */
  function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function xmlAttr(s) { return xmlEsc(s).replace(/"/g, '&quot;'); }
  function sheetTitle(name) {
    var n = String(name || '').replace(/[\\\/?*\[\]:]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31);
    return n || 'Foglio1';
  }

  /* Gli indici 0..5 riproducono l'ordine delle stringhe del file originale. */
  function SharedStrings() {
    this.list = [SOFT_HYPHEN, 'MATRICOLA', 'N° PIANALE', "Q.TA' COLONNINI", 'CODICI', 'DESTINAZIONE'];
    this.map = {}; this.refs = 0;
    var self = this;
    this.list.forEach(function (s, i) { self.map[s] = i; });
  }
  SharedStrings.prototype.idx = function (s) {
    this.refs += 1;
    if (this.map[s] === undefined) { this.map[s] = this.list.length; this.list.push(s); }
    return this.map[s];
  };
  SharedStrings.prototype.xml = function () {
    var si = this.list.map(function (s) {
      var sp = /^\s|\s$/.test(s) ? ' xml:space="preserve"' : '';
      return '<si><t' + sp + '>' + xmlEsc(s) + '</t></si>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
      this.refs + '" uniqueCount="' + this.list.length + '">' + si + '</sst>';
  };

  /* Stili (attributo s) del file originale: 1 dati centrati, 3 trattino, 4 da, 6 a, 12 matricola in grassetto,
     8-11 e 13-14 intestazione, 15-17 riga dell'ordine. */
  function buildSheetXml(tpl, line, plan, sst) {
    var num = function (r, s, v) { return '<c r="' + r + '" s="' + s + '"><v>' + v + '</v></c>'; };
    var str = function (r, s, text) { return '<c r="' + r + '" s="' + s + '" t="s"><v>' + sst.idx(text) + '</v></c>'; };
    var blank = function (r, s) { return '<c r="' + r + '" s="' + s + '"/>'; };
    var numOrStr = function (r, s, v) { return /^(0|[1-9]\d{0,14})$/.test(v) ? num(r, s, v) : str(r, s, v); };

    var rows = [];
    rows.push('<row r="1" ht="26.25" customHeight="1">' +
      str('A1', 10, 'MATRICOLA') + str('B1', 9, 'N° PIANALE') + str('C1', 8, "Q.TA' COLONNINI") + str('D1', 13, 'CODICI') +
      blank('E1', 14) + blank('F1', 14) + str('G1', 11, 'DESTINAZIONE') + '</row>');
    rows.push('<row r="2" ht="20.25">' + numOrStr('A2', 15, line.oda) +
      blank('B2', 16) + blank('C2', 16) + blank('D2', 16) + blank('E2', 16) + blank('F2', 16) + blank('G2', 17) + '</row>');
    plan.rows.forEach(function (p, i) {
      var r = i + 3;
      rows.push('<row r="' + r + '">' +
        (i === 0 ? numOrStr('A' + r, 12, line.matricola) : '') +
        num('B' + r, 1, p.pallet) + num('C' + r, 1, p.qty) + num('D' + r, 4, p.from) +
        str('E' + r, 3, SOFT_HYPHEN) + num('F' + r, 6, p.to) +
        (p.dest ? str('G' + r, 1, p.dest) : blank('G' + r, 1)) + '</row>');
    });
    var lastRow = plan.rows.length + 2;
    return tpl.sheetHead +
      '<dimension ref="A1:G' + lastRow + '"/>' +
      '<sheetViews><sheetView tabSelected="1" zoomScale="85" zoomScaleNormal="85" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15.75" x14ac:dyDescent="0.25"/>' +
      tpl.cols + '<sheetData>' + rows.join('') + '</sheetData>' +
      '<mergeCells count="2"><mergeCell ref="D1:F1"/><mergeCell ref="A2:G2"/></mergeCells>' +
      tpl.sheetTail;
  }

  function buildXlsx(tpl, line, plan, sheetName) {
    var sst = new SharedStrings();
    var sheet = buildSheetXml(tpl, line, plan, sst);
    var files = [
      { name: '[Content_Types].xml', data: tpl.contentTypes },
      { name: '_rels/.rels', data: tpl.rootRels },
      { name: 'xl/workbook.xml', data: tpl.workbook.replace('__SHEETNAME__', xmlAttr(sheetTitle(sheetName))) },
      { name: 'xl/_rels/workbook.xml.rels', data: tpl.workbookRels },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
      { name: 'xl/theme/theme1.xml', data: tpl.theme },
      { name: 'xl/styles.xml', data: tpl.styles },
      { name: 'xl/sharedStrings.xml', data: sst.xml() }
    ];
    return zipStore(files);
  }

  /* ---------- prodotti a scatole: il seriale è della scatola, il pallet è anno + progressivo ---------- */
  /* line: {matricola, oda, box:{pz, per}, destinations:[{name, qty (pezzi)}]} */
  function boxPlan(line, startSerial, firstPallet) {
    var pz = line.box.pz, dests = line.destinations.map(function (d) { return { name: d.name, qty: Math.ceil(d.qty / pz), pcs: d.qty }; });
    var plan = planLine({ matricola: line.matricola, oda: line.oda, perPallet: line.box.per, remainder: 'separate', destinations: dests }, startSerial, firstPallet);
    plan.blocks.forEach(function (b, i) { b.pcs = dests[i].pcs; });
    plan.pcs = dests.reduce(function (a, d) { return a + d.pcs; }, 0);
    return plan;
  }
  /* 600 pezzi da 14: "42x14 + 1x12" */
  function boxComp(pcs, pz) {
    var n = Math.floor(pcs / pz), r = pcs - n * pz;
    return n ? n + 'x' + pz + (r ? ' + 1x' + r : '') : '1x' + r;
  }
  /* pallet di una destinazione: "1x30 + 1x13" (scatole), "1" se è uno solo */
  function palComp(sizes, per) {
    if (sizes.length === 1) return '1';
    var full = sizes.filter(function (s) { return s === per; }).length, rest = sizes.filter(function (s) { return s !== per; });
    return [full ? full + 'x' + per : ''].concat(rest.map(function (s) { return '1x' + s; })).filter(Boolean).join(' + ');
  }
  function palSerial(year2, n) { return String(year2) + pad(n, 2); }
  function palRange(year2, a, b) { return a === b ? palSerial(year2, a) : palSerial(year2, a) + ' - ' + palSerial(year2, b); }
  function boxXlsxName(mats, mese) {
    var u = mats.filter(function (m, i) { return mats.indexOf(m) === i; });
    return cleanName('Scatole - ' + u.join(' - ') + ' - ' + mese) + '.xlsx';
  }
  function qtyRow(it) { return [it.matricola, '', '', it.lot || '', '', '', '', '', '', '', it.oda, '', it.qty].join(';'); }
  /* Un foglio come la tabella di etichettatura: un blocco per matricola, una riga per destinazione. */
  function buildBoxXlsx(tpl, list, title, year2, sheetName) {
    var sst = new SharedStrings(), rows = [], merges = ['<mergeCell ref="A1:I1"/>'], r = 1;
    var num = function (c, s, v) { return '<c r="' + c + r + '" s="' + s + '"><v>' + v + '</v></c>'; };
    var str = function (c, s, t) { return '<c r="' + c + r + '" s="' + s + '" t="s"><v>' + sst.idx(String(t)) + '</v></c>'; };
    var nos = function (c, s, v) { return /^(0|[1-9]\d{0,14})$/.test(String(v)) ? num(c, s, v) : str(c, s, v); };
    rows.push('<row r="1" ht="24" customHeight="1">' + str('A', 9, title) + '</row>');
    list.forEach(function (x) {
      var l = x.line, p = x.plan, per = l.box.per;
      r += 2;
      rows.push('<row r="' + r + '" ht="20" customHeight="1">' + str('A', 10, 'Matricola') + str('B', 10, 'Destinazione') + str('C', 10, 'Qtà') + str('D', 10, 'Seriali') +
        str('E', 10, 'Pallet') + str('F', 10, 'Seriale pallet') + str('G', 10, 'Scatole per pallet') + str('H', 10, 'Oda') + str('I', 10, 'Scatola pz ' + l.box.pz) + '</row>');
      p.blocks.forEach(function (b, i) {
        r += 1;
        rows.push('<row r="' + r + '">' + (i === 0 ? nos('A', 12, l.matricola) : '<c r="A' + r + '" s="1"/>') + str('B', 1, b.name || '') + num('C', 1, b.pcs) +
          str('D', 1, b.firstSerial === b.lastSerial ? String(b.firstSerial) : b.firstSerial + ' - ' + b.lastSerial) + str('E', 1, palComp(b.sizes, per)) +
          str('F', 1, palRange(year2, b.firstPallet, b.lastPallet)) + num('G', 1, per) + nos('H', 1, l.oda) + str('I', 1, boxComp(b.pcs, l.box.pz)) + '</row>');
      });
    });
    var cols = '<cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="9" customWidth="1"/>' +
      '<col min="4" max="4" width="15" customWidth="1"/><col min="5" max="5" width="15" customWidth="1"/><col min="6" max="6" width="16" customWidth="1"/>' +
      '<col min="7" max="7" width="17" customWidth="1"/><col min="8" max="8" width="14" customWidth="1"/><col min="9" max="9" width="16" customWidth="1"/></cols>';
    var sheet = tpl.sheetHead + '<dimension ref="A1:I' + r + '"/>' +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15.75" x14ac:dyDescent="0.25"/>' + cols + '<sheetData>' + rows.join('') + '</sheetData>' +
      '<mergeCells count="1">' + merges.join('') + '</mergeCells>' + tpl.sheetTail.replace('orientation="portrait"', 'orientation="landscape"');
    var files = [
      { name: '[Content_Types].xml', data: tpl.contentTypes }, { name: '_rels/.rels', data: tpl.rootRels },
      { name: 'xl/workbook.xml', data: tpl.workbook.replace('__SHEETNAME__', xmlAttr(sheetTitle(sheetName || title))) },
      { name: 'xl/_rels/workbook.xml.rels', data: tpl.workbookRels }, { name: 'xl/worksheets/sheet1.xml', data: sheet },
      { name: 'xl/theme/theme1.xml', data: tpl.theme }, { name: 'xl/styles.xml', data: tpl.styles }, { name: 'xl/sharedStrings.xml', data: sst.xml() }
    ];
    return zipStore(files);
  }

  return {
    boxPlan: boxPlan, boxComp: boxComp, palComp: palComp, palSerial: palSerial, palRange: palRange, boxXlsxName: boxXlsxName, qtyRow: qtyRow, buildBoxXlsx: buildBoxXlsx,
    MESI: MESI, DEFAULT_CFG: DEFAULT_CFG, MAX_SERIAL: MAX_SERIAL, CSV_HEADER: CSV_HEADER,
    pad: pad, toInt: toInt, palletSizes: palletSizes, planLine: planLine,
    barcodeParts: barcodeParts, barcodeCliente: barcodeCliente, csvRow: csvRow, buildCsvText: buildCsvText, utf8Bom: utf8Bom,
    xlsxName: xlsxName, csvName: csvName, sheetTitle: sheetTitle, zipStore: zipStore, crc32: crc32, buildXlsx: buildXlsx
  };
});
