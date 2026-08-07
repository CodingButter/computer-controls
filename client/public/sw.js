// The service worker exists for one reason: a phone will not offer "add to home
// screen" for a page that cannot start. It caches the shell — the HTML, the
// script, the stylesheet, the icons — so the app opens to its own frame instead
// of the browser's offline page.
//
// It caches the shell and nothing else. Every answer about the desktop is live
// or it is wrong: a cached device list would tell a phone that a machine is
// connected after it went away, and a cached grant would show a permission that
// has since been revoked. Those are not stale pixels, they are false statements
// about what an agent may do. So `/api` and the event socket are handled by not
// handling them — the fetch listener returns without calling respondWith, and
// the request goes to the network as if this worker were not installed.
//
// The precache list is deliberately short. Anything missing from it still works
// online; anything wrong in it breaks the install. The dashboard's built assets
// carry content hashes in their names and are picked up by the runtime cache
// below rather than named here, because a hash pinned in this file goes stale
// on the next build.

const CACHE_NAME = "comcon-shell-v1";

const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

// Paths whose answers are about the machine right now. Never cached, never
// served from cache, not even as a fallback when the network is down: offline,
// the honest answer is the failure the page already knows how to draw.
const LIVE = ["/api/", "/events"];

self.addEventListener("install", (event) => {
  // addAll fails the whole install if one entry 404s, which is the behaviour we
  // want — a half-populated shell cache is how an app opens to a blank frame.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Another origin's business is not ours to cache or to answer.
  if (url.origin !== self.location.origin) return;

  if (isLive(url.pathname)) return;

  event.respondWith(shellFirst(request));
});

function isLive(pathname) {
  return LIVE.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

async function shellFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Opaque and error responses are passed through without being kept: caching a
  // 404 shell asset would make the miss permanent until the cache name changes.
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}
