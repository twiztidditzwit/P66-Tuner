/* AE scatter (tip-in throttle-rate vs lean-depth) tests.
 * Run: node tools/ae-scatter-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/ae-scatter.js']
  .forEach(function (f) {
    eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
  });
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

function fakeMap() {
  return { mapping: {
    RPM: { column: 'rpm' }, TPS: { column: 'tps' },
    O2_B1: { column: 'o2' }, ECT: { column: 'ect' }
  }, unmapped: [] };
}

// rows for one stab: baseline cruise at tps 15 / o2 450, then a single-step
// jump to tpsTo held for 10 samples with the given per-sample O2 trace,
// then 30 cruise samples (clears the 20-sample refractory gap).
function stabRows(spec) {
  var rows = [];
  for (var c = 0; c < 30; c++) rows.push({ rpm: 1800, tps: 15, o2: 450, ect: 190 });
  rows.push({ rpm: 1800, tps: spec.tpsTo, o2: 450, ect: 190 }); // the stab
  for (var s = 0; s < 10; s++) {
    rows.push({ rpm: 1900 + s * 20, tps: spec.tpsTo,
      o2: spec.o2Trace[Math.min(s, spec.o2Trace.length - 1)], ect: 190 });
  }
  return rows;
}
function cruise30(rows) {
  for (var c = 0; c < 30; c++) rows.push({ rpm: 1800, tps: 15, o2: 450, ect: 190 });
}
function buildRows(specs) {
  var rows = [];
  specs.forEach(function (spec) {
    rows = rows.concat(stabRows(spec));
    cruise30(rows);
  });
  return rows;
}
function tableFrom(rows) {
  return P66.tableFromRows(rows.map(function (r) {
    return { rpm: r.rpm, tps: r.tps, o2: r.o2, ect: r.ect };
  }), ['rpm', 'tps', 'o2', 'ect']);
}

var LEAN_TRACE = [120, 120, 120, 120, 120, 450, 450, 450, 450, 450];
var RICH_TRACE = [850, 850, 850, 450, 450, 450, 450, 450, 450, 450];
var MID_TRACE = [350, 350, 350, 350, 350, 450, 450, 450, 450, 450]; // 100 mV dip, not a spike

console.log('ae-scatter: dataset from analyzer report');
var specs = [
  { tpsTo: 55, o2Trace: LEAN_TRACE }, // dtps 40, lean
  { tpsTo: 55, o2Trace: LEAN_TRACE }, // dtps 40, lean
  { tpsTo: 45, o2Trace: RICH_TRACE }  // dtps 30, no dip
];
var rows = buildRows(specs);
var table = tableFrom(rows);
var report = P66.analyzeTipIn(table, fakeMap());
check('3 events detected', report.events === 3, String(report.events));
var data = P66.tipinScatterData(table, fakeMap(), report);
check('available', data.available === true);
check('3 points', data.points.length === 3, String(data.points.length));
check('points in log order', data.points[0].index < data.points[1].index &&
  data.points[1].index < data.points[2].index);
check('point shape', data.points.every(function (p) {
  return typeof p.index === 'number' && typeof p.dTpsDt === 'number' &&
    typeof p.leanDepthMv === 'number' && typeof p.flagged === 'boolean';
}));

console.log('ae-scatter: dTpsDt math');
var dtps40 = data.points[0].dTpsDt;
check('dtps 40 -> ~275.9 %/s (40 / 0.145)', approx(dtps40, 40 / 0.145, 0.2),
  String(dtps40));
var dtps30 = data.points[2].dTpsDt;
check('dtps 30 -> ~206.9 %/s', approx(dtps30, 30 / 0.145, 0.2), String(dtps30));

console.log('ae-scatter: lean-depth extraction');
check('lean dip 450-120 = 330', data.points[0].leanDepthMv === 330,
  String(data.points[0].leanDepthMv));
check('rich response clamps to 0 depth', data.points[2].leanDepthMv === 0,
  String(data.points[2].leanDepthMv));

console.log('ae-scatter: threshold flagging');
check('lean points flagged', data.points[0].flagged && data.points[1].flagged);
check('non-lean point not flagged', !data.points[2].flagged);
check('leanCount 2', data.leanCount === 2, String(data.leanCount));
check('threshold carried on data', data.thresholdMv === 250, String(data.thresholdMv));

console.log('ae-scatter: caption');
var cap = P66.aeScatterCaption(data);
check('caption names 3 stabs', /3 tip-in stabs/.test(cap), cap);
check('caption names lean count', /2 went leaner than 250mV/.test(cap), cap);
check('caption trend: deeper stabs trend leaner', /deeper stabs trend leaner/.test(cap), cap);

console.log('ae-scatter: weak-correlation caption');
// Same lean-spike depth at every rate would be zero variance; instead use a
// mid-depth dip on the middle-rate stab so the correlation is ~0 ("no link").
var weakSpecs = [
  { tpsTo: 55, o2Trace: LEAN_TRACE },
  { tpsTo: 45, o2Trace: MID_TRACE },
  { tpsTo: 35, o2Trace: LEAN_TRACE }
];
var weakRows = buildRows(weakSpecs);
var weakTable = tableFrom(weakRows);
var weakData = P66.tipinScatterData(weakTable, fakeMap(), P66.analyzeTipIn(weakTable, fakeMap()));
var weakCap = P66.aeScatterCaption(weakData);
check('3 weak-trend points', weakData.points.length === 3, String(weakData.points.length));
check('caption notes no clear link', /no clear link/.test(weakCap), weakCap);

console.log('ae-scatter: empty state');
var emptyTable = P66.tableFromRows(
  Array.from({ length: 50 }, function () { return { rpm: 1800, tps: 15, o2: 450, ect: 190 }; }),
  ['rpm', 'tps', 'o2', 'ect']);
var emptyReport = P66.analyzeTipIn(emptyTable, fakeMap());
var emptyData = P66.tipinScatterData(emptyTable, fakeMap(), emptyReport);
check('no points', emptyData.points.length === 0);
var emptyCap = P66.aeScatterCaption(emptyData);
check('caption friendly empty message', /No tip-in stabs detected in this log/.test(emptyCap),
  emptyCap);
var emptySvg = P66.renderAeScatterSVG(emptyData);
check('empty SVG carries message', /No tip-in stabs detected in this log/.test(emptySvg));

console.log('ae-scatter: SVG rendering');
var svg = P66.renderAeScatterSVG(data);
check('svg root', /^<svg/.test(svg.trim()) && /<\/svg>$/.test(svg.trim()));
check('x axis label with units', /throttle rate \(%\/s\)/.test(svg), svg.slice(0, 200));
check('y axis label with units', /lean depth \(mV dip\)/.test(svg));
check('one dot per point', (svg.match(/<circle/g) || []).length === 3 + 2,
  String((svg.match(/<circle/g) || []).length)); // 3 dots + 2 legend dots
check('flagged dot amber', svg.indexOf('#d29922') !== -1);
check('clean dot blue-grey', svg.indexOf('#8b98b0') !== -1);
check('no fuel red/blue semantics used',
  svg.indexOf('#ff0000') === -1 && svg.indexOf('#0000ff') === -1);
check('dot titles present', /stab @row/.test(svg));
check('legend labels', /lean spike/.test(svg) && /no spike/.test(svg));
var custom = P66.renderAeScatterSVG(data, { width: 600, height: 400, title: 'My title' });
check('custom size/title honored', /width="600"/.test(custom) && /My title/.test(custom));

console.log('ae-scatter: internal fallback report (null report)');
var fb = P66.tipinScatterData(table, fakeMap(), null);
check('fallback detects events', fb.available && fb.points.length === 3,
  String(fb.points.length));

console.log('ae-scatter: yesss.csv real-log check');
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
if (fs.existsSync(logPath)) {
  var real = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  var rmap = P66.mapChannels(real.headers);
  var rrep = P66.analyzeTipIn(real, rmap);
  check('yesss.csv: 1 tip-in event', rrep.events === 1, String(rrep.events));
  var rdata = P66.tipinScatterData(real, rmap, rrep);
  check('yesss.csv: 1 point', rdata.points.length === 1, String(rdata.points.length));
  var rp = rdata.points[0];
  check('yesss.csv: point has rate and depth',
    typeof rp.dTpsDt === 'number' && rp.dTpsDt > 0 && typeof rp.leanDepthMv === 'number',
    JSON.stringify(rp));
  check('yesss.csv: known lean spike flagged', rp.flagged === true,
    JSON.stringify(rp));
  var rcap = P66.aeScatterCaption(rdata);
  check('yesss.csv: caption singular stab', /1 tip-in stab;/.test(rcap), rcap);
  check('yesss.csv: SVG one dot', (P66.renderAeScatterSVG(rdata).match(/<circle/g) || []).length === 3);
} else {
  console.log('  (skipped real-log checks: yesss.csv not found)');
}

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
