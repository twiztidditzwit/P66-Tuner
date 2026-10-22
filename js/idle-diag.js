/* P66-Tuner IAC / idle stability diagnostics.
 *
 * Narrowband only: this module needs nothing but RPM, IAC position, and the
 * idle/warm gating the analyzer already computes. No O2 or wideband channel
 * is used, so it works on the stock narrowband datastream.
 *
 * API:
 *   P66.analyzeIdle(reportOrTable, mapResult) -> {
 *     available: Boolean,
 *     reason: String (only when available === false),
 *     hotIdle: { avgIac, avgRpm, rpmStddev, samples },
 *     targetRpm: Number,          // idle target used for the verdict
 *     warmNote: String,           // how "hot" was decided
 *     verdict: 'ok' | 'vacuum-leak-suspect' | 'throttle-misadjusted-suspect'
 *            | 'unstable-idle',
 *     message: String             // plain-language explanation, no jargon
 *   }
 *   P66.renderIdleDiagHTML(result) -> compact dashboard HTML string
 *     (node-safe, inline styles, escaped text).
 *
 * reportOrTable may be:
 *   - an array of log row objects (or { rows, headers }),
 *   - a P66.extractFeatures() bundle (has isIdle/isWarm/table/rowCount),
 *   - an object wrapping one at .features.
 * A full analyzeSession() report carries neither rows nor features, so it is
 * not accepted on its own (returns available:false).
 *
 * Thresholds (all exposed as P66.IDLE_DIAG_THRESHOLDS):
 *
 * - Hot idle rows: reuse the analyzer's own conventions via
 *   P66.extractFeatures(): isIdle = RPM < 1450, TPS < 2%, VSS < 3 MPH
 *   (the stock-calibration "Idle VE Possible" scalars; each condition falls
 *   back to "pass" when its channel is missing), and isWarm = ECT at/above
 *   the analyzer's warm threshold.
 * - Warm threshold: the analyzer's ectWarmThreshold() — 160 F when the ECT
 *   column reads like Fahrenheit (session max > 140), otherwise "within 10
 *   degrees of the session max". With no ECT channel every row counts as
 *   warm, exactly like the analyzer's warmup gating; the result's warmNote
 *   says so.
 * - IAC range: the P66 ADX logs "IAC Position" as a single byte, equation X,
 *   units "Steps" (defs/adx/p66-v6.catalog.json, packet offset 0x1C,
 *   sizeinbits null => 8 bits), so the range is 0..255 steps and a higher
 *   count means the valve is further open. Healthy hot idle on this engine
 *   family sits around 10-40 steps with the throttle stop set correctly
 *   (field calibration from the TunerPro/gearhead-efi community; the ADX
 *   also carries the PCM's learned "IAC Minimum" for reference). A
 *   sustained hot-idle average above 70 steps means the computer is holding
 *   the valve far more open than the blade setting alone would require.
 * - Idle target: the ADX datastream carries the computer's own "Desired
 *   Idle Speed" (X * 12.5 RPM, offset 0x0B) — used when the log includes
 *   it. Fallback is 700 RPM, the middle of the stock '95 3.4L target band
 *   (~650-750 RPM). "On target" = within +/-75 RPM of the target;
 *   "low" = more than 75 RPM under it.
 * - Unstable: hot-idle RPM standard deviation above 60 RPM — the needle is
 *   visibly hunting rather than sitting still.
 * - A minimum of 20 hot-idle samples is required for a verdict; fewer just
 *   means the log didn't capture much hot idle, and the message says so.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var IAC_HIGH_STEPS = 70;        // hot-idle avg IAC above this = "high"
  var TARGET_RPM_FALLBACK = 700;  // used when Desired Idle Speed isn't logged
  var RPM_ON_TARGET_BAND = 75;    // |avg - target| <= this => "on target"
  var RPM_UNSTABLE_STDDEV = 60;   // hot-idle RPM stddev above this => unstable
  var MIN_HOT_IDLE_SAMPLES = 20;

  P66.IDLE_DIAG_THRESHOLDS = {
    IAC_HIGH_STEPS: IAC_HIGH_STEPS,
    TARGET_RPM_FALLBACK: TARGET_RPM_FALLBACK,
    RPM_ON_TARGET_BAND: RPM_ON_TARGET_BAND,
    RPM_UNSTABLE_STDDEV: RPM_UNSTABLE_STDDEV,
    MIN_HOT_IDLE_SAMPLES: MIN_HOT_IDLE_SAMPLES
  };

  function round1(v) { return Math.round(v * 10) / 10; }

  // Local header normalizer (same rules as the channel mapper) for finding
  // the optional "Desired Idle Speed" column.
  function normHeader(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/[()\[\]%]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findDesiredIdleColumn(t) {
    if (!t) return null;
    // Log tables expose the header list as t.headers; be lenient about
    // other shapes (column objects carrying .name).
    var names = Array.isArray(t.headers) ? t.headers : null;
    if (!names && Array.isArray(t.columns)) {
      names = t.columns.map(function (c) { return c && c.name; });
    }
    if (!names) return null;
    for (var i = 0; i < names.length; i++) {
      var n = normHeader(names[i]);
      if (n === 'desired idle speed' || n === 'desired idle' ||
          n === 'target idle' || n === 'idle target' ||
          n === 'target idle speed' || n === 'desired idle rpm') {
        return names[i];
      }
    }
    return null;
  }

  // Accept a features bundle, { features }, or raw rows; anything else is
  // "no log data".
  function resolveFeatures(input, mapResult) {
    if (!input) return null;
    if (input.isIdle && input.isWarm && input.table &&
        typeof input.rowCount === 'number') {
      return input;
    }
    if (input.features && input.features.isIdle) {
      return resolveFeatures(input.features, mapResult);
    }
    if (typeof P66.asTable !== 'function' ||
        typeof P66.extractFeatures !== 'function') {
      return null;
    }
    var t = P66.asTable(input);
    if (!t || !t.rowCount) return null;
    return P66.extractFeatures(t, mapResult);
  }

  function colValues(t, name) {
    if (!t || typeof t.col !== 'function' || !name) return null;
    try { return t.col(name); } catch (e) { return null; }
  }

  /**
   * P66.analyzeIdle(reportOrTable, mapResult) — see header for the contract.
   */
  function analyzeIdle(reportOrTable, mapResult) {
    var map = mapResult || {};
    var iacName = (typeof P66.columnFor === 'function')
      ? P66.columnFor(map, 'IAC') : null;
    var rpmName = (typeof P66.columnFor === 'function')
      ? P66.columnFor(map, 'RPM') : null;
    if (!iacName) {
      return { available: false,
        reason: 'Need an idle air control channel (logged as e.g. "IAC Position" or "IAC Steps").' };
    }
    if (!rpmName) {
      return { available: false, reason: 'Need an RPM channel.' };
    }

    var feats = resolveFeatures(reportOrTable, map);
    if (!feats || !feats.rowCount) {
      return { available: false,
        reason: 'No log data supplied (pass log rows or a precomputed feature set).' };
    }
    var t = feats.table;
    var iacC = colValues(t, iacName);
    var rpmC = colValues(t, rpmName);
    if (!iacC || !rpmC) {
      return { available: false,
        reason: 'Idle air control or RPM column not found in the log data.' };
    }
    var desName = findDesiredIdleColumn(t);
    var desC = desName ? colValues(t, desName) : null;

    // Hot idle = the analyzer's idle entry convention AND fully warm.
    var n = feats.rowCount, i;
    var sumIac = 0, sumRpm = 0, sumRpmSq = 0, sumDes = 0, nDes = 0, samples = 0;
    for (i = 0; i < n; i++) {
      if (!feats.isIdle[i] || !feats.isWarm[i]) continue;
      var iv = iacC[i], rv = rpmC[i];
      if (iv !== iv || rv !== rv) continue;
      sumIac += iv;
      sumRpm += rv;
      sumRpmSq += rv * rv;
      samples++;
      if (desC) {
        var dv = desC[i];
        if (dv === dv && dv > 0) { sumDes += dv; nDes++; }
      }
    }

    var warmNote = (feats.warmThreshold && feats.warmThreshold.label)
      ? 'Hot idle = engine at/above ' + feats.warmThreshold.label
      : 'No ECT channel — every idle sample treated as hot (same as the analyzer\'s warmup gating)';

    function baseResult(extra) {
      var r = {
        available: true,
        hotIdle: { avgIac: 0, avgRpm: 0, rpmStddev: 0, samples: samples },
        targetRpm: nDes ? Math.round(sumDes / nDes) : TARGET_RPM_FALLBACK,
        warmNote: warmNote,
        verdict: 'ok',
        message: ''
      };
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k]; }
      return r;
    }

    if (samples < MIN_HOT_IDLE_SAMPLES) {
      return baseResult({
        verdict: 'ok',
        message: 'Not enough hot-idle data to judge (' + samples +
          ' sample' + (samples === 1 ? '' : 's') + '; need at least ' +
          MIN_HOT_IDLE_SAMPLES + '). This just means the log barely captured ' +
          'any hot idle — nothing looked wrong in what was there.'
      });
    }

    var avgIac = sumIac / samples;
    var avgRpm = sumRpm / samples;
    var variance = Math.max(0, sumRpmSq / samples - avgRpm * avgRpm);
    var rpmStddev = Math.sqrt(variance);
    var targetRpm = nDes ? Math.round(sumDes / nDes) : TARGET_RPM_FALLBACK;

    var result = baseResult({
      hotIdle: {
        avgIac: round1(avgIac),
        avgRpm: Math.round(avgRpm),
        rpmStddev: round1(rpmStddev),
        samples: samples
      },
      targetRpm: targetRpm
    });

    // Verdict priority: a hunting idle makes the averages unreliable, so
    // instability is judged first.
    if (rpmStddev > RPM_UNSTABLE_STDDEV) {
      result.verdict = 'unstable-idle';
      result.message =
        'Idle RPM is hunting — it swung about ±' + Math.round(rpmStddev) +
        ' RPM around an average of ' + Math.round(avgRpm) + ' RPM at hot idle, ' +
        'which is too much wander for a healthy idle. Usual suspects, in ' +
        'order: a vacuum leak, a sticky or carbon-fouled idle air valve, ' +
        'worn spark plugs or plug wires, or a lazy O2 sensor confusing the ' +
        'fueling. Check for vacuum leaks first, then clean the throttle body ' +
        'and idle air passages.';
      return result;
    }

    if (avgIac > IAC_HIGH_STEPS) {
      if (avgRpm < targetRpm - RPM_ON_TARGET_BAND) {
        result.verdict = 'throttle-misadjusted-suspect';
        result.message =
          'The throttle blade may be closed too far. The idle air valve is ' +
          'cranked wide open (about ' + Math.round(avgIac) + ' steps at hot ' +
          'idle, where under 40 is normal) but idle still sits at ' +
          Math.round(avgRpm) + ' RPM — below the ' + targetRpm + ' RPM ' +
          'target. The computer is asking for air it cannot get past the ' +
          'throttle blade, so the throttle stop screw may need a small ' +
          'adjustment — or the blade and throttle body are carbon-fouled.';
      } else {
        result.verdict = 'vacuum-leak-suspect';
        result.message =
          'Possible vacuum leak. The idle air valve is open far more than ' +
          'it should be at hot idle (about ' + Math.round(avgIac) +
          ' steps, where under 40 is normal), yet RPM is sitting ' +
          (avgRpm > targetRpm + RPM_ON_TARGET_BAND ? 'above' : 'at') +
          ' the ' + targetRpm + ' RPM target — the computer is holding the ' +
          'valve open to make up for air sneaking in somewhere it should ' +
          "not. Check the vacuum hoses, the PCV line, the brake booster " +
          'hose, and the intake and throttle body gaskets.';
      }
      return result;
    }

    result.verdict = 'ok';
    result.message =
      'Idle looks healthy. At hot idle the idle air valve averaged about ' +
      Math.round(avgIac) + ' steps and RPM sat steady at ' +
      Math.round(avgRpm) + ' RPM (target ' + targetRpm + ' RPM) — the ' +
      'computer is not working hard to hold idle speed.';
    return result;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var VERDICT_STYLE = {
    'ok': { label: 'Idle looks good', badge: 'background:#123a24;color:#7ee2a8;border:1px solid #2c6b44;' },
    'vacuum-leak-suspect': { label: 'Possible vacuum leak', badge: 'background:#3d2a10;color:#f5b95f;border:1px solid #8a5f22;' },
    'throttle-misadjusted-suspect': { label: 'Throttle may be misadjusted', badge: 'background:#3d2a10;color:#f5b95f;border:1px solid #8a5f22;' },
    'unstable-idle': { label: 'Unstable idle', badge: 'background:#3d2a10;color:#f5b95f;border:1px solid #8a5f22;' }
  };

  /**
   * P66.renderIdleDiagHTML(result) -> compact dashboard HTML string
   * (node-safe). Badge + plain-language message + the hot-idle numbers.
   */
  function renderIdleDiagHTML(result) {
    result = result || {};
    var v = VERDICT_STYLE[result.verdict] || VERDICT_STYLE['ok'];
    var html = '<div class="p66-idle-diag" style="font-size:13px;line-height:1.45;">';
    html += '<div style="font-weight:700;margin-bottom:4px;">Idle air control check</div>';
    if (result.available === false) {
      html += '<div style="opacity:0.8;margin-bottom:8px;">' +
        escHtml(result.reason || 'Idle check needs an IAC channel in the log.') + '</div>';
      html += '</div>';
      return html;
    }
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">';
    html += '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;' +
      v.badge + '">' + escHtml(v.label) + '</span>';
    html += '</div>';
    html += '<div style="margin-bottom:6px;">' + escHtml(result.message || '') + '</div>';
    var h = result.hotIdle || {};
    html += '<div style="font-size:12px;opacity:0.85;">' +
      'Hot idle: valve ~' + escHtml(h.avgIac == null ? '—' : h.avgIac) + ' steps &middot; ' +
      'RPM ' + escHtml(h.avgRpm == null ? '—' : h.avgRpm) +
      ' (&plusmn;' + escHtml(h.rpmStddev == null ? '—' : h.rpmStddev) + ') &middot; ' +
      'target ' + escHtml(result.targetRpm == null ? '—' : result.targetRpm) + ' RPM &middot; ' +
      escHtml(h.samples == null ? '—' : h.samples) + ' samples' +
      '</div>';
    if (result.warmNote) {
      html += '<div style="font-size:11px;opacity:0.6;margin-top:2px;">' +
        escHtml(result.warmNote) + '. Narrowband only — no O2 or wideband channel needed.</div>';
    }
    html += '</div>';
    return html;
  }

  P66.analyzeIdle = analyzeIdle;
  P66.renderIdleDiagHTML = renderIdleDiagHTML;
})(typeof window !== 'undefined' ? window : global);
