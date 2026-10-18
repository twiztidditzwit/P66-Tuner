/* Spark table before/after data tests.
 * Run: node tools/sparkviz-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/xdf-map.js', 'js/dashboard.js', 'js/ve3d.js', 'js/bundled-catalog.js', 'js/ledger.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function approx(a, b) { return Math.abs(a - b) < 1e-9; }

// dashboard.js is DOM-heavy, but sparkComparisonData / sparkKnockOverlay /
// sparkDegPerRaw are pure — safe in node (same approach as vetable-test.js).

var catalog = P66.BUNDLED_CATALOG;
var spark = P66.readTable(catalog, 'Main Spark Advance', new Uint8Array(65536));
var base = spark.base, eb = spark.elementBytes, rows = spark.rows, cols = spark.cols;
function addr(r, c) { return base + (r * cols + c) * eb; }

// Synthetic bin: raw value = 60 + r*2 + c (unique per cell, fits 8-bit).
var bin = new Uint8Array(65536);
function rawVal(r, c) { return 60 + r * 2 + c; }
for (var r = 0; r < rows; r++) {
  for (var c = 0; c < cols; c++) bin[addr(r, c)] = rawVal(r, c);
}
var DEG = 90 / 255; // bundled Main Spark Advance equation X*(90/255)
function degOf(raw) { return Math.round(raw * DEG * 10) / 10; }

function sparkPatch(r, c, deltaDeg, smoothed) {
  var oldRaw = rawVal(r, c);
  var rawDelta = Math.round(deltaDeg * (255 / 90));
  return {
    table: 'Main Spark Advance', address: addr(r, c),
    addressHex: '0x' + addr(r, c).toString(16).toUpperCase(),
    oldValue: oldRaw, newValue: oldRaw + rawDelta,
    deltaDeg: deltaDeg, smoothed: !!smoothed, rpm: 2800, map: 70
  };
}

console.log('sparkviz: degPerRaw helper');
var dpr = P66._sparkDegPerRaw(spark.table);
check('degPerRaw is 90/255', approx(dpr, 90 / 255), String(dpr));
check('unparseable equation -> null', P66._sparkDegPerRaw({ zAxis: { equation: 'log(X)' } }) === null);

console.log('sparkviz: data builder');
var patches = [sparkPatch(11, 10, -2), sparkPatch(5, 5, -1.5, true), sparkPatch(11, 10, -2)];
var data = P66.sparkComparisonData(catalog, bin, patches, null);
check('no error', !data.error, data.error);
check('geometry 17x17', data.rows === 17 && data.cols === 17, data.rows + 'x' + data.cols);
check('before is degrees', data.before[11][10] === degOf(rawVal(11, 10)) &&
  data.before[0][0] === degOf(rawVal(0, 0)), String(data.before[11][10]));
check('after applies patch in raw then converts',
  data.after[11][10] === degOf(rawVal(11, 10) + Math.round(-2 * (255 / 90))),
  String(data.after[11][10]));
check('untouched cell identical', data.after[0][0] === data.before[0][0]);
check('delta recorded in degrees', data.deltas[5][5] && data.deltas[5][5].deltaDeg === -1.5);
check('smoothed flagged', data.deltas[5][5] && data.deltas[5][5].smoothed === true);
check('changed counts patch entries', data.changed === 3, String(data.changed));
check('biggest is -2°', data.biggest && data.biggest.deltaDeg === -2, JSON.stringify(data.biggest));
check('axes present', data.rpmBp.length === 17 && data.mapBp.length === 17);
check('guardrail limit from ledger', data.sparkDegLimit === 6, String(data.sparkDegLimit));

console.log('sparkviz: non-spark patches ignored');
var fuelish = { table: 'Main VE', address: addr(2, 2), addressHex: '0xEAA', deltaPct: 5, oldValue: 100, newValue: 105 };
var wrongTable = { table: 'Main VE', address: 0xEAA, addressHex: '0xEAA', deltaDeg: -2, oldValue: 100, newValue: 98 };
var data2 = P66.sparkComparisonData(catalog, bin, [fuelish, wrongTable, sparkPatch(1, 1, -2)]);
check('only the spark patch counts', data2.changed === 1, String(data2.changed));

console.log('sparkviz: empty tune shows stock table');
var data3 = P66.sparkComparisonData(catalog, bin, [], null);
check('no error', !data3.error);
check('zero changed', data3.changed === 0);
check('after equals before', data3.after[3][3] === data3.before[3][3]);
check('no biggest', data3.biggest === null);
check('no knock overlay', Object.keys(data3.knockOverlay).length === 0);

console.log('sparkviz: knock overlay mapping');
var knock = {
  available: true,
  events: [
    { rpm: 2810, map: 72, peakKR: 4.5, samples: 6 },
    { rpm: 2790, map: 68, peakKR: 2.0, samples: 3 },
    { rpm: null, map: 70, peakKR: 3.0, samples: 2 } // unmappable: skipped
  ]
};
var data4 = P66.sparkComparisonData(catalog, bin, [], knock);
var ov = data4.knockOverlay;
// spark rpmBp: 400..4800 (17); 2810 -> nearest 2800 (row 11). mapBp 20..100 (17); 72 -> 70 (col 10).
check('events map to nearest cell', !!ov['11,10'], JSON.stringify(Object.keys(ov)));
check('event count accumulates', ov['11,10'] && ov['11,10'].events === 2);
check('peak KR is the max', ov['11,10'] && ov['11,10'].peakKR === 4.5);
check('only one cell flagged', Object.keys(ov).length === 1, String(Object.keys(ov).length));

console.log('sparkviz: nearest-cell helper');
var nc = P66._sparkNearestCell(data4.rpmBp, data4.mapBp, 2810, 72);
check('row 11 col 10', nc && nc.row === 11 && nc.col === 10, JSON.stringify(nc));
check('null rpm -> null', P66._sparkNearestCell(data4.rpmBp, data4.mapBp, null, 72) === null);

console.log('sparkviz: 3D surface model accepts spark deltas');
var m = P66.veSurfaceModel(data, 'change');
var changedCell = m.nodes[11][10];
check('signed height from deltaDeg', changedCell.h < 0, String(changedCell.h));
var untouchedCell = m.nodes[0][0];
check('untouched cell flat', untouchedCell.h === 0, String(untouchedCell.h));

console.log('sparkviz: guardrail fallback without ledger');
delete P66.LEDGER_LIMITS;
var data5 = P66.sparkComparisonData(catalog, bin, [], null);
check('falls back to ±6°', data5.sparkDegLimit === 6, String(data5.sparkDegLimit));

console.log('sparkviz: missing table errors cleanly');
var data6 = P66.sparkComparisonData({ tables: [] }, bin, [], null);
check('error returned', !!data6.error, data6.error);

console.log('sparkviz: unsupported equation errors cleanly');
var badCat = JSON.parse(JSON.stringify(catalog));
badCat.tables.forEach(function (t) {
  if (t.title === 'Main Spark Advance') t.zAxis.equation = 'log(X)';
});
var data7 = P66.sparkComparisonData(badCat, bin, [], null);
check('error returned, no guessing', !!data7.error && /refusing to guess/.test(data7.error), data7.error);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
