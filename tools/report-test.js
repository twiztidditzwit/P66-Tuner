/* Shareable report card tests.
 * Run: node tools/report-test.js
 *
 * Canvas/PNG code is DOM-only; in node it is covered by guard checks only.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/analyzer.js', 'js/report.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function mkMap(cols) {
  var mapping = {};
  Object.keys(cols).forEach(function (sig) { mapping[sig] = { column: cols[sig] }; });
  return { mapping: mapping, unmapped: [] };
}

// ---- API surface ----
check('buildReportData exported', typeof P66.buildReportData === 'function');
check('reportTrimVerdict exported', typeof P66.reportTrimVerdict === 'function');
check('renderReportCard exported', typeof P66.renderReportCard === 'function');
check('downloadReportPng exported', typeof P66.downloadReportPng === 'function');

// ---- 128-count trims: known inputs -> known means ----
var rows128 = [];
for (var i = 0; i < 100; i++) {
  rows128.push({ t: (i * 0.5).toFixed(1), int1: 140, blm1: 130, int2: 110, blm2: 120, kr: 0 });
}
var map128 = mkMap({
  TIME: 't', STFT_B1: 'int1', LTFT_B1: 'blm1',
  STFT_B2: 'int2', LTFT_B2: 'blm2', KR: 'kr'
});
var d128 = P66.buildReportData({ rows: rows128, logName: 'synth.csv' }, map128);
check('128-count meanB1 = 140+130-128', d128.trimStats.meanB1 === 142, JSON.stringify(d128.trimStats));
check('128-count meanB2 = 110+120-128', d128.trimStats.meanB2 === 102);
check('logName carried through', d128.logName === 'synth.csv');
check('rows counted', d128.rows === 100);
check('durationS = 49.5', d128.durationS === 49.5, String(d128.durationS));
check('sampleCount === rows', d128.coverage.sampleCount === 100);
check('coverage pct null (no coverage helper input)', d128.coverage.pct === null);
check('no knock on flat log', d128.knockCount === 0);
check('o2 null without o2health module', d128.o2 === null);

// ---- percent trims: stft=+5%, ltft=-5% -> exactly 128 ----
var rowsPct = [];
for (var p = 0; p < 50; p++) rowsPct.push({ s: 5, l: -5 });
var dPct = P66.buildReportData({ rows: rowsPct }, mkMap({ STFT_B1: 's', LTFT_B1: 'l' }));
check('percent trims combine to 128', Math.abs(dPct.trimStats.meanB1 - 128) < 0.01,
  String(dPct.trimStats.meanB1));
check('percent verdict neutral', P66.reportTrimVerdict(dPct.trimStats.meanB1).kind === 'neutral');

// ---- multiplier trims: 1.10 / 0.95 -> 134.4 ----
var rowsMul = [];
for (var q = 0; q < 50; q++) rowsMul.push({ s: 1.10, l: 0.95 });
var dMul = P66.buildReportData({ rows: rowsMul }, mkMap({ STFT: 's', LTFT: 'l' }));
check('multiplier trims combine to 134.4', Math.abs(dMul.trimStats.meanB1 - 134.4) < 0.01,
  String(dMul.trimStats.meanB1));
check('generic STFT/LTFT reports as Bank 1 only', dMul.trimStats.meanB2 === null);

// ---- missing trim channels -> nulls, no throw ----
var dMiss = P66.buildReportData({ rows: rows128 }, mkMap({ TIME: 't' }));
check('meanB1 null when trims unmapped', dMiss.trimStats.meanB1 === null);
check('meanB2 null when trims unmapped', dMiss.trimStats.meanB2 === null);
check('verdict missing on null mean', P66.reportTrimVerdict(null).kind === 'missing');

// ---- one-sided bank (stft only) ----
var rowsOne = [];
for (var r1 = 0; r1 < 40; r1++) rowsOne.push({ s: 150 });
var dOne = P66.buildReportData({ rows: rowsOne }, mkMap({ STFT_B1: 's' }));
check('stft-only bank still averages', dOne.trimStats.meanB1 === 150, String(dOne.trimStats.meanB1));

// ---- trim verdicts ----
check('verdict lean on 142', P66.reportTrimVerdict(142).kind === 'lean');
check('verdict rich on 102', P66.reportTrimVerdict(102).kind === 'rich');
check('verdict neutral on 128', P66.reportTrimVerdict(128).kind === 'neutral');
check('lean text says lean', /lean/.test(P66.reportTrimVerdict(142).text));
check('rich text says rich', /rich/.test(P66.reportTrimVerdict(102).text));

// ---- knock counting ----
var rowsKr = [];
for (var k = 0; k < 60; k++) rowsKr.push({ kr: 0 });
rowsKr[10].kr = 2.5; rowsKr[11].kr = 2.0; rowsKr[12].kr = 1.5; // one event
rowsKr[50].kr = 1.5;                                          // second event
var dKr = P66.buildReportData({ rows: rowsKr }, mkMap({ KR: 'kr' }));
check('knockCount counts events', dKr.knockCount === 2, String(dKr.knockCount));
check('knockMaxKR recorded', dKr.knockMaxKR === 2.5, String(dKr.knockMaxKR));
var dNoKr = P66.buildReportData({ rows: rowsKr }, mkMap({}));
check('knockCount null without KR channel', dNoKr.knockCount === null);

// ---- null / empty tolerance ----
var dNull = P66.buildReportData(null, null);
check('null inputs do not throw', dNull.rows === 0 && dNull.trimStats.meanB1 === null &&
  dNull.knockCount === null && dNull.o2 === null && dNull.durationS === null &&
  dNull.coverage.sampleCount === 0);
var dEmpty = P66.buildReportData({ rows: [] }, {});
check('empty rows do not throw', dEmpty.rows === 0 && dEmpty.durationS === null);
var dNoMap = P66.buildReportData({ rows: rows128 });
check('missing mapResult does not throw', dNoMap.rows === 100 && dNoMap.trimStats.meanB1 === null);

// ---- o2health tolerance ----
check('analyzeO2Health absent by default', typeof P66.analyzeO2Health === 'undefined');
P66.analyzeO2Health = function () { return { summary: 'sensors look healthy' }; };
var dO2 = P66.buildReportData({ rows: rows128 }, map128);
check('o2 result passed through when module present', dO2.o2 && dO2.o2.summary === 'sensors look healthy');
P66.analyzeO2Health = function () { throw new Error('boom'); };
var dO2e = P66.buildReportData({ rows: rows128 }, map128);
check('throwing o2health degrades to null', dO2e.o2 === null);
delete P66.analyzeO2Health;
check('o2health cleaned up', typeof P66.analyzeO2Health === 'undefined');

// ---- DOM guards (node has no document) ----
check('renderReportCard null without DOM', P66.renderReportCard(null, d128) === null);
check('renderReportCard null on missing args', P66.renderReportCard(undefined, undefined) === null);
check('downloadReportPng false without DOM', P66.downloadReportPng(d128) === false);

// ---- real log smoke test ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var rd = P66.buildReportData(parsed, mapResult);
check('real log rows = 10576', rd.rows === 10576, String(rd.rows));
check('real log durationS positive', typeof rd.durationS === 'number' && rd.durationS > 0,
  String(rd.durationS));
check('real log meanB1 finite', isFinite(rd.trimStats.meanB1), String(rd.trimStats.meanB1));
check('real log meanB2 finite or null',
  rd.trimStats.meanB2 === null || isFinite(rd.trimStats.meanB2), String(rd.trimStats.meanB2));
check('real log knockCount sane', rd.knockCount === null || rd.knockCount >= 0,
  String(rd.knockCount));
check('real log sampleCount === rows', rd.coverage.sampleCount === rd.rows);
check('real log o2 null (module absent)', rd.o2 === null);
var vB1 = P66.reportTrimVerdict(rd.trimStats.meanB1);
check('real log bank1 verdict has plain-English text',
  vB1.kind !== 'missing' && vB1.text.length > 0, vB1.kind + ': ' + vB1.text);
console.log('  (real log: B1 avg ' + rd.trimStats.meanB1 + ' → ' + vB1.kind +
  ', B2 avg ' + rd.trimStats.meanB2 + ', knock events ' + rd.knockCount + ')');

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
