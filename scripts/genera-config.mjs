// Genera web/shared/js/config.js dalle variabili d'ambiente SUPABASE_URL e SUPABASE_KEY.
// Su Netlify gira come comando di build; in locale con `npm run config`.
// Senza variabili non sovrascrive un config.js già presente (creato a mano da config.example.js).
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../web/shared/js/config.js', import.meta.url));
const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_KEY || '').trim();

// La pagina gira nel browser: qui va solo la chiave publishable, mai quella service_role.
const ruoloJwt = (k) => {
  try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role; } catch { return ''; }
};
if (key.startsWith('sb_secret_') || ruoloJwt(key) === 'service_role') {
  console.error('SUPABASE_KEY è una chiave segreta: usa la chiave publishable (sb_publishable_...) o anon.');
  process.exit(1);
}
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
  console.error('SUPABASE_URL non sembra un indirizzo Supabase: ' + url);
  process.exit(1);
}

if (!url && !key && existsSync(out)) {
  console.log('config.js già presente: lasciato com\'è.');
  process.exit(0);
}

writeFileSync(out, `/* File generato da scripts/genera-config.mjs: non modificarlo e non pubblicarlo su git. */
window.APP_CONFIG = {
  supabaseUrl: ${JSON.stringify(url.replace(/\/$/, ''))},
  supabaseKey: ${JSON.stringify(key)}
};
`);
console.log(url ? 'config.js creato per ' + url : 'config.js creato vuoto: Produzione e Collaudi lavorano in locale.');
