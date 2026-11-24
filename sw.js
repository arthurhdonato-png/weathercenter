// Service worker: guarda o app para abrir rápido e mostra a última previsão sem internet.
const VERSAO = 'wc-v1';
const APP = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Previsão e alertas: tenta a rede primeiro; sem internet, usa a última resposta salva.
  if (url.hostname.endsWith('open-meteo.com') || url.hostname.endsWith('inmet.gov.br')) {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copia = r.clone(); caches.open(VERSAO + '-dados').then((c) => c.put(req, copia)); }
      return r;
    }).catch(() => caches.match(req).then((r) => r || Promise.reject(new Error('offline')))));
    return;
  }

  // Arquivos do próprio app: cache primeiro, atualizando em segundo plano.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((cache) => {
      const rede = fetch(req).then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(req, copia)); }
        return r;
      }).catch(() => cache);
      return cache || rede;
    }));
  }
});
