/* Cold-start / warmup enrichment analysis tests.
 * Run: node tools/warmup-test.js
 *
 * Fixture contract (documents the gatedRows input shape this module needs):
 *   P66.analyzeWarmup(logTable, mapResult, gatedRows) accepts gatedRows as:
 *     1. number[]   — original row indices into logTable (RECOMMENDED; the
 *                     complement of qualityRows' keptIndex). Exact.
 *     2. boolean[]  — mask, length === logTable.rowCount; true = excluded.
 *     3. log table  — P66 table of the excluded rows in original order
 *                     (P66.filterTable over the keptIndex complement); the
 *                     warm edge is re-estimated on the subset, so the
 *                     cold/warm split is approximate.
 *   Empty/absent gatedRows -> available:false,
 *     'No warmup samples in this log — it starts already warm.'
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/warmup.js'].forEach(function (f) {
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

var COLS = { RPM: 'rpm', TPS: 'tps', MAP: 'map', ECT: 'ect', STFT: 'stft', LTFT: 'ltft', TIME: 't' };
var MAPR = fakeMap(COLS);

// ---- cold-start fixture: crank, flare, then idle with ECT 20->90 C ----
// ECT max = 90, so the analyzer's warm edge = session max - 10 = 80;
// rows with ECT < 80 are the warmup-gated set (indices 0..273 of 320).
// Combined trim ramps -14% -> -2% (rich, decaying) as ECT rises.
var N = 320;
function coldRow(i) {
  var t = +(i * 0.145).toFixed(3);
  var ect = +(20 + 70 * (i / (N - 1))).toFixed(1);
  var r = { t: t, ect: ect, tps: 1, map: 40 };
  var combined;
  if (i < 10) {          // cranking
    r.rpm = Math.round(220 + 20 * Math.sin(i));
    combined = -14;
  } else if (i < 16) {   // startup flare
    r.rpm = 1250;
    combined = -14;
  } else {               // idle warmup ramp
    r.rpm = Math.round(850 + 10 * Math.sin(i / 7));
    combined = -14 + 12 * ((i - 16) / (N - 16));
  }
  if (i === 100) r.tps = 45; // one throttle stab -> 2 transient rows (100, 101), still cold
  r.stft = round1(combined * 0.4);
  r.ltft = round1(combined * 0.6);
  return r;
  function round1(v) { return Math.round(v * 10) / 10; }
}
function makeColdTable() {
  var rows = [];
  for (var i = 0; i < N; i++) rows.push(coldRow(i));
  return P66.tableFromRows(rows);
}
var COLD_IDX = [];
for (var gi = 0; gi <= 273; gi++) COLD_IDX.push(gi); // gatedRows shape 1
var COLD_MASK = [];
for (var gm = 0; gm < N; gm++) COLD_MASK.push(gm <= 273); // gatedRows shape 2

// ---- (1) shape 1: indices ----
var t1 = makeColdTable();
var r1 = P66.analyzeWarmup(t1, MAPR, COLD_IDX);
check('indices: available', r1.available === true, JSON.stringify(r1.reason));
check('indices: inputShape reported', r1.inputShape === 'indices', r1.inputShape);
check('indices: 2 transient rows skipped', r1.transientSkipped === 2,
  'got ' + r1.transientSkipped);
check('indices: 272 cold samples', r1.coldSamples === 272, 'got ' + r1.coldSamples);
check('indices: ECT rose 20->~80', r1.ect && Math.round(r1.ect.start) === 20 &&
  r1.ect.end > 78 && r1.ect.end < 81, JSON.stringify(r1.ect));
check('indices: enrichment available', r1.warmupEnrichment.available === true,
  r1.warmupEnrichment.reason);
check('indices: verdict decaying-sensibly', r1.warmupEnrichment.verdict === 'decaying-sensibly',
  r1.warmupEnrichment.verdict);
check('indices: 6 ECT bins', r1.warmupEnrichment.bins.length === 6,
  JSON.stringify(r1.warmupEnrichment.bins.map(function (b) { return b.lo; })));
check('indices: coldest bin rich', r1.warmupEnrichment.bins[0].avgTrim < -10,
  'got ' + r1.warmupEnrichment.bins[0].avgTrim);
check('indices: hottest bin near zero', Math.abs(r1.warmupEnrichment.bins[5].avgTrim) < 6,
  'got ' + r1.warmupEnrichment.bins[5].avgTrim);
check('indices: trim slope climbs toward zero',
  r1.warmupEnrichment.slopePer10Deg > 0, 'got ' + r1.warmupEnrichment.slopePer10Deg);
check('indices: not over-fueled', r1.overfueling.flagged === false &&
  r1.overfueling.peakRichTrim < -10, JSON.stringify(r1.overfueling));
check('indices: crank found, healthy', r1.crankFuel.available === true &&
  r1.crankFuel.verdict === 'healthy' && r1.crankFuel.events.length === 1,
  JSON.stringify(r1.crankFuel));
check('indices: crank ~1.3s', r1.crankFuel.events[0].durationS > 1 &&
  r1.crankFuel.events[0].durationS < 2, 'got ' + r1.crankFuel.events[0].durationS);
check('indices: flare ~+400rpm', r1.crankFuel.events[0].rpmFlare > 300 &&
  r1.crankFuel.events[0].rpmFlare < 500, 'got ' + r1.crankFuel.events[0].rpmFlare);
check('indices: rich right after start', r1.crankFuel.events[0].richAfterStart < 0,
  'got ' + r1.crankFuel.events[0].richAfterStart);
check('indices: one advisory suggestion', r1.suggestions.length === 1,
  JSON.stringify(r1.suggestions.map(function (s) { return s.table; })));
check('indices: suggestion names choke table + address',
  r1.suggestions[0].table === 'Choke AFR Multiplier vs Startup Coolant' &&
  r1.suggestions[0].address === '0x7A2', JSON.stringify(r1.suggestions[0]));
check('indices: suggestion is advisory, low confidence',
  r1.suggestions[0].action === 'review' && r1.suggestions[0].confidence === 'low' &&
  r1.suggestions[0].deltaPct === -3, JSON.stringify(r1.suggestions[0]));
check('indices: note warns cold data is noisy',
  /noisy/.test(r1.note) && /lower than the hot-path/.test(r1.note), r1.note);

// ---- (2) shape 2: boolean mask — same outcome as indices ----
var t2 = makeColdTable();
var r2 = P66.analyzeWarmup(t2, MAPR, COLD_MASK);
check('mask: available, same cold count', r2.available === true && r2.coldSamples === 272,
  'cold=' + r2.coldSamples);
check('mask: inputShape reported', r2.inputShape === 'mask', r2.inputShape);
check('mask: same verdict', r2.warmupEnrichment.verdict === 'decaying-sensibly',
  r2.warmupEnrichment.verdict);
check('mask: same suggestion', r2.suggestions.length === 1 &&
  r2.suggestions[0].address === '0x7A2', JSON.stringify(r2.suggestions.length));

// ---- (3) shape 3: excluded-rows table ----
var t3 = makeColdTable();
var sub = P66.filterTable(t3, function (i) { return i <= 273; });
var r3 = P66.analyzeWarmup(t3, MAPR, sub);
check('table: available (re-estimated edge)', r3.available === true, JSON.stringify(r3.reason));
check('table: inputShape reported', r3.inputShape === 'table', r3.inputShape);
check('table: fewer rows, still cold', r3.coldSamples > 100 && r3.coldSamples < 272,
  'got ' + r3.coldSamples);
check('table: verdict still decaying-sensibly',
  r3.warmupEnrichment.verdict === 'decaying-sensibly', r3.warmupEnrichment.verdict);

// ---- (4) all-hot log -> available:false ----
function hotRow(i) {
  return { t: +(i * 0.145).toFixed(3), rpm: 2400, tps: 20, map: 60, ect: 195, stft: 1, ltft: -1 };
}
var hotRows = [];
for (var hi = 0; hi < 100; hi++) hotRows.push(hotRow(hi));
var th = P66.tableFromRows(hotRows);
var rh = P66.analyzeWarmup(th, MAPR, []);
check('hot: available false', rh.available === false);
check('hot: reason says starts already warm',
  rh.reason === 'No warmup samples in this log — it starts already warm.', rh.reason);
var rhu = P66.analyzeWarmup(th, MAPR);
check('hot: undefined gatedRows same', rhu.available === false &&
  rhu.reason === 'No warmup samples in this log — it starts already warm.', rhu.reason);
check('hot: suggestions empty', rh.suggestions.length === 0);

// ---- (5) no ECT channel -> cannot find warmup period ----
var noEctMap = fakeMap({ RPM: 'rpm', TPS: 'tps', MAP: 'map', STFT: 'stft', LTFT: 'ltft', TIME: 't' });
var rne = P66.analyzeWarmup(makeColdTable(), noEctMap, COLD_IDX);
check('no ECT: available false', rne.available === false);
check('no ECT: reason names ECT', /No ECT channel/.test(rne.reason), rne.reason);

// ---- (6) no crank rows -> crankFuel unavailable, enrichment still works ----
var norows = [];
for (var ni = 0; ni < N; ni++) { var cr = coldRow(ni); cr.rpm = 850; norows.push(cr); }
var tn = P66.tableFromRows(norows);
var rn = P66.analyzeWarmup(tn, MAPR, COLD_IDX);
check('no crank: enrichment still available', rn.available === true &&
  rn.warmupEnrichment.verdict === 'decaying-sensibly', rn.warmupEnrichment.verdict);
check('no crank: crankFuel unavailable', rn.crankFuel.available === false &&
  /already running/.test(rn.crankFuel.reason), rn.crankFuel.reason);

// ---- (7) long crank -> crank fuel suggestion ----
var lrows = [];
for (var li = 0; li < N; li++) {
  var lr = coldRow(li);
  if (li < 30) { lr.rpm = 230; } // 30 crank rows ~4.2s
  else if (li < 36) { lr.rpm = 1250; }
  lrows.push(lr);
}
var tl = P66.tableFromRows(lrows);
var rl = P66.analyzeWarmup(tl, MAPR, COLD_IDX);
check('long crank: verdict long-crank', rl.crankFuel.verdict === 'long-crank',
  rl.crankFuel.verdict);
check('long crank: crank suggestion at 0x8A9',
  rl.suggestions.some(function (s) {
    return s.address === '0x8A9' && s.deltaPct === 10 && s.confidence === 'low';
  }), JSON.stringify(rl.suggestions.map(function (s) { return s.address + ':' + s.deltaPct; })));

// ---- (8) table reference map ----
check('WARMUP_TABLES: crank vs coolant at 0x8A9',
  P66.WARMUP_TABLES.crankVsCoolant.address === '0x8A9');
check('WARMUP_TABLES: choke vs startup at 0x7A2',
  P66.WARMUP_TABLES.chokeVsStartup.address === '0x7A2');

// ---- (9) HTML render ----
var html = P66.renderWarmupHTML(r1);
check('html: is a string', typeof html === 'string' && html.length > 200);
check('html: names choke table + address',
  html.indexOf('Choke AFR Multiplier vs Startup Coolant') !== -1 &&
  html.indexOf('0x7A2') !== -1);
check('html: plain-language title', html.indexOf('Cold start / warmup enrichment') !== -1);
check('html: trim color legend', /blue = lean/.test(html) && /red = rich/.test(html));
check('html: noisy-data footnote', /noisy/.test(html));
check('html: shows crank seconds', /cranked 1\.3/.test(html), html.slice(0, 400));
var htmlHot = P66.renderWarmupHTML(rh);
check('html hot: carries the reason', htmlHot.indexOf('starts already warm') !== -1);
check('html: no raw <script>', html.toLowerCase().indexOf('<script') === -1);

console.log('\n' + checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
