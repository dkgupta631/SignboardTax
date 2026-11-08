// Network first so a new deploy shows straight away; the cache is the offline fallback.
const CACHE = 'signage-tax-v42';
const FONTS = [300, 400, 500, 600, 700].flatMap((w) => [
  `assets/fonts/prompt-thai-${w}-normal.woff2`,
  `assets/fonts/prompt-latin-${w}-normal.woff2`
]);
const FILES = [
  './', 'index.html', 'css/styles.css', 'css/auth.css', 'css/banner-map.css', 'js/i18n.js', 'js/app.js', 'js/auth-config.js', 'js/auth.js', 'js/mobile-app.js', 'js/scan-voice.js', 'js/sign-detect.js', 'js/scan-measure.js', 'js/scanner.js', 'js/banner-map.js',
  'assets/vendor/leaflet/leaflet.js', 'assets/vendor/leaflet/leaflet.css',
  'favicon.png', 'manifest.webmanifest',
  'assets/img/logo.png', 'assets/img/logo-mark.png', 'assets/img/hero.jpg', 'assets/img/signboard-photo.jpg',
  'assets/img/pharmacy-bg.jpg', 'assets/img/contact-mascot.jpg',
  'assets/img/line-qr.png', 'assets/img/line-qr-2.png', 'assets/docs/sign-tax-form-pp1.pdf',
  'assets/img/social/line.png',
  ...FONTS
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
