/* Performance-budget regression test (Phase 4, item 20).
 *
 * Runs the full analysis pipeline on the real log
 * ~/workspace/user/files/yesss.csv (10,576 rows) and asserts it finishes
 * under fixed wall-clock budgets. The budgets guard the Phase 1 perf work
 * (columnar typed-array storage + single-pass feature extraction): an
 * accidental return to per-sample multi-pass scanning would blow past
 * them long before correctness tests noticed.
 *
 * Budgets were set by measurement on 2026-10-18 (node on this VM):
 *   P66.analyzeSession : 34-104ms over 10 post-warmup runs  -> budget 2000ms
 *   P66.extractFeatures: 2-16ms  over 10 post-warmup runs   -> budget  500ms
 * The budgets are deliberately generous (~20-30x headroom) so the test
 * cannot flake on a loaded VM, but a real regression (e.g. O(n^2) creep)
 * still trips them.
 *
 * Determinism notes: one warmup run (first node run is often slower),
 * then timed runs; the max of the timed runs must be under budget.
 * Output sanity (report shape) is asserted alongside timing so the test
 * cannot pass on a trivial no-op.
 *
 * Run: node tools/perf-budget-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/segments.js', 'js/analyzer.js',
 'js/altitude.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

// Budgets: measured max x ~20-30 headroom; see header comment.
var ANALYZE_SESSION_BUDGET_MS = 2000;
var EXTRACT_FEATURES_BUDGET_MS = 500;
var TIMED_RUNS = 5;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
check('yesss.csv exists', fs.existsSync(logPath), logPath);
if (!fs.existsSync(logPath)) {
  console.log(checks + ' checks, ' + failures + ' failures.');
  process.exit(1);
}

var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
check('real log parses to 10,576 rows', P66.asTable(parsed).rowCount === 10576,
  'got ' + P66.asTable(parsed).rowCount);

// ---- warmup: first run in node is often slower; do not time it ----
var warm = P66.analyzeSession(parsed, mapResult, {});
check('warmup report is truthy', !!warm);
check('warmup report.transmission exists', !!(warm && warm.transmission));
check('warmup report.fuelTrims exists', !!(warm && warm.fuelTrims));

// ---- timed analyzeSession runs ----
var sessionTimes = [];
var report = null;
for (var i = 0; i < TIMED_RUNS; i++) {
  var t0 = Date.now();
  report = P66.analyzeSession(parsed, mapResult, {});
  sessionTimes.push(Date.now() - t0);
}
var sessionMax = Math.max.apply(null, sessionTimes);
console.log('  analyzeSession times (ms): ' + sessionTimes.join(', ') +
  '  max=' + sessionMax + '  budget=' + ANALYZE_SESSION_BUDGET_MS);

check('report is truthy (not a no-op)', !!report);
check('report.rowCount === 10576', report && report.rowCount === 10576,
  'got ' + (report && report.rowCount));
check('report.transmission exists', !!(report && report.transmission));
check('report.fuelTrims exists', !!(report && report.fuelTrims));
check('report.knock exists', !!(report && report.knock));
check('report.regionDistribution exists', !!(report && report.regionDistribution));
check('analyzeSession max ' + sessionMax + 'ms under ' + ANALYZE_SESSION_BUDGET_MS + 'ms budget',
  sessionMax < ANALYZE_SESSION_BUDGET_MS,
  'times: ' + sessionTimes.join(', '));

// ---- timed extractFeatures runs ----
var featureTimes = [];
var feats = null;
for (var j = 0; j < TIMED_RUNS; j++) {
  var f0 = Date.now();
  feats = P66.extractFeatures(P66.asTable(parsed), mapResult);
  featureTimes.push(Date.now() - f0);
}
var featuresMax = Math.max.apply(null, featureTimes);
console.log('  extractFeatures times (ms): ' + featureTimes.join(', ') +
  '  max=' + featuresMax + '  budget=' + EXTRACT_FEATURES_BUDGET_MS);

check('features object is truthy', !!feats);
check('features.rowCount === 10576', feats && feats.rowCount === 10576,
  'got ' + (feats && feats.rowCount));
check('features has derived columns', feats && feats.gear instanceof Uint8Array &&
  Array.isArray(feats.region) && feats.segmentId instanceof Uint8Array);
check('extractFeatures max ' + featuresMax + 'ms under ' + EXTRACT_FEATURES_BUDGET_MS + 'ms budget',
  featuresMax < EXTRACT_FEATURES_BUDGET_MS,
  'times: ' + featureTimes.join(', '));

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
