/* Patch convergence check ("did my last patch work?") tests.
 * Run: node tools/convergence-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/convergence.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- module surface ----
check('checkConvergence exported', typeof P66.checkConvergence === 'function');
check('renderConvergenceHTML exported', typeof P66.renderConvergenceHTML === 'function');
check('margin constant is 3%', P66.CONVERGENCE_MARGIN_PCT === 3);
check('min after-samples constant is 20', P66.CONVERGENCE_MIN_SAMPLES === 20);

// ---- synthetic session reports: percent trim cells (0 = stoich) ----
function cell(rpmBin, mapBin, avgTrim, stddev, samples) {
  return { rpmBin: rpmBin, mapBin: mapBin, avgTrim: avgTrim, stddev: stddev, samples: samples };
}
function report(cells) {
  return { fuelTrims: { available: true, cells: cells } };
}
function fuelPatch(table, cellLabel, deltaPct) {
  return { table: table, cell: cellLabel, kind: 'fuel', action: deltaPct > 0 ? 'add fuel' : 'remove fuel',
           deltaPct: deltaPct, confidence: 'high' };
}
function patchSet(patches) {
  return { id: 'ps_test', appliedAt: '2026-10-22T19:00:00Z',
           beforeLog: 'before.csv', afterLog: 'after.csv', patches: patches };
}
function regionFor(res, table, cellLabel) {
  return res.regions.filter(function (r) { return r.table === table && r.cell === cellLabel; })[0];
}

// (a) trims converge -> 'converged'
var beforeA = report([cell('1000-1500', '40-50', 8.2, 1.5, 60)]);
var afterA  = report([cell('1000-1500', '40-50', 1.1, 1.2, 55)]);
var resA = P66.checkConvergence(beforeA, afterA,
  patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.2)]));
check('(a) available', resA.available === true);
var regA = regionFor(resA, 'Main VE', '1000-1500 RPM / 40-50 kPa');
check('(a) converged', !!regA && regA.verdict === 'converged', JSON.stringify(regA));
check('(a) plain-words region name', !!regA && regA.region === 'main VE, low rpm, light load',
  regA && regA.region);
check('(a) before/after carried', !!regA && regA.before.avgTrim === 8.2 && regA.after.avgTrim === 1.1,
  JSON.stringify(regA && { b: regA.before, a: regA.after }));
check('(a) summary counts', resA.summary.converged === 1 && resA.summary.total === 1,
  JSON.stringify(resA.summary));
check('(a) summary text plain English', typeof resA.summary.text === 'string' && /settled toward stoich/.test(resA.summary.text),
  resA.summary.text);

// (b) trims unchanged -> 'not-converged'
var beforeB = report([cell('2000-2500', '60-70', 8.0, 1.0, 60)]);
var afterB  = report([cell('2000-2500', '60-70', 7.5, 1.1, 50)]);
var resB = P66.checkConvergence(beforeB, afterB,
  patchSet([fuelPatch('Idle VE', '2000-2500 RPM / 60-70 kPa', 5.0)]));
var regB = regionFor(resB, 'Idle VE', '2000-2500 RPM / 60-70 kPa');
check('(b) not-converged', !!regB && regB.verdict === 'not-converged', JSON.stringify(regB));
check('(b) region name for idle VE', !!regB && regB.region === 'idle VE, mid rpm, part load',
  regB && regB.region);
check('(b) detail mentions no movement', !!regB && /No real movement/.test(regB.detail), regB && regB.detail);

// (c) after-log missing the region -> 'inconclusive'
var beforeC = report([cell('3000-3500', '80-90', 6.5, 1.0, 60)]);
var afterC  = report([cell('1000-1500', '40-50', 1.0, 1.0, 50)]); // different zone
var resC = P66.checkConvergence(beforeC, afterC,
  patchSet([fuelPatch('Main VE', '3000-3500 RPM / 80-90 kPa', 6.5)]));
var regC = regionFor(resC, 'Main VE', '3000-3500 RPM / 80-90 kPa');
check('(c) inconclusive', !!regC && regC.verdict === 'inconclusive', JSON.stringify(regC));
check('(c) detail says zone missing from after-log', !!regC && /after-log/.test(regC.detail),
  regC && regC.detail);
check('(c) summary inconclusive count', resC.summary.inconclusive === 1, JSON.stringify(resC.summary));

// (d) empty patch set -> sensible empty result
var resD = P66.checkConvergence(beforeA, afterA, patchSet([]));
check('(d) empty: available', resD.available === true);
check('(d) empty: no regions', resD.regions.length === 0);
check('(d) empty: zero totals', resD.summary.total === 0 && resD.summary.converged === 0 &&
  resD.summary.notConverged === 0 && resD.summary.inconclusive === 0, JSON.stringify(resD.summary));
check('(d) empty: sensible text', /nothing to check/i.test(resD.summary.text), resD.summary.text);

// ---- worse: trims moved away from stoich -> 'not-converged' ----
var resW = P66.checkConvergence(report([cell('1000-1500', '40-50', 4.0, 1.0, 60)]),
                                report([cell('1000-1500', '40-50', 9.0, 1.0, 50)]),
                                patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', -4.0)]));
var regW = regionFor(resW, 'Main VE', '1000-1500 RPM / 40-50 kPa');
check('worse: not-converged', !!regW && regW.verdict === 'not-converged', JSON.stringify(regW));
check('worse: detail says wrong way', !!regW && /wrong way/.test(regW.detail), regW && regW.detail);

// ---- overshoot: lean flips to rich -> 'not-converged' with overshoot detail ----
var resO = P66.checkConvergence(report([cell('1000-1500', '40-50', 8.0, 1.0, 60)]),
                                report([cell('1000-1500', '40-50', -7.0, 1.0, 50)]),
                                patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.0)]));
var regO = regionFor(resO, 'Main VE', '1000-1500 RPM / 40-50 kPa');
check('overshoot: not-converged', !!regO && regO.verdict === 'not-converged', JSON.stringify(regO));
check('overshoot: detail names it', !!regO && /Overshot/.test(regO.detail), regO && regO.detail);

// ---- through-stoich landing inside tolerance -> 'converged' ----
var resT = P66.checkConvergence(report([cell('1000-1500', '40-50', 8.0, 1.0, 60)]),
                                report([cell('1000-1500', '40-50', -1.5, 1.0, 50)]),
                                patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.0)]));
var regT = regionFor(resT, 'Main VE', '1000-1500 RPM / 40-50 kPa');
check('through-stoich: converged', !!regT && regT.verdict === 'converged', JSON.stringify(regT));

// ---- too few after samples -> 'inconclusive' ----
var resF = P66.checkConvergence(report([cell('1000-1500', '40-50', 8.0, 1.0, 60)]),
                                report([cell('1000-1500', '40-50', 1.0, 1.0, 5)]),
                                patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.0)]));
var regF = regionFor(resF, 'Main VE', '1000-1500 RPM / 40-50 kPa');
check('few samples: inconclusive', !!regF && regF.verdict === 'inconclusive', JSON.stringify(regF));
check('few samples: detail names the count', !!regF && /Only 5/.test(regF.detail), regF && regF.detail);

// ---- non-fuel kind (spark) -> 'inconclusive' with knock hint ----
var resS = P66.checkConvergence(report([]), report([]),
  patchSet([{ table: 'Spark Advance', cell: '3000-3500 RPM / 70-80 kPa', kind: 'spark',
              action: 'retard timing', deltaDeg: -2 }]));
var regS = regionFor(resS, 'Spark Advance', '3000-3500 RPM / 70-80 kPa');
check('spark: inconclusive', !!regS && regS.verdict === 'inconclusive', JSON.stringify(regS));
check('spark: detail points at knock report', !!regS && /knock/i.test(regS.detail), regS && regS.detail);
check('spark: region named in plain words from the cell label', !!regS && regS.region === 'spark advance, mid rpm, part load',
  regS && regS.region);

// ---- multiple patches on one region group into one region ----
var resG = P66.checkConvergence(
  report([cell('1000-1500', '40-50', 8.0, 1.0, 60)]),
  report([cell('1000-1500', '40-50', 1.0, 1.0, 50)]),
  patchSet([
    fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 5.0),
    fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 3.0)
  ]));
check('grouping: one region for two patches', resG.regions.length === 1, JSON.stringify(resG.regions.length));
check('grouping: patchCount and net delta', resG.regions[0].patchCount === 2 && resG.regions[0].netDeltaPct === 8,
  JSON.stringify({ n: resG.regions[0].patchCount, d: resG.regions[0].netDeltaPct }));
check('grouping: converged', resG.regions[0].verdict === 'converged');

// ---- missing fuel-trim data -> available=false, regions inconclusive ----
var resM = P66.checkConvergence({ fuelTrims: { available: false, reason: 'no trims' } }, afterA,
  patchSet([fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.0)]));
check('missing before: available=false', resM.available === false && !!resM.reason);
check('missing before: regions inconclusive', resM.regions.length === 1 &&
  resM.regions[0].verdict === 'inconclusive', JSON.stringify(resM.regions));
var resM2 = P66.checkConvergence(null, null, patchSet([]));
check('null reports: available=false, empty regions', resM2.available === false && resM2.regions.length === 0);

// ---- renderConvergenceHTML: node-safe string ----
var threw = false, html = '';
try {
  html = P66.renderConvergenceHTML(resA);
  P66.renderConvergenceHTML(resD);
  P66.renderConvergenceHTML(resM);
  P66.renderConvergenceHTML(null);
} catch (e) { threw = true; }
check('renderConvergenceHTML no-throw under node', !threw);
check('render returns an HTML string', typeof html === 'string' && /<div/.test(html));
check('render shows the verdict word', /Converged/.test(html));
check('render shows the region name', /main VE, low rpm, light load/.test(html));
check('render shows before/after trims', /\+8\.2%/.test(html) && /\+1\.1%/.test(html));
check('render uses blue for lean trims', html.indexOf('#6b9bff') !== -1);
check('render uses red for rich trims',
  P66.renderConvergenceHTML(resO).indexOf('#ff5a5a') !== -1);
check('render includes the trim legend', /blue = lean/.test(html) && /red = rich/.test(html));
check('render escapes HTML in region names', (function () {
  var evil = P66.checkConvergence(beforeA, afterA,
    patchSet([{ table: '<img src=x onerror=alert(1)>', cell: 'global', kind: 'spark' }]));
  var h = P66.renderConvergenceHTML(evil);
  return h.indexOf('<img src=x') === -1 && h.indexOf('&lt;img') !== -1;
})());
check('render of empty set shows the summary', /nothing to check/i.test(P66.renderConvergenceHTML(resD)));

// ---- mixed summary wording ----
var mixed = P66.checkConvergence(
  report([cell('1000-1500', '40-50', 8.0, 1.0, 60), cell('2000-2500', '60-70', 8.0, 1.0, 60)]),
  report([cell('1000-1500', '40-50', 1.0, 1.0, 50)]),
  patchSet([
    fuelPatch('Main VE', '1000-1500 RPM / 40-50 kPa', 8.0),
    fuelPatch('Main VE', '2000-2500 RPM / 60-70 kPa', 8.0)
  ]));
check('mixed: 1 converged, 1 inconclusive', mixed.summary.converged === 1 &&
  mixed.summary.inconclusive === 1 && mixed.summary.total === 2, JSON.stringify(mixed.summary));
check('mixed: summary text names both', /1 of 2/.test(mixed.summary.text) && /too little/.test(mixed.summary.text),
  mixed.summary.text);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
