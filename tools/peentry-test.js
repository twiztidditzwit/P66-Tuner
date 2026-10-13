/* PE entry (power enrichment engagement) tests.
 * Run: node tools/peentry-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/xdf-map.js', 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap(withCmd) {
  var m = { mapping: { TPS: { column: 'tps' } }, unmapped: [] };
  if (withCmd) m.mapping.CMD_LAMBDA = { column: 'cmdlambda' };
  return m;
}

// Rows: cruise baseline, then episodes of TPS 75 held 10 samples.
// peMode: 'never' (lambda stays 1.0), 'prompt' (lambda 0.85 from sample 2),
// 'slow' (lambda 0.85 from sample 8).
function makeRows(nEpisodes, peMode) {
  var rows = [];
  function cruise(n) {
    for (var i = 0; i < n; i++) rows.push({ tps: 20, cmdlambda: 1.0 });
  }
  cruise(20);
  for (var e = 0; e < nEpisodes; e++) {
    for (var s = 0; s < 10; s++) {
      var lambda = 1.0;
      if (peMode === 'prompt' && s >= 2) lambda = 0.85;
      if (peMode === 'slow' && s >= 8) lambda = 0.85;
      rows.push({ tps: 75, cmdlambda: lambda });
    }
    cruise(20);
  }
  return rows;
}

function genFor(peEntry) {
  return P66.generateSuggestions({ fuelTrims: { available: false }, knock: { available: false },
    lambda: { available: false }, narrowband: { available: false }, bankImbalance: { available: false },
    tipIn: { available: false }, peEntry: peEntry }, 'conservative');
}

console.log('peentry: no PE engagement suggests earlier entry');
var r1 = P66.analyzePeEntry(makeRows(4, 'never'), fakeMap(true));
check('available', r1.available === true);
check('4 episodes', r1.episodes === 4, String(r1.episodes));
check('0 engaged', r1.peEngaged === 0);
var s1 = genFor(r1).actionable.filter(function (s) { return s.kind === 'pe-entry'; });
check('one pe-entry suggestion', s1.length === 1, String(s1.length));
check('action is lower', s1[0] && s1[0].action === 'lower');
check('delta negative, capped at -10', s1[0] && s1[0].deltaPct < 0 && s1[0].deltaPct >= -10,
  s1[0] && String(s1[0].deltaPct));

console.log('peentry: prompt PE engagement -> no suggestion');
var r2 = P66.analyzePeEntry(makeRows(4, 'prompt'), fakeMap(true));
check('all engaged', r2.peEngaged === 4, String(r2.peEngaged));
check('delay ~2 samples', r2.avgDelaySamples === 2, String(r2.avgDelaySamples));
var s2 = genFor(r2).actionable.filter(function (s) { return s.kind === 'pe-entry'; });
check('no suggestion', s2.length === 0);

console.log('peentry: slow PE engagement suggests earlier entry');
// 20-sample episodes, PE engages at sample 16 (~2.3 s) — genuinely slow.
function slowRows() {
  var rows = [];
  function cruise(n) {
    for (var i = 0; i < n; i++) rows.push({ tps: 20, cmdlambda: 1.0 });
  }
  cruise(20);
  for (var e = 0; e < 4; e++) {
    for (var s = 0; s < 20; s++) {
      rows.push({ tps: 75, cmdlambda: s >= 16 ? 0.85 : 1.0 });
    }
    cruise(20);
  }
  return rows;
}
var r3 = P66.analyzePeEntry(slowRows(), fakeMap(true));
check('all engaged but slow', r3.peEngaged === 4 && r3.avgDelaySec > 2,
  r3.peEngaged + '/' + r3.avgDelaySec);
var s3 = genFor(r3).actionable.filter(function (s) { return s.kind === 'pe-entry'; });
check('suggestion present', s3.length === 1);

console.log('peentry: too few episodes -> no suggestion');
var r4 = P66.analyzePeEntry(makeRows(2, 'never'), fakeMap(true));
check('2 episodes', r4.episodes === 2);
var s4 = genFor(r4).actionable.filter(function (s) { return s.kind === 'pe-entry'; });
check('no suggestion', s4.length === 0);

console.log('peentry: missing commanded lambda -> unavailable');
var r5 = P66.analyzePeEntry(makeRows(4, 'never'), fakeMap(false));
check('unavailable', r5.available === false, r5.reason);

console.log('peentry: patcher lowers the threshold table with a floor');
var catalog = P66.BUNDLED_CATALOG;
var bin = new Uint8Array(65536);
var t = P66.findTable(catalog, 'TPS% Threshold to Enter PE vs RPM');
var base = parseInt(t.address, 16);
for (var i = 0; i < 17; i++) bin[base + i] = i < 11 ? 179 : 154; // stock-ish
var pr = P66.applyPeEntrySuggestions(catalog, bin, s1);
check('no patch error', !pr.error, pr.error);
check('17 patches', pr.patches.length === 17, String(pr.patches.length));
// conservative: min(10, 5*2) = 10 -> 179 * 0.9 = 161.1 -> 161
var p0 = pr.patches[0];
check('179 -> 161', p0.oldValue === 179 && p0.newValue === 161,
  p0.oldValue + '->' + p0.newValue);
check('table named', p0.table === 'TPS% Threshold to Enter PE vs RPM', p0.table);
// Floor: force a tiny raw value, ensure it floors at 128.
var bin2 = new Uint8Array(65536);
for (var j = 0; j < 17; j++) bin2[base + j] = 130;
var pr2 = P66.applyPeEntrySuggestions(catalog, bin2, s1);
check('floor respected', pr2.patches.every(function (p) { return p.newValue >= 128; }),
  JSON.stringify(pr2.patches.map(function (p) { return p.newValue; }).slice(0, 3)));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
