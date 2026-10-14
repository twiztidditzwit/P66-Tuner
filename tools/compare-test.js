/* Log compare (before/after tune) tests.
 * Run: node tools/compare-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/analyzer.js', 'js/compare.js'].forEach(function (f) {
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
check('compareLogs exported', typeof P66.compareLogs === 'function');
check('renderCompare exported', typeof P66.renderCompare === 'function');
check('min delta threshold is 1.0 counts', P66.COMPARE_MIN_DELTA === 1.0);

// ---- synthetic logs: count128-style trims, known outcomes ----
// A: before tune. B: after tune.
function rows(n, rpm, map, stft, ltft) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ rpm: rpm, map: map, stft: stft, ltft: ltft });
  return out;
}
var SYN_MAP = { mapping: {
  RPM: { column: 'rpm' }, MAP: { column: 'map' },
  STFT: { column: 'stft' }, LTFT: { column: 'ltft' }
}, unmapped: [] };

var rowsA = rows(60, 1200, 45, 140, 128)    // '1000-1500|40-50': rich, tune fixes -> improved
  .concat(rows(60, 2200, 65, 128, 128))     // '2000-2500|60-70': stoich, tune leans -> worsened
  .concat(rows(60, 3200, 85, 140, 128))     // '3000-3500|80-90': rich, tiny move -> unchanged
  .concat(rows(60, 5200, 95, 130, 128));    // '5000-5500|90-100': A only
var rowsB = rows(60, 1200, 45, 132, 128)    // improved: 140 -> 132
  .concat(rows(60, 2200, 65, 138, 128))     // worsened: 128 -> 138
  .concat(rows(60, 3200, 85, 140.3, 128))   // unchanged: delta 0.3 < 1.0
  .concat(rows(60, 4200, 55, 135, 128));    // '4000-4500|50-60': B only
var logA = { rows: rowsA }, logB = { rows: rowsB };

var res = P66.compareLogs({ parsedLog: logA, mapResult: SYN_MAP }, null,
                          { parsedLog: logB, mapResult: SYN_MAP }, null);
check('synthetic: available and compared', res.available === true && res.compared === true);
check('synthetic: 5 cells total', res.cells.length === 5,
  'got ' + res.cells.length);

function cellFor(r, rpm, map) {
  return r.cells.filter(function (c) { return c.rpm === rpm && c.map === map; })[0];
}
var c1 = cellFor(res, '1000-1500', '40-50');
check('cell1 trimA=140 trimB=132 delta=-8', !!c1 && c1.trimA === 140 && c1.trimB === 132 && c1.delta === -8,
  JSON.stringify(c1));
check('cell1 status improved', !!c1 && c1.status === 'improved');
var c2 = cellFor(res, '2000-2500', '60-70');
check('cell2 trimA=128 trimB=138 delta=10', !!c2 && c2.trimA === 128 && c2.trimB === 138 && c2.delta === 10,
  JSON.stringify(c2));
check('cell2 status worsened', !!c2 && c2.status === 'worsened');
var c3 = cellFor(res, '3000-3500', '80-90');
check('cell3 delta=0.3 under threshold', !!c3 && c3.delta === 0.3, JSON.stringify(c3));
check('cell3 status unchanged', !!c3 && c3.status === 'unchanged');
check('summary counts 1/1/1', res.improved === 1 && res.worsened === 1 && res.unchanged === 1,
  JSON.stringify({ i: res.improved, w: res.worsened, u: res.unchanged }));
var cAonly = cellFor(res, '5000-5500', '90-100');
var cBonly = cellFor(res, '4000-4500', '50-60');
check('A-only cell: trimB null, delta null', !!cAonly && cAonly.trimB === null && cAonly.delta === null && cAonly.nB === 0,
  JSON.stringify(cAonly));
check('B-only cell: trimA null, delta null', !!cBonly && cBonly.trimA === null && cBonly.delta === null && cBonly.nA === 0,
  JSON.stringify(cBonly));
check('single-sided cells excluded from verdict counts', res.singleSided === 2);
check('cells sorted by |delta| desc, single-sided last',
  res.cells[0].delta === 10 && res.cells[1].delta === -8 &&
  res.cells[res.cells.length - 1].delta === null &&
  res.cells[res.cells.length - 2].delta === null);
check('gated sample counts present on shared cells',
  !!c1 && c1.nA > 0 && c1.nB > 0, JSON.stringify({ nA: c1 && c1.nA, nB: c1 && c1.nB }));
check('bucketing matches analyzer 500x10 convention',
  !!cellFor(res, '1000-1500', '40-50') && !!cellFor(res, '4000-4500', '50-60'));

// ---- b null: nothing to compare against ----
var resNull = P66.compareLogs({ parsedLog: logA, mapResult: SYN_MAP }, null, null, null);
check('b null: compared=false', resNull.compared === false);
check('b null: cells carry trimA, trimB/delta null',
  resNull.cells.length > 0 &&
  resNull.cells.every(function (c) { return c.trimA !== null && c.trimB === null && c.delta === null; }));
check('b null: verdict counts all zero', resNull.improved === 0 && resNull.worsened === 0 && resNull.unchanged === 0);

// ---- renderCompare is node-safe (no document) ----
var threw = false;
try {
  P66.renderCompare(null, null);
  P66.renderCompare(null, resNull);
  P66.renderCompare(null, res);
} catch (e) { threw = true; }
check('renderCompare no-throw under node (document guard)', !threw);

// ---- unavailable when trim channels missing ----
var noTrim = P66.compareLogs({ parsedLog: logA, mapResult: { mapping: { RPM: { column: 'rpm' } }, unmapped: [] } },
                             null, { parsedLog: logB, mapResult: SYN_MAP }, null);
check('missing trims: available=false', noTrim.available === false && noTrim.cells.length === 0,
  noTrim.reason || 'no reason');

// ---- cold/warmup rows are gated out like the tuner ----
var coldRows = [];
for (var ci = 0; ci < 50; ci++) coldRows.push({ rpm: 1200, map: 45, stft: 150, ltft: 128, ect: 100 });
for (var wi = 0; wi < 50; wi++) coldRows.push({ rpm: 1200, map: 45, stft: 130, ltft: 128, ect: 200 });
var warmMap = { mapping: {
  RPM: { column: 'rpm' }, MAP: { column: 'map' },
  STFT: { column: 'stft' }, LTFT: { column: 'ltft' }, ECT: { column: 'ect' }
}, unmapped: [] };
var warmRes = P66.compareLogs({ parsedLog: { rows: coldRows }, mapResult: warmMap }, null, null, null);
check('cold rows excluded from cell trim',
  warmRes.cells.length === 1 && warmRes.cells[0].trimA === 130,
  JSON.stringify(warmRes.cells[0]));

// ---- real log: self-compare -> all deltas 0, everything unchanged ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
check('yesss.csv parses to 10576 rows', parsed.rows.length === 10576,
  'got ' + parsed.rows.length);

var t0 = Date.now();
var self = P66.compareLogs({ parsedLog: parsed, mapResult: mapResult }, null,
                           { parsedLog: parsed, mapResult: mapResult }, null);
var elapsed = Date.now() - t0;
check('self-compare: available and compared', self.available === true && self.compared === true,
  self.reason || '');
check('self-compare: nothing improved or worsened', self.improved === 0 && self.worsened === 0);
check('self-compare: no single-sided cells', self.singleSided === 0);
check('self-compare: cells populated', self.cells.length > 5, 'got ' + self.cells.length);
check('self-compare: all deltas exactly 0',
  self.cells.every(function (c) { return c.delta === 0; }));
check('self-compare: all unchanged',
  self.unchanged === self.cells.length, self.unchanged + ' of ' + self.cells.length);
check('self-compare: nA equals nB', self.cells.every(function (c) { return c.nA === c.nB; }));
check('self-compare: same result via bare (parsed, map) call form',
  (function () {
    var r2 = P66.compareLogs(parsed, mapResult, parsed, mapResult);
    return r2.cells.length === self.cells.length && r2.unchanged === self.unchanged;
  })());
console.log('  info: self-compare of 10576 rows took ' + elapsed + ' ms');
check('self-compare fast on 10k rows (<5s)', elapsed < 5000, elapsed + ' ms');

// ---- empty log ----
var empty = P66.compareLogs({ rows: [] }, SYN_MAP, null, null);
check('empty log: no cells, not compared', empty.cells.length === 0 && empty.compared === false);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
