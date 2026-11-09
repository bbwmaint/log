// BBW Work Log — Service Worker
// Bump CACHE to force all devices onto fresh code + purge stale assets (e.g. old icon).
const CACHE = 'bbw-b270';

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
      // Take control of open pages WITHOUT force-reloading them. The app serves
      // HTML network-first, so every online load already gets the latest code;
      // forcing a navigate here just yanked people out of what they were doing
      // (and flashed the login screen) on every deploy.
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
//  - App HTML: STALE-WHILE-REVALIDATE — serve the cached page INSTANTLY (so the
//             app opens fast and reliably even on weak LTE, instead of hanging on
//             a ~1.7MB download and sometimes half-rendering), and refresh the
//             cache in the background so the next launch has the newest build.
//             A per-build CACHE bump still rolls every device forward.
//  - Everything else (icons, libs): cache-first, refresh in background
self.addEventListener('fetch', function(e){
  var url = e.request.url;

  if(url.includes('supabase.co') || url.includes('emailjs.com')){
    return; // let the browser handle it normally
  }

  if(isHTML(e.request)){
    // NETWORK-FIRST with a short timeout. When online, always serve the freshest
    // index.html (so a device can never get stuck on a stale/broken cached build —
    // that showed up as 404s and broken screens). If the network is slow/offline,
    // fall back to cache after 2.5s so weak-LTE launches stay fast.
    e.respondWith(
      caches.open(CACHE).then(function(c){
        return new Promise(function(resolve){
          var settled = false;
          function fromCache(){
            return c.match(e.request).then(function(hit){ return hit || c.match('./index.html'); });
          }
          var timer = setTimeout(function(){
            if(settled) return;
            fromCache().then(function(cached){ if(!settled && cached){ settled = true; resolve(cached); } });
          }, 2500);
          fetch(e.request).then(function(resp){
            if(resp && resp.status === 200){ c.put(e.request, resp.clone()); }
            if(settled) return;
            settled = true; clearTimeout(timer); resolve(resp);
          }).catch(function(){
            if(settled) return;
            settled = true; clearTimeout(timer);
            fromCache().then(function(cached){ resolve(cached || Response.error()); });
          });
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
