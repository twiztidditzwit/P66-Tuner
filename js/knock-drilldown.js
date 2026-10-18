/* P66 knock event drill-down.
 *
 * Companion to js/playback-events.js (event ticks) and js/analyzer.js
 * (analyzeKnock). Extracts a raw ±halfWidth sample window around one knock
 * event's sample index and renders a compact multi-series SVG strip chart
 * (RPM / MAP / KR / spark / TPS, one panel per channel) with the event
 * sample marked by a vertical line.
 *
 * Pure logic runs under plain node (no document at import; the renderer
 * builds an HTML string, never touches the DOM).
 *
 * Usage (browser — see the wiring snippet at the bottom of this file):
 *   var win = P66.knockEventWindow(logTable, mapResult, tick.index, 50,
 *                                  (report.knock && report.knock.krScale) || 1);
 *   modalBody.innerHTML = P66.renderKnockDrilldownHTML(win);
 *
 * P66.knockEventWindow(table, mapResult, eventIdx, halfWidth, krScale):
 *   table      a log table (P66.asTable normalizes; legacy row arrays ok)
 *   mapResult  channel-mapper result ({ mapping: { SIGNAL: { column } } })
 *   eventIdx   sample index to center the window on — for ticks this is the
 *              analyzer event's startIdx (see knockEventsOf in
 *              js/playback-events.js)
 *   halfWidth  samples on each side (default 50); clamped at table bounds
 *   krScale    optional KR unit scale to degrees. analyzeKnock reports
 *              krScale (1, or 0.175781 when the KR column held raw ALDL
 *              counts); pass it through so the window's KR series and peak
 *              match the analyzer. Defaults to 1.
 * Returns:
 *   { ok, rpm, map, kr, spark, tps, indices, startIdx, endIdx,
 *     eventIdx, eventPos, peakKR, peakIdx, peakRpm, peakMap,
 *     krScale, halfWidth, missing, rowCount, channels, reason }
 *   - rpm/map/kr/spark/tps: plain arrays parallel to indices, raw log
 *     values (KR scaled to degrees); NaN where the cell was missing.
 *     null when the channel is not mapped.
 *   - indices: global row indices of the window (plain array).
 *   - eventPos: position of eventIdx inside the series arrays.
 *   - peakKR/peakIdx: max scaled KR and its global row index; peakRpm/
 *     peakMap are the RPM/MAP at that sample (null when unmapped).
 *   - missing: signal names with no mapped column (e.g. ['KR']).
 *   - channels: per-panel metadata { signal, key, label, unit, decimals,
 *     color, mapped, eventValue, min, max } for the renderer.
 *   - ok:false + reason when the table is empty or eventIdx is bad.
 *
 * P66.renderKnockDrilldownHTML(win): compact HTML string — title (marks the
 * peak KR), one-line summary, hand-rolled SVG strip chart with the event
 * sample as a dashed vertical marker, and "X channel not mapped" notes for
 * unmapped channels.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var KD_DEFAULT_HALFWIDTH = 50;

  var KD_CHANNELS = [
    { signal: 'RPM',       key: 'rpm',   label: 'RPM',   unit: 'rpm', decimals: 0, color: '#58a6ff' },
    { signal: 'MAP',       key: 'map',   label: 'MAP',   unit: 'kPa', decimals: 1, color: '#3fb950' },
    { signal: 'KR',        key: 'kr',    label: 'KR',    unit: '°',   decimals: 2, color: '#ffd60a' },
    { signal: 'SPARK_ADV', key: 'spark', label: 'Spark', unit: '°',   decimals: 2, color: '#ff9f43' },
    { signal: 'TPS',       key: 'tps',   label: 'TPS',   unit: '%',   decimals: 1, color: '#9d7bff' }
  ];

  // --- SVG geometry (dark-theme friendly, matches js/stripcharts.js) ---
  var KD_W = 560, KD_PAD_L = 104, KD_PAD_R = 48, KD_PANEL_H = 46,
      KD_GAP = 12, KD_TOP = 6, KD_AXIS_H = 18;
  var KD_GRID = 'rgba(159,169,184,0.14)';
  var KD_TEXT = '#9aa4b2';
  var KD_MARKER = '#eef1f6';
  var KD_FONT = '10px system-ui, -apple-system, sans-serif';

  function kdFinite(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function kdColName(mapResult, signal) {
    if (typeof P66.columnFor !== 'function') return null;
    return P66.columnFor(mapResult, signal);
  }

  // Forgiving numeric column view: numView parses string-channel cells the
  // way the old per-cell parser did; falls back to the strict col().
  function kdColumn(t, name) {
    if (typeof P66.numView === 'function') return P66.numView(t, name);
    return (typeof t.col === 'function') ? t.col(name) : null;
  }

  // Extract one raw series over [start, start+len); NaN where missing.
  function kdSeries(t, colName, len, start, scale) {
    if (!colName) return null;
    var col = kdColumn(t, colName);
    if (!col) return null;
    var out = new Array(len);
    for (var j = 0; j < len; j++) {
      var v = col[start + j];
      out[j] = kdFinite(v) ? v * scale : NaN;
    }
    return out;
  }

  function kdStats(series) {
    var min = Infinity, max = -Infinity, any = false;
    for (var j = 0; j < series.length; j++) {
      var v = series[j];
      if (kdFinite(v)) {
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return any ? { min: min, max: max } : null;
  }

  function knockEventWindow(table, mapResult, eventIdx, halfWidth, krScale) {
    var t = (typeof P66.asTable === 'function') ? P66.asTable(table) : table;
    var n = t ? t.rowCount : 0;
    var win = {
      ok: false, reason: null,
      rpm: null, map: null, kr: null, spark: null, tps: null, indices: null,
      startIdx: -1, endIdx: -1, eventIdx: -1, eventPos: -1,
      peakKR: null, peakIdx: -1, peakRpm: null, peakMap: null,
      krScale: 1, halfWidth: KD_DEFAULT_HALFWIDTH, missing: [],
      rowCount: n, channels: []
    };
    if (!t || !n) { win.reason = 'empty log table'; return win; }
    var idx = Math.round(Number(eventIdx));
    if (!isFinite(idx)) { win.reason = 'eventIdx is not a number'; return win; }
    idx = Math.max(0, Math.min(n - 1, idx));
    var hw = (halfWidth === undefined || halfWidth === null)
      ? KD_DEFAULT_HALFWIDTH : Math.floor(Number(halfWidth));
    if (!isFinite(hw) || hw < 0) hw = KD_DEFAULT_HALFWIDTH;
    var scale = (krScale === undefined || krScale === null) ? 1 : Number(krScale);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    var start = Math.max(0, idx - hw);
    var end = Math.min(n - 1, idx + hw);
    var len = end - start + 1;
    var indices = new Array(len);
    for (var j = 0; j < len; j++) indices[j] = start + j;

    var series = {};
    var missing = [];
    KD_CHANNELS.forEach(function (c) {
      var colName = kdColName(mapResult, c.signal);
      var s = colName ? kdSeries(t, colName, len, start, c.signal === 'KR' ? scale : 1) : null;
      series[c.key] = s;
      if (!s) missing.push(c.signal);
    });

    // Peak KR (scaled degrees) and its global position.
    var peakKR = null, peakPos = -1;
    if (series.kr) {
      for (var k = 0; k < len; k++) {
        var kv = series.kr[k];
        if (kdFinite(kv) && (peakKR === null || kv > peakKR)) {
          peakKR = kv;
          peakPos = k;
        }
      }
    }

    var channels = KD_CHANNELS.map(function (c) {
      var s = series[c.key];
      var st = s ? kdStats(s) : null;
      return {
        signal: c.signal, key: c.key, label: c.label, unit: c.unit,
        decimals: c.decimals, color: c.color, mapped: !!s,
        eventValue: s ? s[idx - start] : NaN,
        min: st ? st.min : null, max: st ? st.max : null
      };
    });

    win.ok = true;
    win.rpm = series.rpm; win.map = series.map; win.kr = series.kr;
    win.spark = series.spark; win.tps = series.tps;
    win.indices = indices;
    win.startIdx = start; win.endIdx = end;
    win.eventIdx = idx; win.eventPos = idx - start;
    win.peakKR = peakKR;
    win.peakIdx = peakPos >= 0 ? start + peakPos : -1;
    win.peakRpm = (peakPos >= 0 && series.rpm) ? series.rpm[peakPos] : null;
    win.peakMap = (peakPos >= 0 && series.map) ? series.map[peakPos] : null;
    win.krScale = scale;
    win.halfWidth = hw;
    win.missing = missing;
    win.channels = channels;
    return win;
  }

  // ---------------------------------------------------------------- render
  function kdFmt(v, decimals) {
    return kdFinite(v) ? v.toFixed(decimals) : '—';
  }

  // Split a series into contiguous finite runs of [x, y] points for one panel.
  function kdRuns(series, x0, xw, y0, yh) {
    var min = Infinity, max = -Infinity, any = false, len = series.length;
    for (var i = 0; i < len; i++) {
      var v = series[i];
      if (kdFinite(v)) {
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!any) return null;
    var span = max - min;
    function X(j) { return len <= 1 ? x0 + xw / 2 : x0 + xw * j / (len - 1); }
    function Y(v) { return span === 0 ? y0 + yh / 2 : y0 + yh - yh * (v - min) / span; }
    var runs = [], cur = null;
    for (var j = 0; j < len; j++) {
      var vv = series[j];
      if (kdFinite(vv)) {
        var pt = [X(j), Y(vv)];
        if (!cur) cur = [pt];
        else cur.push(pt);
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return { runs: runs, y0: y0, yh: yh, span: span };
  }

  function kdStrokeFill(geom, color) {
    var stroke = '', fill = '';
    for (var r = 0; r < geom.runs.length; r++) {
      var run = geom.runs[r];
      var d = '';
      for (var p = 0; p < run.length; p++) {
        d += (p === 0 ? 'M' : 'L') + run[p][0].toFixed(1) + ' ' + run[p][1].toFixed(1);
      }
      stroke += d + ' ';
      var first = run[0], last = run[run.length - 1];
      fill += d + 'L' + last[0].toFixed(1) + ' ' + (geom.y0 + geom.yh).toFixed(1) +
              'L' + first[0].toFixed(1) + ' ' + (geom.y0 + geom.yh).toFixed(1) + 'Z ';
    }
    var fillColor = color;
    // Add a soft alpha fill by wrapping the color in rgba when it is hex.
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      fillColor = 'rgba(' + parseInt(color.slice(1, 3), 16) + ',' +
                  parseInt(color.slice(3, 5), 16) + ',' +
                  parseInt(color.slice(5, 7), 16) + ',0.15)';
    }
    return '<path d="' + fill + '" fill="' + fillColor + '" stroke="none"/>' +
           '<path d="' + stroke + '" fill="none" stroke="' + color +
           '" stroke-width="' + (color === '#ffd60a' ? '2' : '1.5') +
           '" stroke-linejoin="round"/>';
  }

  function kdSvg(win) {
    var x0 = KD_PAD_L, xw = KD_W - KD_PAD_L - KD_PAD_R;
    var totalH = KD_TOP + KD_CHANNELS.length * (KD_PANEL_H + KD_GAP) - KD_GAP + KD_AXIS_H;
    var len = win.indices.length;
    var out = '<svg class="p66-kd-svg" width="' + KD_W + '" height="' + totalH +
              '" viewBox="0 0 ' + KD_W + ' ' + totalH +
              '" role="img" aria-label="knock event strip chart">';

    KD_CHANNELS.forEach(function (c, i) {
      var y0 = KD_TOP + i * (KD_PANEL_H + KD_GAP);
      var ch = win.channels[i];
      // Baseline gridline.
      out += '<line x1="' + x0 + '" y1="' + (y0 + KD_PANEL_H) + '" x2="' + (x0 + xw) +
             '" y2="' + (y0 + KD_PANEL_H) + '" stroke="' + KD_GRID + '"/>';
      // Panel label with the channel value at the event sample.
      out += '<text x="4" y="' + (y0 + 12) + '" font-family="' + KD_FONT +
             '" fill="' + ch.color + '" font-size="11" font-weight="600">' +
             ch.label + '</text>';
      out += '<text x="4" y="' + (y0 + 26) + '" font-family="' + KD_FONT +
             '" fill="' + KD_TEXT + '" font-size="11">' +
             kdFmt(ch.eventValue, ch.decimals) + ch.unit + '</text>';
      var series = win[ch.key];
      if (!ch.mapped) {
        out += '<text x="' + (x0 + xw / 2) + '" y="' + (y0 + KD_PANEL_H / 2 + 4) +
               '" text-anchor="middle" font-family="' + KD_FONT +
               '" fill="' + KD_TEXT + '" font-size="11" font-style="italic">' +
               ch.label + ' channel not mapped</text>';
      } else {
        var geom = kdRuns(series, x0, xw, y0 + 2, KD_PANEL_H - 4);
        if (geom) {
          out += kdStrokeFill(geom, ch.color);
        } else {
          // Mapped but no finite samples in the window: flat midline.
          out += '<line x1="' + x0 + '" y1="' + (y0 + KD_PANEL_H / 2) +
                 '" x2="' + (x0 + xw) + '" y2="' + (y0 + KD_PANEL_H / 2) +
                 '" stroke="' + ch.color + '" stroke-dasharray="3 3" opacity="0.5"/>';
        }
        if (ch.max !== null) {
          out += '<text x="' + (KD_W - 4) + '" y="' + (y0 + 10) +
                 '" text-anchor="end" font-family="' + KD_FONT +
                 '" fill="' + KD_TEXT + '" font-size="9">' +
                 kdFmt(ch.max, ch.decimals) + '</text>';
          out += '<text x="' + (KD_W - 4) + '" y="' + (y0 + KD_PANEL_H) +
                 '" text-anchor="end" font-family="' + KD_FONT +
                 '" fill="' + KD_TEXT + '" font-size="9">' +
                 kdFmt(ch.min, ch.decimals) + '</text>';
        }
      }
    });

    // Event-sample marker: dashed vertical line across all panels.
    var mx = len <= 1 ? x0 + xw / 2 : x0 + xw * win.eventPos / (len - 1);
    out += '<line class="p66-kd-marker" x1="' + mx.toFixed(1) + '" y1="' + KD_TOP +
           '" x2="' + mx.toFixed(1) + '" y2="' + (totalH - KD_AXIS_H) +
           '" stroke="' + KD_MARKER + '" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>';
    // Time axis labels (row indices).
    out += '<text x="' + x0 + '" y="' + (totalH - 4) + '" font-family="' + KD_FONT +
           '" fill="' + KD_TEXT + '" font-size="9">sample ' + win.startIdx + '</text>';
    out += '<text x="' + (x0 + xw) + '" y="' + (totalH - 4) + '" text-anchor="end" font-family="' +
           KD_FONT + '" fill="' + KD_TEXT + '" font-size="9">sample ' + win.endIdx + '</text>';

    return out + '</svg>';
  }

  function renderKnockDrilldownHTML(win) {
    if (!win || !win.ok) {
      var why = (win && win.reason) ? win.reason : 'no knock event window';
      return '<div class="p66-kd-empty">' + why + '</div>';
    }
    var len = win.indices.length;
    var title;
    if (win.kr === null) {
      title = 'Knock event — KR channel not mapped';
    } else if (win.peakKR === null) {
      title = 'Knock event — no KR data in window';
    } else {
      title = 'Knock event — peak KR ' + win.peakKR.toFixed(2) + '°' +
              ' at sample ' + win.peakIdx;
    }
    var sub = 'samples ' + win.startIdx + '–' + win.endIdx + ' · ' + len + ' rows' +
              ' · event sample ' + win.eventIdx;
    if (win.peakRpm !== null && kdFinite(win.peakRpm)) {
      sub += ' · peak at ' + Math.round(win.peakRpm) + ' RPM';
    }
    if (win.peakMap !== null && kdFinite(win.peakMap)) {
      sub += ' / ' + win.peakMap.toFixed(1) + ' kPa';
    }
    return '<div class="p66-kd">' +
           '<div class="p66-kd-title">' + title + '</div>' +
           '<div class="p66-kd-sub">' + sub + '</div>' +
           kdSvg(win) +
           '<div class="p66-kd-legend">dashed line = event sample · panels show channel value at the event sample</div>' +
           '</div>';
  }

  P66.knockEventWindow = knockEventWindow;
  P66.renderKnockDrilldownHTML = renderKnockDrilldownHTML;
})(typeof window !== 'undefined' ? window : global);

/* --------------------------------------------------------------------------
 * COORDINATOR WIRING SNIPPET (do not run here — needs the DOM):
 *
 *   // In index.html, after js/playback-events.js:
 *   //   <script src="js/knock-drilldown.js"></script>
 *
 *   // Event-tick click -> drill-down modal:
 *   function onKnockTickClick(tick) {           // tick = { index, type, label }
 *     var krScale = (report && report.knock && report.knock.krScale) || 1;
 *     var win = P66.knockEventWindow(logTable, mapResult, tick.index, 50, krScale);
 *     modalBody.innerHTML = P66.renderKnockDrilldownHTML(win);
 *     showModal('Knock event @ sample ' + tick.index);
 *   }
 *
 * Notes:
 *   - tick.index is the analyzer event's startIdx (see P66.knockEventsOf in
 *     js/playback-events.js); the drill-down centers the window there and
 *     marks that sample with the dashed vertical line.
 *   - When KR is unmapped the renderer shows "KR channel not mapped" and
 *     still draws the other panels — safe to wire unconditionally.
 *   - package-zip.js globs js/* via readdir, so no zip-config change is
 *     needed for the new file.
 * -------------------------------------------------------------------------- */
