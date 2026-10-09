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
   * Turn fuel suggestions into binary patches against the Main VE table.
   * Only suggestions with action !== 'none' and a nonzero delta produce patches.
   *
   * veTableName may be omitted in favor of an options object:
   *   applyFuelSuggestions(catalog, bin, suggestions, { smooth: false })
   * options.smooth (default true) tapers uncorrected neighbors around each
   * corrected cell; options.rings overrides the default
   * [{ radius: 1, factor: 0.5 }, { radius: 2, factor: 0.25 }].
   */
  function applyFuelSuggestions(catalog, binBytes, suggestions, veTableName, options) {
    if (veTableName && typeof veTableName === 'object') {
      options = veTableName;
      veTableName = 'Main VE';
    }
    veTableName = veTableName || 'Main VE';
    options = options || {};
    var smooth = options.smooth !== false;
    var rings = options.rings || [{ radius: 1, factor: 0.5 }, { radius: 2, factor: 0.25 }];

    var ve = readTable(catalog, veTableName, binBytes);
    if (!ve) return { patches: [], patched: null, error: 'Main VE table not readable' };
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
      if (s.kind !== 'fuel' || s.action === 'none' || !s.deltaPct) return;
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
    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    for (var ri = 0; ri < rows; ri++) {
      for (var ci = 0; ci < cols; ci++) {
        var d = finalGrid[ri][ci];
        if (!d) continue;
        var addr = base + (ri * cols + ci) * eb;
        var oldValue = ve.values[ri][ci];
        var newValue = Math.min(maxRaw, Math.max(0, Math.round(oldValue * (1 + d / 100))));
        writeRaw(patched, addr, eb, newValue);
        var meta = metaGrid[ri][ci];
        patches.push({
          table: veTableName,
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

    return { patches: patches, patched: patched, error: null };
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

  P66.findTable = findTable;
  P66.readTable = readTable;
  P66.mapTrimCellToVE = mapTrimCellToVE;
  P66.applyFuelSuggestions = applyFuelSuggestions;
  P66.applySparkSuggestions = applySparkSuggestions;
  P66.applyPeSuggestions = applyPeSuggestions;
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
