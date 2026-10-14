/* P66 XDF library — personal definition-file shelf.
 *
 * Stores the user's own XDF files in IndexedDB so a dropped definition only
 * has to be loaded once; afterwards it is picked from a dropdown. Records
 * keep the raw XML text — parsing happens on selection via P66.parseXdfXml,
 * exactly as if the file had just been dropped.
 *
 * The store backend is injectable so the logic is testable under node:
 *   var lib = P66.createXdfLibrary(memoryBackend());
 * In the browser, P66.xdfLibrary uses IndexedDB automatically.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var DB_NAME = 'p66-tuner';
  var STORE = 'xdfs';
  var META_STORE = 'meta';

  function uid() {
    return 'xdf-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  function baseName(name) {
    name = String(name || 'untitled.xdf');
    return name.replace(/\.[^.]+$/, '');
  }

  /**
   * Build a library record. Pure — safe to test under node.
   */
  function makeRecord(name, xml, existingNames) {
    var base = baseName(name);
    var candidate = base;
    var n = 2;
    existingNames = existingNames || [];
    while (existingNames.indexOf(candidate) >= 0) {
      candidate = base + ' (' + (n++) + ')';
    }
    return {
      id: uid(),
      name: candidate,
      fileName: String(name || ''),
      size: String(xml || '').length,
      addedAt: new Date().toISOString(),
      xml: String(xml || '')
    };
  }

  /**
   * Sort records newest-first for the dropdown.
   */
  function sortRecords(records) {
    return (records || []).slice().sort(function (a, b) {
      return String(b.addedAt).localeCompare(String(a.addedAt));
    });
  }

  /**
   * IndexedDB backend. All methods return promises.
   */
  function indexedDbBackend() {
    if (typeof indexedDB === 'undefined') {
      return null;
    }
    var dbp = null;
    function db() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains(STORE)) {
            d.createObjectStore(STORE, { keyPath: 'id' });
          }
          if (!d.objectStoreNames.contains(META_STORE)) {
            d.createObjectStore(META_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction(store, mode);
          var os = t.objectStore(store);
          var req = fn(os);
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
    return {
      save: function (rec) { return tx(STORE, 'readwrite', function (os) { return os.put(rec); }); },
      list: function () { return tx(STORE, 'readonly', function (os) { return os.getAll(); }); },
      get: function (id) { return tx(STORE, 'readonly', function (os) { return os.get(id); }); },
      remove: function (id) { return tx(STORE, 'readwrite', function (os) { return os.delete(id); }); },
      getMeta: function (key) {
        return tx(META_STORE, 'readonly', function (os) { return os.get(key); })
          .then(function (r) { return r ? r.value : null; });
      },
      setMeta: function (key, value) {
        return tx(META_STORE, 'readwrite', function (os) { return os.put({ key: key, value: value }); });
      }
    };
  }

  /**
   * In-memory backend with the same shape — used by the node tests and as
   * a fallback when IndexedDB is unavailable.
   */
  function memoryBackend() {
    var recs = {};
    var meta = {};
    return {
      save: function (rec) { recs[rec.id] = rec; return Promise.resolve(rec.id); },
      list: function () {
        return Promise.resolve(Object.keys(recs).map(function (k) { return recs[k]; }));
      },
      get: function (id) { return Promise.resolve(recs[id] || null); },
      remove: function (id) { delete recs[id]; return Promise.resolve(); },
      getMeta: function (key) { return Promise.resolve(key in meta ? meta[key] : null); },
      setMeta: function (key, value) { meta[key] = value; return Promise.resolve(); }
    };
  }

  /**
   * Create a library bound to a backend.
   */
  function createXdfLibrary(backend) {
    backend = backend || indexedDbBackend() || memoryBackend();
    return {
      /** Save an XDF; resolves to the stored record. */
      save: function (name, xml) {
        var self = this;
        return self.list().then(function (recs) {
          var rec = makeRecord(name, xml, recs.map(function (r) { return r.name; }));
          return backend.save(rec).then(function () { return rec; });
        });
      },
      list: function () {
        return backend.list().then(sortRecords);
      },
      get: function (id) { return backend.get(id); },
      remove: function (id) { return backend.remove(id); },
      getLastUsed: function () { return backend.getMeta('lastUsed'); },
      setLastUsed: function (id) { return backend.setMeta('lastUsed', id); },
      available: function () { return true; }
    };
  }

  P66.makeXdfRecord = makeRecord;
  P66.sortXdfRecords = sortRecords;
  P66.createXdfLibrary = createXdfLibrary;
  P66.xdfMemoryBackend = memoryBackend;
  // Browser default instance; lazily bound so node never touches indexedDB.
  var defaultLib = null;
  Object.defineProperty(P66, 'xdfLibrary', {
    get: function () {
      if (!defaultLib) defaultLib = createXdfLibrary();
      return defaultLib;
    },
    configurable: true
  });
})(typeof window !== 'undefined' ? window : global);
