/* P66 strip charts — TunerPro history-table style multi-lane chart.
 *
 * Renders one horizontal lane per channel sharing a single time axis,
 * synchronized with the playback controller from js/playback.js: a playhead
 * line follows controller.onFrame, and click/drag on any lane seeks the
 * controller. Channels resolve via P66.columnFor; channels with no mapped
 * column render a graceful "unmapped" lane.
 *
 * Pure helpers (downsample, x<->index mapping, lane scaling, lane stats,
 * trim colors) run under plain node and are covered by
 * tools/stripcharts-test.js. DOM rendering is guarded by
 * `typeof document === 'undefined'`.
 *
 * Usage (browser):
 *   P66.renderStripCharts(document.getElementById('stripcharts'), ctl,
 *                         { mapResult: mapResult });
 * NOTE: createPlaybackController does NOT expose mapResult, so pass it in
 * opts.mapResult (or as controller.mapResult) for channel resolution.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var SC_DEFAULT_CHANNELS = ['RPM', 'MAP', 'TPS', 'O2_B1', 'O2_B2', 'KR'];
  var SC_DEFAULT_MAX_POINTS = 2000; // per-lane cap
  var SC_DEFAULT_LANE_H = 64;       // px per lane canvas (opts.height)

  // Distinct lane colors, dark-theme friendly.
  var SC_PALETTE = [
    '#58a6ff', '#3fb950', '#ff9f43', '#9d7bff', '#f778ba',
    '#ffd60a', '#4cc9f0', '#e0574f', '#7ee787', '#ffa657'
  ];

  // Fuel-trim convention: blue = adding fuel / lean, red = removing fuel / rich.
  // Matches the playback HUD's 128 rule (pbValueColor in js/playback.js):
  // trim counts below 128 (rich) render red, above 128 (lean) render blue.
  var SC_TRIM_SIGNALS = { STFT_B1: 1, STFT_B2: 1, STFT: 1, LTFT_B1: 1, LTFT_B2: 1, LTFT: 1 };
  var SC_RED = '#ff5a5a';
  var SC_BLUE = '#6b9bff';
  var SC_NEUTRAL = '#9fa9b8';
  var SC_GRID = 'rgba(159,169,184,0.14)';
  var SC_AXIS_H = 22; // px

  var SC_UNITS = {
    RPM: 'rpm', MAP: 'kPa', TPS: '%', O2_B1: 'mV', O2_B2: 'mV', KR: '°',
    VSS: 'mph', ECT: '°F', IAT: '°F', SPARK_ADV: '°', INJ_DC: '%',
    IAC: 'steps', CMD_LAMBDA: 'AFR', INJ_PW: 'ms', BARO: 'kPa', MAF: 'g/s'
  };

  // ---------------------------------------------------------------- pure ---

  function scNum(v) {
    var n = (typeof v === 'number') ? v : parseFloat(v);
    return isFinite(n) ? n : NaN;
  }

  /**
   * Downsample a value array to at most maxPoints points, keeping spikes.
   * Each bucket contributes its min and max (in index order), so a spike
   * inside a bucket always survives. Returns [{ i: rowIndex, v: value }]
   * sorted by row index. Non-finite values are dropped.
   */
  function stripDownsample(values, maxPoints) {
    var n = values ? values.length : 0;
    maxPoints = Math.max(2, (maxPoints | 0) || 0);
    var out = [];
    if (!n) return out;
    var i, v;
    if (n <= maxPoints) {
      for (i = 0; i < n; i++) {
        v = scNum(values[i]);
        if (isFinite(v)) out.push({ i: i, v: v });
      }
      return out;
    }
    var buckets = Math.max(1, Math.floor(maxPoints / 2));
    var size = Math.ceil(n / buckets);
    for (var b = 0; b * size < n; b++) {
      var s = b * size, e = Math.min(n, s + size);
      var mn = Infinity, mx = -Infinity, mni = -1, mxi = -1;
      for (var k = s; k < e; k++) {
        v = scNum(values[k]);
        if (!isFinite(v)) continue;
        if (v < mn) { mn = v; mni = k; }
        if (v > mx) { mx = v; mxi = k; }
      }
      if (mni < 0) continue; // bucket had no finite values
      if (mni <= mxi) {
        out.push({ i: mni, v: mn });
        if (mxi !== mni) out.push({ i: mxi, v: mx });
      } else {
        out.push({ i: mxi, v: mx });
        out.push({ i: mni, v: mn });
      }
    }
    return out;
  }

  /**
   * x pixel (CSS px, within the plot area) -> row index, clamped.
   */
  function stripXToIndex(x, plotW, rowCount) {
    if (!(rowCount > 1) || !(plotW > 0)) return 0;
    if (x <= 0) return 0;
    if (x >= plotW) return rowCount - 1;
    return Math.round((x / plotW) * (rowCount - 1));
  }

  /**
   * row index -> x pixel (CSS px, within the plot area).
   */
  function stripIndexToX(idx, plotW, rowCount) {
    if (!(rowCount > 1) || !(plotW > 0)) return 0;
    return (idx / (rowCount - 1)) * plotW;
  }

  /**
   * Value -> y pixel within a lane of height laneH (0 = top of lane).
   * Returns null for non-finite values so the drawer can break the path.
   */
  function stripY(v, min, max, laneH) {
    var n = scNum(v);
    if (!isFinite(n)) return null;
    var pad = 4;
    if (!(max > min)) return laneH / 2;
    var t = (n - min) / (max - min);
    return (laneH - pad) - t * (laneH - pad * 2);
  }

  /**
   * Min/max over an array of values, ignoring non-finite entries.
   * Returns null when nothing finite is present. Flat ranges are padded
   * so the lane still draws a centered line.
   */
  function stripLaneStats(values) {
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < (values ? values.length : 0); i++) {
      var v = scNum(values[i]);
      if (!isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) return null;
    if (mx === mn) {
      var pad = Math.abs(mx) * 0.05 || 1;
      return { min: mn - pad, max: mx + pad };
    }
    var span = (mx - mn) * 0.06;
    return { min: mn - span, max: mx + span };
  }

  /**
   * Lane color rule for fuel-trim channels: blue = adding fuel / lean
   * (above 128), red = removing fuel / rich (below 128), neutral at 128.
   */
  function stripTrimColor(v) {
    var n = scNum(v);
    if (!isFinite(n)) return SC_NEUTRAL;
    if (n < 128) return SC_RED;
    if (n > 128) return SC_BLUE;
    return SC_NEUTRAL;
  }

  function stripIsTrim(signal) {
    return !!SC_TRIM_SIGNALS[signal];
  }

  /**
   * Resolve channel signals to log columns. Channels without a column get
   * column: null and render as graceful "unmapped" lanes.
   */
  function stripResolveLanes(channels, mapResult) {
    return (channels || []).map(function (sig) {
      var col = (mapResult && P66.columnFor) ? P66.columnFor(mapResult, sig) : null;
      return { signal: sig, column: col };
    });
  }

  /**
   * Compact number formatting for min/max lane labels.
   */
  function scFmtNum(v) {
    var n = scNum(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a !== 0 && (a >= 10000 || a < 0.01)) return n.toExponential(1);
    if (a >= 100) return n.toFixed(0);
    if (a >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function scDecimals(controller, signal) {
    if (controller && controller.gauges) {
      for (var i = 0; i < controller.gauges.length; i++) {
        if (controller.gauges[i].signal === signal) return controller.gauges[i].decimals;
      }
    }
    return 1;
  }

  // ---------------------------------------------------------------- DOM ----

  function scSizeCanvas(cv, cssW, cssH) {
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    cssW = Math.max(1, Math.round(cssW));
    cssH = Math.max(1, Math.round(cssH));
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function scDrawLane(ctx, lane, rowCount, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = SC_GRID;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    if (!lane.column) {
      ctx.fillStyle = 'rgba(159,169,184,0.55)';
      ctx.fillText('unmapped — no log column for ' + lane.signal, 8, h / 2 + 3);
      return;
    }
    var pts = lane.pts;
    if (!pts.length) {
      ctx.fillStyle = 'rgba(159,169,184,0.55)';
      ctx.fillText('no data', 8, h / 2 + 3);
      return;
    }
    var i, x, y;
    if (lane.isTrim) {
      // Per-segment colors under the 128 fuel-trim rule.
      ctx.lineWidth = 1.2;
      for (i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        var ya = stripY(a.v, lane.min, lane.max, h);
        var yb = stripY(b.v, lane.min, lane.max, h);
        if (ya === null || yb === null) continue;
        ctx.strokeStyle = stripTrimColor(a.v);
        ctx.beginPath();
        ctx.moveTo(stripIndexToX(a.i, w, rowCount), ya);
        ctx.lineTo(stripIndexToX(b.i, w, rowCount), yb);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = lane.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      var started = false;
      for (i = 0; i < pts.length; i++) {
        x = stripIndexToX(pts[i].i, w, rowCount);
        y = stripY(pts[i].v, lane.min, lane.max, h);
        if (y === null) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = SC_NEUTRAL;
    ctx.fillText(scFmtNum(lane.max), 4, 10);
    ctx.fillText(scFmtNum(lane.min), 4, h - 4);
  }

  function scDrawAxis(ctx, controller, rowCount, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = SC_NEUTRAL;
    ctx.strokeStyle = SC_GRID;
    var times = controller.times || [];
    var indexed = !!controller.indexed;
    var ticks = 6, k;
    for (k = 0; k < ticks; k++) {
      var frac = ticks === 1 ? 0 : k / (ticks - 1);
      var idx = Math.round(frac * (rowCount - 1));
      var x = stripIndexToX(idx, w, rowCount);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, 5);
      ctx.stroke();
      var label = indexed ? 'row ' + idx : scFmtNum(times[idx]) + 's';
      var tw = ctx.measureText(label).width;
      var lx = Math.min(Math.max(x - tw / 2, 0), Math.max(0, w - tw));
      ctx.fillText(label, lx, 16);
    }
  }

  /**
   * Render the strip chart into container, synced to a playback controller.
   * Returns a stop() function. Re-rendering the same container stops the
   * previous instance first.
   *
   * opts: { channels, height, maxPoints, mapResult }
   *   channels  — signal names, default ['RPM','MAP','TPS','O2_B1','O2_B2','KR']
   *   height    — px per lane canvas, default 64
   *   maxPoints — per-lane downsample cap, default 2000
   *   mapResult — P66.mapChannels() result (the controller doesn't carry it)
   */
  function renderStripCharts(container, controller, opts) {
    if (typeof document === 'undefined') return null;
    if (!container || !controller) return null;
    opts = opts || {};

    if (container._scStop) {
      try { container._scStop(); } catch (e) { /* ignore */ }
      container._scStop = null;
    }
    container.innerHTML = '';

    var channels = opts.channels || SC_DEFAULT_CHANNELS;
    var maxPoints = opts.maxPoints || SC_DEFAULT_MAX_POINTS;
    var laneH = opts.height || SC_DEFAULT_LANE_H;
    var mapResult = opts.mapResult || controller.mapResult || null;
    var rows = controller.rows || [];
    var n = rows.length;
    if (!n) {
      container.innerHTML = '<p class="muted">No log rows to chart.</p>';
      return null;
    }

    // Resolve + extract + downsample each lane (pure, no DOM).
    var lanes = stripResolveLanes(channels, mapResult).map(function (rl, i) {
      var vals = new Array(n);
      for (var r = 0; r < n; r++) {
        vals[r] = rl.column ? rows[r][rl.column] : NaN;
      }
      var st = stripLaneStats(vals);
      return {
        signal: rl.signal,
        column: rl.column,
        color: SC_PALETTE[i % SC_PALETTE.length],
        isTrim: stripIsTrim(rl.signal),
        decimals: scDecimals(controller, rl.signal),
        unit: SC_UNITS[rl.signal] || '',
        min: st ? st.min : 0,
        max: st ? st.max : 1,
        pts: stripDownsample(vals, maxPoints)
      };
    });

    // ---- DOM ----
    var wrap = document.createElement('div');
    wrap.className = 'sc-wrap';

    var head = document.createElement('div');
    head.className = 'sc-head';
    var title = document.createElement('span');
    title.className = 'sc-title';
    title.textContent = 'Strip charts';
    var range = document.createElement('span');
    range.className = 'sc-range muted';
    head.appendChild(title);
    head.appendChild(range);
    wrap.appendChild(head);

    var lanesEl = document.createElement('div');
    lanesEl.className = 'sc-lanes';
    wrap.appendChild(lanesEl);

    function scClock(idx) {
      if (controller.indexed) return 'row ' + idx + ' / ' + n;
      var t = controller.times ? controller.times[idx] : NaN;
      var tMax = controller.tMax;
      return scFmtNum(t) + 's / ' + scFmtNum(tMax) + 's';
    }

    var laneViews = lanes.map(function (lane) {
      var row = document.createElement('div');
      row.className = 'sc-lane';

      var lab = document.createElement('div');
      lab.className = 'sc-lab';
      var nameEl = document.createElement('div');
      nameEl.className = 'sc-lab-name';
      nameEl.textContent = lane.signal;
      nameEl.style.color = lane.isTrim ? SC_NEUTRAL : lane.color;
      var valEl = document.createElement('div');
      valEl.className = 'sc-lab-val';
      valEl.textContent = '—';
      if (!lane.isTrim) valEl.style.color = lane.color;
      var unitEl = document.createElement('div');
      unitEl.className = 'sc-lab-unit muted';
      unitEl.textContent = lane.unit;
      lab.appendChild(nameEl);
      lab.appendChild(valEl);
      lab.appendChild(unitEl);

      var plot = document.createElement('div');
      plot.className = 'sc-plot';
      var cv = document.createElement('canvas');
      cv.className = 'sc-canvas';
      cv.setAttribute('aria-label', lane.signal + ' strip chart');
      plot.appendChild(cv);

      row.appendChild(lab);
      row.appendChild(plot);
      lanesEl.appendChild(row);
      return { lane: lane, plot: plot, canvas: cv, valEl: valEl };
    });

    var playhead = document.createElement('div');
    playhead.className = 'sc-playhead';
    playhead.style.display = 'none';
    lanesEl.appendChild(playhead);

    // Shared time axis, aligned under the plots.
    var axisRow = document.createElement('div');
    axisRow.className = 'sc-lane sc-axisrow';
    var axisSpacer = document.createElement('div');
    axisSpacer.className = 'sc-lab';
    var axisPlot = document.createElement('div');
    axisPlot.className = 'sc-plot';
    var axisCv = document.createElement('canvas');
    axisCv.className = 'sc-axis-cv';
    axisPlot.appendChild(axisCv);
    axisRow.appendChild(axisSpacer);
    axisRow.appendChild(axisPlot);
    wrap.appendChild(axisRow);

    container.appendChild(wrap);

    // ---- drawing ----
    function drawAll() {
      for (var i = 0; i < laneViews.length; i++) {
        var lv = laneViews[i];
        var w = lv.plot.clientWidth;
        if (w < 10) continue;
        var ctx = scSizeCanvas(lv.canvas, w, laneH);
        scDrawLane(ctx, lv.lane, n, w, laneH);
      }
      var aw = axisPlot.clientWidth;
      if (aw >= 10) {
        var actx = scSizeCanvas(axisCv, aw, SC_AXIS_H);
        scDrawAxis(actx, controller, n, aw, SC_AXIS_H);
      }
    }

    function paint(idx) {
      // Playhead: position over the plot column of the lanes area.
      var lrect = lanesEl.getBoundingClientRect();
      var prect = laneViews.length ? laneViews[0].plot.getBoundingClientRect() : null;
      if (prect && prect.width > 0) {
        var x = stripIndexToX(idx, prect.width, n);
        playhead.style.display = '';
        playhead.style.left = (prect.left - lrect.left + x) + 'px';
      }
      for (var i = 0; i < laneViews.length; i++) {
        var lv = laneViews[i];
        if (!lv.lane.column) { lv.valEl.textContent = 'unmapped'; continue; }
        var raw = rows[idx][lv.lane.column];
        var v = scNum(raw);
        lv.valEl.textContent = isFinite(v) ? v.toFixed(lv.lane.decimals) : '—';
        if (lv.lane.isTrim) lv.valEl.style.color = stripTrimColor(v);
      }
      range.textContent = scClock(idx);
    }

    // ---- sync + seek ----
    var unsub = controller.onFrame(function (idx) { paint(idx); });

    var seeking = false;
    function seekFromEvent(e, plot) {
      var rect = plot.getBoundingClientRect();
      if (rect.width <= 0) return;
      var x = e.clientX - rect.left;
      controller.seek(stripXToIndex(x, rect.width, n));
    }
    laneViews.forEach(function (lv) {
      var cv = lv.canvas;
      cv.addEventListener('pointerdown', function (e) {
        seeking = true;
        if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} }
        seekFromEvent(e, lv.plot);
      });
      cv.addEventListener('pointermove', function (e) {
        if (seeking) seekFromEvent(e, lv.plot);
      });
      cv.addEventListener('pointerup', function () { seeking = false; });
      cv.addEventListener('pointercancel', function () { seeking = false; });
    });

    var rafPending = false;
    function onResize() {
      if (rafPending) return;
      rafPending = true;
      var raf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame : function (fn) { return setTimeout(fn, 50); };
      raf(function () {
        rafPending = false;
        drawAll();
        paint(controller.getIndex());
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
    }

    drawAll();
    paint(controller.getIndex());
    // Catch late layout (container attached after render).
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(function () { drawAll(); paint(controller.getIndex()); });
    }

    function stop() {
      unsub();
      seeking = false;
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', onResize);
      }
    }
    container._scStop = stop;
    return stop;
  }

  P66.SC_DEFAULT_CHANNELS = SC_DEFAULT_CHANNELS;
  P66.stripDownsample = stripDownsample;
  P66.stripXToIndex = stripXToIndex;
  P66.stripIndexToX = stripIndexToX;
  P66.stripY = stripY;
  P66.stripLaneStats = stripLaneStats;
  P66.stripTrimColor = stripTrimColor;
  P66.stripIsTrim = stripIsTrim;
  P66.stripResolveLanes = stripResolveLanes;
  P66.scFmtNum = scFmtNum;
  P66.renderStripCharts = renderStripCharts;
})(typeof window !== 'undefined' ? window : global);
