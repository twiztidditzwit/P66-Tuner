/* P66-Tuner patch convergence check ("did my last patch work?")
 *
 * The tuning loop is: log -> analyze -> patch -> flash -> drive -> log
 * again. This module answers the question the second log exists for: did
 * the patch set actually move the cells it touched toward stoich?
 *
 *   P66.checkConvergence(beforeReport, afterReport, patchSet) -> result
 *   P66.renderConvergenceHTML(result) -> compact HTML string
 *
 * Input contract
 * --------------
 * beforeReport / afterReport: analyzer session reports as returned by
 *   P66.analyzeSession. Only report.fuelTrims is read:
 *     report.fuelTrims = {
 *       available: true,
 *       cells: [{ rpmBin, mapBin, samples, avgTrim, stddev, idleFraction }, ...]
 *     }
 *   avgTrim / stddev are SIGNED PERCENT (0 = stoich; positive = ECU adding
 *   fuel = running lean; negative = ECU removing fuel = running rich).
 * patchSet: the patch identity the journal will carry (the coordinator tags
 *   it; build it from the session's actionable suggestions — every field
 *   below exists on a tuner suggestion):
 *     {
 *       id: 'ps_k3xq...',               // stable id the journal carries
 *       appliedAt: '2026-10-22T19:00:00Z', // when the patched bin was flashed
 *       beforeLog: 'yesss.csv',         // log behind beforeReport
 *       afterLog: 'run2.csv',           // log behind afterReport
 *       patches: [
 *         { table: 'Main VE', cell: '1000-1500 RPM / 40-50 kPa', kind: 'fuel',
 *           action: 'add fuel', deltaPct: 5.0, confidence: 'high' },
 *         { table: 'Spark Advance', cell: '3000-3500 RPM / 70-80 kPa',
 *           kind: 'spark', action: 'retard timing', deltaDeg: -2 }
 *       ]
 *     }
 *   table: tuner suggestion table name ('Main VE', 'Idle VE', ...).
 *   cell:  tuner suggestion cell label ('1000-1500 RPM / 40-50 kPa' for
 *          fuel; 'global', 'WOT', 'tip-in', ... for other kinds).
 *   kind:  tuner suggestion kind ('fuel', 'spark', 'pe', 'ae',
 *          'pe-entry', 'trans-firmness', ...).
 *   deltaPct / deltaDeg: the applied move (one will be null). Optional.
 *
 * How it judges
 * -------------
 * Patches are grouped by (kind, table, cell) into regions. Only fuel-kind
 * patches (Main VE / Idle VE) move closed-loop fuel trims, so only those
 * get a trim verdict; every other kind is 'inconclusive' with a
 * plain-English reason pointing at the right evidence (knock report for
 * spark, WOT logs for PE, ...).
 * For a fuel region: compare the before/after mean trim (deviation from 0)
 * on the same RPM x MAP cell. Converged = trims moved toward 0 by at
 * least CONVERGE_MARGIN_PCT; not-converged = barely moved or moved away;
 * inconclusive = the after-log has too few warm, steady-state samples in
 * the region (or no samples at all). Always narrowband.
 *
 * Result:
 *   {
 *     available: true, reason: null,
 *     patchSetId, beforeLog, afterLog,
 *     regions: [{
 *       table, kind, cell, region,           // region = plain words
 *       verdict: 'converged'|'not-converged'|'inconclusive',
 *       before: { avgTrim, stddev, samples }, // percent, signed; 0 = stoich
 *       after:  { avgTrim, stddev, samples },
 *       patchCount, netDeltaPct,             // netDeltaPct null for spark
 *       detail: 'plain words'
 *     }],
 *     summary: { total, converged, notConverged, inconclusive, text }
 *   }
 *
 * Fuel-trim colors (app convention): blue = lean / ECU adding fuel /
 * positive trim, red = rich / ECU removing fuel / negative trim.
 * No dependencies; DOM-free (render returns a string).
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Judgment floors. The tuner's balanced-mode trim gate is 3% and its
  // conservative per-cell sample floor is 30; convergence uses 3% as the
  // "meaningful move" margin and 20 warm samples as the evidence floor.
  var CONVERGE_MARGIN_PCT = 3;   // |improvement| >= this to call it converged
  var AFTER_MIN_SAMPLES = 20;   // gated samples needed in the after-log region

  var TRIM_LEAN_COLOR = '#6b9bff';  // blue = adding fuel / lean
  var TRIM_RICH_COLOR = '#ff5a5a';  // red  = removing fuel / rich

  function round1(v) { return Math.round(v * 10) / 10; }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSignedPct(v) {
    if (v === null || v === undefined || v !== v) return '—';
    var r = round1(v);
    return (r > 0 ? '+' : '') + r + '%';
  }

  function leanRichWord(v) {
    if (v > 0) return 'lean (ECU was adding fuel)';
    if (v < 0) return 'rich (ECU was removing fuel)';
    return 'right on stoich';
  }

  // ---- report cell lookup ----

  function cellIndex(report) {
    var idx = {};
    var ft = report && report.fuelTrims;
    if (!ft || !ft.available || !Array.isArray(ft.cells)) return null;
    ft.cells.forEach(function (c) {
      if (!c || !c.rpmBin || !c.mapBin) return;
      idx[c.rpmBin + '|' + c.mapBin] = {
        avgTrim: (typeof c.avgTrim === 'number') ? c.avgTrim : null,
        stddev: (typeof c.stddev === 'number') ? c.stddev : 0,
        samples: (typeof c.samples === 'number') ? c.samples : 0
      };
    });
    return idx;
  }

  // ---- region naming (plain words) ----

  // Tuner fuel cell labels look like "1000-1500 RPM / 40-50 kPa".
  function parseTrimCell(label) {
    var m = /^(\S+)\s*RPM\s*\/\s*(\S+)\s*kPa/.exec(String(label || ''));
    return m ? { rpmBin: m[1], mapBin: m[2] } : null;
  }

  function binStart(bin) {
    var m = /^(\d+)/.exec(String(bin || ''));
    return m ? parseInt(m[1], 10) : NaN;
  }

  function plainRegion(table, cellLabel) {
    var nice = String(table || '').toLowerCase().replace(/\s+ve$/, ' VE');
    if (/idle ve/i.test(String(table || ''))) nice = 'idle VE';
    else if (/main ve/i.test(String(table || ''))) nice = 'main VE';
    var p = parseTrimCell(cellLabel);
    if (!p) return nice || String(cellLabel || 'unknown zone');
    var rpm = binStart(p.rpmBin), map = binStart(p.mapBin);
    var rpmWord = (rpm !== rpm) ? '' : (rpm < 2000 ? 'low rpm' : (rpm < 3500 ? 'mid rpm' : 'high rpm'));
    var mapWord = (map !== map) ? '' : (map < 50 ? 'light load' : (map < 80 ? 'part load' : 'heavy load'));
    return [nice, rpmWord, mapWord].filter(function (w) { return w; }).join(', ') || nice;
  }

  // ---- verdicts ----

  function spreadNote(before, after) {
    if (before.stddev > 0 && after.stddev > before.stddev + 3) {
      return ' Spread widened (' + round1(before.stddev) + '% to ' +
        round1(after.stddev) + '%), so the cell is noisier than it was — ' +
        'could be transients or a lazy O2; watch it next log.';
    }
    return '';
  }

  function fuelVerdict(before, after) {
    if (!before || before.avgTrim === null || !before.samples) {
      return {
        verdict: 'inconclusive',
        detail: 'The before-log has no usable samples in this zone, so there is no baseline to compare against.'
      };
    }
    if (!after || !after.samples) {
      return {
        verdict: 'inconclusive',
        detail: 'This zone does not appear in the after-log at all. Drive so it covers the same ground as the before-log, then check again.'
      };
    }
    if (after.samples < AFTER_MIN_SAMPLES) {
      return {
        verdict: 'inconclusive',
        detail: 'Only ' + after.samples + ' warm, steady-state samples landed in this zone after the flash ' +
          '(need ' + AFTER_MIN_SAMPLES + '). Log more driving here, then check again.'
      };
    }
    var b = before.avgTrim, a = after.avgTrim;
    var dB = Math.abs(b), dA = Math.abs(a);
    var improvement = dB - dA;
    var flipped = (b > 0 && a < 0) || (b < 0 && a > 0);

    if (flipped) {
      if (dA < CONVERGE_MARGIN_PCT) {
        return {
          verdict: 'converged',
          detail: 'Crossed through stoich and landed clean — was ' + leanRichWord(b) +
            ' (' + fmtSignedPct(b) + '), now ' + fmtSignedPct(a) + '.' + spreadNote(before, after)
        };
      }
      return {
        verdict: 'not-converged',
        detail: 'Overshot — was ' + leanRichWord(b) + ' (' + fmtSignedPct(b) +
          '), now ' + leanRichWord(a) + ' (' + fmtSignedPct(a) +
          '). Halve the move on this zone and re-log.'
      };
    }
    if (improvement >= CONVERGE_MARGIN_PCT) {
      return {
        verdict: 'converged',
        detail: 'Was ' + leanRichWord(b) + ' (' + fmtSignedPct(b) +
          '), now ' + fmtSignedPct(a) + ' — the correction moved it toward stoich.' +
          spreadNote(before, after)
      };
    }
    if (improvement <= -CONVERGE_MARGIN_PCT) {
      return {
        verdict: 'not-converged',
        detail: 'Went the wrong way — ' + fmtSignedPct(b) + ' before, ' +
          fmtSignedPct(a) + ' after, further from stoich. This patch made it worse; roll it back.'
      };
    }
    return {
      verdict: 'not-converged',
      detail: 'No real movement (' + fmtSignedPct(b) + ' to ' + fmtSignedPct(a) +
        ') — the patch has not taken hold in this zone yet. Confirm the patched bin is actually flashed.'
    };
  }

  function nonFuelReason(kind, table) {
    var k = String(kind || '');
    if (k === 'spark') {
      return 'Spark patches move timing, not fuel trims — judge this one by the knock report, not by trims.';
    }
    if (k === 'pe') {
      return 'Power-enrichment patches only matter at wide-open throttle; closed-loop trims cannot judge them. Check WOT lambda instead.';
    }
    if (k === 'ae') {
      return 'Accel-enrichment patches only fire on tip-in; steady-state trims cannot judge them. Check tip-in lean spikes instead.';
    }
    if (k === 'pe-entry') {
      return 'PE-entry patches change when enrichment starts, not cruising fuel — trims cannot judge this. Watch WOT entries instead.';
    }
    if (/^trans/.test(k)) {
      return 'Transmission patches move shift behavior, not fuel trims — judge this one by shift feel and the transmission report.';
    }
    return 'This ' + (table ? table + ' ' : '') + 'patch does not move closed-loop fuel trims, so trims cannot judge it.';
  }

  // ---- main entry ----

  function checkConvergence(beforeReport, afterReport, patchSet) {
    patchSet = patchSet || {};
    var patches = Array.isArray(patchSet.patches) ? patchSet.patches : [];

    var beforeIdx = cellIndex(beforeReport);
    var afterIdx = cellIndex(afterReport);
    var available = !!beforeIdx && !!afterIdx;
    var reason = null;
    if (!beforeIdx && !afterIdx) reason = 'Neither session has fuel-trim data.';
    else if (!beforeIdx) reason = 'The before-session has no fuel-trim data.';
    else if (!afterIdx) reason = 'The after-session has no fuel-trim data.';

    // Group patches into regions by (kind, table, cell).
    var groups = {}; // key -> { kind, table, cell, patchCount, netDeltaPct, netDeltaDeg }
    patches.forEach(function (p) {
      p = p || {};
      var key = String(p.kind || '') + '|' + String(p.table || '') + '|' + String(p.cell || '');
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          kind: p.kind || '', table: p.table || '', cell: p.cell || '',
          patchCount: 0, netDeltaPct: 0, netDeltaDeg: 0,
          hasPct: false, hasDeg: false
        };
      }
      g.patchCount++;
      if (typeof p.deltaPct === 'number' && p.deltaPct === p.deltaPct) {
        g.netDeltaPct += p.deltaPct; g.hasPct = true;
      }
      if (typeof p.deltaDeg === 'number' && p.deltaDeg === p.deltaDeg) {
        g.netDeltaDeg += p.deltaDeg; g.hasDeg = true;
      }
    });

    var regions = Object.keys(groups).sort().map(function (key) {
      var g = groups[key];
      var parsed = parseTrimCell(g.cell);
      var regionName = plainRegion(g.table, g.cell);
      var r = {
        table: g.table,
        kind: g.kind,
        cell: g.cell,
        region: regionName,
        verdict: 'inconclusive',
        before: null,
        after: null,
        patchCount: g.patchCount,
        netDeltaPct: g.hasPct ? round1(g.netDeltaPct) : null,
        netDeltaDeg: g.hasDeg ? round1(g.netDeltaDeg) : null,
        detail: ''
      };
      if (!available) {
        r.detail = reason + ' Trims cannot be compared.';
        return r;
      }
      if (g.kind !== 'fuel' || !parsed) {
        r.detail = nonFuelReason(g.kind, g.table);
        return r;
      }
      var lookupKey = parsed.rpmBin + '|' + parsed.mapBin;
      r.before = beforeIdx[lookupKey] || null;
      r.after = afterIdx[lookupKey] || null;
      var v = fuelVerdict(r.before, r.after);
      r.verdict = v.verdict;
      r.detail = v.detail;
      return r;
    });

    var s = { total: regions.length, converged: 0, notConverged: 0, inconclusive: 0 };
    regions.forEach(function (r) {
      if (r.verdict === 'converged') s.converged++;
      else if (r.verdict === 'not-converged') s.notConverged++;
      else s.inconclusive++;
    });
    s.text = summaryText(s);

    return {
      available: available,
      reason: reason,
      patchSetId: patchSet.id || null,
      beforeLog: patchSet.beforeLog || null,
      afterLog: patchSet.afterLog || null,
      regions: regions,
      summary: s
    };
  }

  function summaryText(s) {
    if (!s.total) return 'No patches in this patch set — nothing to check.';
    var z = s.total === 1 ? 'zone' : 'zones';
    if (s.converged === s.total) {
      return 'Every patched ' + z + ' settled toward stoich — the last flash did its job.';
    }
    if (s.converged > 0 && s.notConverged === 0) {
      return s.converged + ' of ' + s.total + ' patched ' + z +
        ' settled toward stoich; the rest had too little after-log driving to judge. Log more and check again.';
    }
    if (s.notConverged === s.total) {
      return 'None of the patched ' + z + ' moved toward stoich yet — confirm the patched bin is actually flashed, then re-log.';
    }
    var parts = [];
    if (s.converged) parts.push(s.converged + ' settled');
    if (s.notConverged) parts.push(s.notConverged + ' did not move or went worse');
    if (s.inconclusive) parts.push(s.inconclusive + ' need more driving to judge');
    return 'Of ' + s.total + ' patched ' + z + ': ' + parts.join(', ') + '.';
  }

  // ---- rendering ----

  function trimSpan(v) {
    if (v === null || v === undefined || v !== v) return '<span>—</span>';
    var color = Math.abs(v) < 0.5 ? 'inherit'
      : (v > 0 ? TRIM_LEAN_COLOR : TRIM_RICH_COLOR);
    return '<span style="color:' + color + ';font-weight:600;">' + escHtml(fmtSignedPct(v)) + '</span>';
  }

  function verdictBadge(verdict) {
    var style, text;
    if (verdict === 'converged') {
      style = 'background:#12351f;color:#7ee2a0;border:1px solid #2c6b3f;';
      text = 'Converged';
    } else if (verdict === 'not-converged') {
      style = 'background:#3d1a12;color:#ff9a7a;border:1px solid #7a3a26;';
      text = 'Not converged';
    } else {
      style = 'background:#2a2f38;color:#aab3c0;border:1px solid #454c59;';
      text = 'Inconclusive';
    }
    return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;' +
      style + '">' + text + '</span>';
  }

  /**
   * P66.renderConvergenceHTML(result) -> compact HTML string (node-safe).
   * Summary one-liner plus one row per region: plain-words zone name,
   * verdict badge, before -> after trim numbers (blue = lean / adding
   * fuel, red = rich / removing fuel), and the plain-English detail.
   */
  function renderConvergenceHTML(result) {
    result = result || {};
    var regions = Array.isArray(result.regions) ? result.regions : [];
    var s = result.summary || { total: regions.length, converged: 0, notConverged: 0, inconclusive: 0, text: '' };

    var html = '<div class="p66-conv" style="font-size:13px;line-height:1.45;">';
    html += '<div style="font-weight:700;margin-bottom:4px;">Did the last patch work?</div>';
    if (result.available === false) {
      html += '<div style="opacity:0.8;margin-bottom:8px;">' +
        escHtml(result.reason || 'No fuel-trim data to compare.') + '</div>';
    } else {
      html += '<div style="margin-bottom:8px;">' + escHtml(s.text || '') + '</div>';
    }
    if (!regions.length) {
      html += '<div style="opacity:0.75;">No patched zones to show.</div>';
    }
    regions.forEach(function (r) {
      html += '<div style="border-top:1px solid rgba(128,128,128,0.25);padding:6px 0;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">';
      html += '<span style="font-weight:600;">' + escHtml(r.region || r.table || 'zone') + '</span>';
      html += verdictBadge(r.verdict);
      html += '</div>';
      var b = r.before, a = r.after;
      if (b && a) {
        html += '<div style="margin-top:2px;">Trims: ' +
          trimSpan(b.avgTrim) + ' &rarr; ' + trimSpan(a.avgTrim) +
          ' <span style="opacity:0.65;font-size:12px;">(' + (a.samples || 0) +
          ' after-log samples)</span></div>';
      } else if (r.patchCount) {
        var move = r.netDeltaPct !== null ? 'net ' + fmtSignedPct(r.netDeltaPct)
          : (r.netDeltaDeg !== null ? 'net ' + (r.netDeltaDeg > 0 ? '+' : '') + r.netDeltaDeg + '°' : '');
        html += '<div style="margin-top:2px;opacity:0.75;font-size:12px;">' +
          r.patchCount + ' patch' + (r.patchCount === 1 ? '' : 'es') +
          (move ? ' (' + escHtml(move) + ')' : '') + '</div>';
      }
      if (r.detail) {
        html += '<div style="opacity:0.85;margin-top:2px;">' + escHtml(r.detail) + '</div>';
      }
      html += '</div>';
    });
    html += '<div style="margin-top:8px;font-size:11px;opacity:0.65;">' +
      'Trim numbers: <span style="color:' + TRIM_LEAN_COLOR + ';font-weight:600;">blue = lean (ECU adding fuel)</span>, ' +
      '<span style="color:' + TRIM_RICH_COLOR + ';font-weight:600;">red = rich (ECU removing fuel)</span>, 0% = stoich. Narrowband only.</div>';
    html += '</div>';
    return html;
  }

  P66.checkConvergence = checkConvergence;
  P66.renderConvergenceHTML = renderConvergenceHTML;
  P66.CONVERGENCE_MARGIN_PCT = CONVERGE_MARGIN_PCT;
  P66.CONVERGENCE_MIN_SAMPLES = AFTER_MIN_SAMPLES;
})(typeof window !== 'undefined' ? window : global);
