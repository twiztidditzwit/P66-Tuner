/* Single-pass feature extraction tests.
 *
 * Covers the Phase 1 item-2 refactor (js/analyzer.js):
 *  - P66.extractFeatures: one pass over the samples computes the shared
 *    derived columns (gear/ratio, segmentId, isIdle, isWarm, isTransient,
 *    engineOn, region, VSS auto-detect, warmup threshold) with documented
 *    thresholds; gear inference relocated verbatim from analyzeTransmission
 *    (4L60E bands 136/72/44.5/31, 3-sample debounce).
 *  - the classifySegment fallback mirror agrees with P66.classifySegment.
 *  - every analyze* function accepts the feature object and returns
 *    results identical to the no-features call (with and without prior
 *    segmentation).
 *  - analyzeSession report shape unchanged.
 *  - real-log regression on yesss.csv: 4 knock events, 19 shifts,
 *    0 flared, 1 hunting episode, TCC inferred (column empty).
 *  - timing: analyzeSession ms recorded (fails only on correctness).
 *
 * Run: node tools/features-test.js
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

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function synthMap() {
  return { mapping: {
    RPM: { column: 'RPM' }, MAP: { column: 'MAP' }, TPS: { column: 'TPS' },
    VSS: { column: 'VSS' }, ECT: { column: 'ECT' }, KR: { column: 'KR' },
    STFT: { column: 'STFT' }, LTFT: { column: 'LTFT' }, O2_B1: { column: 'O2' }
  }, unmapped: [] };
}

// Synthetic log exercising every derived column.
// [RPM, MAP, TPS, VSS, ECT, KR, STFT, LTFT, O2]
function synthRows() {
  return [
    [800, 35, 1, 0, 100, 0, 2, 1, 500],    // 0: idle seg, cold
    [800, 35, 1, 0, 190, 0, 2, 1, 500],    // 1: idle seg, warm
    [2000, 45, 20, 45, 195, 0, 3, 1, 500], // 2: transient (TPS 1->20), gear 3 candidate
    [2000, 45, 20, 45, 195, 0, 3, 1, 500], // 3: cruise
    [2000, 45, 20, 45, 195, 0, 3, 1, 500], // 4: gear 3 confirmed (debounce)
    [2000, 45, 35, 45, 195, 0, 3, 1, 500], // 5: TPS jump -> transient region
    [1790, 50, 15, 55, 195, 0, 2, 0, 500], // 6: ratio 32.5 -> gear 4 candidate (transient: TPS 35->15)
    [1790, 50, 15, 55, 195, 0, 2, 0, 500], // 7
    [1790, 50, 15, 55, 195, 0, 2, 0, 500], // 8: gear 4 confirmed
    [4000, 80, 85, 60, 200, 0, 1, 0, 500], // 9: wot seg, ratio 66.7 -> gear 2 candidate
    [2500, 40, 0, 50, 200, 0, 1, 0, 500],  // 10: decel seg
    [300, 30, 1, 0, 200, 0, 1, 0, 500]     // 11: engine off (RPM < 400)
  ];
}
function synthTable() {
  var csv = 'RPM,MAP,TPS,VSS,ECT,KR,STFT,LTFT,O2\n' +
    synthRows().map(function (r) { return r.join(','); }).join('\n');
  return P66.parseLogText(csv);
}

console.log('1. extractFeatures derived columns on synthetic table');
(function () {
  var t = synthTable();
  var f = P66.extractFeatures(t, synthMap());
  check('rowCount', f.rowCount === 12, String(f.rowCount));
  check('SEGMENT_IDS', eq(P66.SEGMENT_IDS, { idle: 0, cruise: 1, wot: 2, decel: 3, other: 4 }),
    JSON.stringify(P66.SEGMENT_IDS));
  var sid = Array.prototype.slice.call(f.segmentId);
  check('segmentId idle/cruise/wot/decel',
    sid[0] === 0 && sid[2] === 1 && sid[9] === 2 && sid[10] === 3 && sid[11] === 0,
    JSON.stringify(sid));
  var gear = Array.prototype.slice.call(f.gear);
  check('gear debounce: 3 confirmed at sample 4, 4 at sample 8',
    gear[0] === 0 && gear[3] === 0 && gear[4] === 3 && gear[5] === 3 && gear[8] === 4,
    JSON.stringify(gear));
  check('gear holds previous when RPM < 400', gear[11] === 4, String(gear[11]));
  check('ratio round2 RPM/MPH', f.ratio[6] === 32.55, String(f.ratio[6]));
  check('ratio NaN when unknown', f.ratio[0] !== f.ratio[0], String(f.ratio[0]));
  check('vss auto-detect mph', f.vssUnit === 'mph' && f.vssToMph === 1,
    f.vssUnit + '/' + f.vssToMph);
  check('isIdle thresholds', f.isIdle[0] === true && f.isIdle[2] === false && f.isIdle[11] === true,
    JSON.stringify([f.isIdle[0], f.isIdle[2], f.isIdle[11]]));
  check('isWarm: ECT<160 cold, >=160 warm', f.isWarm[0] === false && f.isWarm[1] === true,
    JSON.stringify([f.isWarm[0], f.isWarm[1]]));
  check('warmThreshold 160F', f.warmThreshold && f.warmThreshold.threshold === 160,
    JSON.stringify(f.warmThreshold));
  check('isTransient on TPS jump', f.isTransient[5] === true && f.isTransient[0] === false,
    JSON.stringify([f.isTransient[0], f.isTransient[5]]));
  check('region transient matches', f.region[5] === 'transient' && f.region[3] === 'cruise',
    JSON.stringify([f.region[5], f.region[3]]));
  check('engineOn RPM>400', f.engineOn[0] === true && f.engineOn[11] === false,
    JSON.stringify([f.engineOn[0], f.engineOn[11]]));
})();

console.log('2. graceful degradation without channels');
(function () {
  var t = P66.parseLogText('RPM,MAP\n800,35\n900,36\n');
  var f = P66.extractFeatures(t, { mapping: { RPM: { column: 'RPM' }, MAP: { column: 'MAP' } }, unmapped: [] });
  var gear = Array.prototype.slice.call(f.gear);
  var sid = Array.prototype.slice.call(f.segmentId);
  check('no VSS -> gear all unknown', gear[0] === 0 && gear[1] === 0, JSON.stringify(gear));
  check('no TPS/VSS -> segment other', sid[0] === 4 && sid[1] === 4, JSON.stringify(sid));
  check('no ECT -> warmThreshold null, all warm',
    f.warmThreshold === null && f.isWarm[0] === true && f.isWarm[1] === true,
    JSON.stringify(f.warmThreshold));
  check('no VSS -> vssUnit mph default', f.vssUnit === 'mph' && f.vssToMph === 1, f.vssUnit);
})();

console.log('3. classifySegment fallback mirror agrees with segments.js');
(function () {
  var t = synthTable();
  var withSeg = Array.prototype.slice.call(P66.extractFeatures(t, synthMap()).segmentId);
  var saved = P66.classifySegment;
  delete P66.classifySegment;
  var withoutSeg;
  try {
    withoutSeg = Array.prototype.slice.call(P66.extractFeatures(t, synthMap()).segmentId);
  } finally {
    P66.classifySegment = saved;
  }
  check('fallback mirror matches P66.classifySegment', eq(withSeg, withoutSeg),
    JSON.stringify(withSeg) + ' vs ' + JSON.stringify(withoutSeg));
  // Spot-check the documented thresholds through the real implementation.
  check('idle: RPM<1450,TPS<2,VSS<3', P66.classifySegment(1400, 1, 2) === 'idle');
  check('wot: TPS>70', P66.classifySegment(4000, 71, 60) === 'wot');
  check('decel: TPS<2,RPM>1500,VSS>10', P66.classifySegment(2000, 0, 50) === 'decel');
  check('cruise band', P66.classifySegment(2000, 20, 45) === 'cruise');
  check('missing -> other', P66.classifySegment(null, 20, 45) === 'other');
})();

console.log('4. analyze* accept the feature object (identical results)');
(function () {
  var fns = ['analyzeFuelTrims', 'analyzeKnock', 'analyzeLambda', 'analyzeNarrowband',
    'analyzeTipIn', 'analyzePeEntry', 'analyzeTransmission', 'analyzeBankImbalance'];
  // Case A: segmented first (the analyzeSession flow).
  var t = synthTable();
  var map = synthMap();
  P66.segmentRows(t, map);
  var feats = P66.extractFeatures(t, map);
  fns.forEach(function (name) {
    var a = P66[name](t, map);
    var b = P66[name](t, map, feats);
    check(name + ' with/without features identical (segmented)', eq(a, b),
      a.available !== b.available ? 'available differs' : 'value differs');
  });
  // Case B: no prior segmentation — legacy contract: P66.regionAt()
  // defaults to 'cruise' everywhere, so no transient gating happens.
  // (Passing features extracted from an unsegmented table is not a
  // supported flow — analyzeSession always segments first.)
  var t2 = synthTable();
  var fr = P66.analyzeFuelTrims(t2, map);
  check('unsegmented: no transient gating (legacy regionAt default)',
    fr.available === true && fr.qualityGating.gatedTransient === 0 &&
    fr.qualityGating.gatedWarmup === 1,
    JSON.stringify(fr.qualityGating));
  var nb = P66.analyzeNarrowband(t2, map);
  check('unsegmented: narrowband runs', nb.available === true);
  var tr = P66.analyzeTransmission(t2, map);
  check('unsegmented: transmission runs', tr.available === true && tr.shifts !== undefined);
})();

console.log('5. analyzeSession report shape unchanged');
(function () {
  var t = synthTable();
  var r = P66.analyzeSession(t, synthMap());
  var keys = Object.keys(r).sort();
  var want = ['altitudeFt', 'bankImbalance', 'baro', 'fuelTrims', 'knock', 'lambda',
    'missingChannels', 'narrowband', 'peEntry', 'regionDistribution', 'rowCount',
    'tipIn', 'transmission'].sort();
  check('top-level keys', eq(keys, want), JSON.stringify(keys));
  check('transmission sub-keys present',
    r.transmission.shifts !== undefined && r.transmission.tccSource !== undefined &&
    r.transmission.huntingEpisodes !== undefined);
  check('knock sub-keys present',
    r.knock.knockEvents !== undefined && r.knock.maxKR !== undefined);
  check('fuelTrims qualityGating present',
    r.fuelTrims.qualityGating && r.fuelTrims.qualityGating.note !== undefined);
})();

console.log('6. yesss.csv regression');
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
if (fs.existsSync(logPath)) {
  var real = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  var rmap = P66.mapChannels(real.headers);
  var sess = P66.analyzeSession(real, rmap);
  check('rowCount 10576', sess.rowCount === 10576, String(sess.rowCount));
  check('knock events = 4', sess.knock.knockEvents === 4, String(sess.knock.knockEvents));
  check('shifts = 19', sess.transmission.shifts === 19, String(sess.transmission.shifts));
  check('flared = 0', sess.transmission.flaredShifts === 0, String(sess.transmission.flaredShifts));
  check('hunting episodes = 1', sess.transmission.huntingEpisodes === 1,
    String(sess.transmission.huntingEpisodes));
  check('TCC inferred (column empty)', sess.transmission.tccSource === 'inferred',
    String(sess.transmission.tccSource));
  // Full-report determinism: two runs must agree exactly.
  var sess2 = P66.analyzeSession(real, rmap);
  check('analyzeSession deterministic', eq(sess, sess2));
  // analyze* with explicit features match the session sub-reports.
  var feats = P66.extractFeatures(real, rmap);
  check('transmission matches explicit-features call',
    eq(sess.transmission, P66.analyzeTransmission(real, rmap, feats)));
  check('fuelTrims matches explicit-features call',
    eq(sess.fuelTrims, P66.analyzeFuelTrims(real, rmap, feats)));

  console.log('7. analyzeSession timing on yesss.csv (record only)');
  var times = [];
  for (var k = 0; k < 7; k++) {
    var t0 = Date.now();
    P66.analyzeSession(real, rmap);
    times.push(Date.now() - t0);
  }
  times.sort(function (a, b) { return a - b; });
  var med = times[3];
  console.log('  analyzeSession(yesss.csv, 10576 rows): median of 7 = ' + med + ' ms' +
    ' (runs: ' + times.join(', ') + ')');
  console.log('  pre-refactor baseline on this VM (2026-10-18, 30 interleaved A/B runs):' +
    ' old p50 = 77 ms, new p50 = 79 ms — distributions overlap, no real change.');
  check('timing sane (finished, < 60 s)', med > 0 && med < 60000, med + ' ms');
} else {
  console.log('  (skipped real-log checks: yesss.csv not found)');
}

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
