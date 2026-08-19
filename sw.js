/* ============================================================
   Studio Au Bas des Crêtes — Service Worker
   Rôles : 1) rendre l'app installable et consultable hors-ligne
           2) recevoir les notifications push de l'hôte
   ============================================================ */

const CACHE = 'studio-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Réseau d'abord (l'app reste toujours à jour), cache en secours hors-ligne.
   Les appels aux fonctions Netlify ne sont jamais mis en cache. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/.netlify/')) return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});

/* ---------- Notifications push (hôte) ---------- */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { titre: 'Studio Au Bas des Crêtes', message: event.data ? event.data.text() : '' }; }

  const titre = d.titre || 'Studio Au Bas des Crêtes';
  const options = {
    body: d.message || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.id || 'studio-commande',
    renotify: true,
    vibrate: d.urgent ? [90, 50, 90, 50, 90] : [70, 40, 70],
    data: { url: d.url || './#admin' }
  };
  event.waitUntil(self.registration.showNotification(titre, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          try { if (c.navigate) c.navigate(url); } catch (_) {}
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
