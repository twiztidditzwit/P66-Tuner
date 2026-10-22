/* p66-tuner service worker — offline app shell cache.
 * No build step, no dependencies. Registration is guarded in index.html
 * (https/localhost only), so file:// use is unaffected.
 */
'use strict';

var CACHE_NAME = 'p66-tuner-v2';

// Bump CACHE_NAME whenever the app shell changes; activate() drops older caches.
var APP_SHELL = [
  './',
  'index.html',
  'js/analyzer-worker.js',
  'js/log-parser.js',
  'js/log-merge.js',
  'js/channel-mapper.js',
  'js/log-health.js',
  'js/idc-headroom.js',
  'js/analyzer.js',
  'js/idle-diag.js',
  'js/ae-scatter.js',
  'js/shift-histograms.js',
  'js/analyze-async.js',
  'js/coverage.js',
  'js/tuner.js',
  'js/warmup.js',
  'js/ve-provenance.js',
  'js/mode-compare.js',
  'js/lazy.js',
  'js/dashboard.js',
  'js/ve3d.js',
  'js/trim-heatmap.js',
  'js/xdf-map.js',
  'js/pe-verify.js',
  'js/verify.js',
  'js/provenance.js',
  'js/twobin.js',
  'js/fingerprints.js',
  'js/safety.js',
  'js/summary.js',
  'js/ledger.js',
  'js/patch-preview.js',
  'js/journal.js',
  'js/knock-spark.js',
  'js/convergence.js',
  'js/altitude.js',
  'js/playback.js',
  'js/engine-sound.js',
  'js/stripcharts.js',
  'js/playback-events.js',
  'js/knock-drilldown.js',
  'js/sparklines.js',
  'js/compare.js',
  'js/o2health.js',
  'js/report.js',
  'js/segments.js',
  'js/xdf-library.js',
  'js/wizard.js',
  'js/bundled-catalog.js',
  'js/bindiff.js',
  'js/easy.js',
  'app.js',
  'styles.css',
  'styles/stripcharts.css',
  'styles/playback-events.css',
  'styles/compare.css',
  'styles/o2health.css',
  'styles/report.css',
  'styles/segments.css',
  'styles/vepoints.css',
  'styles/xdf-library.css',
  'manifest.webmanifest',
  'icon.svg'
];

// ---- install: precache the app shell -------------------------------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ---- activate: clean old caches ------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) {
          return caches.delete(key);
        }
        return undefined;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---- fetch: cache-first for the app shell --------------------------
// Never cache uploads, IndexedDB, or non-GET traffic — those only come
// from same-origin POSTs or script-generated requests, which we ignore.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') {
    return;
  }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return; // cross-origin (fonts/CDN) — the app currently uses none
  }
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(req).then(function (resp) {
        // Cache readable GET responses for later offline use.
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return resp;
      });
    }).catch(function () {
      // Offline fallback: serve the cached app shell.
      if (req.mode === 'navigate') {
        return caches.match('index.html');
      }
      return caches.match(req);
    })
  );
});
