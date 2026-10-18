/* P66-Tuner shareable report card.
 * Builds a plain-data summary of one analyzed log and renders it as a
 * fixed-width DOM card (good for screenshots) plus a canvas-drawn PNG
 * download. No dependencies, no DOM-to-canvas libraries.
 *
 *   P66.buildReportData(parsedLog, mapResult) -> {
 *     logName, rows, durationS,
 *     trimStats: { meanB1, meanB2 },  // mean combined STFT+LTFT, 128-count units
 *     knockCount, knockMaxKR,
 *     coverage: { pct, sampleCount },
 *     o2                              // P66.analyzeO2Health result or null
 *   }
 *   P66.reportTrimVerdict(mean) -> { kind: 'lean'|'rich'|'neutral'|'missing', text }
 *   P66.renderReportCard(container, data) -> card element | null
 *   P66.downloadReportPng(data) -> true|false
 *
 * Every piece of data tolerates absence: missing analyzer modules, missing
 * channels, and missing O2-health analysis all degrade to nulls rather than
 * throwing. Fuel-trim colors follow the app convention: blue = adding fuel
 * (lean), red = removing fuel (rich). Always narrowband.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var TRIM_LEAN_COLOR = '#6b9bff';  // blue  = adding fuel / lean
  var TRIM_RICH_COLOR = '#ff5a5a';  // red   = removing fuel / rich
  var NEUTRAL_COLOR = '#eef1f6';

  // ---------------------------------------------------------------- numbers

  function round1(v) { return Math.round(v * 10) / 10; }

  function colFor(mapResult, signal) {
    if (typeof P66.columnFor !== 'function' || !mapResult) return null;
    try { return P66.columnFor(mapResult, signal) || null; }
    catch (e) { return null; }
  }

  // ---------------------------------------------------------------- trim math

  // Local style fallback (channel-mapper normally provides this).
  function fallbackDetectTrimStyle(vals) {
    if (!vals.length) return 'percent';
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    if (med > 0.5 && med < 1.5) return 'multiplier';
    if (med >= 90 && med <= 170) return 'count128';
    return 'percent';
  }

  function detectStyle(vals) {
    if (typeof P66.detectTrimStyle === 'function') {
      try { return P66.detectTrimStyle(vals); } catch (e) { /* fall through */ }
    }
    return fallbackDetectTrimStyle(vals);
  }

  // Every trim encoding normalized to GM 128-count units (128 = no correction).
  function trimToCounts(v, style) {
    if (style === 'multiplier') return v * 128;
    if (style === 'count128') return v;
    return 128 * (1 + v / 100); // percent
  }

  // Per-bank trim column pairs. Bank 1 first, bank 2 second; a single
  // generic STFT/LTFT pair reports as Bank 1 only.
  function bankTrimCols(mapResult) {
    var b1 = {
      stft: colFor(mapResult, 'STFT_B1'),
      ltft: colFor(mapResult, 'LTFT_B1')
    };
    var b2 = {
      stft: colFor(mapResult, 'STFT_B2'),
      ltft: colFor(mapResult, 'LTFT_B2')
    };
    var gen = {
      stft: colFor(mapResult, 'STFT'),
      ltft: colFor(mapResult, 'LTFT')
    };
    var banks = [];
    if (b1.stft || b1.ltft) banks.push({ stft: b1.stft || gen.stft, ltft: b1.ltft || gen.ltft });
    if (b2.stft || b2.ltft) banks.push({ stft: b2.stft || gen.stft, ltft: b2.ltft || gen.ltft });
    if (!banks.length && (gen.stft || gen.ltft)) banks.push({ stft: gen.stft, ltft: gen.ltft });
    return banks;
  }

  // Mean combined (STFT + LTFT) trim in 128-count units for one bank.
  // Combined = stftCounts + ltftCounts - 128; a missing side counts as 128
  // (no correction). Null when neither trim channel exists or no rows
  // carry a value. t: log table (or legacy input, normalized once).
  function meanBankTrim(rows, bank) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var stftC = t ? P66.numView(t, bank.stft) : null;
    var ltftC = t ? P66.numView(t, bank.ltft) : null;
    var stftVals = [], ltftVals = [];
    var cap = Math.min(n, 2000);
    for (var i = 0; i < cap; i++) {
      var s = stftC ? stftC[i] : NaN;
      var l = ltftC ? ltftC[i] : NaN;
      if (s === s) stftVals.push(s);
      if (l === l) ltftVals.push(l);
    }
    if (!stftVals.length && !ltftVals.length) return null;
    var sStyle = detectStyle(stftVals);
    var lStyle = detectStyle(ltftVals);
    var sum = 0, cnt = 0;
    for (var j = 0; j < n; j++) {
      var sv = stftC ? stftC[j] : NaN;
      var lv = ltftC ? ltftC[j] : NaN;
      if (sv !== sv && lv !== lv) continue;
      var sc = sv !== sv ? 128 : trimToCounts(sv, sStyle);
      var lc = lv !== lv ? 128 : trimToCounts(lv, lStyle);
      sum += sc + lc - 128;
      cnt++;
    }
    return cnt ? round1(sum / cnt) : null;
  }

  function reportTrimStats(rows, mapResult) {
    var stats = { meanB1: null, meanB2: null };
    try {
      var banks = bankTrimCols(mapResult);
      if (banks[0]) stats.meanB1 = meanBankTrim(rows, banks[0]);
      if (banks[1]) stats.meanB2 = meanBankTrim(rows, banks[1]);
    } catch (e) { /* nulls stand */ }
    return stats;
  }

  // ------------------------------------------------------------------ pieces

  function reportDuration(rows, mapResult) {
    try {
      var t = P66.asTable(rows);
      var col = t ? P66.numView(t, colFor(mapResult, 'TIME')) : null;
      if (!col) return null;
      var min = Infinity, max = -Infinity, n = 0;
      for (var i = 0; i < t.rowCount; i++) {
        var tt = col[i];
        if (tt !== tt) continue;
        if (tt < min) min = tt;
        if (tt > max) max = tt;
        n++;
      }
      if (n < 2 || !(max > min)) return null;
      return round1(max - min);
    } catch (e) { return null; }
  }

  function reportKnock(rows, mapResult) {
    if (typeof P66.analyzeKnock !== 'function') return { count: null, maxKR: null };
    try {
      var r = P66.analyzeKnock(rows, mapResult);
      if (!r || !r.available) return { count: null, maxKR: null };
      return { count: r.knockEvents, maxKR: r.maxKR };
    } catch (e) { return { count: null, maxKR: null }; }
  }

  // O2 health is built by a sibling worker that may not be loaded yet;
  // its result shape is unknown, so this is pure best-effort.
  function reportO2(rows, mapResult) {
    if (typeof P66.analyzeO2Health !== 'function') return null;
    try { return P66.analyzeO2Health(rows, mapResult) || null; }
    catch (e) { return null; }
  }

  /**
   * Assemble the report data object. Never throws on missing pieces —
   * anything unavailable becomes null.
   */
  function buildReportData(parsedLog, mapResult) {
    var data = {
      logName: null,
      logSources: null, // multi-log sessions: [{ name, rows }] per merged file
      rows: 0,
      durationS: null,
      trimStats: { meanB1: null, meanB2: null },
      knockCount: null,
      knockMaxKR: null,
      coverage: { pct: null, sampleCount: 0 },
      o2: null
    };
    try {
      var t = P66.asTable(parsedLog);
      var n = t ? t.rowCount : 0;
      data.rows = n;
      data.coverage.sampleCount = n;
      if (parsedLog) {
        data.logName = parsedLog.logName || parsedLog.name || null;
        if (parsedLog.logSources) {
          data.logSources = parsedLog.logSources.map(function (s) {
            return { name: s.name, rows: s.rows };
          });
        }
      }
      data.durationS = reportDuration(t, mapResult);
      data.trimStats = reportTrimStats(t, mapResult);
      var k = reportKnock(t, mapResult);
      data.knockCount = k.count;
      data.knockMaxKR = k.maxKR;
      data.o2 = reportO2(t, mapResult);
    } catch (e) { /* partial data still returned */ }
    return data;
  }

  // ------------------------------------------------------------- text lines

  /**
   * Plain-English verdict for a mean trim in 128-count units.
   */
  function reportTrimVerdict(mean) {
    if (mean === null || mean === undefined || isNaN(mean)) {
      return { kind: 'missing', text: 'trim channels not logged' };
    }
    var d = mean - 128;
    if (Math.abs(d) < 0.5) {
      return { kind: 'neutral', text: 'on target (avg ' + mean.toFixed(1) + ')' };
    }
    if (d > 0) {
      return { kind: 'lean', text: 'running lean — PCM adding fuel (avg ' + mean.toFixed(1) + ')' };
    }
    return { kind: 'rich', text: 'running rich — PCM pulling fuel (avg ' + mean.toFixed(1) + ')' };
  }

  function verdictColor(kind) {
    if (kind === 'lean') return TRIM_LEAN_COLOR;
    if (kind === 'rich') return TRIM_RICH_COLOR;
    return NEUTRAL_COLOR;
  }

  function fmtDuration(s) {
    if (s === null || s === undefined || isNaN(s)) return '—';
    var m = Math.floor(s / 60);
    var sec = Math.round(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function knockText(data) {
    if (data.knockCount === null || data.knockCount === undefined) {
      return 'Knock: KR channel not logged';
    }
    if (data.knockCount === 0) return 'Knock: no knock events';
    var worst = (data.knockMaxKR !== null && data.knockMaxKR !== undefined)
      ? ' (worst ' + data.knockMaxKR + '°)' : '';
    return 'Knock: ' + data.knockCount + ' event' +
      (data.knockCount === 1 ? '' : 's') + worst;
  }

  function coverageText(data) {
    var n = data.coverage ? data.coverage.sampleCount : 0;
    var pct = data.coverage && data.coverage.pct !== null && data.coverage.pct !== undefined
      ? ' · coverage ' + data.coverage.pct + '%' : '';
    return 'Coverage: ' + n.toLocaleString('en-US') + ' samples analyzed (' +
      fmtDuration(data.durationS) + ')' + pct;
  }

  function o2Summary(o2) {
    if (o2 === null || o2 === undefined) return null;
    if (typeof o2 === 'string') return o2 || null;
    if (typeof o2 !== 'object') return String(o2);
    var keys = ['summary', 'verdict', 'status', 'note', 'message'];
    for (var i = 0; i < keys.length; i++) {
      if (typeof o2[keys[i]] === 'string' && o2[keys[i]]) return o2[keys[i]];
    }
    if (typeof o2.healthy === 'boolean') {
      return o2.healthy ? 'O2 sensors reading healthy' : 'O2 sensor issue flagged — check sensors';
    }
    return null; // unknown shape: omit the line rather than print garbage
  }

  // One {label, text, color} per stat row; shared by the DOM card and the
  // canvas PNG so both stay in sync.
  function reportLines(data) {
    var v1 = reportTrimVerdict(data.trimStats.meanB1);
    var v2 = reportTrimVerdict(data.trimStats.meanB2);
    var lines = [
      { label: 'Bank 1', text: v1.text, kind: v1.kind, color: verdictColor(v1.kind) },
      { label: 'Bank 2', text: v2.text, kind: v2.kind, color: verdictColor(v2.kind) },
      { label: 'Knock', text: knockText(data).replace(/^Knock: /, ''), color: NEUTRAL_COLOR },
      { label: 'Coverage', text: coverageText(data).replace(/^Coverage: /, ''), color: NEUTRAL_COLOR }
    ];
    var os = o2Summary(data.o2);
    if (os) lines.push({ label: 'O2 health', text: os, color: NEUTRAL_COLOR });
    return lines;
  }

  function reportSubtitle(data) {
    var bits = [];
    if (data.logSources && data.logSources.length) {
      bits.push(data.logSources.map(function (s) { return s.name; }).join(' + '));
    } else if (data.logName) {
      bits.push(data.logName);
    }
    bits.push(data.rows.toLocaleString('en-US') + ' rows');
    bits.push(fmtDuration(data.durationS));
    return bits.join('  ·  ');
  }

  // ------------------------------------------------------------------- DOM

  /**
   * Render the fixed-width summary card into container. Returns the card
   * element, or null outside a DOM environment.
   */
  function renderReportCard(container, data) {
    if (typeof document === 'undefined') return null;
    if (!container || !data) return null;
    var doc = document;

    var card = doc.createElement('div');
    card.className = 'p66-report-card';

    var title = doc.createElement('div');
    title.className = 'p66-rc-title';
    title.textContent = 'P66 Log Report';
    card.appendChild(title);

    var sub = doc.createElement('div');
    sub.className = 'p66-rc-sub';
    sub.textContent = reportSubtitle(data);
    card.appendChild(sub);

    reportLines(data).forEach(function (line) {
      var row = doc.createElement('div');
      row.className = 'p66-rc-row';
      var label = doc.createElement('span');
      label.className = 'p66-rc-label';
      label.textContent = line.label;
      var val = doc.createElement('span');
      val.className = 'p66-rc-val' +
        (line.kind === 'lean' ? ' trim-lean' :
          line.kind === 'rich' ? ' trim-rich' : '');
      val.textContent = line.text;
      row.appendChild(label);
      row.appendChild(val);
      card.appendChild(row);
    });

    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'p66-rc-btn';
    btn.textContent = 'Download PNG';
    btn.addEventListener('click', function () { downloadReportPng(data); });
    card.appendChild(btn);

    container.appendChild(card);
    return card;
  }

  // ------------------------------------------------------------------ PNG

  /**
   * Draw a simplified version of the card onto a <canvas> and trigger a
   * PNG download. Deliberately simple and robust — not pixel-identical
   * to the DOM card. Returns false outside a DOM environment.
   */
  function downloadReportPng(data) {
    if (typeof document === 'undefined') return false;
    try {
      var lines = reportLines(data);
      var W = 1600;
      var pad = 64, titleH = 104, subH = 64, lineH = 62, footH = 70;
      var H = pad + titleH + subH + lines.length * lineH + footH + pad;

      var canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext('2d');
      if (!ctx) return false;

      // Background + border.
      ctx.fillStyle = '#14171c';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#2a2e35';
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, W - 16, H - 16);
      // Accent bar.
      ctx.fillStyle = '#2b6cb0';
      ctx.fillRect(pad, pad + 8, 10, titleH + subH - 16);

      var x = pad + 40;
      var y = pad + 66;
      ctx.fillStyle = '#eef1f6';
      ctx.font = '700 54px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText('P66 Log Report', x, y);

      y += subH;
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '400 32px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(reportSubtitle(data), x, y);

      y += 26;
      ctx.font = '400 34px system-ui, -apple-system, "Segoe UI", sans-serif';
      lines.forEach(function (line) {
        y += lineH;
        ctx.fillStyle = '#9aa3b2';
        ctx.fillText(line.label + ':', x, y);
        ctx.fillStyle = line.color;
        ctx.fillText(line.text, x + 280, y);
      });

      y += footH;
      ctx.fillStyle = '#5b6470';
      ctx.font = '400 26px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillText('p66-tuner · narrowband O2 only', x, y);

      canvas.toBlob(function (blob) {
        if (!blob) return;
        var url = (window.URL || window.webkitURL).createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'p66-log-report.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          (window.URL || window.webkitURL).revokeObjectURL(url);
          a.remove();
        }, 1500);
      }, 'image/png');
      return true;
    } catch (e) { return false; }
  }

  P66.buildReportData = buildReportData;
  P66.reportTrimVerdict = reportTrimVerdict;
  P66.renderReportCard = renderReportCard;
  P66.downloadReportPng = downloadReportPng;
})(typeof window !== 'undefined' ? window : global);
