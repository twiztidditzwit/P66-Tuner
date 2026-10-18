/* VE 3D surface math tests (projection + surface model are pure).
 * Run: node tools/vetable3d-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/xdf-map.js', 'js/dashboard.js', 'js/ve3d.js', 'js/bundled-catalog.js'].forEach(function (f) {
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

console.log('vepoints: stride sampling');
function fakeRows(n, fn) {
  var rows = [];
  for (var i = 0; i < n; i++) rows.push(fn(i));
  return rows;
}
var big = fakeRows(10000, function (i) { return { RPM: 800 + i, MAP: 30 + (i % 70) }; });
var s2000 = P66.vePointsSample(big, 'RPM', 'MAP', 2000);
check('10k rows -> 2000 points', s2000.length === 2000);
check('first point from row 0', s2000[0].rpm === 800 && s2000[0].map === 30);
check('even stride of 5 across the log', s2000[1].rpm === 805 && s2000[1999].rpm === 800 + 9995);
check('not just the first rows', s2000[1999].rpm > 800 + 1999, 'last=' + s2000[1999].rpm);

var few = fakeRows(50, function (i) { return { RPM: 1000 + i, MAP: 40 }; });
check('short log keeps every row', P66.vePointsSample(few, 'RPM', 'MAP', 2000).length === 50);

var gappy = fakeRows(9, function (i) {
  return { RPM: i % 3 === 0 ? 'n/a' : 1000 + i, MAP: 50 };
});
var sg = P66.vePointsSample(gappy, 'RPM', 'MAP', 3);
check('invalid rows dropped', sg.length === 3);
check('stride still spans the whole log', sg[0].rpm === 1001 && sg[1].rpm === 1004 && sg[2].rpm === 1007,
  JSON.stringify(sg.map(function (p) { return p.rpm; })));

check('null column -> []', P66.vePointsSample(big, null, 'MAP', 2000).length === 0);
check('empty rows -> []', P66.vePointsSample([], 'RPM', 'MAP', 2000).length === 0);
check('maxPoints 0 -> []', P66.vePointsSample(big, 'RPM', 'MAP', 0).length === 0);
check('default max is VE_POINTS_MAX', P66.vePointsSample(big, 'RPM', 'MAP').length === P66.VE_POINTS_MAX);

console.log('vepoints: range filtering');
var rpts = [{ rpm: 800, map: 30 }, { rpm: 400, map: 20 }, { rpm: 5000, map: 30 }, { rpm: 900, map: 105 }];
var kept = P66.vePointsInRange(rpts, [400, 800, 1200], [20, 60, 100]);
check('in-range kept (bounds inclusive), out-of-range dropped',
  kept.length === 2 && kept[0].rpm === 800 && kept[1].rpm === 400);
check('descending breakpoints handled',
  P66.vePointsInRange(rpts, [1200, 800, 400], [100, 60, 20]).length === 2);
check('missing breakpoints -> []', P66.vePointsInRange(rpts, [], [20, 60]).length === 0);
check('empty points -> []', P66.vePointsInRange([], [400, 800], [20, 60]).length === 0);

console.log('vepoints: axis fraction');
check('midpoint interpolates', approx(P66.veAxisFrac([0, 100, 200], 150), 1.5));
check('exact endpoints',
  P66.veAxisFrac([0, 100, 200], 0) === 0 && P66.veAxisFrac([0, 100, 200], 200) === 2);
check('out of range -> null', P66.veAxisFrac([0, 100, 200], 250) === null);
check('descending axis', approx(P66.veAxisFrac([200, 100, 0], 150), 0.5));
check('too few breakpoints -> null', P66.veAxisFrac([100], 100) === null);

console.log('vepoints: model mapping');
var synData = { rows: 2, cols: 2, rpmBp: [400, 800], mapBp: [20, 100] };
var synModel = {
  nodes: [
    [{ h: 0, rgb: [0, 0, 0] }, { h: 1, rgb: [0, 0, 0] }],
    [{ h: 2, rgb: [0, 0, 0] }, { h: 3, rgb: [0, 0, 0] }]
  ],
  rows: 2, cols: 2
};
var pmid = P66.vePointModel({ rpm: 600, map: 60 }, synModel, synData, 10);
check('cell center interpolates height', pmid !== null && approx(pmid.y, 15), 'y=' + (pmid && pmid.y));
check('cell center coords', pmid !== null && approx(pmid.x, 0) && approx(pmid.z, 0));
var p00 = P66.vePointModel({ rpm: 400, map: 20 }, synModel, synData, 10);
check('corner hits node', p00 !== null && approx(p00.y, 0) && approx(p00.x, -0.5) && approx(p00.z, -0.5));
check('out of range -> null', P66.vePointModel({ rpm: 900, map: 60 }, synModel, synData, 10) === null);

console.log('vepoints: source setter');
P66.setVePointsSource(null);
check('no source -> resolve null', P66._vePointsResolve(data) === null);
P66.setVePointsSource({ parsedLog: { rows: big }, mapResult: P66.mapChannels(['RPM', 'MAP']) });
var res = P66._vePointsResolve(data);
check('setter resolves sampled points',
  res !== null && res.rpmCol === 'RPM' && res.mapCol === 'MAP' &&
  res.points.length > 0 && res.points.length <= P66.VE_POINTS_MAX,
  'n=' + (res && res.points.length));
check('resolved points are plain {rpm,map}',
  res !== null && res.points.every(function (p) { return typeof p.rpm === 'number' && typeof p.map === 'number'; }));
check('resolved points all inside Main VE axis range',
  res !== null && res.points.every(function (p) {
    return p.rpm >= 0 && p.rpm <= 6400 && p.map >= 15 && p.map <= 100;
  }));
P66.setVePointsSource({ parsedLog: { rows: big }, mapResult: P66.mapChannels(['TPS', 'ECT']) });
check('missing RPM/MAP mapping -> resolve null', P66._vePointsResolve(data) === null);
P66.setVePointsSource(null);
check('clearing source -> resolve null', P66._vePointsResolve(data) === null);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
