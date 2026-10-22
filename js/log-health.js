/* P66-Tuner log health check — pre-analysis gate
 * Scores a log 0-100 for data quality before analysis runs:
 *   - sensor dropouts (runs of NaN/missing in mapped channels)
 *   - flatlined channels that should move (RPM, MAP, TPS, narrowband O2s)
 *   - ALDL gaps (jumps in the timestamp or sample-counter channel)
 *   - sample-rate sanity vs the 8192-baud ALDL frame expectation
 * Narrowband O2 only — nothing wideband. All issue messages are in plain
 * words; the user does not follow code.
 *
 * Plain script — attaches to the global P66 namespace (browser + node
 * compatible). Load order: js/log-parser.js, js/channel-mapper.js, then this.
 *
 * P66.logHealth(logTable, mapResult) ->
 *   { score: 0-100,
 *     issues: [ { severity: 'info'|'warn'|'block',
 *                 code: 'dropout'|'flatline'|'aldl-gap'|'sample-rate'|
 *                       'missing-channel'|'too-short'|'empty-log',
 *                 channel: <mapped column name or null>,
 *                 message: <plain words> } ],
 *     block: boolean }          // true when the log is garbage
 *
 * P66.logHealthGate(health) ->
 *   { ok: boolean,              // false when blocked
 *     overrideRequired: boolean,// true when the user must explicitly choose "Analyze anyway"
 *     message: <plain words> }
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // ---- tuning constants -------------------------------------------------
  var EXPECTED_SAMPLE_S = 0.145; // 8192-baud ALDL full-frame period (same
                                 // figure o2health.js and playback.js use)
  var MIN_ROWS = 30;             // o2health's 30-sample usability floor
  var DROPOUT_WARN_FRAC = 0.05;  // >=5% missing on a key channel -> warn
  var DROPOUT_BLOCK_FRAC = 0.50; // >=50% missing on RPM/MAP/TPS -> block
  var GAP_FACTOR = 3;            // time jump > 3x the median interval = dropped frames
  var GAP_MIN_S = 0.5;           // ignore sub-half-second interval wobble
  var W_BLOCK = 40, W_WARN = 12, W_INFO = 3;

  // Key signals scanned for dropouts, roughly in importance order.
  // Narrowband only — WB_LAMBDA is deliberately excluded.
  var KEY_SIGNALS = ['RPM', 'MAP', 'TPS', 'O2_B1', 'O2_B2', 'ECT', 'SPARK_ADV',
                     'VSS', 'STFT_B1', 'STFT_B2', 'LTFT_B1', 'LTFT_B2',
                     'CMD_LAMBDA', 'IAC', 'INJ_DC'];
  // Dropout on one of these at >=50% means the log is garbage.
  var BLOCK_DROPOUT_SIGNALS = { RPM: true, MAP: true, TPS: true };

  // Signals that should move while the engine runs: if (max-min) stays under
  // `range` over the whole log, the channel is flatlined.
  var SHOULD_MOVE = {
    RPM:   { range: 5,  unit: 'rpm', severity: 'block' },
    MAP:   { range: 2,  unit: 'kPa', severity: 'warn'  },
    TPS:   { range: 1,  unit: '%',   severity: 'info'  },
    O2_B1: { range: 30, unit: 'mV',  severity: 'info'  },
    O2_B2: { range: 30, unit: 'mV',  severity: 'info'  },
    O2:    { range: 30, unit: 'mV',  severity: 'info'  }
  };

  var SIGNAL_NAMES = {
    RPM: 'RPM', MAP: 'MAP', TPS: 'throttle position',
    O2_B1: 'O2 sensor bank 1', O2_B2: 'O2 sensor bank 2', O2: 'O2 sensor',
    ECT: 'coolant temp', SPARK_ADV: 'spark advance', VSS: 'vehicle speed',
    STFT_B1: 'short-term fuel trim bank 1', STFT_B2: 'short-term fuel trim bank 2',
    LTFT_B1: 'long-term fuel trim bank 1', LTFT_B2: 'long-term fuel trim bank 2',
    CMD_LAMBDA: 'commanded AFR', IAC: 'idle air control',
    INJ_DC: 'injector duty cycle'
  };

  function fmt(v) {
    return String(Math.round(v * 10) / 10);
  }

  function friendly(signal) {
    return SIGNAL_NAMES[signal] || signal;
  }

  // Single pass over a Float32Array column: usable count, min/max, NaN
  // total, longest NaN run, and how many NaN runs are >= 3 samples.
  function scanChannel(arr, n) {
    var usable = 0, min = Infinity, max = -Infinity;
    var nanTotal = 0, run = 0, longest = 0, runs = 0;
    for (var i = 0; i < n; i++) {
      var v = arr[i];
      if (v !== v) { nanTotal++; run++; continue; } // NaN = missing
      if (run >= 3) runs++;
      if (run > longest) longest = run;
      run = 0;
      usable++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (run >= 3) runs++;
    if (run > longest) longest = run;
    return { usable: usable, min: min, max: max,
             nanTotal: nanTotal, longest: longest, runs: runs };
  }

  function pushIssue(issues, severity, code, channel, message) {
    issues.push({ severity: severity, code: code, channel: channel, message: message });
  }

  // ---- dropouts ---------------------------------------------------------
  function checkDropouts(table, map, n, issues) {
    KEY_SIGNALS.forEach(function (signal) {
      var col = P66.columnFor(map, signal);
      if (!col) return;
      var arr = P66.numView(table, col);
      if (!arr) return;
      var s = scanChannel(arr, n);
      var name = friendly(signal);
      if (s.usable === 0) {
        pushIssue(issues, BLOCK_DROPOUT_SIGNALS[signal] ? 'block' : 'warn',
          'dropout', col,
          name + ' has no usable samples at all — the channel recorded nothing.');
        return;
      }
      var frac = s.nanTotal / n;
      var pct = Math.round(frac * 100);
      if (frac >= DROPOUT_BLOCK_FRAC && BLOCK_DROPOUT_SIGNALS[signal]) {
        pushIssue(issues, 'block', 'dropout', col,
          name + ' is missing for ' + pct + '% of this log — too much dropout to tune from.');
      } else if (frac >= DROPOUT_BLOCK_FRAC) {
        pushIssue(issues, 'warn', 'dropout', col,
          name + ' is missing for ' + pct + '% of this log — results for it will be thin.');
      } else if (frac >= DROPOUT_WARN_FRAC) {
        pushIssue(issues, 'warn', 'dropout', col,
          name + ' drops out for ' + pct + '% of the samples' +
          (s.longest >= 3 ? ' (longest gap: ' + s.longest + ' samples in a row)' : '') + '.');
      } else if (frac >= 0.01 || s.longest >= 10) {
        pushIssue(issues, 'info', 'dropout', col,
          name + ' has brief dropouts (' + pct + '% of samples' +
          (s.longest >= 3 ? ', longest ' + s.longest + ' in a row' : '') + ').');
      }
    });
  }

  // ---- flatlines --------------------------------------------------------
  function checkFlatlines(table, map, n, issues) {
    Object.keys(SHOULD_MOVE).forEach(function (signal) {
      var col = P66.columnFor(map, signal);
      if (!col) return;
      var arr = P66.numView(table, col);
      if (!arr) return;
      var spec = SHOULD_MOVE[signal];
      var s = scanChannel(arr, n);
      if (s.usable < MIN_ROWS) return; // dropout check already flagged thin data
      if ((s.max - s.min) > spec.range) return;
      var name = friendly(signal);
      var stuck = 'stuck at ' + fmt(s.max) + ' ' + spec.unit;
      var message;
      if (signal === 'RPM') {
        message = s.max === 0
          ? 'RPM reads 0 for the whole log — the engine was never running (or the RPM channel is dead).'
          : 'RPM is ' + stuck + ' for the whole log — the channel is not live.';
      } else if (signal === 'MAP') {
        message = 'MAP never moves (' + stuck + ') — if the engine was running, this channel is not recording.';
      } else if (signal === 'TPS') {
        message = 'Throttle never moved (' + stuck + ') — this looks like an idle-only or key-on log.';
      } else {
        message = name + ' never switches (flat at ' + fmt(s.max) + ' mV) — ' +
          'the engine may never have warmed up, or the sensor is lazy or dead.';
      }
      pushIssue(issues, spec.severity, 'flatline', col, message);
    });
  }

  // ---- ALDL gaps --------------------------------------------------------
  // Returns { sawTime: boolean } so the caller knows whether the
  // sample-rate check could run.
  function checkAldlGaps(table, map, n, issues) {
    var tcol = P66.columnFor(map, 'TIME');
    var tarr = tcol ? P66.numView(table, tcol) : null;
    if (tarr) {
      var ts = [];
      for (var i = 0; i < n; i++) {
        var v = tarr[i];
        if (v === v) ts.push({ t: v, i: i });
      }
      if (ts.length >= 2) {
        var diffs = [];
        var backward = 0;
        for (var k = 1; k < ts.length; k++) {
          var d = ts[k].t - ts[k - 1].t;
          if (d <= 0) { backward++; continue; }
          diffs.push(d);
        }
        if (backward > 0) {
          pushIssue(issues, 'warn', 'aldl-gap', tcol,
            'Timestamps jump backwards ' + backward + ' time(s) — the log clock is unreliable.');
        }
        if (diffs.length) {
          var sorted = diffs.slice().sort(function (a, b) { return a - b; });
          var median = sorted[Math.floor(sorted.length / 2)];
          var gaps = [];
          for (var g = 1; g < ts.length; g++) {
            var gd = ts[g].t - ts[g - 1].t;
            if (gd > GAP_FACTOR * median && gd > GAP_MIN_S) {
              gaps.push({ gap: gd, at: ts[g].t });
            }
          }
          if (gaps.length) {
            var biggest = gaps.reduce(function (a, b) { return b.gap > a.gap ? b : a; });
            var sev = (gaps.length >= 3 || biggest.gap >= 2.0) ? 'warn' : 'info';
            pushIssue(issues, sev, 'aldl-gap', tcol,
              'Found ' + gaps.length + ' dropped ALDL frame(s) — biggest gap ' +
              fmt(biggest.gap) + 's, about ' + Math.round(biggest.at) + 's into the log.');
          }
        }
        return { sawTime: true, times: ts };
      }
      pushIssue(issues, 'info', 'aldl-gap', tcol,
        'Timestamp channel has no usable values — could not check for dropped ALDL frames.');
      return { sawTime: false, times: [] };
    }
    // No TIME channel: try a sample/frame sequence counter instead.
    var seq = findSequenceColumn(table);
    if (seq) {
      checkSequenceGaps(seq, issues);
      return { sawTime: false, times: [] };
    }
    pushIssue(issues, 'info', 'aldl-gap', null,
      'No timestamp or sample-counter channel found — could not check for dropped ALDL frames.');
    return { sawTime: false, times: [] };
  }

  function findSequenceColumn(table) {
    var headers = table.headers || [];
    for (var h = 0; h < headers.length; h++) {
      var name = headers[h];
      if (/(^|[\s_#.\-])(sample|frame|seq|sequence|record|counter|number)([\s_#.\-]|$)/i.test(name)) {
        var arr = P66.numView(table, name);
        if (arr) return { name: name, arr: arr };
      }
    }
    return null;
  }

  function checkSequenceGaps(seq, issues) {
    var vals = [];
    for (var i = 0; i < seq.arr.length; i++) {
      var v = seq.arr[i];
      if (v === v) vals.push(v);
    }
    if (vals.length < 2) {
      pushIssue(issues, 'info', 'aldl-gap', seq.name,
        'Sample-counter channel has no usable values — could not check for dropped frames.');
      return;
    }
    var steps = [];
    var backward = 0;
    for (var k = 1; k < vals.length; k++) {
      var st = vals[k] - vals[k - 1];
      if (st <= 0) { backward++; continue; }
      steps.push(st);
    }
    if (backward > 0) {
      pushIssue(issues, 'warn', 'aldl-gap', seq.name,
        'Sample counter jumps backwards ' + backward + ' time(s) — frames may be out of order.');
    }
    if (!steps.length) return;
    var sorted = steps.slice().sort(function (a, b) { return a - b; });
    var medianStep = sorted[Math.floor(sorted.length / 2)] || 1;
    var jumps = steps.filter(function (s) { return s >= 2 && s > 1.5 * medianStep; });
    if (jumps.length) {
      var biggest = Math.max.apply(null, jumps);
      pushIssue(issues, 'warn', 'aldl-gap', seq.name,
        'Found ' + jumps.length + ' dropped frame(s) via the sample counter — ' +
        'biggest jump skips ' + Math.round(biggest - medianStep) + ' frame(s).');
    }
  }

  // ---- sample-rate sanity ------------------------------------------------
  function checkSampleRate(ts, tcol, issues) {
    if (!ts || ts.length < 2) {
      pushIssue(issues, 'info', 'sample-rate', null,
        'No timestamp channel — could not verify the sample rate ' +
        '(expect about 7 frames per second on 8192-baud ALDL).');
      return;
    }
    var span = ts[ts.length - 1].t - ts[0].t;
    if (!(span > 0)) {
      pushIssue(issues, 'warn', 'sample-rate', tcol,
        'Timestamps never advance — cannot tell how fast this log was recorded.');
      return;
    }
    var avg = span / (ts.length - 1);
    if (avg > 0.5) {
      pushIssue(issues, 'warn', 'sample-rate', tcol,
        'Samples arrive every ~' + fmt(avg) + 's on average — an 8192-baud ALDL frame ' +
        'should take about 0.15s. The bus may be overloaded or the logger was polling slowly.');
    } else if (avg < 0.05) {
      pushIssue(issues, 'warn', 'sample-rate', tcol,
        'Samples arrive every ~' + fmt(avg) + 's on average — faster than 8192-baud ALDL ' +
        'can deliver. This may not be a real P66/ALDL log.');
    }
  }

  // ---- main entry ---------------------------------------------------------
  /**
   * Score a log's data quality. Returns { score, issues, block }.
   */
  function logHealth(logTable, mapResult) {
    var issues = [];
    var table = (P66.asTable ? P66.asTable(logTable) : logTable);
    var map = (mapResult && mapResult.mapping) ? mapResult : { mapping: {} };

    if (!table || !table.columns || !table.columns.length) {
      pushIssue(issues, 'block', 'empty-log', null, 'This log has no data rows at all.');
      return { score: Math.max(0, 100 - W_BLOCK), issues: issues, block: true };
    }
    var n = table.rowCount || 0;
    if (n <= 0) {
      pushIssue(issues, 'block', 'empty-log', null, 'This log has no data rows at all.');
      return { score: Math.max(0, 100 - W_BLOCK), issues: issues, block: true };
    }
    if (n < MIN_ROWS) {
      pushIssue(issues, 'block', 'too-short', null,
        'Only ' + n + ' rows — about ' + Math.max(1, Math.round(n * EXPECTED_SAMPLE_S)) +
        's of logging. That is not enough to tune from.');
      return { score: Math.max(0, 100 - W_BLOCK), issues: issues, block: true };
    }

    var rpmCol = P66.columnFor(map, 'RPM');
    if (!rpmCol) {
      pushIssue(issues, 'block', 'missing-channel', null,
        'No RPM channel found — analysis needs engine speed to work with.');
    } else {
      var anyKey = ['MAP', 'TPS', 'O2_B1', 'O2_B2', 'O2', 'ECT'].some(function (sig) {
        return !!P66.columnFor(map, sig);
      });
      if (!anyKey) {
        pushIssue(issues, 'block', 'missing-channel', null,
          'None of the key channels (MAP, throttle, O2, coolant) are in this log — ' +
          'there is nothing to analyze.');
      }
    }

    checkDropouts(table, map, n, issues);
    checkFlatlines(table, map, n, issues);
    var gapInfo = checkAldlGaps(table, map, n, issues);
    checkSampleRate(gapInfo.times, P66.columnFor(map, 'TIME'), issues);

    var score = 100;
    var blocked = false;
    issues.forEach(function (iss) {
      if (iss.severity === 'block') { score -= W_BLOCK; blocked = true; }
      else if (iss.severity === 'warn') { score -= W_WARN; }
      else { score -= W_INFO; }
    });
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score: score, issues: issues, block: blocked };
  }

  /**
   * Gate decision for the analyze flow. Blocked logs need an explicit
   * "Analyze anyway" from the user; everything else passes through.
   */
  function logHealthGate(health) {
    health = health || {};
    var issues = health.issues || [];
    var score = (health.score === undefined || health.score === null) ? 100 : health.score;
    if (!health.block) {
      var message = issues.length === 0
        ? 'Log health check passed — 100/100. Good to analyze.'
        : 'Log health ' + score + '/100 with ' + issues.length + ' note(s). Analysis can continue.';
      return { ok: true, overrideRequired: false, message: message };
    }
    var blockers = issues
      .filter(function (x) { return x.severity === 'block'; })
      .map(function (x) { return x.message; })
      .slice(0, 3)
      .join(' ');
    return {
      ok: false,
      overrideRequired: true,
      message: 'This log looks unusable (' + score + '/100): ' + blockers +
        ' You can analyze anyway if you know what you are doing.'
    };
  }

  P66.logHealth = logHealth;
  P66.logHealthGate = logHealthGate;
  P66.LOG_HEALTH_CONSTANTS = {
    expectedSampleS: EXPECTED_SAMPLE_S,
    minRows: MIN_ROWS,
    dropoutWarnFrac: DROPOUT_WARN_FRAC,
    dropoutBlockFrac: DROPOUT_BLOCK_FRAC,
    gapFactor: GAP_FACTOR,
    weights: { block: W_BLOCK, warn: W_WARN, info: W_INFO }
  };
})(typeof window !== 'undefined' ? window : global);
