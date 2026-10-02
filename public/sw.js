const CACHE = "winning-url-vault-pwa-20261002-v4";
const ASSETS = [
  "/",
  "/index.html",
  "/share.html",
  "/styles.css",
  "/app.js",
  "/share.js",
  "/manifest.json",
  "/manifest.webmanifest",
  "/icon-any-192.png",
  "/icon-any-512.png",
  "/icon-maskable-512.png"
];

async function handleShareTarget(request) {
  let data;
  try { data = await request.formData(); }
  catch { return Response.redirect("/share.html#share_error=parse", 303); }
  const params = new URLSearchParams();
  for (const key of ["title", "text", "url"]) {
    const value = data.get(key);
    if (typeof value === "string" && value.trim()) params.set(key, value.trim());
  }
  const target = new URL("/share.html", self.location.origin);
  target.hash = params.toString();
  return Response.redirect(target.href, 303);
}

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith("winning-url-vault-pwa-") && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share") {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("/index.html");
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
