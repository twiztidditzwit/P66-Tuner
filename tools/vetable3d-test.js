/* VE 3D surface math tests (projection + surface model are pure).
 * Run: node tools/vetable3d-test.js
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
function approx(a, b) { return Math.abs(a - b) < 1e-9; }

console.log('3d: rotation identities');
var r0 = P66._veRotate(1, 2, 3, 0, 0);
check('zero rotation is identity', approx(r0.x1, 1) && approx(r0.y2, 2) && approx(r0.z2, 3));
var rPi = P66._veRotate(1, 0, 0, Math.PI, 0);
check('azimuth PI flips x', approx(rPi.x1, -1) && approx(rPi.z2, 0));
var rQ = P66._veRotate(0, 0, 1, Math.PI / 2, 0);
check('azimuth PI/2 maps +z to -x', approx(rQ.x1, -1) && approx(rQ.z2, 0));
var rE = P66._veRotate(0, 1, 0, 0, Math.PI / 2);
check('elevation PI/2 sends +y to depth', approx(rE.y2, 0) && approx(rE.z2, 1));
var rFull = P66._veRotate(1, 2, 3, Math.PI * 2, 0);
check('azimuth 2PI returns to start', approx(rFull.x1, 1) && approx(rFull.z2, 3));

console.log('3d: depth ordering is consistent');
var near = P66._veRotate(0, 5, 0, 0, 0.9);   // tall point
var far = P66._veRotate(0, 0, 0, 0, 0.9);    // ground point, same x/z
check('taller point is closer (drawn later)', near.z2 > far.z2);

console.log('3d: bilinear interpolation');
var B = P66._veBilinear;
check('corner (0,0)', approx(B(1, 2, 3, 4, 0, 0), 1));
check('corner (1,1)', approx(B(1, 2, 3, 4, 1, 1), 4));
check('edge midpoint', approx(B(0, 10, 20, 30, 0.5, 0), 5));
check('center', approx(B(0, 10, 20, 30, 0.5, 0.5), 15));
check('linear along u', approx(B(0, 10, 0, 10, 0.25, 0.7), 2.5));

console.log('3d: face lighting');
function lightArgs(az, el) {
  return [Math.cos(az), Math.sin(az), Math.cos(el), Math.sin(el)];
}
var flat = P66._veFaceLight(0, 0, 0, 0, Math.cos(0.95), Math.sin(0.95));
check('flat surface brightness in range', flat > 0.55 && flat <= 1, 'b=' + flat);
var slope = P66._veFaceLight(3, 0, 0, 0, Math.cos(0.95), Math.sin(0.95));
check('slope shades differently than flat', Math.abs(slope - flat) > 0.01, 'flat=' + flat + ' slope=' + slope);
check('brightness bounded [0.55,1] over rotations', (function () {
  for (var a = 0; a < 6.3; a += 0.7) {
    for (var e = 0.2; e < 1.45; e += 0.3) {
      var b2 = P66._veFaceLight(1.5, -2, Math.cos(a), Math.sin(a), Math.cos(e), Math.sin(e));
      if (!(b2 >= 0.55 && b2 <= 1)) return false;
    }
  }
  return true;
})());

console.log('3d: surface model (node-based)');
var catalog = P66.BUNDLED_CATALOG;
var ve = P66.readTable(catalog, 'Main VE', new Uint8Array(65536));
var base = ve.base, eb = ve.elementBytes, rows = ve.rows, cols = ve.cols;
var bin = new Uint8Array(65536);
function cellVal(r, c) { return 500 + r * 10 + c; }
for (var r = 0; r < rows; r++) {
  for (var c = 0; c < cols; c++) {
    var v = cellVal(r, c), a = base + (r * cols + c) * eb;
    bin[a] = (v >> 8) & 0xFF; bin[a + 1] = v & 0xFF;
  }
}
function fuelPatch(r, c, pct) {
  var a = base + (r * cols + c) * eb;
  return { table: 'Main VE', address: a, addressHex: '0x' + a.toString(16).toUpperCase(),
    oldValue: cellVal(r, c), newValue: Math.round(cellVal(r, c) * (1 + pct / 100)), deltaPct: pct };
}
var data = P66.veComparisonData(catalog, bin, [fuelPatch(2, 3, 8), fuelPatch(4, 4, -4)]);

var mChange = P66.veSurfaceModel(data, 'change');
check('change: node grid matches table dims',
  mChange.nodes.length === rows && mChange.nodes[0].length === cols);
var bump = mChange.nodes[2][3], dip = mChange.nodes[4][4], flatN = mChange.nodes[0][0];
check('change: positive delta node -> h=1 (max)', approx(bump.h, 1), 'h=' + bump.h);
check('change: negative delta node -> h=-0.5', approx(dip.h, -0.5), 'h=' + dip.h);
check('change: untouched node -> h=0', flatN.h === 0);
check('change: node colors are rgb triples',
  bump.rgb.length === 3 && dip.rgb.length === 3 && flatN.rgb.length === 3);
check('change: colors differ by sign',
  bump.rgb.join() !== dip.rgb.join());

var mBefore = P66.veSurfaceModel(data, 'before');
var hs = [];
mBefore.nodes.forEach(function (row) { row.forEach(function (nd) { hs.push(nd.h); }); });
check('before: heights in [0,1]', Math.min.apply(null, hs) >= 0 && Math.max.apply(null, hs) <= 1);
check('before: tallest node is max value corner', approx(Math.max.apply(null, hs), 1));
check('before: rgb values are bytes',
  mBefore.nodes.every(function (row) {
    return row.every(function (nd) {
      return nd.rgb.every(function (ch) { return ch >= 0 && ch <= 255; });
    });
  }));

var mEmpty = P66.veSurfaceModel(P66.veComparisonData(catalog, bin, []), 'change');
check('change: all flat when no patches',
  mEmpty.nodes.every(function (row) { return row.every(function (nd) { return nd.h === 0; }); }));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
