/* P66-Tuner patch impact preview (read-only guardrail projection)
 *
 * READ-ONLY CONTRACT: this module never writes. It does not record to a
 * ledger, does not touch localStorage, and does not mutate the patch
 * objects it is given. It reads recorded history through
 * ledger.history(fingerprint), does every calculation in local variables,
 * and returns fresh objects. Running the preview changes nothing about
 * what the app will allow or record.
 *
 * The guardrail numbers are NOT copied here. They are read live from
 * js/ledger.js via P66.LEDGER_LIMITS, so a guardrail change in the ledger
 * is picked up automatically. If the ledger module is not loaded, this
 * module refuses to run rather than guessing the numbers.
 *
 * Kind semantics mirror js/ledger.js exactly:
 *   - spark:  patches carrying deltaDeg (degrees, additive)
 *   - trans:  tables named like "line pressure", "upshift", "downshift"
 *             (percent, compounding multiplicatively like fuel)
 *   - fuel:   everything else (VE tables, PE, AE — percent, compounding)
 *   - TCC:    report-only; xdf-map never emits TCC patches, and if one
 *             somehow arrives here it is dropped from the preview.
 *
 * Power-enrichment AFR patches (table 'Power Enrichment Target AFR') carry
 * deltaAfrPct instead of deltaPct. The ledger's stored history only records
 * deltaPct/deltaDeg, so for projection the preview uses each patch's own
 * magnitude (deltaPct, falling back to deltaAfrPct) as the session impact.
 * The guardrail for PE cells follows the ledger's /pe/i rule (pePct).
 *
 * API:
 *   P66.previewPatchImpact(patches, ledgerState) -> impact
 *     patches: [{ table, addressHex, deltaPct | deltaAfrPct | deltaDeg,
 *                 oldValue, newValue, ... }]  (xdf-map patch objects)
 *     ledgerState: null, or { fingerprint, ledger } (a P66.createLedger()
 *       instance — history() and check() are read-only), or
 *       { fingerprint, entries } (raw recorded entries, same shape as
 *       ledger.history() returns)
 *   P66.renderPatchPreviewHTML(impact) -> string (no DOM, plain string)
 *
 * Wiring (for the coordinator; coordinator wires the UI):
 *   var patches = xdfResult.patches;              // from js/xdf-map.js
 *   var impact  = P66.previewPatchImpact(patches, { fingerprint: binSha256, ledger: P66.createLedger() });
 *   showBeforeApplyButton(P66.renderPatchPreviewHTML(impact));
 *
 * This preview is informational. It never implies the patch set is safe
 * to flash — it only estimates where the set lands against the ledger's
 * multi-session guardrails.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Flag threshold: warn once a group would use this fraction of a guardrail.
  var WARN_FRACTION = 0.8;

  /** Guardrails, read live from the ledger module — never copied. */
  function ledgerLimits() {
    var L = P66.LEDGER_LIMITS;
    if (!L || typeof L.fuelPct !== 'number' || typeof L.sparkDeg !== 'number' ||
        typeof L.pePct !== 'number' || typeof L.transPct !== 'number') {
      throw new Error('P66.patch-preview requires js/ledger.js (P66.LEDGER_LIMITS) to be loaded first.');
    }
    return L;
  }

  // ---- patch-kind semantics, mirroring js/ledger.js -------------------

  function isSparkPatch(p) {
    return p.deltaDeg !== undefined && p.deltaDeg !== null;
  }

  function isTransPatch(p) {
    return /line pressure|upshift|downshift/i.test(p.table || '');
  }

  function isTccPatch(p) {
    return /tcc/i.test(p.table || '');
  }

  /** Effective percent magnitude for a non-spark patch. */
  function pctOf(p) {
    if (p.deltaPct !== undefined && p.deltaPct !== null) return p.deltaPct;
    if (p.deltaAfrPct !== undefined && p.deltaAfrPct !== null) return p.deltaAfrPct;
    return 0;
  }

  /** 'fuel' | 'spark' | 'trans', or null for TCC (dropped). */
  function groupOf(p) {
    if (isTccPatch(p)) return null;
    if (isSparkPatch(p)) return 'spark';
    if (isTransPatch(p)) return 'trans';
    return 'fuel';
  }

  function guardrailFor(kind, table, L) {
    if (kind === 'spark') return { limit: L.sparkDeg, unit: '°' };
    if (kind === 'trans') return { limit: L.transPct, unit: '%' };
    return /pe/i.test(table || '')
      ? { limit: L.pePct, unit: '%' }
      : { limit: L.fuelPct, unit: '%' };
  }

  function patchKey(p) {
    return (p.table || '?') + '@' + (p.addressHex || ('0x' + (p.address || 0).toString(16).toUpperCase()));
  }

  function fmtSigned(n, unit) {
    return (n > 0 ? '+' : '') + n + unit;
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- read-only projection -------------------------------------------

  /**
   * Project where a patch set would land against the ledger guardrails.
   * Does not touch the ledger (no record(), no state changes) and does
   * not mutate the patch objects.
   */
  function previewPatchImpact(patches, ledgerState) {
    var L = ledgerLimits();
    patches = Array.isArray(patches) ? patches : [];
    var st = ledgerState || {};
    var fingerprint = st.fingerprint || null;
    var ledger = st.ledger || null;
    var entries = [];
    if (Array.isArray(st.entries)) {
      entries = st.entries;
    } else if (ledger && fingerprint && typeof ledger.history === 'function') {
      entries = ledger.history(fingerprint) || [];
    }

    // Group. TCC "patches" are dropped, never shown.
    var byGroup = { fuel: [], spark: [], trans: [] };
    var realPatches = []; // the set the app would actually check at apply time
    var tccExcluded = 0;
    patches.forEach(function (p) {
      if (!p) return;
      var g = groupOf(p);
      if (!g) { tccExcluded++; return; }
      byGroup[g].push(p);
      realPatches.push(p);
    });

    // Authoritative blocked set: ledger.check() is read-only and is the
    // same call the app uses at apply time, so "blocked" here means the
    // ledger would flag the set at apply time.
    var blockedKeys = {};
    if (ledger && fingerprint && typeof ledger.check === 'function') {
      try {
        ledger.check(fingerprint, realPatches).forEach(function (w) { blockedKeys[w.key] = w; });
      } catch (e) { /* fall through to the projection rule below */ }
    }

    // Per-cell projection: history deltas (what the ledger recorded —
    // deltaPct/deltaDeg only) plus the new patches' effective magnitudes.
    var cells = {}; // key -> { table, addressHex, kind, factor, degrees }
    function ensure(table, addressHex, kind) {
      var k = table + '@' + addressHex;
      if (!cells[k]) {
        cells[k] = { table: table, addressHex: addressHex, kind: kind, factor: 1, degrees: 0 };
      }
      return cells[k];
    }
    entries.forEach(function (e) {
      (e.deltas || []).forEach(function (d) {
        var kind = (d.deltaDeg !== undefined && d.deltaDeg !== null)
          ? 'spark'
          : (/line pressure|upshift|downshift/i.test(d.table || '') ? 'trans' : 'fuel');
        var c = ensure(d.table || '?', d.addressHex || '?', kind);
        if (kind === 'spark') c.degrees += (d.deltaDeg || 0);
        else c.factor *= (1 + (d.deltaPct || 0) / 100);
      });
    });
    patches.forEach(function (p) {
      if (!p || !groupOf(p)) return;
      var kind = groupOf(p);
      var c = ensure(p.table || '?', p.addressHex || ('0x' + (p.address || 0).toString(16).toUpperCase()), kind);
      if (kind === 'spark') c.degrees += (p.deltaDeg || 0);
      else c.factor *= (1 + pctOf(p) / 100);
    });

    var projected = {}; // key -> { table, addressHex, kind, cumulative, unit }
    Object.keys(cells).forEach(function (k) {
      var c = cells[k];
      var gr = guardrailFor(c.kind, c.table, L);
      projected[k] = {
        table: c.table, addressHex: c.addressHex, kind: c.kind,
        cumulative: c.kind === 'spark'
          ? Math.round(c.degrees * 100) / 100
          : Math.round((c.factor - 1) * 10000) / 100,
        limit: gr.limit, unit: gr.unit
      };
    });

    var GROUP_DEF = {
      fuel:  { title: 'Fuel',       guardrail: L.fuelPct,  unit: '%' },
      spark: { title: 'Spark',      guardrail: L.sparkDeg, unit: '°' },
      trans: { title: 'Transmission', guardrail: L.transPct, unit: '%' }
    };

    var groups = {};
    var flags = {};
    ['fuel', 'spark', 'trans'].forEach(function (g) {
      var def = GROUP_DEF[g];
      var ps = byGroup[g];
      var count = ps.length;
      var maxDelta = 0;
      var factor = 1;
      var degSum = 0;
      var tableCounts = {};
      ps.forEach(function (p) {
        var m = g === 'spark' ? (p.deltaDeg || 0) : pctOf(p);
        if (Math.abs(m) > Math.abs(maxDelta)) maxDelta = m;
        if (g === 'spark') degSum += (p.deltaDeg || 0);
        else factor *= (1 + pctOf(p) / 100);
        var t = p.table || '?';
        tableCounts[t] = (tableCounts[t] || 0) + 1;
      });
      var sessionTotal = g === 'spark'
        ? Math.round(degSum * 100) / 100
        : Math.round((factor - 1) * 10000) / 100;
      // Representative table: the one most patches touch.
      var repTable = null, repCount = 0;
      Object.keys(tableCounts).forEach(function (t) {
        if (tableCounts[t] > repCount) { repCount = tableCounts[t]; repTable = t; }
      });
      // Worst projected cell in this group.
      var worst = null;
      Object.keys(projected).forEach(function (k) {
        var pc = projected[k];
        if (pc.kind !== g) return;
        if (!worst || Math.abs(pc.cumulative) > Math.abs(worst.cumulative)) worst = pc;
      });
      var flag = 'ok';
      Object.keys(projected).forEach(function (k) {
        var pc = projected[k];
        if (pc.kind !== g) return;
        if (blockedKeys[k]) { flag = 'blocked'; return; }
        if (Math.abs(pc.cumulative) >= pc.limit) { flag = 'blocked'; }
        else if (flag !== 'blocked' && Math.abs(pc.cumulative) >= WARN_FRACTION * pc.limit) { flag = 'warn'; }
      });
      flags[g] = flag;
      groups[g] = {
        key: g,
        title: def.title,
        count: count,
        maxDelta: Math.round(maxDelta * 100) / 100,
        unit: def.unit,
        sessionTotal: sessionTotal,
        guardrail: def.guardrail,
        representativeTable: repTable,
        worstCell: worst,
        usageFraction: worst ? Math.abs(worst.cumulative) / def.guardrail : 0,
        flag: flag,
        oneLiner: buildOneLiner(g, def, ps, sessionTotal, worst, flag, L)
      };
    });

    var blockedCells = Object.keys(blockedKeys).map(function (k) { return blockedKeys[k]; });
    // Fallback blocked set when no ledger was supplied: the projection rule
    // is the same >= limit comparison the ledger uses.
    if (!blockedCells.length && !ledger) {
      Object.keys(projected).forEach(function (k) {
        var pc = projected[k];
        if (Math.abs(pc.cumulative) >= pc.limit) {
          blockedCells.push({ key: k, table: pc.table, addressHex: pc.addressHex, kind: pc.kind, cumulative: pc.cumulative, limit: pc.limit });
        }
      });
    }

    return {
      empty: patches.length === tccExcluded || patches.length === 0,
      groups: groups,
      flags: flags,
      blockedCells: blockedCells,
      tccExcluded: tccExcluded,
      fingerprint: fingerprint,
      readOnly: true,
      note: 'Read-only projection: it estimates where this patch set would land against the ledger\'s multi-session guardrails from recorded history. It never records to the ledger, never implies the result is safe to flash, and it tracks what the app produced — not what is actually in the binary.'
    };
  }

  function buildOneLiner(g, def, ps, sessionTotal, worst, flag, L) {
    if (!ps.length) return 'No ' + def.title.toLowerCase() + ' changes in this patch set.';
    var rep = '';
    var tableCounts = {};
    ps.forEach(function (p) { var t = p.table || '?'; tableCounts[t] = (tableCounts[t] || 0) + 1; });
    var best = null, n = 0;
    Object.keys(tableCounts).forEach(function (t) { if (tableCounts[t] > n) { n = tableCounts[t]; best = t; } });
    rep = best ? ' to ' + best : '';
    var unit = def.unit;
    var session, worstPart;
    if (g === 'fuel') {
      session = sessionTotal >= 0
        ? 'This session adds +' + sessionTotal + '% fuel' + rep + ';'
        : 'This session removes ' + Math.abs(sessionTotal) + '% fuel' + (best ? ' from ' + best : '') + ';';
      worstPart = ' cumulative would be ' + Math.abs(worst ? worst.cumulative : 0) +
        '% of the ±' + def.guardrail + '% limit.';
    } else if (g === 'spark') {
      session = sessionTotal >= 0
        ? 'This session advances timing by +' + sessionTotal + '°' + rep + ';'
        : 'This session retards timing by ' + Math.abs(sessionTotal) + '°' + (best ? ' in ' + best : '') + ';';
      worstPart = ' cumulative would be ' + Math.abs(worst ? worst.cumulative : 0) +
        '° of the ±' + def.guardrail + '° limit.';
    } else {
      session = sessionTotal >= 0
        ? 'This session firms/raises ' + (best || 'transmission tables') + ' by +' + sessionTotal + '%;'
        : 'This session softens/lowers ' + (best || 'transmission tables') + ' by ' + Math.abs(sessionTotal) + '%;';
      worstPart = ' cumulative would be ' + Math.abs(worst ? worst.cumulative : 0) +
        '% of the ±' + def.guardrail + '% limit.';
    }
    var tail = ' Inside the multi-session guardrails.';
    if (flag === 'warn') tail = ' Past 80% of the guardrail — check the log trend before going further.';
    if (flag === 'blocked') tail = ' The ledger would flag this set: one or more cells reach the multi-session limit. Review before applying.';
    return session + worstPart + tail;
  }

  // ---- HTML rendering (dependency-free string building, no DOM) ----------

  var BAR_COLORS = { ok: '#3d8b4f', warn: '#c98a1b', blocked: '#b23b3b' };

  function barHTML(group) {
    var pct = Math.min(100, Math.round(group.usageFraction * 100));
    var color = BAR_COLORS[group.flag] || BAR_COLORS.ok;
    var over = group.usageFraction > 1 ? ' (over)' : '';
    return '<div style="background:#2a2a2a;border-radius:4px;height:12px;overflow:hidden;margin:6px 0;"' +
      ' title="Uses ' + pct + '% of the ±' + group.guardrail + group.unit + ' guardrail' + esc(over) + '">' +
      '<div style="width:' + pct + '%;height:12px;background:' + color + ';"></div></div>';
  }

  function flagBadge(flag) {
    var label = flag === 'blocked' ? 'WOULD BLOCK' : flag === 'warn' ? 'WARNING' : 'OK';
    var color = BAR_COLORS[flag] || BAR_COLORS.ok;
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;' +
      'font-weight:bold;color:#fff;background:' + color + ';">' + label + '</span>';
  }

  /**
   * Render the impact as an HTML string. Pure string building — no DOM,
   * no dependencies, works in node for tests.
   */
  function renderPatchPreviewHTML(impact) {
    var L = ledgerLimits();
    impact = impact || {};
    var groups = impact.groups || {};
    var html = '<div class="p66-patch-preview" style="font-family:inherit;">';
    html += '<p style="font-size:12px;opacity:0.85;">Informational projection only: this estimates where the patch set ' +
      'would land against the ledger\'s multi-session guardrails (fuel ±' + L.fuelPct + '%, spark ±' + L.sparkDeg +
      '°, trans ±' + L.transPct + '%). It never implies the result is safe to flash.</p>';
    if (impact.empty) {
      html += '<p><strong>No patches to preview.</strong> The patch set is empty — nothing would change.</p>';
    }
    ['fuel', 'spark', 'trans'].forEach(function (g) {
      var gr = groups[g];
      if (!gr) return;
      html += '<section class="p66-pp-group" style="margin:12px 0;padding:10px;border:1px solid #444;border-radius:6px;">';
      html += '<h3 style="margin:0 0 4px 0;">' + esc(gr.title) + ' ' + flagBadge(gr.flag) + '</h3>';
      html += barHTML(gr);
      html += '<div style="font-size:12px;">' + gr.count + ' patch(es) · max single change ' +
        fmtSigned(gr.maxDelta, gr.unit) + ' · session total ' + fmtSigned(gr.sessionTotal, gr.unit) +
        ' · guardrail ±' + gr.guardrail + gr.unit + '</div>';
      if (gr.worstCell) {
        html += '<div style="font-size:12px;opacity:0.85;">Hardest-hit cell: ' + esc(gr.worstCell.table) + ' ' +
          esc(gr.worstCell.addressHex) + ' → cumulative ' + fmtSigned(gr.worstCell.cumulative, gr.unit) +
          ' (' + Math.round((gr.usageFraction || 0) * 100) + '% of guardrail)</div>';
      }
      html += '<p style="font-size:13px;margin:8px 0 0 0;">' + esc(gr.oneLiner) + '</p>';
      html += '</section>';
    });
    if (impact.tccExcluded) {
      html += '<p style="font-size:12px;opacity:0.7;">Note: ' + impact.tccExcluded +
        ' TCC item(s) were excluded — TCC is report-only and is never patched.</p>';
    }
    html += '</div>';
    return html;
  }

  P66.previewPatchImpact = previewPatchImpact;
  P66.renderPatchPreviewHTML = renderPatchPreviewHTML;
  P66.PATCH_PREVIEW_WARN_FRACTION = WARN_FRACTION;
})(typeof window !== 'undefined' ? window : global);
