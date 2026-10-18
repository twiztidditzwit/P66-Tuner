/* P66 playback event ticks.
 *
 * Computes discrete events from a parsed log — knock retard events,
 * throttle tip-in stabs, and power-enrichment (WOT) episodes — and renders
 * them as a compact tick strip that sits under the playback HUD timeline.
 * Clicking a tick seeks the playback controller to that event; the tick
 * nearest at/below the current frame highlights while the log plays.
 *
 * Analyzer shapes (see js/analyzer.js):
 *   analyzeKnock   -> { available, events: [{startIdx, peakKR, rpm, ...}] }
 *   analyzeTipIn   -> { available, events: <count>,
 *                       eventsDetail: [{index, dtps, leanSpike, cold}] }
 *   analyzePeEntry -> { available, episodes: <count>, ... }  (counts only;
 *                       episode start indices are re-derived locally with
 *                       the same TPS >= 60% / 7-sample-sustained grouping)
 *
 * Every analyzer is optional: missing functions, {available:false}, empty
 * results, or thrown errors are tolerated silently — that type is skipped,
 * never fatal.
 *
 * Timestamps follow the playback convention: the log's TIME column via
 * P66.pbBuildTimes (js/playback.js), falling back to row-index timing when
 * the TIME column is missing or mostly non-numeric.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  var EV_TYPES = ['knock', 'tipin', 'pe'];
  var EV_NAMES = { knock: 'Knock', tipin: 'Tip-in', pe: 'PE' };

  // Mirror the episode grouping in analyzePeEntry (js/analyzer.js).
  var PE_TPS_MIN = 60;      // % TPS that counts as high throttle
  var PE_EPISODE_MIN = 7;   // sustained samples for a WOT episode
  var PE_LAMBDA_MAX = 0.95; // commanded lambda below this = PE active
  var PE_SAMPLE_SEC = 0.145; // nominal ALDL sample interval

  function evNum(v) {
    if (v === null || v === undefined) return null;
    var n = (typeof v === 'number') ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /**
   * Build the per-row timestamp array, following the playback convention.
   * Uses P66.pbBuildTimes when available (js/playback.js); otherwise falls
   * back to row-index timing. Returns { times, indexed }.
   * rows: a log table or a legacy array of row objects.
   */
  function eventTimes(rows, mapResult) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var timeCol = (typeof P66.columnFor === 'function')
      ? P66.columnFor(mapResult, 'TIME') : null;
    if (typeof P66.pbBuildTimes === 'function') {
      var tb = P66.pbBuildTimes(t, timeCol);
      return { times: tb.times, indexed: tb.indexed };
    }
    var times = new Array(n);
    var tc = P66.numView(t, timeCol);
    if (tc) {
      var ok = 0;
      for (var i = 0; i < n; i++) {
        var tv = tc[i];
        times[i] = (tv === tv) ? tv : NaN;
        if (tv === tv) ok++;
      }
      if (ok >= n * 0.9) {
        var last = times[0];
        for (var k = 0; k < times.length; k++) {
          if (times[k] === times[k]) last = times[k];
          else times[k] = last;
        }
        return { times: times, indexed: false };
      }
    }
    for (var j = 0; j < n; j++) times[j] = j;
    return { times: times, indexed: true };
  }

  /**
   * Guard an analyzer call: returns the result object, or null when the
   * analyzer is missing, reports unavailable, or throws.
   */
  function tryAnalyzer(name, rows, mapResult) {
    if (typeof P66[name] !== 'function') return null;
    try {
      var res = P66[name](rows, mapResult);
      if (!res || res.available === false) return null;
      return res;
    } catch (e) {
      return null;
    }
  }

  function knockEventsOf(res) {
    var out = [];
    var list = res && res.events;
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var idx = evNum(e.startIdx);
      if (idx === null) continue;
      var parts = ['Knock'];
      if (e.peakKR !== null && e.peakKR !== undefined) parts.push(e.peakKR + ' deg');
      if (e.rpm !== null && e.rpm !== undefined) parts.push(Math.round(e.rpm) + ' RPM');
      if (e.tipOut) parts.push('tip-out');
      else if (e.suspectNoise) parts.push('suspect noise');
      out.push({ index: Math.round(idx), type: 'knock', label: parts.join(' · ') });
    }
    return out;
  }

  function tipInEventsOf(res) {
    var out = [];
    var list = res && res.eventsDetail;
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var idx = evNum(e.index);
      if (idx === null) continue;
      var parts = ['Tip-in'];
      if (e.dtps !== null && e.dtps !== undefined) parts.push('+' + e.dtps + '% TPS');
      if (e.leanSpike) parts.push('lean O2 dip');
      if (e.cold) parts.push('cold');
      out.push({ index: Math.round(idx), type: 'tipin', label: parts.join(' · ') });
    }
    return out;
  }

  /**
   * Re-derive WOT episode starts (analyzePeEntry returns counts only).
   * Groups consecutive TPS >= PE_TPS_MIN samples; episodes shorter than
   * PE_EPISODE_MIN samples are dropped. For each episode, records the PE
   * engagement delay in samples (null when PE never engaged).
   * Returns [{ startIdx, peDelaySamples }].
   * rows: a log table or a legacy array of row objects.
   */
  function peEpisodeIndices(rows, mapResult) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    var tpsC = (typeof P66.columnFor === 'function')
      ? P66.numView(t, P66.columnFor(mapResult, 'TPS')) : null;
    var cmdC = (typeof P66.columnFor === 'function')
      ? P66.numView(t, P66.columnFor(mapResult, 'CMD_LAMBDA')) : null;
    if (!tpsC || !cmdC) return [];
    function toLambda(v) {
      if (v === null || v === undefined || v !== v) return null;
      if (typeof P66.toLambda === 'function') return P66.toLambda(v);
      if (v > 5) return v / 14.7;
      if (v > 0.3 && v < 2.5) return v;
      return null;
    }
    var episodes = [];
    var startIdx = -1, samples = 0;
    function close() {
      if (startIdx >= 0 && samples >= PE_EPISODE_MIN) {
        var peAt = null;
        for (var j = startIdx; j < startIdx + samples && j < n; j++) {
          var lambda = toLambda(cmdC[j]);
          if (lambda !== null && lambda < PE_LAMBDA_MAX) { peAt = j; break; }
        }
        episodes.push({
          startIdx: startIdx,
          peDelaySamples: peAt === null ? null : peAt - startIdx
        });
      }
      startIdx = -1;
      samples = 0;
    }
    for (var i = 0; i < n; i++) {
      var tps = tpsC[i];
      if (tps === tps && tps >= PE_TPS_MIN) {
        if (startIdx < 0) { startIdx = i; samples = 0; }
        samples++;
      } else {
        close();
      }
    }
    close();
    return episodes;
  }

  function peEventsOf(episodes) {
    var out = [];
    for (var i = 0; i < episodes.length; i++) {
      var ep = episodes[i];
      var delay = ep.peDelaySamples;
      var label = 'WOT episode · ' +
        (delay === null ? 'no PE' : 'PE +' + (delay * PE_SAMPLE_SEC).toFixed(1) + 's');
      out.push({ index: ep.startIdx, type: 'pe', label: label });
    }
    return out;
  }

  /**
   * Compute playback events from the three analyzers.
   * parsedLog: a log table, a legacy { rows: [...] } parsed shape, or a
   * legacy row-object array.
   * Returns [{ index, time, type, label }] sorted by index, then type.
   * Missing/unusable analyzers are skipped silently.
   */
  function computePlaybackEvents(parsedLog, mapResult) {
    var t = P66.asTable(parsedLog);
    if (!t || !t.rowCount) return [];
    var tb = eventTimes(t, mapResult);

    var events = [];
    var kr = tryAnalyzer('analyzeKnock', t, mapResult);
    if (kr) events = events.concat(knockEventsOf(kr));
    var ti = tryAnalyzer('analyzeTipIn', t, mapResult);
    if (ti) events = events.concat(tipInEventsOf(ti));
    var pe = tryAnalyzer('analyzePeEntry', t, mapResult);
    if (pe) events = events.concat(peEventsOf(peEpisodeIndices(t, mapResult)));

    var n = t.rowCount;
    events.forEach(function (ev) {
      ev.index = Math.max(0, Math.min(n - 1, ev.index));
      ev.time = tb.times[ev.index];
    });

    var order = { knock: 0, tipin: 1, pe: 2 };
    events.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index;
      return (order[a.type] || 0) - (order[b.type] || 0);
    });
    return events;
  }

  /**
   * Pure tick-position math: percent across the strip for a timestamp.
   */
  function eventTickPct(time, tMin, tMax) {
    if (!(tMax > tMin) || !isFinite(time)) return 0;
    var p = 100 * (time - tMin) / (tMax - tMin);
    return Math.max(0, Math.min(100, p));
  }

  /**
   * The event nearest at/below a frame index (events sorted by index).
   * Returns the event object or null.
   */
  function nearestEventAtOrBelow(events, frameIndex) {
    if (!events || !events.length) return null;
    var best = null;
    for (var i = 0; i < events.length; i++) {
      if (events[i].index <= frameIndex) best = events[i];
      else break;
    }
    return best;
  }

  /**
   * Item 11: knock event drill-down modal. drill = { table, mapResult, krScale }.
   * Shows a zoomed ±50-sample window (RPM, MAP, KR, spark, TPS) around the tick.
   */
  function openKnockDrilldown(ev, drill) {
    if (typeof P66.knockEventWindow !== 'function' || typeof P66.renderKnockDrilldownHTML !== 'function') return;
    var win;
    try {
      win = P66.knockEventWindow(drill.table, drill.mapResult, ev.index, 50, drill.krScale || 1);
    } catch (e) { return; }
    var overlay = document.createElement('div');
    overlay.className = 'p66-modal-overlay';
    overlay.innerHTML =
      '<div class="p66-modal" role="dialog" aria-label="Knock event drill-down">' +
      '<button type="button" class="p66-modal-close" aria-label="Close">×</button>' +
      '<div class="p66-modal-body"></div></div>';
    overlay.querySelector('.p66-modal-body').innerHTML = P66.renderKnockDrilldownHTML(win);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.querySelector('.p66-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  /**
   * Render the event tick strip into container, wired to a playback
   * controller (from P66.createPlaybackController / P66.renderPlayback).
   * Re-rendering clears the previous strip and unsubscribes it.
   * Returns the controller (or null when nothing could render).
   */
  function renderEventTicks(container, controller, events, drill) {
    if (typeof document === 'undefined') return null;
    if (!container) return null;
    if (container._evUnsub) { container._evUnsub(); container._evUnsub = null; }
    container.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'p66-event-ticks';

    var list = (events || []).slice().sort(function (a, b) { return a.index - b.index; });
    if (!list.length || !controller) {
      var empty = document.createElement('div');
      empty.className = 'p66-events-empty';
      empty.textContent = list.length
        ? 'Event ticks need a playback controller.'
        : 'No events found in this log.';
      wrap.appendChild(empty);
      container.appendChild(wrap);
      return controller || null;
    }

    var counts = { knock: 0, tipin: 0, pe: 0 };
    list.forEach(function (ev) { if (counts[ev.type] !== undefined) counts[ev.type]++; });

    var legend = document.createElement('div');
    legend.className = 'p66-events-legend';
    EV_TYPES.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'p66-events-chip ev-' + t;
      var dot = document.createElement('span');
      dot.className = 'p66-events-dot';
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(EV_NAMES[t] + ' (' + counts[t] + ')'));
      legend.appendChild(chip);
    });
    wrap.appendChild(legend);

    var strip = document.createElement('div');
    strip.className = 'p66-events-strip';
    var tMin = controller.tMin, tMax = controller.tMax;
    var ticks = list.map(function (ev) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p66-event-tick ev-' + ev.type;
      b.style.left = eventTickPct(ev.time, tMin, tMax) + '%';
      b.title = ev.label;
      b.setAttribute('aria-label', ev.label);
      b.addEventListener('click', function () {
        controller.seek(ev.index);
        // Item 11: knock ticks also open the drill-down window.
        if (ev.type === 'knock' && drill && typeof P66.knockEventWindow === 'function') {
          openKnockDrilldown(ev, drill);
        }
      });
      strip.appendChild(b);
      return { el: b, ev: ev };
    });
    wrap.appendChild(strip);
    container.appendChild(wrap);

    function highlight(idx) {
      var near = nearestEventAtOrBelow(list, idx);
      for (var i = 0; i < ticks.length; i++) {
        ticks[i].el.classList.toggle('active', near !== null && ticks[i].ev === near);
      }
    }
    var unsub = controller.onFrame(function (idx) { highlight(idx); });
    container._evUnsub = unsub;
    highlight(controller.getIndex());
    return controller;
  }

  P66.peEpisodeIndices = peEpisodeIndices;
  P66.eventTickPct = eventTickPct;
  P66.nearestEventAtOrBelow = nearestEventAtOrBelow;
  P66.computePlaybackEvents = computePlaybackEvents;
  P66.renderEventTicks = renderEventTicks;
})(typeof window !== 'undefined' ? window : global);
