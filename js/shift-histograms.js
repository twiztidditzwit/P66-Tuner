/* P66-Tuner shift-time histograms
 *
 * Groups the PCM's measured shift times (from the 1-2 / 2-3 "shift time"
 * channels, on value change only) by shift pair and renders one small
 * histogram panel per pair, with the median marked and flared shifts
 * flagged. Plain-script P66-namespace module, no DOM, no bundler.
 *
 * SEMANTICS (do not get backwards):
 *  - Shift times come ONLY from the PCM "shift time" channels
 *    (SHIFT_T12 / SHIFT_T23 in the channel mapper). The PCM holds the last
 *    shift's measured time until the next shift of that pair, so only
 *    value *changes* count as shift observations — the reading at log
 *    start is the pre-log state, not an observed shift.
 *  - The companion "Shift Time Error" channels read a constant ~5.7 in
 *    the field logs seen so far and their encoding is not understood.
 *    They are NEVER read here and NEVER used for any verdict.
 *  - Flare information (RPM flare >= the trans flare threshold on an
 *    upshift) comes from analyzeTransmission's detected shift events,
 *    not from the time channels.
 *
 * INPUT NOTE: analyzeTransmission's report.transmission carries
 * pcmShiftDetail, but that list is truncated to 10 entries, which
 * undercounts long logs. shiftTimeHistograms(transReport) therefore
 * accepts optional (rows, mapResult): when both are given it re-derives
 * the complete PCM snapshot list straight from the SHIFT_T12/SHIFT_T23
 * channels with the same value-change algorithm documented above, and
 * falls back to report.pcmShiftDetail otherwise.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  /* ------------------------------------------------------------------
   * TUNE CONSTANTS — every threshold lives here, with its reasoning.
   * ------------------------------------------------------------------
   * HIST_BINS 8 — bins per histogram panel. Shift times cluster tightly
   *    (tenths of a second), so 8 bins resolve the spread without turning
   *    single samples into noise.
   *
   * CHANGE_EPS_SEC 0.005 — mirrors analyzeTransmission: a PCM shift-time
   *    reading only counts as a new observation when it moves by more
   *    than 0.005s.
   *
   * FLARE_LINK_SAMPLES 40 — links a flared shift event to the PCM shift-
   *    time snapshot(s) measured for it. The PCM updates the shift-time
   *    channel when it measures the shift, so the snapshot should land
   *    within ~40 samples (~5.8s at the 0.145s sample rate) of the
   *    detected shift event.
   *
   * SLOW_MEDIAN_SEC — per-pair "this is slow" median. The real log runs
   *    1-2 at ~0.68s and 2-3 at ~0.35s, so the flags sit clearly above
   *    healthy: 0.90s for 1-2 / 3-4 (about a third slower than typical,
   *    into clutch-slip territory) and 0.60s for the quicker 2-3.
   * ------------------------------------------------------------------ */
  var SHIFT_HISTOGRAM_CONSTANTS = {
    bins: 8,
    changeEpsSec: 0.005,
    flareLinkSamples: 40,
    slowMedianSec: { '1-2': 0.90, '2-3': 0.60, '3-4': 0.90 },
    pairs: ['1-2', '2-3', '3-4']
  };
  P66.SHIFT_HISTOGRAM_CONSTANTS = SHIFT_HISTOGRAM_CONSTANTS;

  var PAIRS = SHIFT_HISTOGRAM_CONSTANTS.pairs;

  /**
   * PCM shift-time snapshots from a numeric channel view.
   * Mirrors analyzeTransmission's private pcmShiftSnapshots: only value
   * changes count; the reading at log start is ignored.
   */
  function pcmShiftSnapshots(col, pair) {
    var out = [];
    if (!col) return out;
    var prev = NaN, started = false;
    for (var pi = 0; pi < col.length; pi++) {
      var v = col[pi];
      if (v !== v || v <= 0) { prev = v; started = true; continue; }
      if (started && prev === prev &&
          Math.abs(v - prev) > SHIFT_HISTOGRAM_CONSTANTS.changeEpsSec) {
        out.push({ index: pi, pair: pair, timeSec: Math.round(v * 1000) / 1000 });
      }
      prev = v; started = true;
    }
    return out;
  }

  function medianOf(sorted) {
    if (!sorted.length) return null;
    var mid = Math.floor(sorted.length / 2);
    var m = sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(m * 1000) / 1000;
  }

  /**
   * The PCM shift-time snapshot list for the report.
   * Full derivation from the raw channels when rows+mapResult are given,
   * otherwise the (possibly truncated) pcmShiftDetail from the report.
   */
  function snapshotList(transReport, rows, mapResult) {
    if (rows && mapResult && typeof P66.asTable === 'function' &&
        typeof P66.numView === 'function' && typeof P66.columnFor === 'function') {
      var t = P66.asTable(rows);
      if (t && t.rowCount > 0) {
        var c12 = P66.numView(t, P66.columnFor(mapResult, 'SHIFT_T12'));
        var c23 = P66.numView(t, P66.columnFor(mapResult, 'SHIFT_T23'));
        if (c12 || c23) {
          return pcmShiftSnapshots(c12, '1-2').concat(pcmShiftSnapshots(c23, '2-3'));
        }
      }
    }
    var det = (transReport && transReport.pcmShiftDetail) || [];
    return det.map(function (s) {
      return { index: s.index, pair: s.pair, timeSec: s.timeSec };
    });
  }

  /** Flared upshift events from the report's detected shift list. */
  function flaredUpshifts(transReport) {
    var evs = (transReport && transReport.shiftEvents) || [];
    return evs.filter(function (s) { return s.type === 'upshift' && s.flared; });
  }

  /**
   * Group the PCM shift times by shift pair (upshifts only).
   * Returns { '1-2': {pair, times, count, median, min, max, flares,
   * flaredCount, snapshots}, ... } for every pair, even when empty.
   * `flares` holds the log row indices of the flared shift events for
   * the pair; each snapshot carries a `flared` flag when it was measured
   * for a flared shift.
   */
  function shiftTimeHistograms(transReport, rows, mapResult) {
    var snaps = snapshotList(transReport, rows, mapResult);
    var flared = flaredUpshifts(transReport);
    var link = SHIFT_HISTOGRAM_CONSTANTS.flareLinkSamples;
    var hists = {};
    PAIRS.forEach(function (pair) {
      var ts = snaps.filter(function (s) { return s.pair === pair; });
      ts.sort(function (a, b) { return a.timeSec - b.timeSec; });
      var fl = flared.filter(function (s) { return (s.from + '-' + s.to) === pair; });
      ts.forEach(function (s) {
        s.flared = fl.some(function (e) {
          return typeof s.index === 'number' && typeof e.index === 'number' &&
            Math.abs(s.index - e.index) <= link;
        });
      });
      var times = ts.map(function (s) { return s.timeSec; });
      hists[pair] = {
        pair: pair,
        times: times,
        count: times.length,
        median: medianOf(times),
        min: times.length ? times[0] : null,
        max: times.length ? times[times.length - 1] : null,
        flares: fl.map(function (e) { return e.index; }),
        flaredCount: fl.length,
        snapshots: ts
      };
    });
    return hists;
  }
  P66.shiftTimeHistograms = shiftTimeHistograms;

  /**
   * Plain-English one-line caption for a pair group.
   * "1-2: 12 shifts, median 0.68s — healthy" / flags when the median is
   * slow or flares cluster.
   */
  function pairCaption(g) {
    if (!g.times.length) return 'no ' + g.pair + ' shifts logged';
    var s = g.pair + ': ' + g.count + ' shift' + (g.count === 1 ? '' : 's') +
      ', median ' + g.median.toFixed(2) + 's';
    var flags = [];
    if (g.flaredCount > 0) {
      flags.push(g.flaredCount + ' flared shift' + (g.flaredCount === 1 ? '' : 's') +
        ' (slipping?)');
    }
    if (g.median > SHIFT_HISTOGRAM_CONSTANTS.slowMedianSec[g.pair]) {
      flags.push('slow for a ' + g.pair);
    }
    return flags.length ? s + ' — ' + flags.join('; ') : s + ' — healthy';
  }
  P66.shiftPairCaption = pairCaption;

  /**
   * One-liner per pair plus an overall verdict string.
   * Returns { '1-2': ..., '2-3': ..., '3-4': ..., overall: ... }.
   */
  function shiftHealthSummary(hists) {
    var out = {};
    var anyData = false, bad = [];
    PAIRS.forEach(function (pair) {
      var g = hists && hists[pair];
      if (!g || !g.times || !g.times.length) {
        out[pair] = pair + ': no shifts logged';
        return;
      }
      anyData = true;
      out[pair] = pairCaption(g);
      if (g.flaredCount > 0 ||
          g.median > SHIFT_HISTOGRAM_CONSTANTS.slowMedianSec[pair]) {
        bad.push(pair);
      }
    });
    if (!anyData) {
      out.overall = 'No PCM shift times in this log — shift health could not be judged.';
    } else if (!bad.length) {
      out.overall = 'Shift times look healthy on every logged pair.';
    } else {
      out.overall = 'Take a look at ' + bad.join(' and ') + ' — ' +
        bad.map(function (pair) {
          var g = hists[pair];
          var why = [];
          if (g.flaredCount > 0) {
            why.push(g.flaredCount + ' flared shift' + (g.flaredCount === 1 ? '' : 's'));
          }
          if (g.median > SHIFT_HISTOGRAM_CONSTANTS.slowMedianSec[pair]) {
            why.push('median ' + g.median.toFixed(2) + 's is slow');
          }
          return pair + ': ' + why.join(', ');
        }).join('; ') + '.';
    }
    return out;
  }
  P66.shiftHealthSummary = shiftHealthSummary;

  /* ------------------------------------------------------------------
   * SVG renderer (string only — no DOM, safe under node).
   * ------------------------------------------------------------------ */
  var TEXT_COLOR = '#aeb4c0';
  var TITLE_COLOR = '#dfe3ea';
  var BAR_COLOR = '#58a6ff';
  var FLARE_COLOR = '#d29922'; // knock-amber: a bar containing a flared shift
  var MEDIAN_COLOR = '#dfe3ea';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }
  function fmt2(v) { return v.toFixed(2); }

  function emptyPanelSVG(w, h, title, message) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + escAttr(title) + '">' +
      '<text x="' + (w / 2) + '" y="' + (h / 2 - 6) +
      '" text-anchor="middle" font-size="13" fill="' + TEXT_COLOR + '">' +
      esc(message) + '</text></svg>';
  }

  function renderPanel(g, px, pw, ph) {
    var out = [];
    var title = g.pair + ' shift times';
    out.push('<text x="' + (px + pw / 2) + '" y="18" text-anchor="middle" font-size="13" fill="' +
      TITLE_COLOR + '">' + esc(title) + '</text>');

    if (!g.times.length) {
      out.push('<text x="' + (px + pw / 2) + '" y="' + (ph / 2 + 4) +
        '" text-anchor="middle" font-size="12" fill="' + TEXT_COLOR + '">' +
        esc('no ' + g.pair + ' shifts logged') + '</text>');
      return out.join('');
    }

    var padL = 34, padR = 8, padT = 30, padB = 52;
    var iw = pw - padL - padR, ih = ph - padT - padB;
    var nb = SHIFT_HISTOGRAM_CONSTANTS.bins;
    var lo = g.min, hi = g.max;
    if (hi - lo < 0.05) { // single value: give the bin something to stand on
      var mid = (hi + lo) / 2;
      lo = mid - 0.025; hi = mid + 0.025;
    }
    var bw = (hi - lo) / nb;
    var counts = [], flaredBin = [];
    for (var b = 0; b < nb; b++) { counts.push(0); flaredBin.push(false); }
    g.snapshots.forEach(function (s) {
      var bi = Math.min(nb - 1, Math.floor((s.timeSec - lo) / bw));
      counts[bi]++;
      if (s.flared) flaredBin[bi] = true;
    });
    var maxC = Math.max.apply(null, counts.concat([1]));
    function X(bi) { return px + padL + (bi / nb) * iw; }
    function Y(c) { return padT + ih - (c / maxC) * ih; }

    // baseline
    out.push('<line x1="' + (px + padL) + '" y1="' + (padT + ih) +
      '" x2="' + (px + padL + iw) + '" y2="' + (padT + ih) +
      '" stroke="#3a4150" stroke-width="1"/>');

    for (var i = 0; i < nb; i++) {
      var bx = X(i), bh = (counts[i] / maxC) * ih;
      var barW = Math.max(1.5, (iw / nb) - 3);
      out.push('<rect x="' + bx.toFixed(1) + '" y="' + Y(counts[i]).toFixed(1) +
        '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, bh).toFixed(1) +
        '" fill="' + BAR_COLOR + '" opacity="0.9"' +
        (flaredBin[i] ? ' stroke="' + FLARE_COLOR + '" stroke-width="2.5"' : '') + '/>');
    }

    // x-axis labels: min / max
    out.push('<text x="' + (px + padL) + '" y="' + (padT + ih + 14) +
      '" font-size="10" fill="' + TEXT_COLOR + '">' + fmt2(lo) + 's</text>');
    out.push('<text x="' + (px + padL + iw) + '" y="' + (padT + ih + 14) +
      '" text-anchor="end" font-size="10" fill="' + TEXT_COLOR + '">' + fmt2(hi) + 's</text>');

    // median line + label
    var mx = px + padL + ((g.median - lo) / (hi - lo)) * iw;
    out.push('<line x1="' + mx.toFixed(1) + '" y1="' + padT +
      '" x2="' + mx.toFixed(1) + '" y2="' + (padT + ih) +
      '" stroke="' + MEDIAN_COLOR + '" stroke-width="1.5" stroke-dasharray="5 3"/>');
    out.push('<text x="' + Math.min(mx + 4, px + pw - 4) + '" y="' + (padT + 12) +
      '" font-size="10" fill="' + MEDIAN_COLOR + '">median ' + fmt2(g.median) + 's</text>');

    // caption
    out.push('<text x="' + (px + pw / 2) + '" y="' + (ph - 30) +
      '" text-anchor="middle" font-size="11" fill="' + TEXT_COLOR + '">' +
      esc(pairCaption(g)) + '</text>');

    return out.join('');
  }

  /**
   * Render all pair groups as one SVG string. Friendly empty message
   * when no pair logged any shift times.
   */
  function renderShiftHistogramsSVG(hists) {
    var pw = 320, gap = 12;
    var ph = 210;
    var w = PAIRS.length * pw + (PAIRS.length - 1) * gap;
    var h = ph + 26; // room for the legend
    var title = 'Shift-time histograms';

    var anyData = PAIRS.some(function (pair) {
      var g = hists && hists[pair];
      return g && g.times && g.times.length;
    });
    if (!anyData) {
      return emptyPanelSVG(w, 120, title,
        'No PCM shift times in this log — log a few full-throttle 1-2 and 2-3 pulls ' +
        'with the shift-time channels enabled to fill these in.');
    }

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + escAttr(title) + '">');
    PAIRS.forEach(function (pair, pi) {
      var g = (hists && hists[pair]) ||
        { pair: pair, times: [], count: 0, median: null, min: null, max: null,
          flares: [], flaredCount: 0, snapshots: [] };
      out.push(renderPanel(g, pi * (pw + gap), pw, ph));
    });

    // legend
    var anyFlare = PAIRS.some(function (pair) {
      var g = hists && hists[pair];
      return g && g.snapshots && g.snapshots.some(function (s) { return s.flared; });
    });
    var legend = 'dashed line = median';
    if (anyFlare) {
      out.push('<rect x="10" y="' + (ph + 8) + '" width="14" height="10" fill="' + BAR_COLOR +
        '" stroke="' + FLARE_COLOR + '" stroke-width="2.5"/>');
      legend = 'amber outline = bar contains a flared shift · ' + legend;
    }
    out.push('<text x="' + (anyFlare ? 30 : 10) + '" y="' + (ph + 17) +
      '" font-size="11" fill="' + TEXT_COLOR + '">' + esc(legend) + '</text>');
    out.push('</svg>');
    return out.join('');
  }
  P66.renderShiftHistogramsSVG = renderShiftHistogramsSVG;

})(typeof window !== 'undefined' ? window : global);
