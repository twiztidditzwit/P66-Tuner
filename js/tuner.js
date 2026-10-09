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
   * Spark suggestions from knock analysis.
   * Uses per-event statistics: the target region is the non-transient region
   * with the most knock samples, and the pull is sized from the median event
   * peak (robust against single-sample spikes). Tip-out knock is flagged as
   * possible false knock.
   */
  function sparkSuggestions(knockReport, gates) {
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
    // Target region: most knock samples outside transient (tip-out noise).
    var targetRegion = null, targetSamples = 0;
    Object.keys(knockReport.byRegion).forEach(function (r) {
      if (r === 'transient') return;
      if (knockReport.byRegion[r].samples > targetSamples) {
        targetSamples = knockReport.byRegion[r].samples;
        targetRegion = r;
      }
    });
    if (!targetRegion) {
      out.push({
        kind: 'spark', table: 'Spark Advance', cell: 'global',
        action: 'none', deltaDeg: 0,
        reason: 'Knock occurred only during transients — likely false knock from drivetrain noise. No timing change suggested; verify with audio knock detection.',
        confidence: 'low', samples: knockReport.knockSamples
      });
      return out;
    }
    var regionEvents = knockReport.events.filter(function (e) { return e.region === targetRegion; });
    var peaks = regionEvents.map(function (e) { return e.peakKR; }).sort(function (a, b) { return a - b; });
    var medianPeak = peaks[Math.floor(peaks.length / 2)];
    var pull = round2(clamp(medianPeak, 0.5, gates.maxSparkDeltaDeg));
    var tipOut = regionEvents.some(function (e) { return e.tpsDrop !== null && e.tpsDrop > 10; });
    var singleSpike = regionEvents.length === 1 && regionEvents[0].samples === 1;
    // Knock cell positions (RPM/MAP at each event's peak KR) for the patcher.
    var knockCells = [];
    regionEvents.forEach(function (e) {
      if (e.rpm !== null && e.rpm !== undefined && e.map !== null && e.map !== undefined) {
        knockCells.push({ rpm: e.rpm, map: e.map, peakKR: e.peakKR });
      }
    });
    out.push({
      kind: 'spark', table: 'Spark Advance', cell: targetRegion + ' region',
      action: singleSpike ? 'none' : 'retard timing',
      deltaDeg: singleSpike ? 0 : -pull,
      knockCells: knockCells,
      reason: knockReport.knockEvents + ' knock event(s), ' + knockReport.knockSamples +
        ' samples (' + knockReport.knockPct + '% of log) in ' + targetRegion +
        '; median event peak ' + medianPeak + '°, max ' + knockReport.maxKR + '°.' +
        (singleSpike ? ' Only a single-sample spike — likely noise; no change suggested.' : '') +
        (tipOut ? ' Largest event coincided with throttle lift — possible false knock; verify before pulling timing.' : '') +
        (!singleSpike ? ' Pull timing, re-log, and confirm KR trends down.' : ''),
      confidence: singleSpike ? 'low' : (regionEvents.length >= 2 ? 'high' : 'medium'),
      samples: knockReport.knockSamples
    });
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
        ' samples (target within ' + gates.lambdaThreshold + '). Verify on wideband after change.',
      confidence: 'medium', samples: wot.samples
    });
    return out;
  }

  /**
   * Generate the full suggestion set for a session report.
   * mode: 'conservative' | 'balanced' | 'aggressive'
   */
  function generateSuggestions(report, mode) {
    mode = MODES[mode] ? mode : 'conservative';
    var gates = MODES[mode];
    var suggestions = []
      .concat(fuelSuggestions(report.fuelTrims, gates, report.narrowband))
      .concat(sparkSuggestions(report.knock, gates))
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
