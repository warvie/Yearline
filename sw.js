// Yearline offline cache, build 2026-11-24T01:20:09.976Z
const CACHE = "yearline-2026-11-24T01:20:09.976Z";
const FILES = ["/Yearline/","/Yearline/_expo/static/js/web/index-95ae847375b3d7df9e82309311507d48.js","/Yearline/favicon.ico","/Yearline/icon-180.png","/Yearline/icon-192.png","/Yearline/icon-512.png","/Yearline/index.html","/Yearline/manifest.webmanifest","/Yearline/metadata.json"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // Pages: try the network first (so updates arrive), fall back to the saved copy offline. Everything else: saved copy first.
  if (req.mode === "navigate") { e.respondWith(fetch(req).catch(() => caches.match("/Yearline/"))); return; }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.length ? cs[0].focus() : self.clients.openWindow("/Yearline/"))); });
