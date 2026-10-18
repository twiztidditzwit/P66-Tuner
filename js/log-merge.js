/* P66-Tuner multi-log session merge.
 * Combines several parsed log tables into ONE log table so a single
 * analysis session covers more VE cells (e.g. an idle log + a cruise log
 * + a WOT log).
 *
 * Plain script — attaches to the global P66 namespace (browser + node
 * compatible). Load AFTER js/log-parser.js; it only uses P66.asTable and
 * P66.rewrapTable, so it stays pure (no DOM) and fully testable under node.
 *
 * ============================================================================
 * MERGE SEMANTICS
 * ============================================================================
 * P66.mergeLogTables(tables, sources) concatenates rows in the order the
 * tables are given:
 *
 *   - CHANNEL UNION: the merged header list is the union of all input
 *     headers, in first-seen order. A channel present in only some logs is
 *     filled with NaN (numeric channels) or null (string channels) for the
 *     rows of the logs that lack it — the same missing-data convention the
 *     parser itself uses.
 *   - MIXED-TYPE CHANNELS: if a channel is numeric in one log and a string
 *     channel in another, the whole merged channel is coerced to STRING
 *     (stringCols). Numeric values become their String() form; missing
 *     cells become null. Rationale: a string channel can hold anything, a
 *     Float32Array cannot — coercion must be loss-free in the direction of
 *     the wider type. P66.mergeCompatible() flags every such channel before
 *     the merge so the caller can warn the user.
 *   - PROVENANCE: a Uint16Array column named P66.SRC_LOG ('_srclog') records
 *     the 0-based index of the input table each row came from. It is an
 *     index column, not a signal: t.isNumeric('_srclog') is false, the
 *     channel mapper leaves it unmapped, and it is dropped (not corrupted)
 *     by the worker transfer path, which only moves Float32Array columns.
 *   - '_srclog' is RESERVED: a source log that already carries a channel of
 *     that name has it renamed to '_srclog_orig', '_srclog_orig_2', ...
 *     before merging, so provenance is never ambiguous.
 *   - merged.logSources = [{ name, rows }] parallel to the inputs, and
 *     merged.logName = names joined with ' + ', so the report/provenance
 *     layer records exactly which files (and how many rows each) fed the
 *     session. Merging an already-merged table works: its _srclog values
 *     are treated as numeric and copied (nested merges re-index from 0).
 *
 * The result is a REAL log table (built with P66.rewrapTable), so it is a
 * valid input to P66.analyzeSession, P66.analyzeSessionAsync (worker path),
 * playback, stripcharts and the dashboard. The accessors col()/num() also
 * understand the Uint16Array provenance column; row() (the slow-path debug
 * helper) handles it too.
 *
 * P66.mergeCompatible(tables) -> { ok, problems[] } is the pre-check:
 *   - ok is false only when there is nothing usable to merge (no tables,
 *     or every table empty).
 *   - problems[] carries warnings: logs sharing no channels at all, and
 *     numeric-vs-string clashes per channel (with the coerce-to-string
 *     resolution noted above).
 * ============================================================================
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Reserved provenance column: per-row 0-based index of the source table.
  var SRC_LOG = '_srclog';
  P66.SRC_LOG = SRC_LOG;

  function isTypedArray(c) {
    return (c instanceof Float32Array) || (c instanceof Uint16Array) ||
      (c instanceof Int16Array) || (c instanceof Uint8Array);
  }

  // A channel counts as "numeric-ish" when its storage is a typed array.
  // The parser only ever produces Float32Array, but merged tables carry a
  // Uint16Array _srclog — treating any typed array as numeric keeps
  // merge-of-merges well-defined.
  function channelNumeric(t, name) {
    var i = t.colIndex[name];
    if (i === undefined) return false;
    return isTypedArray(t.columns[i]);
  }

  function channelString(t, name) {
    var i = t.colIndex[name];
    if (i === undefined) return false;
    return t.columns[i] === null && t.stringCols && t.stringCols[name] !== undefined;
  }

  /**
   * Pre-merge compatibility check. Pure; safe to call on raw parse results
   * or legacy row arrays (normalized with P66.asTable).
   * Returns { ok: Boolean, problems: [String] }.
   */
  function mergeCompatible(tables) {
    var problems = [];
    var norm = (tables || []).map(function (t) { return P66.asTable(t); })
      .filter(function (t) { return !!t; });
    if (!norm.length) {
      return { ok: false, problems: ['No logs to merge.'] };
    }
    var withRows = norm.filter(function (t) { return t.rowCount > 0; });
    if (!withRows.length) {
      return { ok: false, problems: ['All logs are empty — nothing to merge.'] };
    }

    // Channel overlap across the non-empty tables.
    var headerSets = withRows.map(function (t) {
      var s = {};
      t.headers.forEach(function (h) { s[h] = true; });
      return s;
    });
    var shared = headerSets[0] ? Object.keys(headerSets[0]) : [];
    shared = shared.filter(function (h) {
      return headerSets.every(function (s) { return !!s[h]; });
    });
    // Ignore the reserved provenance column when judging overlap: it is
    // merge bookkeeping, not log data.
    var sharedData = shared.filter(function (h) { return h !== SRC_LOG; });
    if (!sharedData.length && withRows.length > 1) {
      problems.push('The logs share no common channels — the merged session ' +
        'will analyze each log\'s channels in isolation.');
    }

    // Numeric-vs-string clashes (resolved at merge time by coercing the
    // whole channel to string).
    var seenNumeric = {}, seenString = {};
    withRows.forEach(function (t) {
      t.headers.forEach(function (h) {
        if (h === SRC_LOG) return;
        if (channelNumeric(t, h)) seenNumeric[h] = true;
        else if (channelString(t, h)) seenString[h] = true;
      });
    });
    Object.keys(seenString).forEach(function (h) {
      if (seenNumeric[h]) {
        problems.push('Channel "' + h + '" is numeric in one log and text in ' +
          'another — it will be merged as a text channel.');
      }
    });

    return { ok: true, problems: problems };
  }

  /**
   * Merge parsed log tables into one table. `sources` is an optional array
   * parallel to `tables` with { name, rows } per log; it feeds
   * merged.logSources / merged.logName for report provenance.
   */
  function mergeLogTables(tables, sources) {
    var norm = (tables || []).map(function (t) { return P66.asTable(t); })
      .filter(function (t) { return !!t; });
    if (!norm.length) {
      throw new Error('mergeLogTables: no tables to merge');
    }
    var src = sources || [];
    var labels = norm.map(function (t, i) {
      var s = src[i] || {};
      return {
        name: (s.name !== undefined && s.name !== null) ? String(s.name) : ('log ' + (i + 1)),
        rows: t.rowCount
      };
    });

    // Reserve the provenance name: rename any pre-existing _srclog channel
    // in the inputs so it cannot collide with merge bookkeeping.
    var rename = {}; // tableIdx -> { oldName: newName }
    norm.forEach(function (t, ti) {
      var taken = {};
      t.headers.forEach(function (h) {
        if (h !== SRC_LOG) return;
        var n = SRC_LOG + '_orig', k = 2;
        while (taken[n] || t.colIndex[n] !== undefined) { n = SRC_LOG + '_orig_' + (k++); }
        taken[n] = true;
        (rename[ti] = rename[ti] || {})[h] = n;
      });
    });
    function outName(ti, h) {
      return (rename[ti] && rename[ti][h]) ? rename[ti][h] : h;
    }

    // Union of headers, first-seen order.
    var headers = [];
    var seen = {};
    norm.forEach(function (t, ti) {
      t.headers.forEach(function (h) {
        var n = outName(ti, h);
        if (!seen[n]) { seen[n] = true; headers.push(n); }
      });
    });
    headers.push(SRC_LOG);

    // Per-channel merged type: string wins over numeric (documented rule).
    var asString = {};
    norm.forEach(function (t, ti) {
      t.headers.forEach(function (h) {
        var n = outName(ti, h);
        if (asString[n]) return;
        if (channelString(t, h)) asString[n] = true;
      });
    });

    var total = norm.reduce(function (a, t) { return a + t.rowCount; }, 0);
    var colIndex = {};
    headers.forEach(function (h, i) { colIndex[h] = i; });
    var columns = new Array(headers.length);
    var stringCols = {};

    headers.forEach(function (name, hi) {
      if (name === SRC_LOG) {
        columns[hi] = null; // filled below with the real Uint16Array
        return;
      }
      if (asString[name]) {
        var arr = new Array(total);
        for (var q = 0; q < total; q++) arr[q] = null;
        var off = 0;
        norm.forEach(function (t, ti) {
          var orig = null;
          t.headers.forEach(function (h) { if (outName(ti, h) === name) orig = h; });
          if (orig !== null) {
            var ci = t.colIndex[orig];
            var col = t.columns[ci];
            if (isTypedArray(col)) {
              for (var r = 0; r < t.rowCount; r++) {
                var v = col[r];
                arr[off + r] = (v !== v) ? null : String(v);
              }
            } else {
              var scol = t.stringCols[orig] || [];
              for (var r2 = 0; r2 < t.rowCount; r2++) {
                var s = scol[r2];
                arr[off + r2] = (s === undefined) ? null : s;
              }
            }
          }
          off += t.rowCount;
        });
        columns[hi] = null;
        stringCols[name] = arr;
      } else {
        var num = new Float32Array(total);
        for (var f = 0; f < total; f++) num[f] = NaN;
        var o = 0;
        norm.forEach(function (t, ti) {
          var orig2 = null;
          t.headers.forEach(function (h) { if (outName(ti, h) === name) orig2 = h; });
          if (orig2 !== null) {
            var c2 = t.columns[t.colIndex[orig2]];
            if (isTypedArray(c2)) num.set(c2, o);
          }
          o += t.rowCount;
        });
        columns[hi] = num;
      }
    });

    // Provenance column: which input table each row came from.
    var srcCol = new Uint16Array(total);
    var w = 0;
    norm.forEach(function (t, ti) {
      for (var r = 0; r < t.rowCount; r++) srcCol[w + r] = ti;
      w += t.rowCount;
    });

    var warnings = ['Merged ' + norm.length + ' log(s) (' +
      labels.map(function (l) { return l.name; }).join(', ') + '): ' +
      total + ' rows total.'];
    norm.forEach(function (t, ti) {
      (t.warnings || []).forEach(function (msg) {
        warnings.push('[' + labels[ti].name + '] ' + msg);
      });
    });

    var raw = {
      headers: headers,
      colIndex: colIndex,
      rowCount: total,
      columnCount: headers.length,
      delimiter: norm[0].delimiter || ',',
      warnings: warnings,
      stringCols: stringCols,
      regions: null,
      columns: columns
    };
    var merged = P66.rewrapTable(raw);

    // rewrapTable nulls non-Float32Array columns (the Uint16Array never
    // survives structured transfer either); re-attach it here so the
    // main-thread table carries real provenance.
    merged.columns[colIndex[SRC_LOG]] = srcCol;

    // The stock col()/num()/row() closures only understand Float32Array +
    // stringCols — extend them minimally so the provenance column reads
    // correctly without special-casing call sites.
    var baseNum = merged.num;
    merged.num = function (name, i) {
      var c = this.col(name);
      if (c instanceof Float32Array || c instanceof Uint16Array) {
        var v = c[i];
        return v !== v ? null : v;
      }
      return baseNum.call(this, name, i);
    };
    merged.row = function (i) {
      var obj = {};
      // NOTE: rewrapTable() copies the columns array, so read the live one
      // off the table (it holds the re-attached Uint16Array _srclog).
      var liveCols = merged.columns;
      for (var h = 0; h < headers.length; h++) {
        var cname = headers[h];
        var c = liveCols[h];
        if (isTypedArray(c)) {
          var v = c[i];
          obj[cname] = (v !== v) ? null : v;
        } else {
          var sc = stringCols[cname] || [];
          obj[cname] = (sc[i] === undefined) ? null : sc[i];
        }
      }
      return obj;
    };

    merged.logSources = labels.map(function (l) { return { name: l.name, rows: l.rows }; });
    merged.logName = labels.map(function (l) { return l.name; }).join(' + ');
    return merged;
  }

  P66.mergeCompatible = mergeCompatible;
  P66.mergeLogTables = mergeLogTables;

})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
