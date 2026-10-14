/* P66-Tuner log compare (before/after tune)
 *
 * Compares fuel trims across two logs on the same RPM x MAP cell grid the
 * rest of the app uses, so a "before tune" and "after tune" log can be
 * judged cell by cell: did the tune move each cell closer to stoich?
 *
 *   P66.compareLogs(a, mapA, b, mapB) -> result
 *     a / b : { parsedLog, mapResult } records (each may also be passed as a
 *             bare parsed log with the map result in mapA/mapB). b may be
 *             null, meaning "no second log yet".
 *     result: {
 *       available: bool, reason: string|null, compared: bool (false when b is null),
 *       cells: [{ rpm, map, trimA, trimB, delta, nA, nB }],
 *         rpm/map are the cell bin labels ("1000-1500", "40-50");
 *         trims are in GM 128-count units (128 = stoich); trimB/delta are
 *         null for cells present in only one log.
 *       improved, worsened, unchanged, singleSided: counts
 *     }
 *   P66.renderCompare(container, result) -> renders summary + delta table.
 *
 * Works in browser and node (DOM guarded). No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // ---- cell bucketing ----
  // Copied from js/analyzer.js (rpmBin/mapBin) so compare cells line up
  // exactly with the fuel-trim cells everywhere else in the app:
  // 500-RPM bins ("1000-1500") x 10-kPa MAP bins ("40-50").
  function rpmBin(rpm, width) {
    width = width || 500;
    var b = Math.floor(rpm / width) * width;
    return b + '-' + (b + width);
  }

  function mapBin(map, width) {
    width = width || 10;
    var b = Math.floor(map / width) * width;
    return b + '-' + (b + width);
  }

  /*
   * COMBINED-TRIM CONVENTION (reused from js/analyzer.js analyzeFuelTrims):
   *   1. Each trim channel is normalized to percent with P66.detectTrimStyle
   *      + P66.trimToPct (handles percent, multiplier, and GM 128-count
   *      encodings the same way the tuner does).
   *   2. Per bank: combinedTrim_pct = STFT_pct + LTFT_pct (a missing
   *      channel counts as 0, same as the analyzer).
   *   3. Row combined trim = mean of the bank trims.
   *   4. Cell trim = mean of the row combined trims over the gated rows.
   *   5. Reported in GM 128-count units: counts = 128 * (1 + pct/100), so
   *      128 = stoich, >128 = lean (ECU adding fuel), <128 = rich.
   * Sample-quality gating (P66.qualityRows) is reused too: cold-warmup and
   * transient rows are excluded before averaging, exactly like the tuner.
   */
  function pctToCounts(pct) {
    return 128 * (1 + pct / 100);
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  function sampleColumn(rows, col, max) {
    max = max || 500;
    var out = [];
    for (var i = 0; i < rows.length && out.length < max; i++) {
      var v = num(rows[i][col]);
      if (v !== null) out.push(v);
    }
    return out;
  }

  // Mean combined trim per cell (128-count units) for one log.
  function cellTrims(parsedLog, mapResult) {
    var raw = (parsedLog && parsedLog.rows) || parsedLog || [];
    var rows = Array.isArray(raw) ? raw.slice() : [];
    if (typeof P66.segmentRows === 'function') P66.segmentRows(rows, mapResult);
    var q = (typeof P66.qualityRows === 'function')
      ? P66.qualityRows(rows, mapResult)
      : { rows: rows };
    var banks = P66.fuelTrimBanks(mapResult);
    var rpmCol = P66.columnFor(mapResult, 'RPM');
    var mapCol = P66.columnFor(mapResult, 'MAP');
    if (!banks.length || !rpmCol || !mapCol) {
      return { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
    }
    // Detect each trim column's encoding once, on the gated rows.
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleColumn(q.rows, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleColumn(q.rows, b.ltft)) : 'percent'
      };
    });
    var cells = {}; // "rpmBin|mapBin" -> { rpmBin, mapBin, sum, n }
    q.rows.forEach(function (row) {
      var rpm = num(row[rpmCol]);
      var map = num(row[mapCol]);
      if (rpm === null || map === null) return;
      var sum = 0, n = 0;
      banks.forEach(function (b, bi) {
        var stft = b.stft ? P66.trimToPct(num(row[b.stft]), styles[bi].stft) : 0;
        var ltft = b.ltft ? P66.trimToPct(num(row[b.ltft]), styles[bi].ltft) : 0;
        sum += stft + ltft;
        n++;
      });
      var combinedPct = n ? sum / n : 0;
      var key = rpmBin(rpm) + '|' + mapBin(map);
      var c = cells[key];
      if (!c) c = cells[key] = { rpmBin: rpmBin(rpm), mapBin: mapBin(map), sum: 0, n: 0 };
      c.sum += combinedPct;
      c.n++;
    });
    var out = {};
    Object.keys(cells).forEach(function (key) {
      var c = cells[key];
      out[key] = {
        rpmBin: c.rpmBin,
        mapBin: c.mapBin,
        trim: round2(pctToCounts(c.sum / c.n)), // 128-count units
        n: c.n // gated (warm, steady-state) sample count
      };
    });
    return { available: true, cells: out };
  }

  var IMPROVE_MIN_DELTA = 1.0; // counts; smaller moves are noise

  function verdictFor(trimA, trimB, delta) {
    if (delta === null) return 'single';
    if (Math.abs(delta) < IMPROVE_MIN_DELTA) return 'unchanged';
    var devA = Math.abs(trimA - 128), devB = Math.abs(trimB - 128);
    if (devB < devA) return 'improved';
    if (devB > devA) return 'worsened';
    return 'unchanged'; // moved >= 1 count but equidistant from stoich
  }

  function compareLogs(a, mapA, b, mapB) {
    // Accept {parsedLog, mapResult} records, or bare (parsed, map) pairs.
    function unpack(rec, mapArg) {
      rec = rec || {};
      return {
        parsed: rec.parsedLog || rec,
        map: mapArg || rec.mapResult
      };
    }
    var A = unpack(a, mapA);
    var tA = cellTrims(A.parsed, A.map);
    var tB = null;
    if (b) {
      var B = unpack(b, mapB);
      tB = cellTrims(B.parsed, B.map);
    }

    var cells = [];
    var available = tA.available && (!tB || tB.available);
    if (available) {
      var keys = {};
      Object.keys(tA.cells).forEach(function (k) { keys[k] = true; });
      if (tB) Object.keys(tB.cells).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (key) {
        var ca = tA.cells[key];
        var cb = tB ? tB.cells[key] : undefined;
        var parts = key.split('|');
        var trimA = ca ? ca.trim : null;
        var trimB = cb ? cb.trim : null;
        var delta = (ca && cb) ? round2(trimB - trimA) : null;
        cells.push({
          rpm: parts[0],
          map: parts[1],
          trimA: trimA,
          trimB: trimB,
          delta: delta,
          nA: ca ? ca.n : 0,
          nB: cb ? cb.n : 0,
          status: verdictFor(trimA, trimB, delta)
        });
      });
    }
    var improved = 0, worsened = 0, unchanged = 0, singleSided = 0;
    cells.forEach(function (c) {
      if (c.status === 'improved') improved++;
      else if (c.status === 'worsened') worsened++;
      else if (c.status === 'unchanged') unchanged++;
      else singleSided++;
    });
    // Biggest absolute moves first; single-log cells last.
    cells.sort(function (x, y) {
      var ax = x.delta === null ? -1 : Math.abs(x.delta);
      var ay = y.delta === null ? -1 : Math.abs(y.delta);
      return ay - ax;
    });

    return {
      available: available,
      reason: !tA.available ? tA.reason
        : (tB && !tB.available ? tB.reason : null),
      compared: !!tB,
      cells: cells,
      improved: improved,
      worsened: worsened,
      unchanged: unchanged,
      singleSided: singleSided
    };
  }

  // ---- rendering ----

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Trim cell color: 128 = stoich; above (lean, adding fuel) blue,
  // below (rich, removing fuel) red; near-128 muted.
  function trimClass(v) {
    if (v === null || v === undefined) return 'p66-cmp-mute';
    var d = v - 128;
    if (Math.abs(d) < 0.5) return 'p66-cmp-mute';
    return d > 0 ? 'p66-cmp-pos' : 'p66-cmp-neg';
  }

  // Delta color: engine runs leaner after (delta > 0) blue,
  // richer after (delta < 0) red, ~0 muted.
  function deltaClass(d) {
    if (d === null || d === undefined) return 'p66-cmp-mute';
    if (Math.abs(d) < IMPROVE_MIN_DELTA) return 'p66-cmp-mute';
    return d > 0 ? 'p66-cmp-pos' : 'p66-cmp-neg';
  }

  function fmt(v) {
    return (v === null || v === undefined) ? '—' : Number(v).toFixed(1);
  }

  function renderCompare(container, result) {
    if (typeof document === 'undefined') return; // node-safe no-op
    if (!container) return;
    if (!result || !result.compared) {
      container.innerHTML =
        '<div class="p66-cmp-empty">Load a second log to compare.</div>';
      return;
    }
    if (!result.available) {
      container.innerHTML = '<div class="p66-cmp-empty">' +
        escHtml(result.reason || 'No fuel-trim data to compare.') + '</div>';
      return;
    }
    var html = '<div class="p66-cmp-wrap">';
    html += '<div class="p66-cmp-summary"><strong>' + result.improved +
      '</strong> cells improved / <strong>' + result.worsened +
      '</strong> worsened / <strong>' + result.unchanged + '</strong> unchanged';
    if (result.singleSided) {
      html += ' <span class="p66-cmp-mute">(' + result.singleSided +
        ' cell(s) present in only one log)</span>';
    }
    html += '<div class="p66-cmp-legend">Trim delta in 128-count units ' +
      '(128 = stoich): <span class="p66-cmp-pos">blue = leaner after</span>, ' +
      '<span class="p66-cmp-neg">red = richer after</span>.</div></div>';
    html += '<table class="p66-cmp-table"><thead><tr>' +
      '<th>RPM</th><th>MAP</th><th>Trim A</th><th>Trim B</th>' +
      '<th>&Delta; (B&minus;A)</th><th>Status</th>' +
      '</tr></thead><tbody>';
    result.cells.forEach(function (c) {
      var statusClass = c.status === 'improved' ? 'p66-cmp-pos'
        : c.status === 'worsened' ? 'p66-cmp-neg' : 'p66-cmp-mute';
      var statusText = c.status === 'single'
        ? 'only in ' + (c.trimA === null ? 'B' : 'A')
        : c.status;
      html += '<tr>' +
        '<td>' + escHtml(c.rpm) + '</td>' +
        '<td>' + escHtml(c.map) + '</td>' +
        '<td class="' + trimClass(c.trimA) + '">' + fmt(c.trimA) + '</td>' +
        '<td class="' + trimClass(c.trimB) + '">' + fmt(c.trimB) + '</td>' +
        '<td class="' + deltaClass(c.delta) + '">' + fmt(c.delta) + '</td>' +
        '<td class="' + statusClass + '">' + escHtml(statusText) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  P66.compareLogs = compareLogs;
  P66.renderCompare = renderCompare;
  P66.COMPARE_MIN_DELTA = IMPROVE_MIN_DELTA;
})(typeof window !== 'undefined' ? window : global);
