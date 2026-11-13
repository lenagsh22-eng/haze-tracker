/* Haze Tracker service worker: offline shell, background checks, notification clicks. */
importScripts('core.js');

var CACHE = 'haze-tracker-v1';
var SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'core.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Same-origin files: serve from cache, refresh in the background.
// API calls go straight to the network (the page handles its own offline state).
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return cached || (req.mode === 'navigate' ? caches.match('index.html') : undefined);
      });
      return cached || network;
    })
  );
});

// Background check (Chrome on Android, installed app, when the browser allows it).
self.addEventListener('periodicsync', function (event) {
  if (event.tag === 'psi-check') {
    event.waitUntil(
      Haze.fetchAll().then(function (data) {
        return Haze.evaluateAlert(data).then(function (alert) {
          if (alert) return Haze.showAlert(self.registration, alert);
        });
      }).catch(function () { /* offline or API error: try again next time */ })
    );
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
