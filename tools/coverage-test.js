/* Coverage coach tests.
 * Run: node tools/coverage-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/coverage.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function cells(n, samplesEach) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({ rpmBin: (1000 + i * 500) + '-' + (1500 + i * 500), mapBin: '30-40', samples: samplesEach, avgTrim: 1.5, stddev: 2 });
  }
  return out;
}

function baseReport() {
  return {
    rowCount: 5000,
    regionDistribution: { idle: 300, cruise: 4000, transient: 400, wot: 300 },
    missingChannels: [],
    fuelTrims: { available: true, cells: cells(14, 100), cellCount: 14 }
  };
}

console.log('coverage: rich log');
var rich = P66.analyzeCoverage(baseReport());
check('rich log scores >= 85', rich.score >= 85, 'score=' + rich.score);
check('verdict excellent', rich.verdict === 'excellent', rich.verdict);
check('no critical gaps', !rich.gaps.some(function (g) { return g.severity === 'critical'; }));
check('no drive-cycle steps needed', rich.driveCycle.length === 0, JSON.stringify(rich.driveCycle));

console.log('coverage: idle/cruise only (Dale-style driveway log)');
var thin = P66.analyzeCoverage({
  rowCount: 10576,
  regionDistribution: { idle: 4000, cruise: 6000, transient: 576, wot: 0 },
  missingChannels: ['ECT'],
  fuelTrims: { available: true, cells: cells(6, 400), cellCount: 9 }
});
check('thin log scores below 60', thin.score < 60, 'score=' + thin.score);
check('verdict thin or poor', thin.verdict === 'thin' || thin.verdict === 'poor', thin.verdict);
check('critical wot gap flagged',
  thin.gaps.some(function (g) { return g.area === 'wot' && g.severity === 'critical'; }));
check('drive cycle prescribes WOT pulls',
  thin.driveCycle.some(function (s) { return /wide-open-throttle/i.test(s); }));
check('ECT gap is info-only',
  thin.gaps.some(function (g) { return g.area === 'channels' && g.severity === 'info' && /Coolant temp/.test(g.detail); }));

console.log('coverage: missing KR channel');
var noKr = baseReport();
noKr.missingChannels = ['KR'];
var noKrCov = P66.analyzeCoverage(noKr);
check('KR gap flagged warn',
  noKrCov.gaps.some(function (g) { return g.severity === 'warn' && /Knock retard/.test(g.detail); }));
check('drive cycle asks for KR channel',
  noKrCov.driveCycle.some(function (s) { return /knock retard/i.test(s); }));

console.log('coverage: missing RPM is critical');
var noRpm = baseReport();
noRpm.missingChannels = ['RPM'];
var noRpmCov = P66.analyzeCoverage(noRpm);
check('RPM gap critical',
  noRpmCov.gaps.some(function (g) { return g.severity === 'critical' && /^RPM/.test(g.detail); }));

console.log('coverage: fuel trims unavailable');
var noFuel = baseReport();
noFuel.fuelTrims = { available: false, reason: 'Need STFT/LTFT, RPM and MAP channels.' };
var noFuelCov = P66.analyzeCoverage(noFuel);
check('fuel gap explains why',
  noFuelCov.gaps.some(function (g) { return g.area === 'cells' && /Need STFT/.test(g.detail); }));
check('score stays in range', noFuelCov.score >= 0 && noFuelCov.score <= 100);

console.log('coverage: drive-cycle dedupe');
var dup = P66.analyzeCoverage({
  rowCount: 100,
  regionDistribution: { idle: 0, cruise: 10, transient: 90, wot: 0 },
  missingChannels: ['KR', 'O2_B1', 'O2_B2', 'O2'],
  fuelTrims: { available: false, reason: 'x' }
});
var seen = {};
var dupOk = dup.driveCycle.every(function (s) { if (seen[s]) return false; seen[s] = 1; return true; });
check('no duplicate steps', dupOk);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
