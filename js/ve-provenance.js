/* P66-Tuner VE cell provenance
 * Answers one question per table cell: did any log samples actually
 * inform this cell's tuned value, or was the value filled in from its
 * neighbors?
 *
 *   P66.veCellProvenance(report, tableName, opts) -> {
 *     available, reason, tableName, rows, cols, rpmBp, mapBp,
 *     cells: [[ { row, col, kind, samples, confidence, tier, rpm, map } ]],
 *     measuredCount, interpolatedCount, totalSamples
 *   }
 *   P66.veProvenanceClass(cell)  -> 've-prov-measured ve-prov-high' |
 *                                   've-prov-interp ve-prov-far' | ...
 *   P66.veProvenanceColor(cell, baseColor) -> rgb() string, interpolated
 *                                   cells desaturated toward UI neutral
 *   P66.veProvenanceTip(cell)    -> 'Measured — 42 log samples' |
 *                                   'Interpolated — no direct samples, blended from neighbors'
 *   P66.veProvenanceLegendHTML() -> small legend snippet
 *
 * measured vs interpolated
 * ------------------------
 * A cell is MEASURED when the analyzer attributed log samples to it:
 * any report.fuelTrims cell with samples > 0 whose idleFraction routes it
 * to this table (idleFraction >= 0.5 -> 'Idle VE', else 'Main VE' —
 * exactly the routing rule js/tuner.js uses) and whose RPM/MAP bin range
 * covers the table cell's breakpoint (the same "breakpoint inside bin
 * range" mapping js/xdf-map.js mapTrimCellToVE uses). All of the trim
 * cell's samples count toward each mapped table cell, because the tune's
 * delta for each of those cells was computed from that whole sample set.
 *
 * A cell is INTERPOLATED when no routed trim cell covers it: its value
 * came from smoothing/neighbor-fill (e.g. the patcher's tapered buffer
 * rings, shown italic in the grid) or it was simply never touched.
 *
 * confidence (0-1)
 * ----------------
 * measured:      min(1, samples / 30). 30 is the conservative
 *                minCellSamples gate — a cell with 30+ samples is fully
 *                trusted, fewer scales linearly down.
 * interpolated:  1 / (1 + d), where d is the Chebyshev distance in grid
 *                steps to the nearest measured cell (multi-source BFS:
 *                adjacent = 1 -> 0.5, two rings out = 2 -> 0.33, ...).
 *                Zero measured cells anywhere -> 0. Simple inverse-distance
 *                on the grid; nothing fancier, and the number is meant to
 *                say "how close is the nearest real evidence", not to model
 *                the smoothing math.
 *
 * tiers (for class hooks)
 * -----------------------
 * measured:      high >= 0.67, medium >= 0.34, low below
 * interpolated:  near >= 0.5, mid >= 0.25, far below
 *
 * Styling contract — FUEL COLORS ARE SACRED
 * -----------------------------------------
 * Provenance never uses blue/red semantics (blue = lean/add fuel,
 * red = rich/remove fuel). The distinction is texture, not hue:
 *
 *   - grid cells: add a class hook; the recommended CSS (below) draws a
 *     diagonal hatch over INTERPOLATED cells and a solid light swatch for
 *     MEASURED ones. No color is redefined for either.
 *   - 3D surface: P66.veProvenanceColor() desaturates interpolated cells
 *     toward the UI neutral [38,48,62] (the dashboard trim ramp's neutral
 *     stop) while keeping the original hue direction — a lean/add-fuel
 *     interpolated cell still reads faintly blue, just "greyed out" so it
 *     scans as less trustworthy. Measured cells pass through untouched.
 *
 * Recommended CSS for the coordinator (do NOT put blue/red here):
 *
 *   .ve-prov-interp {
 *     background-image: repeating-linear-gradient(
 *       45deg, rgba(255,255,255,0.16) 0 3px, transparent 3px 7px);
 *   }
 *   .ve-prov-legend .ve-prov-swatch { display:inline-block; width:0.9em;
 *     height:0.9em; border:1px solid #8a93a5; vertical-align:-0.12em;
 *     margin-right:0.35em; }
 *   .ve-prov-legend .ve-prov-measured { background:#cfd6e4; }
 *   .ve-prov-legend .ve-prov-interp {
 *     background:#3a4354; background-image: repeating-linear-gradient(
 *       45deg, rgba(255,255,255,0.25) 0 2px, transparent 2px 5px); }
 *
 * Integration notes for the coordinator
 * -------------------------------------
 * - Build once per table: var prov = P66.veCellProvenance(report, tableName)
 *   where tableName is the same string passed to veComparisonData
 *   ('Main VE' / 'Idle VE'). Geometry comes from the bundled catalog's
 *   table descriptor, the same source the grid reads, so indices align:
 *   prov.cells[r][c] matches the grid's (r, c) and the 3D model's nodes.
 * - renderVeComparison currently does not receive the session report —
 *   it must be threaded in (from the analysis state) so provenance has
 *   report.fuelTrims.cells to work from.
 * - grid: append P66.veProvenanceClass(prov.cells[r][c]) to each td's
 *   class list (classList.add is safer than overwriting className, since
 *   've-unchanged' already uses className) and append
 *   P66.veProvenanceTip(prov.cells[r][c]) to the tooltip.
 * - 3D: in veSurfaceModel's node loop, after computing rgb, call
 *   P66.veProvenanceColor(prov.cells[r][c], 'rgb(r,g,b)') before the
 *   subdivision smoothing runs.
 * - opts override: veCellProvenance(report, name, { catalog }) for a
 *   non-bundled XDF catalog, or { axes: { rows, cols, rpmBp, mapBp } }
 *   for a custom geometry (tests use this).
 *
 * Narrowband only — this module consumes trim/O2-derived sample counts;
 * nothing here touches wideband logic. Works in browser and node.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Full-confidence sample count: mirrors the conservative
  // minCellSamples gate in js/tuner.js (a cell with this many samples
  // is actionable in every confidence mode).
  var FULL_CONFIDENCE_SAMPLES = 30;

  // Dashboard trim ramp's neutral stop — the desaturation target for
  // interpolated cells in the 3D view. Not a semantic color of its own.
  var NEUTRAL = [38, 48, 62];

  function round3(v) { return Math.round(v * 1000) / 1000; }

  function makeGrid(rows, cols, fill) {
    var g = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) row.push(fill);
      g.push(row);
    }
    return g;
  }

  // Parse "2000-2500" -> [2000, 2500]. Same grammar as
  // js/xdf-map.js parseBinLabel (kept local: no cross-module load order).
  function parseBinLabel(label) {
    var m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(label || '').trim());
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  }

  function axisBreakpoints(axis) {
    return ((axis && axis.labels) || []).map(function (l) { return parseFloat(l); })
      .filter(function (v) { return isFinite(v); });
  }

  function findVeTable(catalog, tableName) {
    if (!catalog || !catalog.tables) return null;
    var want = String(tableName || '').trim().toLowerCase();
    var i, t, title;
    for (i = 0; i < catalog.tables.length; i++) {
      t = catalog.tables[i];
      title = String(t.title || '').trim().toLowerCase();
      if (title === want) return t;
    }
    for (i = 0; i < catalog.tables.length; i++) {
      t = catalog.tables[i];
      title = String(t.title || '').trim().toLowerCase();
      if (title.indexOf(want) !== -1) return t;
    }
    return null;
  }

  // Geometry for a named VE table from an XDF catalog: rows/cols from the
  // descriptor (same fields js/xdf-map.js readTable uses), breakpoints
  // from the axis labels.
  function tableGeometry(catalog, tableName) {
    var t = findVeTable(catalog, tableName);
    if (!t) return null;
    var rows = parseInt(t.rows, 10) || axisBreakpoints(t.yAxis).length;
    var cols = parseInt(t.cols, 10) || axisBreakpoints(t.xAxis).length;
    if (!rows || !cols) return null;
    return {
      rows: rows,
      cols: cols,
      rpmBp: axisBreakpoints(t.yAxis),
      mapBp: axisBreakpoints(t.xAxis)
    };
  }

  // Map an analyzer trim cell ({ rpmBin: "2000-2500", mapBin: "80-90" })
  // to table grid cells: every breakpoint inside the bin range.
  // Same rule as js/xdf-map.js mapTrimCellToVE.
  function mapTrimCellToGrid(trimCell, geo) {
    var rpmRange = parseBinLabel(trimCell.rpmBin);
    var mapRange = parseBinLabel(trimCell.mapBin);
    if (!rpmRange || !mapRange) return [];
    var hits = [];
    geo.rpmBp.forEach(function (rpm, r) {
      if (rpm < rpmRange[0] || rpm > rpmRange[1]) return;
      geo.mapBp.forEach(function (map, c) {
        if (map < mapRange[0] || map > mapRange[1]) return;
        hits.push({ row: r, col: c });
      });
    });
    return hits;
  }

  function measuredTier(conf) {
    if (conf >= 0.67) return 'high';
    if (conf >= 0.34) return 'medium';
    return 'low';
  }

  function interpTier(conf) {
    if (conf >= 0.5) return 'near';
    if (conf >= 0.25) return 'mid';
    return 'far';
  }

  /**
   * Build per-cell provenance for one VE table.
   * report    session report (uses report.fuelTrims.cells: each with
   *           rpmBin, mapBin, samples, idleFraction)
   * tableName 'Main VE' | 'Idle VE' (case-insensitive; 'idle' routes idle)
   * opts      { catalog, axes } — catalog defaults to P66.BUNDLED_CATALOG;
   *           axes: { rows, cols, rpmBp, mapBp } overrides geometry
   */
  function veCellProvenance(report, tableName, opts) {
    opts = opts || {};
    var geo = null;
    if (opts.axes && opts.axes.rows && opts.axes.cols) {
      geo = {
        rows: opts.axes.rows,
        cols: opts.axes.cols,
        rpmBp: opts.axes.rpmBp || [],
        mapBp: opts.axes.mapBp || []
      };
    } else {
      geo = tableGeometry(opts.catalog || P66.BUNDLED_CATALOG, tableName);
    }

    var result = {
      available: false,
      reason: '',
      tableName: tableName,
      rows: 0,
      cols: 0,
      rpmBp: [],
      mapBp: [],
      cells: [],
      measuredCount: 0,
      interpolatedCount: 0,
      totalSamples: 0
    };
    if (!geo) {
      result.reason = 'No table geometry for "' + tableName +
        '" — catalog has no matching table and no axes were supplied.';
      return result;
    }
    result.available = true;
    result.rows = geo.rows;
    result.cols = geo.cols;
    result.rpmBp = geo.rpmBp;
    result.mapBp = geo.mapBp;

    // The tuner routes majority-idle trim cells to Idle VE and everything
    // else to Main VE (js/tuner.js fuelSuggestions). Provenance uses the
    // same rule so it describes the cells the tuner would actually patch.
    var isIdleTable = /idle/i.test(String(tableName || ''));

    var sampleGrid = makeGrid(geo.rows, geo.cols, 0);
    var fuel = report && report.fuelTrims;
    if (fuel && fuel.available !== false && fuel.cells) {
      fuel.cells.forEach(function (fc) {
        var fcIdle = (fc.idleFraction || 0) >= 0.5;
        if (fcIdle !== isIdleTable) return; // belongs to the other VE table
        var n = fc.samples || 0;
        if (n <= 0) return;
        mapTrimCellToGrid(fc, geo).forEach(function (h) {
          sampleGrid[h.row][h.col] += n;
          result.totalSamples += n;
        });
      });
    }

    // Chebyshev distance from each cell to the nearest measured cell,
    // multi-source BFS (8-neighborhood: the same "ring" notion the
    // patcher's smoothing buffer uses).
    var dist = makeGrid(geo.rows, geo.cols, Infinity);
    var queue = [];
    for (var r = 0; r < geo.rows; r++) {
      for (var c = 0; c < geo.cols; c++) {
        if (sampleGrid[r][c] > 0) {
          dist[r][c] = 0;
          queue.push([r, c]);
        }
      }
    }
    while (queue.length) {
      var cur = queue.shift();
      var cr = cur[0], cc = cur[1];
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          var nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= geo.rows || nc >= geo.cols) continue;
          if (dist[nr][nc] > dist[cr][cc] + 1) {
            dist[nr][nc] = dist[cr][cc] + 1;
            queue.push([nr, nc]);
          }
        }
      }
    }

    for (var r2 = 0; r2 < geo.rows; r2++) {
      var row = [];
      for (var c2 = 0; c2 < geo.cols; c2++) {
        var n2 = sampleGrid[r2][c2];
        var cell;
        if (n2 > 0) {
          var conf = round3(Math.min(1, n2 / FULL_CONFIDENCE_SAMPLES));
          cell = {
            row: r2, col: c2, kind: 'measured', samples: n2,
            confidence: conf, tier: measuredTier(conf),
            rpm: geo.rpmBp[r2] !== undefined ? geo.rpmBp[r2] : null,
            map: geo.mapBp[c2] !== undefined ? geo.mapBp[c2] : null
          };
          result.measuredCount++;
        } else {
          var d = dist[r2][c2];
          var conf2 = d === Infinity ? 0 : round3(1 / (1 + d));
          cell = {
            row: r2, col: c2, kind: 'interpolated', samples: 0,
            confidence: conf2, tier: interpTier(conf2),
            rpm: geo.rpmBp[r2] !== undefined ? geo.rpmBp[r2] : null,
            map: geo.mapBp[c2] !== undefined ? geo.mapBp[c2] : null
          };
          result.interpolatedCount++;
        }
        row.push(cell);
      }
      result.cells.push(row);
    }

    return result;
  }

  /**
   * CSS class hook for the Before/After/Change grid renderer.
   * Append (classList.add) — never overwrite the cell's existing classes.
   */
  function veProvenanceClass(cell) {
    if (!cell) return '';
    if (cell.kind === 'measured') return 've-prov-measured ve-prov-' + cell.tier;
    if (cell.kind === 'interpolated') return 've-prov-interp ve-prov-' + cell.tier;
    return '';
  }

  function parseCssColor(s) {
    var str = String(s || '').trim();
    var m = /^#([0-9a-fA-F]{6})$/.exec(str);
    if (m) {
      return [
        parseInt(m[1].slice(0, 2), 16),
        parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16)
      ];
    }
    m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(str);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    return null;
  }

  /**
   * Color hook for the 3D surface. Measured cells pass through untouched.
   * Interpolated cells are desaturated toward the UI neutral — the hue
   * direction (blue = lean/add, red = rich/remove) survives so the change
   * meaning stays readable, but the cell scans as greyed out, i.e. less
   * trustworthy. No provenance-specific blue/red semantics are introduced.
   */
  function veProvenanceColor(cell, baseColor) {
    if (!cell || cell.kind !== 'interpolated') return baseColor;
    var rgb = parseCssColor(baseColor);
    if (!rgb) return baseColor;
    var mix = 0.65; // how far toward neutral the interpolated cell moves
    var out = rgb.map(function (v, i) {
      return Math.max(0, Math.min(255, Math.round(v + (NEUTRAL[i] - v) * mix)));
    });
    return 'rgb(' + out.join(',') + ')';
  }

  /**
   * Plain-language tooltip for one cell.
   */
  function veProvenanceTip(cell) {
    if (!cell) return '';
    if (cell.kind === 'measured') {
      var tip = 'Measured — ' + cell.samples + ' log sample' +
        (cell.samples === 1 ? '' : 's');
      if (cell.tier === 'low') tip += ' (thin)';
      return tip;
    }
    if (cell.kind === 'interpolated') {
      return 'Interpolated — no direct samples, blended from neighbors';
    }
    return '';
  }

  /**
   * Small legend snippet. The swatches use the same classes the grid
   * renderer adds, so the coordinator's CSS covers both. No blue/red.
   */
  function veProvenanceLegendHTML() {
    return '<span class="ve-prov-legend">' +
      '<span class="ve-prov-key"><span class="ve-prov-swatch ve-prov-measured"></span>' +
      'Measured — cell had direct log samples</span> ' +
      '<span class="ve-prov-key"><span class="ve-prov-swatch ve-prov-interp"></span>' +
      'Interpolated — filled from neighbors, no direct samples</span>' +
      '</span>';
  }

  P66.veCellProvenance = veCellProvenance;
  P66.veProvenanceClass = veProvenanceClass;
  P66.veProvenanceColor = veProvenanceColor;
  P66.veProvenanceTip = veProvenanceTip;
  P66.veProvenanceLegendHTML = veProvenanceLegendHTML;
})(typeof window !== 'undefined' ? window : global);
