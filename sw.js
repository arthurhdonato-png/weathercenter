// Service worker: guarda o app para abrir rápido e mostra os últimos dados sem internet.
const VERSAO = 'wc-v15';
const APP = ['./', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/main.js', 'js/util.js', 'js/dados.js', 'js/consenso.js', 'js/previsao.js', 'js/icones.js',
  'js/mapas.js', 'js/mapaBase.js', 'js/alertasMapa.js', 'js/rotulosCidades.js', 'js/incendios.js', 'js/notificacoes.js',
  'js/mapaControles.js', 'js/linhaTempoAlertas.js', 'js/graficos.js', 'js/niveis.js', 'js/tema.js', 'js/cena.js', 'vendor/polygon-clipping/polygon-clipping.umd.min.js',
  'dados/mascara-brasil.json', 'dados/municipios.json', 'dados/contorno-brasil-largo.json', 'dados/contorno-ufs.json',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/fontes/noto-sans-latin-wght-normal.woff2',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css', 'vendor/maplibre/leaflet-maplibre-gl.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO && k !== `${VERSAO}-dados` && k !== 'wc-notif' && k !== 'wc-grande').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function redePrimeiro(req, cacheNome) {
  // Arquivos do app: confere com o servidor (sem usar a cópia de até 10 min do navegador), para nunca
  // misturar um index.html novo com scripts antigos logo depois de uma atualização
  const pedido = cacheNome !== VERSAO ? fetch(req) : req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' });
  return pedido.then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(cacheNome).then((c) => c.put(req, copia)); return r; }
    // Serviço recusou (ex.: 429, consultas demais) ou falhou: usa a última resposta boa, se houver
    if (cacheNome !== VERSAO && (r.status === 429 || r.status >= 500)) return caches.match(req).then((v) => v || r);
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

/* ======================= Notificações de alerta (Web Push) ======================= */
// Chegam mesmo com o app fechado. O conteúdo é montado pelo notificador (notificador/enviar.mjs).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { corpo: e.data ? e.data.text() : '' }; }
  const nivel = Number(d.nivel) || 1;
  e.waitUntil(self.registration.showNotification(d.titulo || 'WeatherCenter: novo alerta', {
    body: d.corpo || 'Abra o app para ver os detalhes.',
    tag: d.tag || 'wc-alerta',
    renotify: true,
    icon: 'icons/icon-192.png',
    data: { url: d.url || './' },
    requireInteraction: nivel >= 3, // alerta vermelho fica na tela até a pessoa tocar
    vibrate: nivel >= 3 ? [400, 150, 400, 150, 400] : [200, 100, 200],
    timestamp: Date.now(),
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
    const j = janelas.find((c) => c.url.startsWith(self.registration.scope));
    if (j) return j.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : null)).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});

// O navegador às vezes renova a inscrição sozinho: refaz o cadastro com as mesmas cidades
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const r = await (await caches.open('wc-notif')).match('estado');
    if (!r) return;
    const { cidades, nivelMin, cfg } = await r.json();
    if (!cfg || !cidades?.length) return;
    const chave = Uint8Array.from(atob(cfg.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
    const j = sub.toJSON();
    const h = { 'Content-Type': 'application/json', apikey: cfg.supabaseKey };
    if (cfg.supabaseKey.startsWith('eyJ')) h.Authorization = `Bearer ${cfg.supabaseKey}`;
    await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/wc_inscrever`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_cidades: cidades, p_nivel_min: nivelMin || 1 }),
    });
  })().catch(() => {}));
});
