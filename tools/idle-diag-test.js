/* IAC / idle stability diagnostics tests.
 * Run: node tools/idle-diag-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js',
 'js/idle-diag.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap(withIac) {
  var m = { mapping: {
    RPM: { column: 'rpm' }, TPS: { column: 'tps' }, VSS: { column: 'vss' },
    ECT: { column: 'ect' }
  }, unmapped: [] };
  if (withIac !== false) m.mapping.IAC = { column: 'iac' };
  return m;
}

// 60 hot-idle rows (tps 0, vss 0, ect 182F => warm). rpmFn/iacFn take the
// row index for deterministic jitter.
function idleRows(n, rpmFn, iacFn, extra) {
  var rows = [];
  for (var i = 0; i < n; i++) {
    var r = { rpm: rpmFn(i), tps: 0, vss: 0, ect: 182, iac: iacFn(i) };
    if (extra) for (var k in extra) r[k] = extra[k](i);
    rows.push(r);
  }
  return rows;
}
function steady(v, jitter) {
  return function (i) { return v + ((i % 5) - 2) * (jitter || 0); };
}

console.log('idle-diag: healthy hot idle');
var r1 = P66.analyzeIdle(idleRows(60, steady(702, 2), steady(24, 2)), fakeMap());
check('available', r1.available === true);
check("verdict 'ok'", r1.verdict === 'ok', r1.verdict);
check('samples counted', r1.hotIdle.samples === 60, String(r1.hotIdle.samples));
check('avg IAC near 24', Math.abs(r1.hotIdle.avgIac - 24) < 3, String(r1.hotIdle.avgIac));
check('avg RPM near 702', Math.abs(r1.hotIdle.avgRpm - 702) < 5, String(r1.hotIdle.avgRpm));
check('RPM stddev small', r1.hotIdle.rpmStddev < 10, String(r1.hotIdle.rpmStddev));
check('fallback target 700', r1.targetRpm === 700, String(r1.targetRpm));
check('warm note names 160F', /160/.test(r1.warmNote), r1.warmNote);
check('ok message plain words', /not working hard|steady/i.test(r1.message),
  r1.message.slice(0, 60));

console.log('idle-diag: high IAC + on-target RPM => vacuum leak');
var r2 = P66.analyzeIdle(idleRows(60, steady(705, 3), steady(112, 4)), fakeMap());
check("verdict 'vacuum-leak-suspect'", r2.verdict === 'vacuum-leak-suspect', r2.verdict);
check('message names vacuum leak', /vacuum leak/i.test(r2.message), r2.message.slice(0, 50));
check('message names a hose to check', /hose|gasket/i.test(r2.message));

console.log('idle-diag: high IAC + low RPM => throttle misadjusted');
var r3 = P66.analyzeIdle(idleRows(60, steady(598, 3), steady(120, 4)), fakeMap());
check("verdict 'throttle-misadjusted-suspect'",
  r3.verdict === 'throttle-misadjusted-suspect', r3.verdict);
check('message names the throttle blade', /throttle blade/i.test(r3.message),
  r3.message.slice(0, 60));

console.log('idle-diag: jittery RPM => unstable idle');
var r4 = P66.analyzeIdle(
  idleRows(60, function (i) { return 700 + (i % 2 === 0 ? 85 : -85); }, steady(25, 2)),
  fakeMap());
check('stddev over threshold', r4.hotIdle.rpmStddev > 60, String(r4.hotIdle.rpmStddev));
check("verdict 'unstable-idle'", r4.verdict === 'unstable-idle', r4.verdict);
check('message lists causes', /vacuum leak/i.test(r4.message) && /idle air valve/i.test(r4.message));

console.log('idle-diag: no IAC channel => unavailable');
var r5 = P66.analyzeIdle(idleRows(60, steady(700, 2), steady(25, 2)), fakeMap(false));
check('available false', r5.available === false);
check('reason names the IAC channel', /iac/i.test(r5.reason), r5.reason);

console.log('idle-diag: too few hot-idle samples');
var r6 = P66.analyzeIdle(idleRows(8, steady(700, 2), steady(25, 2)), fakeMap());
check('available', r6.available === true);
check("verdict 'ok' with caveat", r6.verdict === 'ok');
check('message says not enough data', /not enough hot-idle data/i.test(r6.message));

console.log('idle-diag: cold rows excluded from hot idle');
// Mixed log: 30 warm rows (ect 182F => session max > 140, so the warm
// cut is the absolute 160F) followed by 60 cold rows (ect 120F).
var mixedRows = [];
for (var i = 0; i < 30; i++) {
  mixedRows.push({ rpm: 700, tps: 0, vss: 0, ect: 182, iac: 25 });
}
for (var c = 0; c < 60; c++) {
  mixedRows.push({ rpm: 900, tps: 0, vss: 0, ect: 120, iac: 60 });
}
var r7 = P66.analyzeIdle(mixedRows, fakeMap());
check('only warm samples counted', r7.hotIdle.samples === 30, String(r7.hotIdle.samples));
check('avg RPM from warm rows only', Math.abs(r7.hotIdle.avgRpm - 700) < 5,
  String(r7.hotIdle.avgRpm));

console.log('idle-diag: moving rows excluded from idle');
var moveRows = [];
for (var j = 0; j < 60; j++) {
  moveRows.push({ rpm: 1800, tps: 15, vss: 30, ect: 182, iac: 40 });
}
var r8 = P66.analyzeIdle(moveRows, fakeMap());
check('cruise samples not counted', r8.hotIdle.samples === 0, String(r8.hotIdle.samples));

console.log('idle-diag: Desired Idle Speed channel sets the target');
var r9 = P66.analyzeIdle(
  idleRows(60, steady(752, 3), steady(24, 2),
    { 'Desired Idle Speed': function () { return 750; } }),
  fakeMap());
check('target from Desired Idle Speed', r9.targetRpm === 750, String(r9.targetRpm));
check("verdict 'ok'", r9.verdict === 'ok', r9.verdict);

console.log('idle-diag: accepts a precomputed features bundle');
var t = P66.asTable(idleRows(60, steady(702, 2), steady(24, 2)));
var feats = P66.extractFeatures(t, fakeMap());
var r10 = P66.analyzeIdle(feats, fakeMap());
check('features input works', r10.available === true && r10.verdict === 'ok',
  r10.verdict);
check('features input samples', r10.hotIdle.samples === 60,
  String(r10.hotIdle.samples));

console.log('idle-diag: renderIdleDiagHTML');
var h1 = P66.renderIdleDiagHTML(r2);
check('html is a string', typeof h1 === 'string');
check('html carries the verdict label', /Possible vacuum leak/.test(h1));
check('html carries the numbers', /112/.test(h1) && /steps/.test(h1));
var h2 = P66.renderIdleDiagHTML(r5);
check('unavailable renders the reason', /idle air control channel/i.test(h2));
var h3 = P66.renderIdleDiagHTML(r1);
check('ok renders the good badge', /Idle looks good/.test(h3));
check('no jargon in ok html', !/PCM|ECU|VE table/i.test(h3));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
