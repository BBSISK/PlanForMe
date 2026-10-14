// Versioned per deploy: Flask replaces __VERSION__ with the git commit (or a hash of the assets),
// so every deploy installs a new worker, which drops the old cache and refreshes open pages.
// App shell: cache-first. Pages and GET /api/*: network-first with cached fallback (read-only offline).
const VERSION = "planner-__VERSION__";
const SHELL = [
  "/static/app.css?v=__VERSION__",
  "/static/app.js?v=__VERSION__",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // writes always go to the network (offline outbox = phase 2)
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === "navigate" || url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
