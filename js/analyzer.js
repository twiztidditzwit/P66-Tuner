/* P66-Tuner analyzer
 * Segments log rows into operating regions and computes the error
 * metrics that drive tune recommendations:
 *   - fuel trim bias by RPM x MAP cell
 *   - knock retard frequency / severity
 *   - commanded vs actual lambda error
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var REGIONS = ['idle', 'cruise', 'transient', 'wot'];

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /**
   * Assign an operating region to each row. Mutates rows by adding _region.
   * Needs RPM; TPS preferred, MAP as fallback for load detection.
   */
  function segmentRows(rows, mapResult) {
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    var mapCol = P66.columnFor(mapResult, 'MAP');

    // First pass: compute per-sample deltas for transient detection.
    var prevTps = null, prevMap = null;
    rows.forEach(function (row) {
      var rpm = rpmCol ? num(row[rpmCol]) : null;
      var tps = tpsCol ? num(row[tpsCol]) : null;
      var map = mapCol ? num(row[mapCol]) : null;

      var region = 'cruise'; // default
      var isTransient = false;
      if (tps !== null && prevTps !== null && Math.abs(tps - prevTps) >= 8) isTransient = true;
      if (map !== null && prevMap !== null && Math.abs(map - prevMap) >= 8) isTransient = true;

      if (rpm === null) {
        region = 'cruise';
      } else if (isTransient) {
        region = 'transient';
      } else if (tps !== null && tps >= 78) {
        region = 'wot';
      } else if (rpm < 1100 && (tps === null || tps < 5) && (map === null || map < 50)) {
        region = 'idle';
      } else {
        region = 'cruise';
      }
      row._region = region;
      prevTps = tps;
      prevMap = map;
    });
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
   * Fuel trim bias per RPM x MAP cell.
   * Combined trim = STFT + LTFT (percent). Positive = lean, ECU adding fuel.
   */
  function analyzeFuelTrims(rows, mapResult) {
    var trims = P66.fuelTrimColumns(mapResult);
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if ((!trims.stft && !trims.ltft) || !rpmCol || !mapCol) {
      return { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
    }
    var cells = {}; // "rpmBin|mapBin" -> { count, sum, sumSq }
    var totalAbs = 0, totalN = 0;
    rows.forEach(function (row) {
      var rpm = num(row[rpmCol]);
      var map = num(row[mapCol]);
      if (rpm === null || map === null) return;
      var stft = trims.stft ? num(row[trims.stft]) : 0;
      var ltft = trims.ltft ? num(row[trims.ltft]) : 0;
      if (stft === null) stft = 0;
      if (ltft === null) ltft = 0;
      var combined = stft + ltft;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { count: 0, sum: 0, sumSq: 0 });
      c.count++; c.sum += combined; c.sumSq += combined * combined;
      totalAbs += Math.abs(combined); totalN++;
    });
    var cellList = Object.keys(cells).map(function (key) {
      var parts = key.split('|');
      var c = cells[key];
      var mean = c.sum / c.count;
      var variance = Math.max(0, c.sumSq / c.count - mean * mean);
      return {
        rpmBin: parts[0], mapBin: parts[1],
        samples: c.count,
        avgTrim: round2(mean),
        stddev: round2(Math.sqrt(variance))
      };
    }).sort(function (a, b) { return Math.abs(b.avgTrim) - Math.abs(a.avgTrim); });

    return {
      available: true,
      cells: cellList,
      cellCount: cellList.length,
      overallAvgAbsTrim: totalN ? round2(totalAbs / totalN) : 0,
      totalSamples: totalN
    };
  }

  /**
   * Knock retard analysis. KR > 0.5 deg counts as active knock.
   */
  function analyzeKnock(rows, mapResult) {
    var krCol = P66.columnFor(mapResult, 'KR');
    if (!krCol) return { available: false, reason: 'Need KR (knock retard) channel.' };
    var active = 0, maxKR = 0, sumKR = 0;
    var byRegion = {};
    REGIONS.forEach(function (r) { byRegion[r] = { samples: 0, maxKR: 0 }; });
    rows.forEach(function (row) {
      var kr = num(row[krCol]);
      if (kr === null) return;
      var region = row._region || 'cruise';
      if (kr > maxKR) maxKR = kr;
      if (kr > 0.5) {
        active++; sumKR += kr;
        byRegion[region].samples++;
        if (kr > byRegion[region].maxKR) byRegion[region].maxKR = kr;
      }
    });
    return {
      available: true,
      knockSamples: active,
      totalSamples: rows.length,
      knockPct: rows.length ? round2(100 * active / rows.length) : 0,
      maxKR: round2(maxKR),
      avgKRWhenActive: active ? round2(sumKR / active) : 0,
      byRegion: byRegion
    };
  }

  // Normalize an AFR/lambda reading to lambda (gasoline stoich 14.7).
  function toLambda(v) {
    if (v === null) return null;
    if (v > 5) return v / 14.7; // looks like AFR
    if (v > 0.3 && v < 2.5) return v; // looks like lambda
    return null;
  }

  /**
   * Commanded vs actual lambda error.
   */
  function analyzeLambda(rows, mapResult) {
    var cmdCol = P66.columnFor(mapResult, 'CMD_LAMBDA');
    var wbCol = P66.columnFor(mapResult, 'WB_LAMBDA');
    if (!cmdCol || !wbCol) {
      return { available: false, reason: 'Need commanded + wideband lambda/AFR channels.' };
    }
    var errors = [];
    var byRegion = {};
    REGIONS.forEach(function (r) { byRegion[r] = { n: 0, sumAbs: 0 }; });
    rows.forEach(function (row) {
      var cmd = toLambda(num(row[cmdCol]));
      var wb = toLambda(num(row[wbCol]));
      if (cmd === null || wb === null) return;
      var err = wb - cmd; // positive = lean vs commanded
      errors.push(err);
      var region = row._region || 'cruise';
      byRegion[region].n++;
      byRegion[region].sumAbs += Math.abs(err);
    });
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

  function regionDistribution(rows) {
    var dist = {};
    REGIONS.forEach(function (r) { dist[r] = 0; });
    rows.forEach(function (row) {
      var region = row._region || 'cruise';
      dist[region] = (dist[region] || 0) + 1;
    });
    return dist;
  }

  /**
   * Full session analysis. Returns a report object.
   */
  function analyzeSession(parsed, mapResult) {
    var rows = parsed.rows.slice();
    segmentRows(rows, mapResult);
    var missing = [];
    ['RPM', 'MAP', 'TPS'].forEach(function (s) {
      if (!P66.columnFor(mapResult, s)) missing.push(s);
    });
    return {
      rowCount: rows.length,
      regionDistribution: regionDistribution(rows),
      missingChannels: missing,
      fuelTrims: analyzeFuelTrims(rows, mapResult),
      knock: analyzeKnock(rows, mapResult),
      lambda: analyzeLambda(rows, mapResult)
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  P66.segmentRows = segmentRows;
  P66.analyzeFuelTrims = analyzeFuelTrims;
  P66.analyzeKnock = analyzeKnock;
  P66.analyzeLambda = analyzeLambda;
  P66.analyzeSession = analyzeSession;
  P66.REGIONS = REGIONS;
})(typeof window !== 'undefined' ? window : global);
