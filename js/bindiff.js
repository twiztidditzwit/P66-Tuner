/* P66 bin-vs-bin diff (informational view)
 *
 * Compares two 64KB PCM binaries byte-for-byte, coalesces differing bytes
 * into regions, and labels each region with the catalog tables it overlaps
 * (from P66.BUNDLED_CATALOG when loaded). Changed table values are decoded
 * through the table's XDF MATH equation where a supported form is present.
 *
 * Pure logic — no DOM. Node-testable: eval this file, then call
 * P66.diffBins(a, b) with two 65536-byte Uint8Arrays.
 *
 * This view is INFORMATIONAL ONLY. It reports which bytes differ; it does
 * not verify either binary and must never be read as a statement that a
 * binary is safe to flash.
 *
 *   P66.diffBins(binA, binB[, catalog])
 *     -> { byteCount, changedBytes, identical, regions: [...] }
 *        region: { start, end, length, startHex, endHex,
 *                  oldBytes, newBytes,            // Uint8Array slices of the region
 *                  tables: [{ name, address, addressHex,
 *                             tableStart, tableEnd,   // table's bin span (tableEnd exclusive)
 *                             overlapStart, overlapEnd, overlapStartHex, overlapEndHex }] }
 *
 *   P66.diffSummary(diff)
 *     -> { identical, changedBytes, regionCount, tables: [...], unlabeled: {...} }
 *        tables: [{ name, addressHex, units, equation, decoded,
 *                   changedBytes, changedElements, totalElements,
 *                   oldMin, oldMax, newMin, newMax, oldText, newText }]
 *
 *   P66.renderDiffHTML(diff) -> HTML string (string building only, no DOM).
 *
 *   P66.decodeMathEquation(equation, x) -> decoded value or null when the
 *     equation is not a supported linear form (mirrors the supported forms
 *     of xdf-map's rawPerDegree, applied forward; refuses to guess).
 */
