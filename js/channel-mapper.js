/* P66-Tuner channel mapper
 * Maps raw log column headers to canonical tuning signals using
 * scored alias matching. One column maps to at most one signal.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Canonical signal -> alias list (lowercase, compared after normalization).
  // Order matters for greedy assignment: more specific signals first.
  var SIGNAL_ALIASES = {
    RPM: ['rpm', 'engine speed', 'engine_speed', 'erpm', 'revs', 'engine rpm'],
    MAP: ['map', 'manifold absolute pressure', 'manifold pressure', 'map kpa', 'map (kpa)', 'manifold_abs_press'],
    MAF: ['maf', 'mass air flow', 'mass airflow', 'maf g/s', 'maf (g/s)', 'airflow', 'maf lb/min'],
    TPS: ['tps', 'throttle position', 'throttle_position', 'tps %', 'tps (%)', 'throttle %', 'throttlepos'],
    STFT_B1: ['stft b1', 'stft bank 1', 'stft_1', 'short term fuel trim bank 1', 'stftb1',
              'left/front int', 'left front int', 'lf int'],
    STFT_B2: ['stft b2', 'stft bank 2', 'stft_2', 'short term fuel trim bank 2', 'stftb2',
              'right/rear int', 'right rear int', 'rr int'],
    STFT: ['stft', 'short term fuel trim', 'short_term_fuel_trim', 'st fuel trim'],
    LTFT_B1: ['ltft b1', 'ltft bank 1', 'ltft_1', 'long term fuel trim bank 1', 'ltftb1',
              'left/front blm', 'left front blm', 'lf blm'],
    LTFT_B2: ['ltft b2', 'ltft bank 2', 'ltft_2', 'long term fuel trim bank 2', 'ltftb2',
              'right/rear blm', 'right rear blm', 'rr blm'],
    LTFT: ['ltft', 'long term fuel trim', 'long_term_fuel_trim', 'lt fuel trim'],
    BLM_CELL: ['blm cell', 'blmcell', 'fuel trim cell', 'block learn cell'],
    KR: ['kr', 'knock retard', 'knock_retard', 'spark retard', 'knock retard (deg)', 'kr (deg)'],
    IAT: ['iat', 'mat', 'manifold air temp', 'intake air temp', 'intake_air_temp', 'iat f', 'iat (f)', 'air temp'],
    ECT: ['ect', 'coolant', 'coolant temp', 'engine coolant temp', 'coolant_temperature', 'ect f', 'ect (f)'],
    CMD_LAMBDA: ['commanded lambda', 'commanded_lambda', 'commanded afr', 'commanded_afr',
                 'eq ratio', 'equivalence ratio', 'desired afr', 'cmd lambda', 'target lambda',
                 'target afr', 'target air/fuel ratio', 'commanded eq', 'afr commanded'],
    WB_LAMBDA: ['wideband', 'wideband afr', 'wideband_lambda', 'wb afr', 'wbafr', 'wbo2',
                'wb lambda', 'afr wideband', 'lambda wideband', 'actual afr', 'measured afr', 'afr (wideband)'],
    SPARK_ADV: ['spark advance', 'spark_advance', 'ignition timing', 'timing advance',
                'spark (deg)', 'total timing', 'sparkadv'],
    INJ_PW: ['injector pulse width', 'inj pw', 'injector_pw', 'pulse width', 'ipw',
             'injpw ms', 'fuel pw'],
    VSS: ['vss', 'vehicle speed', 'vehicle_speed', 'mph', 'kph', 'speed'],
    BARO: ['baro', 'barometric', 'barometric pressure', 'baro kpa', 'barometer'],
    O2_B1: ['o2 b1', 'o2 bank 1', 'left/front o2', 'left front o2', 'front o2',
            'left/front o2 sensor', 'o2 sensor bank 1', 'lf o2'],
    O2_B2: ['o2 b2', 'o2 bank 2', 'right/rear o2', 'right rear o2', 'rear o2',
            'right/rear o2 sensor', 'o2 sensor bank 2', 'rr o2'],
    O2: ['o2', 'o2 sensor', 'oxygen sensor', 'o2 mv', 'o2 (mv)'],
    TIME: ['=time', 'timestamp', 'sample time', 'log time', 'seconds']
  };

  var CANONICAL_ORDER = Object.keys(SIGNAL_ALIASES);

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .replace(/[()\[\]%]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Score a normalized header against one alias. Higher is better.
  // Exact matches get a small specificity bonus so that a longer, more
  // specific alias (e.g. "left/front o2 sensor") beats a shorter one
  // (e.g. "left/front o2") when both match exactly.
  // An alias prefixed with '=' requires an exact match — used for short
  // generic words like "time" that would otherwise match inside longer
  // unrelated headers (e.g. "1-2 Shift Time Error").
  function aliasScore(normHeader, alias) {
    var exactOnly = alias.charAt(0) === '=';
    if (exactOnly) alias = alias.slice(1);
    function specificity() { return Math.min(9, Math.floor(alias.length / 8)); }
    if (normHeader === alias) return 100 + specificity();
    if (exactOnly) return 0;
    // Whole-word containment, e.g. header "stft bank 1 (%)" contains alias "stft b1"? no —
    // but "engine rpm (rpm)" contains "rpm" as a word.
    var words = normHeader.split(' ');
    if (words.indexOf(alias) !== -1) return 80;
    if (normHeader.indexOf(alias) !== -1) return 65;
    // Token overlap: share at least 2 meaningful tokens.
    var hTokens = words.filter(function (w) { return w.length > 1; });
    var aTokens = alias.split(' ').filter(function (w) { return w.length > 1; });
    var shared = aTokens.filter(function (t) { return hTokens.indexOf(t) !== -1; }).length;
    if (shared >= 2 && shared === aTokens.length) return 55;
    return 0;
  }

  /**
   * Map headers -> canonical signals.
   * Returns { mapping: { SIGNAL: { column, confidence } }, unmapped: [headers] }.
   * Confidence: 'high' (>=80), 'medium' (>=55), 'low' (<55, not assigned).
   */
  function mapChannels(headers) {
    var mapping = {};
    var used = {}; // header -> signal, to enforce one-to-one
    var candidates = [];

    CANONICAL_ORDER.forEach(function (signal) {
      var aliases = SIGNAL_ALIASES[signal];
      headers.forEach(function (h) {
        var norm = normalize(h);
        var best = 0;
        aliases.forEach(function (a) {
          var s = aliasScore(norm, a);
          if (s > best) best = s;
        });
        if (best >= 55) {
          candidates.push({ signal: signal, header: h, score: best });
        }
      });
    });

    // Greedy assignment by descending score.
    candidates.sort(function (a, b) { return b.score - a.score; });
    candidates.forEach(function (c) {
      if (mapping[c.signal] || used[c.header]) return;
      used[c.header] = c.signal;
      mapping[c.signal] = {
        column: c.header,
        confidence: c.score >= 80 ? 'high' : 'medium',
        score: c.score
      };
    });

    var unmapped = headers.filter(function (h) { return !used[h]; });
    return { mapping: mapping, unmapped: unmapped };
  }

  /**
   * Convenience: resolve a canonical signal to its column name, or null.
   */
  function columnFor(mapResult, signal) {
    var m = mapResult.mapping[signal];
    return m ? m.column : null;
  }

  /**
   * STFT/LTFT fallbacks: prefer bank-specific, else generic.
   */
  function fuelTrimColumns(mapResult) {
    return {
      stft: columnFor(mapResult, 'STFT_B1') || columnFor(mapResult, 'STFT'),
      ltft: columnFor(mapResult, 'LTFT_B1') || columnFor(mapResult, 'LTFT')
    };
  }

  /**
   * Per-bank trim column pairs. Averages across banks when both are present.
   */
  function fuelTrimBanks(mapResult) {
    var banks = [];
    var b1 = { stft: columnFor(mapResult, 'STFT_B1'), ltft: columnFor(mapResult, 'LTFT_B1') };
    var b2 = { stft: columnFor(mapResult, 'STFT_B2'), ltft: columnFor(mapResult, 'LTFT_B2') };
    if (b1.stft || b1.ltft) banks.push(b1);
    if (b2.stft || b2.ltft) banks.push(b2);
    if (!banks.length) {
      var gen = { stft: columnFor(mapResult, 'STFT'), ltft: columnFor(mapResult, 'LTFT') };
      if (gen.stft || gen.ltft) banks.push(gen);
    }
    return banks;
  }

  /**
   * Detect a trim channel's encoding from its values:
   *   'multiplier' — centered near 1.0 (e.g. 0.85..1.15)
   *   'count128'   — centered near 128 (GM BLM/INT counts)
   *   'percent'    — centered near 0 (e.g. -25..+25)
   */
  function detectTrimStyle(sampleValues) {
    if (!sampleValues.length) return 'percent';
    var sorted = sampleValues.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    if (med > 0.5 && med < 1.5) return 'multiplier';
    if (med >= 90 && med <= 170) return 'count128';
    return 'percent';
  }

  function trimToPct(v, style) {
    if (v === null || v === undefined) return 0;
    if (style === 'multiplier') return (v - 1) * 100;
    if (style === 'count128') return ((v - 128) / 128) * 100;
    return v;
  }

  P66.SIGNAL_ALIASES = SIGNAL_ALIASES;
  P66.mapChannels = mapChannels;
  P66.columnFor = columnFor;
  P66.fuelTrimColumns = fuelTrimColumns;
  P66.fuelTrimBanks = fuelTrimBanks;
  P66.detectTrimStyle = detectTrimStyle;
  P66.trimToPct = trimToPct;
})(typeof window !== 'undefined' ? window : global);
