/* Log playback HUD tests.
 * Run: node tools/playback-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/playback.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- gauge definitions ----
check('16 gauges defined', P66.HUD_GAUGES.length === 16);
check('gauge order matches TunerPro dash',
  P66.HUD_GAUGES[0].signal === 'RPM' &&
  P66.HUD_GAUGES[5].signal === 'IAC' &&
  P66.HUD_GAUGES[8].signal === 'O2_B1' &&
  P66.HUD_GAUGES[10].signal === 'STFT_B1' &&
  P66.HUD_GAUGES[12].signal === 'LTFT_B1' &&
  P66.HUD_GAUGES[14].signal === 'CMD_LAMBDA' &&
  P66.HUD_GAUGES[15].signal === 'TPS');
check('every gauge has label, unit, decimals, color, border',
  P66.HUD_GAUGES.every(function (g) {
    return g.label && typeof g.unit === 'string' &&
      Number.isInteger(g.decimals) && g.color && g.border;
  }));

// ---- formatting ----
check('pbFmt rounds to decimals', P66.pbFmt(12.3456, 2) === '12.35');
check('pbFmt integer decimals', P66.pbFmt(1800.4, 0) === '1800');
check('pbFmt dash on null', P66.pbFmt(null, 2) === '—');
check('pbFmt dash on undefined', P66.pbFmt(undefined, 2) === '—');
check('pbFmt dash on NaN', P66.pbFmt(NaN, 2) === '—');
check('pbFmt dash on text', P66.pbFmt('abc', 2) === '—');
check('pbFmt parses numeric strings', P66.pbFmt('0.00', 2) === '0.00');

// ---- AFR conversion ----
check('pbToAfr scales lambda', Math.abs(P66.pbToAfr(1.0) - 14.7) < 1e-9);
check('pbToAfr leaves AFR alone', Math.abs(P66.pbToAfr(14.7) - 14.7) < 1e-9);
check('pbToAfr NaN in NaN out', isNaN(P66.pbToAfr('xyz')));

// ---- timestamps ----
var rows = [];
for (var i = 0; i < 100; i++) rows.push({ t: (i * 0.145).toFixed(3) });
var tb = P66.pbBuildTimes(rows, 't');
check('pbBuildTimes uses time column', !tb.indexed && tb.times.length === 100);
check('pbBuildTimes monotonic', tb.times[50] > tb.times[10]);
var tb2 = P66.pbBuildTimes(rows, null);
check('pbBuildTimes falls back to index', tb2.indexed && tb2.times[7] === 7);
var rows3 = [];
for (var q = 0; q < 10; q++) rows3.push({ t: (q * 0.2).toFixed(1) });
rows3[4].t = 'bad';
var tb3 = P66.pbBuildTimes(rows3, 't');
check('pbBuildTimes fills single gap', !tb3.indexed && Math.abs(tb3.times[4] - 0.6) < 1e-6,
  String(tb3.times[4]));

// ---- row index search ----
check('pbRowIndexAt start', P66.pbRowIndexAt(tb.times, 0) === 0);
check('pbRowIndexAt middle', P66.pbRowIndexAt(tb.times, tb.times[42]) === 42);
check('pbRowIndexAt clamps before start', P66.pbRowIndexAt(tb.times, -5) === 0);
check('pbRowIndexAt clamps after end', P66.pbRowIndexAt(tb.times, 1e9) === 99);
check('pbRowIndexAt between samples picks last <= t',
  P66.pbRowIndexAt([0, 1, 2, 3], 2.7) === 2);

// ---- column resolution on Dale's real log ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
check('IAC maps to IAC Position',
  P66.columnFor(mapResult, 'IAC') === 'IAC Position');
check('INJ_DC maps to Injector Duty Cycle',
  P66.columnFor(mapResult, 'INJ_DC') === 'Injector Duty Cycle');
var cols = P66.pbResolveColumns(mapResult);
check('all 16 gauges resolve on the real log',
  cols.every(function (c) { return !!c; }),
  JSON.stringify(P66.HUD_GAUGES.filter(function (g, i) { return !cols[i]; })
    .map(function (g) { return g.signal; })));
check('O2 B1 resolves to Left/Front O2 Sensor', cols[8] === 'Left/Front O2 Sensor');
check('INT B1 resolves to Left/Front INT', cols[10] === 'Left/Front INT');
check('BLM B2 resolves to Right/Rear BLM', cols[13] === 'Right/Rear BLM');
check('target AFR resolves', cols[14] === 'Target Air/Fuel Ratio');

// ---- fallbacks ----
var sparse = { mapping: { STFT: { column: 'stft' }, LTFT: { column: 'ltft' } }, unmapped: [] };
var cols2 = P66.pbResolveColumns(sparse);
check('STFT_B1 falls back to STFT', cols2[10] === 'stft');
check('LTFT_B2 falls back to LTFT', cols2[13] === 'ltft');
check('unmapped gauge resolves null', cols2[0] === null);

// ---- 128 color rule ----
var gc = { color: '#eef1f6' };
check('pbValueColor red below 128', P66.pbValueColor(gc, 100) === '#ff5a5a');
check('pbValueColor red on string below 128', P66.pbValueColor(gc, '100') === '#ff5a5a');
check('pbValueColor blue above 128', P66.pbValueColor(gc, 150) === '#6b9bff');
check('pbValueColor neutral at exactly 128', P66.pbValueColor(gc, 128) === '#eef1f6');
check('pbValueColor default on NaN', P66.pbValueColor(gc, NaN) === '#eef1f6');
check('pbValueColor default on null', P66.pbValueColor(gc, null) === '#eef1f6');

// ---- playback controller ----
var ctlRows = [];
for (var ci = 0; ci < 50; ci++) ctlRows.push({ t: (ci * 0.2).toFixed(1), rpm: 800 + ci * 10 });
var ctlMap = { mapping: {
  TIME: { column: 't' }, RPM: { column: 'rpm' }, CMD_LAMBDA: { column: 'afr' }
}, unmapped: [] };
check('createPlaybackController null on empty', P66.createPlaybackController({ rows: [] }, ctlMap) === null);
var ctl = P66.createPlaybackController({ rows: ctlRows }, ctlMap);
check('controller exposes table/times', ctl.table.rowCount === 50 && ctl.times.length === 50);
check('controller initial index 0', ctl.getIndex() === 0);
check('controller initial state paused', ctl.getState().playing === false && ctl.getState().speed === 1);
var seen = [];
var unsub = ctl.onFrame(function (idx) { seen.push(idx); });
ctl.seek(10);
check('seek moves index and emits', ctl.getIndex() === 10 && seen[seen.length - 1] === 10);
ctl.seek(9999);
check('seek clamps to last row', ctl.getIndex() === 49);
ctl.seek(-5);
check('seek clamps to first row', ctl.getIndex() === 0);
unsub();
var nBefore = seen.length;
ctl.seek(20);
check('unsubscribe stops notifications', seen.length === nBefore && ctl.getIndex() === 20);
var rpmGi = P66.HUD_GAUGES.findIndex(function (g) { return g.signal === 'RPM'; });
check('valueAt returns gauge value', P66.createPlaybackController && ctl.valueAt(rpmGi, 5) === 850);
var afrGi = P66.HUD_GAUGES.findIndex(function (g) { return g.signal === 'CMD_LAMBDA'; });
ctlRows[5].afr = '1.0';
// Columnar storage snapshots at creation: rebuild the controller to pick
// up the late-added channel, then verify the lambda->AFR conversion.
var ctl2 = P66.createPlaybackController({ rows: ctlRows }, ctlMap);
check('valueAt converts lambda to AFR', Math.abs(ctl2.valueAt(afrGi, 5) - 14.7) < 1e-9);
check('valueAt NaN on unmapped gauge', isNaN(ctl.valueAt(P66.HUD_GAUGES.findIndex(function (g) { return g.signal === 'KR'; }), 5)));
ctl.setSpeed(2);
check('setSpeed updates state', ctl.getState().speed === 2);
ctl.stop();
check('stop pauses', ctl.getState().playing === false);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
