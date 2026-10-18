/* P66-Tuner trim heatmap
 *
 * Per-cell BLM (long-term trim) / INT (short-term trim) heatmap on the
 * analyzer's VE aggregation grid — 500 RPM x 10 kPa bins, the exact bin
 * edges analyzeFuelTrims() in js/analyzer.js uses (its local rpmBin/
 * mapBin defaults of 500/10), so this heatmap overlays the fuel-trim
 * cells conceptually. The dashboard's trim grid (js/dashboard.js
 * renderHeatmap) bins on the same edges.
 *
 * NARROWBAND ONLY: BLM/INT are the narrowband fuel trims. There is no
 * wideband channel anywhere in this codebase and none in this module.
 *
 * SAMPLE QUALITY: rows pass through P66.qualityRows() — the exact gate
 * analyzeFuelTrims uses (cold-warmup rows and transient rows excluded)
 * — not a reimplementation.
 *
 * COLOR CONVENTION (mandatory, same as everywhere else):
 *   blue = adding fuel / positive trim / lean
 *   red  = removing fuel / negative trim / rich
 * Implemented by P66._trimColor from js/dashboard.js when that file is
 * loaded, with an identical local fallback when it is not.
 *
 * LAYER TOGGLE: buildTrimHeatmap() computes BOTH layers into every cell
 * ({ blmAvg, intAvg, count, thin }), so the UI can switch between the BLM
 * and INT layers by calling renderTrimHeatmapHTML(hm, { layer: 'int' })
 * with no recomputation — pure re-render.
 *
 * Plain script — attaches to the global P66 namespace (browser + node
 * compatible). The DOM stays out of the core: buildTrimHeatmap() is pure
 * data prep (node-testable); renderTrimHeatmapHTML() returns an HTML
 * string.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Exact bin edges of the fuel-trim/VE aggregation grid in analyzer.js
  // (rpmBin width 500, mapBin width 10). Bin "500-1000" holds [500,1000).
  var RPM_BIN_WIDTH = 500, MAP_BIN_WIDTH = 10;

  // Thin-data threshold: cells with fewer samples are faded + flagged.
  var DEFAULT_MIN_SAMPLES = 25;

  // Neutral empty-cell fill — same as dashboard.js renderHeatmap's
  // chart-empty rect fill.
  var NEUTRAL_FILL = '#141a23';

  function rpmBinOf(rpm) {
    var b = Math.floor(rpm / RPM_BIN_WIDTH) * RPM_BIN_WIDTH;
    return b + '-' + (b + RPM_BIN_WIDTH);
  }
  function mapBinOf(map) {
    var b = Math.floor(map / MAP_BIN_WIDTH) * MAP_BIN_WIDTH;
    return b + '-' + (b + MAP_BIN_WIDTH);
  }
  function binLo(label) {
    var m = /^(-?\d+)/.exec(label);
    return m ? parseInt(m[1], 10) : 0;
  }
  function byBinLo(a, b) { return binLo(a) - binLo(b); }
  function round2(v) { return Math.round(v * 100) / 100; }
  function nn(v) { return v !== v ? null : v; } // NaN -> null

  function sampleColumn(t, name, max) {
    max = max || 500;
    var out = [];
    var c = name ? P66.numView(t, name) : null;
    if (!c) return out;
    for (var i = 0; i < t.rowCount && out.length < max; i++) {
      var v = c[i];
      if (v === v) out.push(v);
    }
    return out;
  }

  /**
   * Trim color, blue = lean/adding-fuel (+), red = rich/removing-fuel (-).
   * Delegates to P66._trimColor (dashboard.js) when it is loaded so every
   * view shares one mapping; the fallback below is that same mapping
   * re-implemented (two-stop per side, clamped at +/-10%).
   */
  function trimColor(t) {
    if (typeof P66._trimColor === 'function') return P66._trimColor(t);
    var c = Math.max(-10, Math.min(10, t)) / 10; // -1..1
    var k = Math.abs(c);
    var neutral = [38, 48, 62];
    var mid = c >= 0 ? [80, 200, 255] : [255, 171, 64]; // cyan / orange
    var hi = c >= 0 ? [56, 120, 255] : [255, 77, 60];   // blue / red
    var a, b, f;
    if (k <= 0.5) { a = neutral; b = mid; f = k / 0.5; }
    else { a = mid; b = hi; f = (k - 0.5) / 0.5; }
    var rgb = a.map(function (v, i) { return Math.round(v + (b[i] - v) * f); });
    return 'rgb(' + rgb.join(',') + ')';
  }

  /**
   * Readable text over a data-cell background: dark on bright cells,
   * inherit (light) on dark cells. Delegates to P66._cellTextColor
   * (dashboard.js); the fallback repeats its luminance rule.
   */
  function cellTextColor(bg) {
    if (typeof P66._cellTextColor === 'function') return P66._cellTextColor(bg);
    var m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(bg);
    if (!m) return '';
    var lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
    return lum > 140 ? '#141a23' : '';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * P66.buildTrimHeatmap(table, features, opts)
   *
   * Builds a per-cell BLM/INT heatmap over the analyzer's RPM x MAP
   * aggregation grid.
   *
   *   table     columnar log table (P66.parseLogText) or legacy row array.
   *   features  optional P66.extractFeatures() output for the same table —
   *             handed through to P66.qualityRows() so the gate reuses the
   *             session's single-pass features instead of rebuilding them.
   *   opts      { mapResult (required), layer, minSamples, rpmWidth, mapWidth }
   *             rpmWidth/mapWidth are accepted for tests only — production
   *             callers must leave the 500/10 defaults alone so the grid
   *             stays edge-aligned with analyzeFuelTrims().
   *
   * Returns:
   *   { available, rpmBins, mapBins, cells, minSamples, gating }
   * where cells is a 2D grid — cells[mapIndex][rpmIndex], MAP bins ascending,
   * RPM bins ascending — and each cell is null (no samples) or
   *   { blmAvg, intAvg, count, thin }
   * Both layers live in every cell: the UI toggles layers without
   * recomputation (see renderTrimHeatmapHTML layer option).
   */
  function buildTrimHeatmap(table, features, opts) {
    opts = opts || {};
    var mapResult = opts.mapResult;
    var t = P66.asTable(table);
    if (!t || !mapResult) {
      return { available: false, reason: 'Need a log table and channel mapping.' };
    }
    var banks = (typeof P66.fuelTrimBanks === 'function')
      ? P66.fuelTrimBanks(mapResult) : [];
    var rpmName = P66.columnFor(mapResult, 'RPM');
    var mapName = P66.columnFor(mapResult, 'MAP');
    var rpmC0 = rpmName ? P66.numView(t, rpmName) : null;
    var mapC0 = mapName ? P66.numView(t, mapName) : null;
    if (!banks.length || !rpmC0 || !mapC0) {
      return { available: false,
        reason: 'Need STFT/INT and/or LTFT/BLM trim, RPM and MAP channels.' };
    }

    // Sample-quality gating — the same gate analyzeFuelTrims uses.
    // Cold (below ECT warmup threshold) and transient rows never reach
    // the averaging loop.
    var q = P66.qualityRows(t, mapResult, features);
    var gt = P66.asTable(q.rows);
    var rpmC = P66.numView(gt, rpmName);
    var mapC = P66.numView(gt, mapName);

    // Per-column encoding detection on the gated table, like analyzeFuelTrims.
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(gt, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(gt, b.ltft)) : 'percent'
      };
    });
    var trimCols = banks.map(function (b) {
      return {
        stft: b.stft ? P66.numView(gt, b.stft) : null,
        ltft: b.ltft ? P66.numView(gt, b.ltft) : null
      };
    });

    var acc = {}; // "rpmBin|mapBin" -> { n, blm, int }
    for (var i = 0; i < gt.rowCount; i++) {
      var rpm = rpmC[i], map = mapC[i];
      if (rpm !== rpm || map !== map) continue;
      var blm = 0, intg = 0;
      for (var bi = 0; bi < banks.length; bi++) {
        var tc = trimCols[bi];
        intg += tc.stft ? P66.trimToPct(nn(tc.stft[i]), styles[bi].stft) : 0;
        blm  += tc.ltft ? P66.trimToPct(nn(tc.ltft[i]), styles[bi].ltft) : 0;
      }
      blm /= banks.length; intg /= banks.length;
      var key = rpmBinOf(rpm) + '|' + mapBinOf(map);
      var c = acc[key] || (acc[key] = { n: 0, blm: 0, int: 0 });
      c.n++; c.blm += blm; c.int += intg;
    }

    var rpmSeen = {}, mapSeen = {};
    Object.keys(acc).forEach(function (key) {
      var parts = key.split('|');
      rpmSeen[parts[0]] = true;
      mapSeen[parts[1]] = true;
    });
    var rpmBins = Object.keys(rpmSeen).sort(byBinLo);
    var mapBins = Object.keys(mapSeen).sort(byBinLo);

    var minSamples = (opts.minSamples !== undefined && opts.minSamples !== null)
      ? opts.minSamples : DEFAULT_MIN_SAMPLES;
    var cells = mapBins.map(function (mb) {
      return rpmBins.map(function (rb) {
        var c = acc[rb + '|' + mb];
        if (!c) return null;
        return {
          blmAvg: round2(c.blm / c.n),
          intAvg: round2(c.int / c.n),
          count: c.n,
          thin: c.n < minSamples
        };
      });
    });

    return {
      available: true,
      rpmBins: rpmBins,
      mapBins: mapBins,
      cells: cells,
      minSamples: minSamples,
      gating: {
        gatedWarmup: q.gatedWarmup,
        gatedTransient: q.gatedTransient,
        ectAvailable: q.ectAvailable,
        note: q.warmNote
      }
    };
  }

  function fmtTrim(v) {
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function layerLabel(layer) {
    return layer === 'int' ? 'INT (short-term)' : 'BLM (long-term)';
  }

  /**
   * P66.renderTrimHeatmapHTML(heatmap, opts) -> HTML string.
   *
   * Grid table: MAP bins as rows (high load on top), RPM bins as columns.
   * Cell fill = trimColor(layer value) with intensity proportional to
   * |trim|; zero-sample cells render neutral with a "no data" tooltip;
   * thin cells (count < minSamples) are faded with a dashed edge and a
   * "n=X — thin data" tooltip. Every cell carries a title tooltip with
   * BLM/INT/count.
   *
   * opts.layer: 'blm' (default) | 'int'. Because buildTrimHeatmap puts
   * both layers in every cell, the dashboard can render the toggle as a
   * pure re-render with no recomputation.
   */
  function renderTrimHeatmapHTML(heatmap, opts) {
    opts = opts || {};
    var layer = opts.layer === 'int' ? 'int' : 'blm';
    var valueOf = layer === 'int'
      ? function (c) { return c.intAvg; }
      : function (c) { return c.blmAvg; };

    if (!heatmap || !heatmap.available || !heatmap.cells || !heatmap.cells.length) {
      return '<p class="muted">No fuel trim data for heatmap.</p>';
    }
    var rpmBins = heatmap.rpmBins, mapBins = heatmap.mapBins;

    var html = '<div class="trim-heatmap" data-layer="' + layer + '">';
    html += '<p class="trim-legend muted">' + escHtml(layerLabel(layer)) +
      ' per RPM x MAP cell (BLM/INT toggle needs no recompute). ' +
      '<span class="swatch" style="background:' + escHtml(trimColor(-10)) + '"></span> rich (−) ' +
      '<span class="swatch" style="background:' + escHtml(trimColor(0)) + '"></span> stoich ' +
      '<span class="swatch" style="background:' + escHtml(trimColor(10)) + '"></span> lean (+)' +
      '</p>';
    html += '<table class="trim-grid"><thead><tr><th></th>';
    rpmBins.forEach(function (rb) {
      html += '<th>' + escHtml(rb) + '</th>';
    });
    html += '<th class="trim-axis">RPM</th></tr></thead><tbody>';

    // High MAP on top, matching the VE grids.
    for (var r = mapBins.length - 1; r >= 0; r--) {
      var mb = mapBins[r];
      html += '<tr><th>' + escHtml(mb) + '</th>';
      for (var ci = 0; ci < rpmBins.length; ci++) {
        var cell = heatmap.cells[r][ci];
        if (!cell) {
          html += '<td class="trim-cell trim-empty" title="' +
            escHtml(rpmBins[ci] + ' RPM / ' + mb + ' kPa: no data') +
            '" style="background:' + NEUTRAL_FILL + '">—</td>';
          continue;
        }
        var v = valueOf(cell);
        var bg = trimColor(Math.max(-10, Math.min(10, v)));
        var tip = rpmBins[ci] + ' RPM / ' + mb + ' kPa: BLM ' + fmtTrim(cell.blmAvg) +
          ', INT ' + fmtTrim(cell.intAvg) + ', n=' + cell.count;
        var cls = 'trim-cell', style = 'background:' + bg + ';';
        if (cell.thin) {
          // De-emphasize thin data: faded fill + dashed edge.
          cls += ' trim-thin';
          style += 'opacity:0.45;border:1px dashed #8b93a3;';
          tip += ' — thin data';
        } else {
          var fg = cellTextColor(bg);
          if (fg) style += 'color:' + fg + ';';
        }
        html += '<td class="' + cls + '" title="' + escHtml(tip) +
          '" style="' + escHtml(style) + '">' + escHtml(fmtTrim(v)) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '<p class="trim-axis muted">MAP kPa</p>';
    if (heatmap.gating && heatmap.gating.note) {
      html += '<p class="muted trim-gating">' + escHtml(heatmap.gating.note) + '</p>';
    }
    html += '</div>';
    return html;
  }

  // Expose bin-edge constants so the dashboard (and tests) can assert
  // alignment with the fuel-trim aggregation grid.
  P66.TRIM_HEATMAP_RPM_WIDTH = RPM_BIN_WIDTH;
  P66.TRIM_HEATMAP_MAP_WIDTH = MAP_BIN_WIDTH;
  P66.buildTrimHeatmap = buildTrimHeatmap;
  P66.renderTrimHeatmapHTML = renderTrimHeatmapHTML;
  P66._trimHeatmapColor = trimColor;

})(typeof window !== 'undefined' ? window : global);

/* ---- dashboard wiring (for the coordinator; not executed here) ----
 *
 * // In the Fuel tab, next to the existing trim grid:
 * var hm = P66.buildTrimHeatmap(table, features, { mapResult: mapResult });
 * panel.innerHTML = P66.renderTrimHeatmapHTML(hm, { layer: 'blm' });
 *
 * // Layer toggle buttons re-render the same heatmap object — no
 * // recomputation (both BLM and INT live in every cell):
 * blmBtn.onclick = function () { panel.innerHTML = P66.renderTrimHeatmapHTML(hm, { layer: 'blm' }); };
 * intBtn.onclick = function () { panel.innerHTML = P66.renderTrimHeatmapHTML(hm, { layer: 'int' }); };
 */
