/* P66 sparklines — trailing traces for the playback HUD gauges.
 *
 * Companion to js/playback.js. Extracts a trailing window of display values
 * for one HUD gauge ending at the controller's current row, draws a min/max
 * autoscaled line + fill on a 2D canvas, and computes NaN-safe stats for
 * tooltips. Pure logic runs under plain node; drawSparkline no-ops when no
 * canvas/context is available.
 *
 * The parent wires one sparkline per HUD tile, e.g. on each frame:
 *   P66.drawSparkline(tileCanvas,
 *     P66.sparklineWindow(playbackCtl, gaugeIdx, 120), { color: '#6b9bff' });
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  function spFinite(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * Trailing window of display values for gaugeIdx ending at the
   * controller's current index. Uses controller.valueAt (which handles the
   * AFR conversion), clamps at row 0, and propagates NaN for missing values
   * instead of throwing. Returns [] for a missing/broken controller or a
   * non-positive window size.
   */
  function sparklineWindow(controller, gaugeIdx, windowRows) {
    if (!controller ||
        typeof controller.getIndex !== 'function' ||
        typeof controller.valueAt !== 'function') return [];
    windowRows = Math.floor(windowRows);
    if (!isFinite(windowRows) || windowRows <= 0) return [];
    var idx = controller.getIndex() | 0;
    if (idx < 0) return [];
    var start = idx - windowRows + 1;
    if (start < 0) start = 0;
    var out = new Array(idx - start + 1);
    for (var r = start, k = 0; r <= idx; r++, k++) {
      var v = controller.valueAt(gaugeIdx, r);
      out[k] = spFinite(v) ? v : NaN;
    }
    return out;
  }

  /**
   * Min/max/last of a value array, ignoring NaN. Returns nulls when there
   * are no finite values. Used for sparkline tooltips.
   */
  function sparklineStats(values) {
    var min = Infinity, max = -Infinity, last = null, any = false;
    var n = values ? values.length : 0;
    for (var i = 0; i < n; i++) {
      var v = values[i];
      if (spFinite(v)) {
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
        last = v;
      }
    }
    if (!any) return { min: null, max: null, last: null };
    return { min: min, max: max, last: last };
  }

  /**
   * Draw a sparkline: autoscaled line plus a subtle fill down to the
   * baseline, over the values array (numbers or NaN). NaN gaps break the
   * line rather than connecting across them. If all values are NaN or all
   * equal, a flat midline is drawn instead. Gracefully no-ops when the
   * canvas is missing, has no getContext, or has no drawable area — safe to
   * call under node.
   *
   * opts: { color, fillColor, lineWidth }
   */
  function drawSparkline(canvas, values, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var w = canvas.width || 0, h = canvas.height || 0;
    if (w <= 0 || h <= 0) return;
    var n = values ? values.length : 0;
    if (!n) return;
    opts = opts || {};
    var color = opts.color || '#6b9bff';
    var fillColor = opts.fillColor || 'rgba(107,155,255,0.18)';
    var lw = opts.lineWidth || 1.5;

    var min = Infinity, max = -Infinity, any = false;
    for (var i = 0; i < n; i++) {
      var v = values[i];
      if (spFinite(v)) {
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    ctx.clearRect(0, 0, w, h);
    if (!any || min === max) {
      // Flat midline: nothing (or nothing varying) to scale.
      var mid = Math.floor(h / 2) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      return;
    }

    var pad = 2;
    var span = max - min;
    var single = (n === 1);
    function xAt(j) { return single ? w / 2 : pad + (w - 2 * pad) * j / (n - 1); }
    function yAt(val) { return h - pad - ((val - min) / span) * (h - 2 * pad); }

    // Fill pass: each contiguous finite run becomes a polygon closed along
    // the baseline. Two passes keep per-segment state trivial.
    ctx.beginPath();
    var inSeg = false, lastX = 0;
    for (var j = 0; j < n; j++) {
      if (spFinite(values[j])) {
        var x = xAt(j), y = yAt(values[j]);
        if (!inSeg) { ctx.moveTo(x, h); ctx.lineTo(x, y); inSeg = true; }
        else { ctx.lineTo(x, y); }
        lastX = x;
      } else if (inSeg) {
        ctx.lineTo(lastX, h);
        ctx.closePath();
        inSeg = false;
      }
    }
    if (inSeg) { ctx.lineTo(lastX, h); ctx.closePath(); }
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Stroke pass.
    ctx.beginPath();
    inSeg = false;
    for (var k = 0; k < n; k++) {
      if (spFinite(values[k])) {
        var px = xAt(k), py = yAt(values[k]);
        if (!inSeg) { ctx.moveTo(px, py); inSeg = true; }
        else { ctx.lineTo(px, py); }
      } else {
        inSeg = false;
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  P66.sparklineWindow = sparklineWindow;
  P66.sparklineStats = sparklineStats;
  P66.drawSparkline = drawSparkline;
})(typeof window !== 'undefined' ? window : global);
