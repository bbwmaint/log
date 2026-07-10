// BBW Work Log — Service Worker
// Bump CACHE to force all devices onto fresh code + purge stale assets (e.g. old icon).
const CACHE = 'bbw-v39';

// Precache the shell AND the icon set / manifest so they refresh in one shot.
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './icon-maskable-512.png',
];

// Install — cache the app shell, activate immediately.
// Uses allSettled so a single missing/renamed file never blocks the whole install.
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return Promise.allSettled(PRECACHE.map(function(u){ return cache.add(u); }));
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
//  - Everything else (icons, libs): cache-first, refresh in background
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

// ── Web Push ─────────────────────────────────────────────
// Fires even when the app is fully closed. The Edge Function
// sends a JSON payload {title, body, url, tag}.
self.addEventListener('push', function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err){ data = { body: (e.data && e.data.text()) || '' }; }
  var title = data.title || 'BBW Maintenance';
  var opts = {
    body: data.body || 'New maintenance request',
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    tag: data.tag || 'bbw-req',
    data: { url: data.url || './' },
    requireInteraction: !!data.requireInteraction
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping the notification focuses/opens the app
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
      for (var i=0;i<list.length;i++){
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
