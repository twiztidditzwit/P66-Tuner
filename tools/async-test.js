/* Async analysis wrapper tests (Phase 1, item 3).
 *
 * Covers js/analyze-async.js (P66.analyzeSessionAsync, tableToTransport /
 * tableFromTransport) and the analyzeSession onStage hook in js/analyzer.js:
 *  - under node, typeof Worker === 'undefined', so the sync-fallback path
 *    is taken (no invocation-style changes needed by the suites).
 *  - async-fallback report is deep-identical to the sync analyzeSession
 *    report, on a synthetic table AND on yesss.csv (4 knock events,
 *    19 shifts, 0 flared, 1 hunting episode).
 *  - the report JSON-serializes cleanly (no functions / circular refs) and
 *    survives a structuredClone round-trip byte-identically.
 *  - onProgress receives monotonically non-decreasing pct values ending
 *    at 100.
 *  - tableToTransport -> tableFromTransport round-trip rebuilds a working
 *    table (this is the worker-side rebuild path): analysis on the rebuilt
 *    table is identical, and the source table's columns are NOT neutered.
 *  - a throwing Worker constructor falls back to the sync path and still
 *    resolves the identical report.
 *
 * Run: node tools/async-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/segments.js', 'js/altitude.js',
 'js/analyzer.js', 'js/analyze-async.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// NaN-tolerant deep equal (report math can legitimately contain NaN).
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(function (k) {
    return Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]);
  });
}

function findFunctions(x, seen, trail) {
  if (x === null || typeof x !== 'object') {
    return (typeof x === 'function') ? [trail || '(root)'] : [];
  }
  seen = seen || [];
  if (seen.indexOf(x) !== -1) return ['CIRCULAR at ' + (trail || '(root)')];
  seen.push(x);
  var bad = [];
  Object.keys(x).forEach(function (k) {
    var v = x[k];
    var here = (trail ? trail + '.' : '') + k;
    if (typeof v === 'function') bad.push(here);
    else bad = bad.concat(findFunctions(v, seen, here));
  });
  return bad;
}

function synthCsv() {
  var rows = ['RPM,MAP,TPS,VSS,ECT,KR,STFT_B1,LTFT_B1,O2_B1'];
  // idle, cruise, transients, a knock blip, gear-friendly cruise rows
  var data = [
    [800, 35, 1, 0, 100, 0, 2, 1, 500],
    [800, 35, 1, 0, 190, 0, 2, 1, 500],
    [2000, 45, 20, 45, 195, 0, 3, 1, 500],
    [2000, 45, 20, 45, 195, 0, 3, 1, 500],
    [2000, 45, 20, 45, 195, 4, 3, 1, 480],
    [2000, 45, 20, 45, 195, 6, 3, 1, 470],
    [2000, 45, 20, 45, 195, 0, 3, 1, 500],
    [1790, 50, 15, 55, 195, 0, 2, 0, 500],
    [1790, 50, 15, 55, 195, 0, 2, 0, 500],
    [4000, 80, 85, 60, 200, 0, 1, 0, 500]
  ];
  data.forEach(function (r) { rows.push(r.join(',')); });
  return rows.join('\n');
}
function synthMap() {
  return { mapping: {
    RPM: { column: 'RPM' }, MAP: { column: 'MAP' }, TPS: { column: 'TPS' },
    VSS: { column: 'VSS' }, ECT: { column: 'ECT' }, KR: { column: 'KR' },
    STFT_B1: { column: 'STFT_B1' }, LTFT_B1: { column: 'LTFT_B1' },
    O2_B1: { column: 'O2_B1' }
  }, unmapped: [] };
}

async function main() {
  console.log('1. node environment takes the Worker-absent path');
  check('typeof Worker === "undefined" under node', typeof Worker === 'undefined');
  check('P66.workerSupported() is false under node', P66.workerSupported() === false);

  console.log('2. synthetic table: async report identical to sync report');
  var t1 = P66.parseLogText(synthCsv());
  var t2 = P66.parseLogText(synthCsv());
  var map = synthMap();
  var syncReport = P66.analyzeSession(t1, map);
  var pcts = [];
  var p = P66.analyzeSessionAsync(t2, map, function (pct, stage) { pcts.push(pct); });
  check('analyzeSessionAsync returns a Promise', p instanceof Promise);
  var asyncReport = await p;
  check('async report deep-equals sync report', deepEq(asyncReport, syncReport));
  check('async report JSON-equals sync report', eq(asyncReport, syncReport));

  console.log('3. progress events: monotonic, ending at 100');
  var mono = pcts.length > 0 && pcts.every(function (v, i) {
    return i === 0 || v >= pcts[i - 1];
  });
  check('progress events received (' + pcts.length + ')', pcts.length > 0, JSON.stringify(pcts));
  check('progress monotonically non-decreasing', mono, JSON.stringify(pcts));
  check('progress ends at 100', pcts[pcts.length - 1] === 100, JSON.stringify(pcts[pcts.length - 1]));

  console.log('4. report survives structured cloning');
  var jsonOk = false, jsonStr = '';
  try { jsonStr = JSON.stringify(asyncReport); jsonOk = jsonStr.length > 0; }
  catch (e) { jsonOk = false; }
  check('report JSON-serializes cleanly', jsonOk);
  var badFns = findFunctions(asyncReport, []);
  check('report contains no functions / circular refs', badFns.length === 0, badFns.join(', '));
  if (typeof structuredClone === 'function') {
    var cloned = structuredClone(asyncReport);
    check('structuredClone round-trip identical (via JSON)',
      JSON.stringify(cloned) === jsonStr);
    check('structuredClone deep-equals original', deepEq(cloned, asyncReport));
  } else {
    console.log('  (structuredClone unavailable — skipped)');
  }

  console.log('5. transport round-trip (worker-side rebuild path)');
  var t3 = P66.parseLogText(synthCsv());
  var before = t3.col('RPM').slice(0, 5).join(',');
  var transport = P66.tableToTransport(t3);
  check('transport columns are Float32Array copies',
    transport.columns[0] instanceof Float32Array &&
    transport.columns[0] !== t3.columns[0]);
  check('source table columns not neutered by transport',
    t3.col('RPM').slice(0, 5).join(',') === before &&
    t3.columns.every(function (c) { return c === null || c.length === t3.rowCount; }));
  check('transport survives structuredClone (the worker post path)',
    (function () { try { structuredClone(transport); return true; } catch (e) { return false; } })());
  // structuredClone (not JSON) is the faithful stand-in for worker
  // postMessage: it preserves Float32Array, which JSON would mangle.
  var rebuilt = P66.tableFromTransport(structuredClone(transport));
  check('rebuilt table passes isLogTable', P66.isLogTable(rebuilt));
  var rebuiltReport = P66.analyzeSession(rebuilt, map);
  check('analysis on rebuilt table identical to sync report', deepEq(rebuiltReport, syncReport));

  console.log('6. throwing Worker constructor falls back to sync');
  var savedWorker = global.Worker;
  global.Worker = function () { throw new Error('file:// blocked'); };
  try {
    var t4 = P66.parseLogText(synthCsv());
    var fbPcts = [];
    var fbReport = await P66.analyzeSessionAsync(t4, map, function (pct) { fbPcts.push(pct); });
    check('fallback resolves identical report', deepEq(fbReport, syncReport));
    check('fallback still reports progress ending at 100',
      fbPcts.length > 0 && fbPcts[fbPcts.length - 1] === 100);
  } finally {
    if (savedWorker === undefined) delete global.Worker;
    else global.Worker = savedWorker;
  }

  console.log('7. yesss.csv regression (async path)');
  var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
  if (fs.existsSync(logPath)) {
    var realSync = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
    var realAsync = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
    var rmap = P66.mapChannels(realSync.headers);
    var sRep = P66.analyzeSession(realSync, rmap);
    var aRep = await P66.analyzeSessionAsync(realAsync, rmap);
    check('rowCount 10576 (async)', aRep.rowCount === 10576, String(aRep.rowCount));
    check('knock events = 4 (async)', aRep.knock.knockEvents === 4, String(aRep.knock.knockEvents));
    check('shifts = 19 (async)', aRep.transmission.shifts === 19, String(aRep.transmission.shifts));
    check('flared = 0 (async)', aRep.transmission.flaredShifts === 0,
      String(aRep.transmission.flaredShifts));
    check('hunting episodes = 1 (async)', aRep.transmission.huntingEpisodes === 1,
      String(aRep.transmission.huntingEpisodes));
    check('async report deep-equals sync report on yesss.csv', deepEq(aRep, sRep));
  } else {
    console.log('  (skipped real-log checks: yesss.csv not found)');
  }

  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}

main().catch(function (err) {
  console.log('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
