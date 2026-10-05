/* P66-Tuner log parser
 * Parses CSV/TSV PCM log exports into structured data.
 * Plain script — attaches to the global P66 namespace (browser + node compatible).
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

  function coerceValue(raw) {
    if (raw === '' || raw === null || raw === undefined) return null;
    var n = Number(raw);
    if (raw !== '' && !isNaN(n) && isFinite(n)) return n;
    return raw;
  }

  /**
   * Parse raw log text.
   * Returns { headers, rows, delimiter, rowCount, columnCount, warnings }.
   * rows: array of objects keyed by header name, values coerced to numbers where possible.
   */
  function parseLogText(text) {
    var warnings = [];
    if (!text || !text.trim()) {
      return { headers: [], rows: [], delimiter: ',', rowCount: 0, columnCount: 0, warnings: ['Empty file'] };
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
      return { headers: [], rows: [], delimiter: delimiter, rowCount: 0, columnCount: 0, warnings: ['No data lines found'] };
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
    var headers = splitLine(nonBlank[headerIdx], delimiter);
    var columnCount = headers.length;
    if (columnCount < 2) {
      warnings.push('Only one column detected — delimiter may be wrong (detected: ' +
        (delimiter === '\t' ? 'TAB' : delimiter) + ').');
    }
    // De-duplicate headers (some loggers repeat names).
    var seen = {};
    headers = headers.map(function (h, i) {
      var name = h === '' ? ('col_' + i) : h;
      if (seen[name] !== undefined) {
        seen[name]++;
        name = name + '_' + seen[name];
      } else {
        seen[name] = 0;
      }
      return name;
    });

    var rows = [];
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
        if (!isNaN(Number(fields[f])) && isFinite(Number(fields[f]))) numericCount++;
      }
      if (checkCount > 0 && numericCount / checkCount < 0.5) { skippedNonNumeric++; continue; }
      var obj = {};
      for (var c = 0; c < columnCount; c++) {
        obj[headers[c]] = coerceValue(fields[c]);
      }
      rows.push(obj);
    }
    if (skipped > 0) {
      warnings.push(skipped + ' row(s) skipped due to column mismatch.');
    }
    if (skippedNonNumeric > 0) {
      warnings.push(skippedNonNumeric + ' non-data row(s) skipped (e.g. units row).');
    }
    return {
      headers: headers,
      rows: rows,
      delimiter: delimiter,
      rowCount: rows.length,
      columnCount: columnCount,
      warnings: warnings
    };
  }

  P66.parseLogText = parseLogText;
  P66.detectDelimiter = detectDelimiter;
})(typeof window !== 'undefined' ? window : global);
