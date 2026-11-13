// Keeps the app's own files on the device so it still opens when the internet drops.
// Always asks the network first, so a new release shows as soon as it is online.
// Data (/api) is not handled here: app.js keeps its own copies.
const CACHE = 'fm-shell-v12';
// app.js loads the page modules in /js/.
const SHELL = ['/', '/app.js', '/i18n.js', '/styles.css', '/fikra-logo.png', '/vendor/qrcode.js', '/js/admin.js', '/js/api.js', '/js/assets.js', '/js/contracts.js', '/js/core.js', '/js/docs.js', '/js/health.js', '/js/inventory.js', '/js/kpis.js', '/js/capa.js', '/js/layout.js', '/js/meetings.js', '/js/offline.js', '/js/ovr.js', '/js/inv.js', '/js/risk.js', '/js/pex.js', '/js/quality.js', '/js/reports.js', '/js/rounds.js', '/js/tickets.js', '/js/xlsx.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Every page address is the same single-page app.
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || SHELL.includes(url.pathname) || url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/js/'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});

// A notification from the server (see sendPush in src/worker.js). Tapping it opens the request,
// in the app's window when one is open.
self.addEventListener('push', (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch {
    /* an empty or unreadable message still shows, so the person knows to look */
  }
  e.waitUntil(
    self.registration.showNotification(m.title || 'Quality & Accreditation', {
      body: m.body || '',
      tag: m.tag || undefined,
      renotify: !!m.tag,
      lang: m.lang || 'ar',
      dir: m.dir || 'rtl',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { url: m.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === location.origin);
      if (!open) return self.clients.openWindow(url.href);
      open.postMessage({ open: url.hash });
      return open.focus();
    }),
  );
});
