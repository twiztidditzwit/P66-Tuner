/* Sample-quality gating tests: warmup + transient exclusion.
 * Run: node tools/quality-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// Fake mapResult: columns keyed by header name.
function fakeMap(withEct) {
  var mapping = {
    RPM: { column: 'rpm' }, MAP: { column: 'map' }, TPS: { column: 'tps' },
    STFT: { column: 'stft' }, LTFT: { column: 'ltft' },
    O2_B1: { column: 'o2' }
  };
  if (withEct) mapping.ECT = { column: 'ect' };
  return { mapping: mapping, unmapped: [] };
}

// 200 rows: first 50 cold (ECT 100F), rest warm (190F). Steady cruise.
// Cold rows run +12% trim (cold enrichment); warm rows run +2%.
function makeRows(ectUnit) {
  var rows = [];
  for (var i = 0; i < 200; i++) {
    var cold = i < 50;
    var ectF = cold ? 100 : 190;
    rows.push({
      rpm: 2000, map: 45, tps: 20,
      ect: ectUnit === 'C' ? (ectF - 32) * 5 / 9 : ectF,
      stft: cold ? 12 : 2, ltft: 0, o2: cold ? 150 : 450,
      _region: 'cruise'
    });
  }
  return rows;
}

console.log('quality: warmup gating (F)');
var q1 = P66.qualityRows(makeRows('F'), fakeMap(true));
check('gates 50 cold rows', q1.gatedWarmup === 50, 'gated=' + q1.gatedWarmup);
check('keeps 150 warm rows', q1.rows.length === 150, 'kept=' + q1.rows.length);
check('ect available', q1.ectAvailable === true);

console.log('quality: warmup gating (C / ambiguous band)');
var q2 = P66.qualityRows(makeRows('C'), fakeMap(true));
// Ambiguous band (max ~88C): relative threshold = max-10 cuts the cold edge.
check('gates the cold edge', q2.gatedWarmup > 0 && q2.gatedWarmup < 100, 'gated=' + q2.gatedWarmup);
check('note names relative threshold', /session max/.test(q2.warmNote), q2.warmNote);

console.log('quality: transient exclusion');
var rows3 = makeRows('F');
rows3.forEach(function (r, i) { if (i % 10 === 0) r._region = 'transient'; });
var q3 = P66.qualityRows(rows3, fakeMap(true));
// 20 transient rows: 5 of them in the cold 50, 15 in the warm 150
check('transients excluded', q3.gatedTransient === 20, 'gated=' + q3.gatedTransient);
check('warmup count excludes transients already removed', q3.gatedWarmup === 45, 'gated=' + q3.gatedWarmup);

console.log('quality: no ECT channel');
var q4 = P66.qualityRows(makeRows('F'), fakeMap(false));
check('no warmup gating without ECT', q4.gatedWarmup === 0 && q4.rows.length === 200);
check('note says unavailable', /unavailable/.test(q4.warmNote));

console.log('quality: null ECT kept');
var rows5 = makeRows('F');
rows5[100].ect = null; rows5[101].ect = null;
var q5 = P66.qualityRows(rows5, fakeMap(true));
check('null-ECT rows kept', q5.rows.length === 150, 'kept=' + q5.rows.length);

console.log('quality: fuel trims use gated rows');
var fr = P66.analyzeFuelTrims(makeRows('F'), fakeMap(true));
// Warm rows average +2% trim; without gating the cold +12% rows would drag it up.
var cell = fr.cells[0];
check('cell avg reflects warm rows only', Math.abs(cell.avgTrim - 2) < 0.5, 'avgTrim=' + cell.avgTrim);
check('gating reported', fr.qualityGating.gatedWarmup === 50, JSON.stringify(fr.qualityGating));
check('all samples used are warm', fr.totalSamples === 150, 'total=' + fr.totalSamples);

console.log('quality: narrowband uses gated rows');
var nb = P66.analyzeNarrowband(makeRows('F'), fakeMap(true));
var nbCell = nb.cells[0];
check('O2 avg reflects warm rows only', nbCell.avgMv > 400, 'avgMv=' + nbCell.avgMv);
check('narrowband gating reported', nb.qualityGating.gatedWarmup === 50);

console.log('quality: rising cold-start edge gated (never fully warm, F)');
var riseRows = [];
for (var i = 0; i < 200; i++) {
  riseRows.push({
    rpm: 2000, map: 45, tps: 20, ect: 60 + i * 0.25, // 60 -> 110F, never hits 160
    stft: 8, ltft: 0, o2: 200, _region: 'cruise'
  });
}
var q6 = P66.qualityRows(riseRows, fakeMap(true));
check('cold edge gated', q6.gatedWarmup > 0, 'gated=' + q6.gatedWarmup);
check('hottest rows kept', q6.rows.length > 0 && q6.rows.length < 200, 'kept=' + q6.rows.length);
check('note is explicit', /session max/.test(q6.warmNote), q6.warmNote);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
