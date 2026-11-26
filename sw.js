// Service worker: guarda o app para abrir rápido e mostra os últimos dados sem internet.
const VERSAO = 'wc-v6';
const APP = ['./', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/main.js', 'js/util.js', 'js/dados.js', 'js/consenso.js', 'js/previsao.js', 'js/icones.js',
  'js/mapas.js', 'js/mapaBase.js', 'js/alertasMapa.js', 'js/rotulosCidades.js', 'js/incendios.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/fontes/noto-sans-latin-wght-normal.woff2',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css', 'vendor/maplibre/leaflet-maplibre-gl.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && k !== `${VERSAO}-dados`).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function redePrimeiro(req, cacheNome) {
  return fetch(req).then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(cacheNome).then((c) => c.put(req, copia)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: cacheNome === VERSAO }).then((r) => r || Promise.reject(new Error('offline'))));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Previsão e alertas: rede primeiro; sem internet, a última resposta salva
  if (/open-meteo\.com$|api\.met\.no$|inmet\.gov\.br$|raw\.githubusercontent\.com$/.test(url.hostname)) { e.respondWith(redePrimeiro(req, `${VERSAO}-dados`)); return; }
  // Arquivos do app: rede primeiro (sempre a versão mais nova), cache quando offline
  if (url.origin === location.origin) e.respondWith(redePrimeiro(req, VERSAO));
});
