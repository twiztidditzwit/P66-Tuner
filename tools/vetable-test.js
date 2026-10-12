/* VE table before/after data tests.
 * Run: node tools/vetable-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/xdf-map.js', 'js/dashboard.js', 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// dashboard.js needs `document` at load for nothing (only inside functions),
// but veComparisonData is pure — safe in node.

var catalog = P66.BUNDLED_CATALOG;
var ve = P66.readTable(catalog, 'Main VE', new Uint8Array(65536));
var base = ve.base, eb = ve.elementBytes, rows = ve.rows, cols = ve.cols;
function addr(r, c) { return base + (r * cols + c) * eb; }

// Synthetic bin: cell value = 500 + r*10 + c (unique per cell, 16-bit BE).
var bin = new Uint8Array(65536);
function cellVal(r, c) { return 500 + r * 10 + c; }
for (var r = 0; r < rows; r++) {
  for (var c = 0; c < cols; c++) {
    var v = cellVal(r, c), a = addr(r, c);
    bin[a] = (v >> 8) & 0xFF;
    bin[a + 1] = v & 0xFF;
  }
}

function fuelPatch(r, c, pct, smoothed) {
  var oldValue = cellVal(r, c);
  return {
    table: 'Main VE', address: addr(r, c),
    addressHex: '0x' + addr(r, c).toString(16).toUpperCase(),
    oldValue: oldValue, newValue: Math.round(oldValue * (1 + pct / 100)),
    deltaPct: pct, smoothed: !!smoothed, rpm: 1000 + r * 500, map: 30 + c * 5
  };
}

console.log('vetable: data builder');
var patches = [fuelPatch(2, 3, 5), fuelPatch(5, 5, -3, true), fuelPatch(2, 3, 5)]; // dup address ok
var data = P66.veComparisonData(catalog, bin, patches);
check('no error', !data.error, data.error);
check('geometry 17x13', data.rows === 17 && data.cols === 13, data.rows + 'x' + data.cols);
check('before matches bin', data.before[2][3] === cellVal(2, 3) && data.before[0][0] === cellVal(0, 0));
check('after applies patch', data.after[2][3] === Math.round(cellVal(2, 3) * 1.05), String(data.after[2][3]));
check('untouched cell identical', data.after[0][0] === data.before[0][0]);
check('delta recorded', data.deltas[5][5] && data.deltas[5][5].deltaPct === -3);
check('smoothed flagged', data.deltas[5][5] && data.deltas[5][5].smoothed === true);
check('changed counts patch entries', data.changed === 3, String(data.changed));
check('biggest is +5%', data.biggest && data.biggest.deltaPct === 5, JSON.stringify(data.biggest));
check('axes present', data.rpmBp.length === 17 && data.mapBp.length === 13);

console.log('vetable: non-VE patches ignored');
var sparkish = { table: 'Main Spark', address: 0x39, addressHex: '0x39', deltaDeg: -2, oldValue: 30, newValue: 28 };
var peish = { table: 'PE', address: 0xFFFF, addressHex: '0xFFFF', deltaPct: 4, oldValue: 10, newValue: 10 };
var data2 = P66.veComparisonData(catalog, bin, [sparkish, peish, fuelPatch(1, 1, 2)]);
check('only the VE fuel patch counts', data2.changed === 1, String(data2.changed));

console.log('vetable: empty tune shows stock table');
var data3 = P66.veComparisonData(catalog, bin, []);
check('no error', !data3.error);
check('zero changed', data3.changed === 0);
check('after equals before', data3.after[3][3] === data3.before[3][3]);
check('no biggest', data3.biggest === null);

console.log('vetable: missing table errors cleanly');
var data4 = P66.veComparisonData({ tables: [] }, bin, []);
check('error returned', !!data4.error, data4.error);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
