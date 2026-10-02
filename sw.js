const CACHE = 'lenscape-v2';
const SHELL = ['/', '/index.html', '/privacy.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/assets/icon.svg', '/assets/icon-192.png', '/assets/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin && url.pathname.startsWith('/api/'))return;

  // Cache the pinned Leaflet runtime after first load, but never grow the cache with map tiles.
  if(url.hostname==='unpkg.com'){
    event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(response=>{
      if(response.ok||response.type==='opaque')caches.open(CACHE).then(cache=>cache.put(req,response.clone()));
      return response;
    })));
    return;
  }
  if(url.origin!==location.origin)return;

  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(response=>{
      if(response.ok)caches.open(CACHE).then(cache=>cache.put(req,response.clone()));
      return response;
    }).catch(async()=>await caches.match(req)||await caches.match('/index.html')));
    return;
  }

  event.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(response=>{
    if(response.ok)caches.open(CACHE).then(cache=>cache.put(req,response.clone()));
    return response;
  })));
});
