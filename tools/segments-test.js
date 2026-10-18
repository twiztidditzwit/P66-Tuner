/* Drive-segment breakdown tests.
 * Run: node tools/segments-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/segments.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- segment key order ----
check('SEGMENTS in spec order',
  JSON.stringify(P66.SEGMENTS.map(function (s) { return s.key; })) ===
  JSON.stringify(['idle', 'cruise', 'wot', 'decel', 'other']));

// ---- classifySegment ----
check('idle: 1000rpm 0.5%tps 0mph', P66.classifySegment(1000, 0.5, 0) === 'idle');
check('idle: boundary 1449/1.9/2.9', P66.classifySegment(1449, 1.9, 2.9) === 'idle');
check('rpm=1450 not idle', P66.classifySegment(1450, 0.5, 0) !== 'idle');
check('tps=2 not idle', P66.classifySegment(1000, 2, 0) !== 'idle');
check('vss=3 not idle', P66.classifySegment(1000, 0.5, 3) !== 'idle');
check('wot: 3000rpm 80%tps 60mph', P66.classifySegment(3000, 80, 60) === 'wot');
check('priority: TPS 80 at 1000rpm -> wot not idle',
  P66.classifySegment(1000, 80, 0) === 'wot');
check('decel: 2000rpm 0%tps 50mph', P66.classifySegment(2000, 0, 50) === 'decel');
check('decel: boundary rpm 1501', P66.classifySegment(1501, 1, 50) === 'decel');
check('rpm=1500 not decel', P66.classifySegment(1500, 0, 50) !== 'decel');
check('vss=10 not decel', P66.classifySegment(2000, 0, 10) !== 'decel');
check('cruise: 2500rpm 20%tps 55mph', P66.classifySegment(2500, 20, 55) === 'cruise');
check('cruise: tps=70 boundary', P66.classifySegment(2000, 70, 55) === 'cruise');
check('cruise: tps=2 boundary', P66.classifySegment(2000, 2, 55) === 'cruise');
check('other: parked revs 3000/5/0', P66.classifySegment(3000, 5, 0) === 'other');
check('other: rolling but tps<2 under rpm floor', P66.classifySegment(1400, 1, 10) === 'other');
check('other: null rpm', P66.classifySegment(null, 0, 0) === 'other');
check('other: null tps', P66.classifySegment(1000, null, 0) === 'other');
check('other: null vss', P66.classifySegment(1000, 0, null) === 'other');

// ---- analyzeSegments on synthetic rows ----
function fakeMap(cols) {
  var mapping = {};
  Object.keys(cols).forEach(function (sig) { mapping[sig] = { column: cols[sig] }; });
  return { mapping: mapping, unmapped: [] };
}
var sigMap = fakeMap({ RPM: 'rpm', TPS: 'tps', VSS: 'vss' });

function synthRows() {
  return [
    { rpm: 800, tps: 0.5, vss: 0 },    // idle
    { rpm: 900, tps: 1, vss: 0 },      // idle
    { rpm: 2500, tps: 20, vss: 55 },    // cruise
    { rpm: 2200, tps: 30, vss: 60 },    // cruise
    { rpm: 4500, tps: 85, vss: 70 },    // wot
    { rpm: 3000, tps: 0, vss: 65 },     // decel
    { rpm: 3000, tps: 5, vss: 0 }       // other (parked rev)
  ];
}
var res = P66.analyzeSegments(synthRows(), sigMap);
var byKey = {};
res.forEach(function (s) { byKey[s.key] = s; });
check('result keys in spec order',
  JSON.stringify(res.map(function (s) { return s.key; })) ===
  JSON.stringify(['idle', 'cruise', 'wot', 'decel', 'other']));
check('idle samples 2', byKey.idle.samples === 2);
check('cruise samples 2', byKey.cruise.samples === 2);
check('wot samples 1', byKey.wot.samples === 1);
check('decel samples 1', byKey.decel.samples === 1);
check('other samples 1', byKey.other.samples === 1);
check('shares sum to 1',
  Math.abs(res.reduce(function (a, s) { return a + s.share; }, 0) - 1) < 1e-9);
check('idle share 2/7', Math.abs(byKey.idle.share - 2 / 7) < 1e-9);
check('trims null when unmapped',
  byKey.idle.avgTrimB1 === null && byKey.idle.avgTrimB2 === null);

// ---- missing columns -> other, never throws ----
var noCols = fakeMap({});
var res2 = P66.analyzeSegments(synthRows(), noCols);
check('missing columns: all samples other',
  res2.filter(function (s) { return s.key !== 'other'; })
    .every(function (s) { return s.samples === 0; }) &&
  res2.filter(function (s) { return s.key === 'other'; })[0].samples === 7);
check('empty rows: shares 0, no throw',
  P66.analyzeSegments([], sigMap).every(function (s) { return s.share === 0 && s.samples === 0; }));
check('null mapResult: no throw', (function () {
  var r = P66.analyzeSegments(synthRows(), null);
  return r.filter(function (s) { return s.key === 'other'; })[0].samples === 7;
})());

// ---- trim math: 128-count encoding ----
var trimMap = fakeMap({
  RPM: 'rpm', TPS: 'tps', VSS: 'vss',
  STFT_B1: 'stft1', LTFT_B1: 'ltft1',
  STFT_B2: 'stft2', LTFT_B2: 'ltft2'
});
var trimRows = [
  { rpm: 800, tps: 0.5, vss: 0, stft1: 140, ltft1: 136, stft2: 120, ltft2: 120 },
  { rpm: 900, tps: 1, vss: 0, stft1: 132, ltft1: 128, stft2: 124, ltft2: 128 }
];
// B1: (140+136-128)=148, (132+128-128)=132 -> avg 140 (lean -> blue, >128)
// B2: (120+120-128)=112, (124+128-128)=124 -> avg 118 (rich -> red, <128)
var tr = P66.analyzeSegments(trimRows, trimMap);
var ti = tr.filter(function (s) { return s.key === 'idle'; })[0];
check('avgTrimB1 128-count: 140', Math.abs(ti.avgTrimB1 - 140) < 1e-9, String(ti.avgTrimB1));
check('avgTrimB2 128-count: 118', Math.abs(ti.avgTrimB2 - 118) < 1e-9, String(ti.avgTrimB2));
check('cruise trims null with zero cruise samples',
  tr.filter(function (s) { return s.key === 'cruise'; })[0].avgTrimB1 === null);

// ---- trim math: multiplier encoding ----
var mRows = [
  { rpm: 800, tps: 0.5, vss: 0, stft1: 1.05, ltft1: 0.95 },
  { rpm: 900, tps: 1, vss: 0, stft1: 1.0, ltft1: 1.0 }
];
// (134.4 + 121.6 - 128) = 128 ; (128 + 128 - 128) = 128 -> avg 128
var mr = P66.analyzeSegments(mRows, trimMap);
var mi = mr.filter(function (s) { return s.key === 'idle'; })[0];
check('avgTrimB1 multiplier->128 counts: 128', Math.abs(mi.avgTrimB1 - 128) < 1e-9, String(mi.avgTrimB1));
check('avgTrimB2 null (bank 2 unmapped)', mi.avgTrimB2 === null);

// ---- trim math: percent encoding ----
var pRows = [
  { rpm: 800, tps: 0.5, vss: 0, stft1: 5, ltft1: -5 }
];
// 134.4 + 121.6 - 128 = 128
var pr = P66.analyzeSegments(pRows, trimMap);
var pi = pr.filter(function (s) { return s.key === 'idle'; })[0];
check('avgTrimB1 percent->128 counts: 128', Math.abs(pi.avgTrimB1 - 128) < 1e-9, String(pi.avgTrimB1));

// ---- row with non-numeric trim value is skipped for that bank ----
var gRows = [
  { rpm: 800, tps: 0.5, vss: 0, stft1: 140, ltft1: 136 },
  { rpm: 900, tps: 1, vss: 0, stft1: 'bad', ltft1: 136 }
];
var gr = P66.analyzeSegments(gRows, trimMap);
var gi = gr.filter(function (s) { return s.key === 'idle'; })[0];
check('bad trim value skips row (avg 148)',
  gi.samples === 2 && Math.abs(gi.avgTrimB1 - 148) < 1e-9, String(gi.avgTrimB1));

// ---- renderSegments is a no-op under plain node ----
check('renderSegments no-op without document', (function () {
  P66.renderSegments(null, res);
  P66.renderSegments({}, res);
  return typeof document === 'undefined';
})());

// ---- real log: ~/workspace/user/files/yesss.csv ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
check('real log parses 10576 rows', parsed.rowCount === 10576, String(parsed.rowCount));
var realMap = P66.mapChannels(parsed.headers);
var real = P66.analyzeSegments(parsed, realMap);
var realByKey = {};
real.forEach(function (s) { realByKey[s.key] = s; });
var shareSum = real.reduce(function (a, s) { return a + s.share; }, 0);
check('real log shares sum to ~1', Math.abs(shareSum - 1) < 1e-9, String(shareSum));
check('real log: idle share is the largest',
  realByKey.idle.share >= realByKey.cruise.share &&
  realByKey.idle.share >= realByKey.decel.share &&
  realByKey.idle.share >= realByKey.wot.share &&
  realByKey.idle.share >= realByKey.other.share,
  JSON.stringify(real.map(function (s) { return [s.key, (s.share * 100).toFixed(1)]; })));
check('real log: idle share > 0.4', realByKey.idle.share > 0.4, String(realByKey.idle.share));
check('real log: no WOT (matches known idle/cruise log)',
  realByKey.wot.samples === 0 && realByKey.wot.avgTrimB1 === null);
check('real log: idle avgTrimB1 rich (<128)',
  realByKey.idle.avgTrimB1 !== null && realByKey.idle.avgTrimB1 < 128, String(realByKey.idle.avgTrimB1));
check('real log: idle avgTrimB2 rich (<128)',
  realByKey.idle.avgTrimB2 !== null && realByKey.idle.avgTrimB2 < 128, String(realByKey.idle.avgTrimB2));
check('real log: cruise avgTrimB1 numeric',
  typeof realByKey.cruise.avgTrimB1 === 'number', String(realByKey.cruise.avgTrimB1));

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
