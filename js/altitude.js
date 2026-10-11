/* P66-Tuner altitude / barometric awareness
 *
 * Why the app cares about altitude: the PCM's fueling math is baro-aware,
 * and a lying barometric reading makes tuners chase the VE table for a
 * problem that isn't in the VE table. At 2840 ft the air holds ~91 kPa
 * instead of 101 — if the PCM thinks it's at sea level, every load
 * calculation is wrong and no VE patch fixes that.
 *
 * What this module does NOT do: it does not "correct" fuel suggestions for
 * altitude. Trim-derived VE corrections are inherently altitude-correct —
 * closed loop already compensates for air density. This module is purely
 * diagnostic: it checks that the PCM's baro reading is plausible for the
 * user's altitude, and sanity-checks WOT MAP against baro (MAP can never
 * physically exceed baro on a naturally aspirated engine).
 *
 *   P66.baroForAltitude(feet) -> kPa (standard atmosphere)
 *   P66.createAltitudeStore() -> { get(), set(feet) } (persisted, default 2840)
 *   P66.analyzeBaro(rows, mapResult, altitudeFt) -> report
 *
 * Works in browser and node. No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var STORE_KEY = 'p66-altitude-ft';
  var DEFAULT_ALTITUDE_FT = 2840;

  // Baro plausibility thresholds (kPa).
  var BARO_WARN_KPA = 3;  // |pcm - expected| past this -> verify altitude setting
  var BARO_FAULT_KPA = 5; // past this -> suspect the baro sensor itself
  var BARO_DRIFT_KPA = 8; // baro range across the log past this -> note the refresh

  /**
   * Standard-atmosphere barometric pressure for an altitude.
   * P = 101.325 * (1 - 2.25577e-5 * h)^5.25588, h in meters.
   */
  function baroForAltitude(feet) {
    var h = (Number(feet) || 0) * 0.3048;
    if (h < 0) h = 0;
    return 101.325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
  }

  function round1(v) { return Math.round(v * 10) / 10; }

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

  function createAltitudeStore(store) {
    store = store || defaultStore();
    return {
      get: function () {
        var raw = null;
        try { raw = store.getItem(STORE_KEY); } catch (e) { /* ignore */ }
        var v = parseFloat(raw);
        if (!isFinite(v) || v < -1000 || v > 15000) return DEFAULT_ALTITUDE_FT;
        return Math.round(v);
      },
      set: function (feet) {
        var v = parseFloat(feet);
        if (!isFinite(v) || v < -1000 || v > 15000) return false;
        try { store.setItem(STORE_KEY, String(Math.round(v))); } catch (e) { /* ignore */ }
        return true;
      }
    };
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /**
   * Baro plausibility diagnostic.
   * Compares the PCM's reported barometric pressure against the expected
   * value for the user's altitude, and checks WOT MAP against baro.
   */
  function analyzeBaro(rows, mapResult, altitudeFt) {
    var baroCol = P66.columnFor(mapResult, 'BARO');
    var expected = baroForAltitude(altitudeFt);
    if (!baroCol) {
      return {
        available: false,
        altitudeFt: altitudeFt,
        expectedKpa: round1(expected),
        reason: 'No barometric pressure channel in this log — baro plausibility cannot be checked. ' +
          'Log the BARO channel if your ADX exposes it.'
      };
    }
    var vals = [];
    rows.forEach(function (row) {
      var v = num(row[baroCol]);
      if (v !== null && v > 20 && v < 120) vals.push(v); // sanity window for kPa
    });
    if (vals.length < 10) {
      return {
        available: false,
        altitudeFt: altitudeFt,
        expectedKpa: round1(expected),
        reason: 'Baro channel present but has too few valid samples (' + vals.length + ').'
      };
    }
    vals.sort(function (a, b) { return a - b; });
    var median = vals[Math.floor(vals.length / 2)];
    var min = vals[0], max = vals[vals.length - 1];
    var delta = median - expected;

    var status = 'ok';
    var note;
    if (Math.abs(delta) >= BARO_FAULT_KPA) {
      status = 'fault';
      note = 'PCM baro reads ' + round1(median) + ' kPa but ' + altitudeFt + ' ft expects ~' +
        round1(expected) + ' kPa (|Δ| ' + round1(Math.abs(delta)) + ' kPa). ' +
        'Suspect the baro sensor or a stale key-on reading — the PCM\'s load math is wrong, ' +
        'and VE patches will be compensating for bad baro instead of a bad VE table. Fix this first.';
    } else if (Math.abs(delta) >= BARO_WARN_KPA) {
      status = 'warn';
      note = 'PCM baro ' + round1(median) + ' kPa vs ~' + round1(expected) + ' kPa expected at ' +
        altitudeFt + ' ft (|Δ| ' + round1(Math.abs(delta)) + ' kPa). ' +
        'Probably weather or the altitude setting — confirm the altitude is right before worrying.';
    } else {
      note = 'PCM baro ' + round1(median) + ' kPa agrees with ~' + round1(expected) +
        ' kPa expected at ' + altitudeFt + ' ft. Load calculations are on solid ground.';
    }
    if (max - min >= BARO_DRIFT_KPA) {
      note += ' Baro drifted ' + round1(min) + '–' + round1(max) + ' kPa across the log ' +
        '(the P66 refreshes baro at high load) — median used for the comparison.';
    }

    // WOT MAP vs baro: physically, MAP cannot exceed baro on an NA engine.
    var wotFlag = null;
    var mapCol = P66.columnFor(mapResult, 'MAP');
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    if (mapCol && tpsCol) {
      var wotPeak = -Infinity, wotN = 0;
      rows.forEach(function (row) {
        var tps = num(row[tpsCol]);
        var map = num(row[mapCol]);
        if (tps !== null && tps >= 78 && map !== null) {
          wotN++;
          if (map > wotPeak) wotPeak = map;
        }
      });
      if (wotN >= 10 && wotPeak > median + 5) {
        wotFlag = 'WOT MAP peaked at ' + round1(wotPeak) + ' kPa — above the PCM\'s own baro reading (' +
          round1(median) + ' kPa). That is physically impossible on a naturally aspirated engine: ' +
          'suspect the MAP sensor, the baro reading, or both.';
        if (status === 'ok') status = 'warn';
      }
    }

    return {
      available: true,
      altitudeFt: altitudeFt,
      expectedKpa: round1(expected),
      pcmMedianKpa: round1(median),
      pcmMinKpa: round1(min),
      pcmMaxKpa: round1(max),
      samples: vals.length,
      deltaKpa: round1(delta),
      status: status,
      note: note,
      wotMapFlag: wotFlag
    };
  }

  P66.baroForAltitude = baroForAltitude;
  P66.createAltitudeStore = createAltitudeStore;
  P66.analyzeBaro = analyzeBaro;
  P66.DEFAULT_ALTITUDE_FT = DEFAULT_ALTITUDE_FT;
  P66._altitudeMemoryStore = memoryStore;
})(typeof window !== 'undefined' ? window : global);
