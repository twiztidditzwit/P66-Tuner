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

  // Sample up to N numeric values from a column for style detection.
  function sampleColumn(rows, col, max) {
    max = max || 500;
    var out = [];
    for (var i = 0; i < rows.length && out.length < max; i++) {
      var v = num(rows[i][col]);
      if (v !== null) out.push(v);
    }
    return out;
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
   * Combined trim = STFT + LTFT (percent), averaged across banks.
   * Trim channels are auto-normalized (percent / multiplier / GM 128-count).
   */
  function analyzeFuelTrims(rows, mapResult) {
    var banks = P66.fuelTrimBanks(mapResult);
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!banks.length || !rpmCol || !mapCol) {
      return { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
    }
    // Detect each trim column's encoding once.
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(rows, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(rows, b.ltft)) : 'percent'
      };
    });
    var cells = {}; // "rpmBin|mapBin" -> { count, sum, sumSq }
    var totalAbs = 0, totalN = 0;
    rows.forEach(function (row) {
      var rpm = num(row[rpmCol]);
      var map = num(row[mapCol]);
      if (rpm === null || map === null) return;
      var bankTrims = [];
      banks.forEach(function (b, bi) {
        var stft = b.stft ? P66.trimToPct(num(row[b.stft]), styles[bi].stft) : 0;
        var ltft = b.ltft ? P66.trimToPct(num(row[b.ltft]), styles[bi].ltft) : 0;
        bankTrims.push(stft + ltft);
      });
      var combined = bankTrims.reduce(function (a, t) { return a + t; }, 0) / bankTrims.length;
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
   * Consecutive active rows are grouped into events; sizing uses robust
   * per-event statistics so a single spike can't drive the recommendation.
   */
  function analyzeKnock(rows, mapResult) {
    var krCol = P66.columnFor(mapResult, 'KR');
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    if (!krCol) return { available: false, reason: 'Need KR (knock retard) channel.' };

    // Group consecutive KR-active rows into events.
    var events = [];
    var cur = null;
    rows.forEach(function (row, i) {
      var kr = num(row[krCol]);
      if (kr !== null && kr > 0.5) {
        if (!cur) {
          cur = {
            startIdx: i, endIdx: i, samples: 0, peakKR: 0, sumKR: 0,
            regions: {}, tpsStart: tpsCol ? num(row[tpsCol]) : null, tpsEnd: null
          };
        }
        cur.endIdx = i;
        cur.samples++;
        cur.sumKR += kr;
        if (kr > cur.peakKR) cur.peakKR = kr;
        var region = row._region || 'cruise';
        cur.regions[region] = (cur.regions[region] || 0) + 1;
        cur.tpsEnd = tpsCol ? num(row[tpsCol]) : null;
      } else if (cur) {
        events.push(cur);
        cur = null;
      }
    });
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
      totalSamples: rows.length,
      knockPct: rows.length ? round2(100 * active / rows.length) : 0,
      maxKR: round2(maxKR),
      avgKRWhenActive: active ? round2(sumKR / active) : 0,
      byRegion: byRegion,
      events: events.map(function (e) {
        return {
          startIdx: e.startIdx, samples: e.samples, region: e.region,
          peakKR: round2(e.peakKR), avgKR: round2(e.avgKR),
          tpsDrop: e.tpsDrop === null ? null : round2(e.tpsDrop)
        };
      })
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
  P66.toLambda = toLambda;
  P66.REGIONS = REGIONS;
})(typeof window !== 'undefined' ? window : global);
