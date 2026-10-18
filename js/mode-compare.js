/* P66-Tuner suggestion-mode compare
 * Compares what each confidence mode (conservative / balanced / aggressive)
 * would suggest for the same session report, side by side, BEFORE the user
 * picks a mode. Pure analysis: runs the real tuner entry point once per
 * mode and aggregates the results. Applies nothing, touches no ledger,
 * records nothing. Informational only — suggestions are guidance only,
 * always verify manually before flashing.
 *
 *   P66.compareModes(report, tunerOpts)
 *     tunerOpts: { catalog } — optional XDF catalog, passed straight through
 *       to P66.generateSuggestions (defaults inside the tuner to the bundled
 *       P66 definitions when omitted, same as the rest of the app).
 *     -> { modes: { conservative: {...}, balanced: {...}, aggressive: {...} } }
 *   P66.compareModesRecommendation(comp) -> plain-English string
 *   P66.renderModeCompareHTML(comp) -> HTML string, DOM-free (node-testable)
 *
 * Works in browser and node. No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var MODE_ORDER = ['conservative', 'balanced', 'aggressive'];
  var KIND_ROWS = ['fuel', 'spark', 'trans', 'ae', 'pe'];
  var KIND_LABELS = {
    fuel: 'Fuel (VE)',
    spark: 'Timing',
    trans: 'Transmission',
    ae: 'Tip-in AE',
    pe: 'Full-throttle PE'
  };

  /**
   * Bucket the tuner's fine-grained suggestion kinds into the five display
   * rows: fuel, spark, trans (trans-firmness/kickdown/hunting/tcc), ae,
   * pe (pe + pe-entry). Anything unrecognized lands in 'other' and is
   * counted in the totals only.
   */
  function bucketOf(kind) {
    if (kind === 'fuel') return 'fuel';
    if (kind === 'spark') return 'spark';
    if (kind === 'ae') return 'ae';
    if (kind === 'pe' || kind === 'pe-entry') return 'pe';
    if (kind && String(kind).indexOf('trans') === 0) return 'trans';
    return 'other';
  }

  function magnitude(s) {
    var m = 0;
    if (isFinite(s.deltaPct)) m = Math.max(m, Math.abs(s.deltaPct));
    if (isFinite(s.deltaDeg)) m = Math.max(m, Math.abs(s.deltaDeg));
    return m;
  }

  function deltaUnit(s) {
    if (isFinite(s.deltaPct)) return '%';
    if (isFinite(s.deltaDeg)) return '°';
    return '';
  }

  function isActionable(s) {
    return s.action !== 'none';
  }

  /**
   * Aggregate one mode's tuner result into counts and max deltas per kind.
   */
  function summarizeMode(result, mode) {
    var byKind = {};
    KIND_ROWS.forEach(function (k) {
      byKind[k] = { total: 0, actionable: 0, blocked: 0, maxDeltaMag: 0, maxDeltaSigned: 0, unit: k === 'spark' ? '°' : '%' };
    });

    (result.suggestions || []).forEach(function (s) {
      var b = bucketOf(s.kind);
      if (!byKind[b]) return;
      var row = byKind[b];
      row.total++;
      var act = isActionable(s);
      if (act) row.actionable++; else row.blocked++;
      if (act) {
        // Keep the signed delta of the largest-|magnitude| suggestion so the
        // fuel-color convention (blue=add/lean, red=remove/rich) stays honest.
        var mag = magnitude(s);
        if (mag > row.maxDeltaMag) {
          row.maxDeltaMag = mag;
          row.maxDeltaSigned = isFinite(s.deltaPct) ? s.deltaPct : (isFinite(s.deltaDeg) ? s.deltaDeg : 0);
          row.unit = deltaUnit(s) || row.unit;
        }
      }
    });

    var plainEnglish = null;
    if (typeof P66.summarizeTune === 'function') {
      plainEnglish = P66.summarizeTune(result.actionable || [], []);
    }

    return {
      mode: mode,
      gates: result.gates || null,
      summary: result.summary || '',
      totalSuggestions: (result.suggestions || []).length,
      totalActionable: (result.actionable || []).length,
      totalBlocked: (result.blocked || []).length,
      byKind: byKind,
      plainEnglish: plainEnglish,
      result: result
    };
  }

  /**
   * Run the real tuner suggestion logic once per mode and aggregate.
   * Read-only: P66.generateSuggestions builds suggestion objects from the
   * report; it never applies patches, never touches the ledger, and never
   * records anything. This function adds no writes of its own.
   */
  function compareModes(report, tunerOpts) {
    var opts = tunerOpts || {};
    var modes = {};
    MODE_ORDER.forEach(function (mode) {
      var result = P66.generateSuggestions(report, mode, opts.catalog);
      modes[mode] = summarizeMode(result, mode);
    });
    return { modes: modes };
  }

  function extremes(comp) {
    var least = null, most = null;
    MODE_ORDER.forEach(function (mode) {
      var n = comp.modes[mode].totalActionable;
      if (least === null || n < comp.modes[least].totalActionable) least = mode;
      if (most === null || n > comp.modes[most].totalActionable) most = mode;
    });
    return { least: least, most: most };
  }

  function differingKinds(comp) {
    var out = [];
    KIND_ROWS.forEach(function (k) {
      var counts = MODE_ORDER.map(function (m) { return comp.modes[m].byKind[k].actionable; });
      var deltas = MODE_ORDER.map(function (m) { return comp.modes[m].byKind[k].maxDeltaSigned; });
      var same = counts.every(function (c) { return c === counts[0]; }) &&
                 deltas.every(function (d) { return d === deltas[0]; });
      if (!same) out.push(k);
    });
    return out;
  }

  /**
   * Plain-English recommendation: which mode changes least/most, where the
   * modes disagree, and the safety note (comparison is informational).
   */
  function compareModesRecommendation(comp) {
    var e = extremes(comp);
    var leastN = comp.modes[e.least].totalActionable;
    var mostN = comp.modes[e.most].totalActionable;
    var line;
    if (leastN === mostN) {
      line = leastN === 0
        ? 'All three modes agree: no changes suggested. Nothing to flash.'
        : 'All three modes agree (' + leastN + ' actionable suggestion' + (leastN === 1 ? '' : 's') +
          ' each) — the mode choice would not change this tune.';
    } else {
      line = cap(e.least) + ' changes the least (' + leastN + ' actionable suggestion' +
        (leastN === 1 ? '' : 's') + '); ' + cap(e.most) + ' changes the most (' + mostN + ').';
      var diff = differingKinds(comp);
      if (diff.length) {
        line += ' The modes mainly disagree on ' +
          diff.map(function (k) { return KIND_LABELS[k].toLowerCase(); }).join(', ') + '.';
      }
    }
    return line + ' This comparison is informational only — it never applies a tune. ' +
      'Pick a mode, then review the suggestions and verify before flashing.';
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Fuel-color convention (matches the rest of the app):
   * blue = add fuel / lean (positive delta), red = remove fuel / rich
   * (negative delta). Reuses the app's trimColor when present, else the
   * identical local mapping.
   */
  function trimColor(t) {
    if (typeof P66._trimColor === 'function') return P66._trimColor(t);
    var c = Math.max(-10, Math.min(10, t)) / 10;
    var k = Math.abs(c);
    var neutral = [38, 48, 62];
    var mid = c >= 0 ? [80, 200, 255] : [255, 171, 64];
    var hi = c >= 0 ? [56, 120, 255] : [255, 77, 60];
    var a, b, f;
    if (k <= 0.5) { a = neutral; b = mid; f = k / 0.5; }
    else { a = mid; b = hi; f = (k - 0.5) / 0.5; }
    var rgb = a.map(function (v, i) { return Math.round(v + (b[i] - v) * f); });
    return 'rgb(' + rgb.join(',') + ')';
  }

  /**
   * Render the three-mode comparison as an HTML string (DOM-free, safe to
   * inject or test in node). Columns: one per mode. Rows: per kind with
   * counts and max deltas; cells where the modes disagree get the
   * `mc-diff` highlight class.
   */
  function renderModeCompareHTML(comp) {
    var diff = differingKinds(comp);
    var rec = compareModesRecommendation(comp);

    var html = '<div class="mc-wrap">' +
      '<div class="mc-recommendation">' + esc(rec) + '</div>' +
      '<table class="mc-table"><thead><tr><th class="mc-kind"></th>';

    MODE_ORDER.forEach(function (mode) {
      var entry = comp.modes[mode];
      var gates = entry.gates || {};
      var caps = 'fuel ±' + (gates.maxFuelDeltaPct || '?') + '% · spark ±' +
        (gates.maxSparkDeltaDeg || '?') + '° · trans ±' + (gates.maxTransDeltaPct || '?') + '%';
      var headline = entry.plainEnglish && entry.plainEnglish.headline
        ? '<div class="mc-headline">' + esc(entry.plainEnglish.headline) + '</div>'
        : '';
      html += '<th class="mc-mode mc-mode-' + mode + '"><div class="mc-mode-name">' + cap(mode) +
        '</div><div class="mc-caps">' + esc(caps) + '</div>' +
        '<div class="mc-total">' + entry.totalActionable + ' actionable' +
        (entry.totalBlocked ? ' · ' + entry.totalBlocked + ' held back' : '') +
        '</div>' + headline + '</th>';
    });
    html += '</tr></thead><tbody>';

    KIND_ROWS.forEach(function (k) {
      html += '<tr><th class="mc-kind">' + esc(KIND_LABELS[k]) + '</th>';
      MODE_ORDER.forEach(function (mode) {
        var row = comp.modes[mode].byKind[k];
        var isDiff = diff.indexOf(k) !== -1;
        var cls = 'mc-cell mc-cell-' + k + (isDiff ? ' mc-diff' : '');
        var deltaHtml;
        if (row.actionable > 0 && row.maxDeltaMag > 0) {
          var sd = row.maxDeltaSigned;
          var sdText = (sd < 0 ? '-' : '+') + row.maxDeltaMag + row.unit;
          deltaHtml = ' · max <span class="mc-delta" style="background:' +
            trimColor(Math.max(-10, Math.min(10, sd))) + '">' + esc(sdText) + '</span>';
        } else if (row.actionable > 0) {
          deltaHtml = ' · max 0' + row.unit;
        } else {
          deltaHtml = '';
        }
        var label = row.actionable === 0 ? '—' : String(row.actionable);
        html += '<td class="' + cls + '">' + esc(label) + deltaHtml + '</td>';
      });
      html += '</tr>';
    });

    // Plain-English bullets per mode (first few; the full list stays in comp).
    html += '</tbody></table>';
    var bullets = '';
    MODE_ORDER.forEach(function (mode) {
      var entry = comp.modes[mode];
      var list = entry.plainEnglish && entry.plainEnglish.bullets;
      if (!list || !list.length) {
        bullets += '<div class="mc-bullets mc-mode-' + mode + '"><strong>' + cap(mode) +
          ':</strong> <span class="muted">No suggestions in this mode.</span></div>';
        return;
      }
      bullets += '<div class="mc-bullets mc-mode-' + mode + '"><strong>' + cap(mode) +
        ':</strong><ul>' +
        list.slice(0, 3).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') +
        (list.length > 3 ? '<li class="muted">…and ' + (list.length - 3) + ' more.</li>' : '') +
        '</ul></div>';
    });

    return html + bullets + '</div>';
  }

  P66.compareModes = compareModes;
  P66.compareModesRecommendation = compareModesRecommendation;
  P66.renderModeCompareHTML = renderModeCompareHTML;
})(typeof window !== 'undefined' ? window : global);
