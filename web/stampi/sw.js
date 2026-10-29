/* Gestione Stampi: service worker minimo per installare l'app.
   I dati (Supabase) passano sempre dalla rete: niente dati salvati in cache. */
const CACHE = 'stampi-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './css/stampi.css', './js/app.js',
  '../shared/js/config.js', '../shared/brand/favicon.ico',
  '../shared/brand/icone/stampi-192.png', '../shared/brand/icone/stampi-512.png', '../shared/brand/icone/stampi-apple-touch.png',
  '../shared/brand/logo-orizzontale-bianco.png', '../shared/brand/logo-orizzontale-scuro.png', '../shared/brand/simbolo-bianco.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Sempre la versione più recente dalla rete; la copia salvata serve solo senza connessione.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
