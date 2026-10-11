/* P66-Tuner log coverage coach
 * Tells the user what their log is missing BEFORE they tune from it.
 *
 * The most common real-world failure is tuning from a thin log: idle and
 * light cruise only (like a driveway warmup), no WOT, no knock channel.
 * The analyzer will happily produce suggestions from whatever it gets, so
 * this module scores the log's coverage and prescribes the drive cycle
 * that would fill the gaps. It never blocks tuning — it informs it.
 *
 *   P66.analyzeCoverage(report) -> {
 *     score: 0-100, verdict: 'excellent'|'good'|'thin'|'poor',
 *     gaps: [{ area, severity: 'info'|'warn'|'critical', detail }],
 *     driveCycle: [string],   // prescribed logging steps, priority order
 *     details: { ... }        // component scores for the curious
 *   }
 *
 * Works in browser and node. No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Scoring weights. Regions 40 / cell density 30 / channels 30.
  var W = {
    idle: 8, cruise: 12, wot: 20,
    cells: 30,
    rpm: 6, map: 6, tps: 6, kr: 6, o2: 4, ect: 2
  };

  var MIN_WOT_SAMPLES = 30;    // below this, WOT fueling is guesswork
  var MIN_CRUISE_SAMPLES = 500; // ~1 min at 8 Hz; less is a snapshot, not a trend
  var MIN_IDLE_SAMPLES = 120;
  var TARGET_GOOD_CELLS = 12;  // well-sampled fuel cells for full cell-density marks
  var MIN_CELL_SAMPLES = 20;   // a cell counts as "covered" at this many samples

  function hasChannel(report, sig) {
    return report.missingChannels.indexOf(sig) === -1;
  }

  function pushGap(gaps, area, severity, detail) {
    gaps.push({ area: area, severity: severity, detail: detail });
  }

  /**
   * Score a session report's log coverage and prescribe the drive cycle
   * that fills the gaps. Pure function — safe to call from tests.
   */
  function analyzeCoverage(report) {
    var gaps = [];
    var driveCycle = [];
    var dist = report.regionDistribution || {};
    var idleN = dist.idle || 0, cruiseN = dist.cruise || 0, wotN = dist.wot || 0;

    var score = 0;
    var details = {};

    // ---- regions (40) ----
    var regionScore = 0;
    if (idleN >= MIN_IDLE_SAMPLES) { regionScore += W.idle; }
    else {
      pushGap(gaps, 'idle', idleN > 0 ? 'info' : 'warn',
        idleN > 0
          ? 'Only ' + idleN + ' idle samples — idle fueling reads are thin.'
          : 'No idle data in this log — idle fueling cannot be evaluated.');
      driveCycle.push('Idle the car fully warm for 3 minutes (Park/Neutral, accessories off) and log it.');
    }
    if (cruiseN >= MIN_CRUISE_SAMPLES) { regionScore += W.cruise; }
    else {
      pushGap(gaps, 'cruise', 'warn',
        'Only ' + cruiseN + ' cruise samples — part-throttle fueling needs more steady driving data.');
      driveCycle.push('Drive 20+ minutes mixed: steady highway cruise plus town stop-and-go, no hard pulls.');
    }
    if (wotN >= MIN_WOT_SAMPLES) { regionScore += W.wot; }
    else {
      pushGap(gaps, 'wot', wotN > 0 ? 'warn' : 'critical',
        wotN > 0
          ? 'Only ' + wotN + ' WOT samples (need ' + MIN_WOT_SAMPLES + ') — power enrichment and WOT fueling stay conservative.'
          : 'No wide-open-throttle data at all — power enrichment, WOT fueling, and high-load knock cannot be tuned from this log.');
      driveCycle.push('Log 2–3 wide-open-throttle pulls (2nd or 3rd gear, 2000–5000 RPM), lifting where safe. This is the single most valuable data you can add.');
    }
    details.regions = regionScore;
    score += regionScore;

    // ---- cell density (30) ----
    var cellScore = 0;
    var goodCells = 0, totalCells = 0;
    if (report.fuelTrims && report.fuelTrims.available) {
      totalCells = report.fuelTrims.cellCount || 0;
      (report.fuelTrims.cells || []).forEach(function (c) {
        if (c.samples >= MIN_CELL_SAMPLES) goodCells++;
      });
      cellScore = Math.round(W.cells * Math.min(1, goodCells / TARGET_GOOD_CELLS));
      if (goodCells < TARGET_GOOD_CELLS) {
        pushGap(gaps, 'cells', goodCells < 4 ? 'warn' : 'info',
          'Only ' + goodCells + ' well-sampled fuel cell(s) across ' + totalCells +
          ' populated — more varied driving fills the table instead of a few cells.');
      }
    } else {
      pushGap(gaps, 'cells', 'warn',
        'Fuel-trim analysis unavailable (' +
        (report.fuelTrims ? report.fuelTrims.reason : 'no data') + ') — no fueling coverage to score.');
    }
    details.cellDensity = cellScore;
    details.goodCells = goodCells;
    details.totalCells = totalCells;
    score += cellScore;

    // ---- channels (30) ----
    var channelScore = 0;
    function chan(sig, weight, label, advice, severity) {
      if (hasChannel(report, sig)) { channelScore += weight; return true; }
      pushGap(gaps, 'channels', severity,
        label + ' channel missing — ' + advice);
      return false;
    }
    chan('RPM', W.rpm, 'RPM', 'nothing can be binned without it; add it to the log.', 'critical');
    chan('MAP', W.map, 'MAP', 'load binning falls back to TPS only.', 'warn');
    chan('TPS', W.tps, 'TPS', 'transient detection and WOT identification are degraded.', 'warn');
    if (!chan('KR', W.kr, 'Knock retard', 'spark suggestions are disabled without it; log Knock Retard (°).', 'warn')) {
      driveCycle.push('Enable the knock retard channel in TunerPro before the next log — without it, timing stays untouched.');
    }
    var o2ok = hasChannel(report, 'O2_B1') || hasChannel(report, 'O2_B2') || hasChannel(report, 'O2');
    if (o2ok) { channelScore += W.o2; }
    else {
      pushGap(gaps, 'channels', 'warn',
        'Narrowband O2 channel missing — trim-only fueling analysis, no O2 corroboration or WOT richness check.');
      driveCycle.push('Log narrowband O2 sensor voltage (mV), Bank 1 at minimum — it corroborates every fueling suggestion.');
    }
    if (!chan('ECT', W.ect, 'Coolant temp (ECT)', 'warmup gating is unavailable; cold-start rows are included in averages.', 'info')) {
      // no drive-cycle step needed; informational only
    }
    details.channels = channelScore;
    score += channelScore;

    score = Math.max(0, Math.min(100, score));
    var verdict = score >= 85 ? 'excellent' : score >= 60 ? 'good' : score >= 35 ? 'thin' : 'poor';

    // A critical gap (no WOT data, no RPM) caps the verdict: the number may
    // look passable, but the log cannot support the tune it implies.
    var hasCritical = gaps.some(function (g) { return g.severity === 'critical'; });
    if (hasCritical && (verdict === 'excellent' || verdict === 'good')) {
      verdict = 'thin';
      score = Math.min(score, 59);
    }

    // De-duplicate drive-cycle steps while preserving priority order.
    var seen = {};
    driveCycle = driveCycle.filter(function (s) {
      if (seen[s]) return false;
      seen[s] = true;
      return true;
    });

    return {
      score: score,
      verdict: verdict,
      gaps: gaps,
      driveCycle: driveCycle,
      details: details
    };
  }

  P66.analyzeCoverage = analyzeCoverage;
  P66.COVERAGE_WEIGHTS = W;
})(typeof window !== 'undefined' ? window : global);
