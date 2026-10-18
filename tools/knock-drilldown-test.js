/* Knock event drill-down tests.
 *
 * Covers:
 *  - knockEventWindow: correct centering, clamping at table edges,
 *    series lengths, peak-KR detection, KR unit scaling, missing-channel
 *    handling, NaN gaps, invalid input.
 *  - renderKnockDrilldownHTML: SVG output, event-sample marker, peak KR
 *    in the title, missing-channel notes.
 *  - Real-log check on Dale's yesss.csv: first knock event window extracts
 *    sane RPM/MAP ranges.
 *
 * Run: node tools/knock-drilldown-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/analyzer.js',
 'js/knock-drilldown.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fullMap() {
  return { mapping: {
    KR: { column: 'KR' }, TPS: { column: 'TPS' }, RPM: { column: 'RPM' },
    MAP: { column: 'MAP' }, SPARK_ADV: { column: 'SPARK_ADV' },
    TIME: { column: 'TIME' }
  } };
}

// Synthetic log: 200 rows, knock bump rows 90..109 peaking 3.0 deg at row 100.
function makeSynth(krFn) {
  var lines = ['KR,TPS,RPM,MAP,SPARK_ADV,TIME'];
  for (var i = 0; i < 200; i++) {
    var kr = krFn(i);
    var rpm = 2950 + i * 0.5;
    lines.push([kr, 40, rpm.toFixed(1), 84, 24, (i * 0.145).toFixed(3)].join(','));
  }
  return P66.parseLogText(lines.join('\n'));
}
function bumpKR(i) {
  if (i < 90 || i > 109) return 0;
  var d = Math.abs(i - 100);
  return Math.round((3 - d * 0.3) * 100) / 100; // 3.0 at i=100, decays to 0.3
}

console.log('1. window centering and series extraction');
var t = makeSynth(bumpKR);
var map = fullMap();
var win = P66.knockEventWindow(t, map, 100, 50);
check('ok', win.ok === true, String(win.ok));
check('window length 101', win.indices.length === 101, String(win.indices.length));
check('starts at 50', win.startIdx === 50, String(win.startIdx));
check('ends at 150', win.endIdx === 150, String(win.endIdx));
check('indices centered on event', win.indices[50] === 100, String(win.indices[50]));
check('eventIdx recorded', win.eventIdx === 100, String(win.eventIdx));
check('eventPos is 50', win.eventPos === 50, String(win.eventPos));
check('rpm length', win.rpm.length === 101, String(win.rpm.length));
check('map length', win.map.length === 101, String(win.map.length));
check('kr length', win.kr.length === 101, String(win.kr.length));
check('spark length', win.spark.length === 101, String(win.spark.length));
check('tps length', win.tps.length === 101, String(win.tps.length));
check('nothing missing', win.missing.length === 0, JSON.stringify(win.missing));

console.log('2. peak KR detection');
check('peakKR is 3.0', win.peakKR === 3.0, String(win.peakKR));
check('peakIdx is 100', win.peakIdx === 100, String(win.peakIdx));
check('peakRpm finite near 3000',
  typeof win.peakRpm === 'number' && win.peakRpm > 2990 && win.peakRpm < 3010,
  String(win.peakRpm));
check('peakMap is 84', win.peakMap === 84, String(win.peakMap));
check('rpm series sane at event',
  win.rpm[win.eventPos] > 2990 && win.rpm[win.eventPos] < 3010,
  String(win.rpm[win.eventPos]));

console.log('3. clamping at table edges');
var w0 = P66.knockEventWindow(t, map, 5, 50);
check('start clamps at 0', w0.startIdx === 0, String(w0.startIdx));
check('start window length 56', w0.indices.length === 56, String(w0.indices.length));
check('eventPos 5 after clamp', w0.eventPos === 5, String(w0.eventPos));
check('indices[5] is 5', w0.indices[5] === 5, String(w0.indices[5]));
var w1 = P66.knockEventWindow(t, map, 198, 50);
check('end clamps at 199', w1.endIdx === 199, String(w1.endIdx));
check('end window length 52', w1.indices.length === 52, String(w1.indices.length));
check('eventPos 50 after clamp', w1.eventPos === 50, String(w1.eventPos));
check('negative halfWidth falls back to default', P66.knockEventWindow(t, map, 100, -3).halfWidth === 50);
check('default halfWidth is 50', P66.knockEventWindow(t, map, 100).halfWidth === 50);

console.log('4. KR unit scaling');
var rawT = makeSynth(function (i) {
  if (i < 90 || i > 109) return 0;
  var d = Math.abs(i - 100);
  return Math.round(17 - d * 2); // raw ALDL counts, peak 17
});
var wRaw = P66.knockEventWindow(rawT, map, 100, 50, 0.175781);
check('raw counts scaled to degrees',
  Math.abs(wRaw.peakKR - 17 * 0.175781) < 0.01, String(wRaw.peakKR));
check('krScale recorded', wRaw.krScale === 0.175781, String(wRaw.krScale));
check('bad krScale falls back to 1',
  P66.knockEventWindow(t, map, 100, 50, -2).krScale === 1);

console.log('5. missing channel handling');
var noKrMap = { mapping: {
  TPS: { column: 'TPS' }, RPM: { column: 'RPM' },
  MAP: { column: 'MAP' }, SPARK_ADV: { column: 'SPARK_ADV' }
} };
var wNoKr = P66.knockEventWindow(t, noKrMap, 100, 50);
check('KR series is null', wNoKr.kr === null);
check('other series present', wNoKr.rpm !== null && wNoKr.map !== null);
check('missing lists KR', wNoKr.missing.indexOf('KR') !== -1, JSON.stringify(wNoKr.missing));
check('peakKR null without KR', wNoKr.peakKR === null);
var htmlNoKr = P66.renderKnockDrilldownHTML(wNoKr);
check('missing-KR note in HTML', /KR channel not mapped/.test(htmlNoKr), htmlNoKr.slice(0, 120));
check('missing-KR still renders svg', /<svg/.test(htmlNoKr));

console.log('6. renderer');
var html = P66.renderKnockDrilldownHTML(win);
check('contains svg', /<svg[\s>]/.test(html));
check('contains event marker', /p66-kd-marker/.test(html));
check('peak KR in title', /peak KR 3\.00/.test(html), html.slice(0, 200));
check('five panels (one label per channel)',
  (html.match(/font-weight="600"/g) || []).length === 5,
  String((html.match(/font-weight="600"/g) || []).length));
check('event sample value labels', /KR<\/text>[\s\S]{0,200}3\.00/.test(html));
check('invalid window renders note', /p66-kd-empty/.test(P66.renderKnockDrilldownHTML(null)));
check('empty table not ok', P66.knockEventWindow(P66.parseLogText(''), map, 0, 50).ok === false);

console.log('7. NaN gaps do not break extraction');
var nanT = makeSynth(function (i) {
  if (i === 100) return ''; // empty cell -> NaN at the true peak
  return bumpKR(i);
});
var wNan = P66.knockEventWindow(nanT, map, 100, 50);
check('NaN at peak still finds next peak', Math.abs(wNan.peakKR - 2.7) < 1e-4, String(wNan.peakKR));
check('peakIdx shifts to 99', wNan.peakIdx === 99, String(wNan.peakIdx));
var htmlNan = P66.renderKnockDrilldownHTML(wNan);
check('NaN window still renders', /<svg[\s>]/.test(htmlNan) && /p66-kd-marker/.test(htmlNan));

console.log('8. real log (yesss.csv)');
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var realMap = P66.mapChannels(parsed.headers);
var kr = P66.analyzeKnock(parsed, realMap);
check('knock available on real log', kr.available === true, kr.reason || '');
check('real log has events', kr.events.length > 0, String(kr.events.length));
var ev = kr.events[0];
check('event startIdx in range',
  ev.startIdx >= 0 && ev.startIdx < parsed.rowCount, String(ev.startIdx));
var wReal = P66.knockEventWindow(parsed, realMap, ev.startIdx, 50, kr.krScale);
check('real window ok', wReal.ok === true);
var realRpm = wReal.rpm.filter(function (v) { return v === v; });
var realMapV = wReal.map.filter(function (v) { return v === v; });
check('real RPM values sane',
  realRpm.length > 0 && realRpm.every(function (v) { return v >= 300 && v <= 7000; }),
  'n=' + realRpm.length + ' min=' + Math.min.apply(null, realRpm));
check('real MAP values sane',
  realMapV.length > 0 && realMapV.every(function (v) { return v >= 5 && v <= 110; }),
  'n=' + realMapV.length + ' min=' + Math.min.apply(null, realMapV));
console.log('  info: first event @' + ev.startIdx + ' peakKR=' + kr.events[0].peakKR +
  '° krScale=' + kr.krScale + ' rpm=[' +
  Math.min.apply(null, realRpm).toFixed(0) + '..' + Math.max.apply(null, realRpm).toFixed(0) +
  '] map=[' + Math.min.apply(null, realMapV).toFixed(1) + '..' +
  Math.max.apply(null, realMapV).toFixed(1) + ']');
var htmlReal = P66.renderKnockDrilldownHTML(wReal);
check('real render contains svg + marker',
  /<svg[\s>]/.test(htmlReal) && /p66-kd-marker/.test(htmlReal));

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
