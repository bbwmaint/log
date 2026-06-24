// BBW Work Log — Service Worker
// Bump CACHE to force all devices onto fresh code.
const CACHE = 'bbw-v19';

const PRECACHE = [
  './',
  './index.html',
];

// Install — cache the app shell, activate immediately
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(PRECACHE);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

// Activate — drop old caches, take control of open pages
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){
      return self.clients.claim();
    })
  );
});

function isHTML(req){
  return req.mode === 'navigate' ||
         (req.headers.get('accept') || '').includes('text/html') ||
         req.url.indexOf('index.html') !== -1 ||
         req.url.replace(/[#?].*$/,'').endsWith('/');
}

// Fetch strategy:
//  - Supabase / EmailJS: always network, never touched
//  - App HTML: NETWORK-FIRST so new code lands the moment a device is online
//             (falls back to cache only when offline)
//  - Everything else (icons, libs): cache-first
self.addEventListener('fetch', function(e){
  var url = e.request.url;

  if(url.includes('supabase.co') || url.includes('emailjs.com')){
    return; // let the browser handle it normally
  }

  if(isHTML(e.request)){
    e.respondWith(
      fetch(e.request).then(function(response){
        if(response && response.status === 200){
          var copy = response.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        }
        return response;
      }).catch(function(){
        return caches.match(e.request).then(function(c){
          return c || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Static assets: cache-first, refresh in background
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var net = fetch(e.request).then(function(response){
        if(response && response.status === 200 && response.type === 'basic'){
          var copy = response.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        }
        return response;
      }).catch(function(){ return cached; });
      return cached || net;
    })
  );
});
