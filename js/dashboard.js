/* P66-Tuner dashboard
 * SVG visualizations for session analysis: trim heatmap, knock timeline,
 * lambda trace, region distribution, and session-over-session comparison.
 * No external dependencies — hand-rolled SVG.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function text(parent, x, y, str, attrs) {
    var t = el('text', attrs || {}, parent);
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.textContent = str;
    return t;
  }

  function clear(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  function emptyMsg(container, msg) {
    clear(container);
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = msg;
    container.appendChild(p);
  }

  /* ---------- shared helpers (also unit-tested) ---------- */

  // Diverging color for trim %: blue (lean = add fuel) -> neutral -> red (rich = remove fuel).
  /**
   * Multi-hue value ramp: deep indigo -> blue -> cyan -> green -> yellow ->
   * orange -> red. Far more hue variation than a single-hue ramp while
   * staying ordered dark/low -> bright/high. Explicit stops, no fit error.
   */
  var VALUE_STOPS = [
    [35, 25, 70],    // deep indigo
    [50, 90, 230],   // blue
    [30, 190, 235],  // cyan
    [45, 205, 130],  // green
    [240, 225, 70],  // yellow
    [245, 130, 35],  // orange
    [215, 45, 35]    // red
  ];
  function valueRamp(t) {
    t = Math.max(0, Math.min(1, t));
    var segs = VALUE_STOPS.length - 1;
    var x = t * segs;
    var i = Math.min(Math.floor(x), segs - 1);
    var f = x - i;
    var a = VALUE_STOPS[i], b = VALUE_STOPS[i + 1];
    var rgb = a.map(function (v, k) { return Math.round(v + (b[k] - v) * f); });
    return 'rgb(' + rgb.join(',') + ')';
  }

  function trimColor(t) {
    var c = Math.max(-10, Math.min(10, t)) / 10; // -1..1
    var k = Math.abs(c);
    var neutral = [38, 48, 62];
    // Two-stop ramp per side for more hue travel:
    // lean (+) = adding fuel -> neutral -> cyan -> blue ;
    // rich (-) = removing fuel -> neutral -> orange -> red
    var mid = c >= 0 ? [80, 200, 255] : [255, 171, 64];
    var hi = c >= 0 ? [56, 120, 255] : [255, 77, 60];
    var a, b, f;
    if (k <= 0.5) { a = neutral; b = mid; f = k / 0.5; }
    else { a = mid; b = hi; f = (k - 0.5) / 0.5; }
    var rgb = a.map(function (v, i) { return Math.round(v + (b[i] - v) * f); });
    return 'rgb(' + rgb.join(',') + ')';
  }

  /**
   * Parse a CSS color ('#rrggbb' or 'rgb(r,g,b)') into [r, g, b].
   * The VE palette helpers return rgb() strings, so handle both.
   * (js/ve3d.js carries its own private copy for the 3D surface model.)
   */
  function cssToRgb(css) {
    var m = /^#([0-9a-f]{6})$/i.exec(css);
    if (m) {
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(css);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    return [35, 44, 58]; // fallback: dark neutral
  }

  /**
   * Readable text color over a data-cell background: dark text on bright
   * cells, inherit (light) text on dark cells.
   */
  function cellTextColor(bg) {
    var rgb = cssToRgb(bg);
    var lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return lum > 140 ? '#141a23' : '';
  }

  function binLo(label) {
    var m = /^(-?\d+)/.exec(label);
    return m ? parseInt(m[1], 10) : 0;
  }

  function sortedBins(labels) {
    return labels.slice().sort(function (a, b) { return binLo(a) - binLo(b); });
  }

  function downsample(arr, max) {
    if (arr.length <= max) return arr;
    var step = arr.length / max;
    var out = [];
    for (var i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* ---------- trim heatmap ---------- */

  function renderHeatmap(container, fuelReport) {
    if (!fuelReport || !fuelReport.available || !fuelReport.cells.length) {
      emptyMsg(container, 'No fuel trim data for heatmap.');
      return;
    }
    clear(container);

    var byKey = {};
    var rpmBins = {}, mapBins = {};
    fuelReport.cells.forEach(function (c) {
      byKey[c.rpmBin + '|' + c.mapBin] = c;
      rpmBins[c.rpmBin] = true;
      mapBins[c.mapBin] = true;
    });
    var rpmSorted = sortedBins(Object.keys(rpmBins));
    var mapSorted = sortedBins(Object.keys(mapBins)).reverse(); // high load on top

    var cellW = 72, cellH = 46, labelW = 64, labelH = 30;
    var W = labelW + rpmSorted.length * cellW + 12;
    var H = labelH + mapSorted.length * cellH + 12;

    var svg = el('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      class: 'chart', role: 'img'
    }, container);

    // Column (RPM) labels
    rpmSorted.forEach(function (b, i) {
      text(svg, labelW + i * cellW + cellW / 2, 18, b, {
        'text-anchor': 'middle', class: 'chart-label', 'font-size': '10'
      });
    });
    text(svg, labelW + (rpmSorted.length * cellW) / 2, H - 2, 'RPM', {
      'text-anchor': 'middle', class: 'chart-label', 'font-size': '11'
    });

    // Rows (MAP) + cells
    mapSorted.forEach(function (mb, r) {
      var y = labelH + r * cellH;
      text(svg, labelW - 6, y + cellH / 2 + 4, mb, {
        'text-anchor': 'end', class: 'chart-label', 'font-size': '10'
      });
      rpmSorted.forEach(function (rb, i) {
        var x = labelW + i * cellW;
        var c = byKey[rb + '|' + mb];
        var rect = el('rect', {
          x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2,
          rx: 4, fill: c ? trimColor(c.avgTrim) : '#141a23',
          class: c ? '' : 'chart-empty'
        }, svg);
        if (c) {
          var title = el('title', {}, rect);
          title.textContent = rb + ' RPM / ' + mb + ' kPa: ' +
            (c.avgTrim > 0 ? '+' : '') + c.avgTrim + '% trim, ' +
            c.samples + ' samples (stddev ' + c.stddev + ')';
          var fg = Math.abs(c.avgTrim) > 4 ? '#0d1117' : '#e6e9ef';
          text(svg, x + cellW / 2, y + 20,
            (c.avgTrim > 0 ? '+' : '') + c.avgTrim + '%', {
              'text-anchor': 'middle', 'font-size': '12', 'font-weight': 'bold', fill: fg
            });
          text(svg, x + cellW / 2, y + 35, c.samples + ' samples', {
            'text-anchor': 'middle', 'font-size': '9', fill: fg, opacity: '0.75'
          });
        }
      });
    });

    // Axis caption
    text(svg, 8, labelH - 12, 'MAP kPa', {
      class: 'chart-label', 'font-size': '11'
    });

    // Legend
    var legend = document.createElement('div');
    legend.className = 'chart-legend muted';
    legend.innerHTML =
      '<span class="swatch" style="background:' + trimColor(-10) + '"></span> rich (−) ' +
      '<span class="swatch" style="background:' + trimColor(0) + '"></span> stoich ' +
      '<span class="swatch" style="background:' + trimColor(10) + '"></span> lean (+)';
    container.appendChild(legend);
  }

  /* ---------- knock timeline ---------- */

  function renderKnockTimeline(container, rows, mapResult) {
    var krName = P66.columnFor(mapResult, 'KR');
    var t = P66.asTable(rows);
    var krC = t ? P66.numView(t, krName) : null;
    if (!krC) { emptyMsg(container, 'No KR channel — knock timeline unavailable.'); return; }
    var n = t.rowCount;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var kr = krC[i];
      if (kr === kr && kr > 0.5) pts.push({ i: i, kr: kr });
    }
    clear(container);
    if (!pts.length) {
      var ok = document.createElement('p');
      ok.className = 'status-ok';
      ok.textContent = 'No knock retard events in this session.';
      container.appendChild(ok);
      return;
    }
    var W = 720, H = 140, padL = 36, padB = 22;
    var maxKR = Math.max.apply(null, pts.map(function (p) { return p.kr; }));
    var maxI = n - 1 || 1;
    var svg = el('svg', {
      width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H,
      class: 'chart', preserveAspectRatio: 'none'
    }, container);

    // baseline
    el('line', {
      x1: padL, y1: H - padB, x2: W - 4, y2: H - padB,
      stroke: '#2b3340', 'stroke-width': 1
    }, svg);
    text(svg, 4, 14, maxKR.toFixed(1) + '°', { class: 'chart-label', 'font-size': '10' });
    text(svg, 4, H - padB, '0°', { class: 'chart-label', 'font-size': '10' });

    pts.forEach(function (p) {
      var x = padL + (p.i / maxI) * (W - padL - 8);
      var h = (p.kr / maxKR) * (H - padB - 16);
      el('rect', {
        x: x, y: H - padB - h, width: Math.max(1.5, (W / maxI) * 0.8), height: h,
        fill: p.kr >= 4 ? '#f85149' : '#d29922', opacity: '0.9'
      }, svg);
    });
    text(svg, W / 2, H - 6, pts.length + ' knock events over ' + n + ' samples', {
      'text-anchor': 'middle', class: 'chart-label', 'font-size': '10'
    });
  }

  /* ---------- lambda trace ---------- */

  function renderLambdaTrace(container, rows, mapResult) {
    var cmdName = P66.columnFor(mapResult, 'CMD_LAMBDA');
    var wbName = P66.columnFor(mapResult, 'WB_LAMBDA');
    var t = P66.asTable(rows);
    var cmdC = t ? P66.numView(t, cmdName) : null;
    var wbC = t ? P66.numView(t, wbName) : null;
    if (!cmdC || !wbC) {
      emptyMsg(container, 'Need commanded + wideband lambda/AFR channels.');
      return;
    }
    var cmd = [], wb = [];
    for (var li = 0; li < t.rowCount; li++) {
      var cv = cmdC[li], wv = wbC[li];
      var c = P66.toLambda(cv !== cv ? null : cv);
      var w = P66.toLambda(wv !== wv ? null : wv);
      if (c !== null && w !== null) { cmd.push(c); wb.push(w); }
    }
    clear(container);
    if (!cmd.length) { emptyMsg(container, 'No valid lambda sample pairs.'); return; }

    var MAXP = 400;
    var cmdS = downsample(cmd, MAXP), wbS = downsample(wb, MAXP);
    var all = cmdS.concat(wbS);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var span = Math.max(0.05, hi - lo);
    lo -= span * 0.15; hi += span * 0.15;

    var W = 720, H = 160, padL = 40, padB = 22;
    var svg = el('svg', {
      width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H,
      class: 'chart', preserveAspectRatio: 'none'
    }, container);

    function X(i) { return padL + (i / (MAXP - 1)) * (W - padL - 8); }
    function Y(v) { return 8 + (1 - (v - lo) / (hi - lo)) * (H - 8 - padB); }

    // stoich reference
    if (lo < 1 && hi > 1) {
      el('line', {
        x1: padL, y1: Y(1), x2: W - 4, y2: Y(1),
        stroke: '#2b3340', 'stroke-dasharray': '4 3', 'stroke-width': 1
      }, svg);
      text(svg, W - 6, Y(1) - 4, 'λ 1.00', {
        'text-anchor': 'end', class: 'chart-label', 'font-size': '10'
      });
    }

    function path(data, color) {
      var d = data.map(function (v, i) {
        return (i === 0 ? 'M' : 'L') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
      }).join(' ');
      el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 1.5 }, svg);
    }
    path(cmdS, '#58a6ff');
    path(wbS, '#d29922');

    text(svg, 4, 14, hi.toFixed(2), { class: 'chart-label', 'font-size': '10' });
    text(svg, 4, H - padB, lo.toFixed(2), { class: 'chart-label', 'font-size': '10' });

    var legend = document.createElement('div');
    legend.className = 'chart-legend muted';
    legend.innerHTML =
      '<span class="swatch" style="background:#58a6ff"></span> commanded ' +
      '<span class="swatch" style="background:#d29922"></span> measured ' +
      '(' + cmd.length + ' samples' + (cmd.length > MAXP ? ', downsampled' : '') + ')';
    container.appendChild(legend);
  }

  /* ---------- region distribution ---------- */

  function renderRegionBars(container, report) {
    clear(container);
    var dist = report.regionDistribution || {};
    var total = report.rowCount || 1;
    var wrap = document.createElement('div');
    wrap.className = 'region-bars';
    P66.REGIONS.forEach(function (r) {
      var n = dist[r] || 0;
      var pct = (100 * n / total);
      var row = document.createElement('div');
      row.className = 'region-row';
      row.innerHTML =
        '<span class="region-name">' + r + '</span>' +
        '<span class="region-bar"><span class="region-fill region-' + r + '" style="width:' +
        pct.toFixed(1) + '%"></span></span>' +
        '<span class="region-num">' + n + ' (' + pct.toFixed(0) + '%)</span>';
      wrap.appendChild(row);
    });
    container.appendChild(wrap);
  }

  /* ---------- log coverage coach ---------- */

  var VERDICT_WORDS = {
    excellent: 'Excellent coverage — this log can support a full tune.',
    good: 'Good coverage — usable, with a few gaps worth filling next time.',
    thin: 'Thin coverage — tune from this log, but fill the gaps before trusting it fully.',
    poor: 'Poor coverage — log more driving before tuning from this.'
  };

  function renderCoverage(container, report) {
    clear(container);
    if (typeof P66.analyzeCoverage !== 'function') {
      emptyMsg(container, 'Coverage module not loaded.');
      return;
    }
    var cov = P66.analyzeCoverage(report);
    var wrap = document.createElement('div');
    var sevIcon = { critical: '🛑', warn: '⚠️', info: 'ℹ️' };
    var html = '<p><strong>Coverage score: ' + cov.score + '/100</strong> — ' +
      (VERDICT_WORDS[cov.verdict] || cov.verdict) + '</p>';
    if (cov.gaps.length) {
      html += '<ul>';
      cov.gaps.forEach(function (g) {
        html += '<li>' + (sevIcon[g.severity] || '•') + ' ' + g.detail + '</li>';
      });
      html += '</ul>';
    } else {
      html += '<p class="status-ok">No gaps found.</p>';
    }
    if (cov.driveCycle.length) {
      html += '<p><strong>What to log next:</strong></p><ol>';
      cov.driveCycle.forEach(function (s) { html += '<li>' + s + '</li>'; });
      html += '</ol>';
    }
    wrap.innerHTML = html;
    container.appendChild(wrap);
  }

  /* ---------- session comparison ---------- */

  function compareMetrics(prev, curr) {
    function m(r) {
      return {
        trim: r.fuelTrims.available ? r.fuelTrims.overallAvgAbsTrim : null,
        knock: r.knock.available ? r.knock.knockSamples : null,
        maxKR: r.knock.available ? r.knock.maxKR : null,
        lambda: r.lambda.available ? r.lambda.meanAbsError : null,
        rows: r.rowCount
      };
    }
    var a = m(prev), b = m(curr);
    // lower is better for all metrics
    function row(label, fmt) {
      var d = (a[label] !== null && b[label] !== null) ? b[label] - a[label] : null;
      return { label: label, prev: a[label], curr: b[label], delta: d, fmt: fmt };
    }
    return [
      row('trim', function (v) { return v === null ? '—' : v.toFixed(2) + '%'; }),
      row('knock', function (v) { return v === null ? '—' : String(v); }),
      row('maxKR', function (v) { return v === null ? '—' : v.toFixed(1) + '°'; }),
      row('lambda', function (v) { return v === null ? '—' : 'λ ' + v.toFixed(3); }),
      row('rows', function (v) { return String(v); })
    ];
  }

  var METRIC_NAMES = {
    trim: 'Avg |fuel trim|', knock: 'Knock samples', maxKR: 'Max KR',
    lambda: 'Lambda err', rows: 'Samples'
  };

  function renderComparison(container, history) {
    clear(container);
    if (history.length < 2) {
      emptyMsg(container, 'Run analysis on two sessions to compare before/after.');
      return;
    }
    var prev = history[history.length - 2];
    var curr = history[history.length - 1];
    var rows = compareMetrics(prev, curr);
    var html = '<table><thead><tr><th>Metric</th><th>Previous</th><th>Current</th><th>Δ</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var deltaTxt = '—', cls = '';
      if (r.delta !== null) {
        var better = r.label === 'rows' ? r.delta > 0 : r.delta < 0;
        var worse = r.label === 'rows' ? r.delta < 0 : r.delta > 0;
        var sign = r.delta > 0 ? '+' : '';
        if (r.label === 'lambda') deltaTxt = sign + r.delta.toFixed(3);
        else if (r.label === 'trim' || r.label === 'maxKR') deltaTxt = sign + r.delta.toFixed(2);
        else deltaTxt = sign + r.delta;
        cls = better ? 'status-ok' : (worse ? 'status-bad' : '');
      }
      html += '<tr><td>' + (METRIC_NAMES[r.label] || r.label) + '</td>' +
        '<td>' + r.fmt(r.prev) + '</td><td>' + r.fmt(r.curr) + '</td>' +
        '<td class="' + cls + '">' + deltaTxt + '</td></tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  /* ---------- tune journal ---------- */

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderJournal(container, sessionMeta) {
    if (typeof P66.createJournal !== 'function') {
      emptyMsg(container, 'Journal module not loaded.');
      return;
    }
    var journal = P66.createJournal();
    function paint() {
      clear(container);
      var wrap = document.createElement('div');
      var formHtml = '<textarea id="journal-note" rows="2" style="width:100%;box-sizing:border-box;" ' +
        'placeholder="What did you flash, and what happened? e.g. flashed 10/11 — pulled 2° at 3000rpm, knock gone, idle hunts"></textarea>' +
        '<p><button id="journal-add" type="button" style="width:auto;">Save note</button></p>';
      var formDiv = document.createElement('div');
      formDiv.innerHTML = formHtml;
      wrap.appendChild(formDiv);
      var entries = journal.list();
      if (!entries.length) {
        var p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No notes yet. After you flash, write down what you changed and what the car did — ' +
          'the next log only makes sense with these notes.';
        wrap.appendChild(p);
      } else {
        var ul = document.createElement('ul');
        entries.slice(0, 10).forEach(function (e) {
          var li = document.createElement('li');
          var when = e.date ? e.date.slice(0, 10) : '';
          li.innerHTML = '<strong>' + escHtml(when) + '</strong> ' + escHtml(e.note) +
            (e.logName ? ' <span class="muted">(' + escHtml(e.logName) + ')</span>' : '') +
            ' <button type="button" data-jid="' + escHtml(e.id) + '" style="width:auto;padding:0 0.4rem;" title="Delete note">×</button>';
          ul.appendChild(li);
        });
        wrap.appendChild(ul);
      }
      container.appendChild(wrap);
      var addBtn = wrap.querySelector('#journal-add');
      var noteEl = wrap.querySelector('#journal-note');
      addBtn.addEventListener('click', function () {
        var added = journal.add({
          note: noteEl.value,
          logName: (sessionMeta && sessionMeta.logName) || '',
          patchCount: (sessionMeta && sessionMeta.patchCount) || 0,
          binFingerprint: (sessionMeta && sessionMeta.binFingerprint) || ''
        });
        if (added) paint();
        else noteEl.focus();
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('button[data-jid]'), function (b) {
        b.addEventListener('click', function () {
          journal.remove(b.getAttribute('data-jid'));
          paint();
        });
      });
    }
    paint();
  }

  /* ---------- VE table before/after ---------- */

  /**
   * Pure data builder for the VE before/after view. Testable in node.
   * Returns { before, after, deltas, rows, cols, rpmBp, mapBp, changed,
   *   biggest, tableTitle } or { error }.
   */
  function veComparisonData(catalog, binBytes, patches, tableName) {
    tableName = tableName || 'Main VE';
    if (typeof P66.readTable !== 'function') {
      return { error: 'Table reader not loaded (js/xdf-map.js).' };
    }
    var ve = P66.readTable(catalog, tableName, binBytes);
    if (!ve) {
      return { error: tableName + ' table not readable from this binary/catalog.' };
    }
    var rows = ve.rows, cols = ve.cols, eb = ve.elementBytes, base = ve.base;
    var after = ve.values.map(function (row) { return row.slice(); });
    var deltas = [];
    for (var r = 0; r < rows; r++) deltas.push(new Array(cols).fill(null));
    var changed = 0, biggest = null;
    (patches || []).forEach(function (p) {
      if (p.address === undefined || p.address === null) return;
      if (p.table && p.table !== tableName) return; // belongs to the other VE table
      var idx = Math.floor((p.address - base) / eb);
      if (idx < 0 || idx >= rows * cols) return; // not a cell of this table
      if (p.deltaPct === undefined || p.deltaPct === null) return; // fuel only
      var rr = Math.floor(idx / cols), cc = idx % cols;
      after[rr][cc] = p.newValue;
      deltas[rr][cc] = { deltaPct: p.deltaPct, smoothed: !!p.smoothed };
      changed++;
      if (!biggest || Math.abs(p.deltaPct) > Math.abs(biggest.deltaPct)) {
        biggest = { row: rr, col: cc, deltaPct: p.deltaPct };
      }
    });
    function bps(axis) {
      return ((axis && axis.labels) || []).map(function (l) { return parseFloat(l); })
        .filter(function (v) { return isFinite(v); });
    }
    return {
      before: ve.values, after: after, deltas: deltas,
      rows: rows, cols: cols,
      rpmBp: bps(ve.table.yAxis), mapBp: bps(ve.table.xAxis),
      changed: changed, biggest: biggest,
      tableTitle: ve.table.title || 'Main VE'
    };
  }

  // Sequential blue scale for absolute VE values.
  function veValueColor(v, min, max) {
    var t = max > min ? (v - min) / (max - min) : 0.5;
    return valueRamp(Math.max(0, Math.min(1, t)));
  }

  /* ---------- lazy 3D surface renderer (js/ve3d.js) ---------- */

  // Flush a log source stashed while js/ve3d.js was not yet loaded into
  // the real P66.setVePointsSource. app.js stashes to P66._vePointsPending
  // when the 3D module is not loaded yet (see the coordinator note in the
  // item-18 report); the first 3D view picks it up here.
  function flushVePointsPending() {
    if (P66._vePointsPending) {
      var pending = P66._vePointsPending;
      P66._vePointsPending = null;
      try { P66.setVePointsSource(pending); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Run fn once the 3D surface renderer (js/ve3d.js) is available.
   * If it is already loaded — normal full page load, or node tests — fn
   * runs synchronously, preserving the old call order. Otherwise
   * js/lazy.js's P66.loadScriptOnce fetches it first and fn runs when it
   * arrives; on failure onFail receives the error.
   */
  function ensureVe3d(fn, onFail) {
    if (typeof P66.renderVeSurface === 'function') {
      flushVePointsPending();
      fn();
      return;
    }
    if (typeof P66.loadScriptOnce !== 'function') {
      onFail(new Error('3D renderer not loaded and no script loader available'));
      return;
    }
    P66.loadScriptOnce('js/ve3d.js').then(function () {
      if (typeof P66.renderVeSurface === 'function') {
        flushVePointsPending();
        fn();
      } else {
        onFail(new Error('js/ve3d.js loaded but P66.renderVeSurface is missing'));
      }
    }, onFail);
  }

  function renderVeComparison(container, catalog, binBytes, patches) {
    // Stop any previous 3D loop: the old canvas is detached after clear().
    if (container._veStop) {
      try { container._veStop(); } catch (e) { /* ignore */ }
      container._veStop = null;
    }
    clear(container);

    // VE tables touched by this tune's patches (Main VE first), limited to
    // tables the catalog can actually read. A table switcher appears only
    // when the tune touched more than one table.
    var tableNames = [];
    (patches || []).forEach(function (p) {
      if (p && p.table && tableNames.indexOf(p.table) === -1) tableNames.push(p.table);
    });
    tableNames.sort(function (a, b) {
      if (a === 'Main VE') return -1;
      if (b === 'Main VE') return 1;
      return a < b ? -1 : 1;
    });
    tableNames = tableNames.filter(function (t) {
      return typeof P66.readTable === 'function' && P66.readTable(catalog, t, binBytes) !== null;
    });
    if (!tableNames.length) tableNames = ['Main VE'];

    var currentTable = tableNames[0];
    var currentView = 'change';
    var data = null, vmin = 0, vmax = 1;

    var wrap = document.createElement('div');
    var summary = document.createElement('p');
    wrap.appendChild(summary);

    if (tableNames.length > 1) {
      var tableToggle = document.createElement('p');
      tableToggle.className = 've-toggle';
      tableNames.forEach(function (t) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = t;
        if (t === currentTable) btn.classList.add('active');
        btn.addEventListener('click', function () {
          Array.prototype.forEach.call(tableToggle.querySelectorAll('button'), function (x) {
            x.classList.remove('active');
          });
          btn.classList.add('active');
          loadTable(t);
        });
        tableToggle.appendChild(btn);
      });
      wrap.appendChild(tableToggle);
    }

    var toggle = document.createElement('p');
    toggle.className = 've-toggle';
    var VIEWS = [
      { key: 'before', label: 'Before' },
      { key: 'after', label: 'After' },
      { key: 'change', label: 'Change' },
      { key: '3d', label: '3D' }
    ];
    VIEWS.forEach(function (v) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = v.label;
      btn.setAttribute('data-view', v.key);
      if (v.key === currentView) btn.classList.add('active');
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(toggle.querySelectorAll('button'), function (x) {
          x.classList.remove('active');
        });
        btn.classList.add('active');
        setView(v.key);
      });
      toggle.appendChild(btn);
    });
    wrap.appendChild(toggle);

    var gridBox = document.createElement('div');
    gridBox.className = 've-grid-box';
    wrap.appendChild(gridBox);
    container.appendChild(wrap);

    function updateSummary() {
      if (data.changed) {
        var b = data.biggest;
        var bRpm = data.rpmBp[b.row] !== undefined ? data.rpmBp[b.row] + ' RPM' : 'row ' + b.row;
        var bMap = data.mapBp[b.col] !== undefined ? data.mapBp[b.col] + ' kPa' : 'col ' + b.col;
        summary.innerHTML = '<strong>' + data.tableTitle + ': ' + data.changed + ' of ' + (data.rows * data.cols) +
          ' cells changed.</strong> Biggest move ' + (b.deltaPct > 0 ? '+' : '') + b.deltaPct +
          '% @ ' + bRpm + ' / ' + bMap + '. <span class="muted">Raw table values; ' +
          'smoothed buffer cells shown in italic.</span>';
      } else {
        summary.innerHTML = '<span class="muted">No ' + data.tableTitle +
          ' changes in this tune — showing the stock table.</span>';
      }
    }

    function loadTable(t) {
      currentTable = t;
      data = veComparisonData(catalog, binBytes, patches, t);
      if (data.error) {
        summary.innerHTML = '<span class="muted">' + data.error + '</span>';
        gridBox.innerHTML = '';
        return;
      }
      vmin = Infinity; vmax = -Infinity;
      data.before.forEach(function (row) {
        row.forEach(function (v) {
          if (v < vmin) vmin = v;
          if (v > vmax) vmax = v;
        });
      });
      updateSummary();
      paint();
    }

    function setView(v) {
      currentView = v;
      paint();
    }

    function cellTip(r, c) {
      var rpm = data.rpmBp[r] !== undefined ? data.rpmBp[r] + ' RPM' : 'row ' + r;
      var map = data.mapBp[c] !== undefined ? data.mapBp[c] + ' kPa' : 'col ' + c;
      var d = data.deltas[r][c];
      var tip = rpm + ' / ' + map + ' — before ' + data.before[r][c] + ' → after ' + data.after[r][c];
      if (d) {
        tip += ' (' + (d.deltaPct > 0 ? '+' : '') + d.deltaPct + '%' +
          (d.smoothed ? ', smoothed buffer' : '') + ')';
      }
      return tip;
    }

    function paint() {
      var view = currentView;
      if (container._veStop) {
        try { container._veStop(); } catch (e) { /* ignore */ }
        container._veStop = null;
      }
      gridBox.innerHTML = '';
      if (view === '3d') {
        // Lazy-load the 3D renderer (js/ve3d.js) on first use; when it
        // is already loaded this runs synchronously, as before.
        ensureVe3d(paint3D, function (err) {
          gridBox.innerHTML = '<p class="muted">3D view unavailable: ' +
            (err && err.message ? err.message : err) + '</p>';
        });
        return;
      }
      var table = document.createElement('table');
      table.className = 've-grid';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      hr.appendChild(document.createElement('th')); // corner
      data.mapBp.forEach(function (m) {
        var th = document.createElement('th');
        th.textContent = m;
        hr.appendChild(th);
      });
      // If axis labels are missing, fall back to column indices.
      if (!data.mapBp.length) {
        for (var c0 = 0; c0 < data.cols; c0++) {
          var th0 = document.createElement('th');
          th0.textContent = c0;
          hr.appendChild(th0);
        }
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      for (var r = 0; r < data.rows; r++) {
        var tr = document.createElement('tr');
        var rh = document.createElement('th');
        rh.textContent = data.rpmBp[r] !== undefined ? data.rpmBp[r] : r;
        tr.appendChild(rh);
        for (var c = 0; c < data.cols; c++) {
          var td = document.createElement('td');
          var d = data.deltas[r][c];
          td.title = cellTip(r, c);
          if (view === 'change') {
            if (d) {
              td.textContent = (d.deltaPct > 0 ? '+' : '') + d.deltaPct + '%';
              var chgBg = trimColor(Math.max(-10, Math.min(10, d.deltaPct)));
              td.style.background = chgBg;
              td.style.color = cellTextColor(chgBg);
              if (d.smoothed) td.style.fontStyle = 'italic';
            } else {
              td.textContent = '—';
              td.className = 've-unchanged';
            }
          } else {
            var v = view === 'before' ? data.before[r][c] : data.after[r][c];
            td.textContent = v;
            var valBg = veValueColor(v, vmin, vmax);
            td.style.background = valBg;
            td.style.color = cellTextColor(valBg);
            if (view === 'after' && d) td.style.fontWeight = 'bold';
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      gridBox.appendChild(table);
    }

    function paint3D() {
      var dataset = 'change';
      var dsWrap = document.createElement('p');
      dsWrap.className = 've-toggle';
      [['before', 'Before'], ['after', 'After'], ['change', 'Change']].forEach(function (ds) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = ds[1];
        if (ds[0] === dataset) b.classList.add('active');
        b.addEventListener('click', function () {
          dataset = ds[0];
          Array.prototype.forEach.call(dsWrap.querySelectorAll('button'), function (x) {
            x.classList.remove('active');
          });
          b.classList.add('active');
        });
        dsWrap.appendChild(b);
      });
      gridBox.appendChild(dsWrap);

      // Operating-points toggle: ON scatters stride-sampled log samples
      // as dots on the 3D surface. Default OFF. When no log source has
      // been provided via P66.setVePointsSource(), the toggle is disabled
      // with a hint.
      var ptsInfo = P66._vePointsResolve(data);
      var showPoints = false;
      var ptsRow = document.createElement('p');
      ptsRow.className = 've-toggle ve-points-row';
      var ptsLabel = document.createElement('label');
      ptsLabel.className = 've-points-label';
      var ptsBox = document.createElement('input');
      ptsBox.type = 'checkbox';
      ptsBox.checked = false;
      var ptsDot = document.createElement('span');
      ptsDot.className = 've-points-dot';
      ptsDot.setAttribute('aria-hidden', 'true');
      ptsLabel.appendChild(ptsBox);
      ptsLabel.appendChild(ptsDot);
      ptsLabel.appendChild(document.createTextNode(' Operating points'));
      ptsRow.appendChild(ptsLabel);
      var ptsHint = document.createElement('span');
      ptsHint.className = 've-points-hint muted';
      if (ptsInfo) {
        ptsHint.textContent = ' — ' + ptsInfo.points.length + ' log samples';
      } else {
        ptsBox.disabled = true;
        ptsHint.textContent = ' (load a log to show operating points)';
      }
      ptsRow.appendChild(ptsHint);
      gridBox.appendChild(ptsRow);
      ptsBox.addEventListener('change', function () {
        showPoints = ptsBox.checked;
      });

      var canvas = document.createElement('canvas');
      gridBox.appendChild(canvas);
      var hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = 'Drag to rotate · scroll to zoom · slowly auto-rotates when idle';
      gridBox.appendChild(hint);
      try {
        container._veStop = P66.renderVeSurface(canvas, data, function () { return dataset; }, {
          getShowPoints: function () { return showPoints; },
          getPoints: function () { return ptsInfo ? ptsInfo.points : []; }
        });
      } catch (e) {
        gridBox.innerHTML = '<p class="muted">3D view unavailable: ' + (e && e.message ? e.message : e) + '</p>';
      }
    }

    loadTable(currentTable);
  }

  /* ---------- Main Spark Advance before/after (Spark dashboard tab) ---------- */

  /**
   * Degrees per raw unit for a spark table, from its MATH equation.
   * Returns null when the equation is missing or unparseable — the caller
   * errors out rather than guessing a scale (same lane as js/xdf-map.js).
   */
  function sparkDegPerRaw(table) {
    if (typeof P66.rawPerDegree !== 'function') return null;
    var eq = table && table.zAxis && table.zAxis.equation;
    var rpd = P66.rawPerDegree(eq);
    if (rpd === null || !isFinite(rpd) || rpd <= 0) return null;
    return 1 / rpd;
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  /**
   * Nearest spark-table cell for an (rpm, map) point, mirroring
   * js/tuner.js nearestSparkCell so the overlay marks the same cells the
   * patcher would retard.
   */
  function sparkNearestCell(rpmBp, mapBp, rpm, map) {
    if (rpm === null || rpm === undefined || map === null || map === undefined) return null;
    if (!rpmBp || !rpmBp.length || !mapBp || !mapBp.length) return null;
    function nearest(bp, v) {
      var best = 0, bestD = Math.abs(bp[0] - v);
      for (var i = 1; i < bp.length; i++) {
        var d = Math.abs(bp[i] - v);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    return { row: nearest(rpmBp, rpm), col: nearest(mapBp, map) };
  }

  /**
   * Pure knock overlay builder (testable in node). Maps each knock event's
   * (rpm, map) — taken at the event's peak KR — onto the spark table's
   * nearest cells. Returns { "row,col": { row, col, events, peakKR } }.
   * All flagged events are marked (single-sample spikes and tip-out
   * rejects included): the overlay shows where knock was *seen* so timing
   * can be read against it; the tuner's gating still decides what acts.
   */
  function sparkKnockOverlay(knockReport, rpmBp, mapBp) {
    var overlay = {};
    var events = (knockReport && knockReport.events) || [];
    events.forEach(function (e) {
      var hit = sparkNearestCell(rpmBp, mapBp, e.rpm, e.map);
      if (!hit) return;
      var key = hit.row + ',' + hit.col;
      if (!overlay[key]) overlay[key] = { row: hit.row, col: hit.col, events: 0, peakKR: 0 };
      overlay[key].events++;
      if (e.peakKR > overlay[key].peakKR) overlay[key].peakKR = e.peakKR;
    });
    return overlay;
  }

  /**
   * Pure data builder for the spark before/after view. Testable in node.
   * Mirrors veComparisonData: reads the Main Spark Advance table, applies
   * the session's spark patches (deltaDeg, address-mapped), and overlays
   * knock-flagged cells. Values are converted to DEGREES via the table's
   * MATH equation so the table reads as timing, not raw counts.
   * Returns { before, after, deltas, knockOverlay, rows, cols, rpmBp,
   *   mapBp, changed, biggest, tableTitle, sparkDegLimit } or { error }.
   */
  function sparkComparisonData(catalog, binBytes, patches, knockReport) {
    var tableName = 'Main Spark Advance';
    if (typeof P66.readTable !== 'function') {
      return { error: 'Table reader not loaded (js/xdf-map.js).' };
    }
    var spark = P66.readTable(catalog, tableName, binBytes);
    if (!spark) {
      return { error: 'Main Spark Advance table not readable from this binary/catalog.' };
    }
    var degPerRaw = sparkDegPerRaw(spark.table);
    if (degPerRaw === null) {
      return {
        error: 'Unsupported spark scaling equation "' +
          ((spark.table.zAxis && spark.table.zAxis.equation) || '') +
          '" — refusing to guess a scale.'
      };
    }
    var rows = spark.rows, cols = spark.cols, eb = spark.elementBytes, base = spark.base;
    var before = spark.values.map(function (row) {
      return row.map(function (v) { return round1(v * degPerRaw); });
    });
    var after = before.map(function (row) { return row.slice(); });
    var deltas = [];
    for (var r = 0; r < rows; r++) deltas.push(new Array(cols).fill(null));
    var changed = 0, biggest = null;
    (patches || []).forEach(function (p) {
      if (p.address === undefined || p.address === null) return;
      if (p.table && p.table !== tableName) return; // belongs to another table
      var idx = Math.floor((p.address - base) / eb);
      if (idx < 0 || idx >= rows * cols) return; // not a cell of this table
      if (p.deltaDeg === undefined || p.deltaDeg === null) return; // spark only
      var rr = Math.floor(idx / cols), cc = idx % cols;
      after[rr][cc] = round1(p.newValue * degPerRaw);
      deltas[rr][cc] = { deltaDeg: p.deltaDeg, smoothed: !!p.smoothed };
      changed++;
      if (!biggest || Math.abs(p.deltaDeg) > Math.abs(biggest.deltaDeg)) {
        biggest = { row: rr, col: cc, deltaDeg: p.deltaDeg };
      }
    });
    function bps(axis) {
      return ((axis && axis.labels) || []).map(function (l) { return parseFloat(l); })
        .filter(function (v) { return isFinite(v); });
    }
    var rpmBp = bps(spark.table.yAxis), mapBp = bps(spark.table.xAxis);
    var limit = (P66.LEDGER_LIMITS && P66.LEDGER_LIMITS.sparkDeg) || 6;
    return {
      before: before, after: after, deltas: deltas,
      knockOverlay: sparkKnockOverlay(knockReport, rpmBp, mapBp),
      rows: rows, cols: cols,
      rpmBp: rpmBp, mapBp: mapBp,
      changed: changed, biggest: biggest,
      tableTitle: spark.table.title || 'Main Spark Advance',
      sparkDegLimit: limit
    };
  }

  function fmtDeg(v) {
    return (v > 0 ? '+' : '') + v + '°';
  }

  function renderSparkComparison(container, catalog, binBytes, patches, knockReport) {
    // Stop any previous 3D loop: the old canvas is detached after clear().
    if (container._sparkStop) {
      try { container._sparkStop(); } catch (e) { /* ignore */ }
      container._sparkStop = null;
    }
    clear(container);

    var data = sparkComparisonData(catalog, binBytes, patches, knockReport);
    var wrap = document.createElement('div');
    var summary = document.createElement('p');
    wrap.appendChild(summary);
    if (data.error) {
      summary.innerHTML = '<span class="muted">' + data.error + '</span>';
      container.appendChild(wrap);
      return;
    }

    var currentView = 'change';
    var vmin = Infinity, vmax = -Infinity;
    data.before.forEach(function (row) {
      row.forEach(function (v) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      });
    });

    function knockKeys() {
      return Object.keys(data.knockOverlay);
    }

    function updateSummary() {
      if (data.changed) {
        var b = data.biggest;
        var bRpm = data.rpmBp[b.row] !== undefined ? data.rpmBp[b.row] + ' RPM' : 'row ' + b.row;
        var bMap = data.mapBp[b.col] !== undefined ? data.mapBp[b.col] + ' kPa' : 'col ' + b.col;
        summary.innerHTML = '<strong>' + data.tableTitle + ': ' + data.changed + ' of ' +
          (data.rows * data.cols) + ' cells changed.</strong> Biggest move ' +
          fmtDeg(b.deltaDeg) + ' @ ' + bRpm + ' / ' + bMap + '. ' +
          '<span class="muted">Degrees of ignition timing; knock-flagged cells are outlined ' +
          'in amber; smoothed buffer cells shown in italic.</span>';
      } else {
        summary.innerHTML = '<span class="muted">No spark changes suggested — table unchanged ' +
          '(showing the stock table).</span>';
      }
      var nk = knockKeys();
      if (nk.length) {
        var flagged = nk.map(function (k) {
          var o = data.knockOverlay[k];
          var lbl = (data.rpmBp[o.row] !== undefined ? data.rpmBp[o.row] + ' RPM' : 'row ' + o.row) +
            ' / ' + (data.mapBp[o.col] !== undefined ? data.mapBp[o.col] + ' kPa' : 'col ' + o.col);
          return lbl + ' (' + o.events + ' event' + (o.events === 1 ? '' : 's') +
            ', peak ' + o.peakKR + '° KR)';
        });
        summary.innerHTML += '<br><span class="muted">Knock flagged in ' + nk.length +
          ' spark cell' + (nk.length === 1 ? '' : 's') + ': ' + flagged.join('; ') + '.</span>';
      }
      // Ledger guardrail lane: cumulative per-cell timing moves warn past
      // ±N° across sessions (js/ledger.js). Same plain-English warn wording.
      summary.innerHTML += '<br><span class="muted">Cumulative guardrail: the tune warns if one ' +
        'cell\'s total timing move across sessions reaches ±' + data.sparkDegLimit +
        '° — verify the trend is actually improving the log before flashing further.</span>';
    }

    var toggle = document.createElement('p');
    toggle.className = 've-toggle';
    var VIEWS = [
      { key: 'before', label: 'Before' },
      { key: 'after', label: 'After' },
      { key: 'change', label: 'Change' },
      { key: '3d', label: '3D' }
    ];
    VIEWS.forEach(function (v) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = v.label;
      btn.setAttribute('data-view', v.key);
      if (v.key === currentView) btn.classList.add('active');
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(toggle.querySelectorAll('button'), function (x) {
          x.classList.remove('active');
        });
        btn.classList.add('active');
        currentView = v.key;
        paint();
      });
      toggle.appendChild(btn);
    });
    wrap.appendChild(toggle);

    var gridBox = document.createElement('div');
    gridBox.className = 've-grid-box';
    wrap.appendChild(gridBox);
    container.appendChild(wrap);

    function cellTip(r, c) {
      var rpm = data.rpmBp[r] !== undefined ? data.rpmBp[r] + ' RPM' : 'row ' + r;
      var map = data.mapBp[c] !== undefined ? data.mapBp[c] + ' kPa' : 'col ' + c;
      var d = data.deltas[r][c];
      var tip = rpm + ' / ' + map + ' — before ' + data.before[r][c] + '° → after ' +
        data.after[r][c] + '°';
      if (d) tip += ' (' + fmtDeg(d.deltaDeg) + (d.smoothed ? ', smoothed buffer' : '') + ')';
      var ko = data.knockOverlay[r + ',' + c];
      if (ko) {
        tip += ' · knock flagged here (' + ko.events + ' event' +
          (ko.events === 1 ? '' : 's') + ', peak ' + ko.peakKR + '° KR)';
      }
      return tip;
    }

    function paint() {
      var view = currentView;
      if (container._sparkStop) {
        try { container._sparkStop(); } catch (e) { /* ignore */ }
        container._sparkStop = null;
      }
      gridBox.innerHTML = '';
      if (view === '3d') {
        // Lazy-load the 3D renderer (js/ve3d.js) on first use; when it
        // is already loaded this runs synchronously, as before.
        ensureVe3d(paintSpark3D, function (err) {
          gridBox.innerHTML = '<p class="muted">3D view unavailable: ' +
            (err && err.message ? err.message : err) + '</p>';
        });
        return;
      }
      var table = document.createElement('table');
      table.className = 've-grid';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      hr.appendChild(document.createElement('th')); // corner
      data.mapBp.forEach(function (m) {
        var th = document.createElement('th');
        th.textContent = m;
        hr.appendChild(th);
      });
      if (!data.mapBp.length) {
        for (var c0 = 0; c0 < data.cols; c0++) {
          var th0 = document.createElement('th');
          th0.textContent = c0;
          hr.appendChild(th0);
        }
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      for (var r = 0; r < data.rows; r++) {
        var tr = document.createElement('tr');
        var rh = document.createElement('th');
        rh.textContent = data.rpmBp[r] !== undefined ? data.rpmBp[r] : r;
        tr.appendChild(rh);
        for (var c = 0; c < data.cols; c++) {
          var td = document.createElement('td');
          var d = data.deltas[r][c];
          td.title = cellTip(r, c);
          if (data.knockOverlay[r + ',' + c]) td.classList.add('spark-knock');
          if (view === 'change') {
            if (d) {
              td.textContent = fmtDeg(d.deltaDeg);
              var chgBg = trimColor(Math.max(-10, Math.min(10, d.deltaDeg)));
              td.style.background = chgBg;
              td.style.color = cellTextColor(chgBg);
              if (d.smoothed) td.style.fontStyle = 'italic';
            } else {
              td.textContent = '—';
              td.classList.add('ve-unchanged');
            }
          } else {
            var v = view === 'before' ? data.before[r][c] : data.after[r][c];
            td.textContent = v + '°';
            var valBg = veValueColor(v, vmin, vmax);
            td.style.background = valBg;
            td.style.color = cellTextColor(valBg);
            if (view === 'after' && d) td.style.fontWeight = 'bold';
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      gridBox.appendChild(table);
    }

    function paintSpark3D() {
      var dataset = 'change';
      var dsWrap = document.createElement('p');
      dsWrap.className = 've-toggle';
      [['before', 'Before'], ['after', 'After'], ['change', 'Change']].forEach(function (ds) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = ds[1];
        if (ds[0] === dataset) b.classList.add('active');
        b.addEventListener('click', function () {
          dataset = ds[0];
          Array.prototype.forEach.call(dsWrap.querySelectorAll('button'), function (x) {
            x.classList.remove('active');
          });
          b.classList.add('active');
        });
        dsWrap.appendChild(b);
      });
      gridBox.appendChild(dsWrap);

      // Operating-points toggle, mirroring the VE 3D view: stride-sampled
      // log samples drawn as dots on the surface. Disabled with a hint
      // until a log source is provided via P66.setVePointsSource().
      var ptsInfo = P66._vePointsResolve(data);
      var showPoints = false;
      var ptsRow = document.createElement('p');
      ptsRow.className = 've-toggle ve-points-row';
      var ptsLabel = document.createElement('label');
      ptsLabel.className = 've-points-label';
      var ptsBox = document.createElement('input');
      ptsBox.type = 'checkbox';
      ptsBox.checked = false;
      var ptsDot = document.createElement('span');
      ptsDot.className = 've-points-dot';
      ptsDot.setAttribute('aria-hidden', 'true');
      ptsLabel.appendChild(ptsBox);
      ptsLabel.appendChild(ptsDot);
      ptsLabel.appendChild(document.createTextNode(' Operating points'));
      ptsRow.appendChild(ptsLabel);
      var ptsHint = document.createElement('span');
      ptsHint.className = 've-points-hint muted';
      if (ptsInfo) {
        ptsHint.textContent = ' — ' + ptsInfo.points.length + ' log samples';
      } else {
        ptsBox.disabled = true;
        ptsHint.textContent = ' (load a log to show operating points)';
      }
      ptsRow.appendChild(ptsHint);
      gridBox.appendChild(ptsRow);
      ptsBox.addEventListener('change', function () {
        showPoints = ptsBox.checked;
      });

      var canvas = document.createElement('canvas');
      gridBox.appendChild(canvas);
      var hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = 'Drag to rotate · scroll to zoom · slowly auto-rotates when idle';
      gridBox.appendChild(hint);
      try {
        container._sparkStop = P66.renderVeSurface(canvas, data, function () { return dataset; }, {
          getShowPoints: function () { return showPoints; },
          getPoints: function () { return ptsInfo ? ptsInfo.points : []; }
        });
      } catch (e) {
        gridBox.innerHTML = '<p class="muted">3D view unavailable: ' + (e && e.message ? e.message : e) + '</p>';
      }
    }

    updateSummary();
    paint();
  }

  /* ---------- Spark dashboard tab: panel injection + wiring ---------- */

  // The tab button lives in index.html (one line, data-tab="spark"); the
  // panel is injected here at runtime because this partition owns only
  // dashboard.js + that button line. All spark-specific CSS is scoped to
  // this injected <style> element — styles.css is untouched.
  var SPARK_STYLE_ID = 'spark-viz-style';
  var SPARK_STYLE_CSS =
    '/* ---- Spark table viz (injected at runtime by js/dashboard.js) ---- */\n' +
    '/* Knock-flagged spark cells: amber outline matches the knock timeline. */\n' +
    '.ve-grid td.spark-knock { outline: 2px solid #d29922; outline-offset: -2px; }\n';

  function ensureSparkPanel() {
    if (typeof document === 'undefined') return null;
    var host = document.getElementById('spark-compare');
    if (host) return host;
    if (!document.getElementById(SPARK_STYLE_ID)) {
      var style = document.createElement('style');
      style.id = SPARK_STYLE_ID;
      style.type = 'text/css';
      style.appendChild(document.createTextNode(SPARK_STYLE_CSS));
      document.head.appendChild(style);
    }
    var histPanel = document.querySelector('.tab-panel[data-panel="history"]');
    var panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.setAttribute('data-panel', 'spark');
    panel.setAttribute('role', 'tabpanel');
    var desc = document.createElement('p');
    desc.className = 'muted tab-desc';
    desc.textContent = 'Ignition timing — the spark table before and after the tune, with knock locations marked.';
    panel.appendChild(desc);
    var sec = document.createElement('div');
    var h3 = document.createElement('h3');
    h3.appendChild(document.createTextNode('Main Spark Advance '));
    var sub = document.createElement('span');
    sub.className = 'muted';
    sub.style.fontWeight = 'normal';
    sub.textContent = '— RPM × MAP, degrees';
    h3.appendChild(sub);
    sec.appendChild(h3);
    host = document.createElement('div');
    host.id = 'spark-compare';
    var ph = document.createElement('p');
    ph.className = 'muted';
    ph.textContent = 'Load an XDF + stock binary to render the spark table.';
    host.appendChild(ph);
    sec.appendChild(host);
    panel.appendChild(sec);
    if (histPanel && histPanel.parentNode) {
      histPanel.parentNode.insertBefore(panel, histPanel.nextSibling);
    } else if (document.querySelector('.tabs[role="tablist"]')) {
      document.querySelector('.tabs[role="tablist"]').parentNode.appendChild(panel);
    } else {
      return null;
    }
    return host;
  }

  // Data source for the spark tab. The host app (which owns the loaded XDF
  // catalog, the binary bytes, and the patch list) calls:
  //   P66.setSparkVizSource({ catalog, binBytes, patches, knockReport });
  // knockReport is optional — the dashboard's own session knock analysis
  // (report.knock) is used as the overlay source when not supplied.
  var sparkSource = { catalog: null, binBytes: null, patches: [], knockReport: null };
  function setSparkVizSource(src) {
    src = src || {};
    sparkSource = {
      catalog: src.catalog || null,
      binBytes: src.binBytes || null,
      patches: src.patches || [],
      knockReport: src.knockReport || null
    };
  }

  function renderSparkPanel(report) {
    var host = ensureSparkPanel();
    if (!host) return;
    if (sparkSource.catalog && sparkSource.binBytes) {
      var knock = sparkSource.knockReport || (report && report.knock);
      try {
        renderSparkComparison(host, sparkSource.catalog, sparkSource.binBytes,
          sparkSource.patches, knock);
      } catch (err) {
        emptyMsg(host, 'Spark table render failed: ' + (err && err.message ? err.message : err));
      }
    } else {
      emptyMsg(host, 'Load an XDF + stock binary to render the spark table.');
    }
  }


  /* ---------- transmission ---------- */

  function renderTransmission(container, report, parsedLog, mapResult) {
    clear(container);
    var tr = report.transmission;
    var wrap = document.createElement('div');
    if (!tr || !tr.available) {
      emptyMsg(container, (tr && tr.reason) || 'Transmission analysis unavailable.');
      return;
    }
    function fmt(v, suffix) {
      return v === null || v === undefined ? '—' : v + (suffix || '');
    }
    var html = '<p class="muted">Gear is inferred from RPM vs speed (the ALDL stream carries no gear channel). ' +
      'VSS read as ' + tr.vssUnit + '. TCC: ' + (tr.tccSource === 'channel' ? 'read from the log' : 'inferred') + '.</p>';
    if (tr.pcmShiftCount12 || tr.pcmShiftCount23) {
      html += '<p><strong>PCM-measured shift times:</strong> ' +
        '1-2: ' + (tr.pcmTypicalShift12 !== null ? tr.pcmTypicalShift12 + ' s (' + tr.pcmShiftCount12 + ' shifts)' : '—') +
        ' · 2-3: ' + (tr.pcmTypicalShift23 !== null ? tr.pcmTypicalShift23 + ' s (' + tr.pcmShiftCount23 + ' shifts)' : '—') +
        '</p>';
    }
    html += '<p><strong>' + tr.shifts + ' shifts</strong> detected (' + tr.upshifts + ' up, ' +
      tr.downshifts + ' down) · ' + tr.flaredShifts + ' flared · ' +
      tr.tccApplies + ' TCC applies / ' + tr.tccReleases + ' releases · ' +
      tr.kickdowns + ' kickdown stabs' +
      (tr.avgKickdownDelaySec !== null ? ' (avg ' + tr.avgKickdownDelaySec + ' s)' : '') + ' · ' +
      tr.huntingEpisodes + ' hunting episode(s)</p>';

    var avgs = [
      ['1→2', tr.avgShiftRpm12], ['2→3', tr.avgShiftRpm23], ['3→4', tr.avgShiftRpm34]
    ].filter(function (x) { return x[1] !== null; });
    if (avgs.length) {
      html += '<p><strong>Avg shift RPM:</strong> ' +
        avgs.map(function (x) { return x[0] + ' @ ' + x[1].toLocaleString('en-US'); }).join(' · ') + '</p>';
    }
    if (tr.huntingDetail.length) {
      html += '<p>⚠️ <strong>Shift hunting:</strong> ' + tr.huntingDetail.map(function (h) {
        return h.gears + ' around ' + h.mphAt + ' MPH';
      }).join('; ') + '</p>';
    }
    if (tr.tccCycles >= 2) {
      html += '<p>⚠️ <strong>TCC cycling</strong> at cruise (' + tr.tccCycles +
        ' lock/unlock cycles) — reported only, never auto-tuned.</p>';
    }
    if (tr.shiftEvents.length) {
      html += '<table><thead><tr><th>Shift</th><th>RPM</th><th>MPH</th><th>TPS</th><th>Flare</th></tr></thead><tbody>';
      tr.shiftEvents.slice(0, 12).forEach(function (s) {
        html += '<tr><td>' + s.from + '→' + s.to + ' ' + s.type + '</td><td>' +
          fmt(s.rpmAt === null ? null : s.rpmAt.toLocaleString('en-US')) + '</td><td>' +
          fmt(s.mphAt) + '</td><td>' + fmt(s.tpsAt, '%') + '</td><td>' +
          (s.flared ? '⚠️ +' + s.flareRpm + ' RPM' : '—') + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="muted">No shifts detected — log some driving with steady throttle and gear changes to unlock shift analysis.</p>';
    }
    // Item 13: shift-time histograms per shift pair, flares flagged.
    // Pass the log table + map so the module re-derives the COMPLETE snapshot
    // list (report.transmission.pcmShiftDetail is truncated to 10 entries).
    if (typeof P66.shiftTimeHistograms === 'function' && typeof P66.renderShiftHistogramsSVG === 'function') {
      try {
        var sh = P66.shiftTimeHistograms(tr, parsedLog || null, mapResult || null);
        html += '<h3>Shift-time distributions</h3>';
        html += P66.renderShiftHistogramsSVG(sh);
        if (typeof P66.shiftHealthSummary === 'function') {
          var shs = P66.shiftHealthSummary(sh);
          if (shs && shs.overall) html += '<p>' + escHtml(shs.overall) + '</p>';
        }
      } catch (sherr) { /* histograms are informational */ }
    }
    wrap.innerHTML = html;
    container.appendChild(wrap);
  }

  /* ---------- entry point ---------- */

  function renderDashboard(parts, report, parsedLog, mapResult, history, sessionMeta) {
    if (parts.heatmap) renderHeatmap(parts.heatmap, report.fuelTrims);
    // Trim heatmap (item 10): BLM/INT per VE-grid cell next to the trim grid.
    // Toggle re-renders the same heatmap object — no recompute.
    if (parts.heatmap && typeof P66.buildTrimHeatmap === 'function' && typeof P66.renderTrimHeatmapHTML === 'function') {
      try {
        var thm = P66.buildTrimHeatmap(parsedLog, null, { mapResult: mapResult });
        if (thm && thm.available) {
          var thmWrap = document.createElement('div');
          thmWrap.className = 'trim-heatmap-wrap';
          thmWrap.innerHTML =
            '<h3>Trim heatmap <span class="muted">— per-cell BLM/INT on VE axes</span></h3>' +
            '<p><span role="group" aria-label="Heatmap layer">' +
            '<button type="button" class="thm-layer active" data-layer="blm">BLM</button> ' +
            '<button type="button" class="thm-layer" data-layer="int">INT</button></span></p>' +
            '<div class="thm-host"></div>';
          var thmHost = thmWrap.querySelector('.thm-host');
          thmHost.innerHTML = P66.renderTrimHeatmapHTML(thm, { layer: 'blm' });
          thmWrap.querySelectorAll('.thm-layer').forEach(function (btn) {
            btn.addEventListener('click', function () {
              thmWrap.querySelectorAll('.thm-layer').forEach(function (b) { b.classList.remove('active'); });
              btn.classList.add('active');
              thmHost.innerHTML = P66.renderTrimHeatmapHTML(thm, { layer: btn.getAttribute('data-layer') });
            });
          });
          parts.heatmap.appendChild(thmWrap);
        }
      } catch (therr) { /* heatmap is informational; never break the dashboard */ }
    }
    if (parts.coverage) renderCoverage(parts.coverage, report);
    if (parts.trans) renderTransmission(parts.trans, report, parsedLog, mapResult);
    if (parts.journal) renderJournal(parts.journal, sessionMeta);
    if (parts.regions) renderRegionBars(parts.regions, report);
    if (parts.knock) renderKnockTimeline(parts.knock, parsedLog, mapResult);
    if (parts.lambda) renderLambdaTrace(parts.lambda, parsedLog, mapResult);
    if (parts.comparison) renderComparison(parts.comparison, history || []);
    renderSparkPanel(report);
  }

  // Exposed for testing
  P66.renderHeatmap = renderHeatmap;
  P66.renderJournal = renderJournal;
  P66.veComparisonData = veComparisonData;
  P66.renderVeComparison = renderVeComparison;
  P66.sparkComparisonData = sparkComparisonData;
  P66.setSparkVizSource = setSparkVizSource;
  P66._sparkDegPerRaw = sparkDegPerRaw;
  P66._sparkNearestCell = sparkNearestCell;
  P66.renderDashboard = renderDashboard;
  // Inject the Spark tab panel (+ its scoped <style>) as soon as this
  // module loads, so the index.html tab button has a panel to switch to
  // even before the first analysis runs. Node-safe: no document there.
  try { ensureSparkPanel(); } catch (e) { /* ignore */ }
  P66._trimColor = trimColor;
  P66._valueRamp = valueRamp;
  P66._cellTextColor = cellTextColor;
})(typeof window !== 'undefined' ? window : global);
