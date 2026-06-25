/* Reflexos Diários — service worker (offline-first cache) */
const CACHE='reflexos-v1';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  // Cache-first for same-origin app shell; network passthrough for the rest (e.g. JSZip CDN).
  if(new URL(req.url).origin===location.origin){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));return res;
    }).catch(()=>caches.match('./index.html'))));
  }
});
