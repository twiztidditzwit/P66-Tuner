/* P66-Tuner log parser
 * Parses CSV/TSV PCM log exports into structured data.
 * Plain script — attaches to the global P66 namespace (browser + node compatible).
 *
 * ============================================================================
 * DATA API — columnar log table
 * ============================================================================
 * P66.parseLogText(text) returns a "log table":
 *
 *   {
 *     headers:     [String]            header names, de-duplicated
 *     columns:     [Float32Array|null] numeric channels, parallel to headers
 *                                   (null entry = non-numeric channel; see stringCols)
 *     stringCols:  { NAME: [...] }    plain arrays for channels that are NOT
 *                                   all-numeric (rare; e.g. flag strings).
 *                                   Only present for non-numeric channels.
 *     colIndex:    { NAME: idx }      header name -> column index
 *     rowCount:    Number              samples in the log
 *     columnCount: Number              headers.length
 *     delimiter:   String              detected delimiter
 *     warnings:    [String]            parse notes (skipped rows, etc.)
 *     regions:     null | [String]     per-row operating region, set by
 *                                   P66.segmentRows(table, mapResult)
 *
 *     col(name)       -> Float32Array | Array | null
 *                        the channel's storage (numeric or string), null when unknown
 *     num(name, i)    -> Number | null
 *                        finite numeric value at row i, or null when the cell is
 *                        missing (NaN), the channel is non-numeric, or unknown
 *     isNumeric(name) -> Boolean
 *     row(i)          -> Object        SLOW-PATH compatibility helper: materializes
 *                        ONE row as { header: value } with the OLD row-object
 *                        semantics (missing -> null). O(columnCount) allocation
 *                        per call — for transitional/debugging use only, NEVER
 *                        in hot loops. Hot loops must index col(name)[i] and
 *                        treat NaN as missing.
 *
 * P66.numView(table, name) -> Float32Array | null: forgiving numeric view
 * for math — numeric channels return their storage directly (zero copy);
 * string channels return a cached per-cell-parsed Float32Array
 * (unparseable -> NaN), reproducing the old parser's per-cell coercion.
 *   }
 *
 * MISSING DATA: empty cells become NaN in numeric columns. This replaces the
 * old row-object convention where empty coerced to null. In columnar loops,
 * test with `v !== v` (NaN check) or use table.num(name, i), which maps NaN
 * back to null.
 *
 * NON-NUMERIC CHANNELS: a channel is numeric only when EVERY non-empty cell
 * parses as a finite number (same coercion the old per-cell parser used).
 * A channel with any non-empty non-numeric cell is stored whole in
 * stringCols (raw trimmed strings; empty cells -> null). Numeric code
 * reading such a channel via table.num() sees null (missing).
 *
 * INPUT FLEXIBILITY: analyzer entry points accept either a log table or a
 * legacy array of row objects (the pre-columnar shape). P66.asTable()
 * normalizes either form to a log table — legacy arrays are converted ONCE
 * at the function boundary, so hot loops always run on Float32Arrays.
 * ============================================================================
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var CANDIDATE_DELIMITERS = [',', '\t', ';', '|'];

  function detectDelimiter(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
    var sample = lines.slice(0, Math.min(5, lines.length));
    var best = ',';
    var bestScore = -1;
    CANDIDATE_DELIMITERS.forEach(function (d) {
      var counts = sample.map(function (l) { return l.split(d).length; });
      // Consistency matters more than raw count: low variance across lines wins.
      var mean = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
      var variance = counts.reduce(function (a, c) { return a + Math.pow(c - mean, 2); }, 0) / counts.length;
      var score = mean > 1 ? mean / (1 + variance) : -1;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  // Split one line respecting double-quoted fields.
  function splitLine(line, delimiter) {
    var fields = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === delimiter && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields.map(function (f) { return f.trim(); });
  }

  // True when a trimmed field parses as a finite number.
  function fieldIsNumeric(f) {
    if (f === '') return false;
    var n = Number(f);
    return !isNaN(n) && isFinite(n);
  }

  // De-duplicate headers (some loggers repeat names).
  function dedupeHeaders(headers) {
    var seen = {};
    return headers.map(function (h, i) {
      var name = h === '' ? ('col_' + i) : h;
      if (seen[name] !== undefined) {
        seen[name]++;
        name = name + '_' + seen[name];
      } else {
        seen[name] = 0;
      }
      return name;
    });
  }

  function makeTable(headers, columns, stringCols, colIndex, delimiter, warnings, rowCount) {
    var t = {
      headers: headers,
      columns: columns,
      stringCols: stringCols,
      colIndex: colIndex,
      rowCount: rowCount,
      columnCount: headers.length,
      delimiter: delimiter,
      warnings: warnings,
      regions: null, // set by P66.segmentRows(table, mapResult)
      col: function (name) {
        var i = colIndex[name];
        if (i === undefined) return null;
        var c = columns[i];
        return (c !== null && c !== undefined) ? c : (stringCols[name] || null);
      },
      num: function (name, i) {
        var c = this.col(name);
        if (!(c instanceof Float32Array)) return null;
        var v = c[i];
        return v !== v ? null : v; // NaN (missing) -> null
      },
      isNumeric: function (name) {
        var i = colIndex[name];
        return i !== undefined && columns[i] instanceof Float32Array;
      },
      // SLOW-PATH compatibility helper: materialize one row object with the
      // OLD row-object semantics (missing -> null). O(columnCount) per call —
      // for transitional/debugging use only, never in hot loops.
      row: function (i) {
        var obj = {};
        for (var h = 0; h < headers.length; h++) {
          var name = headers[h];
          var c = columns[h];
          if (c instanceof Float32Array) {
            var v = c[i];
            obj[name] = (v !== v) ? null : v;
          } else {
            obj[name] = stringCols[name][i];
          }
        }
        return obj;
      }
    };
    return t;
  }

  function emptyTable(delimiter, warnings) {
    return makeTable([], [], {}, {}, delimiter || ',', warnings || [], 0);
  }

  /**
   * Parse raw log text.
   * Returns a columnar log table (see DATA API above).
   * Missing/empty numeric cells become NaN (documented above).
   */
  function parseLogText(text) {
    var warnings = [];
    if (!text || !text.trim()) {
      return emptyTable(',', ['Empty file']);
    }
    var delimiter = detectDelimiter(text);
    var lines = text.split(/\r?\n/);
    // Drop leading blank lines / comment lines starting with # or ;
    var nonBlank = [];
    for (var li = 0; li < lines.length; li++) {
      var t = lines[li].trim();
      if (t === '' || /^[#;]/.test(t)) continue;
      nonBlank.push(lines[li]);
    }
    if (!nonBlank.length) {
      return emptyTable(delimiter, ['No data lines found']);
    }
    // Header = the first line carrying the most fields. This skips title lines
    // like TunerPro's "Engine data log recorded on ..." preamble.
    var headerIdx = 0, headerFields = 0;
    var scanLimit = Math.min(10, nonBlank.length);
    for (var s = 0; s < scanLimit; s++) {
      var fc = splitLine(nonBlank[s], delimiter).length;
      if (fc > headerFields) { headerFields = fc; headerIdx = s; }
    }
    if (headerIdx > 0) {
      warnings.push('Skipped ' + headerIdx + ' leading title line(s) before the header row.');
    }
    var headers = dedupeHeaders(splitLine(nonBlank[headerIdx], delimiter));
    var columnCount = headers.length;
    if (columnCount < 2) {
      warnings.push('Only one column detected — delimiter may be wrong (detected: ' +
        (delimiter === '\t' ? 'TAB' : delimiter) + ').');
    }
    var colIndex = {};
    headers.forEach(function (h, i) { colIndex[h] = i; });

    // Accumulate raw (trimmed string) fields per column.
    var rawCols = [];
    for (var c = 0; c < columnCount; c++) rawCols.push([]);
    var skipped = 0;
    var skippedNonNumeric = 0;
    for (var r = headerIdx + 1; r < nonBlank.length; r++) {
      var line = nonBlank[r];
      var fields = splitLine(line, delimiter);
      if (fields.length !== columnCount) {
        // Tolerate trailing empty fields; otherwise skip the row.
        while (fields.length < columnCount) fields.push('');
        if (fields.length > columnCount) { skipped++; continue; }
      }
      // Skip non-data rows (e.g. TunerPro's units row): if most fields are
      // non-numeric text, this isn't a sample.
      var numericCount = 0, checkCount = 0;
      for (var f = 0; f < fields.length; f++) {
        if (fields[f] === '') continue;
        checkCount++;
        if (fieldIsNumeric(fields[f])) numericCount++;
      }
      if (checkCount > 0 && numericCount / checkCount < 0.5) { skippedNonNumeric++; continue; }
      for (var c2 = 0; c2 < columnCount; c2++) rawCols[c2].push(fields[c2]);
    }
    if (skipped > 0) {
      warnings.push(skipped + ' row(s) skipped due to column mismatch.');
    }
    if (skippedNonNumeric > 0) {
      warnings.push(skippedNonNumeric + ' non-data row(s) skipped (e.g. units row).');
    }

    var rowCount = rawCols.length ? rawCols[0].length : 0;
    var columns = [];
    var stringCols = {};
    for (var c3 = 0; c3 < columnCount; c3++) {
      var vals = rawCols[c3];
      var allNumeric = true;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === '') continue;
        if (!fieldIsNumeric(vals[i])) { allNumeric = false; break; }
      }
      if (allNumeric) {
        var arr = new Float32Array(vals.length);
        for (var j = 0; j < vals.length; j++) {
          arr[j] = vals[j] === '' ? NaN : Number(vals[j]);
        }
        columns.push(arr);
      } else {
        columns.push(null);
        var sarr = new Array(vals.length);
        for (var k = 0; k < vals.length; k++) {
          sarr[k] = vals[k] === '' ? null : vals[k];
        }
        stringCols[headers[c3]] = sarr;
      }
    }

    return makeTable(headers, columns, stringCols, colIndex, delimiter, warnings, rowCount);
  }

  // ---- legacy-input adapters -------------------------------------------

  function isLogTable(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x) &&
      Array.isArray(x.columns) &&
      x.colIndex !== null && typeof x.colIndex === 'object' &&
      typeof x.col === 'function';
  }

  // Classify one legacy cell: missing | numeric | string.
  // Matches the old per-cell coerceValue semantics: ''/null/undefined ->
  // missing; finite numbers and numeric strings -> numeric; a non-finite
  // number (Infinity) counts as missing (the old num() mapped it to null
  // downstream anyway); anything else -> string.
  function classifyCell(v) {
    if (v === null || v === undefined || v === '') return 0; // missing
    if (typeof v === 'number') return isFinite(v) ? 1 : 0;
    var n = Number(v);
    return (!isNaN(n) && isFinite(n)) ? 1 : 2;
  }

  /**
   * Convert a legacy array of row objects (the pre-columnar shape) into a
   * log table. headers: optional explicit header list; otherwise the union
   * of row keys in first-seen order. The `_region` field (set by
   * P66.segmentRows on legacy rows) is lifted into table.regions and
   * excluded from the channels.
   */
  function tableFromRows(rows, headers) {
    rows = rows || [];
    var hdrs = [];
    var seen = {};
    function addHeader(name) {
      if (name === '_region' || seen[name] !== undefined) return;
      seen[name] = hdrs.length;
      hdrs.push(name);
    }
    if (headers && headers.length) {
      headers.forEach(addHeader);
    } else {
      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        if (!r || typeof r !== 'object') continue;
        Object.keys(r).forEach(addHeader);
      }
    }
    var n = rows.length;
    var colCount = hdrs.length;
    var kinds = new Array(colCount); // 0 = unseen, 1 = numeric, 2 = string
    for (var ck = 0; ck < colCount; ck++) kinds[ck] = 0;
    var regions = new Array(n);
    var anyRegion = false;
    // First pass: decide per-channel numeric vs string.
    for (var i = 0; i < n; i++) {
      var row = rows[i] || {};
      if (row._region !== undefined) { regions[i] = row._region; anyRegion = true; }
      for (var c = 0; c < colCount; c++) {
        if (kinds[c] === 2) continue;
        var kind = classifyCell(row[hdrs[c]]);
        if (kind === 2) kinds[c] = 2;
        else if (kind === 1) kinds[c] = 1;
      }
    }
    var columns = [];
    var stringCols = {};
    var colIndex = {};
    for (var c2 = 0; c2 < colCount; c2++) {
      colIndex[hdrs[c2]] = c2;
      if (kinds[c2] === 2) {
        columns.push(null);
        var sarr = new Array(n);
        for (var j = 0; j < n; j++) {
          var sv = (rows[j] || {})[hdrs[c2]];
          sarr[j] = (sv === null || sv === undefined || sv === '') ? null : sv;
        }
        stringCols[hdrs[c2]] = sarr;
      } else {
        var arr = new Float32Array(n);
        for (var k = 0; k < n; k++) {
          var v = (rows[k] || {})[hdrs[c2]];
          if (v === null || v === undefined || v === '') { arr[k] = NaN; continue; }
          var nv = (typeof v === 'number') ? v : Number(v);
          arr[k] = isFinite(nv) ? nv : NaN;
        }
        columns.push(arr);
      }
    }
    var t = makeTable(hdrs, columns, stringCols, colIndex, ',', [], n);
    if (anyRegion) t.regions = regions;
    return t;
  }

  /**
   * Normalize analyzer input to a log table. Accepts:
   *   - a log table (returned as-is, zero cost),
   *   - a legacy array of row objects (converted once),
   *   - a legacy parsed-log shape { rows: [...], headers: [...] }.
   * Returns null for null/undefined input.
   */
  function asTable(input) {
    if (!input) return null;
    if (isLogTable(input)) return input;
    if (Array.isArray(input)) return tableFromRows(input);
    if (Array.isArray(input.rows)) return tableFromRows(input.rows, input.headers);
    return tableFromRows([]);
  }

  /**
   * Compact a table to the rows where keep(i) is true. Returns a new table
   * with contiguous 0..rowCount indexing (columns, stringCols and regions
   * are all filtered the same way).
   */
  function filterTable(t, keep) {
    var idx = [];
    for (var i = 0; i < t.rowCount; i++) if (keep(i)) idx.push(i);
    var n = idx.length;
    var columns = t.columns.map(function (c) {
      if (!(c instanceof Float32Array)) return null;
      var a = new Float32Array(n);
      for (var j = 0; j < n; j++) a[j] = c[idx[j]];
      return a;
    });
    var stringCols = {};
    Object.keys(t.stringCols).forEach(function (name) {
      var src = t.stringCols[name];
      var a = new Array(n);
      for (var j = 0; j < n; j++) a[j] = src[idx[j]];
      stringCols[name] = a;
    });
    var ci = {};
    Object.keys(t.colIndex).forEach(function (k) { ci[k] = t.colIndex[k]; });
    var out = makeTable(t.headers.slice(), columns, stringCols, ci,
      t.delimiter, t.warnings.slice(), n);
    if (t.regions) {
      var rg = new Array(n);
      for (var k = 0; k < n; k++) rg[k] = t.regions[idx[k]];
      out.regions = rg;
    }
    return out;
  }

  /**
   * Forgiving numeric view of a channel for math: numeric channels return
   * their Float32Array directly (zero copy); non-numeric (string) channels
   * return a cached Float32Array parsed per cell (unparseable -> NaN).
   * This reproduces the old row-object parser's per-cell coercion, so a
   * stray 'n/a' or 'bad' string only blanks its own cell instead of
   * poisoning the whole channel. Returns null when the channel is unknown.
   */
  function numView(t, name) {
    if (!t || !name) return null;
    var i = t.colIndex[name];
    if (i === undefined) return null;
    var c = t.columns[i];
    if (c instanceof Float32Array) return c;
    var cache = t._numViews || (t._numViews = {});
    if (cache[name]) return cache[name];
    var src = t.stringCols[name];
    if (!src) return null;
    var a = new Float32Array(src.length);
    for (var k = 0; k < src.length; k++) {
      var s = src[k];
      if (s === null || s === undefined || s === '') { a[k] = NaN; continue; }
      var n = Number(s);
      a[k] = isFinite(n) ? n : NaN;
    }
    cache[name] = a;
    return a;
  }

  /**
   * Operating region for row i: the table's regions when segmented,
   * 'cruise' otherwise (same default the old row._region code used).
   */
  function regionAt(t, i) {
    if (!t || !t.regions) return 'cruise';
    return t.regions[i] || 'cruise';
  }

  /**
   * Rebuild a log table wrapper from plain serializable data — the shape a
   * table's fields take after structured cloning / worker transfer. The
   * column buffers (Float32Array, possibly transferred) are re-attached and
   * the same col()/num()/isNumeric()/row() API is restored via makeTable,
   * so analyzer code runs identically on the rebuilt table. Used by the
   * Web Worker path (js/analyzer-worker.js); plain data only, no functions.
   */
  function rewrapTable(data) {
    var cols = (data.columns || []).map(function (c) {
      return (c instanceof Float32Array) ? c : null;
    });
    var ci = {};
    Object.keys(data.colIndex || {}).forEach(function (k) { ci[k] = data.colIndex[k]; });
    var t = makeTable((data.headers || []).slice(), cols, data.stringCols || {}, ci,
      data.delimiter || ',', (data.warnings || []).slice(), data.rowCount || 0);
    if (data.regions) t.regions = data.regions;
    return t;
  }

  P66.parseLogText = parseLogText;
  P66.detectDelimiter = detectDelimiter;
  P66.isLogTable = isLogTable;
  P66.asTable = asTable;
  P66.tableFromRows = tableFromRows;
  P66.filterTable = filterTable;
  P66.numView = numView;
  P66.regionAt = regionAt;
  P66.rewrapTable = rewrapTable;
})(typeof window !== 'undefined' ? window : global);
