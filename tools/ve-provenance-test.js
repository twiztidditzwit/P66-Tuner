/* VE cell provenance tests.
 * Run: node tools/ve-provenance-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/ve-provenance.js', 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// Fake geometry: 4x4, breakpoints chosen so bin ranges hit cleanly.
var AXES = {
  rows: 4, cols: 4,
  rpmBp: [800, 1200, 1600, 2000],
  mapBp: [20, 30, 40, 50]
};

function trimCell(rpmBin, mapBin, samples, idleFraction) {
  return { rpmBin: rpmBin, mapBin: mapBin, samples: samples, idleFraction: idleFraction || 0 };
}

var report = {
  fuelTrims: {
    available: true,
    cells: [
      // bin 800-1200 x 20-30 -> rows {0,1} x cols {0,1}, 60 samples, Main VE
      trimCell('800-1200', '20-30', 60, 0),
      // bin 1600-2000 x 40-50 -> rows {2,3} x cols {2,3}, 12 samples, Main VE
      trimCell('1600-2000', '40-50', 12, 0),
      // same region as the first, but idle-routed: must NOT count for Main VE
      trimCell('800-1200', '20-30', 9, 0.9)
    ]
  }
};

console.log('ve-provenance: measured vs interpolated (Main VE)');
var prov = P66.veCellProvenance(report, 'Main VE', { axes: AXES });
check('available', prov.available === true, prov.reason);
check('geometry 4x4', prov.rows === 4 && prov.cols === 4, prov.rows + 'x' + prov.cols);
check('corner cell measured with exact sample count',
  prov.cells[0][0].kind === 'measured' && prov.cells[0][0].samples === 60,
  JSON.stringify(prov.cells[0][0]));
check('trim cell fans out to every breakpoint in range',
  prov.cells[1][1].kind === 'measured' && prov.cells[1][1].samples === 60,
  JSON.stringify(prov.cells[1][1]));
check('second trim cell measured',
  prov.cells[3][3].kind === 'measured' && prov.cells[3][3].samples === 12,
  JSON.stringify(prov.cells[3][3]));
check('idle-routed cell does not leak into Main VE samples',
  prov.cells[0][0].samples === 60, 'samples=' + prov.cells[0][0].samples);
check('uncovered cell is interpolated with zero samples',
  prov.cells[0][3].kind === 'interpolated' && prov.cells[0][3].samples === 0,
  JSON.stringify(prov.cells[0][3]));
check('measured count 8, interpolated count 8',
  prov.measuredCount === 8 && prov.interpolatedCount === 8,
  prov.measuredCount + '/' + prov.interpolatedCount);
check('cells carry row/col and axis labels',
  prov.cells[1][2].row === 1 && prov.cells[1][2].col === 2 &&
  prov.cells[1][2].rpm === 1200 && prov.cells[1][2].map === 40,
  JSON.stringify(prov.cells[1][2]));

console.log('ve-provenance: confidence');
check('60 samples -> full confidence', prov.cells[0][0].confidence === 1, String(prov.cells[0][0].confidence));
check('12 samples -> 0.4', prov.cells[3][3].confidence === 0.4, String(prov.cells[3][3].confidence));
check('confidence monotonic in samples',
  prov.cells[0][0].confidence >= prov.cells[3][3].confidence);
check('tier high for 60 samples', prov.cells[0][0].tier === 'high', prov.cells[0][0].tier);
check('tier medium for 12 samples', prov.cells[3][3].tier === 'medium', prov.cells[3][3].tier);
// (0,2): nearest measured is (0,1) or (1,1), Chebyshev distance 1 -> 0.5, near
check('adjacent interpolated cell conf 0.5, tier near',
  prov.cells[0][2].confidence === 0.5 && prov.cells[0][2].tier === 'near',
  JSON.stringify(prov.cells[0][2]));
// (0,3): nearest measured (0,1)/(1,1)/(2,2) -> distance 2 -> 1/3, mid
check('two-ring interpolated cell conf 0.333, tier mid',
  prov.cells[0][3].confidence === 0.333 && prov.cells[0][3].tier === 'mid',
  JSON.stringify(prov.cells[0][3]));

console.log('ve-provenance: routing to Idle VE');
var idleAxes = { rows: 2, cols: 4, rpmBp: [800, 1200], mapBp: [20, 30, 40, 50] };
var idleProv = P66.veCellProvenance(report, 'Idle VE', { axes: idleAxes });
check('idle-routed cell measured in Idle VE',
  idleProv.cells[0][0].kind === 'measured' && idleProv.cells[0][0].samples === 9,
  JSON.stringify(idleProv.cells[0][0]));
check('main-routed cells do not leak into Idle VE',
  idleProv.cells[0][2].kind === 'interpolated', JSON.stringify(idleProv.cells[0][2]));
check('thin measured tier low', idleProv.cells[0][0].tier === 'low', idleProv.cells[0][0].tier);

console.log('ve-provenance: no fuel data -> all interpolated');
var empty = P66.veCellProvenance({ fuelTrims: { available: false } }, 'Main VE', { axes: AXES });
check('still available', empty.available === true);
check('zero measured', empty.measuredCount === 0, String(empty.measuredCount));
check('all interpolated', empty.interpolatedCount === 16, String(empty.interpolatedCount));
check('no measured cells -> interpolated confidence 0',
  empty.cells[0][0].confidence === 0 && empty.cells[0][0].tier === 'far',
  JSON.stringify(empty.cells[0][0]));

console.log('ve-provenance: geometry unavailable');
var noGeo = P66.veCellProvenance(report, 'Main VE', { catalog: { tables: [] } });
check('available false', noGeo.available === false);
check('reason explains', /no matching table/i.test(noGeo.reason), noGeo.reason);
check('empty cells', noGeo.cells.length === 0);

console.log('ve-provenance: bundled catalog geometry');
var catMain = P66.veCellProvenance(report, 'Main VE'); // defaults to P66.BUNDLED_CATALOG
check('Main VE 17x13', catMain.available && catMain.rows === 17 && catMain.cols === 13,
  (catMain.rows || '?') + 'x' + (catMain.cols || '?'));
var catIdle = P66.veCellProvenance(report, 'Idle VE');
check('Idle VE 7x13', catIdle.available && catIdle.rows === 7 && catIdle.cols === 13,
  (catIdle.rows || '?') + 'x' + (catIdle.cols || '?'));

console.log('ve-provenance: class hooks');
check('measured class', P66.veProvenanceClass({ kind: 'measured', tier: 'high' }) ===
  've-prov-measured ve-prov-high', P66.veProvenanceClass({ kind: 'measured', tier: 'high' }));
check('interpolated class', P66.veProvenanceClass({ kind: 'interpolated', tier: 'far' }) ===
  've-prov-interp ve-prov-far', P66.veProvenanceClass({ kind: 'interpolated', tier: 'far' }));
// Word boundaries: 'measured' itself contains the substring 'red'.
check('class has no blue/red semantics',
  !/\bblue\b|\bred\b/.test(P66.veProvenanceClass({ kind: 'measured', tier: 'high' })) &&
  !/\bblue\b|\bred\b/.test(P66.veProvenanceClass({ kind: 'interpolated', tier: 'far' })));
check('null cell -> empty', P66.veProvenanceClass(null) === '');

console.log('ve-provenance: color hook');
var base = 'rgb(255,77,60)'; // strong rich/remove red from the trim ramp
check('measured passes through', P66.veProvenanceColor({ kind: 'measured', tier: 'high' }, base) === base);
var adj = P66.veProvenanceColor({ kind: 'interpolated', tier: 'mid' }, base);
check('interpolated returns rgb() string', /^rgb\(\d+,\d+,\d+\)$/.test(adj), adj);
var spread = function (s) {
  var m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(s);
  return Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]);
};
check('interpolated is desaturated (red-green spread shrinks)', spread(adj) < spread(base),
  'base spread ' + spread(base) + ' -> ' + spread(adj));
check('hue direction survives (still reddish)', (function () {
  var m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(adj);
  return +m[1] > +m[3];
})(), adj);
check('hex base also handled', /^rgb\(/.test(P66.veProvenanceColor({ kind: 'interpolated', tier: 'far' }, '#3890ff')));
check('unparseable base returned unchanged',
  P66.veProvenanceColor({ kind: 'interpolated', tier: 'far' }, 'banana') === 'banana');
check('null cell returns base', P66.veProvenanceColor(null, base) === base);

console.log('ve-provenance: tooltips');
check('measured tip', P66.veProvenanceTip({ kind: 'measured', samples: 42, tier: 'high' }) ===
  'Measured — 42 log samples', P66.veProvenanceTip({ kind: 'measured', samples: 42, tier: 'high' }));
check('thin measured tip flags thin',
  /\(thin\)/.test(P66.veProvenanceTip({ kind: 'measured', samples: 5, tier: 'low' })),
  P66.veProvenanceTip({ kind: 'measured', samples: 5, tier: 'low' }));
check('interpolated tip',
  P66.veProvenanceTip({ kind: 'interpolated', tier: 'mid' }) ===
  'Interpolated — no direct samples, blended from neighbors',
  P66.veProvenanceTip({ kind: 'interpolated', tier: 'mid' }));
check('null tip empty', P66.veProvenanceTip(null) === '');

console.log('ve-provenance: legend');
var legend = P66.veProvenanceLegendHTML();
check('legend is a string', typeof legend === 'string');
check('legend mentions Measured', /Measured/.test(legend));
check('legend mentions Interpolated', /Interpolated/.test(legend));
check('legend uses provenance classes', /ve-prov-measured/.test(legend) && /ve-prov-interp/.test(legend));
check('legend has no blue/red semantics', !/\bblue\b|\bred\b/i.test(legend));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
