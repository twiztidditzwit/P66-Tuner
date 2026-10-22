/* Log health score tests.
 * Run: node tools/log-health-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/log-health.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap(cols) {
  var mapping = {};
  Object.keys(cols).forEach(function (sig) {
    mapping[sig] = { column: cols[sig], confidence: 'high', score: 100 };
  });
  return { mapping: mapping, unmapped: [] };
}

function makeTable(n, fn) {
  var rows = [];
  for (var i = 0; i < n; i++) rows.push(fn(i));
  return P66.tableFromRows(rows);
}

var COLS = { RPM: 'rpm', MAP: 'map', TPS: 'tps', O2_B1: 'o2b1', O2_B2: 'o2b2', ECT: 'ect', TIME: 't' };

// Healthy 600-row log @ ~0.145s/frame: everything moves.
function cleanRow(i) {
  return {
    t: +(i * 0.145).toFixed(3),
    rpm: Math.round(800 + 25 * Math.sin(i / 9) + 8 * Math.sin(i / 3)),
    map: +(40 + 3 * Math.sin(i / 21)).toFixed(1),
    tps: +(6 + 4 * Math.sin(i / 33)).toFixed(1),
    o2b1: (Math.floor(i / 10) % 2 === 0) ? 800 : 100,
    o2b2: (Math.floor(i / 10 + 1) % 2 === 0) ? 800 : 100,
    ect: +(180 + i * 0.01).toFixed(1)
  };
}

function hasIssue(h, code, severity) {
  return h.issues.filter(function (x) {
    return x.code === code && (!severity || x.severity === severity);
  });
}

// ---- (1) all-clean log scores 100, no issues, gate passes ----
var clean = makeTable(600, cleanRow);
var hc = P66.logHealth(clean, fakeMap(COLS));
check('clean: score 100', hc.score === 100, 'got ' + hc.score);
check('clean: no issues', hc.issues.length === 0, JSON.stringify(hc.issues));
check('clean: not blocked', hc.block === false);
var gc = P66.logHealthGate(hc);
check('clean gate: ok', gc.ok === true);
check('clean gate: no override needed', gc.overrideRequired === false);
check('clean gate: message mentions pass', /passed/.test(gc.message), gc.message);

// ---- (2) 10% RPM dropout -> warn, score 88 ----
var drop = makeTable(600, function (i) {
  var r = cleanRow(i);
  if (i >= 100 && i < 160) r.rpm = NaN;
  return r;
});
var hd = P66.logHealth(drop, fakeMap(COLS));
var dw = hasIssue(hd, 'dropout', 'warn');
check('dropout: one warn dropout issue', dw.length === 1, JSON.stringify(hd.issues));
check('dropout: channel is rpm', dw.length === 1 && dw[0].channel === 'rpm');
check('dropout: message plain words', dw.length === 1 && /drops out for 10%/.test(dw[0].message), dw[0] && dw[0].message);
check('dropout: score 88', hd.score === 88, 'got ' + hd.score);
check('dropout: not blocked', hd.block === false);
var gd = P66.logHealthGate(hd);
check('dropout gate: ok, no override', gd.ok === true && gd.overrideRequired === false);
check('dropout gate: message carries score', /88/.test(gd.message), gd.message);

// ---- (3) 70% RPM dropout -> block ----
var dropHeavy = makeTable(600, function (i) {
  var r = cleanRow(i);
  if (i < 420) r.rpm = NaN;
  return r;
});
var hh = P66.logHealth(dropHeavy, fakeMap(COLS));
var hb = hasIssue(hh, 'dropout', 'block');
check('heavy dropout: block dropout issue', hb.length === 1, JSON.stringify(hh.issues));
check('heavy dropout: message says too much', hb.length === 1 && /too much dropout/.test(hb[0].message), hb[0] && hb[0].message);
check('heavy dropout: blocked', hh.block === true);
check('heavy dropout: score 60', hh.score === 60, 'got ' + hh.score);
var gh = P66.logHealthGate(hh);
check('heavy gate: not ok', gh.ok === false);
check('heavy gate: override required', gh.overrideRequired === true);
check('heavy gate: message offers analyze-anyway',
  /analyze anyway/i.test(gh.message), gh.message);

// ---- (4) RPM channel entirely NaN -> block ----
var allNan = makeTable(600, function (i) {
  var r = cleanRow(i); r.rpm = NaN; return r;
});
var han = P66.logHealth(allNan, fakeMap(COLS));
check('all-NaN RPM: blocked', han.block === true);
check('all-NaN RPM: block dropout, no usable samples',
  hasIssue(han, 'dropout', 'block').length === 1 &&
  /no usable samples/.test(hasIssue(han, 'dropout', 'block')[0].message),
  JSON.stringify(han.issues));

// ---- (5) flatlined RPM at 812 -> block ----
var flatRpm = makeTable(600, function (i) {
  var r = cleanRow(i); r.rpm = 812; return r;
});
var hfr = P66.logHealth(flatRpm, fakeMap(COLS));
var frb = hasIssue(hfr, 'flatline', 'block');
check('flat RPM: block flatline', frb.length === 1, JSON.stringify(hfr.issues));
check('flat RPM: message names stuck value', frb.length === 1 && /stuck at 812 rpm/.test(frb[0].message), frb[0] && frb[0].message);
check('flat RPM: blocked', hfr.block === true);

// ---- (6) flatlined RPM at 0 -> block, engine-never-ran message ----
var zeroRpm = makeTable(600, function (i) {
  var r = cleanRow(i); r.rpm = 0; return r;
});
var hzr = P66.logHealth(zeroRpm, fakeMap(COLS));
var zrb = hasIssue(hzr, 'flatline', 'block');
check('zero RPM: blocked', hzr.block === true);
check('zero RPM: engine never ran message',
  zrb.length === 1 && /never running/.test(zrb[0].message), zrb[0] && zrb[0].message);

// ---- (7) flatlined TPS only -> info, score 97 ----
var flatTps = makeTable(600, function (i) {
  var r = cleanRow(i); r.tps = 0; return r;
});
var hft = P66.logHealth(flatTps, fakeMap(COLS));
var fti = hasIssue(hft, 'flatline', 'info');
check('flat TPS: info flatline', fti.length === 1, JSON.stringify(hft.issues));
check('flat TPS: score 97', hft.score === 97, 'got ' + hft.score);
check('flat TPS: not blocked', hft.block === false);
check('flat TPS: idle-only wording', fti.length === 1 && /idle-only/.test(fti[0].message), fti[0] && fti[0].message);

// ---- (8) flatlined O2 bank 1 -> info ----
var flatO2 = makeTable(600, function (i) {
  var r = cleanRow(i); r.o2b1 = 450; return r;
});
var hfo = P66.logHealth(flatO2, fakeMap(COLS));
check('flat O2: info flatline', hasIssue(hfo, 'flatline', 'info').length === 1,
  JSON.stringify(hfo.issues));
check('flat O2: not blocked', hfo.block === false);

// ---- (9) 2s ALDL gap in timestamps -> warn ----
var gapT = makeTable(600, function (i) {
  var r = cleanRow(i);
  if (i >= 300) r.t = +(r.t + 2.0).toFixed(3);
  return r;
});
var hgap = P66.logHealth(gapT, fakeMap(COLS));
var gw = hasIssue(hgap, 'aldl-gap', 'warn');
check('time gap: warn aldl-gap', gw.length === 1, JSON.stringify(hgap.issues));
check('time gap: mentions dropped frames', gw.length === 1 && /dropped ALDL frame/.test(gw[0].message), gw[0] && gw[0].message);
check('time gap: not blocked', hgap.block === false);

// ---- (10) no TIME channel -> info limitation notes, still healthy ----
var noTimeCols = { RPM: 'rpm', MAP: 'map', TPS: 'tps', O2_B1: 'o2b1', O2_B2: 'o2b2', ECT: 'ect' };
var hnt = P66.logHealth(clean, fakeMap(noTimeCols));
check('no TIME: info aldl-gap limitation',
  hasIssue(hnt, 'aldl-gap', 'info').length === 1 &&
  /could not check for dropped ALDL frames/.test(hasIssue(hnt, 'aldl-gap', 'info')[0].message),
  JSON.stringify(hnt.issues));
check('no TIME: info sample-rate limitation',
  hasIssue(hnt, 'sample-rate', 'info').length === 1, JSON.stringify(hnt.issues));
check('no TIME: score 94', hnt.score === 94, 'got ' + hnt.score);
check('no TIME: not blocked', hnt.block === false);

// ---- (11) slow sampling (1s/frame) -> warn ----
var slow = makeTable(600, function (i) {
  var r = cleanRow(i); r.t = +i.toFixed(1); return r;
});
var hsl = P66.logHealth(slow, fakeMap(COLS));
var slw = hasIssue(hsl, 'sample-rate', 'warn');
check('slow rate: warn sample-rate', slw.length === 1, JSON.stringify(hsl.issues));
check('slow rate: mentions 0.15s expectation', slw.length === 1 && /0\.15s/.test(slw[0].message), slw[0] && slw[0].message);

// ---- (12) impossibly fast sampling -> warn ----
var fast = makeTable(600, function (i) {
  var r = cleanRow(i); r.t = +(i * 0.01).toFixed(3); return r;
});
var hfa = P66.logHealth(fast, fakeMap(COLS));
check('fast rate: warn sample-rate', hasIssue(hfa, 'sample-rate', 'warn').length === 1,
  JSON.stringify(hfa.issues));
check('fast rate: faster-than-ALDL wording',
  /faster than 8192-baud ALDL/.test(hasIssue(hfa, 'sample-rate', 'warn')[0].message));

// ---- (13) missing RPM mapping -> block ----
var noRpmCols = { MAP: 'map', TPS: 'tps', O2_B1: 'o2b1', TIME: 't' };
var hnr = P66.logHealth(clean, fakeMap(noRpmCols));
check('no RPM map: block missing-channel',
  hasIssue(hnr, 'missing-channel', 'block').length === 1, JSON.stringify(hnr.issues));
check('no RPM map: blocked', hnr.block === true);

// ---- (14) too-short log -> block ----
var tiny = makeTable(10, cleanRow);
var ht = P66.logHealth(tiny, fakeMap(COLS));
check('tiny: block too-short', hasIssue(ht, 'too-short', 'block').length === 1,
  JSON.stringify(ht.issues));
check('tiny: blocked', ht.block === true);
var gt = P66.logHealthGate(ht);
check('tiny gate: override required', gt.ok === false && gt.overrideRequired === true);

// ---- (15) empty table -> block ----
var hempty = P66.logHealth(P66.tableFromRows([]), fakeMap(COLS));
check('empty: block empty-log', hasIssue(hempty, 'empty-log', 'block').length === 1,
  JSON.stringify(hempty.issues));
check('empty: blocked', hempty.block === true);

// ---- (16) sequence-counter fallback: jump 100->106 ----
var seqRows = makeTable(600, function (i) {
  var r = cleanRow(i);
  delete r.t;
  r.frame = i < 100 ? i : i + 5; // counter skips 100..104 -> 5 dropped frames
  return r;
});
var hsq = P66.logHealth(seqRows, fakeMap(noTimeCols));
var sqw = hasIssue(hsq, 'aldl-gap', 'warn');
check('seq counter: warn aldl-gap', sqw.length === 1, JSON.stringify(hsq.issues));
check('seq counter: mentions dropped frames', sqw.length === 1 && /dropped frame/.test(sqw[0].message), sqw[0] && sqw[0].message);

// ---- (17) backwards timestamps -> warn ----
var backT = makeTable(600, function (i) {
  var r = cleanRow(i);
  if (i === 200) r.t = +(199 * 0.145 - 0.5).toFixed(3); // one backwards jump
  return r;
});
var hbk = P66.logHealth(backT, fakeMap(COLS));
check('backwards time: warn aldl-gap', hasIssue(hbk, 'aldl-gap', 'warn').length >= 1,
  JSON.stringify(hbk.issues));
check('backwards time: backwards wording',
  /backwards/.test(hasIssue(hbk, 'aldl-gap', 'warn')[0].message));

// ---- (18) null mapResult does not throw ----
var hnull = P66.logHealth(clean, null);
check('null mapResult: no throw, blocks on missing RPM',
  hnull.block === true && hasIssue(hnull, 'missing-channel', 'block').length === 1,
  JSON.stringify(hnull.issues));

// ---- (19) constants exported ----
var C = P66.LOG_HEALTH_CONSTANTS;
check('constants: expected sample 0.145s', C.expectedSampleS === 0.145);
check('constants: minRows 30', C.minRows === 30);
check('constants: block frac 0.5', C.dropoutBlockFrac === 0.5);
check('constants: gap factor 3', C.gapFactor === 3);
check('constants: weights 40/12/3',
  C.weights.block === 40 && C.weights.warn === 12 && C.weights.info === 3);

// ---- (20) real log: Dale's yesss.csv — smoke test ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var hreal = P66.logHealth(parsed, mapResult);
check('real log: no throw, score is a number', typeof hreal.score === 'number');
check('real log: issues is an array', Array.isArray(hreal.issues));
check('real log: not blocked', hreal.block === false,
  JSON.stringify(hreal.issues.map(function (x) { return x.severity + ':' + x.code; })));
check('real log: score >= 80', hreal.score >= 80, 'got ' + hreal.score);

console.log('\n--- real log report (yesss.csv) ---');
console.log('  score=' + hreal.score + ' block=' + hreal.block);
hreal.issues.forEach(function (x) {
  console.log('  [' + x.severity + '/' + x.code + ']' + (x.channel ? ' ' + x.channel : '') + ' ' + x.message);
});
var greal = P66.logHealthGate(hreal);
console.log('  gate: ok=' + greal.ok + ' override=' + greal.overrideRequired);
console.log('  gate message: ' + greal.message);

console.log('\n' + checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
