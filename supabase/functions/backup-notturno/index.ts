// Backup notturno: legge portale (collaudi e seriali), produzione e gestione stampi, li allega a un'email via Resend.
// Si avvia dal compito pianificato (token nel vault) oppure dal portale, da un amministratore ("Invia un backup ora").
// Gli allegati si reimportano così come sono: Portale › Storico › Importa, Produzione › Importa backup, Stampi › Backup › Importa.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono variabili fornite da Supabase alla funzione: non vanno mai nel codice.
const SB = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-backup-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(SB + "/rest/v1/" + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(path.split("?")[0] + ": " + r.status + " " + (await r.text()).slice(0, 200));
  return r;
}
async function all(path: string) {
  let out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = await (await rest(path, { headers: { "Range-Unit": "items", Range: from + "-" + (from + 999) } })).json();
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function log(ok: boolean, origine: string, dettaglio: string) {
  try { await rest("backup_esiti", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ok, origine, dettaglio: dettaglio.slice(0, 500) }) }); } catch (_) { /* il backup conta più dell'esito */ }
}
function b64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const REP = /^(stampaggio|officina|entrambi)::([\s\S]*)$/;
function fromAna(x: any) {
  const m = REP.exec(String(x.b || ""));
  const o: any = { id: x.id, a: x.a, b: m ? m[2] : x.b };
  if (m) o.reparto = m[1];
  if (x.tipo === "prodotti") {
    if (x.ritmo != null && Number(x.ritmo) > 0) o.ritmo = Number(x.ritmo);
    if (x.postazioni != null) o.postazioni = Number(x.postazioni);
    if (x.matricola) o.matricola = x.matricola;
  }
  return o;
}
function fromReg(r: any) {
  const o: any = { id: r.id, ts: new Date(r.ts).toISOString(), operatore: r.operatore, prodotto: r.prodotto, tipo: r.tipo, causa: r.causa || "" };
  if (r.pezzi != null) o.pezzi = r.pezzi;
  if (r.durata_sec != null) o.durataSec = r.durata_sec;
  return o;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let origine = "notte";
  try {
    const cfg = await (await rest("rpc/backup_segreti", { method: "POST", body: JSON.stringify({ t: req.headers.get("x-backup-token") || "" }) })).json();
    if (!cfg.token_ok) {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const u = jwt ? await fetch(SB + "/auth/v1/user", { headers: { apikey: SRK, Authorization: "Bearer " + jwt } }) : null;
      const uj = u && u.ok ? await u.json() : null;
      if (!uj || !uj.app_metadata || uj.app_metadata.ruolo !== "admin") return json({ ok: false, errore: "Non autorizzato" }, 401);
      origine = "a mano · " + (uj.email || "amministratore");
    }
    if (!cfg.chiave) {
      await log(false, origine, "Manca la chiave di Resend");
      return json({ ok: false, errore: "Manca la chiave di Resend: inseriscila nel portale, in Storico › Backup notturno." }, 400);
    }

    const [docs, ana, reg] = await Promise.all([
      all("portale_doc?select=col,id,data&order=col.asc,id.asc"),
      all("anagrafica?select=*&order=id.asc"),
      all("registrazioni?select=*&order=ts.desc"),
    ]);
    // Stampi: se le tabelle mancassero il resto del backup parte comunque
    let stampi: any[] = [], movStampi: any[] = [], soggetti: any[] = [], stampiErr = "";
    try {
      [stampi, movStampi, soggetti] = await Promise.all([
        all("stampi?select=*&order=nome.asc"),
        all("stampi_movimenti?select=*&order=data.desc"),
        all("stampi_soggetti?select=*&order=nome.asc"),
      ]);
    } catch (e) { stampiErr = e instanceof Error ? e.message : String(e); }

    const now = new Date(), salvato = now.toISOString();
    const dati: Record<string, Record<string, unknown>> = {};
    docs.forEach((r: any) => { (dati[r.col] = dati[r.col] || {})[r.id] = r.data; });
    const portale = { formato: "collaudi-seriali", versione: 1, salvato, dati };
    const prod: any = { operatori: [], prodotti: [], scarti: [], fermi: [], registrazioni: reg.map(fromReg) };
    ana.forEach((x: any) => { if (prod[x.tipo]) prod[x.tipo].push(fromAna(x)); });
    const stampiBk = { formato: "gestione-stampi", versione: 1, salvato, stampi, movimenti: movStampi, soggetti };

    const day = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
    const iso = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(now);
    const n = (c: string) => Object.keys(dati[c] || {}).length;
    const righe = [
      ["Matricole", n("serials")], ["Ordini", n("orders")], ["Collaudi in calendario", n("events")], ["Lotti registrati", n("runs")],
      ["Prodotti della produzione", prod.prodotti.length], ["Operatori", prod.operatori.length], ["Registrazioni della produzione", prod.registrazioni.length],
      ["Stampi", stampi.length], ["Movimenti stampi", movStampi.length], ["Manutentori e coproprietari", soggetti.length],
    ];
    const html = `<div style="font-family:Arial,sans-serif;color:#102935;font-size:14px;line-height:1.5">
      <h2 style="margin:0 0 8px">Backup del ${day}</h2>
      <p>In allegato i dati di <b>Collaudi e Seriali</b>, della <b>Gestione Produzione</b> e della <b>Gestione Stampi</b>.</p>
      <table style="border-collapse:collapse">${righe.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0">${k}</td><td style="padding:3px 0;text-align:right"><b>${v}</b></td></tr>`).join("")}</table>
      ${stampiErr ? `<p style="color:#b3261e">Stampi non inclusi: ${stampiErr.slice(0, 200)}</p>` : ""}
      <p style="margin-top:14px"><b>Per ripristinare:</b><br>
      collaudi-seriali-${iso}.json → Portale › Storico › Dati › Importa;<br>
      produzione-backup-${iso}.json → Gestione Produzione › Backup dati › Importa backup;<br>
      stampi-backup-${iso}.json → Gestione Stampi › Backup › Importa backup.</p>
      <p style="color:#5b6b73;font-size:12px">Email automatica (${origine}). Conserva questi messaggi: sono le copie di sicurezza dei dati.</p></div>`;
    const attachments = [
      { filename: `collaudi-seriali-${iso}.json`, content: b64(JSON.stringify(portale, null, 1)) },
      { filename: `produzione-backup-${iso}.json`, content: b64(JSON.stringify(prod, null, 1)) },
    ];
    if (!stampiErr) attachments.push({ filename: `stampi-backup-${iso}.json`, content: b64(JSON.stringify(stampiBk, null, 1)) });
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.chiave, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.mittente || "Backup Officine Demo <onboarding@resend.dev>",
        to: [cfg.destinatario],
        subject: `Backup Collaudi e Produzione · ${day}`,
        html,
        attachments,
      }),
    });
    const rj = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = (rj && (rj.message || rj.name)) || ("errore " + r.status);
      await log(false, origine, "Resend: " + why);
      return json({ ok: false, errore: "Resend: " + why }, 502);
    }
    const det = `Inviato a ${cfg.destinatario}: ${n("serials")} matricole, ${n("orders")} ordini, ${n("events")} collaudi, ${prod.registrazioni.length} registrazioni, ${stampi.length} stampi`;
    await log(true, origine, det);
    return json({ ok: true, dettaglio: det, id: rj.id });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await log(false, origine, m);
    return json({ ok: false, errore: m }, 500);
  }
});
