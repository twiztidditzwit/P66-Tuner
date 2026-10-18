/* P66-Tuner O2 sensor health panel
 * Narrowband O2 health from raw log data: switching rate, swing amplitude,
 * and rich/lean excursion averages per bank. Sensors are only judged on
 * warm samples (a cold narrowband reads lean no matter what).
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  /* ------------------------------------------------------------------
   * TUNE CONSTANTS — every threshold lives here, with its reasoning.
   * ------------------------------------------------------------------
   * O2_STOICH_MV   450  — narrowband switching point: a good sensor
   *    swings rich↔lean around stoich (~450mV). Matches the 450mV
   *    threshold already used in analyzer.js's cross-count health check.
   *
   * O2_HYST_HIGH_MV 500 / O2_HYST_LOW_MV 400 — hysteresis band.
   *    The sensor is latched "rich" only above 500mV and "lean" only
   *    below 400mV. The band sits symmetric around stoich, ~±50mV:
   *    wide enough to absorb narrowband ripple near the switch point
   *    so we count real swings instead of noise chatter, narrow enough
   *    that a genuine (even tired) swing still crosses both edges.
   *
   * WARM_ECT_F     160  — closed loop needs a hot sensor and a hot
   *    engine. P66 logs report ECT in °F (see analyzer.js); a sensor
   *    is only in closed loop above ~160°F coolant, so colder rows
   *    are excluded from the verdict entirely.
   *
   * MIN_USABLE_SAMPLES 30 — fewer than this many warm, numeric O2
   *    samples and the stats are noise; the bank is reported as
   *    unavailable with a reason instead of zeros.
   *
   * LAZY_SPM       15   — a healthy narrowband switches ~30-60x/min at
   *    cruise. Below 15 switches/min the sensor is too slow to keep
   *    the trims centered (contaminated, aging, or carbon-fouled).
   *
   * LAZY_AMP_MV    600  — a healthy sensor swings ~100→900mV
   *    (amplitude ~800mV). A swing under 600mV means the sensor has
   *    lost its range (lazy heater, lean bias, or exhaust leak)
   *    even if it still manages to cross stoich.
   *
   * FALLBACK_SAMPLE_S 0.145 — ALDL/TunerPro sample period used when
   *    the log has no TIME column, so switches/min still has a time
   *    base. Same 0.145s used in playback.js's synthetic-row tests.
   * ------------------------------------------------------------------ */
  var O2_STOICH_MV = 450;
  var O2_HYST_HIGH_MV = 500;
  var O2_HYST_LOW_MV = 400;
  var WARM_ECT_F = 160;
  var MIN_USABLE_SAMPLES = 30;
  var LAZY_SPM = 15;
  var LAZY_AMP_MV = 600;
  var FALLBACK_SAMPLE_S = 0.145;

  function round2(v) { return Math.round(v * 100) / 100; }

  function mean(a) {
    if (!a.length) return null;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  /**
   * Analyze one bank's O2 signal over warm rows.
   * t: log table (or legacy row array — normalized once at the boundary).
   * Returns { switchesPerMin, avgHighMv, avgLowMv, amplitudeMv,
   *           lazy, available, reason }.
   */
  function analyzeBank(rows, o2Name, timeName, ectName) {
    var noCol = {
      switchesPerMin: null, avgHighMv: null, avgLowMv: null, amplitudeMv: null,
      lazy: null, available: false, reason: 'No O2 sensor column mapped for this bank.'
    };
    if (!o2Name) return noCol;
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var o2C = P66.numView(t, o2Name);
    var timeC = P66.numView(t, timeName);
    var ectC = P66.numView(t, ectName);
    if (!o2C) return noCol;

    var highs = [], lows = [];
    var switches = 0, usable = 0;
    var stateAbove = null; // latched side of the hysteresis band
    var firstT = NaN, lastT = NaN, rowsUsed = 0, rowsSeen = n;

    for (var i = 0; i < n; i++) {
      if (ectC) {
        var ect = ectC[i];
        // A missing ECT is "unknown", not cold: keep the row (same convention
        // as analyzer.js's quality gating).
        if (ect === ect && ect <= WARM_ECT_F) continue;
      }
      var v = o2C[i];
      if (v !== v) continue;
      usable++;
      rowsUsed++;

      if (timeC) {
        var tt = timeC[i];
        if (tt === tt) {
          if (firstT !== firstT) firstT = tt;
          lastT = tt;
        }
      }
      if (v > O2_HYST_HIGH_MV) highs.push(v);
      else if (v < O2_HYST_LOW_MV) lows.push(v);

      if (v > O2_HYST_HIGH_MV) {
        if (stateAbove === false) switches++;
        stateAbove = true;
      } else if (v < O2_HYST_LOW_MV) {
        if (stateAbove === true) switches++;
        stateAbove = false;
      }
      // Between 400 and 500mV the latch holds: noise near stoich
      // never counts as a switch.
    }

    var ectNote = ectName
      ? (rowsSeen - rowsUsed) + ' cold row(s) excluded (ECT ≤ ' + WARM_ECT_F + '°F)'
      : 'no ECT channel — warmup gating unavailable, all samples used';

    if (usable < MIN_USABLE_SAMPLES) {
      return {
        switchesPerMin: null, avgHighMv: null, avgLowMv: null, amplitudeMv: null,
        lazy: null, available: false,
        reason: 'Only ' + usable + ' usable warm O2 sample(s) (' + MIN_USABLE_SAMPLES +
          ' needed). ' + ectNote + '.'
      };
    }

    var avgHigh = mean(highs);
    var avgLow = mean(lows);
    // If one side never appeared (e.g. a flat lean line), amplitude
    // collapses to 0 — worst case, which trips the lazy gate.
    var amplitude = (avgHigh !== null && avgLow !== null)
      ? (avgHigh - avgLow) : 0;

    var minutes = (firstT === firstT && lastT === lastT && lastT > firstT)
      ? (lastT - firstT) / 60
      : (usable * FALLBACK_SAMPLE_S) / 60;
    var spm = minutes > 0 ? switches / minutes : 0;

    var isLazy = spm < LAZY_SPM || amplitude < LAZY_AMP_MV;

    return {
      switchesPerMin: round2(spm),
      avgHighMv: avgHigh !== null ? Math.round(avgHigh) : null,
      avgLowMv: avgLow !== null ? Math.round(avgLow) : null,
      amplitudeMv: Math.round(amplitude),
      lazy: isLazy,
      available: true,
      reason: usable + ' warm sample(s) analyzed. ' + ectNote + '.'
    };
  }

  /**
   * P66.analyzeO2Health(rows, mapResult) -> { b1: {...}, b2: {...} }
   * rows: a log table or a legacy array of row objects.
   * Per-bank O2 health from the mapped O2_B1 / O2_B2 channels.
   * A single generic O2 signal (no bank split) is reported on Bank 1.
   */
  function analyzeO2Health(rows, mapResult) {
    var b1Name = P66.columnFor(mapResult, 'O2_B1') || P66.columnFor(mapResult, 'O2');
    var b2Name = P66.columnFor(mapResult, 'O2_B2');
    var timeName = P66.columnFor(mapResult, 'TIME');
    var ectName = P66.columnFor(mapResult, 'ECT');
    return {
      b1: analyzeBank(rows, b1Name, timeName, ectName),
      b2: analyzeBank(rows, b2Name, timeName, ectName)
    };
  }

  function verdictText(bankName, b) {
    if (!b.available) return 'No reading — ' + b.reason;
    if (b.lazy) {
      var why = [];
      if (b.switchesPerMin < LAZY_SPM)
        why.push('only ' + b.switchesPerMin + '/min switching (healthy is 30+)');
      if (b.amplitudeMv < LAZY_AMP_MV)
        why.push('weak swing of ' + b.amplitudeMv + 'mV (healthy is ~800mV)');
      return bankName + ' O2 looks lazy — ' + why.join('; ') + '.';
    }
    return bankName + ' O2 switching healthy.';
  }

  function statRow(label, value, cls) {
    return '<div class="o2h-row"><span class="o2h-label">' + label + '</span>' +
      '<span class="o2h-value' + (cls ? ' ' + cls : '') + '">' + value + '</span></div>';
  }

  function fmtMv(v) { return v === null ? '—' : v + ' mV'; }
  function fmtSpm(v) { return v === null ? '—' : v + ' /min'; }

  function bankCard(bankName, b) {
    var cls = 'o2h-card' +
      (b.available ? (b.lazy ? ' o2h-lazy' : ' o2h-ok') : ' o2h-na');
    var body;
    if (!b.available) {
      body = '<div class="o2h-reason">' + b.reason + '</div>';
    } else {
      body =
        statRow('Switches', fmtSpm(b.switchesPerMin)) +
        statRow('Amplitude', fmtMv(b.amplitudeMv)) +
        statRow('High avg (rich)', fmtMv(b.avgHighMv), 'o2h-rich') +
        statRow('Low avg (lean)', fmtMv(b.avgLowMv), 'o2h-lean') +
        '<div class="o2h-verdict">' + verdictText(bankName, b) + '</div>';
    }
    return '<div class="' + cls + '"><div class="o2h-bank">' + bankName +
      '</div>' + body + '</div>';
  }

  /**
   * P66.renderO2Health(container, result) — per-bank health cards.
   * container: DOM element (e.g. document.getElementById('o2health')).
   */
  function renderO2Health(container, result) {
    if (typeof document === 'undefined') return;
    if (!container || !result) return;
    container.innerHTML =
      '<div class="o2h-panel">' +
      '<div class="o2h-title">O2 Sensor Health <span class="o2h-sub">narrowband, warm samples only</span></div>' +
      '<div class="o2h-cards">' +
      bankCard('Bank 1', result.b1) +
      bankCard('Bank 2', result.b2) +
      '</div></div>';
  }

  // Export the tune constants so tests/docs can reference them.
  P66.O2_HEALTH_CONSTANTS = {
    stoichMv: O2_STOICH_MV,
    hystHighMv: O2_HYST_HIGH_MV,
    hystLowMv: O2_HYST_LOW_MV,
    warmEctF: WARM_ECT_F,
    minUsableSamples: MIN_USABLE_SAMPLES,
    lazySwitchesPerMin: LAZY_SPM,
    lazyAmplitudeMv: LAZY_AMP_MV,
    fallbackSampleS: FALLBACK_SAMPLE_S
  };
  P66.analyzeO2Health = analyzeO2Health;
  P66.renderO2Health = renderO2Health;
})(typeof window !== 'undefined' ? window : global);
