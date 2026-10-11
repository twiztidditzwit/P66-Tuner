/* Bank-imbalance diagnostic tests.
 * Run: node tools/imbalance-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap() {
  return {
    mapping: {
      RPM: { column: 'rpm' }, MAP: { column: 'map' }, TPS: { column: 'tps' },
      STFT_B1: { column: 'stft1' }, LTFT_B1: { column: 'ltft1' },
      STFT_B2: { column: 'stft2' }, LTFT_B2: { column: 'ltft2' },
      STFT: { column: 'stft1' }, LTFT: { column: 'ltft1' }
    },
    unmapped: []
  };
}

// 100 rows in one cell: bank1 +12%, bank2 +1%. 100 rows in another cell: balanced.
function makeRows() {
  var rows = [];
  for (var i = 0; i < 100; i++) {
    rows.push({
      rpm: 2000, map: 45, tps: 20,
      stft1: 12, ltft1: 0, stft2: 1, ltft2: 0, _region: 'cruise'
    });
  }
  for (var j = 0; j < 100; j++) {
    rows.push({
      rpm: 3000, map: 60, tps: 25,
      stft1: 3, ltft1: 0, stft2: 3, ltft2: 0, _region: 'cruise'
    });
  }
  return rows;
}

console.log('imbalance: detection');
var r = P66.analyzeBankImbalance(makeRows(), fakeMap());
check('available', r.available === true);
check('one finding', r.findingCount === 1, 'found=' + r.findingCount);
check('finding is the split cell', r.findings[0] && r.findings[0].rpmBin === '2000-2500');
check('lean bank identified as 1', r.findings[0] && r.findings[0].leanBank === 1);
check('delta ~11', r.findings[0] && Math.abs(r.findings[0].delta - 11) < 0.5,
  'delta=' + (r.findings[0] && r.findings[0].delta));

console.log('imbalance: balanced log is clean');
var balanced = [];
for (var i = 0; i < 100; i++) {
  balanced.push({ rpm: 2000, map: 45, tps: 20, stft1: 3, ltft1: 0, stft2: 3, ltft2: 0, _region: 'cruise' });
}
var rb = P66.analyzeBankImbalance(balanced, fakeMap());
check('no findings', rb.findingCount === 0);

console.log('imbalance: needs both banks');
var noB2 = { mapping: {
  RPM: { column: 'rpm' }, MAP: { column: 'map' },
  STFT_B1: { column: 'stft1' }, LTFT_B1: { column: 'ltft1' }
}, unmapped: [] };
var rn = P66.analyzeBankImbalance(makeRows(), noB2);
check('unavailable without bank 2', rn.available === false);

console.log('imbalance: tuner cautions the split cell');
var report = {
  fuelTrims: P66.analyzeFuelTrims(makeRows(), fakeMap()),
  narrowband: { available: false },
  bankImbalance: P66.analyzeBankImbalance(makeRows(), fakeMap()),
  knock: { available: false }, lambda: { available: false }
};
var sugs = P66.generateSuggestions(report, 'conservative').suggestions;
var splitSug = sugs.filter(function (s) {
  return s.kind === 'fuel' && s.action !== 'none' && /2000-2500/.test(s.cell);
})[0];
check('split cell gets a fuel suggestion', !!splitSug);
check('suggestion carries imbalance caution', splitSug && /Bank imbalance/.test(splitSug.reason),
  splitSug && splitSug.reason.slice(-120));
check('confidence capped at medium', splitSug && splitSug.confidence === 'medium',
  splitSug && splitSug.confidence);
var okSug = sugs.filter(function (s) {
  return s.kind === 'fuel' && s.action !== 'none' && /3000-3500/.test(s.cell);
})[0];
check('balanced cell has no caution', !okSug || !/Bank imbalance/.test(okSug.reason));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
