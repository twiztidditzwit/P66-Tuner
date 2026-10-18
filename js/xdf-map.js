/* P66-Tuner XDF/binary mapper
 * Bridges the analyzer's trim cells to concrete binary patches using an
 * XDF catalog (from tools/xdf-parse.js) and the target binary image.
 *
 *   P66.findTable(catalog, 'Main VE')
 *   P66.readTable(catalog, 'Main VE', binBytes) -> { rows, cols, values[][] }
 *   P66.mapTrimCellToVE(trimCell, veTable) -> [{ row, col, rpm, map }]
 *   P66.applyFuelSuggestions(catalog, binBytes, suggestions)
 *       -> { patches: [{ table, address, sizeBytes, oldValue, newValue, deltaPct, rpm, map }],
 *            patched: Uint8Array|null }
 *
 * - By default applyFuelSuggestions smooths the result: cells corrected from
 *   trim data keep their full delta, and up to two rings of uncorrected
 *   neighbors are tapered toward them (50%, 25%) so the table has no cliffs.
 *   Pass { smooth: false } to restore raw per-cell patching, or custom
 *   { rings: [{ radius, factor }] }. Buffer cells are flagged smoothed: true.
 *
 * Notes:
 * - 68HC11 is big-endian; 16-bit table elements are read/written BE.
 * - patched binary is returned WITHOUT checksum correction — the P66 XDF
 *   carries no checksum definition, so the result must be validated
 *   (checksum fix + bench test) before flashing.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  function findTable(catalog, name) {
    var tables = catalog.tables || [];
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].title === name) return tables[i];
    }
    // Fallback: case-insensitive contains.
    var lower = name.toLowerCase();
    for (var j = 0; j < tables.length; j++) {
      if (tables[j].title.toLowerCase().indexOf(lower) !== -1) return tables[j];
    }
    return null;
  }

  function parseAddr(a) {
    if (typeof a === 'number') return a;
    var s = String(a || '').trim();
    return s.slice(0, 2).toLowerCase() === '0x' ? parseInt(s, 16) : parseInt(s, 10);
  }

  function elementBytes(table) {
    var bits = parseInt(table.elementSizeBits || '8', 10);
    return bits === 16 ? 2 : 1;
  }

  function readRaw(binBytes, address, sizeBytes) {
    if (sizeBytes === 2) {
      return (binBytes[address] << 8) | binBytes[address + 1]; // big-endian
    }
    return binBytes[address];
  }

  function writeRaw(binBytes, address, sizeBytes, value) {
    var v = Math.max(0, Math.round(value));
    if (sizeBytes === 2) {
      v = Math.min(0xFFFF, v);
      binBytes[address] = (v >> 8) & 0xFF;
      binBytes[address + 1] = v & 0xFF;
    } else {
      binBytes[address] = Math.min(0xFF, v);
    }
  }

  /**
   * Read a table's raw values from the binary. Returns null when the table
   * or its geometry is incomplete.
   */
  function readTable(catalog, name, binBytes) {
    var t = findTable(catalog, name);
    if (!t || !t.address) return null;
    // 1D tables may omit cols (or rows); default the missing dim to 1.
    var rows = parseInt(t.rows, 10) || 1;
    var cols = parseInt(t.cols, 10) || 1;
    var base = parseAddr(t.address);
    var eb = elementBytes(t);
    var values = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) {
        var addr = base + (r * cols + c) * eb;
        if (addr + eb > binBytes.length) return null;
        row.push(readRaw(binBytes, addr, eb));
      }
      values.push(row);
    }
    return { table: t, rows: rows, cols: cols, values: values, elementBytes: eb, base: base };
  }

  function axisBreakpoints(axis) {
    return (axis.labels || []).map(function (l) { return parseFloat(l); })
      .filter(function (v) { return isFinite(v); });
  }

  // Parse "2000-2500" -> [2000, 2500].
  function parseBinLabel(label) {
    var m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(label).trim());
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  }

  /**
   * Map an analyzer trim cell ({ rpmBin: "2000-2500", mapBin: "80-90" })
   * to concrete VE table cells via axis breakpoints.
   * Returns [{ row, col, rpm, map }] — every VE cell whose breakpoint
   * falls inside the trim cell's range.
   */
  function mapTrimCellToVE(trimCell, veTable) {
    var rpmRange = parseBinLabel(trimCell.rpmBin);
    var mapRange = parseBinLabel(trimCell.mapBin);
    if (!rpmRange || !mapRange) return [];
    var rpmBp = axisBreakpoints(veTable.table.yAxis);
    var mapBp = axisBreakpoints(veTable.table.xAxis);
    var hits = [];
    rpmBp.forEach(function (rpm, r) {
      if (rpm < rpmRange[0] || rpm > rpmRange[1]) return;
      mapBp.forEach(function (map, c) {
        if (map < mapRange[0] || map > mapRange[1]) return;
        hits.push({ row: r, col: c, rpm: rpm, map: map });
      });
    });
    return hits;
  }

  /**
   * Build buffer rings around changed VE cells so the table has no cliffs
   * between corrected and uncorrected cells. Only fills cells that had no
   * suggestion of their own; targeted cells are never touched. Each ring
   * tapers the mean of neighboring targeted deltas by its factor.
   * rings: e.g. [{ radius: 1, factor: 0.5 }, { radius: 2, factor: 0.25 }]
   */
  function smoothDeltaGrid(deltaGrid, rows, cols, rings) {
    var out = deltaGrid.map(function (row) { return row.slice(); });
    rings.forEach(function (ring) {
      var r = Math.max(1, ring.radius | 0);
      var f = ring.factor;
      for (var i = 0; i < rows; i++) {
        for (var j = 0; j < cols; j++) {
          if (deltaGrid[i][j] !== 0) continue; // never touch targeted cells
          if (out[i][j] !== 0) continue;       // inner ring wins
          var sum = 0, n = 0;
          for (var di = -r; di <= r; di++) {
            for (var dj = -r; dj <= r; dj++) {
              if (!di && !dj) continue;
              var ni = i + di, nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= rows || nj >= cols) continue;
              if (deltaGrid[ni][nj] !== 0) { sum += deltaGrid[ni][nj]; n++; }
            }
          }
          if (n > 0) out[i][j] = (sum / n) * f;
        }
      }
    });
    return out;
  }

  /**
   * Turn fuel suggestions into binary patches, routing each suggestion to
   * its target VE table (suggestion.table, default 'Main VE'). The PCM runs
   * the Idle VE table at idle and Main VE everywhere else, so idle-region
   * corrections must land in Idle VE — patching Main VE alone mistunes idle.
   *
   * Only suggestions with action !== 'none' and a nonzero delta produce patches.
   *
   * veTableName may be omitted in favor of an options object:
   *   applyFuelSuggestions(catalog, bin, suggestions, { smooth: false })
   * An explicit veTableName overrides per-suggestion routing (legacy
   * single-table mode). options.smooth (default true) tapers uncorrected
   * neighbors around each corrected cell; options.rings overrides the default
   * [{ radius: 1, factor: 0.5 }, { radius: 2, factor: 0.25 }].
   *
   * Returns { patches, patched, error, warnings }. warnings covers partial
   * problems (e.g. a target table missing from the catalog); error is set
   * only when no patches could be produced at all.
   */
  function applyFuelSuggestions(catalog, binBytes, suggestions, veTableName, options) {
    if (veTableName && typeof veTableName === 'object') {
      options = veTableName;
      veTableName = null;
    }
    options = options || {};
    var smooth = options.smooth !== false;
    var rings = options.rings || [{ radius: 1, factor: 0.5 }, { radius: 2, factor: 0.25 }];

    // Group actionable fuel suggestions by target table.
    var groups = {};
    var order = [];
    (suggestions || []).forEach(function (s) {
      if (!s || s.kind !== 'fuel' || s.action === 'none' || !s.deltaPct) return;
      var t = veTableName || s.table || 'Main VE';
      if (!groups[t]) { groups[t] = []; order.push(t); }
      groups[t].push(s);
    });

    var patched = new Uint8Array(binBytes); // working copy, accumulates tables
    var allPatches = [];
    var tableErrors = [];
    order.forEach(function (t) {
      var r = patchVeTable(catalog, t, patched, groups[t], smooth, rings);
      if (r.error) {
        // A missing/unreadable table kills only its own suggestions.
        tableErrors.push(t + ': ' + r.error + ' (' + groups[t].length + ' suggestion(s) skipped)');
        return;
      }
      allPatches = allPatches.concat(r.patches);
    });

    if (!allPatches.length && tableErrors.length) {
      return { patches: [], patched: null, error: tableErrors.join(' / '), warnings: [] };
    }
    // Partial failure (some tables patched, some skipped) is a warning, not
    // an error, so callers keep the good patches.
    return { patches: allPatches, patched: patched, error: null, warnings: tableErrors };
  }

  /**
   * Single-table patch pipeline: read the table, build the delta grid from
   * this table's suggestions, optionally smooth buffer rings, and write the
   * patches into binImage (modified in place). Returns { patches, error }.
   */
  function patchVeTable(catalog, tableName, binImage, suggestions, smooth, rings) {
    var ve = readTable(catalog, tableName, binImage);
    if (!ve) return { patches: [], error: 'table not readable from this binary/catalog' };
    var eb = ve.elementBytes;
    var base = ve.base;
    var rows = ve.rows, cols = ve.cols;
    var rpmBp = axisBreakpoints(ve.table.yAxis);
    var mapBp = axisBreakpoints(ve.table.xAxis);
    var maxRaw = eb === 2 ? 0xFFFF : 0xFF;

    // 1. Delta grid from suggestions; first (strongest-trim) suggestion wins per cell.
    var deltaGrid = [];
    var metaGrid = [];
    for (var r = 0; r < rows; r++) {
      deltaGrid.push(new Array(cols).fill(0));
      metaGrid.push(new Array(cols).fill(null));
    }
    suggestions.forEach(function (s) {
      // Recover the trim cell's bin labels from the suggestion's cell text:
      // "2000-2500 RPM / 80-90 kPa".
      var m = /^(\S+)\s*RPM\s*\/\s*(\S+)\s*kPa/.exec(s.cell || '');
      if (!m) return;
      var hits = mapTrimCellToVE({ rpmBin: m[1], mapBin: m[2] }, ve);
      hits.forEach(function (h) {
        if (metaGrid[h.row][h.col]) return;
        metaGrid[h.row][h.col] = { confidence: s.confidence, rpm: h.rpm, map: h.map };
        deltaGrid[h.row][h.col] = s.deltaPct;
      });
    });

    // 2. Optional buffer rings around corrected cells.
    var finalGrid = smooth ? smoothDeltaGrid(deltaGrid, rows, cols, rings) : deltaGrid;

    // 3. Write patches.
    var patches = [];
    for (var ri = 0; ri < rows; ri++) {
      for (var ci = 0; ci < cols; ci++) {
        var d = finalGrid[ri][ci];
        if (!d) continue;
        var addr = base + (ri * cols + ci) * eb;
        var oldValue = ve.values[ri][ci];
        var newValue = Math.min(maxRaw, Math.max(0, Math.round(oldValue * (1 + d / 100))));
        writeRaw(binImage, addr, eb, newValue);
        var meta = metaGrid[ri][ci];
        patches.push({
          table: tableName,
          address: addr,
          addressHex: '0x' + addr.toString(16).toUpperCase(),
          sizeBytes: eb,
          rpm: meta ? meta.rpm : (rpmBp[ri] !== undefined ? rpmBp[ri] : null),
          map: meta ? meta.map : (mapBp[ci] !== undefined ? mapBp[ci] : null),
          oldValue: oldValue,
          newValue: newValue,
          deltaPct: Math.round(d * 100) / 100,
          smoothed: !meta,
          confidence: meta ? meta.confidence : null
        });
      }
    }

    return { patches: patches, error: null };
  }

  /**
   * Parse a linear spark-table MATH equation into raw units per degree.
   * Supports X*(a/b), X*a, X/a, and bare X. Returns null when the
   * equation is not a supported linear form — the caller must refuse
   * to patch rather than guess the scaling.
   */
  function rawPerDegree(equation) {
    var s = String(equation || '').replace(/\s+/g, '');
    var m;
    if ((m = /^X\*\(([\d.]+)\/([\d.]+)\)$/.exec(s))) {
      var a = parseFloat(m[1]);
      return a ? parseFloat(m[2]) / a : null; // deg = raw*(a/b) -> raw = deg*(b/a)
    }
    if ((m = /^X\*([\d.]+)$/.exec(s))) {
      var f = parseFloat(m[1]);
      return f ? 1 / f : null;
    }
    if ((m = /^X\/([\d.]+)$/.exec(s))) {
      var d = parseFloat(m[1]);
      return d ? d : null; // deg = raw/d -> raw = deg*d
    }
    if (s === 'X') return 1;
    return null;
  }

  /**
   * Map an { rpm, map } point to the nearest table cell by axis breakpoints.
   * Returns { row, col } or null when the table has no usable axes.
   */
  function mapPointToTable(point, table) {
    var rpmBp = axisBreakpoints(table.yAxis);
    var mapBp = axisBreakpoints(table.xAxis);
    if (!rpmBp.length || !mapBp.length) return null;
    function nearest(bp, v) {
      var best = 0, bestD = Math.abs(bp[0] - v);
      for (var i = 1; i < bp.length; i++) {
        var d = Math.abs(bp[i] - v);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    return { row: nearest(rpmBp, point.rpm), col: nearest(mapBp, point.map) };
  }

  /**
   * Turn spark suggestions (knock retard) into binary patches against the
   * Main Spark Advance table. Each suggestion's knockCells (RPM/MAP at each
   * knock event's peak KR) map to their nearest spark cells; the degree
   * pull is converted to raw units via the table's MATH equation.
   *
   * options.smooth (default true) tapers one ring of uncorrected neighbors
   * at 50%; options.rings overrides. Only suggestions with
   * action === 'retard timing' and a nonzero deltaDeg produce patches.
   */
  function applySparkSuggestions(catalog, binBytes, suggestions, sparkTableName, options) {
    if (sparkTableName && typeof sparkTableName === 'object') {
      options = sparkTableName;
      sparkTableName = 'Main Spark Advance';
    }
    sparkTableName = sparkTableName || 'Main Spark Advance';
    options = options || {};
    var smooth = options.smooth !== false;
    var rings = options.rings || [{ radius: 1, factor: 0.5 }];

    var spark = readTable(catalog, sparkTableName, binBytes);
    if (!spark) return { patches: [], patched: null, error: 'Spark table not readable' };
    var rpd = rawPerDegree(spark.table.zAxis && spark.table.zAxis.equation);
    if (rpd === null || !isFinite(rpd) || rpd <= 0) {
      return { patches: [], patched: null, error: 'Unsupported spark equation "' + ((spark.table.zAxis && spark.table.zAxis.equation) || '') + '" — refusing to guess scaling' };
    }
    var eb = spark.elementBytes;
    var base = spark.base;
    var rows = spark.rows, cols = spark.cols;
    var rpmBp = axisBreakpoints(spark.table.yAxis);
    var mapBp = axisBreakpoints(spark.table.xAxis);
    var maxRaw = eb === 2 ? 0xFFFF : 0xFF;

    // Delta grid in raw units; first suggestion wins per cell.
    var deltaGrid = [];
    var metaGrid = [];
    for (var r = 0; r < rows; r++) {
      deltaGrid.push(new Array(cols).fill(0));
      metaGrid.push(new Array(cols).fill(null));
    }
    suggestions.forEach(function (s) {
      if (s.kind !== 'spark' || s.action !== 'retard timing' || !s.deltaDeg) return;
      var rawDelta = Math.round(s.deltaDeg * rpd); // deltaDeg negative = retard
      if (!rawDelta) return;
      (s.knockCells || []).forEach(function (kc) {
        var hit = mapPointToTable(kc, spark.table);
        if (!hit) return;
        if (metaGrid[hit.row][hit.col]) return;
        metaGrid[hit.row][hit.col] = { confidence: s.confidence, rpm: kc.rpm, map: kc.map };
        deltaGrid[hit.row][hit.col] = rawDelta;
      });
    });

    var finalGrid = smooth ? smoothDeltaGrid(deltaGrid, rows, cols, rings) : deltaGrid;

    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    for (var ri = 0; ri < rows; ri++) {
      for (var ci = 0; ci < cols; ci++) {
        var d = finalGrid[ri][ci];
        if (!d) continue;
        var addr = base + (ri * cols + ci) * eb;
        var oldValue = spark.values[ri][ci];
        var newValue = Math.min(maxRaw, Math.max(0, Math.round(oldValue + d)));
        if (newValue === oldValue) continue;
        writeRaw(patched, addr, eb, newValue);
        var meta = metaGrid[ri][ci];
        patches.push({
          table: sparkTableName,
          address: addr,
          addressHex: '0x' + addr.toString(16).toUpperCase(),
          sizeBytes: eb,
          rpm: meta ? meta.rpm : (rpmBp[ri] !== undefined ? rpmBp[ri] : null),
          map: meta ? meta.map : (mapBp[ci] !== undefined ? mapBp[ci] : null),
          oldValue: oldValue,
          newValue: newValue,
          deltaDeg: Math.round((newValue - oldValue) / rpd * 100) / 100,
          smoothed: !meta,
          confidence: meta ? meta.confidence : null
        });
      }
    }

    return { patches: patches, patched: patched, error: null };
  }

  /**
   * Turn power-enrichment suggestions into binary patches against the
   * Power Enrichment Target AFR table. The suggestion is WOT-global, and
   * so is the table (target AFR vs RPM) — the enrichment applies uniformly
   * to every cell. Enriching lowers the AFR target:
   * newRaw = round(oldRaw * (1 - deltaPct/100)).
   *
   * The table's MATH equation must be a supported linear form (see
   * rawPerDegree); anything else refuses rather than guessing the scaling.
   * Only suggestions with action === 'enrich' and a nonzero deltaPct
   * produce patches.
   */
  function applyPeSuggestions(catalog, binBytes, suggestions, peTableName, options) {
    if (peTableName && typeof peTableName === 'object') {
      options = peTableName;
      peTableName = 'Power Enrichment Target AFR';
    }
    peTableName = peTableName || 'Power Enrichment Target AFR';
    options = options || {};

    var pe = readTable(catalog, peTableName, binBytes);
    if (!pe) return { patches: [], patched: null, error: 'PE AFR table not readable' };
    var rpu = rawPerDegree(pe.table.zAxis && pe.table.zAxis.equation);
    if (rpu === null || !isFinite(rpu) || rpu <= 0) {
      return { patches: [], patched: null, error: 'Unsupported PE equation "' + ((pe.table.zAxis && pe.table.zAxis.equation) || '') + '" — refusing to guess scaling' };
    }
    var eb = pe.elementBytes;
    var base = pe.base;
    var maxRaw = eb === 2 ? 0xFFFF : 0xFF;

    var s = null;
    (suggestions || []).forEach(function (x) {
      if (!s && x.kind === 'pe' && x.action === 'enrich' && x.deltaPct) s = x;
    });
    if (!s) return { patches: [], patched: new Uint8Array(binBytes), error: null };

    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    var rpmBp = axisBreakpoints(pe.table.yAxis);
    for (var r = 0; r < pe.rows; r++) {
      for (var c = 0; c < pe.cols; c++) {
        var addr = base + (r * pe.cols + c) * eb;
        var oldValue = pe.values[r][c];
        // Via display units for clarity: newAFR = oldAFR * (1 - d%), back to raw.
        var newValue = Math.min(maxRaw, Math.max(0, Math.round((oldValue / rpu) * (1 - s.deltaPct / 100) * rpu)));
        if (newValue === oldValue) continue;
        writeRaw(patched, addr, eb, newValue);
        patches.push({
          table: peTableName,
          address: addr,
          addressHex: '0x' + addr.toString(16).toUpperCase(),
          sizeBytes: eb,
          rpm: rpmBp[r] !== undefined ? rpmBp[r] : null,
          map: null,
          oldValue: oldValue,
          newValue: newValue,
          deltaAfrPct: -Math.round(s.deltaPct * 100) / 100,
          smoothed: false,
          confidence: s.confidence || null
        });
      }
    }

    return { patches: patches, patched: patched, error: null };
  }

  /**
   * Scale the accel-enrichment vs D-TPS multiplier tables.
   *
   * The PCM has two AE tables indexed by throttle-movement rate (D-TPS):
   * the async shot ('AE Async Multiplier vs D-TPS', 0xA26 — fires an
   * immediate extra pulse on a stab) and the sync adder ('AE Multipler vs
   * D-TPS', 0xA59 — extra fuel on the following injections; note the XDF's
   * "Multipler" typo, matched verbatim). Both are 8-bit X/256 multipliers,
   * so a percentage scale of the raw bytes is a percentage scale of the
   * fuel. The D-TPS axis breakpoints are implicit in the PCM (not in the
   * XDF), so the whole curve scales together, preserving its shape.
   *
   * Only suggestions with kind === 'ae', action === 'increase' and a
   * nonzero deltaPct produce patches. Rows already at 255 stay at 255.
   * Returns { patches, patched, error, warnings }.
   */
  var AE_TABLES = ['AE Async Multiplier vs D-TPS', 'AE Multipler vs D-TPS'];

  function applyAeSuggestions(catalog, binBytes, suggestions, options) {
    options = options || {};
    var s = null;
    (suggestions || []).forEach(function (x) {
      if (!s && x.kind === 'ae' && x.action === 'increase' && x.deltaPct) s = x;
    });
    if (!s) return { patches: [], patched: new Uint8Array(binBytes), error: null, warnings: [] };

    var factor = 1 + s.deltaPct / 100;
    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    var warnings = [];
    AE_TABLES.forEach(function (name) {
      var t = readTable(catalog, name, patched);
      if (!t) {
        warnings.push(name + ': table not readable from this binary/catalog — skipped');
        return;
      }
      var eb = t.elementBytes;
      var maxRaw = eb === 2 ? 0xFFFF : 0xFF;
      for (var r = 0; r < t.rows; r++) {
        for (var c = 0; c < t.cols; c++) {
          var addr = t.base + (r * t.cols + c) * eb;
          var oldValue = t.values[r][c];
          var newValue = Math.min(maxRaw, Math.round(oldValue * factor));
          if (newValue === oldValue) continue;
          writeRaw(patched, addr, eb, newValue);
          patches.push({
            table: name,
            address: addr,
            addressHex: '0x' + addr.toString(16).toUpperCase(),
            sizeBytes: eb,
            rpm: null,
            map: null,
            oldValue: oldValue,
            newValue: newValue,
            deltaPct: Math.round(s.deltaPct * 100) / 100,
            smoothed: false,
            confidence: s.confidence || null
          });
        }
      }
    });

    if (!patches.length && warnings.length) {
      return { patches: [], patched: null, error: warnings.join(' / '), warnings: [] };
    }
    return { patches: patches, patched: patched, error: null, warnings: warnings };
  }

  /**
   * Lower the PE TPS entry threshold ('TPS% Threshold to Enter PE vs RPM').
   *
   * The stock calibration waits for ~70% TPS before power enrichment; this
   * scales the 8-bit threshold table down so PE engages earlier. Each cell
   * is floored at raw 128 (~50% TPS) so repeated passes cannot drag PE into
   * part-throttle cruise. Only suggestions with kind === 'pe-entry',
   * action === 'lower' and a nonzero deltaPct produce patches.
   * Returns { patches, patched, error, warnings }.
   */
  var PE_ENTRY_TABLE = 'TPS% Threshold to Enter PE vs RPM';
  var PE_ENTRY_FLOOR_RAW = 128; // ~50% TPS

  function applyPeEntrySuggestions(catalog, binBytes, suggestions, options) {
    options = options || {};
    var s = null;
    (suggestions || []).forEach(function (x) {
      if (!s && x.kind === 'pe-entry' && x.action === 'lower' && x.deltaPct) s = x;
    });
    if (!s) return { patches: [], patched: new Uint8Array(binBytes), error: null, warnings: [] };

    var t = readTable(catalog, PE_ENTRY_TABLE, binBytes);
    if (!t) {
      return { patches: [], patched: null,
        error: PE_ENTRY_TABLE + ': table not readable from this binary/catalog', warnings: [] };
    }
    var factor = 1 + s.deltaPct / 100;
    var eb = t.elementBytes;
    var maxRaw = eb === 2 ? 0xFFFF : 0xFF;
    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    var rpmBp = axisBreakpoints(t.table.yAxis);
    for (var r = 0; r < t.rows; r++) {
      for (var c = 0; c < t.cols; c++) {
        var addr = t.base + (r * t.cols + c) * eb;
        var oldValue = t.values[r][c];
        var newValue = Math.min(maxRaw, Math.max(PE_ENTRY_FLOOR_RAW, Math.round(oldValue * factor)));
        if (newValue === oldValue) continue;
        writeRaw(patched, addr, eb, newValue);
        patches.push({
          table: PE_ENTRY_TABLE,
          address: addr,
          addressHex: '0x' + addr.toString(16).toUpperCase(),
          sizeBytes: eb,
          rpm: rpmBp[r] !== undefined ? rpmBp[r] : null,
          map: null,
          oldValue: oldValue,
          newValue: newValue,
          deltaPct: Math.round(s.deltaPct * 100) / 100,
          smoothed: false,
          confidence: s.confidence || null
        });
      }
    }
    return { patches: patches, patched: patched, error: null, warnings: [] };
  }

  /**
   * Apply transmission suggestions: line pressure, downshift scheduling,
   * and shift-hysteresis widening.
   *
   * Three patch types, each region-targeted and capped:
   *
   * - trans-firmness (action 'increase'): scales the two Main Line Pressure
   *   tables up by deltaPct, but only in the MPH band where flaring shifts
   *   were observed (±10 MPH). Pressure is capped at the 8-bit max; the
   *   patch ledger guards cumulative moves at ±20% (see js/ledger.js).
   * - trans-kickdown (action 'raise'): raises Normal Downshift MPH
   *   thresholds by deltaPct near the speeds where kickdown was lazy
   *   (±15 MPH of cell value). Each cell is capped at 90% of its matching
   *   upshift cell (same TPS row, mirrored gear pair) so the downshift
   *   schedule can never stack onto or cross the upshift schedule — the
   *   structural guarantee against shift hunting.
   * - trans-hunting (action 'widen'): widens hysteresis in the cruise
   *   region — upshift cells later (+deltaPct), downshift cells earlier
   *   (-deltaPct) — limited to the observed gear pair and MPH/TPS window.
   *
   * trans-tcc suggestions always carry action 'none' and never reach the
   * patcher (filtered into `blocked` by generateSuggestions).
   * Returns { patches, patched, error, warnings }.
   */
  var TRANS_LINE_PRESSURE_TABLES = ['Main Line Pressure 0-64MPH', 'Main Line Pressure 64-128MPH'];
  var TRANS_UPSHIFT_TABLE = 'Normal Upshifts';
  var TRANS_DOWNSHIFT_TABLE = 'Normal Downshifts';
  var TRANS_FIRM_MPH_BAND = 10;
  var TRANS_KICK_MPH_BAND = 15;
  var TRANS_HUNT_TPS_BAND = 12.5;

  function firstSuggestion(suggestions, kind, action) {
    var found = null;
    (suggestions || []).forEach(function (x) {
      if (!found && x.kind === kind && x.action === action && x.deltaPct) found = x;
    });
    return found;
  }

  function numLabel(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  function pushTransPatch(patches, patched, table, addr, eb, oldValue, newValue, deltaPct, extra) {
    if (newValue === oldValue) return;
    writeRaw(patched, addr, eb, newValue);
    var p = {
      table: table,
      address: addr,
      addressHex: '0x' + addr.toString(16).toUpperCase(),
      sizeBytes: eb,
      rpm: null,
      map: null,
      mph: extra && extra.mph !== undefined ? extra.mph : null,
      tps: extra && extra.tps !== undefined ? extra.tps : null,
      oldValue: oldValue,
      newValue: newValue,
      deltaPct: Math.round(deltaPct * 100) / 100,
      smoothed: false,
      confidence: extra && extra.confidence ? extra.confidence : null
    };
    patches.push(p);
  }

  function applyTransSuggestions(catalog, binBytes, suggestions, options) {
    options = options || {};
    var firm = firstSuggestion(suggestions, 'trans-firmness', 'increase');
    var kick = firstSuggestion(suggestions, 'trans-kickdown', 'raise');
    var hunt = firstSuggestion(suggestions, 'trans-hunting', 'widen');
    if (!firm && !kick && !hunt) {
      return { patches: [], patched: new Uint8Array(binBytes), error: null, warnings: [] };
    }

    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    var warnings = [];
    function fail(msg) {
      return { patches: [], patched: null, error: msg, warnings: [] };
    }

    // --- 1. Line pressure for shift firmness ---------------------------
    if (firm) {
      var factor = 1 + firm.deltaPct / 100;
      var regionMph = firm.region && firm.region.mph !== null ? firm.region.mph : null;
      if (regionMph === null) {
        warnings.push('trans-firmness: no shift region recorded — skipped');
      } else {
        TRANS_LINE_PRESSURE_TABLES.forEach(function (name) {
          var t = readTable(catalog, name, patched);
          if (!t) { warnings.push(name + ': table not readable — skipped'); return; }
          var eb = t.elementBytes;
          var maxRaw = eb === 2 ? 0xFFFF : 0xFF;
          var mphBp = axisBreakpoints(t.table.xAxis);
          var tpsBp = axisBreakpoints(t.table.yAxis);
          for (var r = 0; r < t.rows; r++) {
            for (var c = 0; c < t.cols; c++) {
              var mph = mphBp[c] !== undefined ? mphBp[c] : null;
              if (mph === null || Math.abs(mph - regionMph) > TRANS_FIRM_MPH_BAND) continue;
              var addr = t.base + (r * t.cols + c) * eb;
              var oldValue = t.values[r][c];
              var newValue = Math.min(maxRaw, Math.round(oldValue * factor));
              pushTransPatch(patches, patched, name, addr, eb, oldValue, newValue,
                firm.deltaPct, { mph: mph, tps: tpsBp[r] !== undefined ? tpsBp[r] : null,
                  confidence: firm.confidence });
            }
          }
        });
      }
    }

    // --- 2. Earlier kickdown: raise downshift thresholds ----------------
    // Structural guard: a downshift cell may never reach its matching
    // upshift cell (same TPS row, mirrored pair, e.g. 4-3 vs 3-4).
    if (kick) {
      var kFactor = 1 + kick.deltaPct / 100;
      var kRegionMph = kick.region && kick.region.mph !== null ? kick.region.mph : null;
      var kd = readTable(catalog, TRANS_DOWNSHIFT_TABLE, patched);
      if (!kd) return fail(TRANS_DOWNSHIFT_TABLE + ': table not readable from this binary/catalog');
      var up = readTable(catalog, TRANS_UPSHIFT_TABLE, patched);
      var kdEb = kd.elementBytes;
      var kdMax = kdEb === 2 ? 0xFFFF : 0xFF;
      var kdTpsBp = axisBreakpoints(kd.table.yAxis);
      var kdCols = kd.table.xAxis.labels || [];
      var upCols = up ? (up.table.xAxis.labels || []) : [];
      var upTpsBp = up ? axisBreakpoints(up.table.yAxis) : [];
      for (var kr = 0; kr < kd.rows; kr++) {
        for (var kc = 0; kc < kd.cols; kc++) {
          var kAddr = kd.base + (kr * kd.cols + kc) * kdEb;
          var kOld = kd.values[kr][kc];
          // Physical MPH of this cell (equation X/2 applied by convention
          // of the shift tables; compare in raw to avoid float drift).
          var kOldMph = kOld / 2;
          if (kRegionMph !== null && Math.abs(kOldMph - kRegionMph) > TRANS_KICK_MPH_BAND) continue;
          var kNew = Math.round(kOld * kFactor);
          // Cap below the matching upshift cell.
          var pairLabel = kdCols[kc] || '';
          var mirror = pairLabel.split('-').reverse().join('-'); // '4-3' -> '3-4'
          var uc = upCols.indexOf(mirror);
          var cap = Math.min(kdMax, Math.round(kOld * 1.5));
          if (up && uc !== -1 && kr < up.rows) {
            var upTps = upTpsBp[kr], kdTps = kdTpsBp[kr];
            if (upTps !== undefined && kdTps !== undefined && Math.abs(upTps - kdTps) < 0.01) {
              cap = Math.min(cap, Math.floor(up.values[kr][uc] * 0.9));
            }
          }
          kNew = Math.max(kOld, Math.min(cap, kNew));
          pushTransPatch(patches, patched, TRANS_DOWNSHIFT_TABLE, kAddr, kdEb, kOld, kNew,
            kick.deltaPct, { mph: kOldMph,
              tps: kdTpsBp[kr] !== undefined ? kdTpsBp[kr] : null,
              confidence: kick.confidence });
        }
      }
    }

    // --- 3. Hunting: widen hysteresis in the cruise region --------------
    if (hunt) {
      var hFactor = 1 + hunt.deltaPct / 100;
      var hRegion = hunt.region || {};
      var upT = readTable(catalog, TRANS_UPSHIFT_TABLE, patched);
      var dnT = readTable(catalog, TRANS_DOWNSHIFT_TABLE, patched);
      if (!upT || !dnT) {
        warnings.push('trans-hunting: shift tables not readable — skipped');
      } else {
        var upEb = upT.elementBytes, dnEb = dnT.elementBytes;
        var upTpsBp = axisBreakpoints(upT.table.yAxis);
        var dnTpsBp = axisBreakpoints(dnT.table.yAxis);
        var upLabels = upT.table.xAxis.labels || [];
        var dnLabels = dnT.table.xAxis.labels || [];
        function pairCols(labels, want) {
          if (!want) return labels.map(function (_, i) { return i; });
          var idx = labels.indexOf(want);
          return idx === -1 ? [] : [idx];
        }
        // Normalize the pair: the episode may start with a downshift
        // ("3-2"), but the upshift column is always low-high ("2-3").
        var pairNums = String(hRegion.pair || '').split('-')
          .map(function (x) { return parseInt(x, 10); })
          .filter(isFinite).sort();
        var upWant = pairNums.length === 2 ? pairNums.join('-') : null;
        var dnWant = pairNums.length === 2 ? pairNums.slice().reverse().join('-') : null;
        // Gate on the TPS row: the hunting happened at this throttle
        // position, so these are the thresholds that govern it. The cell's
        // MPH value is what we are changing — gating on it would be
        // circular. Observed MPH is reported for context only.
        function inRegion(tpsLabel) {
          if (hRegion.tps !== null && hRegion.tps !== undefined && tpsLabel !== null &&
              Math.abs(tpsLabel - hRegion.tps) > TRANS_HUNT_TPS_BAND) return false;
          return true;
        }
        pairCols(upLabels, upWant).forEach(function (c) {
          for (var r = 0; r < upT.rows; r++) {
            var tpsL = upTpsBp[r] !== undefined ? upTpsBp[r] : null;
            if (!inRegion(tpsL)) continue;
            var addr = upT.base + (r * upT.cols + c) * upEb;
            var oldV = upT.values[r][c];
            var newV = Math.min(upEb === 2 ? 0xFFFF : 0xFF, Math.round(oldV * hFactor));
            pushTransPatch(patches, patched, TRANS_UPSHIFT_TABLE, addr, upEb, oldV, newV,
              hunt.deltaPct, { mph: oldV / 2, tps: tpsL, confidence: hunt.confidence });
          }
        });
        pairCols(dnLabels, dnWant).forEach(function (c) {
          for (var r2 = 0; r2 < dnT.rows; r2++) {
            var tpsL2 = dnTpsBp[r2] !== undefined ? dnTpsBp[r2] : null;
            if (!inRegion(tpsL2)) continue;
            var addr2 = dnT.base + (r2 * dnT.cols + c) * dnEb;
            var oldV2 = dnT.values[r2][c];
            var newV2 = Math.max(0, Math.round(oldV2 / hFactor));
            pushTransPatch(patches, patched, TRANS_DOWNSHIFT_TABLE, addr2, dnEb, oldV2, newV2,
              -hunt.deltaPct, { mph: oldV2 / 2, tps: tpsL2, confidence: hunt.confidence });
          }
        });
      }
    }

    if (!patches.length && warnings.length) {
      return { patches: [], patched: null, error: warnings.join(' / '), warnings: [] };
    }
    return { patches: patches, patched: patched, error: null, warnings: warnings };
  }

  P66.findTable = findTable;
  P66.readTable = readTable;
  P66.applyFuelSuggestions = applyFuelSuggestions;
  P66.applySparkSuggestions = applySparkSuggestions;
  P66.applyPeSuggestions = applyPeSuggestions;
  P66.applyAeSuggestions = applyAeSuggestions;
  P66.applyPeEntrySuggestions = applyPeEntrySuggestions;
  P66.applyTransSuggestions = applyTransSuggestions;
  P66.rawPerDegree = rawPerDegree;

  /* ---------- XDF XML parsing (browser + node) ---------- */

  function xgrab(body, re) {
    var m = re.exec(body);
    return m ? m[1] : '';
  }

  function xdfParseAxis(block, id) {
    var m = new RegExp('<XDFAXIS id="' + id + '"[^>]*>([\\s\\S]*?)</XDFAXIS>').exec(block);
    if (!m) return null;
    var b = m[1];
    var labels = [];
    var lr = /<LABEL index="\d+" value="([^"]+)"/g, lm;
    while ((lm = lr.exec(b)) !== null) labels.push(lm[1]);
    return {
      units: xgrab(b, /<units>([^<]*)<\/units>/) || '',
      count: parseInt(xgrab(b, /<indexcount>(\d+)<\/indexcount>/) || '0', 10) || labels.length,
      equation: xgrab(b, /<MATH equation="([^"]+)"/) || '',
      labels: labels
    };
  }

  function xdfParseEmbedded(block) {
    var m = /<EMBEDDEDDATA([^>]*)>/.exec(block);
    if (!m) return {};
    var a = m[1];
    function attr(n) { var mm = new RegExp(n + '="([^"]+)"').exec(a); return mm ? mm[1] : ''; }
    return {
      address: attr('mmedaddress'),
      elementSizeBits: attr('mmedelementsizebits'),
      rowCount: attr('mmedrowcount'),
      colCount: attr('mmedcolcount')
    };
  }

  /**
   * Parse XDF XML text into a catalog: { deftitle, tables[], constants[], flags[] }.
   * Works on raw XML text — no DOM required.
   */
  function parseXdfXml(xml) {
    var tables = [];
    var tre = /<XDFTABLE uniqueid="([^"]+)"[^>]*>([\s\S]*?)<\/XDFTABLE>/g, tm;
    while ((tm = tre.exec(xml)) !== null) {
      var tbody = tm[2];
      var title = (xgrab(tbody, /<title>([\s\S]*?)<\/title>/) || '').trim().replace(/\s+/g, ' ');
      var zBlock = (/<XDFAXIS id="z"[^>]*>([\s\S]*?)<\/XDFAXIS>/.exec(tbody) || [])[1] || '';
      var zEmb = xdfParseEmbedded(zBlock);
      var emb = xdfParseEmbedded(tbody);
      var dataAxis = xdfParseAxis(tbody, 'z') || {};
      tables.push({
        id: tm[1],
        title: title,
        address: zEmb.address || emb.address || '',
        rows: parseInt(zEmb.rowCount || emb.rowCount || '0', 10) || null,
        cols: parseInt(zEmb.colCount || emb.colCount || '0', 10) || null,
        elementSizeBits: zEmb.elementSizeBits || emb.elementSizeBits || '',
        xAxis: xdfParseAxis(tbody, 'x'),
        yAxis: xdfParseAxis(tbody, 'y'),
        zAxis: { units: dataAxis.units || '', equation: dataAxis.equation || '' }
      });
    }
    var constants = [];
    var cre = /<XDFCONSTANT uniqueid="([^"]+)"[^>]*>([\s\S]*?)<\/XDFCONSTANT>/g, cm;
    while ((cm = cre.exec(xml)) !== null) {
      var cbody = cm[2];
      var cemb = xdfParseEmbedded(cbody);
      constants.push({
        id: cm[1],
        title: (xgrab(cbody, /<title>([\s\S]*?)<\/title>/) || '').trim().replace(/\s+/g, ' '),
        address: cemb.address || '',
        elementSizeBits: cemb.elementSizeBits || '',
        units: xgrab(cbody, /<units>([^<]*)<\/units>/) || '',
        equation: xgrab(cbody, /<MATH equation="([^"]+)"/) || ''
      });
    }
    var flags = [];
    var fre = /<XDFFLAG uniqueid="([^"]+)"[^>]*>([\s\S]*?)<\/XDFFLAG>/g, fm;
    while ((fm = fre.exec(xml)) !== null) {
      flags.push({
        id: fm[1],
        title: (xgrab(fm[2], /<title>([\s\S]*?)<\/title>/) || '').trim().replace(/\s+/g, ' '),
        address: xdfParseEmbedded(fm[2]).address || ''
      });
    }
    return {
      deftitle: xgrab(xml, /<deftitle>([^<]*)<\/deftitle>/),
      tables: tables,
      constants: constants,
      flags: flags
    };
  }

  P66.parseXdfXml = parseXdfXml;
})(typeof window !== 'undefined' ? window : global);
