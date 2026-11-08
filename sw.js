/* App-shell cache only. Business data is NEVER cached here (API calls are cross-origin and bypassed); offline data lives in IndexedDB. */
const V = 'ane-shell-v3';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/app.js', 'js/config.js', 'assets/logo/AdamNokia_Primary_FullColor.svg', 'assets/logo/AdamNokia_Secondary_Horizontal_FullColor.svg', 'assets/logo/AdamNokia_Secondary_Horizontal_Reversed_White.svg', 'assets/logo/AdamNokia_Submark_Reversed_White.svg', 'assets/icons/favicon.svg', 'assets/icons/AdamNokia_icon_192x192.png', 'assets/icons/AdamNokia_icon_512x512.png', 'assets/icons/apple-touch-icon.png', 'assets/fonts/Poppins-Regular.ttf', 'assets/fonts/Poppins-Medium.ttf', 'assets/fonts/Poppins-Bold.ttf'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
/* stale-while-revalidate for our own files: opens instantly offline, picks up new versions on the next visit */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || (await c.match('index.html'));
  }));
});
