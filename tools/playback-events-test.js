/* Playback event ticks tests.
 * Run: node tools/playback-events-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/playback.js',
 'js/analyzer.js', 'js/playback-events.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- pure math ----
check('eventTickPct midpoint', P66.eventTickPct(5, 0, 10) === 50);
check('eventTickPct start', P66.eventTickPct(0, 0, 10) === 0);
check('eventTickPct end', P66.eventTickPct(10, 0, 10) === 100);
check('eventTickPct clamps below', P66.eventTickPct(-3, 0, 10) === 0);
check('eventTickPct clamps above', P66.eventTickPct(99, 0, 10) === 100);
check('eventTickPct degenerate range', P66.eventTickPct(5, 5, 5) === 0);
check('eventTickPct non-finite time', P66.eventTickPct(NaN, 0, 10) === 0);

var evs = [{ index: 5 }, { index: 20 }, { index: 42 }];
check('nearest exact hit', P66.nearestEventAtOrBelow(evs, 20) === evs[1]);
check('nearest between picks lower', P66.nearestEventAtOrBelow(evs, 30) === evs[1]);
check('nearest before first is null', P66.nearestEventAtOrBelow(evs, 2) === null);
check('nearest after last is last', P66.nearestEventAtOrBelow(evs, 999) === evs[2]);
check('nearest empty is null', P66.nearestEventAtOrBelow([], 10) === null);
check('nearest null is null', P66.nearestEventAtOrBelow(null, 10) === null);

// ---- synthetic log with stub analyzers ----
var synthMap = { mapping: {
  TIME: { column: 't' }, TPS: { column: 'tps' }, CMD_LAMBDA: { column: 'cmd' }
}, unmapped: [] };
var synthRows = [];
for (var i = 0; i < 100; i++) {
  synthRows.push({ t: (i * 0.2).toFixed(1), tps: i < 50 ? '5' : '75', cmd: i < 50 ? '1.0' : '0.87' });
}
var synthLog = { rows: synthRows };

var realKnock = P66.analyzeKnock, realTipIn = P66.analyzeTipIn, realPe = P66.analyzePeEntry;
function knockStub() {
  return { available: true, events: [
    { startIdx: 40, peakKR: 3.2, rpm: 2450, tipOut: false, suspectNoise: false },
    { startIdx: 8, peakKR: 1.1, rpm: 1100, tipOut: true, suspectNoise: false }
  ] };
}
function tipInStub() {
  return { available: true, events: 2, eventsDetail: [
    { index: 60, dtps: 18, leanSpike: true, cold: false },
    { index: 20, dtps: 12, leanSpike: false, cold: true }
  ] };
}
function peStub() { return { available: true, episodes: 1 }; }
function stubAll() {
  P66.analyzeKnock = knockStub;
  P66.analyzeTipIn = tipInStub;
  P66.analyzePeEntry = peStub;
}
stubAll();

var ev = P66.computePlaybackEvents(synthLog, synthMap);
check('stub analyzers yield events', ev.length === 5, 'got ' + ev.length);
check('knock event from startIdx',
  ev.some(function (e) { return e.type === 'knock' && e.index === 40; }));
check('tipin event from eventsDetail index',
  ev.some(function (e) { return e.type === 'tipin' && e.index === 60; }));
check('tipin label marks lean spike',
  ev.filter(function (e) { return e.type === 'tipin'; })
    .some(function (e) { return e.label.indexOf('lean') >= 0; }));
check('knock label carries peak KR',
  ev.filter(function (e) { return e.type === 'knock'; })
    .every(function (e) { return e.label.indexOf('deg') >= 0; }));
check('pe episode from TPS>=60 block',
  ev.some(function (e) { return e.type === 'pe' && e.index === 50; }),
  JSON.stringify(ev.filter(function (e) { return e.type === 'pe'; })));
check('pe label notes PE engagement',
  ev.filter(function (e) { return e.type === 'pe'; })
    .some(function (e) { return e.label.indexOf('PE +') >= 0; }));
check('events sorted by index',
  ev.every(function (e, i) { return i === 0 || ev[i - 1].index <= e.index; }));
check('event shape',
  ev.every(function (e) {
    return Number.isInteger(e.index) && isFinite(e.time) &&
      (e.type === 'knock' || e.type === 'tipin' || e.type === 'pe') &&
      typeof e.label === 'string' && e.label.length > 0;
  }));
check('time from TIME column', ev.filter(function (e) { return e.index === 40; })[0].time === 8);

var types = {};
ev.forEach(function (e) { types[e.type] = true; });
check('all three types present', types.knock && types.tipin && types.pe);

// ---- tolerance: missing analyzer ----
stubAll();
P66.analyzeKnock = undefined;
var ev2 = P66.computePlaybackEvents(synthLog, synthMap);
check('missing knock analyzer tolerated, others survive',
  ev2.length === 3 && ev2.every(function (e) { return e.type !== 'knock'; }));

// ---- tolerance: analyzer reports unavailable ----
stubAll();
P66.analyzeTipIn = function () { return { available: false, reason: 'no' }; };
var ev3 = P66.computePlaybackEvents(synthLog, synthMap);
check('unavailable tipin skipped silently',
  ev3.length === 3 && ev3.every(function (e) { return e.type !== 'tipin'; }));

// ---- tolerance: analyzer throws ----
stubAll();
P66.analyzePeEntry = function () { throw new Error('boom'); };
var ev4 = P66.computePlaybackEvents(synthLog, synthMap);
check('throwing PE analyzer tolerated',
  ev4.length === 4 && ev4.every(function (e) { return e.type !== 'pe'; }));

// ---- tolerance: count-only tipin result (no eventsDetail) ----
stubAll();
P66.analyzeTipIn = function () { return { available: true, events: 7 }; };
var ev5 = P66.computePlaybackEvents(synthLog, synthMap);
check('tipin without eventsDetail yields no tipin ticks', ev5.every(function (e) { return e.type !== 'tipin'; }));

// ---- tolerance: empty log ----
check('empty rows -> []',
  P66.computePlaybackEvents({ rows: [] }, synthMap).length === 0);
check('missing parsedLog -> []',
  P66.computePlaybackEvents(null, synthMap).length === 0);

// ---- index-based time fallback ----
var noTimeRows = [];
for (var q = 0; q < 20; q++) noTimeRows.push({ a: q });
var noTimeMap = { mapping: {}, unmapped: [] };
P66.analyzeKnock = function () {
  return { available: true, events: [{ startIdx: 9, peakKR: 2, rpm: 2000 }] };
};
P66.analyzeTipIn = function () { return { available: false }; };
P66.analyzePeEntry = function () { return { available: false }; };
var ev6 = P66.computePlaybackEvents({ rows: noTimeRows }, noTimeMap);
check('no TIME column falls back to index time',
  ev6.length === 1 && ev6[0].time === 9, JSON.stringify(ev6));
P66.analyzeKnock = realKnock; P66.analyzeTipIn = realTipIn; P66.analyzePeEntry = realPe;

// ---- PE episode scanner ----
var peRows = [];
for (var w = 0; w < 30; w++) {
  peRows.push({ tps: w >= 10 && w < 22 ? '70' : '20', cmd: w >= 14 ? '0.9' : '1.0' });
}
var peEps = P66.peEpisodeIndices(peRows, synthMap);
check('PE scanner finds sustained WOT episode',
  peEps.length === 1 && peEps[0].startIdx === 10,
  JSON.stringify(peEps));
check('PE scanner records engagement delay',
  peEps[0].peDelaySamples === 4, JSON.stringify(peEps[0]));
var shortRows = [];
for (var s = 0; s < 10; s++) shortRows.push({ tps: s >= 3 && s < 6 ? '80' : '10', cmd: '1.0' });
check('PE scanner drops sub-threshold blip', P66.peEpisodeIndices(shortRows, synthMap).length === 0);
check('PE scanner needs TPS and CMD columns',
  P66.peEpisodeIndices(peRows, { mapping: {}, unmapped: [] }).length === 0);
var noPeRows = [];
for (var np = 0; np < 20; np++) noPeRows.push({ tps: np >= 5 && np < 18 ? '65' : '15', cmd: '1.0' });
var noPeEps = P66.peEpisodeIndices(noPeRows, synthMap);
check('PE scanner flags missing PE',
  noPeEps.length === 1 && noPeEps[0].peDelaySamples === null);

// ---- renderEventTicks node guard (no document) ----
check('renderEventTicks returns null without document',
  P66.renderEventTicks(null, null, []) === null);
var ctl = P66.createPlaybackController(synthLog, synthMap);
check('renderEventTicks with controller still returns null without document',
  P66.renderEventTicks({}, ctl, ev) === null);
check('renderEventTicks tolerates null container', P66.renderEventTicks(null, ctl, ev) === null);

// ---- Dale's real log with the real analyzers ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
var realMap = P66.mapChannels(parsed.headers);
var t0 = Date.now();
var realEv = P66.computePlaybackEvents(parsed, realMap);
var ms = Date.now() - t0;
check('real log computes without throwing', Array.isArray(realEv));
check('real log runs fast (<5s)', ms < 5000, ms + 'ms');
var rc = { knock: 0, tipin: 0, pe: 0 };
realEv.forEach(function (e) { rc[e.type]++; });
console.log('  info: real log events knock=' + rc.knock + ' tipin=' + rc.tipin +
  ' pe=' + rc.pe + ' total=' + realEv.length + ' in ' + ms + 'ms');
check('real log has knock events', rc.knock > 0);
check('real log has tipin events', rc.tipin > 0);
check('real log event indices in range',
  realEv.every(function (e) { return e.index >= 0 && e.index < parsed.rows.length; }));
check('real log event times finite',
  realEv.every(function (e) { return isFinite(e.time); }));
check('real log events sorted',
  realEv.every(function (e, i) { return i === 0 || realEv[i - 1].index <= e.index; }));
var kr = P66.analyzeKnock(parsed.rows, realMap);
check('knock tick count matches analyzeKnock event count',
  rc.knock === (kr.available ? kr.events.length : 0),
  'ticks=' + rc.knock + ' analyzer=' + (kr.available ? kr.events.length : 'n/a'));

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
