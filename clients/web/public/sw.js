/**
 * Service worker: cache the PWA shell for offline installability.
 *
 * CRITICAL: this NEVER caches desktop state, /turn audio, or WebSocket data.
 * Only the static shell (HTML, CSS, manifest, icons) is precached so the app
 * installs and launches offline. Live desktop state is always fetched fresh.
 */

const CACHE_NAME = "computer-controls-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // NEVER cache live data — desktop state, voice turns, WebSocket upgrades.
  if (
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/turn") ||
    url.pathname.startsWith("/session")
  ) {
    return;
  }

  // Shell assets: cache-first.
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((resp) => {
          // Cache a copy of new shell assets.
          if (resp.ok && event.request.method === "GET") {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return resp;
        }),
    ),
  );
});
