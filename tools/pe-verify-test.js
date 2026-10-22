/* PE commanded-vs-actual verification tests.
 * Run: node tools/pe-verify-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/xdf-map.js',
 'js/pe-verify.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// Fake PE Target AFR table: 1D vs RPM, 17 rows, equation X/10, base 0x86C.
// Every row raw = 125 -> 12.5 AFR.
var PE_BASE = 0x86C;
var rpmLabels = [];
for (var i = 0; i < 17; i++) rpmLabels.push(String(i * 300)); // 0..4800
var catalog = { tables: [{
  title: 'Power Enrichment Target AFR',
  address: PE_BASE,
  rows: 17,
  cols: 1,
  elementSizeBits: '8',
  yAxis: { units: 'RPM', labels: rpmLabels },
  xAxis: { units: '', labels: ['0'] },
  zAxis: { units: 'AFR', equation: 'X/10' }
}]};

function makeBin() {
  var bin = new Uint8Array(0x10000);
  for (var r = 0; r < 17; r++) bin[PE_BASE + r] = 125; // 12.5 AFR everywhere
  return bin;
}

function fakeReport(rows, withCmd) {
  var m = { mapping: { TPS: { column: 'tps' }, RPM: { column: 'rpm' } }, unmapped: [] };
  if (withCmd) m.mapping.CMD_LAMBDA = { column: 'cmdlambda' };
  return { rows: rows, mapResult: m };
}

// Rows: cruise baseline, then N episodes of TPS 75 held 10 samples at 3000 rpm.
// commandedLambda is the commanded channel value during the episode.
function makeRows(nEpisodes, commandedLambda) {
  var rows = [];
  function cruise(n) {
    for (var i = 0; i < n; i++) rows.push({ tps: 20, rpm: 2200, cmdlambda: 1.0 });
  }
  cruise(20);
  for (var e = 0; e < nEpisodes; e++) {
    for (var s = 0; s < 10; s++) rows.push({ tps: 75, rpm: 3000, cmdlambda: commandedLambda });
    cruise(20);
  }
  return rows;
}

var STOICH = 14.7;

console.log('pe-verify: commanded matches table -> ok');
var r1 = P66.verifyPeCommanded(fakeReport(makeRows(2, 12.5 / STOICH), true), catalog, makeBin());
check('available', r1.available === true, JSON.stringify(r1.reason));
check('verdict ok', r1.verdict === 'ok', String(r1.verdict));
check('2 episodes', r1.episodes.length === 2, String(r1.episodes.length));
check('no mismatches', r1.mismatches.length === 0);
check('commandedAfr ~12.5', Math.abs(r1.episodes[0].commandedAfr - 12.5) < 0.05,
  String(r1.episodes[0].commandedAfr));
check('tableAfr 12.5', r1.episodes[0].tableAfr === 12.5, String(r1.episodes[0].tableAfr));
check('episode flagged match', r1.episodes[0].match === true);
check('message mentions agree', /agree/.test(r1.message), String(r1.message));

console.log('pe-verify: commanded systematically leaner than table -> suspect');
var r2 = P66.verifyPeCommanded(fakeReport(makeRows(2, 13.5 / STOICH), true), catalog, makeBin());
check('available', r2.available === true, JSON.stringify(r2.reason));
check('verdict table-mismatch-suspect', r2.verdict === 'table-mismatch-suspect', String(r2.verdict));
check('2 episodes', r2.episodes.length === 2, String(r2.episodes.length));
check('2 mismatches', r2.mismatches.length === 2, String(r2.mismatches.length));
check('first episode flagged', r2.episodes[0].match === false);
check('delta +1.0 (leaner)', Math.abs(r2.episodes[0].delta - 1.0) < 0.05,
  String(r2.episodes[0].delta));
check('message says leaner', /leaner/.test(r2.message), String(r2.message));

console.log('pe-verify: no PE episodes -> unavailable');
var r3 = P66.verifyPeCommanded(fakeReport(makeRows(0, 12.5 / STOICH), true), catalog, makeBin());
check('available false', r3.available === false);
check('reason is no-episodes', r3.reason === 'No PE episodes in this log.', String(r3.reason));

console.log('pe-verify: missing commanded channel -> unavailable');
var r4 = P66.verifyPeCommanded(fakeReport(makeRows(2, 12.5 / STOICH), false), catalog, makeBin());
check('available false', r4.available === false);
check('reason mentions commanded channel', /commanded/i.test(r4.reason), String(r4.reason));

console.log('pe-verify: missing PE table in catalog -> unavailable');
var r5 = P66.verifyPeCommanded(fakeReport(makeRows(2, 12.5 / STOICH), true),
  { tables: [] }, makeBin());
check('available false', r5.available === false);
check('reason mentions PE table', /PE Target AFR/.test(r5.reason), String(r5.reason));

console.log('pe-verify: AFR-format commanded channel also works');
var r6rows = makeRows(1, 0); // placeholder; rebuild with raw AFR below
r6rows = [];
(function () {
  for (var i = 0; i < 20; i++) r6rows.push({ tps: 20, rpm: 2200, cmdlambda: 14.7 });
  for (var s = 0; s < 10; s++) r6rows.push({ tps: 75, rpm: 3000, cmdlambda: 12.5 }); // raw AFR
  for (var j = 0; j < 20; j++) r6rows.push({ tps: 20, rpm: 2200, cmdlambda: 14.7 });
})();
var r6 = P66.verifyPeCommanded(fakeReport(r6rows, true), catalog, makeBin());
check('verdict ok with AFR units', r6.available === true && r6.verdict === 'ok',
  r6.verdict + ' / ' + r6.reason);

console.log('pe-verify: renderPeVerifyHTML');
var h1 = P66.renderPeVerifyHTML(r1);
check('ok html has verdict', /agree/i.test(h1));
check('ok html has episode row', /12\.5/.test(h1));
var h2 = P66.renderPeVerifyHTML(r2);
check('suspect html warns', /does not match/.test(h2));
var h3 = P66.renderPeVerifyHTML(r3);
check('unavailable html shows reason', /No PE episodes/.test(h3));
check('html escapes nothing broken', /^<div class="pev-panel">/.test(h1));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
