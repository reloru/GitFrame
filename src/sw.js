/**
 * Service worker: makes GitFrame open without a connection.
 *
 * Plain JavaScript rather than TypeScript on purpose. A service worker runs in
 * ServiceWorkerGlobalScope, which needs the "WebWorker" lib; that conflicts
 * with "DOM" in the same program, and the rest of src/ needs DOM. tsconfig.json
 * includes only src/**\/*.ts, so this file sits outside the type program with
 * no config change.
 *
 * What is cached here is the APP — its own HTML, script, styles and icons.
 * Video and captured frames are never written anywhere: they stay in memory
 * for the session, exactly as before.
 *
 * __CACHE_VERSION__ is replaced at build time (scripts/build.mjs) with a digest
 * of every file below. A fixed name would pin phones to the first version they
 * ever saw.
 */

const CACHE = 'gitframe-__CACHE_VERSION__';

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

/*
 * addAll is all-or-nothing: if any file fails to download, the whole install
 * rejects and this version never activates. That is what stops a flaky network
 * leaving half an old app and half a new one on the phone.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The health check exists to report on the live Worker; a cached answer would
  // report on nothing.
  if (url.pathname === '/healthz') return;

  event.respondWith(serve(event, url));
});

/** Store only complete, same-origin 200s — never a redirect, range or error. */
function cacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}

async function fromNetwork(cache, request, key) {
  const response = await fetch(request);
  if (cacheable(response)) {
    await cache.put(key, response.clone());
  }
  return response;
}

/**
 * Cache first, then refresh in the background.
 *
 * The app opens instantly and works offline; a newer version downloaded now is
 * used on the next launch. Waiting on the network first would undo the point of
 * caching at all, and the Worker sends Cache-Control: no-store, so there is no
 * HTTP-level caching underneath this to fall back on.
 */
async function serve(event, url) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  // Any navigation resolves to the shell: this is a single-page app, and a
  // deep link offline should still open it rather than fail.
  const key = request.mode === 'navigate' ? '/index.html' : url.pathname;
  const cached = await cache.match(key);

  if (cached) {
    // waitUntil keeps the worker alive for the refresh; offline, it just fails.
    event.waitUntil(fromNetwork(cache, request, key).catch(() => {}));
    return cached;
  }

  return fromNetwork(cache, request, key);
}
