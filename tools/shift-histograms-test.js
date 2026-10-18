/* Shift-time histogram tests.
 * Run: node tools/shift-histograms-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/analyzer.js', 'js/shift-histograms.js']
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

check('shiftTimeHistograms is a function', typeof P66.shiftTimeHistograms === 'function');
check('renderShiftHistogramsSVG is a function', typeof P66.renderShiftHistogramsSVG === 'function');
check('shiftHealthSummary is a function', typeof P66.shiftHealthSummary === 'function');
check('constants exported', !!P66.SHIFT_HISTOGRAM_CONSTANTS &&
  P66.SHIFT_HISTOGRAM_CONSTANTS.slowMedianSec['1-2'] === 0.90 &&
  P66.SHIFT_HISTOGRAM_CONSTANTS.slowMedianSec['2-3'] === 0.60);

// ---- synthetic report: grouping by pair, stats, flare marking ----
var synth = {
  pcmShiftDetail: [
    { index: 10, pair: '1-2', timeSec: 0.50 },
    { index: 20, pair: '1-2', timeSec: 0.70 },
    { index: 30, pair: '1-2', timeSec: 0.60 },
    { index: 40, pair: '1-2', timeSec: 0.95 }, // far from the flared event
    { index: 1002, pair: '1-2', timeSec: 0.55 }, // within the link window of it
    { index: 50, pair: '2-3', timeSec: 0.35 }
  ],
  shiftEvents: [
    { index: 1000, type: 'upshift', from: 1, to: 2, flared: true, flareRpm: 400 },
    { index: 60, type: 'upshift', from: 2, to: 3, flared: false },
    { index: 70, type: 'downshift', from: 3, to: 2, flared: false } // never flared by construction
  ]
};
var h = P66.shiftTimeHistograms(synth);

check('groups exist for all three pairs',
  h['1-2'] && h['2-3'] && h['3-4'],
  Object.keys(h).join(','));
check('1-2: 5 times grouped', h['1-2'].times.length === 5, h['1-2'].times.join(','));
check('1-2: times sorted', JSON.stringify(h['1-2'].times) === JSON.stringify([0.5, 0.55, 0.6, 0.7, 0.95]));
check('1-2: count', h['1-2'].count === 5, 'got ' + h['1-2'].count);
check('1-2: median of odd list is the middle', h['1-2'].median === 0.6, 'got ' + h['1-2'].median);
check('1-2: min/max', h['1-2'].min === 0.5 && h['1-2'].max === 0.95,
  JSON.stringify({ min: h['1-2'].min, max: h['1-2'].max }));
check('2-3: single time', h['2-3'].count === 1 && h['2-3'].median === 0.35 &&
  h['2-3'].min === 0.35 && h['2-3'].max === 0.35);
check('3-4: empty group', h['3-4'].count === 0 && h['3-4'].median === null &&
  h['3-4'].min === null && h['3-4'].max === null);

// flares: the 1-2 event at index 41 is flared; snapshot at index 40 is within the link window
check('1-2: flares holds the flared event index',
  JSON.stringify(h['1-2'].flares) === JSON.stringify([1000]),
  JSON.stringify(h['1-2'].flares));
check('1-2: flaredCount', h['1-2'].flaredCount === 1, 'got ' + h['1-2'].flaredCount);
check('1-2: only the snapshot inside the link window is marked',
  JSON.stringify(h['1-2'].snapshots.map(function (s) { return [s.index, s.flared]; })) ===
    JSON.stringify([[10, false], [1002, true], [30, false], [20, false], [40, false]]),
  JSON.stringify(h['1-2'].snapshots.map(function (s) { return [s.index, s.flared]; })));
check('2-3: no flares', h['2-3'].flaredCount === 0 && h['2-3'].flares.length === 0);

// odd-count median
var hOdd = P66.shiftTimeHistograms({
  pcmShiftDetail: [
    { index: 1, pair: '2-3', timeSec: 0.4 },
    { index: 2, pair: '2-3', timeSec: 0.2 },
    { index: 3, pair: '2-3', timeSec: 0.9 }
  ],
  shiftEvents: []
});
check('odd-count median is the middle', hOdd['2-3'].median === 0.4, 'got ' + hOdd['2-3'].median);

// even-count median (avg of the two middles)
var hEven = P66.shiftTimeHistograms({
  pcmShiftDetail: [
    { index: 1, pair: '2-3', timeSec: 0.4 },
    { index: 2, pair: '2-3', timeSec: 0.8 }
  ],
  shiftEvents: []
});
check('even-count median is the avg of the middles', hEven['2-3'].median === 0.6,
  'got ' + hEven['2-3'].median);

// ---- captions ----
check('healthy caption', P66.shiftPairCaption(h['2-3']) === '2-3: 1 shift, median 0.35s — healthy',
  P66.shiftPairCaption(h['2-3']));
check('flare caption flags the flare',
  /1 flared shift/.test(P66.shiftPairCaption(h['1-2'])),
  P66.shiftPairCaption(h['1-2']));
check('empty caption', P66.shiftPairCaption(h['3-4']) === 'no 3-4 shifts logged');

var slow = P66.shiftTimeHistograms({
  pcmShiftDetail: [
    { index: 1, pair: '1-2', timeSec: 1.0 },
    { index: 2, pair: '1-2', timeSec: 1.1 },
    { index: 3, pair: '1-2', timeSec: 1.2 }
  ],
  shiftEvents: []
});
check('slow caption flags slow median',
  /slow for a 1-2/.test(P66.shiftPairCaption(slow['1-2'])),
  P66.shiftPairCaption(slow['1-2']));

// ---- SVG ----
var svg = P66.renderShiftHistogramsSVG(h);
check('svg: is a string starting with <svg', typeof svg === 'string' && svg.indexOf('<svg') === 0);
check('svg: one panel per pair', /1-2 shift times/.test(svg) && /2-3 shift times/.test(svg) &&
  /3-4 shift times/.test(svg));
check('svg: median label present', /median 0.35s/.test(svg));
check('svg: flared bar carries knock-amber #d29922 outline',
  /stroke="#d29922"/.test(svg), 'no #d29922 stroke found');
check('svg: empty pair panel shows "no 3-4 shifts logged"',
  /no 3-4 shifts logged/.test(svg));
check('svg: caption text embedded', /1-2: 5 shifts, median 0.60s/.test(svg));
check('svg: no Shift Time Error content', !/shift time error/i.test(svg));

var svgEmpty = P66.renderShiftHistogramsSVG(P66.shiftTimeHistograms({ pcmShiftDetail: [], shiftEvents: [] }));
check('svg: all-empty gives friendly empty message',
  svgEmpty.indexOf('<svg') === 0 && /No PCM shift times in this log/.test(svgEmpty));

var threw = false;
try { P66.renderShiftHistogramsSVG(null); } catch (e) { threw = true; }
check('render no-throw without document / null input', threw === false);

// ---- summary ----
var sum = P66.shiftHealthSummary(h);
check('summary: per-pair one-liners', typeof sum['1-2'] === 'string' &&
  typeof sum['2-3'] === 'string' && typeof sum['3-4'] === 'string');
check('summary: overall verdict mentions 1-2 flare', /1-2/.test(sum.overall) && /flared/.test(sum.overall),
  sum.overall);
var sumHealthy = P66.shiftHealthSummary(P66.shiftTimeHistograms({
  pcmShiftDetail: [{ index: 1, pair: '2-3', timeSec: 0.35 }],
  shiftEvents: []
}));
check('summary: healthy overall', sumHealthy.overall === 'Shift times look healthy on every logged pair.',
  sumHealthy.overall);
var sumNone = P66.shiftHealthSummary(P66.shiftTimeHistograms(null));
check('summary: no-data overall', /could not be judged/.test(sumNone.overall), sumNone.overall);

// ---- real log: Dale's yesss.csv — consistency with analyzeTransmission ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var mapResult = P66.mapChannels(parsed.headers);
var trans = P66.analyzeTransmission(P66.asTable(parsed), mapResult,
  P66.extractFeatures(P66.asTable(parsed), mapResult));
var hr = P66.shiftTimeHistograms(trans, parsed, mapResult);

check('real: 1-2 group count matches analyzer pcmShiftCount12',
  hr['1-2'].count === trans.pcmShiftCount12,
  'group=' + hr['1-2'].count + ' analyzer=' + trans.pcmShiftCount12);
check('real: 1-2 group has 12 shifts', hr['1-2'].count === 12, 'got ' + hr['1-2'].count);
check('real: 1-2 median matches analyzer pcmTypicalShift12',
  Math.abs(hr['1-2'].median - trans.pcmTypicalShift12) < 0.01,
  'median=' + hr['1-2'].median + ' typical=' + trans.pcmTypicalShift12);
check('real: 1-2 median is ~0.68s', Math.abs(hr['1-2'].median - 0.68) < 0.01,
  'got ' + hr['1-2'].median);
check('real: 2-3 group count matches analyzer pcmShiftCount23',
  hr['2-3'].count === trans.pcmShiftCount23,
  'group=' + hr['2-3'].count + ' analyzer=' + trans.pcmShiftCount23);
check('real: 2-3 group has 7 shifts', hr['2-3'].count === 7, 'got ' + hr['2-3'].count);
check('real: 2-3 median matches analyzer pcmTypicalShift23',
  Math.abs(hr['2-3'].median - trans.pcmTypicalShift23) < 0.01,
  'median=' + hr['2-3'].median + ' typical=' + trans.pcmTypicalShift23);
check('real: 2-3 median is ~0.35s', Math.abs(hr['2-3'].median - 0.35) < 0.01,
  'got ' + hr['2-3'].median);
check('real: 3-4 has no PCM times (PCM only exposes 1-2/2-3 channels)',
  hr['3-4'].count === 0, 'got ' + hr['3-4'].count);
check('real: no flares in group data (matches 0 flared shifts)',
  hr['1-2'].flaredCount === 0 && hr['2-3'].flaredCount === 0);
check('real: min/max sane', hr['1-2'].min < hr['1-2'].max &&
  hr['2-3'].min < hr['2-3'].max,
  JSON.stringify({ g12: [hr['1-2'].min, hr['1-2'].max], g23: [hr['2-3'].min, hr['2-3'].max] }));

var sumReal = P66.shiftHealthSummary(hr);
check('real: summary overall healthy', sumReal.overall === 'Shift times look healthy on every logged pair.',
  sumReal.overall);
check('real: summary 1-2 one-liner', sumReal['1-2'] === '1-2: 12 shifts, median 0.68s — healthy',
  sumReal['1-2']);

var svgReal = P66.renderShiftHistogramsSVG(hr);
check('real: svg renders', svgReal.indexOf('<svg') === 0 && svgReal.length > 1000);
check('real: svg has no amber without flares', svgReal.indexOf('#d29922') < 0);
check('real: svg shows 3-4 empty state', /no 3-4 shifts logged/.test(svgReal));

console.log('\n--- real log groups (yesss.csv) ---');
['1-2', '2-3', '3-4'].forEach(function (p) {
  var g = hr[p];
  console.log('  ' + p + ': count=' + g.count + ' median=' + g.median +
    ' min=' + g.min + ' max=' + g.max + ' flared=' + g.flaredCount);
});
console.log('  caption 1-2: ' + P66.shiftPairCaption(hr['1-2']));
console.log('  overall: ' + sumReal.overall);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
