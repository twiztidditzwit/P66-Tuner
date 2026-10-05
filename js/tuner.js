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
   * Positive avg trim (lean) -> suggest adding fuel: correction = -avgTrim,
   * expressed as a VE/MAF multiplier delta in percent.
   */
  function fuelSuggestions(fuelReport, gates) {
    var out = [];
    if (!fuelReport || !fuelReport.available) return out;
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
      out.push({
        kind: 'fuel', table: 'VE/MAF', cell: cell.rpmBin + ' RPM / ' + cell.mapBin + ' kPa',
        action: delta > 0 ? 'add fuel' : 'remove fuel', deltaPct: delta,
        reason: 'Avg combined trim ' + (cell.avgTrim > 0 ? '+' : '') + cell.avgTrim +
          '% over ' + cell.samples + ' samples (stddev ' + cell.stddev + ').' +
          (capped ? ' Capped at mode limit; re-log and iterate.' : ''),
        confidence: cell.samples >= gates.minCellSamples * 2 ? 'high' : 'medium',
        samples: cell.samples
      });
    });
    return out;
  }

  /**
   * Spark suggestions from knock analysis.
   * Sustained KR in a region -> pull timing there.
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
    // Pull timing proportional to worst observed KR, capped per mode.
    var pull = round2(clamp(knockReport.maxKR, 0.5, gates.maxSparkDeltaDeg));
    var worstRegion = null, worstMax = 0;
    Object.keys(knockReport.byRegion).forEach(function (r) {
      if (knockReport.byRegion[r].maxKR > worstMax) {
        worstMax = knockReport.byRegion[r].maxKR;
        worstRegion = r;
      }
    });
    out.push({
      kind: 'spark', table: 'Spark Advance',
      cell: worstRegion ? worstRegion + ' region' : 'global',
      action: 'retard timing', deltaDeg: -pull,
      reason: knockReport.knockSamples + ' knock samples (' + knockReport.knockPct + '% of log), ' +
        'max KR ' + knockReport.maxKR + ' deg' +
        (worstRegion ? ', worst in ' + worstRegion : '') +
        '. Pull timing, re-log, and confirm KR trends down before further changes.',
      confidence: knockReport.knockSamples >= gates.minKnockSamples * 2 ? 'high' : 'medium',
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
      .concat(fuelSuggestions(report.fuelTrims, gates))
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
