/* Drive-segment breakdown for p66-tuner.
 *
 * Splits a log into drive segments so the user can see WHERE the log's
 * samples came from (idle vs cruise vs WOT vs decel) and what the average
 * fuel trim was in each segment.
 *
 * Segment definitions (evaluated in the priority order below; the first
 * match wins):
 *
 *   idle   — RPM<1450 && TPS<2% && VSS<3. Reuses the analyzer's idle
 *            convention verbatim: these are the stock-calibration
 *            "Idle VE Possible" entry scalars, and this is the region where
 *            the PCM runs the Idle VE table instead of Main VE.
 *   wot    — TPS>70%. The driver is asking for near/full power; PE-mode
 *            territory where trims go open loop.
 *   decel  — TPS<2% && RPM>1500 && VSS>10. Foot off the pedal while rolling
 *            with engine speed still up — overrun / decel-fuel-cut
 *            territory where trims swing for reasons unrelated to VE.
 *   cruise — In-gear steady driving that is none of the above:
 *            VSS>3 (rolling) and TPS in the 2–70% band. This is the part of
 *            the log that actually teaches the tuner something.
 *   other  — Everything left over: parked revs (RPM up, VSS ~ 0), rows
 *            with missing/non-numeric RPM, TPS or VSS, or an unmapped
 *            RPM/TPS/VSS column. Never throws — unknown data is "other",
 *            not an error.
 *
 * Priority when a sample qualifies for more than one:
 *   idle > wot > decel > cruise > other.
 * In practice the definitions are nearly disjoint (idle needs VSS<3 while
 * decel needs VSS>10, wot needs TPS>70 while idle needs TPS<2), but the
 * ordering is enforced anyway: idle wins first because the analyzer's idle
 * convention is anchored on the PCM's own idle-entry scalars, and wot
 * outranks cruise/decel because TPS>70% is unambiguous driver intent.
 *
 * Trim reporting: avgTrimB1/avgTrimB2 are the mean COMBINED trim
 * (STFT+LTFT) of that segment's samples in GM 128-count units, centered
 * at 128 — below 128 the PCM is removing fuel (rich), above 128 it is
 * adding fuel (lean). Each trim channel is auto-detected for its encoding
 * (P66.detectTrimStyle: 'count128', 'multiplier', or 'percent') and
 * converted to 128-count units before combining. null when no trim
 * channel is mapped for that bank.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // ---- segment definitions ----
  var IDLE_RPM_MAX = 1450;   // analyzer's idle convention (stock "Idle VE Possible" scalar)
  var IDLE_TPS_MAX = 2;      // %
  var IDLE_VSS_MAX = 3;      // mph
  var WOT_TPS_MIN = 70;      // %
  var DECEL_TPS_MAX = 2;     // %
  var DECEL_RPM_MIN = 1500;
  var DECEL_VSS_MIN = 10;    // mph

  var SEGMENTS = [
    { key: 'idle',   label: 'Idle' },
    { key: 'cruise', label: 'Cruise' },
    { key: 'wot',    label: 'WOT' },
    { key: 'decel',  label: 'Decel' },
    { key: 'other',  label: 'Other' }
  ];

  /**
   * Classify one sample. Returns one of the SEGMENTS keys.
   * Missing/non-numeric RPM, TPS or VSS -> 'other' (never throws).
   * Priority: idle > wot > decel > cruise > other.
   */
  function classifySegment(rpm, tps, vss) {
    if (rpm === null || tps === null || vss === null) return 'other';
    if (rpm < IDLE_RPM_MAX && tps < IDLE_TPS_MAX && vss < IDLE_VSS_MAX) return 'idle';
    if (tps > WOT_TPS_MIN) return 'wot';
    if (tps < DECEL_TPS_MAX && rpm > DECEL_RPM_MIN && vss > DECEL_VSS_MIN) return 'decel';
    if (vss > IDLE_VSS_MAX && tps >= IDLE_TPS_MAX && tps <= WOT_TPS_MIN) return 'cruise';
    return 'other';
  }

  // ---- trim handling (128-count units, centered at 128) ----

  // Sample up to max numeric values from a column for encoding detection.
  // Accepts a log table or a legacy row-object array.
  function sampleValues(rows, name, max) {
    max = max || 500;
    var out = [];
    var t = P66.asTable(rows);
    if (!t) return out;
    var c = P66.numView(t, name);
    if (!c) return out;
    for (var i = 0; i < t.rowCount && out.length < max; i++) {
      var v = c[i];
      if (v === v) out.push(v);
    }
    return out;
  }

  // Convert a trim reading to GM 128-count units.
  function toCount128(v, style) {
    if (style === 'multiplier') return v * 128;          // 1.0 -> 128
    if (style === 'percent') return 128 * (1 + v / 100); // 0% -> 128
    return v;                                           // already 128-counts
  }

  /**
   * Combined trim for one bank on one row, in 128-count units centered
   * at 128. Unmapped channels contribute neutrally (128); a non-numeric
   * value on a mapped channel means "no data this row" -> returns null.
   * t: log table; i: row index; cols: { stft, ltft } Float32Arrays (or null).
   */
  function bankCombinedAt(t, i, cols, style) {
    var total = -128; // each mapped channel adds ~128 at stoich
    var mapped = 0;
    var chans = [
      cols.stft ? { c: cols.stft, style: style.stft } : null,
      cols.ltft ? { c: cols.ltft, style: style.ltft } : null
    ];
    for (var k = 0; k < chans.length; k++) {
      if (!chans[k]) continue;
      var v = chans[k].c[i];
      if (v !== v) return null;
      total += toCount128(v, chans[k].style);
      mapped++;
    }
    return mapped ? total : null;
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  /**
   * P66.analyzeSegments(rows, mapResult)
   * rows: a log table or a legacy array of row objects.
   * Returns [{ key, label, share, samples, avgTrimB1, avgTrimB2 }] in the
   * SEGMENTS order. share = samples / rowCount. avgTrimB1/avgTrimB2 are
   * the mean combined trim (STFT+LTFT, 128-count units) per segment, or
   * null when that bank has no mapped trim channel.
   */
  function analyzeSegments(rows, mapResult) {
    var t = P66.asTable(rows) || P66.tableFromRows([]);
    var n = t.rowCount;
    var rpmC = P66.numView(t, mapResult ? P66.columnFor(mapResult, 'RPM') : null);
    var tpsC = P66.numView(t, mapResult ? P66.columnFor(mapResult, 'TPS') : null);
    var vssC = P66.numView(t, mapResult ? P66.columnFor(mapResult, 'VSS') : null);

    var banks = (mapResult && typeof P66.fuelTrimBanks === 'function')
      ? P66.fuelTrimBanks(mapResult) : [];
    var styles = banks.map(function (b) {
      return {
        stft: b.stft ? P66.detectTrimStyle(sampleValues(t, b.stft)) : 'percent',
        ltft: b.ltft ? P66.detectTrimStyle(sampleValues(t, b.ltft)) : 'percent'
      };
    });
    var bankCols = banks.map(function (b) {
      return { stft: P66.numView(t, b.stft), ltft: P66.numView(t, b.ltft) };
    });

    var acc = {};
    SEGMENTS.forEach(function (s) {
      acc[s.key] = { samples: 0, b1sum: 0, b1n: 0, b2sum: 0, b2n: 0 };
    });

    for (var i = 0; i < n; i++) {
      var key = classifySegment(
        rpmC ? (rpmC[i] !== rpmC[i] ? null : rpmC[i]) : null,
        tpsC ? (tpsC[i] !== tpsC[i] ? null : tpsC[i]) : null,
        vssC ? (vssC[i] !== vssC[i] ? null : vssC[i]) : null
      );
      var a = acc[key];
      a.samples++;
      if (banks[0]) {
        var t1 = bankCombinedAt(t, i, bankCols[0], styles[0]);
        if (t1 !== null) { a.b1sum += t1; a.b1n++; }
      }
      if (banks[1]) {
        var t2 = bankCombinedAt(t, i, bankCols[1], styles[1]);
        if (t2 !== null) { a.b2sum += t2; a.b2n++; }
      }
    }

    return SEGMENTS.map(function (s) {
      var a = acc[s.key];
      return {
        key: s.key,
        label: s.label,
        share: n ? a.samples / n : 0,
        samples: a.samples,
        avgTrimB1: banks[0] && a.b1n ? round1(a.b1sum / a.b1n) : null,
        avgTrimB2: banks[1] && a.b2n ? round1(a.b2sum / a.b2n) : null
      };
    });
  }

  // ---- rendering ----

  // Below 128 (PCM removing fuel / rich) -> .trim-neg (red);
  // above 128 (adding fuel / lean) -> .trim-pos (blue); null -> dash.
  // These classes live in styles.css and follow the app's fuel-trim color
  // convention. Exactly 128 keeps the default text color.
  function trimCell(v) {
    if (v === null || v === undefined) return '<span class="seg-trim-dash">—</span>';
    var cls = v < 128 ? 'trim-neg' : (v > 128 ? 'trim-pos' : '');
    var txt = (Math.round(v * 10) / 10).toFixed(1);
    return cls ? '<span class="' + cls + '">' + txt + '</span>' : '<span>' + txt + '</span>';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * P66.renderSegments(container, result)
   * Renders a stacked horizontal share bar (one colored block per segment,
   * width ∝ share) plus a legend, then one row per segment with label,
   * % share, sample count, and average trims colored by the 128 rule.
   */
  function renderSegments(container, result) {
    if (typeof document === 'undefined') return;
    if (!container) return;
    container.innerHTML = '';
    result = result || [];

    var wrap = document.createElement('div');
    wrap.className = 'seg-wrap';

    // Stacked share bar: one block per segment, width ∝ share.
    var bar = document.createElement('div');
    bar.className = 'seg-bar';
    result.forEach(function (seg) {
      if (seg.share <= 0) return;
      var block = document.createElement('div');
      block.className = 'seg-block seg-' + esc(seg.key);
      block.style.width = (seg.share * 100).toFixed(2) + '%';
      block.title = seg.label + ': ' + (seg.share * 100).toFixed(1) + '%';
      bar.appendChild(block);
    });
    wrap.appendChild(bar);

    // Legend.
    var legend = document.createElement('div');
    legend.className = 'seg-legend';
    result.forEach(function (seg) {
      var item = document.createElement('span');
      item.className = 'seg-legend-item';
      item.innerHTML = '<span class="seg-chip seg-' + esc(seg.key) + '"></span>' +
        esc(seg.label) + ' ' + (seg.share * 100).toFixed(1) + '%';
      legend.appendChild(item);
    });
    wrap.appendChild(legend);

    // Per-segment rows.
    var rows = document.createElement('div');
    rows.className = 'seg-rows';
    result.forEach(function (seg) {
      var row = document.createElement('div');
      row.className = 'seg-row';
      row.innerHTML =
        '<span class="seg-chip seg-' + esc(seg.key) + '"></span>' +
        '<span class="seg-label">' + esc(seg.label) + '</span>' +
        '<span class="seg-share">' + (seg.share * 100).toFixed(1) + '%</span>' +
        '<span class="seg-count">' + seg.samples.toLocaleString() + ' samples</span>' +
        '<span class="seg-trim">B1 ' + trimCell(seg.avgTrimB1) + '</span>' +
        '<span class="seg-trim">B2 ' + trimCell(seg.avgTrimB2) + '</span>';
      rows.appendChild(row);
    });
    wrap.appendChild(rows);

    container.appendChild(wrap);
  }

  P66.SEGMENTS = SEGMENTS;
  P66.classifySegment = classifySegment;
  P66.analyzeSegments = analyzeSegments;
  P66.renderSegments = renderSegments;
})(typeof window !== 'undefined' ? window : global);
