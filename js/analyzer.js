/* P66-Tuner analyzer
 * Segments log rows into operating regions and computes the error
 * metrics that drive tune recommendations:
 *   - fuel trim bias by RPM x MAP cell
 *   - knock retard frequency / severity
 *   - commanded vs actual lambda error
 *
 * All entry points accept either a columnar log table (from
 * P66.parseLogText) or a legacy array of row objects; legacy input is
 * normalized once at the boundary via P66.asTable, and every hot loop
 * below runs on Float32Array columns (NaN = missing cell).
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var REGIONS = ['idle', 'cruise', 'transient', 'wot'];

  // NaN -> null (missing-cell bridge for helpers that expect null).
  function nn(v) { return v !== v ? null : v; }

  // Numeric column for a mapped signal name, or null.
  function ncol(t, name) { return P66.numView(t, name); } // forgiving per-cell-parsed view

  // Sample up to N numeric values from a column for style detection.
  function sampleColumn(t, name, max) {
    max = max || 500;
    var out = [];
    var c = ncol(t, name);
    if (!c) return out;
    for (var i = 0; i < t.rowCount && out.length < max; i++) {
      var v = c[i];
      if (v === v) out.push(v);
    }
    return out;
  }

  /**
   * Assign an operating region to each row.
   * Legacy array input: mutates rows by adding _region (old contract).
   * Log-table input: sets table.regions (same values, columnar home).
   * Needs RPM; TPS preferred, MAP as fallback for load detection.
   */
  function segmentRows(rows, mapResult) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var rpmC = ncol(t, P66.columnFor(mapResult, 'RPM'));
    var tpsC = ncol(t, P66.columnFor(mapResult, 'TPS'));
    var mapC = ncol(t, P66.columnFor(mapResult, 'MAP'));

    var regions = new Array(n);
    // First pass: compute per-sample deltas for transient detection.
    var prevTps = NaN, prevMap = NaN;
    for (var i = 0; i < n; i++) {
      var rpm = rpmC ? rpmC[i] : NaN;
      var tps = tpsC ? tpsC[i] : NaN;
      var map = mapC ? mapC[i] : NaN;

      var region = 'cruise'; // default
      var isTransient = false;
      if (tps === tps && prevTps === prevTps && Math.abs(tps - prevTps) >= 8) isTransient = true;
      if (map === map && prevMap === prevMap && Math.abs(map - prevMap) >= 8) isTransient = true;

      if (rpm !== rpm) {
        region = 'cruise';
      } else if (isTransient) {
        region = 'transient';
      } else if (tps === tps && tps >= 78) {
        region = 'wot';
      } else if (rpm < 1100 && (tps !== tps || tps < 5) && (map !== map || map < 50)) {
        region = 'idle';
      } else {
        region = 'cruise';
      }
      regions[i] = region;
      prevTps = tps;
      prevMap = map;
    }
    if (P66.isLogTable(rows)) {
      rows.regions = regions;
    } else {
      // Legacy contract: _region lands on the caller's row objects.
      var src = Array.isArray(rows) ? rows : (rows && rows.rows) || [];
      for (var k = 0; k < n && k < src.length; k++) {
        if (src[k] && typeof src[k] === 'object') src[k]._region = regions[k];
      }
    }
    return rows;
  }

  function rpmBin(rpm, width) {
    width = width || 500;
    var b = Math.floor(rpm / width) * width;
    return b + '-' + (b + width);
  }

  function mapBin(map, width) {
    width = width || 10;
    var b = Math.floor(map / width) * width;
    return b + '-' + (b + width);
  }

  /**
   * Sample-quality gating for trim-driven analysis.
   *
   * Two classic sources of bad fueling suggestions:
   *   1. Cold operation — fuel trims during warmup (open loop, cold O2) do
   *      not reflect the VE table. Rows below the warmed-up ECT threshold
   *      are excluded when an ECT channel is mapped.
   *   2. Transients — accel enrichment and decel fuel cut swing trims for
   *      reasons unrelated to the VE cell. Transient rows are excluded.
   *
   * Returns { rows, gatedWarmup, gatedTransient, ectAvailable, warmNote }.
   * `rows` keeps the input's shape: a filtered log table for table input,
   * the kept original row objects for legacy array input.
   * A missing ECT value on a row is treated as unknown (row kept): the gate
   * targets the known-cold warmup period, not sensor dropouts mid-log.
   */
  var WARM_F = 160;

  // Idle-VE entry convention (stock-calibration "Idle VE Possible" scalars:
  // 1450 RPM, ~2% TPS, 2 MPH). The PCM runs the Idle VE table (not Main VE)
  // when these hold. TPS/VSS channels are optional — without them the test
  // falls back to RPM-only. Shared by extractFeatures (isIdle) and
  // analyzeFuelTrims (per-cell idle fraction).
  var IDLE_VE_RPM_MAX = 1450, IDLE_VE_TPS_MAX = 2, IDLE_VE_VSS_MAX = 3;

  /**
   * Warmup threshold for the ECT column, without trusting a unit label.
   * A driven P66 log reports ECT in °F (TunerPro units row) with a session
   * max well above 140; anything at or below that is either °C or an
   * engine that never warmed up. In the ambiguous band an absolute
   * threshold cannot be trusted, so the warmup edge is cut relative to
   * the session max — the rising cold-start edge is what pollutes trims.
   * Returns { threshold, label } or null when no ECT samples exist.
   */
  function ectWarmThreshold(t, ectName) {
    var c = ncol(t, ectName);
    if (!c) return null;
    var max = -Infinity, n = 0;
    for (var i = 0; i < t.rowCount; i++) {
      var v = c[i];
      if (v !== v) continue;
      n++;
      if (v > max) max = v;
    }
    if (!n) return null;
    if (max > 140) return { threshold: WARM_F, label: WARM_F + '°F' };
    return { threshold: max - 10, label: 'within 10° of session max (' + Math.round(max) + '°)' };
  }

  function qualityRows(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var ectName = P66.columnFor(mapResult, 'ECT');
    // Optional features: the keep() predicate then reads the precomputed
    // isTransient/isWarm columns instead of re-scanning regions and ECT.
    var feats = featuresFor(t, mapResult, features);
    var wt = feats.warmThreshold;
    var gatedWarmup = 0, gatedTransient = 0;
    var keptIndex = []; // keptIndex[j] = original row i of kept row j
    function keep(i) {
      if (feats.isTransient[i]) { gatedTransient++; return false; }
      if (!feats.isWarm[i]) { gatedWarmup++; return false; }
      keptIndex.push(i);
      return true;
    }
    var kept;
    if (P66.isLogTable(rows)) {
      kept = P66.filterTable(t, keep);
    } else {
      // Legacy contract: the kept ORIGINAL row objects, in order.
      var src = Array.isArray(rows) ? rows : (rows && rows.rows) || [];
      kept = [];
      for (var i = 0; i < n; i++) {
        if (keep(i) && i < src.length) kept.push(src[i]);
      }
    }
    return {
      rows: kept,
      keptIndex: keptIndex,
      gatedWarmup: gatedWarmup,
      gatedTransient: gatedTransient,
      ectAvailable: !!ectName,
      warmNote: wt
        ? 'Excluded ' + gatedWarmup + ' cold row(s) below ' + wt.label +
          ' and ' + gatedTransient + ' transient row(s).'
        : 'No ECT channel — warmup gating unavailable; cold-start rows included (' +
          gatedTransient + ' transient row(s) excluded).'
    };
  }

  // ---- single-pass feature extraction ---------------------------------
  //
  // P66.extractFeatures(table, mapResult) loops over the log's samples ONCE
  // and computes every per-sample derived column the analyze* reductions
  // share, so each analyzer becomes a cheap reduction over these
  // precomputed columns instead of re-scanning the log for the same
  // quantities. analyzeSession() extracts once and hands the feature
  // object to every analyze* function as an optional third argument;
  // a direct analyze*() call without features builds them on the spot
  // (see featuresFor below).

  // Drive-segment ids for the `segmentId` column (js/segments.js vocabulary).
  var SEGMENT_IDS = { idle: 0, cruise: 1, wot: 2, decel: 3, other: 4 };

  // Fallback mirror of P66.classifySegment (js/segments.js) for contexts
  // where segments.js isn't loaded (node tests that only eval analyzer.js).
  // Thresholds must match segments.js exactly; tools/features-test.js
  // asserts the two agree on a sweep of inputs whenever both are present.
  var SEG_IDLE_RPM_MAX = 1450, SEG_IDLE_TPS_MAX = 2, SEG_IDLE_VSS_MAX = 3;
  var SEG_WOT_TPS_MIN = 70;
  var SEG_DECEL_TPS_MAX = 2, SEG_DECEL_RPM_MIN = 1500, SEG_DECEL_VSS_MIN = 10;
  function classifySegmentLocal(rpm, tps, vss) {
    if (rpm === null || tps === null || vss === null) return 'other';
    if (rpm < SEG_IDLE_RPM_MAX && tps < SEG_IDLE_TPS_MAX && vss < SEG_IDLE_VSS_MAX) return 'idle';
    if (tps > SEG_WOT_TPS_MIN) return 'wot';
    if (tps < SEG_DECEL_TPS_MAX && rpm > SEG_DECEL_RPM_MIN && vss > SEG_DECEL_VSS_MIN) return 'decel';
    if (vss > SEG_IDLE_VSS_MAX && tps >= SEG_IDLE_TPS_MAX && tps <= SEG_WOT_TPS_MIN) return 'cruise';
    return 'other';
  }

  /**
   * P66.extractFeatures(table, mapResult)
   *
   * Single pass over all rows. Returns a feature object:
   *
   *   {
   *     table, rowCount,
   *     region:      [String]  per-sample operating region from the
   *                             segmentRows algorithm: 'idle' | 'cruise' |
   *                             'transient' | 'wot'. Transient = |dTPS| >= 8%
   *                             or |dMAP| >= 8 kPa vs the previous sample
   *                             (both samples present); WOT = TPS >= 78%;
   *                             idle = RPM < 1100, TPS < 5% (or missing),
   *                             MAP < 50 kPa (or missing); else 'cruise'.
   *                             Missing RPM classifies 'cruise'.
   *     isTransient: [Boolean] region === 'transient'. Rows with missing
   *                             RPM never count as transient (they classify
   *                             'cruise'), exactly like segmentRows.
   *     segmentId:   Uint8Array drive-segment id per sample, from the
   *                             js/segments.js classifySegment logic:
   *                             0 idle (RPM<1450, TPS<2%, VSS<3),
   *                             1 cruise (VSS>3, TPS 2-70%),
   *                             2 wot (TPS>70%),
   *                             3 decel (TPS<2%, RPM>1500, VSS>10),
   *                             4 other (incl. any missing RPM/TPS/VSS).
   *                             Priority: idle > wot > decel > cruise.
   *     gear:       Uint8Array  inferred gear, 0 = unknown, else 1-4.
   *                             Relocated verbatim from analyzeTransmission:
   *                             4L60E RPM-per-MPH band centers 136 / 72 /
   *                             44.5 / 31, nearest-center wins, rejected
   *                             when the ratio is outside 12-220 or farther
   *                             than 28% from the winning center, and a new
   *                             gear must persist 3 consecutive samples
   *                             (debounce). Samples with missing RPM/VSS,
   *                             VSS < 2, or RPM < 400 keep the previous gear.
   *     ratio:      [Number]  RPM-per-MPH per sample (float64, round2),
   *                             NaN when unknown.
   *     vssToMph, vssUnit, cruiseRatioMedian:
   *                             VSS unit auto-detect, relocated verbatim:
   *                             median RPM/VSS over light-cruise samples
   *                             (TPS 8-35% or missing, |dVSS| < 1.5,
   *                             1200 < RPM < 2800, VSS >= 5); median < 25
   *                             means the log is in KPH (x0.621371).
   *     isIdle:     [Boolean] PCM Idle-VE entry convention:
   *                             RPM < 1450 AND (TPS missing or < 2%) AND
   *                             (VSS missing or < 3). Same test
   *                             analyzeFuelTrims uses for idleFraction.
   *     isWarm:     [Boolean] ECT at/above the warmup threshold. The
   *                             threshold is ectWarmThreshold(): 160 F when
   *                             the session ECT max exceeds 140, else
   *                             (session max - 10). Missing ECT channel or
   *                             missing cell counts as warm (the gate
   *                             targets the known-cold warmup period, not
   *                             sensor dropouts).
   *     warmThreshold: { threshold, label } | null (null = no ECT channel).
   *     engineOn:   [Boolean] RPM present and > 400 (cranking threshold).
   *     columns:    { rpm, tps, map, vss, ect } resolved channel names.
   *   }
   *
   * Missing channels: every derived column degrades gracefully (NaN-safe);
   * gear/ratio need RPM+VSS and stay unknown without them.
   */
  function extractFeatures(input, mapResult) {
    var t = P66.asTable(input);
    var n = t ? t.rowCount : 0;
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var tpsName = P66.columnFor(mapResult, 'TPS');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var vssName = P66.columnFor(mapResult, 'VSS');
    var ectName = P66.columnFor(mapResult, 'ECT');
    var rpmC = ncol(t, rpmName);
    var tpsC = ncol(t, tpsName);
    var mapC = ncol(t, mapName);
    var vssC = ncol(t, vssName);
    var ectC = ncol(t, ectName);

    // ECT warmup threshold (the same ectWarmThreshold the gating code uses).
    var wt = ectName ? ectWarmThreshold(t, ectName) : null;

    // --- VSS unit auto-detect (relocated verbatim from analyzeTransmission)
    var cruiseRatios = [];
    var prevVss = NaN;
    for (var i = 0; i < n; i++) {
      var rpm0 = rpmC ? rpmC[i] : NaN, vss0 = vssC ? vssC[i] : NaN;
      var tps0 = tpsC ? tpsC[i] : NaN;
      if (rpm0 !== rpm0 || vss0 !== vss0 || vss0 < 5) { prevVss = vss0; continue; }
      var dvss = (prevVss === prevVss && vss0 === vss0) ? Math.abs(vss0 - prevVss) : 99;
      if ((tps0 !== tps0 || (tps0 >= 8 && tps0 <= 35)) && dvss < 1.5 && rpm0 > 1200 && rpm0 < 2800) {
        cruiseRatios.push(rpm0 / vss0);
      }
      prevVss = vss0;
    }
    cruiseRatios.sort(function (a, b) { return a - b; });
    var medCruise = cruiseRatios.length ? cruiseRatios[Math.floor(cruiseRatios.length / 2)] : null;
    var vssToMph = (medCruise !== null && medCruise < 25) ? 0.621371 : 1;
    var vssUnit = vssToMph < 1 ? 'kph->mph' : 'mph';

    function gearOf(ratio) {
      if (ratio === null || ratio > 220 || ratio < 12) return null;
      var best = null, bestD = Infinity;
      for (var g = 0; g < 4; g++) {
        var d = Math.abs(ratio - TRANS_GEAR_CENTERS[g]);
        if (d < bestD) { bestD = d; best = g + 1; }
      }
      // Reject ambiguous midpoints (converter in transition).
      var lo = TRANS_GEAR_CENTERS[best - 1];
      if (bestD > lo * 0.28) return null;
      return best;
    }

    var classify = (typeof P66.classifySegment === 'function')
      ? P66.classifySegment : classifySegmentLocal;

    // When the table was already segmented (analyzeSession segments before
    // extracting), reuse those regions instead of recomputing them — same
    // values, one fewer pass over the samples.
    var preRegions = (t && t.regions && t.regions.length === n) ? t.regions : null;

    var region = new Array(n);
    var isTransient = new Array(n);
    var segmentId = new Uint8Array(n);
    var gear = new Uint8Array(n); // 0 = unknown
    var ratio = new Array(n);     // float64, NaN = unknown
    var isIdle = new Array(n);
    var isWarm = new Array(n);
    var engineOn = new Array(n);

    // --- the single pass ---
    var prevTps = NaN, prevMap = NaN;
    var candGear = null, candCount = 0, curGear = null;
    for (var s = 0; s < n; s++) {
      var rpm = rpmC ? rpmC[s] : NaN;
      var tps = tpsC ? tpsC[s] : NaN;
      var map = mapC ? mapC[s] : NaN;
      var vss = vssC ? vssC[s] : NaN;
      var ect = ectC ? ectC[s] : NaN;

      // Operating region — the segmentRows algorithm, verbatim. Skipped
      // when the table already carries regions (see preRegions above).
      var rg;
      if (preRegions) {
        rg = preRegions[s] || 'cruise';
      } else {
        var moved = false;
        if (tps === tps && prevTps === prevTps && Math.abs(tps - prevTps) >= 8) moved = true;
        if (map === map && prevMap === prevMap && Math.abs(map - prevMap) >= 8) moved = true;
        rg = 'cruise'; // default
        if (rpm !== rpm) {
          rg = 'cruise';
        } else if (moved) {
          rg = 'transient';
        } else if (tps === tps && tps >= 78) {
          rg = 'wot';
        } else if (rpm < 1100 && (tps !== tps || tps < 5) && (map !== map || map < 50)) {
          rg = 'idle';
        }
      }
      region[s] = rg;
      isTransient[s] = (rg === 'transient');

      // Drive segment (js/segments.js vocabulary); NaN -> null = 'other'.
      segmentId[s] = SEGMENT_IDS[classify(nn(rpm), nn(tps), nn(vss))];

      // PCM Idle-VE entry convention (stock "Idle VE Possible" scalars).
      isIdle[s] = rpm === rpm && rpm < IDLE_VE_RPM_MAX &&
        (tps !== tps || tps < IDLE_VE_TPS_MAX) &&
        (vss !== vss || vss < IDLE_VE_VSS_MAX);

      // Warmup: unknown ECT (no channel, or a missing cell) counts as warm.
      isWarm[s] = !(wt && ect === ect && ect < wt.threshold);

      engineOn[s] = rpm === rpm && rpm > 400;

      // Gear inference — relocated verbatim from analyzeTransmission
      // (Uint8Array storage: 0 = the old null).
      if (rpm !== rpm || vss !== vss || vss < 2 || rpm < 400) {
        gear[s] = curGear || 0; ratio[s] = NaN; candGear = null; candCount = 0;
      } else {
        var rto = rpm / (vss * vssToMph);
        ratio[s] = round2(rto);
        var gg = gearOf(rto);
        if (gg === curGear) { candGear = null; candCount = 0; }
        else if (gg === candGear) {
          if (++candCount >= TRANS_CONFIRM) { curGear = gg; candGear = null; candCount = 0; }
        } else { candGear = gg; candCount = gg === null ? 0 : 1; }
        gear[s] = curGear || 0;
      }

      prevTps = tps;
      prevMap = map;
    }

    return {
      table: t,
      rowCount: n,
      region: region,
      isTransient: isTransient,
      segmentId: segmentId,
      gear: gear,
      ratio: ratio,
      isIdle: isIdle,
      isWarm: isWarm,
      engineOn: engineOn,
      vssToMph: vssToMph,
      vssUnit: vssUnit,
      cruiseRatioMedian: medCruise,
      warmThreshold: wt,
      columns: { rpm: rpmName, tps: tpsName, map: mapName, vss: vssName, ect: ectName }
    };
  }

  /**
   * Resolve the feature object an analyze* reduction runs on.
   *
   * Caller-supplied features (analyzeSession extracts once and passes them
   * in) are used as-is. A direct analyze*() call without features builds
   * them on the spot — but keeps the legacy region source: P66.regionAt()
   * (pre-segmented regions when the caller segmented first, 'cruise'
   * everywhere otherwise), exactly what the pre-refactor loops read.
   */
  function featuresFor(t, mapResult, features) {
    var n = t ? t.rowCount : 0;
    if (features && features.table === t && features.rowCount === n) return features;
    var f = extractFeatures(t, mapResult);
    var region = new Array(n), trans = new Array(n);
    for (var i = 0; i < n; i++) {
      var r = P66.regionAt(t, i);
      region[i] = r;
      trans[i] = (r === 'transient');
    }
    f.region = region;
    f.isTransient = trans;
    return f;
  }

  /**
   * Fuel trim bias per RPM x MAP cell.
   * Combined trim = STFT + LTFT (percent), averaged across banks.
   * Trim channels are auto-normalized (percent / multiplier / GM 128-count).
   * Only warmed-up, steady-state rows are used (see qualityRows).
   */
  function analyzeFuelTrims(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var banks = P66.fuelTrimBanks(mapResult);
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var rpmC0 = ncol(t, rpmName);
    var mapC0 = ncol(t, mapName);
    if (!banks.length || !rpmC0 || !mapC0) {
      return { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
    }
    // Sample-quality gating: cold and transient rows do not reflect the VE
    // table, so they are excluded before any averaging happens.
    var q = qualityRows(t, mapResult, feats);
    var gt = P66.asTable(q.rows);
    var keptIndex = q.keptIndex;
    var rpmC = ncol(gt, rpmName);
    var mapC = ncol(gt, mapName);
    // Detect each trim column's encoding once.
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(gt, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(gt, b.ltft)) : 'percent'
      };
    });
    var trimCols = banks.map(function (b) {
      return { stft: ncol(gt, b.stft), ltft: ncol(gt, b.ltft) };
    });
    var cells = {}; // "rpmBin|mapBin" -> { count, sum, sumSq, idle }
    var totalAbs = 0, totalN = 0;
    for (var i = 0; i < gt.rowCount; i++) {
      var rpm = rpmC[i];
      var map = mapC[i];
      if (rpm !== rpm || map !== map) continue;
      var bankTrims = [];
      for (var bi = 0; bi < banks.length; bi++) {
        var tc = trimCols[bi];
        var stft = tc.stft ? P66.trimToPct(nn(tc.stft[i]), styles[bi].stft) : 0;
        var ltft = tc.ltft ? P66.trimToPct(nn(tc.ltft[i]), styles[bi].ltft) : 0;
        bankTrims.push(stft + ltft);
      }
      var combined = bankTrims.reduce(function (a, x) { return a + x; }, 0) / bankTrims.length;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { count: 0, sum: 0, sumSq: 0, idle: 0 });
      c.count++; c.sum += combined; c.sumSq += combined * combined;
      // Was the PCM on the Idle VE table for this sample? Precomputed in
      // the feature pass (same entry conditions over the same values).
      if (feats.isIdle[keptIndex[i]]) c.idle++;
      totalAbs += Math.abs(combined); totalN++;
    }
    var cellList = Object.keys(cells).map(function (key) {
      var parts = key.split('|');
      var c = cells[key];
      var mean = c.sum / c.count;
      var variance = Math.max(0, c.sumSq / c.count - mean * mean);
      return {
        rpmBin: parts[0], mapBin: parts[1],
        samples: c.count,
        avgTrim: round2(mean),
        stddev: round2(Math.sqrt(variance)),
        // Fraction of this cell's samples logged while the PCM was on the
        // Idle VE table. The tuner routes majority-idle cells there.
        idleFraction: round2(c.idle / c.count)
      };
    }).sort(function (a, b) { return Math.abs(b.avgTrim) - Math.abs(a.avgTrim); });

    return {
      available: true,
      cells: cellList,
      cellCount: cellList.length,
      overallAvgAbsTrim: totalN ? round2(totalAbs / totalN) : 0,
      totalSamples: totalN,
      qualityGating: {
        gatedWarmup: q.gatedWarmup,
        gatedTransient: q.gatedTransient,
        ectAvailable: q.ectAvailable,
        note: q.warmNote
      }
    };
  }

  /**
   * Knock retard unit handling.
   *
   * The P66 ALDL datastream reports knock retard as a raw 0-255 byte:
   *   KR (degrees) = raw * 0.175781            (docs/aldl.md, Robert Saar P66 V6 ADX)
   * TunerPro applies the ADX conversion when logging, so a normal log's KR
   * column already holds degrees — every nonzero value is a multiple of
   * 0.175781 (e.g. 8 counts = 1.41 deg). A log captured without the
   * conversion (raw ALDL stream) holds plain integers instead.
   *
   * detectKrScale: all-integer KR values => raw counts, scale them to
   * degrees. Any fractional value => already degrees, scale = 1. Scaling
   * down is the conservative direction: treating raw counts as degrees
   * would size spark retard ~5.7x too large.
   */
  var KR_RAW_TO_DEG = 0.175781;

  function detectKrScale(t, krName) {
    var c = ncol(t, krName);
    var seen = 0, allInt = true;
    if (c) {
      for (var i = 0; i < t.rowCount && seen < 2000; i++) {
        var v = c[i];
        if (v !== v || v <= 0) continue;
        seen++;
        if (v !== Math.round(v)) { allInt = false; break; }
      }
    }
    if (seen > 0 && allInt) return { scale: KR_RAW_TO_DEG, rawCounts: true };
    return { scale: 1, rawCounts: false };
  }

  /**
   * Knock retard analysis. KR > 0.5 deg counts as active knock.
   * Consecutive active rows are grouped into events; sizing uses robust
   * per-event statistics so a single spike can't drive the recommendation.
   *
   * Each exported event carries two trust flags for the tuner:
   *   suspectNoise — single-sample spike. Genuine PCM knock retard decays
   *     over many samples (~1 deg/sec observed); a full-scale spike that
   *     vanishes in one ~0.15 s sample is burst noise, not combustion knock.
   *   tipOut — throttle closed during the event (tpsDrop > 10). Classic
   *     drivetrain-noise false knock; never sized into a spark suggestion.
   */
  function analyzeKnock(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var krName = P66.columnFor(mapResult, 'KR');
    var tpsName = P66.columnFor(mapResult, 'TPS');
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var krC = ncol(t, krName);
    var tpsC = ncol(t, tpsName);
    var rpmC = ncol(t, rpmName);
    var mapC = ncol(t, mapName);
    if (!krC) return { available: false, reason: 'Need KR (knock retard) channel.' };

    var krScale = detectKrScale(t, krName);

    // Group consecutive KR-active rows into events.
    var events = [];
    var cur = null;
    for (var i = 0; i < t.rowCount; i++) {
      var krRaw = krC[i];
      var kr = (krRaw !== krRaw) ? NaN : krRaw * krScale.scale;
      if (kr === kr && kr > 0.5) {
        if (!cur) {
          cur = {
            startIdx: i, endIdx: i, samples: 0, peakKR: 0, sumKR: 0,
            regions: {}, tpsStart: tpsC ? nn(tpsC[i]) : null, tpsEnd: null
          };
        }
        cur.endIdx = i;
        cur.samples++;
        cur.sumKR += kr;
        if (kr > cur.peakKR) {
          cur.peakKR = kr;
          // Position of the worst knock: what the spark patcher retards.
          cur.peakRpm = rpmC ? nn(rpmC[i]) : null;
          cur.peakMap = mapC ? nn(mapC[i]) : null;
        }
        var region = feats.region[i];
        cur.regions[region] = (cur.regions[region] || 0) + 1;
        cur.tpsEnd = tpsC ? nn(tpsC[i]) : null;
      } else if (cur) {
        events.push(cur);
        cur = null;
      }
    }
    if (cur) events.push(cur);

    events.forEach(function (e) {
      // Majority region for the event.
      var best = 'cruise', bestN = 0;
      Object.keys(e.regions).forEach(function (r) {
        if (e.regions[r] > bestN) { bestN = e.regions[r]; best = r; }
      });
      e.region = best;
      e.avgKR = e.sumKR / e.samples;
      e.tpsDrop = (e.tpsStart !== null && e.tpsEnd !== null) ? e.tpsStart - e.tpsEnd : 0;
      e.tipOut = e.tpsDrop > 10;
      e.suspectNoise = e.samples <= 1;
    });

    var active = 0, maxKR = 0, sumKR = 0;
    var byRegion = {};
    REGIONS.forEach(function (r) { byRegion[r] = { samples: 0, events: 0, maxKR: 0 }; });
    events.forEach(function (e) {
      active += e.samples;
      sumKR += e.sumKR;
      if (e.peakKR > maxKR) maxKR = e.peakKR;
      var br = byRegion[e.region];
      br.samples += e.samples;
      br.events++;
      if (e.peakKR > br.maxKR) br.maxKR = e.peakKR;
    });

    return {
      available: true,
      knockSamples: active,
      knockEvents: events.length,
      totalSamples: t.rowCount,
      knockPct: t.rowCount ? round2(100 * active / t.rowCount) : 0,
      maxKR: round2(maxKR),
      avgKRWhenActive: active ? round2(sumKR / active) : 0,
      krUnits: 'degrees',             // report is always normalized to degrees
      krScale: krScale.scale,         // 1, or 0.175781 when raw counts were detected
      krRawCountsDetected: krScale.rawCounts,
      byRegion: byRegion,
      events: events.map(function (e) {
        return {
          startIdx: e.startIdx, samples: e.samples, region: e.region,
          peakKR: round2(e.peakKR), avgKR: round2(e.avgKR),
          rpm: e.peakRpm !== null && e.peakRpm !== undefined ? round2(e.peakRpm) : null,
          map: e.peakMap !== null && e.peakMap !== undefined ? round2(e.peakMap) : null,
          tpsDrop: e.tpsDrop === null ? null : round2(e.tpsDrop),
          tipOut: !!e.tipOut,
          suspectNoise: !!e.suspectNoise
        };
      })
    };
  }

  // Normalize an AFR/lambda reading to lambda (gasoline stoich 14.7).
  // NaN (missing) falls through the comparisons to null, same as the
  // old null input did.
  function toLambda(v) {
    if (v === null || v === undefined) return null;
    if (v > 5) return v / 14.7; // looks like AFR
    if (v > 0.3 && v < 2.5) return v; // looks like lambda
    return null;
  }

  /**
   * Commanded vs actual lambda error.
   */
  function analyzeLambda(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var cmdC = ncol(t, P66.columnFor(mapResult, 'CMD_LAMBDA'));
    var wbC = ncol(t, P66.columnFor(mapResult, 'WB_LAMBDA'));
    if (!cmdC || !wbC) {
      return { available: false, reason: 'Need commanded + wideband lambda/AFR channels.' };
    }
    var errors = [];
    var byRegion = {};
    REGIONS.forEach(function (r) { byRegion[r] = { n: 0, sumAbs: 0 }; });
    for (var i = 0; i < t.rowCount; i++) {
      var cmd = toLambda(cmdC[i]);
      var wb = toLambda(wbC[i]);
      if (cmd === null || wb === null) continue;
      var err = wb - cmd; // positive = lean vs commanded
      errors.push(err);
      var region = feats.region[i];
      byRegion[region].n++;
      byRegion[region].sumAbs += Math.abs(err);
    }
    if (!errors.length) return { available: false, reason: 'No valid lambda sample pairs.' };
    var sumAbs = errors.reduce(function (a, e) { return a + Math.abs(e); }, 0);
    var within3 = errors.filter(function (e) { return Math.abs(e) <= 0.03; }).length;
    var regionSummary = {};
    REGIONS.forEach(function (r) {
      regionSummary[r] = byRegion[r].n
        ? { samples: byRegion[r].n, avgAbsError: round3(byRegion[r].sumAbs / byRegion[r].n) }
        : { samples: 0, avgAbsError: null };
    });
    return {
      available: true,
      samples: errors.length,
      meanAbsError: round3(sumAbs / errors.length),
      pctWithin3Pct: round2(100 * within3 / errors.length),
      byRegion: regionSummary
    };
  }

  /**
   * Narrowband O2 analysis (for cars without a wideband).
   * Per-cell rich/lean bias from O2 voltage, cross-count sensor health,
   * and a WOT richness safety check.
   * Thresholds in mV: <300 lean, 300-600 switching, >600 rich.
   */
  function analyzeNarrowband(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var b1Name = P66.columnFor(mapResult, 'O2_B1');
    var b2Name = P66.columnFor(mapResult, 'O2_B2');
    var soloName = P66.columnFor(mapResult, 'O2');
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var bankDefs = [];
    if (b1Name) bankDefs.push({ name: 'bank1', sig: b1Name });
    if (b2Name) bankDefs.push({ name: 'bank2', sig: b2Name });
    if (!bankDefs.length && soloName) bankDefs.push({ name: 'single', sig: soloName });
    if (!bankDefs.length || !rpmName || !mapName) {
      return { available: false, reason: 'Need O2 sensor (mV), RPM and MAP channels.' };
    }

    // Same sample-quality gating as fuel trims: a cold O2 sensor reads lean
    // and tells you nothing about the VE table.
    var nbq = qualityRows(t, mapResult, feats);
    var gt = P66.asTable(nbq.rows);
    var keptIndex = nbq.keptIndex;
    var grpmC = ncol(gt, rpmName);
    var gmapC = ncol(gt, mapName);
    var gbanks = bankDefs.map(function (b) {
      return { name: b.name, col: ncol(gt, b.sig) };
    });

    // Per-cell bias
    var cells = {};
    for (var i = 0; i < gt.rowCount; i++) {
      var rpm = grpmC[i];
      var map = gmapC[i];
      if (rpm !== rpm || map !== map) continue;
      var sum = 0, mvn = 0;
      for (var bi = 0; bi < gbanks.length; bi++) {
        var mv = gbanks[bi].col ? gbanks[bi].col[i] : NaN;
        if (mv !== mv) continue;
        mvn++;
        sum += mv;
      }
      if (!mvn) continue;
      var avgMv = sum / mvn;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { count: 0, sumMv: 0, rich: 0, lean: 0 });
      c.count++;
      c.sumMv += avgMv;
      if (avgMv > 600) c.rich++;
      else if (avgMv < 300) c.lean++;
    }
    var cellList = Object.keys(cells).map(function (key) {
      var parts = key.split('|');
      var c = cells[key];
      var avgMv = c.sumMv / c.count;
      var pctRich = 100 * c.rich / c.count;
      var pctLean = 100 * c.lean / c.count;
      var bias = 'switching';
      if (avgMv > 600 && pctRich > 60) bias = 'rich';
      else if (avgMv < 350 && pctLean > 60) bias = 'lean';
      return {
        rpmBin: parts[0], mapBin: parts[1], samples: c.count,
        avgMv: Math.round(avgMv), pctRich: round2(pctRich), pctLean: round2(pctLean),
        bias: bias
      };
    }).sort(function (a, b) { return b.samples - a.samples; });

    // Cross-counts (sensor health): threshold crossings in closed-loop-ish rows.
    var STOICH_MV = 450;
    var timeC = ncol(gt, P66.columnFor(mapResult, 'TIME'));
    var crossCounts = gbanks.map(function (b) {
      var crossings = 0, samples = 0, prevAbove = null, firstT = NaN, lastT = NaN;
      for (var k = 0; k < gt.rowCount; k++) {
        var region = feats.region[keptIndex[k]];
        if (region !== 'cruise' && region !== 'idle') continue;
        var v = b.col ? b.col[k] : NaN;
        if (v !== v) continue;
        samples++;
        if (timeC) {
          var tt = timeC[k];
          if (tt === tt) {
            if (firstT !== firstT) firstT = tt;
            lastT = tt;
          }
        }
        var above = v > STOICH_MV;
        if (prevAbove !== null && above !== prevAbove) crossings++;
        prevAbove = above;
      }
      var perMin = null;
      if (samples > 30) {
        var minutes = (firstT === firstT && lastT === lastT && lastT > firstT)
          ? (lastT - firstT) / 60
          : samples / 600; // fallback: assume ~10 Hz
        if (minutes > 0) perMin = round2(crossings / minutes);
      }
      var health = 'unknown';
      if (perMin !== null) {
        health = perMin >= 30 ? 'healthy' : (perMin >= 10 ? 'lazy' : 'dead/slow');
      }
      return { bank: b.name, crossings: crossings, samples: samples, perMin: perMin, health: health };
    });

    // WOT richness safety check.
    var wotSum = 0, wotN = 0, wotRich = 0;
    for (var w = 0; w < gt.rowCount; w++) {
      if (feats.region[keptIndex[w]] !== 'wot') continue;
      for (var wb2 = 0; wb2 < gbanks.length; wb2++) {
        var wv = gbanks[wb2].col ? gbanks[wb2].col[w] : NaN;
        if (wv !== wv) continue;
        wotN++;
        wotSum += wv;
        if (wv > 700) wotRich++;
      }
    }
    var wotCheck = { samples: wotN, status: 'no wot data' };
    if (wotN >= 10) {
      var wotAvg = wotSum / wotN;
      var wotRichPct = 100 * wotRich / wotN;
      wotCheck = {
        samples: wotN,
        avgMv: Math.round(wotAvg),
        pctRich: round2(wotRichPct),
        status: wotAvg > 700 ? 'rich (normal)' : (wotAvg > 550 ? 'marginal — verify fueling' : 'LEAN AT WOT — investigate immediately')
      };
    }

    return {
      available: true,
      cells: cellList,
      cellCount: cellList.length,
      crossCounts: crossCounts,
      wotCheck: wotCheck,
      qualityGating: {
        gatedWarmup: nbq.gatedWarmup,
        gatedTransient: nbq.gatedTransient,
        ectAvailable: nbq.ectAvailable,
        note: nbq.warmNote
      }
    };
  }

  /**
   * Tip-in (throttle stab) analysis for accel-enrichment adequacy.
   *
   * A tip-in event is a fast TPS increase (>= TIP_IN_DTPS % in one sample,
   * ~0.15 s at ALDL rates). After each event we watch the narrowband O2 for
   * WINDOW samples (~1.2 s): a healthy AE shot drives the O2 rich briefly,
   * while an insufficient shot lets it dip lean (< LEAN_MV mV) — the classic
   * tip-in stumble. Events closer than REFRACTORY samples are merged so one
   * stab counts once.
   *
   * Cold-start rows are NOT excluded (unlike fuel trims): a tip-in is a
   * transient by nature. Events are tagged cold/warm via the ECT warmup
   * threshold so the tuner can require warm events.
   *
   * Returns { available, events, leanEvents, leanFraction, avgMinO2,
   *   avgDtps, warmEvents, ... } or { available: false, reason }.
   */
  var TIP_IN_DTPS = 10;   // % TPS jump in one sample that counts as a stab
  var TIP_IN_WINDOW = 8;  // samples after the stab to watch (~1.2 s)
  var TIP_IN_LEAN_MV = 250; // O2 below this in the window = lean spike
  var TIP_IN_REFRACTORY = 20; // min samples between counted events
  var TIP_IN_MIN_EVENTS = 5;  // minimum events before the tuner acts

  function analyzeTipIn(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var tpsName = P66.columnFor(mapResult, 'TPS');
    var o2Name = P66.columnFor(mapResult, 'O2_B1') || P66.columnFor(mapResult, 'O2');
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var ectName = P66.columnFor(mapResult, 'ECT');
    var tpsC = ncol(t, tpsName);
    var o2C = ncol(t, o2Name);
    var rpmC = ncol(t, rpmName);
    var ectC = ncol(t, ectName);
    if (!tpsC || !o2C) {
      return { available: false, reason: 'Need TPS and narrowband O2 channels.' };
    }
    var warmThr = feats.warmThreshold;
    var n = t.rowCount;

    var events = [];
    var prevTps = NaN, lastEventIdx = -TIP_IN_REFRACTORY;
    for (var i = 0; i < n; i++) {
      var tps = tpsC[i];
      if (tps !== tps) { prevTps = NaN; continue; }
      if (prevTps === prevTps && i - lastEventIdx >= TIP_IN_REFRACTORY) {
        var dtps = tps - prevTps;
        if (dtps >= TIP_IN_DTPS) {
          // Confirm a real stab, not a one-sample data glitch: the throttle
          // must stay open (>= +5%) for most of the next 5 samples.
          var sustained = 0;
          for (var k = i + 1; k < Math.min(i + 6, n); k++) {
            var tk = tpsC[k];
            if (tk === tk && tk >= prevTps + 5) sustained++;
          }
          if (sustained < 3) { prevTps = tps; continue; }
          var minO2 = Infinity, o2n = 0;
          for (var j = i; j < Math.min(i + TIP_IN_WINDOW, n); j++) {
            var o2 = o2C[j];
            if (o2 !== o2) continue;
            o2n++;
            if (o2 < minO2) minO2 = o2;
          }
          var ect = ectC ? ectC[i] : NaN;
          events.push({
            index: i,
            dtps: round2(dtps),
            tpsFrom: round2(prevTps),
            tpsTo: round2(tps),
            rpm: rpmC ? nn(rpmC[i]) : null,
            minO2: o2n ? Math.round(minO2) : null,
            leanSpike: o2n > 0 && minO2 < TIP_IN_LEAN_MV,
            cold: ect === ect && warmThr !== null && ect < warmThr.threshold
          });
          lastEventIdx = i;
        }
      }
      prevTps = tps;
    }

    var lean = events.filter(function (e) { return e.leanSpike; });
    var warm = events.filter(function (e) { return !e.cold; });
    function avg(list, key) {
      var s = 0, cnt = 0;
      list.forEach(function (e) { if (e[key] !== null) { s += e[key]; cnt++; } });
      return cnt ? Math.round(s / cnt) : null;
    }
    return {
      available: true,
      events: events.length,
      warmEvents: warm.length,
      leanEvents: lean.length,
      leanFraction: events.length ? round2(lean.length / events.length) : 0,
      warmLeanFraction: warm.length ? round2(lean.filter(function (e) { return !e.cold; }).length / warm.length) : 0,
      avgMinO2: avg(lean, 'minO2'),
      avgDtps: avg(events, 'dtps'),
      minEvents: TIP_IN_MIN_EVENTS,
      tipInDtps: TIP_IN_DTPS,
      windowSamples: TIP_IN_WINDOW,
      leanThresholdMv: TIP_IN_LEAN_MV,
      sampleSec: 0.145, // nominal ALDL sample interval; window ≈ 1.2 s
      eventsDetail: events.slice(0, 25)
    };
  }

  /**
   * Power-enrichment entry analysis.
   *
   * PE (wide-open-throttle fueling) should engage promptly when the driver
   * goes to high throttle. This finds high-throttle episodes (TPS >= 60%
   * sustained ~1 s) and checks whether commanded lambda drops into PE range
   * (< 0.95) during each episode, and how long after the episode starts.
   * Late or absent PE = lazy WOT response; the fix is an earlier PE entry
   * (lower TPS% threshold).
   *
   * Needs TPS and commanded lambda; without commanded lambda PE engagement
   * cannot be observed, so the check reports unavailable.
   */
  var PE_TPS_MIN = 60;      // % TPS that counts as high throttle
  var PE_EPISODE_MIN = 7;   // samples of sustained high TPS (~1 s)
  var PE_LAMBDA_MAX = 0.95; // commanded lambda below this = PE active
  var PE_MIN_EPISODES = 3;  // minimum episodes before the tuner acts

  function analyzePeEntry(rows, mapResult, features) {
    var t = P66.asTable(rows);
    // features accepted for a uniform analyze* signature; PE entry needs
    // no derived columns — it reduces TPS + commanded lambda directly.
    void features;
    var tpsName = P66.columnFor(mapResult, 'TPS');
    var cmdName = P66.columnFor(mapResult, 'CMD_LAMBDA');
    var tpsC = ncol(t, tpsName);
    var cmdC = ncol(t, cmdName);
    if (!tpsC) return { available: false, reason: 'Need TPS channel.' };
    if (!cmdC) {
      return { available: false, reason: 'Need commanded lambda/AFR channel.' };
    }
    var episodes = [];
    var cur = null;
    for (var i = 0; i < t.rowCount; i++) {
      var tps = tpsC[i];
      if (tps === tps && tps >= PE_TPS_MIN) {
        if (!cur) cur = { startIdx: i, samples: 0, peAt: null };
        cur.samples++;
        if (cur.peAt === null) {
          var lambda = toLambda(cmdC[i]);
          if (lambda !== null && lambda < PE_LAMBDA_MAX) cur.peAt = i;
        }
      } else if (cur) {
        if (cur.samples >= PE_EPISODE_MIN) episodes.push(cur);
        cur = null;
      }
    }
    if (cur && cur.samples >= PE_EPISODE_MIN) episodes.push(cur);

    var engaged = episodes.filter(function (e) { return e.peAt !== null; });
    function avgDelay() {
      var s = 0;
      engaged.forEach(function (e) { s += (e.peAt - e.startIdx); });
      return engaged.length ? s / engaged.length : null;
    }
    var d = avgDelay();
    return {
      available: true,
      episodes: episodes.length,
      peEngaged: engaged.length,
      engageFraction: episodes.length ? round2(engaged.length / episodes.length) : 0,
      avgDelaySamples: d !== null ? round2(d) : null,
      avgDelaySec: d !== null ? round2(d * 0.145) : null,
      minEpisodes: PE_MIN_EPISODES,
      tpsThreshold: PE_TPS_MIN,
      peLambda: PE_LAMBDA_MAX
    };
  }

  /**
   * Transmission analysis — gear inference, shift events, TCC behavior,
   * kickdown response, and shift hunting.
   *
   * The P66 ALDL datastream carries no gear or TCC channels, so gear is
   * inferred from the RPM/VSS ratio. A 4L60E's gear ratios (3.06 / 1.625 /
   * 1.00 / 0.696) put each gear in a distinct RPM-per-MPH band (assuming a
   * ~3.42 axle and stock-size tire; bands are wide enough to absorb common
   * axle/tire combos, and VSS units are auto-detected from cruise data).
   * An unlocked converter reads ~8-15% high (slip); a locked TCC reads at
   * the band floor — that step is how TCC apply/release is detected.
   *
   * Needs RPM and VSS. TPS sharpens every finding (shift context, kickdown
   * detection) but the gear/shift core works without it.
   */
  var TRANS_GEAR_CENTERS = [136, 72, 44.5, 31]; // RPM/MPH, gears 1-4
  var TRANS_CONFIRM = 3;        // consecutive samples to confirm a gear
  var TRANS_FLARE_RPM = 150;    // RPM rise during an upshift = slipping/flare
  var TRANS_MIN_SHIFTS = 3;     // minimum upshifts before the tuner acts
  var TRANS_KICK_DTPS = 20;     // % TPS jump that counts as a kickdown stab
  var TRANS_KICK_TPS_MIN = 40;  // stab must reach at least this TPS
  var TRANS_KICK_WINDOW = 20;   // samples (~3 s) to wait for the downshift
  var TRANS_KICK_SLOW_SEC = 1.5;// avg kickdown slower than this = lazy
  var TRANS_MIN_KICKDOWNS = 3;  // minimum kickdowns before the tuner acts
  var TRANS_TCC_STEP = 0.06;    // 6% ratio step = TCC apply/release
  var TRANS_HUNT_REVERSALS = 3;// gear-pair reversals in window = hunting
  var TRANS_HUNT_WINDOW = 300;  // samples (~45 s)

  function analyzeTransmission(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var feats = featuresFor(t, mapResult, features);
    var rpmC = ncol(t, P66.columnFor(mapResult, 'RPM'));
    var vssC = ncol(t, P66.columnFor(mapResult, 'VSS'));
    var tpsC = ncol(t, P66.columnFor(mapResult, 'TPS'));
    if (!rpmC || !vssC) {
      return { available: false, reason: 'Need RPM and VSS (vehicle speed) channels.' };
    }

    // Gear inference now lives in P66.extractFeatures (single pass, shared
    // with the other analyzers; the algorithm was relocated verbatim, only
    // the storage changed: gear is a Uint8Array with 0 = the old null,
    // ratio is a plain float64 Array with NaN = the old null).
    var gears = feats.gear;
    var ratios = feats.ratio;
    var vssToMph = feats.vssToMph;
    var vssUnit = feats.vssUnit;
    var medCruise = feats.cruiseRatioMedian;

    function colVal(c, i) {
      if (!c) return null;
      var v = c[i];
      return v !== v ? null : v;
    }

    // --- shift events -------------------------------------------------
    var shifts = [];
    var lastShiftIdx = -1000;
    for (var si = TRANS_CONFIRM + 2; si < n; si++) {
      var g0 = gears[si - TRANS_CONFIRM - 1], g1 = gears[si];
      if (!g0 || !g1 || g0 === g1) continue;
      if (si - lastShiftIdx < 15) continue; // one event per shift
      lastShiftIdx = si;
      // rpmAt: pre-shift peak, measured BEFORE the transition begins so a
      // mid-shift flare cannot pollute its own baseline. Transition samples
      // live roughly in [i-6, i]; the flare window is [i-4, i].
      var rpmAt = null, mphAt = null, tpsAt = null, flare = 0;
      for (var k = Math.max(0, si - 12); k < Math.max(0, si - 5); k++) {
        var r = colVal(rpmC, k);
        if (r !== null && (rpmAt === null || r > rpmAt)) rpmAt = r;
      }
      for (var m = Math.max(0, si - 4); m <= si; m++) {
        var r2 = colVal(rpmC, m);
        if (r2 !== null && rpmAt !== null && r2 - rpmAt > flare) flare = r2 - rpmAt;
        if (m === si) {
          var v = colVal(vssC, m); mphAt = v === null ? null : round2(v * vssToMph);
          tpsAt = colVal(tpsC, m);
        }
      }
      shifts.push({
        index: si,
        type: g1 > g0 ? 'upshift' : 'downshift',
        from: g0, to: g1,
        rpmAt: rpmAt, mphAt: mphAt, tpsAt: tpsAt,
        durationSamples: TRANS_CONFIRM + 1,
        durationSec: round2((TRANS_CONFIRM + 1) * 0.145),
        flareRpm: Math.round(flare),
        flared: g1 > g0 && flare >= TRANS_FLARE_RPM
      });
    }
    var upshifts = shifts.filter(function (s) { return s.type === 'upshift'; });
    var downshifts = shifts.filter(function (s) { return s.type === 'downshift'; });
    var flared = upshifts.filter(function (s) { return s.flared; });
    function avgShiftRpm(list, from, to) {
      var f = list.filter(function (s) { return s.from === from && s.to === to && s.rpmAt !== null; });
      if (!f.length) return null;
      return Math.round(f.reduce(function (a, s) { return a + s.rpmAt; }, 0) / f.length);
    }

    // --- TCC apply/release: ratio step inside a constant gear ------------
    var tccApplies = 0, tccReleases = 0, tccCycles = 0;
    var tccEvents = [];
    var lastTccIdx = -1000, lastTccType = null;
    for (var ti = 16; ti < n; ti++) {
      var tgear = gears[ti];
      if (!tgear || tgear < 3) continue;
      if (tgear !== gears[ti - 16]) continue; // gear must be constant
      var ttps = colVal(tpsC, ti);
      var tvss = colVal(vssC, ti);
      if (ttps !== null && ttps > 45) continue;
      if (tvss === null || tvss * vssToMph < 30) continue;
      if (ti - lastTccIdx < 40) continue; // one event per transition
      var rA = [], rB = [];
      for (var a = ti - 16; a < ti - 8; a++) if (ratios[a] === ratios[a]) rA.push(ratios[a]);
      for (var b = ti - 8; b <= ti; b++) if (ratios[b] === ratios[b]) rB.push(ratios[b]);
      if (rA.length < 5 || rB.length < 5) continue;
      rA.sort(function (x, y) { return x - y; });
      rB.sort(function (x, y) { return x - y; });
      var mA = rA[Math.floor(rA.length / 2)], mB = rB[Math.floor(rB.length / 2)];
      var step = (mA - mB) / mA;
      var type = null;
      if (step > TRANS_TCC_STEP) type = 'apply';       // ratio fell: converter locked
      else if (step < -TRANS_TCC_STEP) type = 'release'; // ratio rose: converter unlocked
      if (type && type !== lastTccType) {
        if (type === 'apply') tccApplies++; else tccReleases++;
        tccEvents.push({ index: ti, type: type, gear: gears[ti] || null });
        lastTccIdx = ti; lastTccType = type;
      }
    }
    // Count lock/unlock pairs close together = TCC hunting.
    for (var c2 = 1; c2 < tccEvents.length; c2++) {
      if (tccEvents[c2].index - tccEvents[c2 - 1].index < TRANS_HUNT_WINDOW &&
          tccEvents[c2].type !== tccEvents[c2 - 1].type) tccCycles++;
    }

    // --- kickdown: throttle stab followed by a downshift -----------------
    var kickdowns = [];
    if (tpsC) {
      var prevTps = NaN;
      for (var ki = 0; ki < n; ki++) {
        var ktps = tpsC[ki];
        if (ktps !== ktps) { prevTps = NaN; continue; }
        if (prevTps === prevTps && ktps - prevTps >= TRANS_KICK_DTPS && ktps >= TRANS_KICK_TPS_MIN) {
          var found = null;
          for (var j = ki + 1; j < Math.min(ki + 1 + TRANS_KICK_WINDOW, n); j++) {
            var ds = shifts.filter(function (s) { return s.index >= ki && s.index <= j && s.type === 'downshift'; });
            if (ds.length) { found = ds[0]; break; }
          }
          var kv = vssC[ki];
          kickdowns.push({
            index: ki, tpsFrom: round2(prevTps), tpsTo: round2(ktps),
            mphAt: kv !== kv ? null : round2(kv * vssToMph),
            downshiftAt: found ? found.index : null,
            delaySec: found ? round2((found.index - ki) * 0.145) : null,
            noKickdown: !found
          });
        }
        prevTps = ktps;
      }
    }
    var kdDone = kickdowns.filter(function (k) { return !k.noKickdown; });
    var avgKd = kdDone.length
      ? round2(kdDone.reduce(function (a, k) { return a + k.delaySec; }, 0) / kdDone.length) : null;

    // --- shift hunting: repeated reversals between one gear pair --------
    var hunting = 0;
    var huntingDetail = [];
    for (var h = 0; h < shifts.length; h++) {
      var rev = 0, first = shifts[h];
      for (var q = h + 1; q < shifts.length && shifts[q].index - first.index < TRANS_HUNT_WINDOW; q++) {
        var pair = [Math.min(shifts[q].from, shifts[q].to), Math.max(shifts[q].from, shifts[q].to)];
        var fp = [Math.min(first.from, first.to), Math.max(first.from, first.to)];
        if (pair[0] === fp[0] && pair[1] === fp[1] &&
            shifts[q].type !== shifts[q - 1].type) rev++;
      }
      var tpsH = first.tpsAt;
      if (rev >= TRANS_HUNT_REVERSALS && (tpsH === null || tpsH < 40)) {
        hunting++;
        huntingDetail.push({ gears: first.from + '-' + first.to, reversals: rev + 1,
          mphAt: first.mphAt, tpsAt: first.tpsAt });
        h += rev; // don't recount the same episode
      }
    }

    var gearSamples = { 1: 0, 2: 0, 3: 0, 4: 0 };
    gears.forEach(function (g) { if (g) gearSamples[g]++; });

    // --- PCM-measured shift times (when the log carries them) ------------
    // The PCM holds the last shift's measured time until the next shift of
    // that pair, so only value *changes* count as shift observations.
    // NOTE: the companion "Shift Time Error" channels read a constant
    // ~5.7 in the field logs seen so far — their encoding is not understood,
    // so they are mapped but never used for tuning decisions.
    var shiftT12C = ncol(t, P66.columnFor(mapResult, 'SHIFT_T12'));
    var shiftT23C = ncol(t, P66.columnFor(mapResult, 'SHIFT_T23'));
    function pcmShiftSnapshots(col, pair) {
      var out = [];
      if (!col) return out;
      var prev = NaN, started = false;
      for (var pi = 0; pi < n; pi++) {
        var v = col[pi];
        if (v !== v || v <= 0) { prev = v; started = true; continue; }
        // Only value *changes* count — the reading at log start is just
        // the pre-log state, not an observed shift.
        if (started && prev === prev && Math.abs(v - prev) > 0.005) {
          out.push({ index: pi, pair: pair, timeSec: round3(v) });
        }
        prev = v; started = true;
      }
      return out;
    }
    var pcmShifts = pcmShiftSnapshots(shiftT12C, '1-2')
      .concat(pcmShiftSnapshots(shiftT23C, '2-3'));
    function pcmTypical(pair) {
      var ts = pcmShifts.filter(function (s) { return s.pair === pair; })
        .map(function (s) { return s.timeSec; }).sort(function (a, b) { return a - b; });
      return ts.length ? ts[Math.floor(ts.length / 2)] : null;
    }

    // --- TCC from the channel when the log carries it --------------------
    // Falls back to the ratio-step inference above when absent/empty.
    var tccSource = 'inferred';
    var tccName = P66.columnFor(mapResult, 'TCC');
    if (tccName) {
      var tccSeen = 0, lastTccLocked = null, chApplies = 0, chReleases = 0;
      var chEvents = [];
      // The TCC channel may be numeric (duty cycle) or a state string —
      // read the raw channel, not the numeric-only column.
      var tccRaw = t.col(tccName);
      for (var ci = 0; ci < n; ci++) {
        var raw = tccRaw ? tccRaw[ci] : null;
        if (raw === null || raw === undefined) continue;
        if (typeof raw === 'number' && raw !== raw) continue; // NaN = missing
        if (String(raw).trim() === '') continue;
        tccSeen++;
        var locked;
        // Numeric (duty-cycle style) vs state-string style — same typeof
        // test the old num() helper applied: only real numbers count as
        // duty cycle, everything else goes through the state regex.
        if (typeof raw === 'number' && isFinite(raw)) locked = raw > 50;
        else locked = /on|lock|engag/i.test(String(raw)); // state style
        if (lastTccLocked !== null && locked !== lastTccLocked) {
          if (locked) chApplies++; else chReleases++;
          chEvents.push({ index: ci, type: locked ? 'apply' : 'release', gear: gears[ci] || null });
        }
        lastTccLocked = locked;
      }
      if (tccSeen > 10) {
        tccSource = 'channel';
        tccApplies = chApplies; tccReleases = chReleases;
        tccEvents = chEvents.slice(0, 20);
        tccCycles = 0;
        for (var c3 = 1; c3 < chEvents.length; c3++) {
          if (chEvents[c3].index - chEvents[c3 - 1].index < TRANS_HUNT_WINDOW &&
              chEvents[c3].type !== chEvents[c3 - 1].type) tccCycles++;
        }
      }
    }

    return {
      available: true,
      vssUnit: vssUnit,
      tccSource: tccSource,
      cruiseRatioMedian: medCruise !== null ? round2(medCruise) : null,
      shifts: shifts.length,
      upshifts: upshifts.length,
      downshifts: downshifts.length,
      shiftEvents: shifts.slice(0, 30),
      avgShiftRpm12: avgShiftRpm(upshifts, 1, 2),
      avgShiftRpm23: avgShiftRpm(upshifts, 2, 3),
      avgShiftRpm34: avgShiftRpm(upshifts, 3, 4),
      flaredShifts: flared.length,
      flaredDetail: flared.slice(0, 10).map(function (s) {
        return { from: s.from, to: s.to, rpmAt: s.rpmAt, mphAt: s.mphAt, flareRpm: s.flareRpm };
      }),
      minShifts: TRANS_MIN_SHIFTS,
      flareThresholdRpm: TRANS_FLARE_RPM,
      tccApplies: tccApplies,
      tccReleases: tccReleases,
      tccCycles: tccCycles,
      tccDetail: tccEvents.slice(0, 20),
      kickdowns: kickdowns.length,
      kickdownNoShift: kickdowns.filter(function (k) { return k.noKickdown; }).length,
      avgKickdownDelaySec: avgKd,
      slowKickdownSec: TRANS_KICK_SLOW_SEC,
      minKickdowns: TRANS_MIN_KICKDOWNS,
      kickdownDetail: kickdowns.slice(0, 15),
      huntingEpisodes: hunting,
      huntingDetail: huntingDetail.slice(0, 5),
      gearSamples: gearSamples,
      pcmShiftCount12: pcmShifts.filter(function (s) { return s.pair === '1-2'; }).length,
      pcmShiftCount23: pcmShifts.filter(function (s) { return s.pair === '2-3'; }).length,
      pcmTypicalShift12: pcmTypical('1-2'),
      pcmTypicalShift23: pcmTypical('2-3'),
      pcmShiftDetail: pcmShifts.slice(0, 10),
      sampleSec: 0.145
    };
  }

  /**
   * Bank-imbalance diagnostic.
   *
   * When both banks' trims are logged, a large bank-to-bank split in the
   * same RPM x MAP cell means a bank-specific problem — vacuum leak,
   * injector issue, lazy O2 sensor, exhaust leak — not a VE table error.
   * Averaging the banks (as fuel trim analysis does) would then suggest a
   * global VE change that mistunes the healthy bank. Findings are reported
   * as diagnostics; the tuner attaches a caution to affected cells instead
   * of silently suggesting.
   */
  var IMBALANCE_MIN_SAMPLES = 15; // per bank, per cell
  var IMBALANCE_DELTA_PCT = 5;    // |avg1 - avg2| at or above this is a finding

  function analyzeBankImbalance(rows, mapResult, features) {
    var t = P66.asTable(rows);
    var feats = featuresFor(t, mapResult, features);
    var b1stft = P66.columnFor(mapResult, 'STFT_B1');
    var b1ltft = P66.columnFor(mapResult, 'LTFT_B1');
    var b2stft = P66.columnFor(mapResult, 'STFT_B2');
    var b2ltft = P66.columnFor(mapResult, 'LTFT_B2');
    if ((!b1stft && !b1ltft) || (!b2stft && !b2ltft)) {
      return { available: false, reason: 'Need bank-specific STFT/LTFT channels (both banks).' };
    }
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var rpmC0 = ncol(t, rpmName);
    var mapC0 = ncol(t, mapName);
    if (!rpmC0 || !mapC0) {
      return { available: false, reason: 'Need RPM and MAP channels.' };
    }
    var q = qualityRows(t, mapResult, feats);
    var gt = P66.asTable(q.rows);
    var rpmC = ncol(gt, rpmName);
    var mapC = ncol(gt, mapName);
    var b1 = { stft: ncol(gt, b1stft), ltft: ncol(gt, b1ltft) };
    var b2 = { stft: ncol(gt, b2stft), ltft: ncol(gt, b2ltft) };
    var style1 = {
      stft: b1.stft ? P66.detectTrimStyle(sampleColumn(gt, b1stft)) : 'percent',
      ltft: b1.ltft ? P66.detectTrimStyle(sampleColumn(gt, b1ltft)) : 'percent'
    };
    var style2 = {
      stft: b2.stft ? P66.detectTrimStyle(sampleColumn(gt, b2stft)) : 'percent',
      ltft: b2.ltft ? P66.detectTrimStyle(sampleColumn(gt, b2ltft)) : 'percent'
    };
    function bankTrim(b, styles, i) {
      var stft = b.stft ? P66.trimToPct(nn(b.stft[i]), styles.stft) : 0;
      var ltft = b.ltft ? P66.trimToPct(nn(b.ltft[i]), styles.ltft) : 0;
      return stft + ltft;
    }
    var cells = {}; // "rpmBin|mapBin" -> { n1, sum1, n2, sum2 }
    for (var i = 0; i < gt.rowCount; i++) {
      var rpm = rpmC[i];
      var map = mapC[i];
      if (rpm !== rpm || map !== map) continue;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { n1: 0, sum1: 0, n2: 0, sum2: 0, rpmBin: rpmBin(rpm), mapBin: mapBin(map) });
      var t1 = bankTrim(b1, style1, i);
      var t2 = bankTrim(b2, style2, i);
      // A row counts for a bank only when that bank actually reported.
      var b1missing = (!b1.stft || b1.stft[i] !== b1.stft[i]) && (!b1.ltft || b1.ltft[i] !== b1.ltft[i]);
      var b2missing = (!b2.stft || b2.stft[i] !== b2.stft[i]) && (!b2.ltft || b2.ltft[i] !== b2.ltft[i]);
      if (b1.stft && b1missing && b1.ltft && b1missing) { /* no b1 data */ }
      else { c.n1++; c.sum1 += t1; }
      if (b2.stft && b2missing && b2.ltft && b2missing) { /* no b2 data */ }
      else { c.n2++; c.sum2 += t2; }
    }
    var findings = [];
    Object.keys(cells).forEach(function (key) {
      var c = cells[key];
      if (c.n1 < IMBALANCE_MIN_SAMPLES || c.n2 < IMBALANCE_MIN_SAMPLES) return;
      var avg1 = c.sum1 / c.n1, avg2 = c.sum2 / c.n2;
      var delta = avg1 - avg2;
      if (Math.abs(delta) < IMBALANCE_DELTA_PCT) return;
      var leanBank = delta > 0 ? 1 : 2; // positive trim = ECU adding fuel = lean
      findings.push({
        key: key,
        rpmBin: c.rpmBin,
        mapBin: c.mapBin,
        cell: c.rpmBin + ' RPM / ' + c.mapBin + ' kPa',
        bank1Avg: round2(avg1),
        bank2Avg: round2(avg2),
        delta: round2(delta),
        leanBank: leanBank,
        samples1: c.n1,
        samples2: c.n2
      });
    });
    findings.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    return {
      available: true,
      findings: findings,
      findingCount: findings.length,
      note: findings.length
        ? findings.length + ' cell(s) show a bank-to-bank trim split ≥ ' + IMBALANCE_DELTA_PCT +
          '% — diagnose the bank-specific cause before changing VE.'
        : 'No bank-to-bank trim split ≥ ' + IMBALANCE_DELTA_PCT + '% found.'
    };
  }

  function regionDistribution(rows) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var dist = {};
    REGIONS.forEach(function (r) { dist[r] = 0; });
    for (var i = 0; i < n; i++) {
      var region = P66.regionAt(t, i);
      dist[region] = (dist[region] || 0) + 1;
    }
    return dist;
  }

  /**
   * Full session analysis. Returns a report object.
   * opts.altitudeFt (default 2840) feeds the baro plausibility check.
   * onStage(key, pct) — optional progress hook fired at coarse stages
   * (see P66.ANALYSIS_STAGES). Used by the Web Worker / async wrapper so
   * large logs can report progress off the main thread; synchronous
   * callers simply omit it and the code path is unchanged.
   */
  function analyzeSession(parsed, mapResult, opts, onStage) {
    function stage(key, pct) {
      if (typeof onStage === 'function') { try { onStage(key, pct); } catch (e) { /* listener error */ } }
    }
    var t = P66.asTable(parsed);
    segmentRows(t, mapResult);
    stage('segments', 5);
    // One feature pass for the whole session; every analyze* below reduces
    // these precomputed columns instead of re-scanning the log.
    var feats = extractFeatures(t, mapResult);
    stage('features', 12);
    var missing = [];
    ['RPM', 'MAP', 'TPS'].forEach(function (s) {
      if (!P66.columnFor(mapResult, s)) missing.push(s);
    });
    var altitudeFt = (opts && isFinite(opts.altitudeFt)) ? opts.altitudeFt
      : (typeof P66.DEFAULT_ALTITUDE_FT === 'number' ? P66.DEFAULT_ALTITUDE_FT : 2840);
    var fuelTrims = analyzeFuelTrims(t, mapResult, feats);
    stage('fuel', 22);
    var knock = analyzeKnock(t, mapResult, feats);
    stage('knock', 32);
    var lambda = analyzeLambda(t, mapResult, feats);
    stage('lambda', 40);
    var narrowband = analyzeNarrowband(t, mapResult, feats);
    stage('narrowband', 50);
    var tipIn = analyzeTipIn(t, mapResult, feats);
    stage('tipIn', 58);
    var peEntry = analyzePeEntry(t, mapResult, feats);
    stage('peEntry', 66);
    var transmission = analyzeTransmission(t, mapResult, feats);
    stage('transmission', 76);
    var bankImbalance = analyzeBankImbalance(t, mapResult, feats);
    stage('bankImbalance', 84);
    var baro = (typeof P66.analyzeBaro === 'function')
      ? P66.analyzeBaro(t, mapResult, altitudeFt)
      : { available: false, reason: 'Altitude module not loaded (js/altitude.js).' };
    stage('baro', 92);
    var report = {
      rowCount: t ? t.rowCount : 0,
      regionDistribution: regionDistribution(t),
      missingChannels: missing,
      altitudeFt: altitudeFt,
      fuelTrims: fuelTrims,
      knock: knock,
      lambda: lambda,
      narrowband: narrowband,
      tipIn: tipIn,
      peEntry: peEntry,
      transmission: transmission,
      bankImbalance: bankImbalance,
      baro: baro
    };
    stage('report', 100);
    return report;
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  // Coarse progress stages for analyzeSession's optional onStage hook
  // (drives the Web Worker progress messages and the async wrapper).
  // Keys are stable API; pct is 0-100 and non-decreasing.
  var ANALYSIS_STAGES = [
    ['segments', 5], ['features', 12], ['fuel', 22], ['knock', 32],
    ['lambda', 40], ['narrowband', 50], ['tipIn', 58], ['peEntry', 66],
    ['transmission', 76], ['bankImbalance', 84], ['baro', 92], ['report', 100]
  ];

  P66.segmentRows = segmentRows;
  P66.qualityRows = qualityRows;
  P66.extractFeatures = extractFeatures;
  P66.SEGMENT_IDS = SEGMENT_IDS;
  P66.analyzeBankImbalance = analyzeBankImbalance;
  P66.analyzeFuelTrims = analyzeFuelTrims;
  P66.analyzeKnock = analyzeKnock;
  P66.analyzeLambda = analyzeLambda;
  P66.analyzeNarrowband = analyzeNarrowband;
  P66.analyzeTipIn = analyzeTipIn;
  P66.analyzePeEntry = analyzePeEntry;
  P66.analyzeTransmission = analyzeTransmission;
  P66.analyzeSession = analyzeSession;
  P66.ANALYSIS_STAGES = ANALYSIS_STAGES;
  P66.toLambda = toLambda;
  P66.REGIONS = REGIONS;
})(typeof window !== 'undefined' ? window : global);