(function (global) {
  "use strict";
  var P66 = (global.P66 = global.P66 || {});

  var BIN_IMAGE_SIZE = 65536;
  P66.BINDIFF_IMAGE_SIZE = BIN_IMAGE_SIZE;

  /* ---------- helpers ---------- */

  function hex(n, width) {
    var s = n.toString(16).toUpperCase();
    while (s.length < width) s = '0' + s;
    return '0x' + s;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  function readRawBE(bytes, off, eb) {
    if (eb === 2) return (bytes[off] << 8) | bytes[off + 1]; // big-endian, like xdf-map
    return bytes[off];
  }

  /**
   * Apply a TunerPro MATH equation forward (raw counts -> physical value).
   * Supports the same linear forms xdf-map.js supports in rawPerDegree:
   *   X, X*a, X/a, X*(a/b)
   * Returns null for anything else — the caller must fall back to raw bytes
   * rather than guess the scaling.
   */
  function decodeMathEquation(equation, x) {
    var s = String(equation || '').replace(/\s+/g, '');
    if (!s) return null;
    var m;
    if (s === 'X') return x;
    if ((m = /^X\*([\d.]+)$/.exec(s))) {
      var f = parseFloat(m[1]);
      return f ? x * f : null;
    }
    if ((m = /^X\/([\d.]+)$/.exec(s))) {
      var d = parseFloat(m[1]);
      return d ? x / d : null;
    }
    if ((m = /^X\*\(([\d.]+)\/([\d.]+)\)$/.exec(s))) {
      var a = parseFloat(m[1]), b = parseFloat(m[2]);
      return (a && b) ? x * (a / b) : null;
    }
    return null;
  }

  function fmtNum(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (Math.abs(v) < 1e-12) v = 0;
    if (Number.isInteger(v)) return String(v);
    var s = v.toFixed(2);
    return s.replace(/0$/, '').replace(/\.$/, '');
  }

  function fmtHexRaw(v, eb) {
    var width = eb === 2 ? 4 : 2;
    var s = (v & (eb === 2 ? 0xFFFF : 0xFF)).toString(16).toUpperCase();
    while (s.length < width) s = '0' + s;
    return '0x' + s;
  }

  function hexPreview(bytes, maxLen) {
    var out = [];
    var n = Math.min(bytes.length, maxLen || 16);
    for (var i = 0; i < n; i++) out.push(fmtHexRaw(bytes[i], 1).slice(2));
    return out.join(' ');
  }

  function tableCatalog() {
    var cat = P66.BUNDLED_CATALOG;
    if (!cat || !cat.tables) return [];
    return cat.tables;
  }

  function tableGeometry(table) {
    var base = parseAddr(table.address);
    if (isNaN(base)) return null;
    var rows = parseInt(table.rows, 10) || 1; // 1D tables may omit cols/rows
    var cols = parseInt(table.cols, 10) || 1;
    var eb = elementBytes(table);
    return { base: base, rows: rows, cols: cols, eb: eb, end: base + rows * cols * eb };
  }

  function labelTables(start, end, catalog) {
    var tables = catalog || tableCatalog();
    var hits = [];
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var g = tableGeometry(t);
      if (!g) continue;
      var ovStart = Math.max(start, g.base);
      var ovEnd = Math.min(end, g.end - 1);
      if (ovStart <= ovEnd) {
        hits.push({
          name: t.title || t.name || '(unnamed)',
          address: t.address,
          addressHex: hex(g.base, 6),
          tableStart: g.base,
          tableEnd: g.end,
          totalElements: g.rows * g.cols,
          elementSizeBits: g.eb === 2 ? 16 : 8,
          equation: (t.zAxis && t.zAxis.equation) || '',
          units: (t.zAxis && t.zAxis.units) || '',
          overlapStart: ovStart,
          overlapEnd: ovEnd,
          overlapStartHex: hex(ovStart, 6),
          overlapEndHex: hex(ovEnd, 6)
        });
      }
    }
    return hits;
  }

  /* ---------- diff ---------- */

  function checkBin(bin, label) {
    if (!(bin instanceof Uint8Array) || bin.length !== BIN_IMAGE_SIZE) {
      var got = bin == null ? 'null/undefined'
        : (bin instanceof Uint8Array ? bin.length + ' bytes' : typeof bin);
      throw new Error('P66.diffBins: ' + label +
        ' must be a Uint8Array of ' + BIN_IMAGE_SIZE + ' bytes (got ' + got + ').');
    }
  }

  /**
   * Byte-compare two 64KB binaries. Coalesces adjacent differing bytes into
   * regions and labels each region with overlapping catalog tables.
   */
  function diffBins(binA, binB, catalog) {
    checkBin(binA, 'binA');
    checkBin(binB, 'binB');

    var diffOffsets = [];
    for (var i = 0; i < BIN_IMAGE_SIZE; i++) {
      if (binA[i] !== binB[i]) diffOffsets.push(i);
    }

    var regions = [];
    var start = null, prev = null;
    diffOffsets.forEach(function (off) {
      if (start === null) { start = off; prev = off; return; }
      if (off === prev + 1) { prev = off; return; }
      regions.push(makeRegion(binA, binB, start, prev, catalog));
      start = off; prev = off;
    });
    if (start !== null) regions.push(makeRegion(binA, binB, start, prev, catalog));

    var changedBytes = diffOffsets.length;
    return {
      byteCount: BIN_IMAGE_SIZE,
      changedBytes: changedBytes,
      identical: changedBytes === 0,
      regions: regions
    };
  }

  function makeRegion(binA, binB, start, end, catalog) {
    return {
      start: start,
      end: end,
      length: end - start + 1,
      startHex: hex(start, 6),
      endHex: hex(end, 6),
      oldBytes: binA.slice(start, end + 1),
      newBytes: binB.slice(start, end + 1),
      tables: labelTables(start, end, catalog)
    };
  }

  /* ---------- summary ---------- */

  /**
   * Per-table old->new value ranges, decoded through each table's equation
   * where a supported form exists. Elements touched by a region boundary
   * still decode the full element (big-endian) and are counted as changed.
   */
  function diffSummary(diff) {
    var perTable = {};   // name -> aggregate
    var order = [];
    var unlabeledBytes = 0;
    var unlabeledRegions = 0;

    diff.regions.forEach(function (r) {
      if (!r.tables.length) { unlabeledBytes += r.length; unlabeledRegions++; }
      r.tables.forEach(function (t) {
        var key = t.name + '|' + t.addressHex;
        var agg = perTable[key];
        if (!agg) {
          agg = perTable[key] = {
            name: t.name,
            addressHex: t.addressHex,
            units: t.units,
            equation: t.equation,
            decoded: decodeMathEquation(t.equation, 1) !== null,
            changedBytes: 0,
            totalElements: t.totalElements,
            elementSizeBits: t.elementSizeBits,
            oldMin: Infinity, oldMax: -Infinity,
            newMin: Infinity, newMax: -Infinity,
            changedElements: 0,
            partialElements: 0
          };
          order.push(key);
        }
        var eb = t.elementSizeBits === 16 ? 2 : 1;
        var elFirst = Math.floor((t.overlapStart - t.tableStart) / eb);
        var elLast = Math.floor((t.overlapEnd - t.tableStart) / eb);
        for (var el = elFirst; el <= elLast; el++) {
          var elAddr = t.tableStart + el * eb;
          // Byte indexes into this region's slices.
          var oldRaw = 0, newRaw = 0, changedInEl = 0;
          for (var b = 0; b < eb; b++) {
            var addr = elAddr + b;
            var idx = addr - r.start;
            if (idx < 0 || idx >= r.oldBytes.length) continue; // element spans region edge
            var ob = r.oldBytes[idx], nb = r.newBytes[idx];
            if (ob !== nb) changedInEl++;
            if (eb === 2) {
              if (b === 0) { oldRaw = ob << 8; newRaw = nb << 8; }
              else { oldRaw |= ob; newRaw |= nb; }
            } else { oldRaw = ob; newRaw = nb; }
          }
          if (!changedInEl) continue;
          agg.changedBytes += changedInEl;
          agg.changedElements++;
          if (changedInEl < eb) agg.partialElements++;
          var ov = agg.decoded ? decodeMathEquation(t.equation, oldRaw) : oldRaw;
          var nv = agg.decoded ? decodeMathEquation(t.equation, newRaw) : newRaw;
          if (ov < agg.oldMin) agg.oldMin = ov;
          if (ov > agg.oldMax) agg.oldMax = ov;
          if (nv < agg.newMin) agg.newMin = nv;
          if (nv > agg.newMax) agg.newMax = nv;
        }
      });
    });

    var tables = order.map(function (key) {
      var a = perTable[key];
      var eb = a.elementSizeBits === 16 ? 2 : 1;
      var oldText, newText;
      if (a.decoded) {
        oldText = rangeText(a.oldMin, a.oldMax, fmtNum) + (a.units ? ' ' + a.units : '');
        newText = rangeText(a.newMin, a.newMax, fmtNum) + (a.units ? ' ' + a.units : '');
      } else {
        oldText = rangeText(a.oldMin, a.oldMax, function (v) { return fmtHexRaw(v, eb); }) + ' (raw)';
        newText = rangeText(a.newMin, a.newMax, function (v) { return fmtHexRaw(v, eb); }) + ' (raw)';
      }
      return {
        name: a.name,
        addressHex: a.addressHex,
        units: a.units,
        equation: a.equation,
        decoded: a.decoded,
        changedBytes: a.changedBytes,
        changedElements: a.changedElements,
        totalElements: a.totalElements,
        partialElements: a.partialElements,
        oldMin: a.oldMin,
        oldMax: a.oldMax,
        newMin: a.newMin,
        newMax: a.newMax,
        oldText: oldText,
        newText: newText
      };
    });

    return {
      identical: diff.identical,
      changedBytes: diff.changedBytes,
      regionCount: diff.regions.length,
      tables: tables,
      unlabeled: { bytes: unlabeledBytes, regions: unlabeledRegions }
    };
  }

  function rangeText(lo, hi, fmt) {
    if (lo === Infinity) return '—';
    return lo === hi ? fmt(lo) : fmt(lo) + ' – ' + fmt(hi);
  }

  /* ---------- HTML render (string building only) ---------- */

  var EMPTY_STATE_TEXT = 'The two binaries are identical — no differences found.';
  P66.BINDIFF_EMPTY_TEXT = EMPTY_STATE_TEXT;

  var SAFETY_NOTE =
    'Informational only: this comparison reports which bytes differ and does ' +
    'not verify either binary. It does not indicate whether a binary is safe to flash.';

  function renderDiffHTML(diff) {
    if (!diff || diff.identical || !diff.regions.length) {
      return '<div class="p66-bindiff-empty">' + escHtml(EMPTY_STATE_TEXT) + '</div>';
    }
    var summary = diffSummary(diff);
    var pct = (100 * diff.changedBytes / diff.byteCount).toFixed(2);

    var html = '<div class="p66-bindiff">';
    html += '<div class="p66-bindiff-head"><strong>' + diff.changedBytes +
      '</strong> byte' + (diff.changedBytes === 1 ? '' : 's') + ' differ across ' +
      '<strong>' + diff.regions.length + '</strong> region' +
      (diff.regions.length === 1 ? '' : 's') +
      ' <span class="p66-bindiff-mute">(' + pct + '% of the 64KB image)</span></div>';

    html += '<div class="p66-bindiff-tables">';
    summary.tables.forEach(function (t) {
      var barPct = t.totalElements
        ? Math.max(1, Math.round(100 * t.changedElements / t.totalElements)) : 0;
      html += '<div class="p66-bindiff-table">';
      html += '<div class="p66-bindiff-row">' +
        '<span class="p66-bindiff-name">' + escHtml(t.name) + '</span>' +
        '<span class="p66-bindiff-addr">' + escHtml(t.addressHex) + '</span>' +
        '<span class="p66-bindiff-vals">' + escHtml(t.oldText) + ' → ' +
        escHtml(t.newText) + '</span></div>';
      html += '<div class="p66-bindiff-bar"><i style="width:' + barPct + '%"></i></div>';
      html += '<div class="p66-bindiff-sub">' + t.changedElements + ' of ' +
        t.totalElements + ' element' + (t.totalElements === 1 ? '' : 's') +
        ' changed (' + t.changedBytes + ' bytes)' +
        (t.partialElements ? ' · ' + t.partialElements + ' partially covered' : '') +
        (t.decoded ? '' : ' · raw bytes, no equation') + '</div>';
      html += '</div>';
    });
    html += '</div>';

    if (summary.unlabeled.bytes) {
      html += '<div class="p66-bindiff-unlabeled"><div class="p66-bindiff-unlabeled-head">' +
        summary.unlabeled.bytes + ' changed byte' +
        (summary.unlabeled.bytes === 1 ? '' : 's') +
        ' outside catalog tables (' + summary.unlabeled.regions + ' region' +
        (summary.unlabeled.regions === 1 ? '' : 's') + ')</div>';
      diff.regions.forEach(function (r) {
        if (r.tables.length) return;
        html += '<div class="p66-bindiff-row p66-bindiff-rawrow">' +
          '<span class="p66-bindiff-name">uncatalogued</span>' +
          '<span class="p66-bindiff-addr">' + escHtml(r.startHex) + '–' +
          escHtml(r.endHex) + '</span>' +
          '<span class="p66-bindiff-vals">' + escHtml(hexPreview(r.oldBytes)) +
          ' → ' + escHtml(hexPreview(r.newBytes)) + '</span></div>';
      });
      html += '</div>';
    }

    html += '<div class="p66-bindiff-note">' + escHtml(SAFETY_NOTE) + '</div>';
    html += '</div>';
    return html;
  }

  /* ---------- exports ---------- */

  P66.diffBins = diffBins;
  P66.diffSummary = diffSummary;
  P66.renderDiffHTML = renderDiffHTML;
  P66.decodeMathEquation = decodeMathEquation;

  /* ------------------------------------------------------------------
   * WIRING SNIPPET (for the coordinator wiring the UI; not executed)
   *
   *   <!-- index.html -->
   *   <input type="file" id="bindiff-a" accept=".bin">
   *   <input type="file" id="bindiff-b" accept=".bin">
   *   <button id="bindiff-run">Compare binaries</button>
   *   <div id="bindiff-out"></div>
   *
   *   // app.js (load js/bindiff.js — and js/bundled-catalog.js — before this)
   *   function readBinFile(file) {
   *     return new Promise(function (resolve, reject) {
   *       var fr = new FileReader();
   *       fr.onload = function () { resolve(new Uint8Array(fr.result)); };
   *       fr.onerror = function () { reject(new Error('Could not read ' + file.name)); };
   *       fr.readAsArrayBuffer(file);
   *     });
   *   }
   *   document.getElementById('bindiff-run').addEventListener('click', function () {
   *     var fa = document.getElementById('bindiff-a').files[0];
   *     var fb = document.getElementById('bindiff-b').files[0];
   *     var out = document.getElementById('bindiff-out');
   *     if (!fa || !fb) { out.textContent = 'Pick two .bin files to compare.'; return; }
   *     Promise.all([readBinFile(fa), readBinFile(fb)]).then(function (bins) {
   *       var diff = P66.diffBins(bins[0], bins[1]); // throws on non-64KB input
   *       out.innerHTML = P66.renderDiffHTML(diff);
   *     }).catch(function (err) { out.textContent = 'Diff failed: ' + err.message; });
   *   });
   * ------------------------------------------------------------------ */

})(typeof window !== 'undefined' ? window : global);
