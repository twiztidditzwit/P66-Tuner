/* Sparkline tests (trailing traces for the playback HUD gauges).
 * Run: node tools/sparklines-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/playback.js', 'js/sparklines.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- fake controller for synthetic tests ----
function fakeCtl(len, valFn, idx) {
  return {
    getIndex: function () { return (idx === undefined) ? len - 1 : idx; },
    valueAt: function (gi, r) { return valFn(gi, r); }
  };
}
function linVal(gi, r) { return r * 2 + 1; }

// ---- sparklineWindow ----
check('exports sparklineWindow', typeof P66.sparklineWindow === 'function');
check('exports drawSparkline', typeof P66.drawSparkline === 'function');
check('exports sparklineStats', typeof P66.sparklineStats === 'function');

var w = P66.sparklineWindow(fakeCtl(500, linVal, 499), 0, 120);
check('window has windowRows entries', w.length === 120);
check('window ends at current index', w[119] === 499 * 2 + 1);
check('window starts windowRows-1 back', w[0] === 380 * 2 + 1);

var w2 = P66.sparklineWindow(fakeCtl(500, linVal, 10), 0, 120);
check('window clamps at row 0', w2.length === 11 && w2[0] === 1 && w2[10] === 21);

var w3 = P66.sparklineWindow(fakeCtl(500, linVal, 499), 0, 1);
check('windowRows 1 returns just the current value', w3.length === 1 && w3[0] === 499 * 2 + 1);

var withGaps = fakeCtl(500, function (gi, r) { return (r % 3 === 0) ? NaN : r; }, 100);
var w4 = P66.sparklineWindow(withGaps, 0, 10);
check('NaN values propagate without throwing', w4.length === 10 && isNaN(w4[2]) && w4[3] === 94);
check('NaN positions preserved', (function () {
  for (var i = 0; i < 10; i++) {
    var r = 91 + i;
    if (r % 3 === 0) { if (!isNaN(w4[i])) return false; }
    else if (w4[i] !== r) return false;
  }
  return true;
})());

check('windowRows 0 returns []', P66.sparklineWindow(fakeCtl(500, linVal, 499), 0, 0).length === 0);
check('negative windowRows returns []', P66.sparklineWindow(fakeCtl(500, linVal, 499), 0, -5).length === 0);
check('null controller returns []', P66.sparklineWindow(null, 0, 120).length === 0);
check('undefined controller returns []', P66.sparklineWindow(undefined, 0, 120).length === 0);
check('controller missing valueAt returns []',
  P66.sparklineWindow({ getIndex: function () { return 0; } }, 0, 120).length === 0);
check('non-numeric valueAt coerces to NaN',
  isNaN(P66.sparklineWindow(fakeCtl(10, function () { return 'abc'; }, 5), 0, 3)[0]));

var gaugeSeen = [];
var w5 = P66.sparklineWindow(fakeCtl(50, function (gi, r) { gaugeSeen.push(gi); return r; }, 10), 7, 5);
check('gaugeIdx passed through to valueAt',
  w5.length === 5 && gaugeSeen.every(function (g) { return g === 7; }));

// ---- sparklineStats ----
var s1 = P66.sparklineStats([3, 1, NaN, 7, 2]);
check('stats min/max ignore NaN', s1.min === 1 && s1.max === 7);
check('stats last is last finite value', s1.last === 2);
var s2 = P66.sparklineStats([NaN, NaN]);
check('stats nulls on all-NaN', s2.min === null && s2.max === null && s2.last === null);
var s3 = P66.sparklineStats([]);
check('stats nulls on empty', s3.min === null && s3.max === null && s3.last === null);
check('stats nulls on null input',
  (function () { var s = P66.sparklineStats(null); return s.min === null && s.last === null; })());
var s4 = P66.sparklineStats([NaN, 42, NaN]);
check('stats single finite value', s4.min === 42 && s4.max === 42 && s4.last === 42);
var s5 = P66.sparklineStats([NaN, -5, 0.25]);
check('stats last skips trailing NaN', s5.last === 0.25);

// ---- drawSparkline ----
function mockCanvas(wd, ht) {
  var calls = [];
  function rec(name, x, y) {
    var c = [name];
    if (x !== undefined) c.push(x);
    if (y !== undefined) c.push(y);
    calls.push(c);
  }
  var ctx = {
    clearRect: function () { rec('clearRect'); },
    beginPath: function () { rec('beginPath'); },
    moveTo: function (x, y) { rec('moveTo', x, y); },
    lineTo: function (x, y) { rec('lineTo', x, y); },
    closePath: function () { rec('closePath'); },
    stroke: function () { rec('stroke'); },
    fill: function () { rec('fill'); },
    fillStyle: null, strokeStyle: null, lineWidth: 0, lineJoin: null
  };
  return {
    width: wd, height: ht, _ctx: ctx, calls: calls,
    getContext: function () { return ctx; }
  };
}
function coordsFinite(calls) {
  return calls.every(function (c) {
    if (c[0] === 'moveTo' || c[0] === 'lineTo') return isFinite(c[1]) && isFinite(c[2]);
    return true;
  });
}
function countCalls(calls, name) {
  return calls.filter(function (c) { return c[0] === name; }).length;
}

check('drawSparkline no-op on null canvas', (function () {
  try { P66.drawSparkline(null, [1, 2, 3], { color: '#fff' }); return true; }
  catch (e) { return false; }
})());
check('drawSparkline no-op on undefined canvas', (function () {
  try { P66.drawSparkline(undefined, [1, 2, 3]); return true; }
  catch (e) { return false; }
})());
check('drawSparkline no-op without getContext', (function () {
  try { P66.drawSparkline({ width: 100, height: 40 }, [1, 2, 3]); return true; }
  catch (e) { return false; }
})());
check('drawSparkline no-op when getContext returns null', (function () {
  try { P66.drawSparkline({ width: 100, height: 40, getContext: function () { return null; } }, [1, 2, 3]); return true; }
  catch (e) { return false; }
})());
check('drawSparkline no-op on zero-size canvas', (function () {
  var m = mockCanvas(0, 0);
  P66.drawSparkline(m, [1, 2, 3]);
  return m.calls.length === 0;
})());
check('drawSparkline no-op on empty values', (function () {
  var m = mockCanvas(100, 40);
  P66.drawSparkline(m, []);
  return m.calls.length === 0;
})());

var m1 = mockCanvas(100, 40);
P66.drawSparkline(m1, [1, 2, 3, 4, 5, 6, 7, 8], { color: '#ff5a5a', fillColor: 'rgba(255,90,90,0.2)', lineWidth: 2 });
check('drawSparkline strokes and fills on varying data',
  countCalls(m1.calls, 'stroke') === 1 && countCalls(m1.calls, 'fill') === 1);
check('drawSparkline coordinates all finite', coordsFinite(m1.calls));
check('drawSparkline honors color option', m1._ctx.strokeStyle === '#ff5a5a');
check('drawSparkline honors fillColor option', m1._ctx.fillStyle === 'rgba(255,90,90,0.2)');
check('drawSparkline honors lineWidth option', m1._ctx.lineWidth === 2);

var m2 = mockCanvas(100, 40);
P66.drawSparkline(m2, [1, 2, 3]);
check('drawSparkline uses defaults without opts',
  m2._ctx.strokeStyle === '#6b9bff' && m2._ctx.lineWidth === 1.5);

var m3 = mockCanvas(100, 40);
P66.drawSparkline(m3, [5, 5, 5, 5]);
check('flat midline on all-equal values',
  countCalls(m3.calls, 'stroke') === 1 && countCalls(m3.calls, 'moveTo') === 1 &&
  countCalls(m3.calls, 'lineTo') === 1);
check('flat midline at vertical center', (function () {
  var mt = m3.calls.filter(function (c) { return c[0] === 'moveTo'; })[0];
  var lt = m3.calls.filter(function (c) { return c[0] === 'lineTo'; })[0];
  return mt[2] === 20.5 && lt[2] === 20.5 && mt[1] === 0 && lt[1] === 100;
})());

var m4 = mockCanvas(100, 40);
P66.drawSparkline(m4, [NaN, NaN, NaN]);
check('flat midline on all-NaN values', countCalls(m4.calls, 'stroke') === 1 && coordsFinite(m4.calls));

var m5 = mockCanvas(120, 40);
P66.drawSparkline(m5, [1, 2, NaN, 4, 5, NaN, 7]);
check('NaN gaps break segments, not crash',
  coordsFinite(m5.calls) && countCalls(m5.calls, 'stroke') === 1);
// stroke pass: NaN gap → moveTo restarts the line: expect 3 moveTo (1 fill moveTo + ... )
check('line splits into 3 segments across 2 gaps', (function () {
  // fill pass contributes moveTo(x,h)+lineTo(x,y) per segment start; stroke pass one moveTo per segment.
  // total lineTo >= per-point; simplest robust check: stroke pass begins each segment with moveTo.
  // Count stroke moveTo = total moveTo minus fill moveTos (one per segment, same count).
  var mv = countCalls(m5.calls, 'moveTo');
  return mv === 6; // 3 fill-path moveTo + 3 stroke-path moveTo
})(), 'moveTo count=' + countCalls(m5.calls, 'moveTo'));

var m6 = mockCanvas(100, 40);
P66.drawSparkline(m6, [3]);
check('single value draws flat midline without division by zero', (function () {
  var mv = m6.calls.filter(function (c) { return c[0] === 'moveTo'; })[0];
  return mv && mv[2] === 20.5 && coordsFinite(m6.calls);
})());

var m7 = mockCanvas(200, 50);
P66.drawSparkline(m7, [10, 20, 30]);
check('y scale uses full range', (function () {
  var lts = m7.calls.filter(function (c) { return c[0] === 'lineTo'; });
  var ys = lts.map(function (c) { return c[2]; });
  var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
  return lo < 25 && hi > 25 && hi - lo > 40; // spans most of the 50px height
})());

// ---- integration with the real controller on Dale's log ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
if (fs.existsSync(logPath)) {
  var parsed = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  var mapResult = P66.mapChannels(parsed.headers);
  var ctl = P66.createPlaybackController(parsed, mapResult);
  check('real controller created', !!ctl);
  var rpmGi = P66.HUD_GAUGES.findIndex(function (g) { return g.signal === 'RPM'; });
  ctl.seek(500);
  var rw = P66.sparklineWindow(ctl, rpmGi, 120);
  check('real window is 120 rows', rw.length === 120);
  check('real window end matches valueAt',
    (function () {
      var v = ctl.valueAt(rpmGi, 500);
      var a = rw[119], b = v;
      if (isNaN(a) && isNaN(b)) return true;
      return a === b;
    })());
  check('real window start matches row 381', rw[0] === ctl.valueAt(rpmGi, 381) || (isNaN(rw[0]) && isNaN(ctl.valueAt(rpmGi, 381))));
  ctl.seek(10);
  var rw2 = P66.sparklineWindow(ctl, rpmGi, 120);
  check('real window clamps near log start', rw2.length === 11);
  var st = P66.sparklineStats(rw);
  check('stats on real RPM window finite', st.min !== null && isFinite(st.min) && st.max >= st.min && st.last !== null);
  var afrGi = P66.HUD_GAUGES.findIndex(function (g) { return g.signal === 'CMD_LAMBDA'; });
  ctl.seek(200);
  var rwAfr = P66.sparklineWindow(ctl, afrGi, 50);
  var finite = rwAfr.filter(function (v) { return isFinite(v); });
  check('AFR-converted window values are AFR-scale when finite',
    finite.length === 0 || finite.every(function (v) { return v > 5; }));
  var ctlSparse = P66.createPlaybackController(parsed, { mapping: { TIME: { column: 'TIME' } }, unmapped: [] });
  ctlSparse.seek(100);
  var rwNaN = P66.sparklineWindow(ctlSparse, rpmGi, 20);
  check('sparklineWindow propagates NaN on unmapped gauge', rwNaN.length === 20 && rwNaN.every(function (v) { return isNaN(v); }));
  ctl.stop();
  ctlSparse.stop();
  var m8 = mockCanvas(100, 40);
  P66.drawSparkline(m8, rw);
  check('drawSparkline handles real log data', coordsFinite(m8.calls) && countCalls(m8.calls, 'stroke') === 1);
} else {
  console.log('  (skipped real-log checks: yesss.csv not present)');
}

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
