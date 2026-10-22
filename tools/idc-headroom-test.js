/* Injector duty-cycle headroom tests.
 * Run: node tools/idc-headroom-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/idc-headroom.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap(cols) {
  var mapping = {};
  Object.keys(cols).forEach(function (sig) {
    mapping[sig] = { column: cols[sig], confidence: 'high', score: 100 };
  });
  return { mapping: mapping, unmapped: [] };
}

var fullMap = fakeMap({ INJ_DC: 'injdc', RPM: 'rpm', MAP: 'map' });

// rows(i) -> {injdc, rpm, map}
function makeRows(n, fn) {
  var rows = [];
  for (var i = 0; i < n; i++) {
    var r = fn(i) || {};
    r.t = i;
    rows.push(r);
  }
  return rows;
}

// ---- (a) hot region at 85%: 20 samples at ~4600rpm/95kPa ----
var hotRows = makeRows(120, function (i) {
  if (i < 20) return { injdc: 85, rpm: 4500 + (i % 10) * 10, map: 95 };
  return { injdc: 20 + (i % 5), rpm: 1500 + (i % 10) * 10, map: 40 };
});
var rw = P66.analyzeIdcHeadroom(hotRows, fullMap);
check('85%: available', rw.available === true);
check('85%: verdict watch', rw.verdict === 'watch', 'got ' + rw.verdict);
check('85%: peakDuty 85', rw.peakDuty === 85, 'got ' + rw.peakDuty);
check('85%: peakCell ~4600rpm/95kPa',
  rw.peakCell.rpm >= 4500 && rw.peakCell.rpm <= 4600 && rw.peakCell.map === 95,
  JSON.stringify(rw.peakCell));
check('85%: one overCell at 4400\u20134800 RPM / 90\u2013100 kPa',
  rw.overCells.length === 1 &&
    rw.overCells[0].rpmRange === '4400\u20134800 RPM' &&
    rw.overCells[0].mapRange === '90\u2013100 kPa' &&
    rw.overCells[0].duty === 85 && rw.overCells[0].samples === 20,
  JSON.stringify(rw.overCells));
check('85%: message is plain pre-turbo words',
  /85% duty/.test(rw.message) && /boost/.test(rw.message), rw.message);
check('85%: source channel', rw.source === 'channel');

// ---- (b) 92% region -> critical ----
var critRows = makeRows(120, function (i) {
  if (i < 10) return { injdc: 92, rpm: 4800 + (i % 5) * 10, map: 98 };
  return { injdc: 25, rpm: 1600, map: 45 };
});
var rc = P66.analyzeIdcHeadroom(critRows, fullMap);
check('92%: verdict critical', rc.verdict === 'critical', 'got ' + rc.verdict);
check('92%: overCell duty 92', rc.overCells.length === 1 && rc.overCells[0].duty === 92,
  JSON.stringify(rc.overCells));
check('92%: message says nearly static / fuel system the limit',
  /nearly static/.test(rc.message) && /stock fuel system is the limit/.test(rc.message), rc.message);

// ---- (c) everything under 70% -> ok, no overCells ----
var calmRows = makeRows(200, function (i) {
  return { injdc: 15 + (i % 40), rpm: 1200 + (i % 30) * 100, map: 30 + (i % 20) };
});
var rok = P66.analyzeIdcHeadroom(calmRows, fullMap);
check('calm: verdict ok', rok.verdict === 'ok', 'got ' + rok.verdict);
check('calm: no overCells', rok.overCells.length === 0);
check('calm: peakDuty < 70', rok.peakDuty < 70, 'got ' + rok.peakDuty);
check('calm: message says plenty of headroom',
  /plenty of headroom/.test(rok.message), rok.message);

// ---- (d) missing IDC channel -> available:false with reason ----
var rno = P66.analyzeIdcHeadroom(calmRows, fakeMap({ RPM: 'rpm', MAP: 'map' }));
check('missing IDC: available false', rno.available === false);
check('missing IDC: reason explains', /No injector duty-cycle channel/.test(rno.reason), rno.reason);
check('missing IDC: verdict null, peakDuty null',
  rno.verdict === null && rno.peakDuty === null);
check('missing IDC: message carries the reason', /No injector/.test(rno.message), rno.message);

// ---- (e) INJ_DC as 0..1 fraction auto-scales to percent ----
var fracRows = makeRows(120, function (i) {
  if (i < 15) return { injdc: 0.86, rpm: 5000, map: 100 };
  return { injdc: 0.15, rpm: 1500, map: 40 };
});
var rf = P66.analyzeIdcHeadroom(fracRows, fullMap);
check('fraction: scaled, verdict watch', rf.available === true && rf.verdict === 'watch',
  JSON.stringify({ v: rf.verdict, peak: rf.peakDuty }));
check('fraction: peakDuty 86', rf.peakDuty === 86, 'got ' + rf.peakDuty);

// ---- (f) INJ_PW + RPM fallback estimates duty ----
var pwMap = fakeMap({ INJ_PW: 'injpw', RPM: 'rpm', MAP: 'map' });
var pwRows = makeRows(120, function (i) {
  if (i < 12) return { injpw: 20, rpm: 4800, map: 95 }; // 20*4800/1200 = 80%
  return { injpw: 3, rpm: 1500, map: 40 };
});
var rp = P66.analyzeIdcHeadroom(pwRows, pwMap);
check('INJ_PW fallback: available, source estimated',
  rp.available === true && rp.source === 'estimated',
  JSON.stringify({ a: rp.available, s: rp.source }));
check('INJ_PW fallback: 20ms@4800rpm = 80% -> watch',
  rp.verdict === 'watch' && rp.peakDuty === 80,
  JSON.stringify({ v: rp.verdict, peak: rp.peakDuty }));
check('INJ_PW fallback: reason says estimated',
  /estimated from injector pulse width/.test(rp.reason), rp.reason);

// ---- (g) precomputed report.idcHeadroom used verbatim ----
var pre = { available: true, verdict: 'ok', peakDuty: 50, message: 'pre' };
var rpre = P66.analyzeIdcHeadroom({ rowCount: 10, fuelTrims: {}, idcHeadroom: pre }, fullMap);
check('precomputed: returned verbatim', rpre === pre);

// ---- (h) bare analyzer report -> available:false with clear reason ----
var rrep = P66.analyzeIdcHeadroom({ rowCount: 100, fuelTrims: {}, missingChannels: [] }, fullMap);
check('bare report: available false', rrep.available === false);
check('bare report: reason points at the table path',
  /carries no IDC stats/.test(rrep.reason), rrep.reason);

// ---- (i) no RPM/MAP columns: still computes peak duty ----
var norpmRows = makeRows(50, function () { return { injdc: 55 }; });
var rnr = P66.analyzeIdcHeadroom(norpmRows, fakeMap({ INJ_DC: 'injdc' }));
check('no RPM/MAP: available, peakDuty 55',
  rnr.available === true && rnr.peakDuty === 55, JSON.stringify({ a: rnr.available, p: rnr.peakDuty }));
check('no RPM/MAP: peakCell nulls',
  rnr.peakCell.rpm === null && rnr.peakCell.map === null);
check('no RPM/MAP: verdict ok', rnr.verdict === 'ok');

// ---- (j) thin bin (4 samples at 88%) ignored by MIN_CELL_SAMPLES ----
var thinRows = makeRows(60, function (i) {
  if (i < 4) return { injdc: 88, rpm: 4700, map: 92 };
  return { injdc: 30, rpm: 2000, map: 50 };
});
var rt = P66.analyzeIdcHeadroom(thinRows, fullMap);
check('thin bin: overCells empty, verdict ok',
  rt.overCells.length === 0 && rt.verdict === 'ok',
  JSON.stringify({ cells: rt.overCells.length, v: rt.verdict }));

// ---- constants exported ----
var C = P66.IDC_HEADROOM_CONSTANTS;
check('constants: watch 80 / critical 90',
  C.watchDutyPct === 80 && C.criticalDutyPct === 90);
check('constants: minCellSamples 5', C.minCellSamples === 5);
check('constants: rpmBin 400 / mapBin 10', C.rpmBinSize === 400 && C.mapBinKpa === 10);

// ---- render: HTML string, no DOM needed ----
var html = P66.renderIdcHTML(rc);
check('render: returns a string', typeof html === 'string');
check('render: critical badge + duty',
  /CRITICAL/.test(html) && /92%/.test(html));
check('render: overCell row present',
  /4800\u20135200 RPM/.test(html) && /90\u2013100 kPa/.test(html));
check('render: 80/90 marker lines', html.split('idc-mark').length === 3);
check('render: message included', /nearly static/.test(html));
check('render: no trim colors', !/trimColor|#6b9bff|#ff5a5a/.test(html));

var htmlOk = P66.renderIdcHTML(rok);
check('render ok: OK badge', />OK</.test(htmlOk));
check('render ok: no-region note', /No RPM .* region over 80% duty/.test(htmlOk));

var htmlNa = P66.renderIdcHTML(rno);
check('render na: NO DATA badge + reason', />NO DATA</.test(htmlNa) && /No injector duty-cycle channel/.test(htmlNa));

var htmlNull = P66.renderIdcHTML(null);
check('render null: graceful', typeof htmlNull === 'string' && /No injector data/.test(htmlNull));

// ---- real log: Dale's yesss.csv — smoke test ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var rreal = P66.analyzeIdcHeadroom(parsed, mapResult);
check('real log: available', rreal.available === true, rreal.reason);
check('real log: numeric peakDuty', typeof rreal.peakDuty === 'number', 'got ' + rreal.peakDuty);
check('real log: render works', /idc-panel/.test(P66.renderIdcHTML(rreal)));

console.log('\n--- real log report (yesss.csv) ---');
console.log('  available=' + rreal.available + ' source=' + rreal.source +
  ' peakDuty=' + rreal.peakDuty + '% cell=' + JSON.stringify(rreal.peakCell) +
  ' verdict=' + rreal.verdict + ' overCells=' + rreal.overCells.length);
console.log('  message: ' + rreal.message);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
