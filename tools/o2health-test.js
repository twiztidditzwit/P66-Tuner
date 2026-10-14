/* O2 sensor health panel tests.
 * Run: node tools/o2health-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/o2health.js'].forEach(function (f) {
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

// n rows at sampleHz; fn(i) returns {o2b1, o2b2, ...} per row.
function makeRows(n, sampleHz, fn) {
  var rows = [];
  for (var i = 0; i < n; i++) {
    var r = fn(i) || {};
    r.t = +(i / sampleHz).toFixed(3);
    rows.push(r);
  }
  return rows;
}

function wave(fnPeriodSamples) {
  return function (i) {
    var hi = Math.floor(i / fnPeriodSamples) % 2 === 0;
    return { o2b1: hi ? 800 : 100, o2b2: hi ? 800 : 100 };
  };
}

var baseMap = fakeMap({ O2_B1: 'o2b1', O2_B2: 'o2b2', TIME: 't' });

// ---- (a) healthy fast switching: 10Hz, toggles every 1s -> ~60/min ----
var healthy = makeRows(600, 10, wave(10));
var rh = P66.analyzeO2Health(healthy, baseMap);
check('healthy: b1 available', rh.b1.available === true);
check('healthy: b2 available', rh.b2.available === true);
check('healthy: not lazy', rh.b1.lazy === false && rh.b2.lazy === false);
check('healthy: ~60 switches/min',
  rh.b1.switchesPerMin > 55 && rh.b1.switchesPerMin < 65,
  'got ' + rh.b1.switchesPerMin);
check('healthy: avgHigh ~800mV', rh.b1.avgHighMv === 800, 'got ' + rh.b1.avgHighMv);
check('healthy: avgLow ~100mV', rh.b1.avgLowMv === 100, 'got ' + rh.b1.avgLowMv);
check('healthy: amplitude 700mV', rh.b1.amplitudeMv === 700, 'got ' + rh.b1.amplitudeMv);
check('healthy: banks agree',
  rh.b1.switchesPerMin === rh.b2.switchesPerMin && rh.b1.amplitudeMv === rh.b2.amplitudeMv);

// ---- (b) flat lazy line: 100mV, 0 switches ----
var flat = makeRows(600, 10, function () { return { o2b1: 100, o2b2: 100 }; });
var rf = P66.analyzeO2Health(flat, baseMap);
check('flat: available', rf.b1.available === true);
check('flat: 0 switches/min', rf.b1.switchesPerMin === 0, 'got ' + rf.b1.switchesPerMin);
check('flat: lazy', rf.b1.lazy === true && rf.b2.lazy === true);
check('flat: amplitude 0, no high side',
  rf.b1.amplitudeMv === 0 && rf.b1.avgHighMv === null && rf.b1.avgLowMv === 100,
  JSON.stringify({ amp: rf.b1.amplitudeMv, hi: rf.b1.avgHighMv, lo: rf.b1.avgLowMv }));

// ---- (c) slow switching: 10Hz, toggles every 12s -> ~5/min ----
var slow = makeRows(3000, 10, wave(120));
var rs = P66.analyzeO2Health(slow, baseMap);
check('slow: available', rs.b1.available === true);
check('slow: ~5 switches/min',
  rs.b1.switchesPerMin > 4 && rs.b1.switchesPerMin < 6,
  'got ' + rs.b1.switchesPerMin);
check('slow: amplitude still full', rs.b1.amplitudeMv === 700, 'got ' + rs.b1.amplitudeMv);
check('slow: lazy via rate alone', rs.b1.lazy === true);

// ---- (d) missing O2 column ----
var noO2 = P66.analyzeO2Health(healthy, fakeMap({ TIME: 't' }));
check('no O2: b1 unavailable', noO2.b1.available === false);
check('no O2: b2 unavailable', noO2.b2.available === false);
check('no O2: lazy is null', noO2.b1.lazy === null && noO2.b2.lazy === null);
check('no O2: reason, not zeros',
  typeof noO2.b1.reason === 'string' && noO2.b1.reason.length > 0 &&
  noO2.b1.switchesPerMin === null,
  noO2.b1.reason);

// ---- too few samples: 20 rows ----
var tiny = makeRows(20, 10, wave(10));
var rt = P66.analyzeO2Health(tiny, baseMap);
check('tiny: unavailable under 30 samples',
  rt.b1.available === false && /30 needed/.test(rt.b1.reason), rt.b1.reason);

// ---- ECT warm gating: first 100 rows cold (150F, flat 450mV), 600 warm switching ----
var gated = makeRows(700, 10, function (i) {
  var cold = i < 100;
  var hi = Math.floor((i - 100) / 10) % 2 === 0;
  return { o2b1: cold ? 450 : (hi ? 800 : 100), ect: cold ? 150 : 180 };
});
var rg = P66.analyzeO2Health(gated, fakeMap({ O2_B1: 'o2b1', TIME: 't', ECT: 'ect' }));
check('gated: cold rows excluded from rate',
  rg.b1.available === true && rg.b1.switchesPerMin > 55,
  'got ' + rg.b1.switchesPerMin + ' (no gating would give ~50)');
check('gated: reason mentions excluded cold rows',
  /cold row\(s\) excluded/.test(rg.b1.reason), rg.b1.reason);

// ---- no ECT column: all samples used, reason says so ----
var rne = P66.analyzeO2Health(healthy, baseMap);
check('no ECT: available', rne.b1.available === true);
check('no ECT: reason says gating unavailable',
  /no ECT channel/.test(rne.b1.reason), rne.b1.reason);
check('no ECT: not lazy on healthy wave', rne.b1.lazy === false);

// ---- no TIME column: falls back to row count x 0.145s ----
var noT = P66.analyzeO2Health(healthy, fakeMap({ O2_B1: 'o2b1' }));
var expectSpm = 59 / ((600 * 0.145) / 60);
check('no TIME: available', noT.b1.available === true);
check('no TIME: uses 0.145s fallback',
  Math.abs(noT.b1.switchesPerMin - expectSpm) < 0.2,
  'got ' + noT.b1.switchesPerMin + ', expected ~' + expectSpm.toFixed(2));

// ---- generic single O2 signal lands on Bank 1, Bank 2 unavailable ----
var genO2 = makeRows(600, 10, function (i) {
  var hi = Math.floor(i / 10) % 2 === 0;
  return { o2: hi ? 800 : 100 };
});
var rgen = P66.analyzeO2Health(genO2, fakeMap({ O2: 'o2', TIME: 't' }));
check('generic O2: b1 available', rgen.b1.available === true);
check('generic O2: b1 healthy on wave', rgen.b1.lazy === false);
check('generic O2: b2 unavailable (not duplicated)',
  rgen.b2.available === false && /No O2 sensor column/.test(rgen.b2.reason), rgen.b2.reason);

// ---- hysteresis: jitter around stoich without crossing the band = no switches ----
var jitter = makeRows(600, 10, function (i) {
  return { o2b1: (i % 2 === 0) ? 410 : 490, o2b2: 450 };
});
var rj = P66.analyzeO2Health(jitter, baseMap);
check('hysteresis: 410/490 jitter counts no switches',
  rj.b1.switchesPerMin === 0, 'got ' + rj.b1.switchesPerMin);
check('hysteresis: in-band jitter is lazy (no real swing)',
  rj.b1.lazy === true && rj.b1.amplitudeMv === 0,
  JSON.stringify({ spm: rj.b1.switchesPerMin, amp: rj.b1.amplitudeMv }));

// ---- constants exported and documented ----
var C = P66.O2_HEALTH_CONSTANTS;
check('constants: stoich 450mV', C.stoichMv === 450);
check('constants: hysteresis band 400/500mV', C.hystLowMv === 400 && C.hystHighMv === 500);
check('constants: warm ECT 160F', C.warmEctF === 160);
check('constants: 30-sample floor', C.minUsableSamples === 30);
check('constants: lazy <15/min or <600mV', C.lazySwitchesPerMin === 15 && C.lazyAmplitudeMv === 600);
check('constants: fallback sample 0.145s', C.fallbackSampleS === 0.145);

// ---- render guard (no DOM under node) ----
check('renderO2Health is a function', typeof P66.renderO2Health === 'function');
var threw = false;
try { P66.renderO2Health(null, rh); } catch (e) { threw = true; }
check('renderO2Health no-throw without document', threw === false);

// ---- real log: Dale's yesss.csv — smoke test, no verdict assertion ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var rreal = P66.analyzeO2Health(parsed.rows, mapResult);
check('real log: both banks analyzed',
  rreal.b1.available === true && rreal.b2.available === true,
  JSON.stringify({ b1: rreal.b1.reason, b2: rreal.b2.reason }));
check('real log: numeric stats when available',
  typeof rreal.b1.switchesPerMin === 'number' && typeof rreal.b1.amplitudeMv === 'number');

console.log('\n--- real log report (yesss.csv) ---');
['b1', 'b2'].forEach(function (b) {
  var r = rreal[b];
  console.log('  ' + b + ': available=' + r.available +
    ' switches/min=' + r.switchesPerMin +
    ' amplitude=' + r.amplitudeMv + 'mV' +
    ' high=' + r.avgHighMv + 'mV low=' + r.avgLowMv + 'mV' +
    ' lazy=' + r.lazy);
  console.log('    reason: ' + r.reason);
});

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
