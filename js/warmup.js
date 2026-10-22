/* P66-Tuner cold-start / warmup enrichment analysis.
 *
 * Second analyzer pass: runs on the rows the hot path gated OUT
 * (js/analyzer.js qualityRows — cold rows below the ECT warmup edge, plus
 * transient rows). The hot path ignores these because cold trims don't
 * reflect the VE table; this pass reads them for what they ARE good for:
 *   - warmup ("choke") enrichment: does it decay sensibly as ECT rises?
 *   - crank/startup fuel: long cranks, RPM flare on start, rich-after-start
 *   - over-fueling flags while cold (BLM/INT pinned low)
 *
 *   P66.analyzeWarmup(logTable, mapResult, gatedRows) -> result
 *   P66.renderWarmupHTML(result) -> compact dashboard HTML (node-safe)
 *
 * Dependencies: js/log-parser.js (asTable/isLogTable/numView),
 *   js/channel-mapper.js (columnFor, fuelTrimBanks, detectTrimStyle,
 *   trimToPct), js/analyzer.js (extractFeatures).
 * Always narrowband: the only fueling input is STFT+LTFT trim percent.
 *
 * ---------------------------------------------------------------- gating
 * EXACT MECHANISM (js/analyzer.js — this pass reuses it verbatim):
 *   P66.extractFeatures(table, mapResult) computes per-sample columns:
 *     isWarm[i]      = ECT at/above the warmup threshold. The threshold is
 *                      ectWarmThreshold(): 160 F when the session ECT max
 *                      exceeds 140, else (session max - 10). A missing ECT
 *                      channel or a missing cell counts as warm (the gate
 *                      targets the known-cold warmup period, not sensor
 *                      dropouts).
 *     isTransient[i] = region === 'transient', i.e. |dTPS| >= 8% or
 *                      |dMAP| >= 8 kPa vs the previous sample.
 *   qualityRows() keeps only rows where isWarm[i] && !isTransient[i].
 *   The warmup-gated rows are exactly: !isTransient[i] && !isWarm[i].
 *   This pass calls P66.extractFeatures itself, so it speaks the exact
 *   same warm/cold and transient dialect as the hot path.
 *
 * gatedRows INPUT SHAPE — one of:
 *   1. number[]   — original row indices into logTable (the excluded rows).
 *                   RECOMMENDED: exact; mirrors qualityRows' keptIndex.
 *   2. boolean[]  — mask, length === logTable.rowCount; true = excluded row.
 *   3. log table  — P66 log table holding the excluded rows in original
 *                   order (e.g. P66.filterTable over the keptIndex
 *                   complement). The warm edge is re-estimated on the
 *                   subset, so the cold/warm split is approximate; crank
 *                   events may also be cut off at the subset boundary.
 *                   Pass shape 1 or 2 for exact membership.
 * Shapes 1/2 are reduced to cold, non-transient rows using the full-table
 * features; transient rows found in the gated set are counted and skipped
 * (result.transientSkipped) — tip-in enrichment is the AE pass's job.
 * Empty or absent gatedRows -> available:false, 'No warmup samples in this
 * log — it starts already warm.'
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var TRIM_LEAN_COLOR = '#6b9bff'; // blue = adding fuel / lean (app convention)
  var TRIM_RICH_COLOR = '#ff5a5a'; // red  = removing fuel / rich
  var ALDL_FRAME_S = 0.145; // 8192-baud ALDL expectation, TIME fallback

  var COLD_NOTE =
    'Cold data is noisy: the O2 sensor is cold and the PCM runs open loop, ' +
    'so trims may sit frozen at zero for much of the warmup. Confidence on ' +
    'these suggestions is deliberately lower than the hot-path ones — ' +
    'treat them as starting points and verify with a second cold start, ' +
    'not flash-and-forget numbers.';

  // Warmup / crank tables in the Robert Saar P66 V6 XDF (defs/xdf/p66-v6-34l.xdf).
  // Suggestions reference these by name + address where identifiable.
  var WARMUP_TABLES = {
    crankVsCoolant: { title: 'Cranking Fuel BPW Multiplier vs Coolant Temp', address: '0x8A9' },
    crankVsRpm: { title: 'Cranking Fuel BPW Multiplier vs RPM', address: '0x8CA' },
    crankVsRefPulses: { title: 'Cranking Fuel BPW Multiplier vs Reference Pulses', address: '0x8EE' },
    chokeVsStartup: { title: 'Choke AFR Multiplier vs Startup Coolant', address: '0x7A2' },
    chokeReduction: { title: 'Choke AFR Reduction vs Coolant Temp (F51)', address: '0x7B0' },
    chokeDelay: { title: 'Choke AFR Reduction Delay vs Coolant Temp (F53)', address: '0x781' },
    chokeVsRpm: { title: 'Choke AFR Multiplier vs RPM', address: '0x5D1' },
    openLoopAfr: { title: 'Open Loop Target AFR', address: '0x7D1' },
    warmClosedLoopDelay: { title: 'Warm Closed Loop Delay', address: '0x952' }
  };

  function round2(v) { return Math.round(v * 100) / 100; }
  function round1(v) { return Math.round(v * 10) / 10; }
  function nn(v) { return v !== v ? null : v; }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ncol(t, name) {
    if (typeof P66.numView !== 'function') return null;
    try { return P66.numView(t, name); } catch (e) { return null; }
  }

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

  function median(vals) {
    if (!vals.length) return NaN;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ---- gatedRows resolution --------------------------------------------
  // Returns { kind, indices } for shapes 1/2, or { kind:'table', table }
  // for shape 3, or null when gatedRows is missing/empty.

  function resolveGated(t, gatedRows) {
    if (!gatedRows) return null;
    if (Array.isArray(gatedRows)) {
      if (!gatedRows.length) return null;
      if (typeof gatedRows[0] === 'number') {
        var idx = [];
        for (var i = 0; i < gatedRows.length; i++) {
          var r = Math.floor(gatedRows[i]);
          if (r >= 0 && r < t.rowCount) idx.push(r);
        }
        return idx.length ? { kind: 'indices', indices: idx } : null;
      }
      var mask = [];
      for (var k = 0; k < gatedRows.length && k < t.rowCount; k++) {
        if (gatedRows[k]) mask.push(k);
      }
      return mask.length ? { kind: 'mask', indices: mask } : null;
    }
    if (typeof P66.isLogTable === 'function' && P66.isLogTable(gatedRows)) {
      return gatedRows.rowCount ? { kind: 'table', table: gatedRows } : null;
    }
    return null;
  }

  function unavailable(reason) {
    return {
      available: false,
      reason: reason,
      inputShape: null,
      coldSamples: 0,
      transientSkipped: 0,
      ectAvailable: false,
      warmThreshold: null,
      ect: null,
      warmupEnrichment: { available: false, reason: reason },
      overfueling: { flagged: false, avgTrim: null, peakRichTrim: null, sustainedPct: null, note: '' },
      crankFuel: { available: false, reason: reason, events: [], verdict: 'no-crank-detected' },
      suggestions: [],
      note: COLD_NOTE
    };
  }

  /**
   * P66.analyzeWarmup(logTable, mapResult, gatedRows) -> result
   *
   * Analyzed SEPARATELY from the hot report: the rows qualityRows() gated
   * out, targeting crank-fuel and warmup-enrichment tables. See the module
   * header for the exact gating mechanism and the gatedRows input shapes.
   */
  function analyzeWarmup(logTable, mapResult, gatedRows) {
    var t = (typeof P66.asTable === 'function') ? P66.asTable(logTable) : null;
    if (!t || !t.rowCount) {
      return unavailable('No warmup samples in this log — it starts already warm.');
    }

    var resolved = resolveGated(t, gatedRows);
    if (!resolved) {
      return unavailable('No warmup samples in this log — it starts already warm.');
    }

    var ectName = P66.columnFor(mapResult, 'ECT');
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var timeName = P66.columnFor(mapResult, 'TIME');

    // Analysis table + cold positions. Shapes 1/2: exact full-table
    // features. Shape 3: re-estimated on the subset (documented approx).
    var at = t, coldPos = [], transientSkipped = 0, warmThreshold = null;
    if (resolved.kind === 'table') {
      at = resolved.table;
      var gfeats = P66.extractFeatures(at, mapResult);
      warmThreshold = gfeats.warmThreshold;
      for (var gi = 0; gi < at.rowCount; gi++) {
        if (gfeats.isTransient[gi]) { transientSkipped++; continue; }
        if (!gfeats.isWarm[gi]) coldPos.push(gi);
      }
    } else {
      var feats = P66.extractFeatures(t, mapResult);
      warmThreshold = feats.warmThreshold;
      for (var q = 0; q < resolved.indices.length; q++) {
        var i = resolved.indices[q];
        if (feats.isTransient[i]) { transientSkipped++; continue; }
        if (!feats.isWarm[i]) coldPos.push(i);
      }
    }
    coldPos.sort(function (a, b) { return a - b; });

    if (!coldPos.length) {
      // No ECT channel means isWarm[] is all-true (unknown counts as warm),
      // so an empty cold set with a null warmThreshold is really "no ECT".
      return unavailable(warmThreshold === null
        ? 'No ECT channel — cannot find the warmup period.'
        : 'No warmup samples in this log — it starts already warm.');
    }

    var ectC = ncol(at, ectName);
    var rpmC = ncol(at, rpmName);
    var timeC = ncol(at, timeName);

    // Median sample interval for crank-duration math.
    var frameS = ALDL_FRAME_S;
    if (timeC) {
      var diffs = [];
      for (var d = 1; d < at.rowCount; d++) {
        var dd = timeC[d] - timeC[d - 1];
        if (dd === dd && dd > 0 && dd < 5) diffs.push(dd);
      }
      var mdt = median(diffs);
      if (mdt === mdt) frameS = mdt;
    }

    // ---- ECT summary over the cold rows ----
    var ectVals = [];
    for (var e = 0; e < coldPos.length; e++) {
      var ev = ectC ? ectC[coldPos[e]] : NaN;
      if (ev === ev) ectVals.push(ev);
    }
    var ectUnit = '°F';
    var ectMax = ectVals.length ? Math.max.apply(null, ectVals) : NaN;
    var ectMin = ectVals.length ? Math.min.apply(null, ectVals) : NaN;
    if (ectMax === ectMax && ectMax <= 140) ectUnit = '°C';
    var ectStart = ectC ? nn(ectC[coldPos[0]]) : null;
    var ectEnd = ectC ? nn(ectC[coldPos[coldPos.length - 1]]) : null;

    // ---- combined trim per cold row (STFT+LTFT, %, bank-averaged) ----
    var banks = (typeof P66.fuelTrimBanks === 'function') ? P66.fuelTrimBanks(mapResult) : [];
    var trimStyles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(at, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(at, b.ltft)) : 'percent'
      };
    });
    var trimCols = banks.map(function (b) {
      return { stft: ncol(at, b.stft), ltft: ncol(at, b.ltft) };
    });
    function combinedTrim(p) {
      if (!banks.length) return NaN;
      var sum = 0, nb = 0;
      for (var bi = 0; bi < banks.length; bi++) {
        var tc = trimCols[bi];
        var s = tc.stft ? P66.trimToPct(nn(tc.stft[p]), trimStyles[bi].stft) : 0;
        var l = tc.ltft ? P66.trimToPct(nn(tc.ltft[p]), trimStyles[bi].ltft) : 0;
        if (s !== 0 || l !== 0 || tc.stft || tc.ltft) { sum += s + l; nb++; }
      }
      return nb ? sum / nb : NaN;
    }

    var coldTrims = coldPos.map(combinedTrim);
    var trimVals = coldTrims.filter(function (v) { return v === v; });
    var avgTrim = trimVals.length
      ? round2(trimVals.reduce(function (a, x) { return a + x; }, 0) / trimVals.length) : null;
    var peakRich = trimVals.length ? round2(Math.min.apply(null, trimVals)) : null;
    var frozenN = coldTrims.filter(function (v) { return v === v && Math.abs(v) < 0.5; }).length;
    var frozenFrac = coldPos.length ? round2(frozenN / coldPos.length) : 0;

    // ---- warmup enrichment: trim vs ECT bins ----
    var enrichment = { available: false, reason: '', verdict: 'inconclusive', bins: [] };
    if (!ectC || !ectVals.length) {
      enrichment.reason = 'No ECT channel — cannot map enrichment against coolant temperature.';
    } else if (!banks.length) {
      enrichment.reason = 'No STFT/LTFT channels — cannot read warmup trim behavior.';
    } else {
      var BIN_W = 10;
      var bins = {};
      for (var b = 0; b < coldPos.length; b++) {
        var p = coldPos[b], tr = coldTrims[b], ec = ectC[p];
        if (ec !== ec || tr !== tr) continue;
        var lo = Math.floor(ec / BIN_W) * BIN_W;
        var bin = bins[lo] || (bins[lo] = { lo: lo, hi: lo + BIN_W, samples: 0, sum: 0 });
        bin.samples++; bin.sum += tr;
      }
      var binList = Object.keys(bins).map(function (k) {
        var x = bins[k];
        return { lo: x.lo, hi: x.hi, samples: x.samples, avgTrim: round2(x.sum / x.samples) };
      }).sort(function (x, y) { return x.lo - y.lo; });
      var active = binList.filter(function (x) { return x.samples >= 3; });
      enrichment.bins = binList;
      if (active.length < 2) {
        enrichment.reason = 'Too few cold samples with live trims to judge the enrichment curve.';
      } else {
        // Least-squares slope of avgTrim vs bin midpoint.
        var sx = 0, sy = 0, sxx = 0, sxy = 0;
        active.forEach(function (x) {
          var xm = (x.lo + x.hi) / 2;
          sx += xm; sy += x.avgTrim; sxx += xm * xm; sxy += xm * x.avgTrim;
        });
        var denom = active.length * sxx - sx * sx;
        var slope = denom !== 0 ? (active.length * sxy - sx * sy) / denom : 0;
        var slopePer10 = round2(slope * 10);
        var third = Math.max(1, Math.floor(active.length / 3));
        var earlyAvg = round2(active.slice(0, third).reduce(function (a, x) { return a + x.avgTrim; }, 0) / third);
        var lateAvg = active[active.length - 1].avgTrim;
        enrichment.available = true;
        enrichment.slopePer10Deg = slopePer10;
        enrichment.earlyAvgTrim = earlyAvg;
        enrichment.lateAvgTrim = lateAvg;
        enrichment.frozenFrac = frozenFrac;
        if (lateAvg > 8) {
          enrichment.verdict = 'stuck-lean';
          enrichment.note = 'Trims were still asking for fuel (' + lateAvg +
            '%) at the warm end of the cold rows — the choke enrichment is ' +
            'too weak or tapering off too fast.';
        } else if (lateAvg < -8) {
          enrichment.verdict = 'stuck-rich';
          enrichment.note = 'Trims were still pulling fuel (' + lateAvg +
            '%) at the warm end of the cold rows — the choke enrichment is ' +
            'too heavy and not decaying.';
        } else {
          enrichment.verdict = 'decaying-sensibly';
          enrichment.note = 'Trims settled near zero (' + lateAvg +
            '%) as coolant temperature rose, moving ' +
            (slopePer10 >= 0 ? '+' : '') + slopePer10 +
            '% per 10' + ectUnit + ' — the choke enrichment is tapering off the way it should.';
        }
        if (frozenFrac > 0.7) {
          enrichment.note += ' Note: trims sat frozen at zero for ' +
            Math.round(frozenFrac * 100) + '% of the cold rows (PCM in open ' +
            'loop, O2 sensor cold) — that part of the warmup says nothing ' +
            'about enrichment; the verdict leans on the rows where trims were alive.';
        }
      }
    }

    // ---- over-fueling flag: BLM/INT pinned low while cold ----
    var overfueling = {
      flagged: false, avgTrim: avgTrim, peakRichTrim: peakRich, sustainedPct: null, note: ''
    };
    if (trimVals.length >= 10) {
      var richN = trimVals.filter(function (v) { return v < -8; }).length;
      overfueling.sustainedPct = round2(richN / trimVals.length);
      if (avgTrim !== null && avgTrim < -10) {
        overfueling.flagged = true;
        overfueling.note = 'The PCM was pulling ' + Math.abs(avgTrim) +
          '% fuel on average while cold (richest sample ' + peakRich +
          '%) — the cold enrichment is drowning it, not helping it.';
      }
    }

    // ---- crank / startup fuel ----
    var crank = { available: false, reason: '', events: [], verdict: 'no-crank-detected', note: '' };
    if (!rpmC) {
      crank.reason = 'No RPM channel — cannot find the cranking period.';
    } else {
      var crankRuns = [], run = null;
      for (var c = 0; c < coldPos.length; c++) {
        var p = coldPos[c], rpm = rpmC[p];
        if (rpm === rpm && rpm > 0 && rpm <= 450) {
          if (!run) run = { start: p, end: p };
          else if (p === run.end + 1) run.end = p;
          else { crankRuns.push(run); run = { start: p, end: p }; }
        } else if (run) { crankRuns.push(run); run = null; }
      }
      if (run) crankRuns.push(run);
      if (!crankRuns.length) {
        crank.reason = 'No cranking detected — logging started after the engine was already running.';
      } else {
        crank.available = true;
        var events = crankRuns.map(function (r) {
          var ev = { startRow: r.start, samples: r.end - r.start + 1, durationS: null,
                     rpmFlare: null, richAfterStart: null, started: false };
          var t0 = timeC ? timeC[r.start] : null, t1 = timeC ? timeC[r.end] : null;
          ev.durationS = (t0 !== null && t1 !== null && t0 === t0 && t1 === t1)
            ? round2(Math.max(0, t1 - t0)) : round2(ev.samples * frameS);
          // Find the first engine-on row after the crank run.
          var startP = -1;
          for (var s = r.end + 1; s < at.rowCount && s < r.end + 1 + 200; s++) {
            var sr = rpmC[s];
            if (sr === sr && sr > 400) { startP = s; break; }
          }
          if (startP >= 0) {
            ev.started = true;
            var tStart = timeC ? timeC[startP] : null;
            var flareMax = -Infinity, settle = [];
            for (var q2 = startP; q2 < at.rowCount; q2++) {
              var rr = rpmC[q2];
              var dt = (timeC && tStart !== null && tStart === tStart)
                ? timeC[q2] - tStart : (q2 - startP) * frameS;
              if (dt !== dt || dt > 30) break;
              if (rr === rr) {
                if (dt <= 3 && rr > flareMax) flareMax = rr;
                if (dt >= 10 && dt <= 30) settle.push(rr);
              }
            }
            // rich-after-start: avg combined trim over the first 20 s.
            var tSum = 0, tN = 0;
            for (var q3 = startP; q3 < at.rowCount; q3++) {
              var dt3 = (timeC && tStart !== null && tStart === tStart)
                ? timeC[q3] - tStart : (q3 - startP) * frameS;
              if (dt3 !== dt3 || dt3 > 20) break;
              var tr3 = combinedTrim(q3);
              if (tr3 === tr3) { tSum += tr3; tN++; }
            }
            if (tN) ev.richAfterStart = round2(tSum / tN);
            var settleMed = median(settle);
            if (flareMax > -Infinity && settleMed === settleMed) {
              ev.rpmFlare = Math.round(flareMax - settleMed);
            }
          }
          return ev;
        });
        crank.events = events.map(function (ev) {
          return { startRow: ev.startRow, samples: ev.samples, durationS: ev.durationS,
                   rpmFlare: ev.rpmFlare, richAfterStart: ev.richAfterStart, started: ev.started };
        });
        var longCrank = events.some(function (ev) { return ev.started && ev.durationS > 3; });
        var weakFlare = events.some(function (ev) {
          return ev.started && ev.rpmFlare !== null && ev.rpmFlare < 200;
        });
        if (longCrank) {
          crank.verdict = 'long-crank';
          crank.note = 'At least one start cranked for more than 3 seconds — ' +
            'that is the classic sign of too little cranking fuel when cold.';
        } else if (weakFlare) {
          crank.verdict = 'weak-flare';
          crank.note = 'The engine caught but barely flared on startup — ' +
            'afterstart fuel may be light, or the crank fuel is only just enough.';
        } else {
          crank.verdict = 'healthy';
          crank.note = 'Cranking caught promptly with a normal startup flare.';
        }
      }
    }

    // ---- suggestions (advisory only; confidence low by design) ----
    var suggestions = [];
    var ns = coldPos.length;
    function advise(tableKey, deltaPct, reason) {
      var tbl = WARMUP_TABLES[tableKey];
      suggestions.push({
        kind: 'warmup',
        table: tbl.title,
        address: tbl.address,
        action: 'review',
        deltaPct: deltaPct,
        reason: reason,
        confidence: 'low',
        samples: ns
      });
    }

    if (enrichment.available) {
      if (enrichment.verdict === 'stuck-rich' || overfueling.flagged) {
        advise('chokeVsStartup', -5,
          'Warmup enrichment is too heavy (' + enrichment.lateAvgTrim +
          '% trim at the warm end of the cold rows' +
          (overfueling.flagged ? ', ' + Math.abs(avgTrim) + '% average while cold' : '') +
          '). Consider easing the cold-ECT cells of "' +
          WARMUP_TABLES.chokeVsStartup.title + '" (' + WARMUP_TABLES.chokeVsStartup.address +
          ') down about 5%.');
      } else if (enrichment.verdict === 'stuck-lean') {
        advise('chokeReduction', 5,
          'Warmup enrichment is too weak (' + enrichment.lateAvgTrim +
          '% trim at the warm end of the cold rows). Consider adding about 5% to the ' +
          'cold-ECT cells of "' + WARMUP_TABLES.chokeReduction.title + '" (' +
          WARMUP_TABLES.chokeReduction.address + ').');
      } else if (enrichment.earlyAvgTrim !== undefined && enrichment.earlyAvgTrim < -10) {
        advise('chokeVsStartup', -3,
          'The choke is a touch heavy when stone cold (' + enrichment.earlyAvgTrim +
          '% trim at the coldest coolant temps) but it decays sensibly as ECT rises. ' +
          'If cold starts smell rich, ease just the lowest-ECT cells of "' +
          WARMUP_TABLES.chokeVsStartup.title + '" (' + WARMUP_TABLES.chokeVsStartup.address +
          ') down a couple percent.');
      } else {
        suggestions.push({
          kind: 'warmup',
          table: WARMUP_TABLES.chokeVsStartup.title,
          address: WARMUP_TABLES.chokeVsStartup.address,
          action: 'none',
          deltaPct: 0,
          reason: 'Warmup enrichment looks right — trims settled near zero as coolant ' +
            'temperature rose. No change suggested.',
          confidence: 'low',
          samples: ns
        });
      }
    }

    if (crank.available && crank.verdict === 'long-crank') {
      var worst = crank.events.filter(function (ev) { return ev.started; })
        .sort(function (a, b) { return b.durationS - a.durationS; })[0];
      var ectAtCrank = (ectC && worst) ? nn(ectC[worst.startRow]) : null;
      advise('crankVsCoolant', 10,
        'Long crank (' + (worst ? worst.durationS : '?') + ' s' +
        (ectAtCrank !== null ? ' at ' + Math.round(ectAtCrank) + ectUnit + ' ECT' : '') +
        ') points at too little cranking fuel. Consider adding about 10% to the ' +
        'matching coolant-temp cells of "' + WARMUP_TABLES.crankVsCoolant.title + '" (' +
        WARMUP_TABLES.crankVsCoolant.address + ').');
    }

    return {
      available: true,
      reason: null,
      inputShape: resolved.kind,
      coldSamples: coldPos.length,
      transientSkipped: transientSkipped,
      ectAvailable: !!(ectC && ectVals.length),
      warmThreshold: warmThreshold,
      ect: ectVals.length ? {
        start: ectStart, end: ectEnd, min: round1(ectMin), max: round1(ectMax), unit: ectUnit
      } : null,
      warmupEnrichment: enrichment,
      overfueling: overfueling,
      crankFuel: crank,
      suggestions: suggestions,
      note: COLD_NOTE
    };
  }

  // ---- HTML ---------------------------------------------------------------

  function trimSpan(v) {
    if (v === null || v === undefined || v !== v) return '<span>—</span>';
    var color = v > 0.5 ? TRIM_LEAN_COLOR : (v < -0.5 ? TRIM_RICH_COLOR : 'inherit');
    var sign = v > 0 ? '+' : '';
    return '<span style="color:' + color + ';font-weight:600;">' + sign + round1(v) + '%</span>';
  }

  function verdictBadge(verdict) {
    var style, text;
    if (verdict === 'decaying-sensibly' || verdict === 'healthy') {
      style = 'background:#1d3a24;color:#7fd08a;border:1px solid #2f5c3a;';
      text = verdict === 'healthy' ? 'Healthy' : 'Decaying sensibly';
    } else if (verdict === 'stuck-lean' || verdict === 'long-crank') {
      style = 'background:#3a2a17;color:#f0b35e;border:1px solid #6b4d24;';
      text = verdict === 'long-crank' ? 'Long crank' : 'Stuck lean';
    } else if (verdict === 'stuck-rich' || verdict === 'weak-flare') {
      style = 'background:#3d1f1f;color:#ff8a8a;border:1px solid #6b2f2f;';
      text = verdict === 'weak-flare' ? 'Weak flare' : 'Stuck rich';
    } else {
      style = 'background:#2a2f38;color:#aab3c0;border:1px solid #454c59;';
      text = 'Inconclusive';
    }
    return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;' +
      'font-size:12px;font-weight:600;' + style + '">' + text + '</span>';
  }

  /**
   * P66.renderWarmupHTML(result) -> compact HTML string (node-safe).
   * Plain-language cold-start summary: ECT range, enrichment verdict with
   * the trim-vs-ECT bins, crank findings, over-fueling flag, and the
   * advisory suggestions with their XDF table name + address.
   */
  function renderWarmupHTML(result) {
    result = result || {};
    var html = '<div class="p66-warmup" style="font-size:13px;line-height:1.45;">';
    html += '<div style="font-weight:700;margin-bottom:4px;">Cold start / warmup enrichment</div>';

    if (result.available === false) {
      html += '<div style="opacity:0.8;margin-bottom:8px;">' +
        escHtml(result.reason || 'No warmup data.') + '</div>';
      html += '</div>';
      return html;
    }

    var ect = result.ect;
    if (ect) {
      html += '<div style="margin-bottom:8px;">' + result.coldSamples +
        ' cold sample' + (result.coldSamples === 1 ? '' : 's') +
        ' analyzed — coolant rose from ' + Math.round(ect.start) + ' to ' +
        Math.round(ect.end) + ' ' + escHtml(ect.unit) + '.' +
        (result.transientSkipped ? ' <span style="opacity:0.7;">(' +
          result.transientSkipped + ' transient sample(s) skipped.)</span>' : '') +
        '</div>';
    }

    // Warmup enrichment section.
    var en = result.warmupEnrichment || {};
    html += '<div style="border-top:1px solid rgba(128,128,128,0.25);padding:6px 0;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">';
    html += '<span style="font-weight:600;">Warmup enrichment</span>';
    html += en.available ? verdictBadge(en.verdict) : verdictBadge('inconclusive');
    html += '</div>';
    if (en.available) {
      html += '<div style="margin-top:2px;">' + escHtml(en.note || '') + '</div>';
      if (en.bins && en.bins.length) {
        html += '<div style="margin-top:6px;font-size:12px;">';
        en.bins.forEach(function (b) {
          html += '<div style="display:flex;justify-content:space-between;max-width:340px;' +
            'padding:1px 0;border-bottom:1px dotted rgba(128,128,128,0.2);">' +
            '<span>' + b.lo + '–' + b.hi + ' ' + escHtml(ect ? ect.unit : '') + '</span>' +
            '<span>' + trimSpan(b.avgTrim) + ' <span style="opacity:0.6;">(' +
            b.samples + ')</span></span></div>';
        });
        html += '</div>';
      }
    } else if (en.reason) {
      html += '<div style="opacity:0.75;margin-top:2px;">' + escHtml(en.reason) + '</div>';
    }
    html += '</div>';

    // Crank section.
    var ck = result.crankFuel || {};
    html += '<div style="border-top:1px solid rgba(128,128,128,0.25);padding:6px 0;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">';
    html += '<span style="font-weight:600;">Crank / startup fuel</span>';
    html += verdictBadge(ck.verdict === 'no-crank-detected' ? 'inconclusive' : ck.verdict);
    html += '</div>';
    if (ck.available && ck.events && ck.events.length) {
      ck.events.forEach(function (ev, k) {
        html += '<div style="margin-top:2px;font-size:12px;">Start ' + (k + 1) + ': cranked ' +
          ev.durationS + ' s' +
          (ev.rpmFlare !== null ? ', flare +' + ev.rpmFlare + ' rpm' : '') +
          (ev.richAfterStart !== null ? ', first-20-s trim ' + trimSpan(ev.richAfterStart) : '') +
          '.</div>';
      });
      if (ck.note) html += '<div style="opacity:0.85;margin-top:2px;">' + escHtml(ck.note) + '</div>';
    } else if (ck.reason) {
      html += '<div style="opacity:0.75;margin-top:2px;">' + escHtml(ck.reason) + '</div>';
    }
    html += '</div>';

    // Over-fueling flag.
    var of = result.overfueling || {};
    if (of.flagged) {
      html += '<div style="border-top:1px solid rgba(128,128,128,0.25);padding:6px 0;">' +
        '<span style="font-weight:600;color:' + TRIM_RICH_COLOR + ';">Over-fueling while cold</span>' +
        '<div style="margin-top:2px;">' + escHtml(of.note || '') + '</div></div>';
    }

    // Suggestions.
    var sug = Array.isArray(result.suggestions) ? result.suggestions : [];
    if (sug.length) {
      html += '<div style="border-top:1px solid rgba(128,128,128,0.25);padding:6px 0;">';
      html += '<div style="font-weight:600;margin-bottom:4px;">Suggestions (advisory — cold data is noisy)</div>';
      sug.forEach(function (s) {
        html += '<div style="margin-bottom:6px;">';
        html += '<div><span style="font-weight:600;">' + escHtml(s.table) + '</span> ' +
          '<span style="opacity:0.65;font-size:12px;">' + escHtml(s.address || '') + '</span>';
        if (s.action === 'review' && s.deltaPct) {
          html += ' <span style="font-weight:600;">' +
            (s.deltaPct > 0 ? '+' : '') + s.deltaPct + '%</span>';
        } else if (s.action === 'none') {
          html += ' <span style="opacity:0.6;">(no change)</span>';
        }
        html += '</div>';
        html += '<div style="opacity:0.85;">' + escHtml(s.reason || '') + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div style="margin-top:8px;font-size:11px;opacity:0.65;">' +
      escHtml(result.note || '') + ' Trim colors: ' +
      '<span style="color:' + TRIM_LEAN_COLOR + ';font-weight:600;">blue = lean (ECU adding fuel)</span>, ' +
      '<span style="color:' + TRIM_RICH_COLOR + ';font-weight:600;">red = rich (ECU removing fuel)</span>. Narrowband only.</div>';
    html += '</div>';
    return html;
  }

  P66.WARMUP_TABLES = WARMUP_TABLES;
  P66.analyzeWarmup = analyzeWarmup;
  P66.renderWarmupHTML = renderWarmupHTML;

})(typeof window !== 'undefined' ? window : global);
