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
    if (!t || !t.address || !t.rows || !t.cols) return null;
    var base = parseAddr(t.address);
    var eb = elementBytes(t);
    var values = [];
    for (var r = 0; r < t.rows; r++) {
      var row = [];
      for (var c = 0; c < t.cols; c++) {
        var addr = base + (r * t.cols + c) * eb;
        if (addr + eb > binBytes.length) return null;
        row.push(readRaw(binBytes, addr, eb));
      }
      values.push(row);
    }
    return { table: t, rows: t.rows, cols: t.cols, values: values, elementBytes: eb, base: base };
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
   * Turn fuel suggestions into binary patches against the Main VE table.
   * Only suggestions with action !== 'none' and a nonzero delta produce patches.
   */
  function applyFuelSuggestions(catalog, binBytes, suggestions, veTableName) {
    veTableName = veTableName || 'Main VE';
    var ve = readTable(catalog, veTableName, binBytes);
    if (!ve) return { patches: [], patched: null, error: 'Main VE table not readable' };
    var eb = ve.elementBytes;
    var base = ve.base;
    var patched = new Uint8Array(binBytes); // copy
    var patches = [];
    var seenAddr = {}; // dedupe: first (strongest-trim) suggestion wins per cell

    suggestions.forEach(function (s) {
      if (s.kind !== 'fuel' || s.action === 'none' || !s.deltaPct) return;
      // Recover the trim cell's bin labels from the suggestion's cell text:
      // "2000-2500 RPM / 80-90 kPa".
      var m = /^(\S+)\s*RPM\s*\/\s*(\S+)\s*kPa/.exec(s.cell || '');
      if (!m) return;
      var hits = mapTrimCellToVE({ rpmBin: m[1], mapBin: m[2] }, ve);
      hits.forEach(function (h) {
        var addr = base + (h.row * ve.cols + h.col) * eb;
        if (seenAddr[addr]) return;
        seenAddr[addr] = true;
        var oldValue = ve.values[h.row][h.col];
        var newValue = Math.round(oldValue * (1 + s.deltaPct / 100));
        writeRaw(patched, addr, eb, newValue);
        patches.push({
          table: veTableName,
          address: addr,
          addressHex: '0x' + addr.toString(16).toUpperCase(),
          sizeBytes: eb,
          rpm: h.rpm, map: h.map,
          oldValue: oldValue,
          newValue: Math.min(eb === 2 ? 0xFFFF : 0xFF, newValue),
          deltaPct: s.deltaPct,
          confidence: s.confidence
        });
      });
    });

    return { patches: patches, patched: patched, error: null };
  }

  P66.findTable = findTable;
  P66.readTable = readTable;
  P66.mapTrimCellToVE = mapTrimCellToVE;
  P66.applyFuelSuggestions = applyFuelSuggestions;

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
