/* P66-Tuner PE commanded-vs-actual verification
 *
 * After analyzePeEntry finds wide-open-throttle episodes, this module asks
 * the next question: during those pulls, does the PCM's commanded AFR agree
 * with what the Power Enrichment Target AFR table in the ANALYZED BIN says
 * it should command at that RPM?
 *
 * This is a trust check on the whole pipeline, not a tune suggestion:
 *   - If commanded matches the table, the app's PE advice (lower the TPS%
 *     entry threshold, richen/lean the PE table) is being aimed at the right
 *     data and the right bin.
 *   - If commanded systematically disagrees with the table, one of three
 *     things is happening: the wrong bin is being analyzed (not the one that
 *     was in the PCM when the log was recorded), the PE table axis is being
 *     read differently than the PCM reads it, or PE is not really engaging
 *     and the PCM is commanding something else.
 *
 *   P66.verifyPeCommanded(report, catalog, binBytes)
 *     report   { rows, mapResult } — raw log rows + channel mapping
 *              (the same rows/mapResult passed to P66.analyzePeEntry).
 *     catalog  XDF catalog (P66.findTable-compatible), e.g. P66.BUNDLED_CATALOG.
 *     binBytes Uint8Array of the ANALYZED bin — the PE table is read from
 *              these bytes, not from a stock reference.
 *     -> { available, reason, episodes, mismatches, verdict, message,
 *          tableName, toleranceAfr }
 *
 *   P66.renderPeVerifyHTML(result) -> compact dashboard HTML (string).
 *
 * Episode detection mirrors js/analyzer.js analyzePeEntry (TPS >= 60%
 * sustained 7+ samples; PE engaged = commanded AFR < 0.95 * 14.7).
 * Episodes where PE never engaged cannot verify anything and are skipped.
 *
 * Narrowband only: commanded AFR comes from the PCM's commanded lambda/AFR
 * channel (CMD_LAMBDA). A wideband channel, if present, is deliberately
 * ignored here — the question is what the PCM *commanded*, not what the
 * exhaust measured.
 *
 * Dependencies (load order): js/channel-mapper.js (P66.columnFor),
 * js/log-parser.js (P66.asTable, P66.numView), js/xdf-map.js
 * (P66.findTable, P66.readTable, P66.rawPerDegree). Works in browser and node.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Episode detection thresholds — must match js/analyzer.js analyzePeEntry
  // (PE_TPS_MIN, PE_EPISODE_MIN, PE_LAMBDA_MAX).
  var PE_TPS_MIN = 60;        // % TPS that counts as high throttle
  var PE_EPISODE_MIN = 7;     // sustained samples that make an episode (~1 s)
  var PE_LAMBDA_MAX = 0.95;   // commanded lambda below this = PE active
  var AFR_TOLERANCE = 0.3;    // match if |commanded - table| <= this (AFR)
  var STOICH = 14.7;

  // Candidate titles for the PE target table (findTable also does a
  // case-insensitive contains fallback on each candidate).
  var PE_TABLE_CANDIDATES = [
    'Power Enrichment Target AFR',
    'PE Target AFR',
    'Power Enrichment AFR',
    'PE AFR'
  ];

  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }

  // Normalize an AFR/lambda reading to AFR (gasoline stoich 14.7).
  // Mirrors analyzer.js toLambda, in the AFR domain.
  function toAfr(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    if (n > 5) return n;                 // already AFR
    if (n > 0.3 && n < 2.5) return n * STOICH; // lambda
    return null;
  }

  function axisBreakpoints(axis) {
    return ((axis && axis.labels) || []).map(function (l) { return parseFloat(l); })
      .filter(function (v) { return isFinite(v); });
  }

  function nearestIdx(bps, v) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < bps.length; i++) {
      var d = Math.abs(bps[i] - v);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }

  /**
   * P66.verifyPeCommanded(report, catalog, binBytes)
   *
   * For every PE episode in the log where enrichment actually engaged, read
   * the PCM's commanded AFR and compare it to what the PE Target AFR table
   * in the ANALYZED bin commands at the episode's RPM (and TPS/MAP when the
   * table is 2D on those axes).
   */
  function verifyPeCommanded(report, catalog, binBytes) {
    function unavailable(reason) {
      return { available: false, reason: reason, episodes: [], mismatches: [],
               verdict: null, message: null, tableName: null, toleranceAfr: AFR_TOLERANCE };
    }

    var rows = report && (report.rows || report.parsedRows);
    var mapResult = report && report.mapResult;
    if (!rows || !mapResult || !mapResult.mapping) {
      return unavailable('Need the log rows and channel mapping to check PE.');
    }
    if (!catalog || !catalog.tables) {
      return unavailable('Need an XDF catalog to find the PE Target AFR table.');
    }
    if (!binBytes || !binBytes.length) {
      return unavailable('Need the analyzed bin to read the PE Target AFR table from.');
    }
    var t = P66.asTable(rows);
    var tpsC = P66.numView(t, P66.columnFor(mapResult, 'TPS'));
    var cmdC = P66.numView(t, P66.columnFor(mapResult, 'CMD_LAMBDA'));
    var rpmC = P66.numView(t, P66.columnFor(mapResult, 'RPM'));
    var mapC = P66.numView(t, P66.columnFor(mapResult, 'MAP'));
    if (!tpsC) return unavailable('Need a TPS channel to find WOT pulls.');
    if (!cmdC) {
      return unavailable('No commanded lambda/AFR channel in this log — without the ' +
        'PCM\'s commanded channel there is nothing to compare the PE table against.');
    }

    // Episode detection (same scan as analyzePeEntry).
    var episodes = [];
    var cur = null;
    for (var i = 0; i < t.rowCount; i++) {
      var tps = tpsC[i];
      if (tps === tps && tps >= PE_TPS_MIN) {
        if (!cur) cur = { startRow: i, rows: [] };
        cur.rows.push(i);
      } else if (cur) {
        if (cur.rows.length >= PE_EPISODE_MIN) episodes.push(cur);
        cur = null;
      }
    }
    if (cur && cur.rows.length >= PE_EPISODE_MIN) episodes.push(cur);
    if (!episodes.length) return unavailable('No PE episodes in this log.');

    // PE Target AFR table from the analyzed bin.
    var table = null;
    for (var c = 0; c < PE_TABLE_CANDIDATES.length && !table; c++) {
      table = P66.findTable(catalog, PE_TABLE_CANDIDATES[c]);
    }
    if (!table) {
      return unavailable('The PE Target AFR table was not found in this definition (XDF catalog).');
    }
    var rd = P66.readTable(catalog, table.title, binBytes);
    if (!rd) {
      return unavailable('Could not read the PE Target AFR table from the analyzed bin.');
    }
    var rpu = P66.rawPerDegree(table.zAxis && table.zAxis.equation);
    if (rpu === null || !isFinite(rpu) || rpu <= 0) {
      return unavailable('PE table equation "' +
        ((table.zAxis && table.zAxis.equation) || '') +
        '" is not a supported linear form — refusing to guess the scaling.');
    }
    var rpmBp = axisBreakpoints(table.yAxis);
    if (!rpmBp.length) {
      return unavailable('The PE Target AFR table has no RPM axis to look up.');
    }
    var xBp = axisBreakpoints(table.xAxis);
    var xUnits = String((table.xAxis && table.xAxis.units) || '').toLowerCase();

    // Per-episode: commanded AFR vs table AFR at the episode's RPM.
    var results = [];
    episodes.forEach(function (ep) {
      // Only the engaged rows count — pre-engagement cruise rows would
      // pollute the mean toward stoich.
      var engaged = ep.rows.filter(function (k) {
        var a = toAfr(cmdC[k]);
        return a !== null && a < PE_LAMBDA_MAX * STOICH;
      });
      if (!engaged.length) return; // PE never engaged in this episode
      var sumA = 0, sumR = 0, nR = 0, sumT = 0, nT = 0, sumM = 0, nM = 0;
      engaged.forEach(function (k) {
        sumA += toAfr(cmdC[k]);
        if (rpmC && rpmC[k] === rpmC[k]) { sumR += rpmC[k]; nR++; }
        if (tpsC[k] === tpsC[k]) { sumT += tpsC[k]; nT++; }
        if (mapC && mapC[k] === mapC[k]) { sumM += mapC[k]; nM++; }
      });
      var n = engaged.length;
      var commandedAfr = sumA / n;
      var avgRpm = nR ? sumR / nR : null;
      var avgTps = nT ? sumT / nT : null;
      var avgMap = nM ? sumM / nM : null;

      var row = avgRpm !== null ? nearestIdx(rpmBp, avgRpm) : 0;
      var col = 0;
      if (rd.cols > 1 && xBp.length > 1) {
        var xv = null;
        if (/tps|%/.test(xUnits)) xv = avgTps;
        else if (/kpa|map/.test(xUnits)) xv = avgMap;
        else xv = avgTps !== null ? avgTps : avgMap;
        if (xv !== null) col = nearestIdx(xBp, xv);
      }
      var tableAfr = rd.values[row][col] / rpu;
      var delta = commandedAfr - tableAfr; // positive = PCM commanded leaner
      results.push({
        startRow: ep.startRow,
        samples: ep.rows.length,
        tps: avgTps !== null ? r1(avgTps) : null,
        rpm: avgRpm !== null ? Math.round(avgRpm) : null,
        commandedAfr: r2(commandedAfr),
        tableAfr: r2(tableAfr),
        delta: r2(delta),
        match: Math.abs(delta) <= AFR_TOLERANCE
      });
    });

    if (!results.length) {
      return unavailable('Found high-throttle pulls, but commanded AFR never dropped ' +
        'into enrichment — the PCM was not running the PE table in this log, so there ' +
        'is nothing to compare.');
    }

    var mismatches = results.filter(function (e) { return !e.match; });
    var ok = mismatches.length === 0;
    var plural = results.length > 1 ? 's' : '';
    var message;
    if (ok) {
      message = 'During ' + results.length + ' WOT pull' + plural +
        ' the PCM commanded the same AFR the PE Target AFR table in this bin calls for ' +
        '(within ' + AFR_TOLERANCE + ' AFR). Log and bin agree — PE tuning advice is ' +
        'aimed at the right data.';
    } else {
      var worst = 0;
      var sumD = 0;
      mismatches.forEach(function (e) {
        var a = Math.abs(e.delta);
        if (a > worst) worst = a;
        sumD += e.delta;
      });
      var dir = sumD > 0 ? 'leaner' : 'richer';
      message = mismatches.length + ' of ' + results.length + ' WOT pull' + plural +
        ' commanded an AFR that does not match the PE Target AFR table in this bin ' +
        '(off by up to ' + r2(worst) + ' AFR, on average ' + dir + ' than the table). ' +
        'Three usual causes: the analyzed bin is not the one that was in the PCM when ' +
        'the log was recorded, the PE table axis is being read differently than the PCM ' +
        'reads it, or PE is not really engaging and the PCM is commanding something ' +
        'else. Check the bin against the log before trusting PE suggestions.';
    }
    return {
      available: true,
      reason: null,
      episodes: results,
      mismatches: mismatches,
      verdict: ok ? 'ok' : 'table-mismatch-suspect',
      message: message,
      tableName: table.title,
      toleranceAfr: AFR_TOLERANCE
    };
  }

  /**
   * P66.renderPeVerifyHTML(result) -> compact dashboard HTML (string).
   * Plain language; safe to inject into a dashboard panel.
   */
  function renderPeVerifyHTML(result) {
    if (!result) return '';
    var h = '<div class="pev-panel">';
    h += '<div class="pev-title">PE: Commanded vs Table ' +
      '<span class="pev-sub">does the PCM command what the PE table says?</span></div>';
    if (!result.available) {
      h += '<div class="pev-note">' + esc(result.reason || 'Not available for this log.') + '</div>';
      return h + '</div>';
    }
    var ok = result.verdict === 'ok';
    h += '<div class="pev-verdict ' + (ok ? 'pev-ok' : 'pev-suspect') + '">' +
      esc(ok ? '✓ Log and PE table agree' : '⚠ Commanded AFR does not match the PE table') + '</div>';
    h += '<div class="pev-msg">' + esc(result.message) + '</div>';
    h += '<table class="pev-table"><tr>' +
      '<th>Pull</th><th>RPM</th><th>TPS%</th><th>Commanded AFR</th>' +
      '<th>Table AFR</th><th>Δ</th><th></th></tr>';
    result.episodes.forEach(function (e, idx) {
      h += '<tr>' +
        '<td>' + (idx + 1) + '</td>' +
        '<td>' + (e.rpm !== null ? e.rpm : '—') + '</td>' +
        '<td>' + (e.tps !== null ? e.tps : '—') + '</td>' +
        '<td>' + e.commandedAfr.toFixed(1) + '</td>' +
        '<td>' + e.tableAfr.toFixed(1) + '</td>' +
        '<td>' + (e.delta >= 0 ? '+' : '') + e.delta.toFixed(1) + '</td>' +
        '<td>' + (e.match ? '✓' : '✗') + '</td></tr>';
    });
    h += '</table>';
    h += '<div class="pev-foot">Table: ' + esc(result.tableName) +
      ' · commanded channel only (narrowband PCM channel, no wideband) · match within ' +
      esc(result.toleranceAfr) + ' AFR</div>';
    return h + '</div>';
  }

  // Export the thresholds so tests/docs can reference them.
  P66.PE_VERIFY_CONSTANTS = {
    tpsMin: PE_TPS_MIN,
    episodeMinSamples: PE_EPISODE_MIN,
    peLambdaMax: PE_LAMBDA_MAX,
    afrTolerance: AFR_TOLERANCE,
    stoich: STOICH
  };
  P66.verifyPeCommanded = verifyPeCommanded;
  P66.renderPeVerifyHTML = renderPeVerifyHTML;
})(typeof window !== 'undefined' ? window : global);
