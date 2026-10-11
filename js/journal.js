/* P66-Tuner tune journal
 *
 * Tuning is an iterative loop: log -> analyze -> patch -> flash -> drive ->
 * log again. The journal is where the human writes down what happened
 * between the numbers: "flashed 10/11, pulled 2° at 3000rpm, knock gone but
 * idle hunts." The next session's numbers only make sense with those notes.
 *
 * Entries persist in localStorage (memory shim when unavailable, injectable
 * for tests):
 *
 *   var journal = P66.createJournal();
 *   journal.add({ logName, binFingerprint, patchCount, note }) -> entry
 *   journal.list()   // newest first
 *   journal.remove(id)
 *   journal.clear()
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var STORE_KEY = 'p66-journal-v1';
  var MAX_ENTRIES = 50;

  function memoryStore() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  function defaultStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* private mode */ }
    return memoryStore();
  }

  function load(store) {
    try {
      var raw = store.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function save(store, entries) {
    try { store.setItem(STORE_KEY, JSON.stringify(entries)); } catch (e) { /* storage full/blocked */ }
  }

  function makeId() {
    return 'j' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function createJournal(store) {
    store = store || defaultStore();

    return {
      add: function (entry) {
        entry = entry || {};
        var note = String(entry.note || '').trim();
        if (!note) return null; // empty notes are noise; refuse politely
        var entries = load(store);
        var full = {
          id: makeId(),
          date: new Date().toISOString(),
          logName: entry.logName || '',
          binFingerprint: entry.binFingerprint || '',
          patchCount: entry.patchCount || 0,
          note: note
        };
        entries.unshift(full); // newest first
        while (entries.length > MAX_ENTRIES) entries.pop();
        save(store, entries);
        return full;
      },

      list: function () {
        return load(store);
      },

      remove: function (id) {
        var entries = load(store).filter(function (e) { return e.id !== id; });
        save(store, entries);
      },

      clear: function () {
        save(store, []);
      }
    };
  }

  P66.createJournal = createJournal;
  P66._journalMemoryStore = memoryStore;
})(typeof window !== 'undefined' ? window : global);
