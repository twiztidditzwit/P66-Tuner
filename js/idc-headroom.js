/* P66-Tuner injector duty-cycle headroom warnings.
 *
 * The pre-turbo sanity check: flags log regions where the injectors are
 * running out of room — >=80% duty is a 'watch' (less than 20% headroom
 * left), >=90% is 'critical' (injectors near static, the stock fuel system
 * is the limit and boost is off the table until it's sorted).
 *
 *   P66.analyzeIdcHeadroom(reportOrTable, mapResult) -> {
 *     available, reason, source, sampleCount,
 *     peakDuty,                    // % (1 decimal)
 *     peakCell: { rpm, map },      // numbers (rounded), null when RPM/MAP unlogged
 *     overCells: [                 // RPM x MAP bins at/over the watch line
 *       { rpmRange, mapRange, duty, samples } ],
 *     verdict: 'ok'|'watch'|'critical' (null when available:false),
 *     message                    // plain-words pre-turbo framing
 *   }
 *
 *   P66.renderIdcHTML(result) -> compact dashboard HTML string.
 *
 *   P66.IDC_HEADROOM_CONSTANTS -> { watchDutyPct, criticalDutyPct,
 *     minCellSamples, rpmBinSize, mapBinKpa }
 *
 * Input choice (documented): the analyzer report from P66.analyzeSession
 * carries NO IDC stats, so this module reads the log table itself via
 * P66.columnFor / P66.numView. The first argument accepts:
 *   - a log table (P66.asTable output),
 *   - a plain array of row objects / a parsed log ({rows, headers}),
 *   - an analyzer report carrying a precomputed `idcHeadroom` result
 *     (used verbatim — the forward-compatible slot for a future
 *     analyzer-side IDC pass).
 * Passing a bare analyzer report without one returns available:false with
 * a reason explaining the table path.
 *
 * Duty source: the mapped INJ_DC channel first; when the log has injector
 * pulse width (INJ_PW) plus RPM instead, duty is estimated as
 * pw_ms * rpm / 1200 (one injection per 2 revs on a 4-stroke) and flagged
 * in `source`. INJ_DC values that all land <= 1.5 are read as a 0..1
 * fraction and scaled to percent.
 *
 * Narrowband only. Plain language throughout.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var WATCH_DUTY_PCT = 80;      // >= this: watch — headroom nearly gone
  var CRITICAL_DUTY_PCT = 90;   // >= this: critical — injectors near static
  var MIN_CELL_SAMPLES = 5;     // ignore thin bins (one bad sample spikes)
  var RPM_BIN_SIZE = 400;       // "4400-4800 RPM"
  var MAP_BIN_KPA = 10;         // "90-100 kPa"

  function colFor(mapResult, signal) {
    if (typeof P66.columnFor !== 'function' || !mapResult) return null;
    try { return P66.columnFor(mapResult, signal) || null; }
    catch (e) { return null; }
  }

  function numView(t, name) {
    if (typeof P66.numView !== 'function' || !t || !name) return null;
    try { return P66.numView(t, name); }
    catch (e) { return null; }
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  function unavailable(reason) {
    return {
      available: false,
      reason: reason,
      source: 'none',
      sampleCount: 0,
      peakDuty: null,
      peakCell: { rpm: null, map: null },
      overCells: [],
      verdict: null,
      message: 'No injector duty-cycle data to judge — ' + reason
    };
  }

  function looksLikeAnalyzerReport(o) {
    return o && typeof o === 'object' && !Array.isArray(o) &&
      (o.fuelTrims !== undefined ||
        (typeof o.rowCount === 'number' && o.missingChannels !== undefined));
  }

  // Normalize the first argument to { table } | { precomputed } | { error }.
  function pickTable(input) {
    if (!input) return { error: 'No input was provided.' };
    if (input.idcHeadroom && typeof input.idcHeadroom === 'object')
      return { precomputed: input.idcHeadroom };
    if (typeof P66.isLogTable === 'function' && P66.isLogTable(input))
      return { table: input };
    if (Array.isArray(input) || (input && Array.isArray(input.rows)))
      return { table: P66.asTable(input) };
    if (input.table) return pickTable(input.table);
    if (looksLikeAnalyzerReport(input))
      return { error: 'The analyzer report carries no IDC stats — call ' +
        'P66.analyzeIdcHeadroom with the log table (e.g. P66.asTable(parsed)) ' +
        'instead, or attach a precomputed report.idcHeadroom result.' };
    return { error: 'Unrecognized input — expected a log table, row array, or report.' };
  }

  function analyzeIdcHeadroom(reportOrTable, mapResult) {
    var norm = pickTable(reportOrTable);
    if (norm.precomputed) return norm.precomputed;
    if (norm.error) return unavailable(norm.error);
    var t = norm.table;
    if (!t || !t.rowCount) return unavailable('The log table has no rows.');

    var dcName = colFor(mapResult, 'INJ_DC');
    var pwName = colFor(mapResult, 'INJ_PW');
    var rpmName = colFor(mapResult, 'RPM');
    var mapName = colFor(mapResult, 'MAP');
    var dcC = numView(t, dcName);
    var pwC = numView(t, pwName);
    var rpmC = numView(t, rpmName);
    var mapC = numView(t, mapName);

    var estimated = !dcC && pwC && rpmC;
    if (!dcC && !estimated)
      return unavailable(
        'No injector duty-cycle channel logged (INJ_DC not mapped, and no ' +
        'INJ_PW + RPM pair to estimate from).');

    // First pass: collect valid duty samples (raw units), then detect a
    // 0..1 fraction encoding (max <= 1.5) and scale to percent.
    var duties = [], rpms = [], maps = [];
    var n = t.rowCount, i;
    for (i = 0; i < n; i++) {
      var d = estimated ? (pwC[i] * rpmC[i]) / 1200 : dcC[i];
      if (!(d >= 0) || !isFinite(d)) continue;
      duties.push(d);
      rpms.push(rpmC ? rpmC[i] : NaN);
      maps.push(mapC ? mapC[i] : NaN);
    }
    if (!duties.length)
      return unavailable('The injector channel(s) mapped but held no valid samples.');

    var maxRaw = 0;
    for (i = 0; i < duties.length; i++) if (duties[i] > maxRaw) maxRaw = duties[i];
    var fractionScale = maxRaw <= 1.5;
    if (fractionScale)
      for (i = 0; i < duties.length; i++) duties[i] *= 100;

    var peakDuty = 0, peakRpm = NaN, peakMap = NaN;
    var bins = {}; // "rpmLo|mapLo" -> { max, count }
    for (i = 0; i < duties.length; i++) {
      var dv = duties[i], r = rpms[i], m = maps[i];
      if (dv > peakDuty) { peakDuty = dv; peakRpm = r; peakMap = m; }
      if (r === r && m === m) { // valid RPM + MAP
        var rb = Math.floor(r / RPM_BIN_SIZE) * RPM_BIN_SIZE;
        var mb = Math.floor(m / MAP_BIN_KPA) * MAP_BIN_KPA;
        var k = rb + '|' + mb;
        var b = bins[k] || (bins[k] = { rpmLo: rb, mapLo: mb, max: 0, count: 0 });
        if (dv > b.max) b.max = dv;
        b.count++;
      }
    }

    var overCells = [];
    Object.keys(bins).forEach(function (k) {
      var b = bins[k];
      if (b.count >= MIN_CELL_SAMPLES && b.max >= WATCH_DUTY_PCT) {
        overCells.push({
          rpmRange: b.rpmLo + '\u2013' + (b.rpmLo + RPM_BIN_SIZE) + ' RPM',
          mapRange: b.mapLo + '\u2013' + (b.mapLo + MAP_BIN_KPA) + ' kPa',
          duty: round1(b.max),
          samples: b.count
        });
      }
    });
    overCells.sort(function (a, b2) { return b2.duty - a.duty; });

    var verdict = 'ok';
    overCells.forEach(function (c) { if (c.duty >= CRITICAL_DUTY_PCT) verdict = 'critical'; });
    if (verdict !== 'critical' && overCells.length) verdict = 'watch';

    var peakCell = {
      rpm: peakRpm === peakRpm ? Math.round(peakRpm) : null,
      map: peakMap === peakMap ? Math.round(peakMap) : null
    };
    var atLabel = (peakCell.rpm !== null)
      ? ' at ' + peakCell.rpm + ' RPM / ' + peakCell.map + ' kPa'
      : '';
    var peakTxt = round1(peakDuty) + '% duty' + atLabel;

    var message;
    if (verdict === 'critical') {
      message = 'Injectors peak at ' + peakTxt + ' \u2014 nearly static. ' +
        'The stock fuel system is the limit; sort bigger injectors / pump before any boost.';
    } else if (verdict === 'watch') {
      message = 'Injectors peak at ' + peakTxt + ' \u2014 less than 20% headroom left. ' +
        'The stock fuel system is the next bottleneck; budget fuel upgrades before boost.';
    } else {
      message = 'Injectors peak at ' + peakTxt + ' \u2014 plenty of headroom. ' +
        'The fuel system is not your limiter for turbo plans yet.';
    }

    return {
      available: true,
      reason: estimated
        ? 'No INJ_DC channel logged; duty estimated from injector pulse width \u00d7 RPM.'
        : 'Read from the logged INJ_DC channel' +
          (fractionScale ? ' (0..1 fraction scaled to percent)' : '') + '.',
      source: estimated ? 'estimated' : 'channel',
      sampleCount: duties.length,
      peakDuty: round1(peakDuty),
      peakCell: peakCell,
      overCells: overCells,
      verdict: verdict,
      message: message
    };
  }

  // ---------------------------------------------------------------- render

  var VERDICT_STYLE = {
    ok:       { label: 'OK',       bg: '#3aa655' },
    watch:    { label: 'WATCH',    bg: '#d9a13b' },
    critical: { label: 'CRITICAL', bg: '#d64545' },
    na:       { label: 'NO DATA',  bg: '#8b93a3' }
  };

  /**
   * P66.renderIdcHTML(result) — compact dashboard card, HTML string.
   * Duty-cycle semantics, not fuel-trim: green = headroom fine, amber =
   * watch, red = near static. Pure string, no DOM access (node-safe).
   */
  function renderIdcHTML(result) {
    if (!result || typeof result !== 'object')
      return '<p class="muted">No injector data.</p>';
    var key = result.available ? result.verdict : 'na';
    var st = VERDICT_STYLE[key] || VERDICT_STYLE.na;

    var html = '<div class="idc-panel" style="border:1px solid #d5dae3;' +
      'border-radius:8px;padding:10px 12px;background:#fff;max-width:560px;' +
      'font-family:inherit">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<div class="idc-title" style="font-weight:700">Injector Headroom</div>' +
      '<span class="idc-badge" style="background:' + st.bg + ';color:#fff;' +
      'font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap">' +
      escHtml(st.label) + '</span></div>';
    html += '<div class="idc-sub muted" style="font-size:12px;color:#6b7280;margin:2px 0 8px">' +
      'pre-turbo fuel-system sanity check \u00b7 narrowband log</div>';

    if (!result.available) {
      html += '<div class="idc-reason" style="font-size:13px;color:#6b7280">' +
        escHtml(result.reason || 'No data.') + '</div></div>';
      return html;
    }

    var pct = Math.max(0, Math.min(100, result.peakDuty));
    html += '<div class="idc-bar" title="Peak duty vs 80% watch / 90% critical lines" ' +
      'style="position:relative;height:10px;background:#eef1f6;border-radius:5px;margin:4px 0 10px">' +
      '<div class="idc-fill" style="position:absolute;left:0;top:0;bottom:0;width:' + pct +
      '%;background:' + st.bg + ';border-radius:5px"></div>' +
      '<span class="idc-mark" style="position:absolute;left:80%;top:-3px;bottom:-3px;width:2px;background:#9aa3b2" title="80% watch line"></span>' +
      '<span class="idc-mark" style="position:absolute;left:90%;top:-3px;bottom:-3px;width:2px;background:#5b6270" title="90% critical line"></span>' +
      '</div>';

    var atCell = (result.peakCell.rpm !== null)
      ? ' at ' + escHtml(result.peakCell.rpm + ' RPM / ' + result.peakCell.map + ' kPa')
      : '';
    html += '<div class="idc-peak" style="font-size:14px;margin-bottom:6px">Peak ' +
      '<b>' + escHtml(result.peakDuty + '%') + '</b> duty' + atCell + '</div>';
    html += '<div class="idc-message" style="font-size:13px;line-height:1.45;margin-bottom:8px">' +
      escHtml(result.message) + '</div>';

    if (result.overCells && result.overCells.length) {
      html += '<table class="idc-cells" style="border-collapse:collapse;font-size:12px;width:100%">' +
        '<thead><tr><th style="text-align:left;padding:2px 6px;color:#6b7280;font-weight:600">RPM</th>' +
        '<th style="text-align:left;padding:2px 6px;color:#6b7280;font-weight:600">MAP</th>' +
        '<th style="text-align:right;padding:2px 6px;color:#6b7280;font-weight:600">Duty</th>' +
        '<th style="text-align:right;padding:2px 6px;color:#6b7280;font-weight:600">Samples</th></tr></thead><tbody>';
      result.overCells.forEach(function (c) {
        var hot = c.duty >= CRITICAL_DUTY_PCT;
        html += '<tr>' +
          '<td style="padding:2px 6px">' + escHtml(c.rpmRange) + '</td>' +
          '<td style="padding:2px 6px">' + escHtml(c.mapRange) + '</td>' +
          '<td style="padding:2px 6px;text-align:right;font-weight:700;color:' +
          (hot ? '#d64545' : '#b07d1e') + '">' + escHtml(c.duty + '%') + '</td>' +
          '<td style="padding:2px 6px;text-align:right;color:#6b7280">' + escHtml(c.samples) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<div class="idc-none muted" style="font-size:12px;color:#6b7280">' +
        'No RPM \u00d7 MAP region over 80% duty in this log.</div>';
    }
    if (result.reason)
      html += '<div class="idc-src muted" style="font-size:11px;color:#9aa3b2;margin-top:8px">' +
        escHtml(result.reason) + '</div>';
    html += '</div>';
    return html;
  }

  P66.IDC_HEADROOM_CONSTANTS = {
    watchDutyPct: WATCH_DUTY_PCT,
    criticalDutyPct: CRITICAL_DUTY_PCT,
    minCellSamples: MIN_CELL_SAMPLES,
    rpmBinSize: RPM_BIN_SIZE,
    mapBinKpa: MAP_BIN_KPA
  };
  P66.analyzeIdcHeadroom = analyzeIdcHeadroom;
  P66.renderIdcHTML = renderIdcHTML;
})(typeof window !== 'undefined' ? window : global);
