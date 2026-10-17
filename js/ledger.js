/* P66-Tuner cumulative patch ledger (runaway guard)
 *
 * One tune iteration is capped per mode, but nothing stops a user from
 * flashing five "conservative" tunes in a row and walking a cell 25% away
 * from stock. The ledger records every downloaded patch set per source
 * binary (keyed by SHA-256 fingerprint) and warns when a new patch would
 * push a cell's cumulative change past safe totals.
 *
 * Fuel deltas compound multiplicatively: two +5% patches on the same cell
 * are a 10.25% total move, not 10%. Spark deltas are additive degrees.
 *
 *   var ledger = P66.createLedger();            // localStorage-backed
 *   var ledger = P66.createLedger(memoryStore); // injectable for tests
 *   ledger.record(fingerprint, patches, meta)
 *   ledger.check(fingerprint, newPatches) -> [warnings]
 *   ledger.history(fingerprint) -> [entries]
 *   ledger.clear(fingerprint)
 *
 * This is a guardrail, not a guarantee: it tracks what the app produced,
 * not what was actually flashed. Wording everywhere stays in "warn" lane.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var STORE_KEY = 'p66-ledger-v1';
  var MAX_ENTRIES = 20; // per fingerprint; old tune history prunes itself

  // Cumulative-change warning thresholds.
  var LIMITS = {
    fuelPct: 15,   // |total fuel move| on one cell past this -> warn
    sparkDeg: 6,   // |total spark move| on one cell past this -> warn
    pePct: 15,
    transPct: 20   // |total line-pressure / shift-schedule move| past this -> warn
  };

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

  function patchKey(p) {
    return (p.table || '?') + '@' + (p.addressHex || ('0x' + (p.address || 0).toString(16).toUpperCase()));
  }

  function isSparkPatch(p) {
    return p.deltaDeg !== undefined && p.deltaDeg !== null;
  }

  function isTransPatch(p) {
    return /line pressure|upshift|downshift/i.test(p.table || '');
  }

  function loadAll(store) {
    try {
      var raw = store.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveAll(store, all) {
    try { store.setItem(STORE_KEY, JSON.stringify(all)); } catch (e) { /* storage full/blocked */ }
  }

  /**
   * Compound per-key cumulative deltas from recorded entries plus a set of
   * new patches. Returns { key: { table, addressHex, kind, cumulative } }
   * where cumulative is total % (fuel/PE) or total degrees (spark).
   */
  function cumulativeDeltas(entries, newPatches) {
    var acc = {}; // key -> { table, addressHex, kind, factor, degrees }
    function ensure(p) {
      var k = patchKey(p);
      if (!acc[k]) {
        acc[k] = {
          table: p.table || '?', addressHex: p.addressHex || '?',
          kind: isSparkPatch(p) ? 'spark' : (isTransPatch(p) ? 'trans' : 'fuel'),
          factor: 1, degrees: 0
        };
      }
      return acc[k];
    }
    (entries || []).forEach(function (e) {
      (e.deltas || []).forEach(function (d) {
        var a = ensure(d);
        if (a.kind === 'spark') a.degrees += (d.deltaDeg || 0);
        else a.factor *= (1 + (d.deltaPct || 0) / 100);
      });
    });
    (newPatches || []).forEach(function (p) {
      var a = ensure(p);
      if (a.kind === 'spark') a.degrees += (p.deltaDeg || 0);
      else a.factor *= (1 + (p.deltaPct || 0) / 100);
    });
    var out = {};
    Object.keys(acc).forEach(function (k) {
      var a = acc[k];
      out[k] = {
        table: a.table, addressHex: a.addressHex, kind: a.kind,
        cumulative: a.kind === 'spark'
          ? Math.round(a.degrees * 100) / 100
          : Math.round((a.factor - 1) * 10000) / 100
      };
    });
    return out;
  }

  function createLedger(store) {
    store = store || defaultStore();

    function entriesFor(fingerprint) {
      var all = loadAll(store);
      var list = all[fingerprint] || [];
      return Array.isArray(list) ? list : [];
    }

    return {
      /**
       * Record a downloaded patch set. Call when the user takes the binary,
       * i.e. the best available proxy for "about to flash".
       */
      record: function (fingerprint, patches, meta) {
        if (!fingerprint || !patches || !patches.length) return;
        var all = loadAll(store);
        var list = entriesFor(fingerprint);
        var sig = patches.map(function (p) {
          return patchKey(p) + ':' + (p.deltaPct !== undefined && p.deltaPct !== null ? p.deltaPct : p.deltaDeg);
        }).sort().join('|');
        var last = list[list.length - 1];
        // Same patch set downloaded twice within minutes is an accidental
        // double-download, not two flashes — don't double-count it. A real
        // re-tune cycle (flash, drive, re-log) takes far longer than this.
        var DEDUP_MS = 10 * 60 * 1000;
        if (last && last.sig === sig && (Date.now() - new Date(last.date).getTime()) < DEDUP_MS) return;
        list.push({
          sig: sig,
          date: new Date().toISOString(),
          patchCount: patches.length,
          note: (meta && meta.note) || '',
          deltas: patches.map(function (p) {
            return {
              key: patchKey(p), table: p.table || '?', addressHex: p.addressHex || '?',
              deltaPct: (p.deltaPct !== undefined && p.deltaPct !== null) ? p.deltaPct : null,
              deltaDeg: (p.deltaDeg !== undefined && p.deltaDeg !== null) ? p.deltaDeg : null
            };
          })
        });
        while (list.length > MAX_ENTRIES) list.shift();
        all[fingerprint] = list;
        saveAll(store, all);
      },

      /**
       * Check new patches against recorded history. Returns warnings for
       * cells whose cumulative change would pass the limits.
       */
      check: function (fingerprint, newPatches) {
        var warnings = [];
        if (!fingerprint || !newPatches || !newPatches.length) return warnings;
        var cum = cumulativeDeltas(entriesFor(fingerprint), newPatches);
        Object.keys(cum).forEach(function (k) {
          var c = cum[k];
          var limit = c.kind === 'spark' ? LIMITS.sparkDeg
            : c.kind === 'trans' ? LIMITS.transPct
            : (/pe/i.test(c.table || '') ? LIMITS.pePct : LIMITS.fuelPct);
          var unit = c.kind === 'spark' ? '°' : '%';
          if (Math.abs(c.cumulative) >= limit) {
            warnings.push({
              key: k, table: c.table, addressHex: c.addressHex, kind: c.kind,
              cumulative: c.cumulative, limit: limit,
              message: c.table + ' ' + c.addressHex + ': cumulative ' +
                (c.cumulative > 0 ? '+' : '') + c.cumulative + unit +
                ' across sessions reaches the ±' + limit + unit +
                ' guardrail. This cell has moved a long way from stock — ' +
                'verify the trend is actually improving the log before flashing further.'
            });
          }
        });
        // Most-moved first.
        warnings.sort(function (a, b) {
          return Math.abs(b.cumulative) / b.limit - Math.abs(a.cumulative) / a.limit;
        });
        return warnings;
      },

      history: function (fingerprint) {
        return entriesFor(fingerprint);
      },

      clear: function (fingerprint) {
        var all = loadAll(store);
        delete all[fingerprint];
        saveAll(store, all);
      }
    };
  }

  P66.createLedger = createLedger;
  P66.LEDGER_LIMITS = LIMITS;
  P66._ledgerMemoryStore = memoryStore;
})(typeof window !== 'undefined' ? window : global);
