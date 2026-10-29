/* Grafici integrati: usati solo se report-charts.js non è presente nella cartella */
if (typeof ReportCharts === "undefined") window.ReportCharts = (() => {
  const x = v => String(v ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const p2 = n => String(n).padStart(2, "0"), hms = t => p2(Math.floor(t / 3600)) + ":" + p2(Math.floor(t % 3600 / 60)) + ":" + p2(t % 60);
  const day = d => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  const bump = (m, key, label, f) => { const o = m.get(key) || {label, key, produced: 0, scrap: 0, value: 0}; f(o); m.set(key, o); };
  return {
    aggregate(list, group) {
      const vol = new Map(), sc = new Map(), st = new Map();
      for (const r of list) {
        const d = new Date(r.ts), k = group === "operatore" ? r.operatore : group === "prodotto" ? r.prodotto : day(d);
        const lab = group === "giorno" ? d.toLocaleDateString("it-IT") : k;
        if (r.tipo === "Produzione") bump(vol, k, lab, o => o.produced += r.pezzi || 0);
        if (r.tipo === "Scarto") { bump(vol, k, lab, o => o.scrap += r.pezzi || 0); bump(sc, r.causa, r.causa, o => o.value += r.pezzi || 0); }
        if (r.tipo === "Fermo") bump(st, r.causa, r.causa, o => o.value += r.durataSec || 0);
      }
      const byVal = m => [...m.values()].sort((a, b) => b.value - a.value);
      return {volume: [...vol.values()].sort(group === "giorno" ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.produced - a.produced), scraps: byVal(sc), stops: byVal(st)};
    },
    draw(el, rows, series, unit, title) {
      const max = Math.max(0, ...rows.flatMap(r => series.map(s => r[s.key] || 0)));
      if (!rows.length || !max) { el.innerHTML = '<p class="chart-empty mut">Nessun dato da mostrare</p>'; return; }
      const val = v => unit === "secondi" ? hms(v) : String(v), X0 = 200, BW = 400, bh = 16, rh = series.length * (bh + 2) + 12;
      let g = "";
      rows.forEach((r, i) => {
        const y = 10 + i * rh, lab = String(r.label).length > 26 ? String(r.label).slice(0, 25) + "…" : r.label;
        g += `<text class="chart-label" x="${X0 - 10}" y="${y + series.length * (bh + 2) / 2 + 4}" text-anchor="end"><title>${x(r.label)}</title>${x(lab)}</text>`;
        series.forEach((s, j) => {
          const v = r[s.key] || 0, w = v ? Math.max(2, v / max * BW) : 0, yy = y + j * (bh + 2);
          g += `<rect class="${s.className}" x="${X0}" y="${yy}" width="${w}" height="${bh}" rx="2"><title>${x(s.label)}: ${x(val(v))}</title></rect><text class="chart-value" x="${X0 + w + 6}" y="${yy + bh - 3}">${x(val(v))}</text>`;
        });
      });
      el.innerHTML = `<svg class="report-svg" viewBox="0 0 700 ${rows.length * rh + 14}" role="img" aria-label="${x(title)}">${g}</svg>`;
    }
  };
})();
