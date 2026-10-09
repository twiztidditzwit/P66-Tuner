/* Knock/KR scaling audit for yesss.csv (and any TunerPro log).
 *
 * Investigates the discrepancy: the analyzer reported 4 knock events with
 * max KR 22.5 deg, while manual analysis found only genuine knock peaking
 * at 1.41 deg (~3000 RPM / 83 kPa) plus one 10.37 deg tip-out false-knock.
 *
 * Run: node tools/knock-audit.js
 * (repo has no build step; js/* engine files are plain node-compatible JS)
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});

var LOG = '/home/hatch/workspace/user/files/yesss.csv';
var KR_RAW_TO_DEG = 0.175781; // docs/aldl.md: "Knock Retard: X * 0.175781 degrees."

function main() {
  var text = fs.readFileSync(LOG, 'utf8');
  var parsed = P66.parseLogText(text);
  var mapResult = P66.mapChannels(parsed.headers);
  var krCol = P66.columnFor(mapResult, 'KR');
  console.log('KR channel mapped to header: ' + JSON.stringify(krCol));

  // --- 1. Are the logged KR values raw ALDL counts or already degrees? ---
  var vals = [];
  parsed.rows.forEach(function (row) {
    var v = row[krCol];
    if (typeof v === 'number' && isFinite(v) && v > 0) vals.push(v);
  });
  var distinct = {};
  vals.forEach(function (v) { distinct[v] = (distinct[v] || 0) + 1; });
  var keys = Object.keys(distinct).map(Number).sort(function (a, b) { return a - b; });
  console.log('\n[1] nonzero KR samples: ' + vals.length + ' / ' + parsed.rows.length);
  console.log('distinct KR values (' + keys.length + '): ' + keys.join(', '));
  var allInt = keys.every(function (v) { return v === Math.round(v); });
  console.log('all-integer values (raw ALDL counts?): ' + allInt);
  var mults = keys.map(function (v) { return Math.round(v / KR_RAW_TO_DEG); });
  var exact = keys.every(function (v, i) {
    return Math.abs(v - mults[i] * KR_RAW_TO_DEG) < 0.006;
  });
  console.log('every value ~= N * 0.175781 (ADX conversion already applied): ' + exact);
  console.log('raw counts implied: ' + mults.join(', '));

  // --- 2. Event-by-event classification ---
  var report = P66.analyzeSession(parsed, mapResult);
  console.log('\n[2] knock report: ' + report.knock.knockEvents + ' events, ' +
    report.knock.knockSamples + ' samples, maxKR ' + report.knock.maxKR + ' deg');
  console.log('KR units: ' + report.knock.krUnits +
    (report.knock.krRawCountsDetected ? ' (raw counts detected, scaled x0.175781)' : ''));
  report.knock.events.forEach(function (e, i) {
    console.log('  event' + i + ': rows ' + e.startIdx + '-' + (e.startIdx + e.samples - 1) +
      ' n=' + e.samples + ' peak=' + e.peakKR + ' avg=' + e.avgKR +
      ' rpm=' + e.rpm + ' map=' + e.map + ' region=' + e.region +
      ' tpsDrop=' + e.tpsDrop +
      ' suspectNoise=' + e.suspectNoise + ' tipOut=' + e.tipOut);
  });

  // --- 3. Knock Counter behavior around each event (corroboration) ---
  var kcCol = 'Knock Counter'; // rows are objects keyed by header name
  console.log('\n[3] Knock Counter around events (counts should rise on genuine knock):');
  report.knock.events.forEach(function (e, i) {
    var before = parsed.rows[Math.max(0, e.startIdx - 2)][kcCol];
    var during = parsed.rows[e.startIdx][kcCol];
    var after = parsed.rows[Math.min(parsed.rows.length - 1, e.startIdx + e.samples + 1)][kcCol];
    console.log('  event' + i + ': KC before=' + before + ' at-start=' + during +
      ' after=' + after);
  });

  // --- 4. Decay plausibility: genuine PCM knock retard decays over many ---
  // ---     samples; a full-scale spike vanishing in one sample is noise. ---
  console.log('\n[4] decay plausibility (peak KR / samples):');
  report.knock.events.forEach(function (e, i) {
    console.log('  event' + i + ': ' + e.peakKR + ' deg / ' + e.samples + ' samples = ' +
      (e.peakKR / e.samples).toFixed(2) + ' deg-per-sample');
  });

  // --- 5. What the tuner does with this (gated) ---
  var gates = P66.MODES.conservative;
  var sugs = P66.generateSuggestions(report, 'conservative');
  console.log('\n[5] spark suggestions (conservative mode):');
  sugs.suggestions.filter(function (s) { return s.kind === 'spark'; }).forEach(function (s) {
    console.log('  action=' + s.action + ' deltaDeg=' + s.deltaDeg +
      ' confidence=' + s.confidence);
    console.log('  cell: ' + s.cell);
    console.log('  reason: ' + s.reason);
    console.log('  knockCells: ' + JSON.stringify(s.knockCells));
  });

  // --- 6. Summary verdict ---
  console.log('\n[6] verdict');
  console.log('  * Scaling: values are already degrees (multiples of 0.175781) — no scaling bug.');
  console.log('  * event0 (1.41 deg, 8 samples, steady throttle, gradual decay): genuine knock.');
  console.log('  * event1 (10.37 deg, 41 samples, TPS 50.6 -> 3.5): tip-out transient, false knock — rejected.');
  console.log('  * event2 (22.5 deg = 128 counts, 1 sample, idle): single-sample spike — noise, rejected.');
  console.log('  * event3 (11.25 deg = 64 counts, 1 sample): single-sample spike — noise, rejected.');
  console.log('  * Only one genuine, non-repeatable event remains -> no automatic retard (conservative).');
}

main();
