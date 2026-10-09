/* P66-Tuner master auto tuner engine
 * Rule-based correction suggestions derived from session analysis,
 * with safety gates per confidence mode. Suggestions are guidance
 * only — always verify manually before flashing.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Safety gates per mode. Conservative is the default.
  var MODES = {
    conservative: {
      maxFuelDeltaPct: 5,   // cap on VE/MAF correction per pass
      maxSparkDeltaDeg: 2,  // cap on spark advance change per pass
      minCellSamples: 30,   // minimum samples before a fuel cell is actionable
      minKnockSamples: 10,  // minimum knock samples before spark action
      trimThresholdPct: 4,  // |avg trim| above this triggers a suggestion
      lambdaThreshold: 0.04 // |lambda error| above this triggers PE suggestion
    },
    balanced: {
      maxFuelDeltaPct: 8,
      maxSparkDeltaDeg: 3,
      minCellSamples: 20,
      minKnockSamples: 6,
      trimThresholdPct: 3,
      lambdaThreshold: 0.03
    },
    aggressive: {
      maxFuelDeltaPct: 12,
      maxSparkDeltaDeg: 4,
      minCellSamples: 10,
      minKnockSamples: 4,
      trimThresholdPct: 2,
      lambdaThreshold: 0.02
    }
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /**
   * Fueling suggestions from trim-bias cells.
   * Positive avg trim = ECU adding fuel = running lean = VE/MAF table is
   * low there, so increase it by approximately the trim amount.
   * When a narrowband report is available, per-cell O2 bias corroborates
   * (or challenges) each suggestion and adjusts confidence.
   */
  function fuelSuggestions(fuelReport, gates, nbReport) {
    var out = [];
    if (!fuelReport || !fuelReport.available) return out;
    var nbByCell = {};
    if (nbReport && nbReport.available) {
      nbReport.cells.forEach(function (c) {
        nbByCell[c.rpmBin + '|' + c.mapBin] = c;
      });
    }
    fuelReport.cells.forEach(function (cell) {
      if (cell.samples < gates.minCellSamples) {
        out.push({
          kind: 'fuel', table: 'VE/MAF', cell: cell.rpmBin + ' RPM / ' + cell.mapBin + ' kPa',
          action: 'none', deltaPct: 0,
          reason: 'Low confidence: only ' + cell.samples + ' samples (need ' + gates.minCellSamples + '). No change suggested.',
          confidence: 'low', samples: cell.samples
        });
        return;
      }
      if (Math.abs(cell.avgTrim) < gates.trimThresholdPct) return; // within tolerance
      // Positive avg trim = ECU adding fuel = running lean = VE/MAF table is
      // low there, so increase it by approximately the trim amount.
      var rawDelta = cell.avgTrim;
      var delta = round2(clamp(rawDelta, -gates.maxFuelDeltaPct, gates.maxFuelDeltaPct));
      var capped = Math.abs(rawDelta) > gates.maxFuelDeltaPct;
      var confidence = cell.samples >= gates.minCellSamples * 2 ? 'high' : 'medium';
      var corroboration = '';
      var nb = nbByCell[cell.rpmBin + '|' + cell.mapBin];
      if (nb && nb.samples >= 10) {
        var trimSaysLean = cell.avgTrim > 0;
        if ((trimSaysLean && nb.bias === 'lean') || (!trimSaysLean && nb.bias === 'rich')) {
          corroboration = ' Narrowband O2 agrees (' + nb.bias + ', avg ' + nb.avgMv + ' mV over ' +
            nb.samples + ' samples) — confidence raised.';
          confidence = 'high';
        } else if (nb.bias !== 'switching') {
          corroboration = ' Narrowband O2 disagrees (reads ' + nb.bias + ', avg ' + nb.avgMv +
            ' mV) — treat cautiously, verify sensor health.';
          if (confidence === 'high') confidence = 'medium';
        }
      }
      out.push({
        kind: 'fuel', table: 'VE/MAF', cell: cell.rpmBin + ' RPM / ' + cell.mapBin + ' kPa',
        action: delta > 0 ? 'add fuel' : 'remove fuel', deltaPct: delta,
        reason: 'Avg combined trim ' + (cell.avgTrim > 0 ? '+' : '') + cell.avgTrim +
          '% over ' + cell.samples + ' samples (stddev ' + cell.stddev + ').' +
          (capped ? ' Capped at mode limit; re-log and iterate.' : '') + corroboration,
        confidence: confidence,
        samples: cell.samples
      });
    });
    return out;
  }

  /**
   * Main Spark Advance axis breakpoints from a catalog (bundled by default).
   * Returns { rpmBp: [...], mapBp: [...] } or null when unavailable.
   * Mirrors js/xdf-map.js mapPointToTable's nearest-breakpoint mapping, so
   * the cell an event is gated on is the cell the patcher would retard.
   */
  function sparkAxes(catalog) {
    if (!catalog || !catalog.tables) return null;
    var t = null;
    catalog.tables.forEach(function (tbl) {
      if (/main spark/i.test(tbl.title || '')) t = tbl;
    });
    if (!t || !t.xAxis || !t.yAxis) return null;
    function bps(axis) {
      var out = [];
      (axis.labels || []).forEach(function (l) {
        var v = parseFloat(l);
        if (isFinite(v)) out.push(v);
      });
      return out;
    }
    var rpmBp = bps(t.yAxis), mapBp = bps(t.xAxis);
    if (!rpmBp.length || !mapBp.length) return null;
    return { rpmBp: rpmBp, mapBp: mapBp };
  }

  function nearestSparkCell(axes, rpm, map) {
    if (rpm === null || rpm === undefined || map === null || map === undefined) return null;
    function nearest(bp, v) {
      var best = 0, bestD = Math.abs(bp[0] - v);
      for (var i = 1; i < bp.length; i++) {
        var d = Math.abs(bp[i] - v);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    return { row: nearest(axes.rpmBp, rpm), col: nearest(axes.mapBp, map) };
  }

  /**
   * Spark suggestions from knock analysis.
   *
   * Gating — conservative by design; ghosts must never move timing:
   *  1. Single-sample spikes are burst noise, not knock (genuine PCM knock
   *     retard decays over many samples). Reported, never actionable.
   *  2. Tip-out events (throttle closed during the event) are drivetrain
   *     false knock. Reported, never actionable.
   *  3. Automatic retard requires REPEATABLE knock: >= 2 events mapping to
   *     the same Main Spark cell. A single genuine event is monitor-only.
   * The pull for a repeatable cell is sized from the median peak of that
   * cell's events. knockCells carry each event's RPM/MAP for the patcher.
   */
  function sparkSuggestions(knockReport, gates, catalog) {
    var out = [];
    if (!knockReport || !knockReport.available) return out;
    if (knockReport.knockSamples < gates.minKnockSamples) {
      if (knockReport.knockSamples > 0) {
        out.push({
          kind: 'spark', table: 'Spark Advance', cell: 'global',
          action: 'none', deltaDeg: 0,
          reason: 'Only ' + knockReport.knockSamples + ' knock samples — below action threshold (' +
            gates.minKnockSamples + '). Monitor; no change suggested.',
          confidence: 'low', samples: knockReport.knockSamples
        });
      }
      return out;
    }

    // Partition events: only steady-throttle, multi-sample events can act.
    var clean = [], noise = [], tipOut = [];
    (knockReport.events || []).forEach(function (e) {
      var isNoise = (e.suspectNoise !== undefined) ? e.suspectNoise : e.samples <= 1;
      var isTipOut = (e.tipOut !== undefined) ? e.tipOut
        : (e.tpsDrop !== null && e.tpsDrop !== undefined && e.tpsDrop > 10);
      if (isNoise) noise.push(e);
      else if (isTipOut) tipOut.push(e);
      else clean.push(e);
    });
    var rejectedParts = [];
    if (noise.length) rejectedParts.push(noise.length +
      ' single-sample spike(s) rejected as noise (peak ' +
      noise.map(function (e) { return e.peakKR + '°'; }).join(', ') + ')');
    if (tipOut.length) rejectedParts.push(tipOut.length +
      ' tip-out event(s) rejected as false knock (throttle closed during event)');
    function rejectedNote() {
      return rejectedParts.length ? ' ' + rejectedParts.join('. ') + '.' : '';
    }

    // Target region: non-transient region with the most CLEAN knock samples.
    var targetRegion = null, targetSamples = 0;
    var cleanByRegion = {};
    clean.forEach(function (e) {
      if (e.region === 'transient') return;
      cleanByRegion[e.region] = (cleanByRegion[e.region] || 0) + e.samples;
    });
    Object.keys(cleanByRegion).forEach(function (r) {
      if (cleanByRegion[r] > targetSamples) { targetSamples = cleanByRegion[r]; targetRegion = r; }
    });
    var regionEvents = targetRegion
      ? clean.filter(function (e) { return e.region === targetRegion; })
      : [];

    function monitorSuggestion(reason, cells) {
      out.push({
        kind: 'spark', table: 'Spark Advance',
        cell: (targetRegion ? targetRegion + ' region' : 'global'),
        action: 'none', deltaDeg: 0,
        knockCells: cells,
        reason: reason + rejectedNote(),
        confidence: 'low', samples: knockReport.knockSamples
      });
    }
    function eventCells(evs) {
      var cells = [];
      evs.forEach(function (e) {
        if (e.rpm !== null && e.rpm !== undefined && e.map !== null && e.map !== undefined) {
          cells.push({ rpm: e.rpm, map: e.map, peakKR: e.peakKR });
        }
      });
      return cells;
    }

    if (!regionEvents.length) {
      monitorSuggestion(
        clean.length
          ? 'Genuine knock events occurred only during transients — likely false knock from drivetrain noise. No timing change suggested; verify with audio knock detection.'
          : 'No steady-throttle knock events. No timing change suggested.' +
            (noise.length + tipOut.length ? '' : ' Monitor; no change suggested.'),
        []);
      return out;
    }

    // Repeatability: >= 2 events mapping to the same Main Spark cell.
    var axes = sparkAxes(catalog || P66.BUNDLED_CATALOG);
    if (!axes) {
      monitorSuggestion(
        regionEvents.length + ' genuine knock event(s) in ' + targetRegion +
        ', but spark table axes are unavailable — repeatability cannot be confirmed. No timing change suggested.',
        eventCells(regionEvents));
      return out;
    }
    var cells = {}; // "row,col" -> { events, row, col }
    var unmapped = 0;
    regionEvents.forEach(function (e) {
      var hit = nearestSparkCell(axes, e.rpm, e.map);
      if (!hit) { unmapped++; return; }
      var key = hit.row + ',' + hit.col;
      if (!cells[key]) cells[key] = { events: [], row: hit.row, col: hit.col };
      cells[key].events.push(e);
    });
    if (unmapped) rejectedParts.push(unmapped + ' event(s) could not be mapped to the spark table');

    var keys = Object.keys(cells);
    var repeatable = keys.filter(function (k) { return cells[k].events.length >= 2; });
    var singletons = keys.filter(function (k) { return cells[k].events.length < 2; });

    // Monitor-only notes for genuine but not-yet-repeatable knock.
    singletons.forEach(function (k) {
      var evs = cells[k].events;
      var e = evs[0];
      var label = axes.rpmBp[cells[k].row] + ' RPM / ' + axes.mapBp[cells[k].col] + ' kPa';
      monitorSuggestion(
        'Genuine knock seen once at ' + e.rpm + ' RPM / ' + e.map + ' kPa (peak ' + e.peakKR +
        '°) — not yet repeatable in spark cell ' + label + '. Log again and confirm it returns ' +
        'in the same cell before pulling timing.',
        eventCells(evs));
    });

    // Actionable: one suggestion per repeatable cell, sized from that cell's median peak.
    repeatable.forEach(function (k) {
      var evs = cells[k].events;
      var peaks = evs.map(function (e) { return e.peakKR; }).sort(function (a, b) { return a - b; });
      var medianPeak = peaks[Math.floor(peaks.length / 2)];
      var pull = round2(clamp(medianPeak, 0.5, gates.maxSparkDeltaDeg));
      var label = axes.rpmBp[cells[k].row] + ' RPM / ' + axes.mapBp[cells[k].col] + ' kPa';
      out.push({
        kind: 'spark', table: 'Spark Advance',
        cell: targetRegion + ' region — spark cell ' + label,
        action: 'retard timing',
        deltaDeg: -pull,
        knockCells: eventCells(evs),
        reason: evs.length + ' repeatable knock events in ' + targetRegion + ' (' + label +
          '); median event peak ' + medianPeak + '°. Pull timing, re-log, and confirm KR trends down.' +
          rejectedNote(),
        confidence: evs.length >= 3 ? 'high' : 'medium',
        samples: knockReport.knockSamples
      });
    });

    if (!repeatable.length && !singletons.length) {
      monitorSuggestion('No mappable knock events in ' + targetRegion + '.', []);
    }
    return out;
  }

  /**
   * Power-enrichment suggestion from WOT lambda error.
   */
  function peSuggestions(lambdaReport, gates) {
    var out = [];
    if (!lambdaReport || !lambdaReport.available) return out;
    var wot = lambdaReport.byRegion.wot;
    if (!wot || wot.samples < gates.minCellSamples) {
      if (wot && wot.samples > 0) {
        out.push({
          kind: 'pe', table: 'Power Enrichment', cell: 'WOT',
          action: 'none', deltaPct: 0,
          reason: 'Only ' + wot.samples + ' WOT lambda samples — low confidence. No change suggested.',
          confidence: 'low', samples: wot.samples
        });
      }
      return out;
    }
    if (wot.avgAbsError < gates.lambdaThreshold) return;
    // Convert mean lambda error to a fueling delta: lean (positive err) needs more fuel.
    // Approximate: delta% = err * 100, capped.
    var delta = round2(clamp(wot.avgAbsError * 100, 0, gates.maxFuelDeltaPct));
    out.push({
      kind: 'pe', table: 'Power Enrichment', cell: 'WOT',
      action: 'enrich', deltaPct: delta,
      reason: 'WOT avg lambda error ' + wot.avgAbsError + ' over ' + wot.samples +
        ' samples (target within ' + gates.lambdaThreshold + '). After flashing, log another WOT pull and ' +
        'confirm the narrowband O2 sensor reads solidly rich at full throttle.',
      confidence: 'medium', samples: wot.samples
    });
    return out;
  }

  /**
   * Generate the full suggestion set for a session report.
   * mode: 'conservative' | 'balanced' | 'aggressive'
   * catalog: XDF catalog used for spark-cell repeatability gating
   *   (defaults to the bundled P66 definitions when omitted).
   */
  function generateSuggestions(report, mode, catalog) {
    mode = MODES[mode] ? mode : 'conservative';
    var gates = MODES[mode];
    var suggestions = []
      .concat(fuelSuggestions(report.fuelTrims, gates, report.narrowband))
      .concat(sparkSuggestions(report.knock, gates, catalog))
      .concat(peSuggestions(report.lambda, gates));

    var actionable = suggestions.filter(function (s) { return s.action !== 'none'; });
    var blocked = suggestions.filter(function (s) { return s.action === 'none'; });

    return {
      mode: mode,
      gates: gates,
      suggestions: suggestions,
      actionable: actionable,
      blocked: blocked,
      summary: actionable.length + ' actionable suggestion(s), ' + blocked.length +
        ' held back by safety gates (' + mode + ' mode).'
    };
  }

  P66.MODES = MODES;
  P66.generateSuggestions = generateSuggestions;
})(typeof window !== 'undefined' ? window : global);
