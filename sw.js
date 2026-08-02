const CACHE_NAME = "kalamu-cache-v2";
const FILES_TO_CACHE = ["./kalamu.html", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Ne gère que les requêtes GET du même site (évite les erreurs sur l'API)
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
  // Réseau en premier : on va toujours chercher la dernière version en
  // ligne. Si ça échoue (pas de connexion), on sert la copie en cache.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
