/* P66-Tuner dashboard
 * SVG visualizations for session analysis: trim heatmap, knock timeline,
 * lambda trace, region distribution, and session-over-session comparison.
 * No external dependencies — hand-rolled SVG.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});
  var SVGNS = 'http://www.w3.org/2000/svg';

  // Operating points on the VE 3D surface: stride-sampled (rpm, map) log
  // samples drawn as dots on the surface. The log source is provided by
  // the host app via P66.setVePointsSource(); it stays null until a log
  // is loaded, in which case the toggle shows a disabled/hint state.
  var VE_POINTS_MAX = 2000;
  var vePointsSource = null; // { parsedLog, mapResult } | null

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
    var krCol = P66.columnFor(mapResult, 'KR');
    if (!krCol) { emptyMsg(container, 'No KR channel — knock timeline unavailable.'); return; }
    var pts = [];
    rows.forEach(function (row, i) {
      var kr = num(row[krCol]);
      if (kr !== null && kr > 0.5) pts.push({ i: i, kr: kr });
    });
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
    var maxI = rows.length - 1 || 1;
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
    text(svg, W / 2, H - 6, pts.length + ' knock events over ' + rows.length + ' samples', {
      'text-anchor': 'middle', class: 'chart-label', 'font-size': '10'
    });
  }

  /* ---------- lambda trace ---------- */

  function renderLambdaTrace(container, rows, mapResult) {
    var cmdCol = P66.columnFor(mapResult, 'CMD_LAMBDA');
    var wbCol = P66.columnFor(mapResult, 'WB_LAMBDA');
    if (!cmdCol || !wbCol) {
      emptyMsg(container, 'Need commanded + wideband lambda/AFR channels.');
      return;
    }
    var cmd = [], wb = [];
    rows.forEach(function (row) {
      var c = P66.toLambda(num(row[cmdCol]));
      var w = P66.toLambda(num(row[wbCol]));
      if (c !== null && w !== null) { cmd.push(c); wb.push(w); }
    });
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
        paint3D();
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
      var ptsInfo = vePointsResolve(data);
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
        container._veStop = renderVeSurface(canvas, data, function () { return dataset; }, {
          getShowPoints: function () { return showPoints; },
          getPoints: function () { return ptsInfo ? ptsInfo.points : []; }
        });
      } catch (e) {
        gridBox.innerHTML = '<p class="muted">3D view unavailable: ' + (e && e.message ? e.message : e) + '</p>';
      }
    }

    loadTable(currentTable);
  }

  /* ---------- VE table 3D surface ---------- */

  /**
   * Pure rotation helper (testable): azimuth about Y, then elevation about X.
   * Returns camera-space { x1, y2, z2 }; larger z2 = closer to viewer.
   */
  function veRotate(x, y, z, az, el) {
    var cosA = Math.cos(az), sinA = Math.sin(az);
    var x1 = x * cosA - z * sinA;
    var z1 = x * sinA + z * cosA;
    var cosE = Math.cos(el), sinE = Math.sin(el);
    return { x1: x1, y2: y * cosE - z1 * sinE, z2: y * sinE + z1 * cosE };
  }

  /**
   * Parse a CSS color ('#rrggbb' or 'rgb(r,g,b)') into [r, g, b].
   * The VE palette helpers return rgb() strings, so handle both.
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
   * Pure bilinear interpolation (testable).
   * Corners: a00 at (u=0,v=0), a10 at (1,0), a01 at (0,1), a11 at (1,1).
   */
  function veBilinear(a00, a10, a01, a11, u, v) {
    return a00 * (1 - u) * (1 - v) + a10 * u * (1 - v) +
           a01 * (1 - u) * v + a11 * u * v;
  }

  // Fixed camera-space light direction (toward the light), normalized.
  var VE_LIGHT = (function () {
    var l = [-0.42, 0.82, 0.39];
    var n = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  })();

  /**
   * Pure face brightness (testable): dhdx/dhdz are dy/dx, dy/dz in grid
   * units. The surface normal is rotated into camera space and dotted
   * with a fixed camera-space light. Returns 0.55..1.
   */
  function veFaceLight(dhdx, dhdz, cosA, sinA, cosE, sinE) {
    var inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    var nx = -dhdx * inv, ny = inv, nz = -dhdz * inv;
    var x1 = nx * cosA - nz * sinA;
    var z1 = nx * sinA + nz * cosA;
    var y2 = ny * cosE - z1 * sinE;
    var z2 = ny * sinE + z1 * cosE;
    var dot = x1 * VE_LIGHT[0] + y2 * VE_LIGHT[1] + z2 * VE_LIGHT[2];
    if (dot < 0.12) dot = 0.12;
    if (dot > 1) dot = 1;
    return 0.55 + 0.45 * dot;
  }

  /**
   * Pure stride sampler for operating points (testable in node).
   * Evenly samples up to maxPoints { rpm, map } pairs across the WHOLE
   * log (not just the first rows). rows: parsed-log row objects keyed by
   * header name; rpmCol/mapCol: column names from P66.columnFor().
   * Rows with non-numeric rpm/map are dropped; the stride is computed
   * over the valid rows so coverage still spans the session.
   */
  function vePointsSample(rows, rpmCol, mapCol, maxPoints) {
    maxPoints = maxPoints === undefined ? VE_POINTS_MAX : maxPoints;
    if (!rows || !rows.length || !rpmCol || !mapCol || !(maxPoints > 0)) return [];
    var valid = [];
    for (var i = 0; i < rows.length; i++) {
      if (num(rows[i][rpmCol]) !== null && num(rows[i][mapCol]) !== null) valid.push(i);
    }
    if (!valid.length) return [];
    var n = Math.min(maxPoints, valid.length);
    var pts = [];
    for (var k = 0; k < n; k++) {
      var r = valid[Math.floor(k * valid.length / n)];
      pts.push({ rpm: num(rows[r][rpmCol]), map: num(rows[r][mapCol]) });
    }
    return pts;
  }

  /**
   * Pure range filter for operating points (testable in node).
   * Drops points outside the table's RPM x MAP axis range (inclusive).
   * Breakpoints may run ascending or descending.
   */
  function vePointsInRange(points, rpmBp, mapBp) {
    if (!points || !points.length) return [];
    if (!rpmBp || rpmBp.length < 2 || !mapBp || mapBp.length < 2) return [];
    var rmin = Math.min.apply(null, rpmBp), rmax = Math.max.apply(null, rpmBp);
    var mmin = Math.min.apply(null, mapBp), mmax = Math.max.apply(null, mapBp);
    if (!isFinite(rmin) || !isFinite(rmax) || !isFinite(mmin) || !isFinite(mmax)) return [];
    return points.filter(function (p) {
      return p.rpm >= rmin && p.rpm <= rmax && p.map >= mmin && p.map <= mmax;
    });
  }

  /**
   * Pure: map a physical value to a fractional cell coordinate on a
   * monotone breakpoint axis (testable in node). Returns 0..bps.length-1,
   * or null when outside the axis range. Handles ascending or descending
   * breakpoints, clamping at exact endpoints.
   */
  function veAxisFrac(bps, v) {
    if (!bps || bps.length < 2) return null;
    var asc = bps[bps.length - 1] > bps[0];
    var lo = asc ? bps[0] : bps[bps.length - 1];
    var hi = asc ? bps[bps.length - 1] : bps[0];
    if (!(v >= lo && v <= hi)) return null;
    for (var i = 0; i < bps.length - 1; i++) {
      var a = bps[i], b = bps[i + 1];
      var inSeg = asc ? (v >= a && v <= b) : (v <= a && v >= b);
      if (inSeg) {
        var t = (b === a) ? 0 : (v - a) / (b - a);
        return i + Math.max(0, Math.min(1, t));
      }
    }
    return bps.length - 1; // exact endpoint missed by the scan (float dust)
  }

  /**
   * Pure: model-space position of an operating point for the 3D view
   * (testable in node). p: { rpm, map }; model: veSurfaceModel result
   * ({ nodes, rows, cols }); data: veComparisonData result (rpmBp/mapBp);
   * heightScale: the same height scale the renderer uses.
   * Returns { x, y, z } matching the vertex-grid math (x = MAP column,
   * z = RPM row, y = interpolated surface height), or null when the point
   * falls outside the table's axis range.
   */
  function vePointModel(p, model, data, heightScale) {
    if (!p || !model || !model.nodes || !data) return null;
    var rf = veAxisFrac(data.rpmBp, p.rpm);
    var cf = veAxisFrac(data.mapBp, p.map);
    if (rf === null || cf === null) return null;
    var nodes = model.nodes;
    var r0 = Math.min(Math.floor(rf), data.rows - 2), fv = rf - r0, r1 = r0 + 1;
    var c0 = Math.min(Math.floor(cf), data.cols - 2), fu = cf - c0, c1 = c0 + 1;
    if (!nodes[r0] || !nodes[r1] || !nodes[r0][c0] || !nodes[r1][c1]) return null;
    var h = veBilinear(nodes[r0][c0].h, nodes[r0][c1].h,
                       nodes[r1][c0].h, nodes[r1][c1].h, fu, fv);
    return {
      x: cf - (data.cols - 1) / 2,
      y: h * heightScale,
      z: rf - (data.rows - 1) / 2
    };
  }

  /**
   * Set (or clear) the parsed-log source used by the operating-points
   * overlay. Call after a log is parsed:
   *   P66.setVePointsSource({ parsedLog: parsedLog, mapResult: mapResult });
   * Call with null when the log is cleared.
   */
  function setVePointsSource(source) {
    vePointsSource = (source && source.parsedLog && source.mapResult) ? source : null;
  }

  /**
   * Resolve sampled operating points for the current 3D table view.
   * Returns { points, rpmCol, mapCol } or null when no usable log source
   * (no source set, or RPM/MAP columns not mapped).
   */
  function vePointsResolve(data) {
    if (!vePointsSource || typeof P66.columnFor !== 'function') return null;
    var rpmCol = P66.columnFor(vePointsSource.mapResult, 'RPM');
    var mapCol = P66.columnFor(vePointsSource.mapResult, 'MAP');
    if (!rpmCol || !mapCol || !vePointsSource.parsedLog) return null;
    var pts = vePointsInRange(
      vePointsSample(vePointsSource.parsedLog.rows, rpmCol, mapCol, VE_POINTS_MAX),
      data.rpmBp, data.mapBp);
    return { points: pts, rpmCol: rpmCol, mapCol: mapCol };
  }

  /**
   * Pure surface model for the 3D view (testable in node).
   * dataset: 'before' | 'after' | 'change'.
   * Returns per-NODE { h, rgb } so the renderer can bilinearly subdivide
   * into a smooth continuous surface. Node heights: before/after -> 0..1,
   * change -> -1..1 (signed).
   */
  function veSurfaceModel(data, dataset) {
    var vmin = Infinity, vmax = -Infinity, maxAbs = 0;
    data.before.forEach(function (row) {
      row.forEach(function (v) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      });
    });
    data.deltas.forEach(function (row) {
      row.forEach(function (d) {
        if (d && Math.abs(d.deltaPct) > maxAbs) maxAbs = Math.abs(d.deltaPct);
      });
    });
    var nodes = [];
    for (var r = 0; r < data.rows; r++) {
      var row = [];
      for (var c = 0; c < data.cols; c++) {
        var d = data.deltas[r][c];
        var h, rgb;
        if (dataset === 'change') {
          var dv = d ? d.deltaPct : 0;
          h = maxAbs > 0 ? dv / maxAbs : 0;
          rgb = cssToRgb(d ? trimColor(Math.max(-10, Math.min(10, dv))) : '#232c3a');
        } else {
          var v = dataset === 'before' ? data.before[r][c] : data.after[r][c];
          h = (vmax > vmin) ? (v - vmin) / (vmax - vmin) : 0.5;
          rgb = cssToRgb(veValueColor(v, vmin, vmax));
        }
        row.push({ h: h, rgb: rgb });
      }
      nodes.push(row);
    }
    return { nodes: nodes, rows: data.rows, cols: data.cols };
  }

  /**
   * Interactive 3D VE surface on a canvas. No dependencies — hand-rolled
   * orthographic projection on canvas 2D, so the offline zip still works.
   * Slow auto-rotate, drag to rotate, scroll to zoom. Returns stop().
   * opts (optional): { getShowPoints(), getPoints() } — when getShowPoints()
   * is true, stride-sampled operating points are drawn as small dots just
   * above the surface using the same projection as the surface itself.
   */
  function renderVeSurface(canvas, data, getDataset, opts) {
    var ctx = canvas.getContext('2d');
    var DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var W = 620, H = 440;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = '100%';
    canvas.style.maxWidth = W + 'px';
    canvas.style.height = 'auto';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    var rows = data.rows, cols = data.cols;
    var cx0 = (cols - 1) / 2, cz0 = (rows - 1) / 2;
    var heightScale = Math.min(cols, rows) * 0.55;
    var baseScale = Math.min(W / (cols + 5), H / (rows + 5)) * 0.92;

    var az = -0.65, el = 0.95, zoom = 1;
    var dragging = false, lastX = 0, lastY = 0, lastInteract = 0;
    var AUTO_SPEED = 0.0038; // rad/frame — a full turn takes ~28s
    var raf = 0, stopped = false;

    // Operating-points overlay: the host supplies live getters so the
    // toggle and sample stay in sync without rebuilding the surface.
    var getShowPoints = opts && typeof opts.getShowPoints === 'function'
      ? opts.getShowPoints : function () { return false; };
    var getPoints = opts && typeof opts.getPoints === 'function'
      ? opts.getPoints : function () { return []; };

    // Subdivision quality: each table cell becomes KxK sub-quads with
    // bilinearly interpolated heights/colors for a smooth surface.
    // Drops automatically if the frame rate sags.
    var K = 4, emaDt = 16, lastT = 0;

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function proj(x, y, z) {
      var p = veRotate(x - cx0, y, z - cz0, az, el);
      var s = baseScale * zoom;
      return { sx: W / 2 + p.x1 * s, sy: H / 2 + 14 - p.y2 * s, depth: p.z2 };
    }

    function frame() {
      if (stopped) return;
      var now = Date.now();
      if (!dragging && now - lastInteract > 2500) az += AUTO_SPEED;

      if (typeof performance !== 'undefined' && performance.now) {
        var t = performance.now();
        if (lastT) {
          emaDt = emaDt * 0.94 + (t - lastT) * 0.06;
          if (emaDt > 46 && K > 2) { K--; emaDt = 16; }
        }
        lastT = t;
      }

      var cosA = Math.cos(az), sinA = Math.sin(az);
      var cosE = Math.cos(el), sinE = Math.sin(el);
      var s = baseScale * zoom;
      var ox = W / 2, oy = H / 2 + 14;

      ctx.clearRect(0, 0, W, H);
      var m = veSurfaceModel(data, getDataset());
      var nodes = m.nodes;

      // Subdivided vertex grid shared between sub-quads (no cracks).
      var vR = (rows - 1) * K + 1, vC = (cols - 1) * K + 1;
      var nv = vR * vC;
      var sx = new Array(nv), sy = new Array(nv), dep = new Array(nv);
      var vr = new Array(nv), vg = new Array(nv), vb = new Array(nv);
      var idx = 0;
      for (var vi = 0; vi < vR; vi++) {
        var r0 = Math.min((vi / K) | 0, rows - 2), fv = vi / K - r0, r1 = r0 + 1;
        for (var vj = 0; vj < vC; vj++) {
          var c0 = Math.min((vj / K) | 0, cols - 2), fu = vj / K - c0, c1 = c0 + 1;
          var n00 = nodes[r0][c0], n10 = nodes[r0][c1];
          var n01 = nodes[r1][c0], n11 = nodes[r1][c1];
          var h = veBilinear(n00.h, n10.h, n01.h, n11.h, fu, fv);
          var y = h * heightScale;
          var x = (c0 + fu) - cx0, z = (r0 + fv) - cz0;
          var x1 = x * cosA - z * sinA;
          var z1 = x * sinA + z * cosA;
          var y2 = y * cosE - z1 * sinE;
          var z2 = y * sinE + z1 * cosE;
          sx[idx] = ox + x1 * s;
          sy[idx] = oy - y2 * s;
          dep[idx] = z2;
          vr[idx] = veBilinear(n00.rgb[0], n10.rgb[0], n01.rgb[0], n11.rgb[0], fu, fv);
          vg[idx] = veBilinear(n00.rgb[1], n10.rgb[1], n01.rgb[1], n11.rgb[1], fu, fv);
          vb[idx] = veBilinear(n00.rgb[2], n10.rgb[2], n01.rgb[2], n11.rgb[2], fu, fv);
          idx++;
        }
      }

      var faces = [];
      for (var cr = 0; cr < rows - 1; cr++) {
        for (var cc = 0; cc < cols - 1; cc++) {
          var h00 = nodes[cr][cc].h, h10 = nodes[cr][cc + 1].h;
          var h01 = nodes[cr + 1][cc].h, h11 = nodes[cr + 1][cc + 1].h;
          for (var i = 0; i < K; i++) {
            for (var j = 0; j < K; j++) {
              var a = (cr * K + i) * vC + (cc * K + j);
              var b = a + 1, c2 = a + vC + 1, d2 = a + vC;
              var uc = (j + 0.5) / K, vc = (i + 0.5) / K;
              // Analytic slope of the bilinear patch at the sub-quad center.
              var dhdu = (h10 - h00) * (1 - vc) + (h11 - h01) * vc;
              var dhdv = (h01 - h00) * (1 - uc) + (h11 - h10) * uc;
              var bright = veFaceLight(dhdu * heightScale, dhdv * heightScale,
                                       cosA, sinA, cosE, sinE);
              var fr = (vr[a] + vr[b] + vr[c2] + vr[d2]) * 0.25 * bright;
              var fg = (vg[a] + vg[b] + vg[c2] + vg[d2]) * 0.25 * bright;
              var fb = (vb[a] + vb[b] + vb[c2] + vb[d2]) * 0.25 * bright;
              faces.push({
                a: a, b: b, c: c2, d: d2,
                depth: (dep[a] + dep[b] + dep[c2] + dep[d2]) * 0.25,
                color: 'rgb(' + (fr | 0) + ',' + (fg | 0) + ',' + (fb | 0) + ')'
              });
            }
          }
        }
      }
      faces.sort(function (p, q) { return p.depth - q.depth; }); // far first

      // Zero plane for the change view: translucent reference, drawn first.
      var dataset = getDataset();
      if (dataset === 'change') {
        var zc = [proj(0, 0, 0), proj(cols - 1, 0, 0), proj(cols - 1, 0, rows - 1), proj(0, 0, rows - 1)];
        ctx.beginPath();
        zc.forEach(function (p, i) { if (i) ctx.lineTo(p.sx, p.sy); else ctx.moveTo(p.sx, p.sy); });
        ctx.closePath();
        ctx.fillStyle = 'rgba(120,140,170,0.10)';
        ctx.fill();
      }

      // Operating points: stride-sampled log samples as small dots just
      // above the surface. Drawn before the faces (after the zero plane)
      // so the surface occludes far-side points correctly. Each point is
      // interpolated onto the CURRENT dataset's surface and rotated with
      // the same projection the surface uses.
      if (getShowPoints()) {
        var opPts = getPoints() || [];
        if (opPts.length) {
          var lift = heightScale * 0.04;
          ctx.fillStyle = 'rgba(170,220,255,0.5)';
          for (var pi = 0; pi < opPts.length; pi++) {
            var pm = vePointModel(opPts[pi], m, data, heightScale);
            if (!pm) continue;
            var pr = veRotate(pm.x, pm.y + lift, pm.z, az, el);
            ctx.beginPath();
            ctx.arc(ox + pr.x1 * s, oy - pr.y2 * s, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      for (var fi = 0; fi < faces.length; fi++) {
        var f = faces[fi];
        ctx.beginPath();
        ctx.moveTo(sx[f.a], sy[f.a]);
        ctx.lineTo(sx[f.b], sy[f.b]);
        ctx.lineTo(sx[f.c], sy[f.c]);
        ctx.lineTo(sx[f.d], sy[f.d]);
        ctx.closePath();
        ctx.fillStyle = f.color;
        ctx.fill();
      }

      // Axis labels: RPM along z, MAP along x, ticks at min/mid/max.
      ctx.fillStyle = '#9fa9b8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      function axisLabel(x, z, text) {
        var p = proj(x, 0, z);
        ctx.fillText(text, p.sx, p.sy + 14);
      }
      var midC = (cols - 1) / 2, midR = (rows - 1) / 2;
      var rpmBp = data.rpmBp, mapBp = data.mapBp;
      if (mapBp.length >= 3) {
        axisLabel(0, rows - 1, String(mapBp[0]));
        axisLabel(midC, rows - 1, String(mapBp[Math.floor(mapBp.length / 2)]));
        axisLabel(cols - 1, rows - 1, String(mapBp[mapBp.length - 1]));
      }
      axisLabel(cols - 1 + 0.6, rows - 1, 'MAP kPa');
      if (rpmBp.length >= 3) {
        ctx.textAlign = 'right';
        axisLabel(cols - 1, 0, String(rpmBp[0]));
        axisLabel(cols - 1, midR, String(rpmBp[Math.floor(rpmBp.length / 2)]));
        axisLabel(cols - 1, rows - 1, String(rpmBp[rpmBp.length - 1]));
        ctx.textAlign = 'center';
      }
      axisLabel(cols - 1 + 0.6, 0, 'RPM');

      raf = requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = 'grab';
      lastInteract = Date.now();
    }
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      az += (e.clientX - lastX) * 0.008;
      el = clamp(el + (e.clientY - lastY) * 0.006, 0.2, 1.45);
      lastX = e.clientX; lastY = e.clientY;
      lastInteract = Date.now();
    });
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = clamp(zoom * Math.pow(1.0015, -e.deltaY), 0.5, 2.5);
      lastInteract = Date.now();
    }, { passive: false });

    raf = requestAnimationFrame(frame);
    return function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }

  /* ---------- transmission ---------- */

  function renderTransmission(container, report) {
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
    wrap.innerHTML = html;
    container.appendChild(wrap);
  }

  /* ---------- entry point ---------- */

  function renderDashboard(parts, report, parsedLog, mapResult, history, sessionMeta) {
    if (parts.heatmap) renderHeatmap(parts.heatmap, report.fuelTrims);
    if (parts.coverage) renderCoverage(parts.coverage, report);
    if (parts.trans) renderTransmission(parts.trans, report);
    if (parts.journal) renderJournal(parts.journal, sessionMeta);
    if (parts.regions) renderRegionBars(parts.regions, report);
    if (parts.knock) renderKnockTimeline(parts.knock, parsedLog.rows, mapResult);
    if (parts.lambda) renderLambdaTrace(parts.lambda, parsedLog.rows, mapResult);
    if (parts.comparison) renderComparison(parts.comparison, history || []);
  }

  // Exposed for testing
  P66.renderHeatmap = renderHeatmap;
  P66.renderKnockTimeline = renderKnockTimeline;
  P66.renderLambdaTrace = renderLambdaTrace;
  P66.renderRegionBars = renderRegionBars;
  P66.renderComparison = renderComparison;
  P66.renderCoverage = renderCoverage;
  P66.renderTransmission = renderTransmission;
  P66.renderJournal = renderJournal;
  P66.veComparisonData = veComparisonData;
  P66.renderVeComparison = renderVeComparison;
  P66.veSurfaceModel = veSurfaceModel;
  P66.renderVeSurface = renderVeSurface;
  P66.setVePointsSource = setVePointsSource;
  P66.vePointsSample = vePointsSample;
  P66.vePointsInRange = vePointsInRange;
  P66.veAxisFrac = veAxisFrac;
  P66.vePointModel = vePointModel;
  P66._vePointsResolve = vePointsResolve;
  P66.VE_POINTS_MAX = VE_POINTS_MAX;
  P66._veRotate = veRotate;
  P66._veBilinear = veBilinear;
  P66._veFaceLight = veFaceLight;
  P66.renderDashboard = renderDashboard;
  P66._trimColor = trimColor;
  P66._valueRamp = valueRamp;
  P66._cellTextColor = cellTextColor;
  P66._sortedBins = sortedBins;
  P66._downsample = downsample;
  P66._compareMetrics = compareMetrics;
})(typeof window !== 'undefined' ? window : global);
