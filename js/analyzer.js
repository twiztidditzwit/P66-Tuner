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

  function detectKrScale(rows, krCol) {
    var seen = 0, allInt = true;
    for (var i = 0; i < rows.length && seen < 2000; i++) {
      var v = num(rows[i][krCol]);
      if (v === null || v <= 0) continue;
      seen++;
      if (v !== Math.round(v)) { allInt = false; break; }
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
  function analyzeKnock(rows, mapResult) {
    var krCol = P66.columnFor(mapResult, 'KR');
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!krCol) return { available: false, reason: 'Need KR (knock retard) channel.' };

    var krScale = detectKrScale(rows, krCol);

    // Group consecutive KR-active rows into events.
    var events = [];
    var cur = null;
    rows.forEach(function (row, i) {
      var krRaw = num(row[krCol]);
      var kr = krRaw === null ? null : krRaw * krScale.scale;
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
        if (kr > cur.peakKR) {
          cur.peakKR = kr;
          // Position of the worst knock: what the spark patcher retards.
          cur.peakRpm = rpmCol !== null ? num(row[rpmCol]) : null;
          cur.peakMap = mapCol !== null ? num(row[mapCol]) : null;
        }
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
      totalSamples: rows.length,
      knockPct: rows.length ? round2(100 * active / rows.length) : 0,
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

  /**
   * Narrowband O2 analysis (for cars without a wideband).
   * Per-cell rich/lean bias from O2 voltage, cross-count sensor health,
   * and a WOT richness safety check.
   * Thresholds in mV: <300 lean, 300-600 switching, >600 rich.
   */
  function analyzeNarrowband(rows, mapResult) {
    var b1Col = P66.columnFor(mapResult, 'O2_B1');
    var b2Col = P66.columnFor(mapResult, 'O2_B2');
    var soloCol = P66.columnFor(mapResult, 'O2');
    var banks = [];
    if (b1Col) banks.push({ name: 'bank1', col: b1Col });
    if (b2Col) banks.push({ name: 'bank2', col: b2Col });
    if (!banks.length && soloCol) banks.push({ name: 'single', col: soloCol });
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!banks.length || !rpmCol || !mapCol) {
      return { available: false, reason: 'Need O2 sensor (mV), RPM and MAP channels.' };
    }

    // Per-cell bias
    var cells = {};
    rows.forEach(function (row) {
      var rpm = num(row[rpmCol]);
      var map = num(row[mapCol]);
      if (rpm === null || map === null) return;
      var mvs = banks.map(function (b) { return num(row[b.col]); })
        .filter(function (v) { return v !== null; });
      if (!mvs.length) return;
      var avgMv = mvs.reduce(function (a, v) { return a + v; }, 0) / mvs.length;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { count: 0, sumMv: 0, rich: 0, lean: 0 });
      c.count++;
      c.sumMv += avgMv;
      if (avgMv > 600) c.rich++;
      else if (avgMv < 300) c.lean++;
    });
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
    var timeCol = P66.columnFor(mapResult, 'TIME');
    var crossCounts = banks.map(function (b) {
      var crossings = 0, samples = 0, prevAbove = null, firstT = null, lastT = null;
      rows.forEach(function (row, i) {
        var region = row._region || 'cruise';
        if (region !== 'cruise' && region !== 'idle') return;
        var v = num(row[b.col]);
        if (v === null) return;
        samples++;
        if (timeCol) {
          var t = num(row[timeCol]);
          if (t !== null) {
            if (firstT === null) firstT = t;
            lastT = t;
          }
        }
        var above = v > STOICH_MV;
        if (prevAbove !== null && above !== prevAbove) crossings++;
        prevAbove = above;
      });
      var perMin = null;
      if (samples > 30) {
        var minutes = (firstT !== null && lastT !== null && lastT > firstT)
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
    var wotMvs = [];
    rows.forEach(function (row) {
      if ((row._region || '') !== 'wot') return;
      banks.forEach(function (b) {
        var v = num(row[b.col]);
        if (v !== null) wotMvs.push(v);
      });
    });
    var wotCheck = { samples: wotMvs.length, status: 'no wot data' };
    if (wotMvs.length >= 10) {
      var wotAvg = wotMvs.reduce(function (a, v) { return a + v; }, 0) / wotMvs.length;
      var wotRichPct = 100 * wotMvs.filter(function (v) { return v > 700; }).length / wotMvs.length;
      wotCheck = {
        samples: wotMvs.length,
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
      wotCheck: wotCheck
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
      lambda: analyzeLambda(rows, mapResult),
      narrowband: analyzeNarrowband(rows, mapResult)
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  P66.segmentRows = segmentRows;
  P66.analyzeFuelTrims = analyzeFuelTrims;
  P66.analyzeKnock = analyzeKnock;
  P66.analyzeLambda = analyzeLambda;
  P66.analyzeNarrowband = analyzeNarrowband;
  P66.analyzeSession = analyzeSession;
  P66.toLambda = toLambda;
  P66.REGIONS = REGIONS;
})(typeof window !== 'undefined' ? window : global);
