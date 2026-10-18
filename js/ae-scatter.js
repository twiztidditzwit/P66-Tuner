/* P66 AE scatter — tip-in throttle-rate vs lean-depth scatter plot.
 *
 * Companion to analyzeTipIn (js/analyzer.js). The analyzer already finds
 * throttle stabs and watches the narrowband O2 for lean spikes (<250 mV);
 * this module turns the analyzer's tip-in report into a scatter dataset
 * (throttle rate %/s on x, O2 lean-dip depth mV on y), renders it as a
 * standalone SVG string, and writes a plain-English caption.
 *
 * Plain script — attaches to the global P66 namespace (browser + node
 * compatible). DOM-free: everything is pure data math and string building.
 *
 * API
 * ---
 *   P66.tipinScatterData(table, mapResult, tipinReport)
 *     -> { available, points: [{ index, dTpsDt, leanDepthMv, flagged }],
 *          thresholdMv, count, leanCount, skipped }
 *        points are in log order. eventsDetail is capped at 25 by the
 *        analyzer, so at most 25 points. tipinReport may be null — when it
 *        is, the analyzer is run directly (guarded); this is a fallback,
 *        not a re-detection of events.
 *
 *   P66.renderAeScatterSVG(data, opts) -> String
 *     SVG string: x = dTPS/dt (%/s), y = lean depth (mV dip), one dot per
 *     tip-in event. opts: { width, height, title }. With no points the SVG
 *     carries a friendly "no stabs" message instead of axes.
 *
 *   P66.aeScatterCaption(data) -> String
 *     Plain-English one-liner, e.g.
 *     "7 tip-in stabs; 2 went leaner than 250mV — deeper stabs trend leaner".
 *
 * COLOR CHOICE — deliberately NOT the fuel-trim red/blue convention:
 * this plot is not trim data, so borrowing red/blue would wrongly imply
 * "rich/lean trim" semantics. Flagged dots (lean spike crossed) use the
 * codebase's knock-warning amber #d29922 = "look here", and clean dots use
 * a neutral blue-grey #8b98b0 = "nothing alarming".
 *
 * The parent wires one call, e.g.:
 *   var tipinReport = session.tipIn;                 // P66.analyzeSession
 *   var data = P66.tipinScatterData(logTable, mapResult, tipinReport);
 *   captionEl.textContent = P66.aeScatterCaption(data);
 *   chartEl.innerHTML = P66.renderAeScatterSVG(data);
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var FLAGGED_COLOR = '#d29922'; // knock-amber: crossed the lean-spike threshold
  var PLAIN_COLOR = '#8b98b0';   // neutral blue-grey: no spike on this stab
  var AXIS_COLOR = '#c8ccd4';
  var TEXT_COLOR = '#aeb4c0';
  var TITLE_COLOR = '#dfe3ea';
  var GRID_COLOR = '#2c313b';
  var EMPTY_MSG = 'No tip-in stabs detected in this log';

  var NOMINAL_SAMPLE_SEC = 0.145; // ALDL frame rate, mirrors analyzeTipIn
  var BASELINE_SAMPLES = 5;       // pre-stab samples averaged for the O2 baseline

  function isFin(v) { return typeof v === 'number' && isFinite(v); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function plural(n, one, many) { return n === 1 ? one : many; }

  /**
   * Build the scatter dataset from the analyzer's tip-in report. Events
   * come from report.eventsDetail (the analyzer already detected them);
   * here we only measure each event's throttle rate and lean-dip depth
   * from the columnar table at the reported indices.
   */
  function tipinScatterData(table, mapResult, tipinReport) {
    var t = (P66.asTable ? P66.asTable(table) : null);
    if (!t) {
      return { available: false, reason: 'No log table.', points: [] };
    }
    var report = tipinReport;
    if (!report && typeof P66.analyzeTipIn === 'function') {
      report = P66.analyzeTipIn(t, mapResult); // fallback, not a re-detection
    }
    if (!report || report.available === false) {
      return {
        available: false,
        reason: (report && report.reason) || 'Tip-in analysis unavailable.',
        points: []
      };
    }
    var tpsName = P66.columnFor ? P66.columnFor(mapResult, 'TPS') : null;
    var o2Name = P66.columnFor ?
      (P66.columnFor(mapResult, 'O2_B1') || P66.columnFor(mapResult, 'O2')) : null;
    var tpsC = tpsName ? t.col(tpsName) : null;
    var o2C = o2Name ? t.col(o2Name) : null;
    if (!tpsC || !o2C) {
      return { available: false, reason: 'Need TPS and narrowband O2 channels.', points: [] };
    }
    var sampleSec = isFin(report.sampleSec) && report.sampleSec > 0
      ? report.sampleSec : NOMINAL_SAMPLE_SEC;
    var thresholdMv = isFin(report.leanThresholdMv) ? report.leanThresholdMv : 250;

    var events = report.eventsDetail || [];
    var points = [];
    var skipped = 0;
    for (var k = 0; k < events.length; k++) {
      var e = events[k];
      var i = e.index;
      if (!isFin(i) || i < 1 || i >= t.rowCount) { skipped++; continue; }
      // Throttle rate: the single-step TPS delta at the stab over the
      // sample interval, in %/s.
      var now = tpsC[i], prev = tpsC[i - 1];
      if (now !== now || prev !== prev) { skipped++; continue; }
      var dTpsDt = round1((now - prev) / sampleSec);
      // Lean depth: pre-stab O2 baseline minus the analyzer's window-min O2.
      // AE working well drives the sensor RICH (high mV) on tip-in, so a
      // negative dip is clamped to 0 — there was no lean dip at all.
      var base = o2Baseline(o2C, i);
      var minO2 = e.minO2;
      if (!isFin(base) || !isFin(minO2)) { skipped++; continue; }
      var depth = Math.max(0, Math.round(base - minO2));
      var flagged = e.leanSpike === true || (isFin(minO2) && minO2 < thresholdMv);
      points.push({ index: i, dTpsDt: dTpsDt, leanDepthMv: depth, flagged: flagged });
    }
    return {
      available: true,
      points: points,
      thresholdMv: thresholdMv,
      count: points.length,
      leanCount: points.filter(function (p) { return p.flagged; }).length,
      skipped: skipped
    };
  }

  function o2Baseline(o2C, idx) {
    var s = 0, n = 0;
    var start = Math.max(0, idx - BASELINE_SAMPLES);
    for (var j = start; j < idx; j++) {
      var v = o2C[j];
      if (v === v) { s += v; n++; }
    }
    return n ? s / n : NaN;
  }

  /**
   * Pearson correlation sign between throttle rate and lean depth, used
   * for the caption trend. Returns null when there is nothing to correlate
   * (<2 points or zero variance).
   */
  function scatterTrend(points) {
    if (points.length < 2) return null;
    var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    for (var k = 0; k < points.length; k++) {
      var x = points[k].dTpsDt, y = points[k].leanDepthMv;
      if (!isFin(x) || !isFin(y)) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < 2) return null;
    var denom = (n * sxx - sx * sx) * (n * syy - sy * sy);
    if (denom <= 0) return null;
    return (n * sxy - sx * sy) / Math.sqrt(denom);
  }

  /**
   * Plain-English caption: event count, how many crossed the lean-spike
   * threshold, and the rate-vs-depth trend.
   */
  function aeScatterCaption(data) {
    var pts = (data && data.points) || [];
    if (!pts.length) return 'No tip-in stabs detected in this log — AE could not be tested.';
    var n = pts.length;
    var thr = (data && isFin(data.thresholdMv)) ? Math.round(data.thresholdMv) : 250;
    var lean = pts.filter(function (p) { return p.flagged; }).length;
    var s = n + ' ' + plural(n, 'tip-in stab', 'tip-in stabs') + '; ' +
      lean + ' went leaner than ' + thr + 'mV';
    var r = scatterTrend(pts);
    if (r === null) {
      s += ' — too few stabs to judge a trend';
    } else if (r >= 0.3) {
      s += ' — deeper stabs trend leaner';
    } else if (r <= -0.3) {
      s += ' — gentler stabs trend leaner';
    } else {
      s += ' — no clear link between stab rate and lean dip';
    }
    return s;
  }

  /**
   * Render the scatter dataset as an SVG string. x = throttle rate (%/s),
   * y = lean depth (mV dip); flagged dots (lean spike crossed) in
   * knock-amber, clean dots in neutral blue-grey (see COLOR CHOICE above).
   */
  function renderAeScatterSVG(data, opts) {
    opts = opts || {};
    var w = isFin(opts.width) && opts.width > 0 ? Math.round(opts.width) : 440;
    var h = isFin(opts.height) && opts.height > 0 ? Math.round(opts.height) : 320;
    var pts = (data && data.points) || [];
    var title = opts.title || 'Tip-in throttle rate vs lean dip';

    function svgOpen() {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
        '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + escAttr(title) + '">';
    }
    if (!pts.length) {
      return svgOpen() +
        '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="none"/>' +
        '<text x="' + (w / 2) + '" y="' + (h / 2 - 6) +
        '" text-anchor="middle" font-size="14" fill="' + TEXT_COLOR + '">' +
        esc(EMPTY_MSG) + '</text>' +
        '<text x="' + (w / 2) + '" y="' + (h / 2 + 16) +
        '" text-anchor="middle" font-size="12" fill="' + TEXT_COLOR + '">' +
        esc('Stab the throttle a few times in a future log to test AE.') + '</text>' +
        '</svg>';
    }

    var padL = 58, padR = 16, padT = 34, padB = 44;
    var iw = w - padL - padR, ih = h - padT - padB;
    var xMax = 0, yMax = 0, i, p;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (isFin(p.dTpsDt) && p.dTpsDt > xMax) xMax = p.dTpsDt;
      if (isFin(p.leanDepthMv) && p.leanDepthMv > yMax) yMax = p.leanDepthMv;
    }
    xMax = Math.max(10, xMax * 1.15);
    yMax = Math.max(50, yMax * 1.15);

    function xAt(v) { return padL + (v / xMax) * iw; }
    function yAt(v) { return padT + ih - (v / yMax) * ih; }

    var out = [svgOpen()];
    out.push('<text x="' + (w / 2) + '" y="18" text-anchor="middle" font-size="14" fill="' +
      TITLE_COLOR + '">' + esc(title) + '</text>');
    // grid + ticks
    out.push(gridTicks(4, xMax, 'x', xAt, yAt, padL, padT, iw, ih));
    out.push(gridTicks(4, yMax, 'y', xAt, yAt, padL, padT, iw, ih));
    // axes
    out.push('<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (padL + iw) +
      '" y2="' + (padT + ih) + '" stroke="' + AXIS_COLOR + '"/>');
    out.push('<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' +
      (padT + ih) + '" stroke="' + AXIS_COLOR + '"/>');
    // axis labels with units
    out.push('<text x="' + (padL + iw / 2) + '" y="' + (h - 8) +
      '" text-anchor="middle" font-size="12" fill="' + TEXT_COLOR + '">' +
      esc('throttle rate (%/s)') + '</text>');
    out.push('<text x="14" y="' + (padT + ih / 2) + '" text-anchor="middle" font-size="12" fill="' +
      TEXT_COLOR + '" transform="rotate(-90 14 ' + (padT + ih / 2) + ')">' +
      esc('lean depth (mV dip)') + '</text>');
    // dots: flagged (lean spike) in knock-amber, clean in neutral blue-grey
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (!isFin(p.dTpsDt) || !isFin(p.leanDepthMv)) continue;
      var color = p.flagged ? FLAGGED_COLOR : PLAIN_COLOR;
      out.push('<circle cx="' + fmt(xAt(p.dTpsDt)) + '" cy="' + fmt(yAt(p.leanDepthMv)) +
        '" r="' + (p.flagged ? 5.5 : 4.5) + '" fill="' + color + '" fill-opacity="0.9">' +
        '<title>stab @row ' + p.index + ': ' + p.dTpsDt + ' %/s, ' +
        p.leanDepthMv + ' mV dip' + (p.flagged ? ' — lean spike' : '') + '</title></circle>');
    }
    // legend
    var lx = padL + 8, ly = padT + 8;
    out.push('<circle cx="' + lx + '" cy="' + ly + '" r="4.5" fill="' + FLAGGED_COLOR + '"/>');
    out.push('<text x="' + (lx + 10) + '" y="' + (ly + 4) + '" font-size="11" fill="' +
      TEXT_COLOR + '">' + esc('lean spike') + '</text>');
    out.push('<circle cx="' + (lx + 92) + '" cy="' + ly + '" r="4.5" fill="' + PLAIN_COLOR + '"/>');
    out.push('<text x="' + (lx + 102) + '" y="' + (ly + 4) + '" font-size="11" fill="' +
      TEXT_COLOR + '">' + esc('no spike') + '</text>');
    out.push('</svg>');
    return out.join('');
  }

  function gridTicks(count, max, axis, xAt, yAt, padL, padT, iw, ih) {
    var parts = [];
    for (var k = 1; k <= count; k++) {
      var v = max * k / count;
      var label = v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
      if (axis === 'x') {
        var x = xAt(v);
        parts.push('<line x1="' + fmt(x) + '" y1="' + padT + '" x2="' + fmt(x) +
          '" y2="' + (padT + ih) + '" stroke="' + GRID_COLOR + '"/>');
        parts.push('<text x="' + fmt(x) + '" y="' + (padT + ih + 16) +
          '" text-anchor="middle" font-size="10" fill="' + TEXT_COLOR + '">' + label + '</text>');
      } else {
        var y = yAt(v);
        parts.push('<line x1="' + padL + '" y1="' + fmt(y) + '" x2="' + (padL + iw) +
          '" y2="' + fmt(y) + '" stroke="' + GRID_COLOR + '"/>');
        parts.push('<text x="' + (padL - 8) + '" y="' + fmt(y + 3.5) +
          '" text-anchor="end" font-size="10" fill="' + TEXT_COLOR + '">' + label + '</text>');
      }
    }
    return parts.join('');
  }

  function fmt(v) { return String(Math.round(v * 100) / 100); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  P66.tipinScatterData = tipinScatterData;
  P66.renderAeScatterSVG = renderAeScatterSVG;
  P66.aeScatterCaption = aeScatterCaption;

})(typeof global !== 'undefined' ? global : this);
