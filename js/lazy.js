/* P66 lazy script loader.
 *
 * P66.loadScriptOnce(src) -> Promise that resolves with src once the
 * script has loaded. A <script> tag is injected at most once per src:
 * repeat calls return the cached promise, and a script tag already
 * present in the document (e.g. a static <script src> the coordinator
 * has not removed yet) resolves immediately without injecting a
 * duplicate. On load error the promise rejects and the cache entry is
 * dropped, so a later call may retry.
 *
 * Heavy views use it to stay out of the render-blocking path:
 *   - js/ve3d.js    (3D VE/spark surface) via dashboard.js's ensureVe3d()
 *   - js/report.js  (report card + PNG)   via the app.js report call site
 *   - js/compare.js (before/after log compare) via renderCompareView()
 *
 * Node / test environments have no document: the promise rejects with a
 * descriptive Error. Callers must handle rejection — dashboard.js's
 * ensureVe3d() gate shows its "3D view unavailable" fallback, and the
 * report/compare call sites leave their placeholders in place.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});
  var pending = {};

  function hasScriptTag(src) {
    try {
      return !!document.querySelector('script[src="' + src + '"]');
    } catch (e) {
      return false;
    }
  }

  function loadScriptOnce(src) {
    if (pending[src]) return pending[src];
    var promise = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        reject(new Error('P66.loadScriptOnce: no document — cannot load ' + src));
        return;
      }
      // Already on the page (static tag or an earlier injection): do not
      // inject a second copy — re-running these scripts would reset their
      // module state (e.g. ve3d.js would clear the log-points source).
      if (hasScriptTag(src)) { resolve(src); return; }
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(src); };
      s.onerror = function () {
        delete pending[src]; // let a later call retry
        reject(new Error('P66.loadScriptOnce: failed to load ' + src));
      };
      var head = document.head || document.getElementsByTagName('head')[0] ||
        document.documentElement;
      head.appendChild(s);
    });
    pending[src] = promise;
    return promise;
  }

  P66.loadScriptOnce = loadScriptOnce;
})(typeof window !== 'undefined' ? window : global);
