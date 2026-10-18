/* Engine sound tests (synthesized 60° V6 note for log playback).
 * Run: node tools/engine-sound-test.js
 *
 * Pure math is tested directly; the Web Audio graph is exercised under node
 * through a fake AudioContext, since the module typeof-guards all real
 * AudioContext usage.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/engine-sound.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
}

// ---- exports ----
check('exports engineSoundFreq', typeof P66.engineSoundFreq === 'function');
check('exports engineSoundHarmonics', typeof P66.engineSoundHarmonics === 'function');
check('exports engineSoundCutoff', typeof P66.engineSoundCutoff === 'function');
check('exports createEngineSound', typeof P66.createEngineSound === 'function');

// ---- firing frequency: f = RPM/60*3 ----
check('800 RPM -> 40 Hz', approx(P66.engineSoundFreq(800), 40));
check('1500 RPM -> 75 Hz', approx(P66.engineSoundFreq(1500), 75));
check('3000 RPM -> 150 Hz', approx(P66.engineSoundFreq(3000), 150));
check('4500 RPM -> 225 Hz', approx(P66.engineSoundFreq(4500), 225));
check('6000 RPM -> 300 Hz', approx(P66.engineSoundFreq(6000), 300));
check('0 RPM -> 0 Hz', P66.engineSoundFreq(0) === 0);
check('negative RPM -> 0 Hz', P66.engineSoundFreq(-500) === 0);
check('NaN RPM -> 0 Hz', P66.engineSoundFreq(NaN) === 0);
check('non-numeric RPM -> 0 Hz', P66.engineSoundFreq('fast') === 0);

// ---- harmonic weights ----
var H = P66.engineSoundHarmonics();
check('harmonics has 1st, 1.5, 3rd, 6th orders',
  H['1'] !== undefined && H['1.5'] !== undefined && H['3'] !== undefined && H['6'] !== undefined);
check('harmonics has exactly the four expected orders',
  Object.keys(H).sort().join(',') === '1,1.5,3,6');
check('3rd order is strongest', H['3'] > H['1.5'] && H['3'] > H['6'] && H['3'] > H['1']);
check('1.5 and 6th orders are moderate (below 3rd, above 1st)',
  H['1.5'] < H['3'] && H['6'] < H['3'] && H['1.5'] > H['1'] && H['6'] > H['1']);
check('1st order is lightest but positive', H['1'] > 0 && H['1'] < H['6']);
check('all weights within (0, 1]',
  Object.keys(H).every(function (k) { return H[k] > 0 && H[k] <= 1; }));

// ---- lowpass cutoff ----
var cIdle = P66.engineSoundCutoff(800, 0.15);
var cMax = P66.engineSoundCutoff(6000, 1);
check('cutoff ~400 Hz at idle', cIdle >= 400 && cIdle < 600, 'got ' + cIdle);
check('cutoff reaches ~1200 Hz at max RPM/load', approx(cMax, 1200), 'got ' + cMax);
check('cutoff monotonically non-decreasing with RPM', (function () {
  var prev = -Infinity, load = 0.5, r;
  for (r = 500; r <= 7000; r += 250) {
    var c = P66.engineSoundCutoff(r, load);
    if (c < prev) return false;
    prev = c;
  }
  return true;
})());
check('cutoff monotonically non-decreasing with load', (function () {
  var prev = -Infinity, l;
  for (l = 0; l <= 1.0001; l += 0.1) {
    var c = P66.engineSoundCutoff(3000, l);
    if (c < prev) return false;
    prev = c;
  }
  return true;
})());
check('cutoff within sane bounds across the operating range', (function () {
  var r, l;
  for (r = 0; r <= 7000; r += 500) {
    for (l = 0; l <= 1.0001; l += 0.25) {
      var c = P66.engineSoundCutoff(r, l);
      if (!(c >= 400 && c <= 1200)) return false;
    }
  }
  return true;
})());
check('cutoff handles NaN inputs gracefully',
  P66.engineSoundCutoff(NaN, NaN) === 400 && P66.engineSoundCutoff(3000, NaN) >= 400);

// ---- module loads under node with NO AudioContext defined ----
check('no AudioContext under node', typeof AudioContext === 'undefined');
var sndSilent = P66.createEngineSound();
check('handle exposes the six API methods',
  ['setEnabled', 'setVolume', 'update', 'suspend', 'destroy', 'isEnabled']
    .every(function (m) { return typeof sndSilent[m] === 'function'; }));
check('setEnabled(true) without Web Audio returns false', sndSilent.setEnabled(true) === false);
check('isEnabled() false without Web Audio', sndSilent.isEnabled() === false);
check('_state().supported false without Web Audio', sndSilent._state().supported === false);
check('update() with no AudioContext does not throw', (function () {
  try { sndSilent.update(3000, 60, 20); return true; } catch (e) { return false; }
})());
check('no sounding state without Web Audio', sndSilent._state().sounding === false);
check('setVolume clamps without Web Audio', (function () {
  sndSilent.setVolume(2); var hi = sndSilent._state().volume === 1;
  sndSilent.setVolume(-1); var lo = sndSilent._state().volume === 0;
  return hi && lo;
})());
sndSilent.destroy();

// ---- fake AudioContext for the graph path ----
function fakeParam() {
  var calls = [];
  var p = {
    value: 0,
    _calls: calls,
    setTargetAtTime: function (v, t, tc) { calls.push([v, t, tc]); p.value = v; },
    setValueAtTime: function (v) { p.value = v; }
  };
  return p;
}
function FakeAudioContext() {
  this.currentTime = 1.5;
  this.state = 'running';
  this.destination = {};
  this._gains = [];
  this._filters = [];
  this._oscs = [];
  this._shapers = [];
  this._suspendCalls = 0;
  this._resumeCalls = 0;
}
FakeAudioContext.prototype.createGain = function () {
  var n = { gain: fakeParam(), connect: function () {}, disconnect: function () {} };
  this._gains.push(n); return n;
};
FakeAudioContext.prototype.createOscillator = function () {
  var n = {
    frequency: fakeParam(), type: null, _started: false, _stopped: false,
    connect: function () {}, disconnect: function () {},
    start: function () { n._started = true; }, stop: function () { n._stopped = true; }
  };
  this._oscs.push(n); return n;
};
FakeAudioContext.prototype.createBiquadFilter = function () {
  var n = { frequency: fakeParam(), Q: fakeParam(), type: null,
    connect: function () {}, disconnect: function () {} };
  this._filters.push(n); return n;
};
FakeAudioContext.prototype.createWaveShaper = function () {
  var n = { curve: null, oversample: null, connect: function () {}, disconnect: function () {} };
  this._shapers.push(n); return n;
};
FakeAudioContext.prototype.resume = function () { this._resumeCalls++; this.state = 'running'; };
FakeAudioContext.prototype.suspend = function () { this._suspendCalls++; this.state = 'suspended'; };
FakeAudioContext.prototype.close = function () { this.state = 'closed'; };
global.AudioContext = FakeAudioContext;

var snd = P66.createEngineSound();
check('fake AudioContext detected as supported', snd._state().supported === true);
check('setEnabled(true) returns true with Web Audio', snd.setEnabled(true) === true);
check('isEnabled() true after enable', snd.isEnabled() === true);
check('context created on enable', snd._state().hasContext === true);

// update() with NaN / missing RPM: no throw, muted state
check('update(NaN) does not throw', (function () {
  try { snd.update(NaN, 60, 20); return true; } catch (e) { return false; }
})());
check('update(NaN) leaves muted state', snd._state().sounding === false);
check('update() with no args does not throw', (function () {
  try { snd.update(); return true; } catch (e) { return false; }
})());
check('update() with no args leaves muted state', snd._state().sounding === false);
check('update(0 RPM) mutes', (function () {
  snd.update(0, 60, 20); return snd._state().sounding === false;
})());

// healthy update: 3000 RPM -> sounding
snd.update(3000, 60, 20);
check('update(3000 RPM) enters sounding state', snd._state().sounding === true);

// The module keeps ctx in closure, so exact param assertions use a probed
// handle whose fake context instance we track.
var snd2 = P66.createEngineSound();
snd2.setEnabled(true);
check('update before enable leaves no sounding state', (function () {
  var s3 = P66.createEngineSound();
  s3.setEnabled(false);
  s3.update(3000, 60, 20);
  var ok = s3._state().sounding === false;
  s3.destroy();
  return ok;
})());

// Capture the fake context via a second handle whose nodes we can inspect:
// (the module keeps ctx in closure, so we probe behavior through _state and
//  the fake's recorded param calls on a context we inject by reference)
function inspectableHandle() {
  var h = P66.createEngineSound();
  h.setEnabled(true);
  return h;
}
var probe = inspectableHandle();
// Reach the fake context: it is the most recent FakeAudioContext instance.
// We track instances instead.
var instances = [];
var OrigFake = global.AudioContext;
global.AudioContext = function () {
  var c = new OrigFake();
  instances.push(c);
  return c;
};
var probed = P66.createEngineSound();
probed.setEnabled(true);
var pctx = instances[instances.length - 1];
check('probe context captured', !!pctx);
check('four voices built (one per harmonic order)', pctx._oscs.length === 4);
probed.update(3000, 60, 20);
check('master gain ramped above zero at 3000 RPM', (function () {
  var calls = pctx._gains[0].gain._calls;
  var last = calls[calls.length - 1];
  return last && last[0] > 0;
})());
check('filter cutoff within [400, 1200] at 3000 RPM', (function () {
  var calls = pctx._filters[0].frequency._calls;
  var last = calls[calls.length - 1];
  return last && last[0] >= 400 && last[0] <= 1200;
})());
check('order-3 oscillator at firing freq 150 Hz', (function () {
  return pctx._oscs.some(function (o) {
    var calls = o.frequency._calls;
    var last = calls[calls.length - 1];
    return last && approx(last[0], 150, 0.5);
  });
})());
check('order-6 oscillator at 300 Hz', (function () {
  return pctx._oscs.some(function (o) {
    var calls = o.frequency._calls;
    var last = calls[calls.length - 1];
    return last && approx(last[0], 300, 0.5);
  });
})());
check('all oscillators started', pctx._oscs.every(function (o) { return o._started; }));
check('WaveShaper has a drive curve', pctx._shapers.length === 1 && pctx._shapers[0].curve !== null);
check('higher load raises cutoff', (function () {
  probed.update(3000, 95, 90);
  var hi = pctx._filters[0].frequency._calls.slice(-1)[0][0];
  probed.update(3000, 25, 5);
  var lo = pctx._filters[0].frequency._calls.slice(-1)[0][0];
  return hi > lo;
})());
check('higher load raises gain', (function () {
  probed.update(3000, 95, 90);
  var hi = pctx._gains[0].gain._calls.slice(-1)[0][0];
  probed.update(3000, 25, 5);
  var lo = pctx._gains[0].gain._calls.slice(-1)[0][0];
  return hi > lo;
})());

// setEnabled(false) after true: no sounding state left
check('setEnabled(false) after true returns true', probed.setEnabled(false) === true);
check('setEnabled(false) clears enabled flag', probed._state().enabled === false);
check('setEnabled(false) leaves no sounding state', probed._state().sounding === false);
check('isEnabled() false after disable', probed.isEnabled() === false);
check('master gain ramped to zero on disable', (function () {
  var calls = pctx._gains[0].gain._calls;
  var last = calls[calls.length - 1];
  return last && last[0] === 0;
})());

// suspend() path
probed.setEnabled(true);
probed.update(3000, 60, 20);
check('re-enabled and sounding', probed._state().sounding === true);
probed.suspend();
check('suspend() clears sounding state', probed._state().sounding === false);
check('suspend() ramps gain to zero', (function () {
  var calls = pctx._gains[0].gain._calls;
  var last = calls[calls.length - 1];
  return last && last[0] === 0;
})());

// setVolume clamps
probed.setVolume(2);
check('setVolume(2) clamps to 1', probed._state().volume === 1);
probed.setVolume(-0.5);
check('setVolume(-0.5) clamps to 0', probed._state().volume === 0);
probed.setVolume(0.5);
check('setVolume(0.5) passes through', probed._state().volume === 0.5);
probed.setVolume(NaN);
check('setVolume(NaN) keeps previous volume', probed._state().volume === 0.5);
probed.setVolume(0.7);

// destroy()
probed.destroy();
check('destroy() clears context flag', probed._state().hasContext === false);
check('destroy() clears sounding', probed._state().sounding === false);
check('destroy() clears enabled', probed._state().enabled === false);
check('destroy() stops all oscillators', pctx._oscs.every(function (o) { return o._stopped; }));
check('destroy() closes the context', pctx.state === 'closed');

// watchdog: no update() for >1.5 s auto-mutes.
// The 500 ms interval tick needs the event loop free, so the stall is
// simulated with a patched Date.now and the assertion runs in a timer.
var watch = P66.createEngineSound();
watch.setEnabled(true);
var wctx = instances[instances.length - 1];
watch.update(3000, 60, 20);
check('watchdog handle sounding before stall', watch._state().sounding === true);
var realNow = Date.now;
Date.now = function () { return realNow() + 5000; }; // simulate a stalled playback loop
setTimeout(function () {
  Date.now = realNow;
  check('watchdog auto-mutes after 1.5 s without update()', watch._state().sounding === false);
  watch.destroy();

  // idle lope: 800 RPM order-1 voice at ~13.3 Hz
  var idle = P66.createEngineSound();
  idle.setEnabled(true);
  var ictx = instances[instances.length - 1];
  idle.update(800, 35, 0);
  check('idle update sounds', idle._state().sounding === true);
  check('order-1 voice at crank freq ~13.3 Hz (idle lope)', (function () {
    return ictx._oscs.some(function (o) {
      var calls = o.frequency._calls;
      var last = calls[calls.length - 1];
      return last && approx(last[0], 800 / 60, 0.5);
    });
  })());
  idle.destroy();
  snd.destroy();
  snd2.destroy();
  probe.destroy();

  console.log(checks + ' checks, ' + failures + ' failures.');
  process.exit(failures ? 1 : 0);
}, 800);
