// BBW Work Log — Service Worker
// Version bump this string to force cache update
const CACHE = 'bbw-v1';

// Files to cache on install
const PRECACHE = [
  './',
  './index.html',
];

// Install — cache the app shell
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(PRECACHE);
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

// Activate — clean up old caches
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

// Fetch — serve from cache, fall back to network
// Supabase API calls always go to network (never cached)
self.addEventListener('fetch', function(e){
  var url = e.request.url;

  // Never intercept Supabase or external API calls
  if(url.includes('supabase.co') || url.includes('emailjs.com')){
    e.respondWith(fetch(e.request));
    return;
  }

  // For the app shell: cache-first, update in background
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var networkFetch = fetch(e.request).then(function(response){
        // Update cache with fresh version
        if(response && response.status === 200 && response.type === 'basic'){
          var toCache = response.clone();
          caches.open(CACHE).then(function(cache){
            cache.put(e.request, toCache);
          });
        }
        return response;
      }).catch(function(){
        return cached; // offline fallback
      });

      // Return cached immediately, update in background
      return cached || networkFetch;
    })
  );
});
