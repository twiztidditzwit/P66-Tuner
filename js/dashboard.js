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

  // Diverging color for trim %: blue (rich) -> neutral -> red (lean).
  function trimColor(t) {
    var c = Math.max(-10, Math.min(10, t)) / 10; // -1..1
    var neutral = [38, 48, 62];
    var target = c >= 0 ? [248, 81, 73] : [88, 166, 255];
    var k = Math.abs(c);
    var rgb = neutral.map(function (n, i) {
      return Math.round(n + (target[i] - n) * k);
    });
    return 'rgb(' + rgb.join(',') + ')';
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
      '<span class="swatch" style="background:#d29922"></span> wideband ' +
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

  /* ---------- entry point ---------- */

  function renderDashboard(parts, report, parsedLog, mapResult, history) {
    if (parts.heatmap) renderHeatmap(parts.heatmap, report.fuelTrims);
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
  P66.renderDashboard = renderDashboard;
  P66._trimColor = trimColor;
  P66._sortedBins = sortedBins;
  P66._downsample = downsample;
  P66._compareMetrics = compareMetrics;
})(typeof window !== 'undefined' ? window : global);
