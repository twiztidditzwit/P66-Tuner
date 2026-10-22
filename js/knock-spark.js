/* P66-Tuner knock-based spark learning (cross-session memory)
 *
 * The one-pass tuner (js/tuner.js sparkSuggestions) retards timing from a
 * single session's knock report. This module is the long memory: it looks
 * at the current session's knock report PLUS prior sessions' knock reports
 * (attached to journal entries by the coordinator as entry.report,
 * entry.knockReport, or entry.knock) and suggests a -1 degree pull ONLY
 * where REAL knock repeats in the same Main Spark Advance cell across
 * >= 2 distinct sessions.
 *
 * Rules, in order of strictness:
 *  1. Never from a single session. The pull must be driven by the current
 *     session's data AND confirmed by at least one earlier session.
 *  2. Never from false knock. tipOut (throttle closed mid-event),
 *     suspectNoise (single-sample burst spikes), and transient-region
 *     events (drivetrain noise, not combustion knock) are all excluded —
 *     same trust classification as js/analyzer.js and js/tuner.js.
 *  3. Never past the ledger's cumulative spark guardrail. Cells already at
 *     the guardrail are returned as action 'none' with a reason naming it
 *     (visible, not silently dropped).
 *
 * Cell mapping uses the same nearest-breakpoint convention as tuner.js and
 * js/xdf-map.js (mapPointToTable): Main Spark Advance table, yAxis = RPM
 * breakpoints, xAxis = MAP breakpoints. There is no Idle Spark table — the
 * tuner routes FUEL by idleFraction (Idle VE vs Main VE), but the P66 runs
 * a single spark advance table, so all knock-spark suggestions target it.
 *
 *   P66.suggestKnockSpark(report, journalEntries, ledger, opts)
 *     report:         this session's analysis report, or its .knock report
 *     journalEntries: P66.createJournal().list() entries; each may carry a
 *                     knock report as .report / .knockReport / .knock
 *     ledger:         P66.createLedger() instance (optional)
 *     opts: { catalog, fingerprint|binFingerprint, sessionId|logName,
 *             currentLabel }
 *
 * Returns an array of suggestion objects:
 *   { kind, table, action, deltaDeg, rpmIdx, mapIdx, addressHex, cell,
 *     knockCells, reason, confidence, evidence: { sessions, events: [...] } }
 * The kind/action/deltaDeg/knockCells shape matches what
 * js/xdf-map.js applySparkSuggestions expects, so the output is
 * patcher-compatible.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var SPARK_TABLE_NAME = 'Main Spark Advance';
  var SPARK_TABLE_RE = /main spark/i;
  var PULL_DEG = 1; // exactly one degree per pass, always

  /* Same nearest-breakpoint mapping as tuner.js / xdf-map.js, so the cell
   * an event is learned on is the cell the patcher would retard. */
  function sparkAxes(catalog) {
    if (!catalog || !catalog.tables) return null;
    var t = null;
    catalog.tables.forEach(function (tbl) {
      if (SPARK_TABLE_RE.test(tbl.title || '')) t = tbl;
    });
    if (!t || !t.xAxis || !t.yAxis) return null;
    function bps(axis) {
      var out = [];
      (axis.labels || []).forEach(function (l) {
        var v = parseFloat(l);
        if (isFinite(v)) out.push(v);
      });
      return out;
    }
    var rpmBp = bps(t.yAxis), mapBp = bps(t.xAxis);
    if (!rpmBp.length || !mapBp.length) return null;
    return { rpmBp: rpmBp, mapBp: mapBp, table: t };
  }

  function nearestSparkCell(axes, rpm, map) {
    if (rpm === null || rpm === undefined || map === null || map === undefined) return null;
    function nearest(bp, v) {
      var best = 0, bestD = Math.abs(bp[0] - v);
      for (var i = 1; i < bp.length; i++) {
        var d = Math.abs(bp[i] - v);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    return { row: nearest(axes.rpmBp, rpm), col: nearest(axes.mapBp, map) };
  }

  /* Cell address the same way the spark patcher computes it:
   * base + (row * cols + col) * elementBytes. */
  function cellAddressHex(axes, row, col) {
    var t = axes.table;
    var base = parseInt(t.address, 16);
    if (!isFinite(base)) return null;
    var cols = t.cols || axes.mapBp.length;
    var bits = parseInt(t.elementSizeBits, 10) || 8;
    var eb = Math.max(1, Math.round(bits / 8));
    var addr = base + (row * cols + col) * eb;
    return '0x' + addr.toString(16).toUpperCase();
  }

  /* Real knock = not false-knock-flagged. Mirrors the tuner's trust
   * partition (tipOut / suspectNoise fallbacks included for older report
   * shapes), plus transient-region exclusion: knock seen only while the
   * drivetrain is unsettled reads as false knock there too. */
  function isRealEvent(e) {
    var noise = (e.suspectNoise !== undefined) ? e.suspectNoise : (e.samples || 0) <= 1;
    var tip = (e.tipOut !== undefined) ? e.tipOut
      : (e.tpsDrop !== null && e.tpsDrop !== undefined && e.tpsDrop > 10);
    if (noise || tip) return false;
    if (e.region === 'transient') return false;
    return true;
  }

  /* Pull the knock report out of whatever wrapper we were handed: a bare
   * knock report, a full session report ({ knock }), or a journal entry
   * carrying either. */
  function knockReportOf(entry) {
    if (!entry) return null;
    var r = entry.report || entry.knockReport || entry.knock;
    if (r && r.knock && !r.events) r = r.knock; // full session report wrapper
    return (r && r.available) ? r : null;
  }

  function sessionLabel(entry, fallback) {
    if (entry && entry.logName) return String(entry.logName);
    if (entry && entry.date) return String(entry.date).slice(0, 10);
    return fallback;
  }

  function suggestKnockSpark(report, journalEntries, ledger, opts) {
    opts = opts || {};
    var catalog = opts.catalog || P66.BUNDLED_CATALOG;
    var fingerprint = opts.fingerprint || opts.binFingerprint || null;

    var current = knockReportOf({ report: report });
    if (!current) return [];
    var currentEvents = (current.events || []).filter(isRealEvent);
    if (!currentEvents.length) return [];

    var axes = sparkAxes(catalog);
    if (!axes) return [];

    var cells = {}; // "row,col" -> { row, col, sessions: { sid: { label, events: [] } } }
    function addEvent(sid, label, e) {
      var hit = nearestSparkCell(axes, e.rpm, e.map);
      if (!hit) return;
      var key = hit.row + ',' + hit.col;
      var c = cells[key] || (cells[key] = { row: hit.row, col: hit.col, sessions: {} });
      var s = c.sessions[sid] || (c.sessions[sid] = { label: label, events: [] });
      s.events.push(e);
    }

    currentEvents.forEach(function (e) {
      addEvent('__current', opts.currentLabel || 'current session', e);
    });

    // Prior sessions from the journal. Each entry with a knock report is one
    // session; two entries for the same log name are the same session and
    // must not double-count. The current session (by log name) is excluded
    // so it is never counted against itself.
    var excludeLog = opts.sessionId || opts.logName || null;
    var seen = { __current: true };
    (journalEntries || []).forEach(function (entry, i) {
      if (!entry) return;
      var logName = entry.logName || '';
      if (excludeLog && logName && logName === excludeLog) return;
      var sid = logName ? 'log:' + logName : 'entry:' + (entry.id || ('#' + i));
      if (seen[sid]) return;
      seen[sid] = true;
      var kr = knockReportOf(entry);
      if (!kr) return;
      var evs = (kr.events || []).filter(isRealEvent);
      if (!evs.length) return;
      var label = sessionLabel(entry, 'session ' + (i + 1));
      evs.forEach(function (e) { addEvent(sid, label, e); });
    });

    var out = [];
    Object.keys(cells).forEach(function (key) {
      var c = cells[key];
      if (!c || !c.sessions) return;
      var sids = Object.keys(c.sessions);
      // The pull must be driven by the current session's data...
      if (sids.indexOf('__current') < 0) return;
      // ...and confirmed by at least one earlier session. Never one alone.
      if (sids.length < 2) return;

      var cellLabel = axes.rpmBp[c.row] + ' RPM / ' + axes.mapBp[c.col] + ' kPa';
      var allEvents = [];
      sids.forEach(function (sid) {
        c.sessions[sid].events.forEach(function (e) {
          allEvents.push({
            session: c.sessions[sid].label, rpm: e.rpm, map: e.map,
            peakKR: e.peakKR, samples: e.samples
          });
        });
      });
      var maxPeak = allEvents.reduce(function (m, e) {
        return Math.max(m, e.peakKR || 0);
      }, 0);
      var addressHex = cellAddressHex(axes, c.row, c.col);
      var knockCells = allEvents.map(function (e) {
        return { rpm: e.rpm, map: e.map, peakKR: e.peakKR };
      });

      // Ledger guardrail: would another -1 push this cell past cumulative ±6°?
      var blocked = null;
      if (ledger && fingerprint && addressHex) {
        var key2 = SPARK_TABLE_NAME + '@' + addressHex;
        (ledger.check(fingerprint, [{
          table: SPARK_TABLE_NAME, addressHex: addressHex, deltaDeg: -PULL_DEG
        }]) || []).forEach(function (w) {
          if (w.key === key2) blocked = w;
        });
      }

      if (blocked) {
        var limit = (P66.LEDGER_LIMITS && P66.LEDGER_LIMITS.sparkDeg) || 6;
        out.push({
          kind: 'spark', table: SPARK_TABLE_NAME, action: 'none', deltaDeg: 0,
          rpmIdx: c.row, mapIdx: c.col, addressHex: addressHex,
          cell: 'spark cell ' + cellLabel,
          knockCells: knockCells,
          reason: 'The knock near ' + cellLabel + ' keeps repeating (' + allEvents.length +
            ' events across ' + sids.length + ' separate logs, worst ' + maxPeak +
            '° of knock retard) — but this cell has already been pulled ' +
            Math.abs(blocked.cumulative) + '° total, which is at the ±' + limit +
            '° cumulative guardrail. No timing pull this pass: check that the knock is ' +
            'actually fading with each pull before changing timing here by hand.',
          confidence: 'medium',
          evidence: { sessions: sids.length, events: allEvents }
        });
        return;
      }

      out.push({
        kind: 'spark', table: SPARK_TABLE_NAME, action: 'retard timing', deltaDeg: -PULL_DEG,
        rpmIdx: c.row, mapIdx: c.col, addressHex: addressHex,
        cell: 'spark cell ' + cellLabel,
        knockCells: knockCells,
        reason: 'Knock keeps coming back in the same spot: ' + allEvents.length +
          ' events near ' + cellLabel + ' across ' + sids.length +
          ' separate logs (worst was ' + maxPeak + '° of knock retard). Pulling 1° of ' +
          'timing in that cell this pass. Flash it, log again, and confirm the knock ' +
          'quiets down — if it is still there next time, it gets another degree.',
        confidence: sids.length >= 3 ? 'high' : 'medium',
        evidence: { sessions: sids.length, events: allEvents }
      });
    });
    return out;
  }

  P66.suggestKnockSpark = suggestKnockSpark;
})(typeof window !== 'undefined' ? window : global);
