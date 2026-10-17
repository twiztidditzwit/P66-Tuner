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
   * A null ECT value on a row is treated as unknown (row kept): the gate
   * targets the known-cold warmup period, not sensor dropouts mid-log.
   */
  var WARM_F = 160;

  /**
   * Warmup threshold for the ECT column, without trusting a unit label.
   * A driven P66 log reports ECT in °F (TunerPro units row) with a session
   * max well above 140; anything at or below that is either °C or an
   * engine that never warmed up. In the ambiguous band an absolute
   * threshold cannot be trusted, so the warmup edge is cut relative to
   * the session max — the rising cold-start edge is what pollutes trims.
   * Returns { threshold, label } or null when no ECT samples exist.
   */
  function ectWarmThreshold(rows, ectCol) {
    var max = -Infinity, n = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = num(rows[i][ectCol]);
      if (v === null) continue;
      n++;
      if (v > max) max = v;
    }
    if (!n) return null;
    if (max > 140) return { threshold: WARM_F, label: WARM_F + '°F' };
    return { threshold: max - 10, label: 'within 10° of session max (' + Math.round(max) + '°)' };
  }

  function qualityRows(rows, mapResult) {
    var ectCol = P66.columnFor(mapResult, 'ECT');
    var wt = ectCol ? ectWarmThreshold(rows, ectCol) : null;
    var kept = [], gatedWarmup = 0, gatedTransient = 0;
    rows.forEach(function (row) {
      if ((row._region || '') === 'transient') { gatedTransient++; return; }
      if (wt) {
        var ect = num(row[ectCol]);
        if (ect !== null && ect < wt.threshold) { gatedWarmup++; return; }
      }
      kept.push(row);
    });
    return {
      rows: kept,
      gatedWarmup: gatedWarmup,
      gatedTransient: gatedTransient,
      ectAvailable: !!ectCol,
      warmNote: wt
        ? 'Excluded ' + gatedWarmup + ' cold row(s) below ' + wt.label +
          ' and ' + gatedTransient + ' transient row(s).'
        : 'No ECT channel — warmup gating unavailable; cold-start rows included (' +
          gatedTransient + ' transient row(s) excluded).'
    };
  }

  /**
   * Fuel trim bias per RPM x MAP cell.
   * Combined trim = STFT + LTFT (percent), averaged across banks.
   * Trim channels are auto-normalized (percent / multiplier / GM 128-count).
   * Only warmed-up, steady-state rows are used (see qualityRows).
   */
  function analyzeFuelTrims(rows, mapResult) {
    var banks = P66.fuelTrimBanks(mapResult);
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!banks.length || !rpmCol || !mapCol) {
      return { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
    }
    // Sample-quality gating: cold and transient rows do not reflect the VE
    // table, so they are excluded before any averaging happens.
    var q = qualityRows(rows, mapResult);
    rows = q.rows;
    // Idle-VE detection: the PCM runs the Idle VE table (not Main VE) when
    // idle entry conditions hold. Thresholds below are the stock-calibration
    // entry values ("Idle VE Possible" scalars: 1450 RPM, ~2% TPS, 2 MPH).
    // TPS/VSS channels are optional — without them we fall back to RPM-only.
    var IDLE_RPM_MAX = 1450, IDLE_TPS_MAX = 2, IDLE_VSS_MAX = 3;
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    var vssCol = P66.columnFor(mapResult, 'VSS');
    // Detect each trim column's encoding once.
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(rows, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(rows, b.ltft)) : 'percent'
      };
    });
    var cells = {}; // "rpmBin|mapBin" -> { count, sum, sumSq, idle }
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
      var c = cells[key] || (cells[key] = { count: 0, sum: 0, sumSq: 0, idle: 0 });
      c.count++; c.sum += combined; c.sumSq += combined * combined;
      // Was the PCM on the Idle VE table for this sample? Entry conditions
      // from the calibration; missing TPS/VSS channels fall back to RPM-only.
      var tps = tpsCol ? num(row[tpsCol]) : null;
      var vss = vssCol ? num(row[vssCol]) : null;
      if (rpm < IDLE_RPM_MAX &&
          (tps === null || tps < IDLE_TPS_MAX) &&
          (vss === null || vss < IDLE_VSS_MAX)) c.idle++;
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

    // Same sample-quality gating as fuel trims: a cold O2 sensor reads lean
    // and tells you nothing about the VE table.
    var nbq = qualityRows(rows, mapResult);
    rows = nbq.rows;

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

  function analyzeTipIn(rows, mapResult) {
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    var o2Col = P66.columnFor(mapResult, 'O2_B1') || P66.columnFor(mapResult, 'O2');
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var ectCol = P66.columnFor(mapResult, 'ECT');
    if (!tpsCol || !o2Col) {
      return { available: false, reason: 'Need TPS and narrowband O2 channels.' };
    }
    var warmThr = ectCol ? ectWarmThreshold(rows, ectCol) : null;

    var events = [];
    var prevTps = null, lastEventIdx = -TIP_IN_REFRACTORY;
    rows.forEach(function (row, i) {
      var tps = num(row[tpsCol]);
      if (tps === null) { prevTps = null; return; }
      if (prevTps !== null && i - lastEventIdx >= TIP_IN_REFRACTORY) {
        var dtps = tps - prevTps;
        if (dtps >= TIP_IN_DTPS) {
          // Confirm a real stab, not a one-sample data glitch: the throttle
          // must stay open (>= +5%) for most of the next 5 samples.
          var sustained = 0;
          for (var k = i + 1; k < Math.min(i + 6, rows.length); k++) {
            var tk = num(rows[k][tpsCol]);
            if (tk !== null && tk >= prevTps + 5) sustained++;
          }
          if (sustained < 3) { prevTps = tps; return; }
          var minO2 = Infinity, o2n = 0;
          for (var j = i; j < Math.min(i + TIP_IN_WINDOW, rows.length); j++) {
            var o2 = num(rows[j][o2Col]);
            if (o2 === null) continue;
            o2n++;
            if (o2 < minO2) minO2 = o2;
          }
          var ect = ectCol ? num(row[ectCol]) : null;
          events.push({
            index: i,
            dtps: round2(dtps),
            tpsFrom: round2(prevTps),
            tpsTo: round2(tps),
            rpm: rpmCol ? num(row[rpmCol]) : null,
            minO2: o2n ? Math.round(minO2) : null,
            leanSpike: o2n > 0 && minO2 < TIP_IN_LEAN_MV,
            cold: ect !== null && warmThr !== null && ect < warmThr.threshold
          });
          lastEventIdx = i;
        }
      }
      prevTps = tps;
    });

    var lean = events.filter(function (e) { return e.leanSpike; });
    var warm = events.filter(function (e) { return !e.cold; });
    function avg(list, key) {
      var s = 0, n = 0;
      list.forEach(function (e) { if (e[key] !== null) { s += e[key]; n++; } });
      return n ? Math.round(s / n) : null;
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

  function analyzePeEntry(rows, mapResult) {
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    var cmdCol = P66.columnFor(mapResult, 'CMD_LAMBDA');
    if (!tpsCol) return { available: false, reason: 'Need TPS channel.' };
    if (!cmdCol) {
      return { available: false, reason: 'Need commanded lambda/AFR channel.' };
    }
    var episodes = [];
    var cur = null;
    rows.forEach(function (row, i) {
      var tps = num(row[tpsCol]);
      if (tps !== null && tps >= PE_TPS_MIN) {
        if (!cur) cur = { startIdx: i, samples: 0, peAt: null };
        cur.samples++;
        if (cur.peAt === null) {
          var lambda = P66.toLambda ? P66.toLambda(num(row[cmdCol])) : num(row[cmdCol]);
          if (lambda !== null && lambda < PE_LAMBDA_MAX) cur.peAt = i;
        }
      } else if (cur) {
        if (cur.samples >= PE_EPISODE_MIN) episodes.push(cur);
        cur = null;
      }
    });
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

  function analyzeTransmission(rows, mapResult) {
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var vssCol = P66.columnFor(mapResult, 'VSS');
    var tpsCol = P66.columnFor(mapResult, 'TPS');
    if (!rpmCol || !vssCol) {
      return { available: false, reason: 'Need RPM and VSS (vehicle speed) channels.' };
    }

    // Auto-detect VSS units: median RPM/VSS at light cruise should sit in
    // the 4th-gear band (~31 in MPH, ~19 in KPH).
    var cruiseRatios = [];
    var prevVss = null;
    rows.forEach(function (row) {
      var rpm = num(row[rpmCol]), vss = num(row[vssCol]);
      var tps = tpsCol ? num(row[tpsCol]) : null;
      if (rpm === null || vss === null || vss < 5) { prevVss = vss; return; }
      var dvss = (prevVss !== null && vss !== null) ? Math.abs(vss - prevVss) : 99;
      if ((tps === null || (tps >= 8 && tps <= 35)) && dvss < 1.5 && rpm > 1200 && rpm < 2800) {
        cruiseRatios.push(rpm / vss);
      }
      prevVss = vss;
    });
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

    // Per-sample gear with hysteresis: a new gear must persist
    // TRANS_CONFIRM samples before it counts (debounces ratio noise).
    var gears = new Array(rows.length).fill(null);
    var ratios = new Array(rows.length).fill(null);
    var candGear = null, candCount = 0, curGear = null;
    rows.forEach(function (row, i) {
      var rpm = num(row[rpmCol]);
      var vss = num(row[vssCol]);
      if (rpm === null || vss === null || vss < 2 || rpm < 400) {
        gears[i] = curGear; ratios[i] = null; candGear = null; candCount = 0; return;
      }
      var ratio = rpm / (vss * vssToMph);
      ratios[i] = round2(ratio);
      var g = gearOf(ratio);
      if (g === curGear) { candGear = null; candCount = 0; }
      else if (g === candGear) {
        if (++candCount >= TRANS_CONFIRM) { curGear = g; candGear = null; candCount = 0; }
      } else { candGear = g; candCount = g === null ? 0 : 1; }
      gears[i] = curGear;
    });

    function val(col, i) { return col ? num(rows[i][col]) : null; }

    // --- shift events -------------------------------------------------
    var shifts = [];
    var lastShiftIdx = -1000;
    for (var i = TRANS_CONFIRM + 2; i < rows.length; i++) {
      var g0 = gears[i - TRANS_CONFIRM - 1], g1 = gears[i];
      if (g0 === null || g1 === null || g0 === g1) continue;
      if (i - lastShiftIdx < 15) continue; // one event per shift
      lastShiftIdx = i;
      // rpmAt: pre-shift peak, measured BEFORE the transition begins so a
      // mid-shift flare cannot pollute its own baseline. Transition samples
      // live roughly in [i-6, i]; the flare window is [i-4, i].
      var rpmAt = null, mphAt = null, tpsAt = null, flare = 0;
      for (var k = Math.max(0, i - 12); k < Math.max(0, i - 5); k++) {
        var r = val(rpmCol, k);
        if (r !== null && (rpmAt === null || r > rpmAt)) rpmAt = r;
      }
      for (var m = Math.max(0, i - 4); m <= i; m++) {
        var r2 = val(rpmCol, m);
        if (r2 !== null && rpmAt !== null && r2 - rpmAt > flare) flare = r2 - rpmAt;
        if (m === i) {
          var v = val(vssCol, m); mphAt = v === null ? null : round2(v * vssToMph);
          tpsAt = val(tpsCol, m);
        }
      }
      shifts.push({
        index: i,
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
    for (var t = 16; t < rows.length; t++) {
      if (gears[t] === null || gears[t] < 3) continue;
      if (gears[t] !== gears[t - 16]) continue; // gear must be constant
      var tps = val(tpsCol, t);
      var vss = val(vssCol, t);
      if (tps !== null && tps > 45) continue;
      if (vss === null || vss * vssToMph < 30) continue;
      if (t - lastTccIdx < 40) continue; // one event per transition
      var rA = [], rB = [];
      for (var a = t - 16; a < t - 8; a++) if (ratios[a] !== null) rA.push(ratios[a]);
      for (var b = t - 8; b <= t; b++) if (ratios[b] !== null) rB.push(ratios[b]);
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
        tccEvents.push({ index: t, type: type, gear: gears[t] });
        lastTccIdx = t; lastTccType = type;
      }
    }
    // Count lock/unlock pairs close together = TCC hunting.
    for (var c = 1; c < tccEvents.length; c++) {
      if (tccEvents[c].index - tccEvents[c - 1].index < TRANS_HUNT_WINDOW &&
          tccEvents[c].type !== tccEvents[c - 1].type) tccCycles++;
    }

    // --- kickdown: throttle stab followed by a downshift -----------------
    var kickdowns = [];
    if (tpsCol) {
      var prevTps = null;
      rows.forEach(function (row, i) {
        var tps = num(row[tpsCol]);
        if (tps === null) { prevTps = null; return; }
        if (prevTps !== null && tps - prevTps >= TRANS_KICK_DTPS && tps >= TRANS_KICK_TPS_MIN) {
          var found = null;
          for (var j = i + 1; j < Math.min(i + 1 + TRANS_KICK_WINDOW, rows.length); j++) {
            var ds = shifts.filter(function (s) { return s.index >= i && s.index <= j && s.type === 'downshift'; });
            if (ds.length) { found = ds[0]; break; }
          }
          var v = num(row[vssCol]);
          kickdowns.push({
            index: i, tpsFrom: round2(prevTps), tpsTo: round2(tps),
            mphAt: v === null ? null : round2(v * vssToMph),
            downshiftAt: found ? found.index : null,
            delaySec: found ? round2((found.index - i) * 0.145) : null,
            noKickdown: !found
          });
        }
        prevTps = tps;
      });
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
    function pcmShiftSnapshots(col, pair) {
      var out = [];
      if (!col) return out;
      var prev = null, started = false;
      rows.forEach(function (row, i) {
        var v = num(row[col]);
        if (v === null || v <= 0) { prev = v; started = true; return; }
        // Only value *changes* count — the reading at log start is just
        // the pre-log state, not an observed shift.
        if (started && prev !== null && Math.abs(v - prev) > 0.005) {
          out.push({ index: i, pair: pair, timeSec: round3(v) });
        }
        prev = v; started = true;
      });
      return out;
    }
    var pcmShifts = pcmShiftSnapshots(P66.columnFor(mapResult, 'SHIFT_T12'), '1-2')
      .concat(pcmShiftSnapshots(P66.columnFor(mapResult, 'SHIFT_T23'), '2-3'));
    function pcmTypical(pair) {
      var ts = pcmShifts.filter(function (s) { return s.pair === pair; })
        .map(function (s) { return s.timeSec; }).sort(function (a, b) { return a - b; });
      return ts.length ? ts[Math.floor(ts.length / 2)] : null;
    }

    // --- TCC from the channel when the log carries it --------------------
    // Falls back to the ratio-step inference above when absent/empty.
    var tccSource = 'inferred';
    var tccCol = P66.columnFor(mapResult, 'TCC');
    if (tccCol) {
      var tccSeen = 0, lastTccLocked = null, chApplies = 0, chReleases = 0;
      var chEvents = [];
      rows.forEach(function (row, i) {
        var raw = row[tccCol];
        if (raw === null || raw === undefined || String(raw).trim() === '') return;
        tccSeen++;
        var locked;
        var n = num(raw);
        if (n !== null) locked = n > 50; // duty-cycle style
        else locked = /on|lock|engag/i.test(String(raw)); // state style
        if (lastTccLocked !== null && locked !== lastTccLocked) {
          if (locked) chApplies++; else chReleases++;
          chEvents.push({ index: i, type: locked ? 'apply' : 'release', gear: gears[i] });
        }
        lastTccLocked = locked;
      });
      if (tccSeen > 10) {
        tccSource = 'channel';
        tccApplies = chApplies; tccReleases = chReleases;
        tccEvents = chEvents.slice(0, 20);
        tccCycles = 0;
        for (var c2 = 1; c2 < chEvents.length; c2++) {
          if (chEvents[c2].index - chEvents[c2 - 1].index < TRANS_HUNT_WINDOW &&
              chEvents[c2].type !== chEvents[c2 - 1].type) tccCycles++;
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

  function analyzeBankImbalance(rows, mapResult) {
    var b1 = { stft: P66.columnFor(mapResult, 'STFT_B1'), ltft: P66.columnFor(mapResult, 'LTFT_B1') };
    var b2 = { stft: P66.columnFor(mapResult, 'STFT_B2'), ltft: P66.columnFor(mapResult, 'LTFT_B2') };
    if ((!b1.stft && !b1.ltft) || (!b2.stft && !b2.ltft)) {
      return { available: false, reason: 'Need bank-specific STFT/LTFT channels (both banks).' };
    }
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!rpmCol || !mapCol) {
      return { available: false, reason: 'Need RPM and MAP channels.' };
    }
    var q = qualityRows(rows, mapResult);
    rows = q.rows;
    var style1 = {
      stft: b1.stft ? P66.detectTrimStyle(sampleColumn(rows, b1.stft)) : 'percent',
      ltft: b1.ltft ? P66.detectTrimStyle(sampleColumn(rows, b1.ltft)) : 'percent'
    };
    var style2 = {
      stft: b2.stft ? P66.detectTrimStyle(sampleColumn(rows, b2.stft)) : 'percent',
      ltft: b2.ltft ? P66.detectTrimStyle(sampleColumn(rows, b2.ltft)) : 'percent'
    };
    function bankTrim(b, styles, row) {
      var stft = b.stft ? P66.trimToPct(num(row[b.stft]), styles.stft) : 0;
      var ltft = b.ltft ? P66.trimToPct(num(row[b.ltft]), styles.ltft) : 0;
      return stft + ltft;
    }
    var cells = {}; // "rpmBin|mapBin" -> { n1, sum1, n2, sum2 }
    rows.forEach(function (row) {
      var rpm = num(row[rpmCol]);
      var map = num(row[mapCol]);
      if (rpm === null || map === null) return;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key] || (cells[key] = { n1: 0, sum1: 0, n2: 0, sum2: 0, rpmBin: rpmBin(rpm), mapBin: mapBin(map) });
      var t1 = bankTrim(b1, style1, row);
      var t2 = bankTrim(b2, style2, row);
      // A row counts for a bank only when that bank actually reported.
      if (b1.stft && num(row[b1.stft]) === null && b1.ltft && num(row[b1.ltft]) === null) { /* no b1 data */ }
      else { c.n1++; c.sum1 += t1; }
      if (b2.stft && num(row[b2.stft]) === null && b2.ltft && num(row[b2.ltft]) === null) { /* no b2 data */ }
      else { c.n2++; c.sum2 += t2; }
    });
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
   * opts.altitudeFt (default 2840) feeds the baro plausibility check.
   */
  function analyzeSession(parsed, mapResult, opts) {
    var rows = parsed.rows.slice();
    segmentRows(rows, mapResult);
    var missing = [];
    ['RPM', 'MAP', 'TPS'].forEach(function (s) {
      if (!P66.columnFor(mapResult, s)) missing.push(s);
    });
    var altitudeFt = (opts && isFinite(opts.altitudeFt)) ? opts.altitudeFt
      : (typeof P66.DEFAULT_ALTITUDE_FT === 'number' ? P66.DEFAULT_ALTITUDE_FT : 2840);
    return {
      rowCount: rows.length,
      regionDistribution: regionDistribution(rows),
      missingChannels: missing,
      altitudeFt: altitudeFt,
      fuelTrims: analyzeFuelTrims(rows, mapResult),
      knock: analyzeKnock(rows, mapResult),
      lambda: analyzeLambda(rows, mapResult),
      narrowband: analyzeNarrowband(rows, mapResult),
      tipIn: analyzeTipIn(rows, mapResult),
      peEntry: analyzePeEntry(rows, mapResult),
      transmission: analyzeTransmission(rows, mapResult),
      bankImbalance: analyzeBankImbalance(rows, mapResult),
      baro: (typeof P66.analyzeBaro === 'function')
        ? P66.analyzeBaro(rows, mapResult, altitudeFt)
        : { available: false, reason: 'Altitude module not loaded (js/altitude.js).' }
    };
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  P66.segmentRows = segmentRows;
  P66.qualityRows = qualityRows;
  P66.analyzeBankImbalance = analyzeBankImbalance;
  P66.analyzeFuelTrims = analyzeFuelTrims;
  P66.analyzeKnock = analyzeKnock;
  P66.analyzeLambda = analyzeLambda;
  P66.analyzeNarrowband = analyzeNarrowband;
  P66.analyzeTipIn = analyzeTipIn;
  P66.analyzePeEntry = analyzePeEntry;
  P66.analyzeTransmission = analyzeTransmission;
  P66.analyzeSession = analyzeSession;
  P66.toLambda = toLambda;
  P66.REGIONS = REGIONS;
})(typeof window !== 'undefined' ? window : global);
