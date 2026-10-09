/* Knock detection / KR scaling / spark-gating tests.
 *
 * Covers the knock workstream:
 *  - KR unit handling: raw ALDL counts (integers) are scaled x0.175781 to
 *    degrees; already-converted degree values pass through untouched.
 *  - Event trust flags: single-sample spikes -> suspectNoise, throttle
 *    closing mid-event -> tipOut.
 *  - sparkSuggestions gating: noise and tip-out events never size a
 *    suggestion; automatic retard requires >= 2 events in the same Main
 *    Spark cell; a lone genuine event is monitor-only.
 *  - Real-log regression on yesss.csv: 4 events, 22.5 deg max, but no
 *    automatic retard (ghosts rejected, real knock not yet repeatable).
 *
 * Run: node tools/knock-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// Build a synthetic log. rows: [KR, TPS, RPM, MAP]
function makeLog(rows) {
  var parsed = {
    headers: ['KR', 'TPS', 'RPM', 'MAP', 'TIME'],
    rows: rows.map(function (r, i) {
      return { KR: r[0], TPS: r[1], RPM: r[2], MAP: r[3], TIME: i * 0.145 };
    })
  };
  var mapResult = { mapping: {
    KR: { column: 'KR' }, TPS: { column: 'TPS' }, RPM: { column: 'RPM' },
    MAP: { column: 'MAP' }, TIME: { column: 'TIME' }
  } };
  P66.segmentRows(parsed.rows, mapResult);
  return P66.analyzeKnock(parsed.rows, mapResult);
}

// Steady-throttle knock event rows: KR decays like genuine PCM retard.
function steadyEvent(peak, n, rpm, map, tps) {
  rpm = rpm || 2972; map = map || 84.5; tps = (tps === undefined) ? 40 : tps;
  var rows = [];
  for (var i = 0; i < n; i++) {
    var kr = Math.max(0, Math.round((peak - i * 0.08) * 100) / 100);
    rows.push([kr, tps, rpm, map]);
  }
  return rows;
}
function quiet(n, rpm, map, tps) {
  rpm = rpm || 2972; map = map || 84.5; tps = (tps === undefined) ? 40 : tps;
  var rows = [];
  for (var i = 0; i < n; i++) rows.push([0, tps, rpm, map]);
  return rows;
}
console.log('1. raw ALDL counts are scaled to degrees (x0.175781)');
(function () {
  // 8 raw counts, steady throttle — integer values, no ADX conversion applied.
  var rows = quiet(5).concat(steadyEvent(8, 8).map(function (r) {
    return [Math.round(r[0]), r[1], r[2], r[3]]; // force integers: raw counts
  })).concat(quiet(5));
  var k = makeLog(rows);
  check('raw counts detected', k.krRawCountsDetected === true, JSON.stringify(k.krRawCountsDetected));
  check('scale factor is 0.175781', Math.abs(k.krScale - 0.175781) < 1e-9, String(k.krScale));
  check('peak scaled to 1.41 deg', k.maxKR === 1.41, String(k.maxKR));
  check('event peak scaled', k.events[0].peakKR === 1.41, String(k.events[0].peakKR));
})();

console.log('2. degree values pass through untouched');
(function () {
  var rows = quiet(5).concat(steadyEvent(1.41, 8)).concat(quiet(5));
  var k = makeLog(rows);
  check('not flagged as raw counts', k.krRawCountsDetected === false, String(k.krRawCountsDetected));
  check('scale factor is 1', k.krScale === 1, String(k.krScale));
  check('peak stays 1.41 deg', k.maxKR === 1.41, String(k.maxKR));
})();

console.log('3. single-sample spikes are flagged as noise and never retard timing');
(function () {
  var rows = [];
  for (var i = 0; i < 12; i++) {
    rows.push([22.5, 0.4, 787, 44]); // one-sample full-scale spike at idle
    rows.push([0, 0.4, 787, 44]);
  }
  var k = makeLog(rows);
  check('12 events found', k.knockEvents === 12, String(k.knockEvents));
  check('all flagged suspectNoise', k.events.every(function (e) { return e.suspectNoise; }),
    JSON.stringify(k.events.map(function (e) { return e.suspectNoise; })));
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark'; });
  check('no retard action', sugs.every(function (s) { return s.action !== 'retard timing'; }),
    JSON.stringify(sugs.map(function (s) { return s.action; })));
  check('reason names noise rejection', sugs.some(function (s) { return /rejected as noise/.test(s.reason); }),
    sugs.map(function (s) { return s.reason; }).join(' | '));
})();

console.log('4. tip-out events are rejected as false knock');
(function () {
  // Throttle closes 50 -> 5 across the event (tpsDrop 45 > 10).
  var rows = quiet(3, 3000, 70, 50);
  for (var i = 0; i < 15; i++) {
    rows.push([Math.max(0, 10.37 - i * 0.7), 50 - i * 3, 3000 - i * 40, 70 - i * 2.4]);
  }
  rows = rows.concat(quiet(3, 1500, 35, 5));
  var k = makeLog(rows);
  check('one event', k.knockEvents === 1, String(k.knockEvents));
  check('flagged tipOut', k.events[0].tipOut === true,
    'tpsDrop=' + k.events[0].tpsDrop);
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark'; });
  check('no retard action', sugs.every(function (s) { return s.action !== 'retard timing'; }),
    JSON.stringify(sugs.map(function (s) { return s.action; })));
  check('reason names tip-out rejection', sugs.some(function (s) { return /tip-out event\(s\) rejected as false knock/.test(s.reason); }),
    sugs.map(function (s) { return s.reason; }).join(' | '));
})();

console.log('5. one genuine event is monitor-only (not yet repeatable)');
(function () {
  var rows = quiet(5).concat(steadyEvent(1.41, 12)).concat(quiet(20));
  var k = makeLog(rows);
  check('one clean event', k.knockEvents === 1 && !k.events[0].suspectNoise && !k.events[0].tipOut,
    JSON.stringify(k.events.map(function (e) { return [e.suspectNoise, e.tipOut]; })));
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark'; });
  check('no retard action', sugs.every(function (s) { return s.action !== 'retard timing'; }),
    JSON.stringify(sugs.map(function (s) { return s.action; })));
  check('reason says not yet repeatable', sugs.some(function (s) { return /not yet repeatable/.test(s.reason); }),
    sugs.map(function (s) { return s.reason; }).join(' | '));
  check('knockCells still reported for manual review',
    sugs.some(function (s) { return s.knockCells && s.knockCells.length === 1 && s.knockCells[0].peakKR === 1.41; }),
    JSON.stringify(sugs.map(function (s) { return s.knockCells; })));
})();

console.log('6. two events in the same spark cell -> actionable retard, sized from median peak');
(function () {
  var rows = quiet(5)
    .concat(steadyEvent(1.41, 8, 2972, 84.5))
    .concat(quiet(10))
    .concat(steadyEvent(1.76, 8, 2990, 83))
    .concat(quiet(10));
  var k = makeLog(rows);
  check('two clean events', k.knockEvents === 2 &&
    k.events.every(function (e) { return !e.suspectNoise && !e.tipOut; }),
    String(k.knockEvents));
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark' && s.action === 'retard timing'; });
  check('one actionable suggestion', sugs.length === 1, String(sugs.length));
  var s = sugs[0];
  check('pull = median peak 1.76 clamped to 2 deg', s.deltaDeg === -1.76,
    'deltaDeg=' + s.deltaDeg);
  check('cell label names the spark cell', /2800 RPM \/ 85 kPa/.test(s.cell), s.cell);
  check('knockCells only from the repeatable cell', s.knockCells.length === 2 &&
    s.knockCells.every(function (c) { return c.peakKR === 1.41 || c.peakKR === 1.76; }),
    JSON.stringify(s.knockCells));
  check('medium confidence for 2 events', s.confidence === 'medium', s.confidence);
})();

console.log('7. two genuine events in DIFFERENT cells -> no automatic retard');
(function () {
  var rows = quiet(5)
    .concat(steadyEvent(1.41, 8, 2972, 84.5))   // -> 2800/85
    .concat(quiet(10, 1450, 57))
    .concat(steadyEvent(1.76, 8, 1448, 57.5))   // -> 1400/55 (or 60)
    .concat(quiet(10));
  var k = makeLog(rows);
  check('two clean events', k.knockEvents === 2, String(k.knockEvents));
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark'; });
  check('no retard action', sugs.every(function (s) { return s.action !== 'retard timing'; }),
    JSON.stringify(sugs.map(function (s) { return s.action; })));
  check('two monitor-only notes (one per cell)',
    sugs.filter(function (s) { return /not yet repeatable/.test(s.reason); }).length === 2,
    sugs.map(function (s) { return s.reason; }).join(' | ').slice(0, 200));
})();

console.log('8. ghosts do not leak into an actionable suggestion');
(function () {
  var rows = quiet(5)
    .concat(steadyEvent(1.41, 8, 2972, 84.5))
    .concat(quiet(10))
    .concat(steadyEvent(1.76, 8, 2990, 83))
    .concat(quiet(10))
    .concat([[22.5, 0.4, 787, 44]])              // single-sample spike: noise
    .concat(quiet(5, 787, 44, 0.4))
    ;
  // tip-out event at the same cell as the genuine ones — must still be rejected
  for (var i = 0; i < 12; i++) rows.push([Math.max(0, 8 - i * 0.7), 45 - i * 3.5, 2970, 84]);
  rows = rows.concat(quiet(5, 1500, 35, 5));
  var k = makeLog(rows);
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark' && s.action === 'retard timing'; });
  check('one actionable suggestion', sugs.length === 1, String(sugs.length));
  if (sugs.length === 1) {
    check('knockCells exclude noise and tip-out peaks',
      sugs[0].knockCells.length === 2 &&
      sugs[0].knockCells.every(function (c) { return c.peakKR < 2; }),
      JSON.stringify(sugs[0].knockCells));
    check('reason still discloses rejections', /rejected as noise/.test(sugs[0].reason) &&
      /rejected as false knock/.test(sugs[0].reason), sugs[0].reason.slice(0, 300));
  }
})();

console.log('9. real log yesss.csv: ghosts rejected, real knock monitor-only');
(function () {
  var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
  if (!fs.existsSync(logPath)) {
    check('yesss.csv present', false, logPath);
    return;
  }
  var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  var mapResult = P66.mapChannels(parsed.headers);
  var report = P66.analyzeSession(parsed, mapResult);
  var k = report.knock;
  check('4 knock events', k.knockEvents === 4, String(k.knockEvents));
  check('KR already degrees (no raw counts)', k.krRawCountsDetected === false && k.krScale === 1,
    'raw=' + k.krRawCountsDetected + ' scale=' + k.krScale);
  check('maxKR still reported as 22.5', k.maxKR === 22.5, String(k.maxKR));
  var flags = k.events.map(function (e) { return (e.suspectNoise ? 'N' : '') + (e.tipOut ? 'T' : ''); });
  check('event flags: genuine, tip-out, noise, noise', flags.join(',') === ',T,N,N', flags.join(','));
  ['conservative', 'balanced', 'aggressive'].forEach(function (mode) {
    var sugs = P66.generateSuggestions(report, mode).suggestions
      .filter(function (s) { return s.kind === 'spark'; });
    check(mode + ': no automatic retard',
      sugs.every(function (s) { return s.action !== 'retard timing'; }),
      JSON.stringify(sugs.map(function (s) { return s.action + ':' + s.deltaDeg; })));
    check(mode + ': monitor note for the genuine event',
      sugs.some(function (s) { return /not yet repeatable/.test(s.reason) && /2972/.test(s.reason); }),
      sugs.map(function (s) { return s.reason; }).join(' | ').slice(0, 250));
  });
})();

console.log('10. pre-gate and shape compatibility');
(function () {
  var k = makeLog(quiet(3)); // no knock at all
  var sugs = P66.generateSuggestions({ knock: k }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark'; });
  check('no knock -> no spark suggestions', sugs.length === 0, String(sugs.length));
  var s2 = P66.generateSuggestions({ knock: { available: false } }, 'conservative').suggestions;
  check('knock unavailable -> no spark suggestions',
    s2.filter(function (s) { return s.kind === 'spark'; }).length === 0, String(s2.length));
  // actionable suggestion keeps the patcher input shape
  var rows = quiet(5).concat(steadyEvent(1.41, 8, 2972, 84.5)).concat(quiet(10))
    .concat(steadyEvent(1.76, 8, 2990, 83)).concat(quiet(10));
  var k2 = makeLog(rows);
  var act = P66.generateSuggestions({ knock: k2 }, 'conservative').suggestions
    .filter(function (s) { return s.kind === 'spark' && s.action === 'retard timing'; })[0];
  check('patcher shape: kind/table/action/deltaDeg/knockCells/confidence/samples',
    act && act.kind === 'spark' && typeof act.deltaDeg === 'number' &&
    Array.isArray(act.knockCells) && typeof act.confidence === 'string' &&
    typeof act.samples === 'number', JSON.stringify(act && Object.keys(act)));
})();

console.log('\n' + (failures ? failures + ' FAILURE(S) of ' + checks : 'ALL ' + checks + ' TESTS PASSED'));
process.exit(failures ? 1 : 0);
