/* Strip chart tests (pure helpers + real-log integration).
 * Run: node tools/stripcharts-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/playback.js', 'js/stripcharts.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- defaults ----
check('default channels', P66.SC_DEFAULT_CHANNELS.join(',') === 'RPM,MAP,TPS,O2_B1,O2_B2,KR');

// ---- stripDownsample ----
var vals = [];
for (var i = 0; i < 100; i++) vals.push(i);
var ds = P66.stripDownsample(vals, 2000);
check('downsample passthrough under cap',
  ds.length === 100 && ds[0].i === 0 && ds[0].v === 0 && ds[99].i === 99 && ds[99].v === 99);
check('downsample empty in empty out', P66.stripDownsample([], 2000).length === 0);
check('downsample drops non-finite', (function () {
  var d = P66.stripDownsample([1, NaN, 'x', 3], 100);
  return d.length === 2 && d[0].i === 0 && d[1].i === 3;
})());

var small = [1, 2, 3, 4, 5, 10, 9, 8, 7, 6];
var dsmall = P66.stripDownsample(small, 4);
check('downsample min/max pairs per bucket',
  dsmall.length === 4 &&
  dsmall[0].i === 0 && dsmall[0].v === 1 &&
  dsmall[1].i === 4 && dsmall[1].v === 5 &&
  dsmall[2].i === 5 && dsmall[2].v === 10 &&
  dsmall[3].i === 9 && dsmall[3].v === 6,
  JSON.stringify(dsmall));

var big = [];
for (var j = 0; j < 10000; j++) big.push(Math.sin(j / 100));
big[5000] = 999; // spike
var dbig = P66.stripDownsample(big, 2000);
check('downsample caps at maxPoints', dbig.length <= 2000, String(dbig.length));
check('downsample preserves spike index',
  dbig.some(function (p) { return p.i === 5000; }));
check('downsample output sorted by index',
  dbig.every(function (p, k) { return k === 0 || dbig[k - 1].i < p.i; }));
var dodd = P66.stripDownsample(big, 1999);
check('downsample honors odd cap', dodd.length <= 1999, String(dodd.length));
var dnans = [];
for (var qn = 0; qn < 5000; qn++) dnans.push(qn % 3 === 0 ? NaN : qn);
var dnn = P66.stripDownsample(dnans, 2000);
check('downsample skips NaN in buckets',
  dnn.length <= 2000 && dnn.every(function (p) { return isFinite(p.v); }));

// ---- x <-> index mapping ----
check('xToIndex left edge', P66.stripXToIndex(0, 800, 100) === 0);
check('xToIndex right edge', P66.stripXToIndex(800, 800, 100) === 99);
check('xToIndex middle', P66.stripXToIndex(400, 800, 100) === 50);
check('xToIndex clamps below', P66.stripXToIndex(-20, 800, 100) === 0);
check('xToIndex clamps above', P66.stripXToIndex(900, 800, 100) === 99);
check('xToIndex single row', P66.stripXToIndex(400, 800, 1) === 0);
check('indexToX ends', P66.stripIndexToX(0, 800, 100) === 0 && P66.stripIndexToX(99, 800, 100) === 800);
var roundTrip = [0, 1, 7, 42, 98, 99].every(function (ri) {
  return P66.stripXToIndex(P66.stripIndexToX(ri, 800, 100), 800, 100) === ri;
});
check('indexToX/xToIndex round trip', roundTrip);

// ---- lane scaling ----
check('stripY max at top pad', P66.stripY(100, 0, 100, 64) === 4);
check('stripY min at bottom pad', P66.stripY(0, 0, 100, 64) === 60);
check('stripY mid', P66.stripY(50, 0, 100, 64) === 32);
check('stripY flat range centers', P66.stripY(5, 5, 5, 64) === 32);
check('stripY NaN returns null', P66.stripY(NaN, 0, 100, 64) === null);
check('stripY parses strings', P66.stripY('50', 0, 100, 64) === 32);

// ---- lane stats ----
var st = P66.stripLaneStats([3, 1, 2, NaN, 'x', null]);
check('laneStats min/max ignoring junk', st && st.min < 1 && st.max > 3,
  JSON.stringify(st));
check('laneStats null when nothing finite',
  P66.stripLaneStats([NaN, null, 'x']) === null);
var flat = P66.stripLaneStats([7, 7, 7]);
check('laneStats expands flat range', flat && flat.min < 7 && flat.max > 7,
  JSON.stringify(flat));

// ---- trim colors (blue = lean/add fuel, red = rich/remove fuel) ----
check('trimColor red below 128', P66.stripTrimColor(100) === '#ff5a5a');
check('trimColor blue above 128', P66.stripTrimColor(150) === '#6b9bff');
check('trimColor neutral at 128', P66.stripTrimColor(128) === '#9fa9b8');
check('trimColor neutral on NaN', P66.stripTrimColor(NaN) === '#9fa9b8');
check('isTrim true for STFT_B1', P66.stripIsTrim('STFT_B1') === true);
check('isTrim true for LTFT_B2', P66.stripIsTrim('LTFT_B2') === true);
check('isTrim false for RPM', P66.stripIsTrim('RPM') === false);
check('isTrim false for KR', P66.stripIsTrim('KR') === false);

// ---- number formatting ----
check('scFmtNum hundreds', P66.scFmtNum(1234.567) === '1235');
check('scFmtNum tens', P66.scFmtNum(12.345) === '12.3');
check('scFmtNum small', P66.scFmtNum(0.1234) === '0.12');
check('scFmtNum NaN dash', P66.scFmtNum(NaN) === '—');

// ---- lane resolution ----
var fakeMap = { mapping: { RPM: { column: 'rpm' }, MAP: { column: 'map' } }, unmapped: [] };
var rl = P66.stripResolveLanes(['RPM', 'KR', 'MAP'], fakeMap);
check('resolveLanes maps known signals', rl[0].column === 'rpm' && rl[2].column === 'map');
check('resolveLanes null for unknown signal', rl[1].signal === 'KR' && rl[1].column === null);
check('resolveLanes null without mapResult',
  P66.stripResolveLanes(['RPM'], null)[0].column === null);

// ---- render guard under node (no document) ----
check('renderStripCharts null without document', P66.renderStripCharts(null, null, {}) === null);

// ---- real-log integration (Dale's yesss.csv) ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var ctl = P66.createPlaybackController(parsed, mapResult);
check('controller created for real log', !!ctl && ctl.table.rowCount > 10000,
  ctl ? String(ctl.table.rowCount) : 'null');
var lanes = P66.stripResolveLanes(P66.SC_DEFAULT_CHANNELS, mapResult);
check('all 6 default channels resolve on real log',
  lanes.every(function (l) { return !!l.column; }),
  JSON.stringify(lanes.filter(function (l) { return !l.column; }).map(function (l) { return l.signal; })));
check('RPM lane agrees with HUD gauge resolution',
  lanes[0].column === P66.pbResolveColumns(mapResult)[0], lanes[0].column);
check('O2_B1 resolves', /o2/i.test(lanes[3].column), lanes[3].column);

// Downsample a real lane end-to-end.
var rpmCol = lanes[0].column;
var rpmVals = Array.from(parsed.col(rpmCol));
var dsR = P66.stripDownsample(rpmVals, 2000);
check('real RPM lane downsamples under cap', dsR.length <= 2000 && dsR.length > 100,
  String(dsR.length));
var maxI = 0, maxV = -Infinity;
for (var mi = 0; mi < rpmVals.length; mi++) {
  var mv = (typeof rpmVals[mi] === 'number') ? rpmVals[mi] : parseFloat(rpmVals[mi]);
  if (isFinite(mv) && mv > maxV) { maxV = mv; maxI = mi; }
}
check('real lane max RPM survives downsample',
  dsR.some(function (p) { return p.i === maxI; }),
  'max ' + maxV + ' at row ' + maxI);
var krCol = lanes[5].column;
var krVals = Array.from(parsed.col(krCol));
var krStats = P66.stripLaneStats(krVals);
check('real KR lane stats finite', krStats && isFinite(krStats.min) && isFinite(krStats.max) && krStats.max >= krStats.min,
  JSON.stringify(krStats));
check('real KR lane Y maps inside lane',
  (function () {
    var y = P66.stripY(krStats.max, krStats.min, krStats.max, 64);
    return y !== null && y >= 0 && y <= 64;
  })());

// Unmapped channel degrades gracefully in resolution (render path is DOM-guarded).
var rlUn = P66.stripResolveLanes(['RPM', 'NOPE_NOT_A_SIGNAL'], mapResult);
check('bogus signal resolves to null column', rlUn[1].column === null);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
