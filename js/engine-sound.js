/* P66 engine sound — synthesized 60° V6 engine note that tracks log playback RPM.
 *
 * A small Web Audio synth (sawtooth oscillators at crank-order multiples summed
 * through a WaveShaper + lowpass) whose pitch follows the playback cursor's RPM
 * and whose brightness/loudness follows MAP + TPS load, so a throttle stab
 * sounds like the engine loading up, not just rising pitch.
 *
 * Opt-in only: nothing is created until the user flips the toggle (that click
 * is the user gesture the AudioContext is created/resumed inside, per
 * autoplay policy). When playback pauses, RPM goes missing/NaN, the toggle is
 * flipped off, or update() stops being called, the gain ramps to zero and the
 * context suspends — a watchdog also auto-mutes after 1.5 s without an
 * update() call, so a drone can never be left running.
 *
 * Coordinator wiring (added later — do NOT wire here):
 *   var engineSnd = P66.createEngineSound();
 *   toggle.addEventListener('click', function (e) { engineSnd.setEnabled(e.target.checked); });
 *   volSlider.addEventListener('input', function (e) { engineSnd.setVolume(e.target.value / 100); });
 *   // per playback rAF frame:
 *   engineSnd.update(rpm, mapKpa, tpsPct);
 *   // on playback pause / stop / log unload:
 *   engineSnd.suspend();
 *
 * Pure math (engineSoundFreq, engineSoundHarmonics, engineSoundCutoff) runs
 * under plain node; all AudioContext use is typeof-guarded. See
 * docs/engine-sound.md for the firing-order math and the honesty note
 * (this is synthesized, NOT a recording of the car).
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  // ---------- tiny helpers ----------
  function esFinite(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function clamp01(v) {
    if (!esFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  function clampRpm(rpm) {
    if (!esFinite(rpm) || rpm < 0) return 0;
    return rpm > 7000 ? 7000 : rpm; // clamp past redline so filters never blow up
  }

  // ---------- pure math (node-testable) ----------

  /**
   * Dominant firing frequency of the 4-stroke 60° V6: 3 even firings per
   * crank revolution, 120° apart.
   *   f = RPM / 60 * 3
   * Checkpoints: 800 RPM → 40 Hz, 3000 RPM → 150 Hz, 6000 RPM → 300 Hz.
   * Returns 0 for non-finite/negative RPM.
   */
  function engineSoundFreq(rpm) {
    if (!esFinite(rpm) || rpm <= 0) return 0;
    return rpm / 60 * 3;
  }

  /**
   * Crank-order → relative oscillator weight map, tuned for a 60° V6.
   * 3rd order is the firing order and dominates; 1.5 and 6th are moderate
   * (half-order lope + 2×-firing sizzle); 1st is light so idle lopes rather
   * than thumps.
   */
  function engineSoundHarmonics() {
    return { '1': 0.16, '1.5': 0.55, '3': 1.0, '6': 0.48 };
  }

  /**
   * Lowpass cutoff (Hz) for the exhaust-growl filter: ~400 Hz at idle,
   * rising to ~1200 Hz at high RPM and load. Monotonically non-decreasing
   * in both rpm and load01, always within [400, 1200].
   */
  function engineSoundCutoff(rpm, load01) {
    var rn = clamp01(clampRpm(rpm) / 6000);
    var ln = clamp01(load01);
    return 400 + 800 * (0.6 * Math.pow(rn, 1.25) + 0.4 * ln);
  }

  // ---------- internal (not exported) ----------

  // Combined engine-load cue 0..1 from MAP and TPS. MAP carries most of the
  // weight (it's the true load signal); TPS catches the tip-in transient.
  function esLoad01(mapKpa, tpsPct) {
    var m = esFinite(mapKpa) ? clamp01(mapKpa / 100) : 0;
    var t = esFinite(tpsPct) ? clamp01(tpsPct / 100) : 0;
    return 0.65 * m + 0.35 * t;
  }

  // Master-gain target 0..1 (before the user's volume knob): grows with RPM
  // and load so a throttle stab pushes the engine louder, not just brighter.
  function esGainTarget(rpm, load01) {
    var rn = clamp01(clampRpm(rpm) / 6000);
    return (0.12 + 0.88 * Math.pow(rn, 1.4)) * (0.30 + 0.70 * clamp01(load01));
  }

  function esAudioCtor() {
    if (typeof AudioContext !== 'undefined') return AudioContext;
    if (typeof webkitAudioContext !== 'undefined') return webkitAudioContext;
    return null;
  }

  // Soft-clip drive curve for the WaveShaper — exhaust growl, not fuzz.
  function esDriveCurve(amount) {
    var n = 1024, curve = new Float32Array(n), i, x;
    var norm = Math.tanh(amount);
    for (i = 0; i < n; i++) {
      x = i / (n - 1) * 2 - 1;
      curve[i] = Math.tanh(amount * x) / norm;
    }
    return curve;
  }

  /**
   * Create an engine-sound synth instance. Returns:
   *   { setEnabled(bool), setVolume(0..1), update(rpm, mapKpa, tpsPct),
   *     suspend(), destroy(), isEnabled(), _state() }
   * _state() is a debug/test hook: { enabled, sounding, hasContext,
   * volume, supported }.
   *
   * setEnabled(true) must be called from a user gesture (the toggle click);
   * it creates the AudioContext there and resumes it if suspended. Returns
   * true when audio actually became available, false when the Web Audio API
   * is missing (node, old browser) — the toggle can use that to disable
   * itself.
   */
  function createEngineSound() {
    var enabled = false;
    var volume = 0.7;
    var sounding = false;
    var supported = esAudioCtor() !== null;

    var ctx = null, master = null, filter = null, shaper = null, voices = [];
    var lastUpdateMs = 0, watchdogTimer = null;

    function now() { return (typeof Date.now === 'function') ? Date.now() : 0; }

    function buildGraph(AC) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0; // start silent; update() ramps it up
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      filter.Q.value = 0.7;
      shaper = ctx.createWaveShaper();
      shaper.curve = esDriveCurve(2.2);
      shaper.oversample = '2x';

      var weights = P66.engineSoundHarmonics();
      voices = [];
      Object.keys(weights).forEach(function (key) {
        var order = parseFloat(key);
        var osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 40 * (order / 3); // idle-ish seed; update() retunes
        var g = ctx.createGain();
        g.gain.value = weights[key];
        osc.connect(g);
        g.connect(shaper);
        osc.start();
        voices.push({ osc: osc, gain: g, order: order });
      });

      shaper.connect(filter);
      filter.connect(master);
      master.connect(ctx.destination);
    }

    function startWatchdog() {
      if (watchdogTimer !== null || typeof setInterval !== 'function') return;
      watchdogTimer = setInterval(function () {
        // Safety: if the playback loop stopped feeding us, never leave a
        // drone running — mute fast and suspend the context.
        if (enabled && ctx && sounding && now() - lastUpdateMs > 1500) {
          muteFast();
        }
      }, 500);
      if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
        watchdogTimer.unref(); // don't hold a node test process open
      }
    }

    function stopWatchdog() {
      if (watchdogTimer !== null && typeof clearInterval === 'function') {
        clearInterval(watchdogTimer);
      }
      watchdogTimer = null;
    }

    // Ramp the master gain to zero quickly; suspend the context once quiet.
    function muteFast() {
      sounding = false;
      if (ctx && master) {
        try {
          var t = ctx.currentTime;
          master.gain.setTargetAtTime(0, t, 0.03);
        } catch (e) { /* node fakes / torn-down graph */ }
        var c = ctx;
        setTimeout(function () {
          try { if (c.state === 'running') c.suspend(); } catch (e2) { /* noop */ }
        }, 160);
      }
    }

    function setEnabled(on) {
      on = !!on;
      if (on === enabled) return supported && !!ctx;
      enabled = on;
      if (on) {
        var AC = esAudioCtor();
        if (!AC) return false; // no Web Audio here: stay silent, report it
        try {
          if (!ctx) buildGraph(AC);
          if (ctx.state === 'suspended') ctx.resume();
        } catch (e) {
          enabled = false;
          return false;
        }
        startWatchdog();
        return true;
      }
      stopWatchdog();
      muteFast();
      return true;
    }

    function setVolume(v) {
      if (esFinite(v)) volume = Math.min(1, Math.max(0, v));
    }

    // Cheap enough for every animation frame: a handful of
    // setTargetAtTime calls (smoothing handled by the audio thread — no
    // zipper noise). NaN/missing RPM mutes instead of throwing.
    function update(rpm, mapKpa, tpsPct) {
      lastUpdateMs = now();
      if (!enabled || !ctx || !master) { sounding = false; return; }
      var r = esFinite(rpm) ? rpm : NaN;
      if (!esFinite(r) || r <= 0) { muteFast(); return; }
      var load = esLoad01(mapKpa, tpsPct);
      var crank = r / 60; // crank rev/s; order-3 voice == engineSoundFreq(r)
      var cutoff = engineSoundCutoff(r, load);
      var target = esGainTarget(r, load) * volume;
      try {
        var t = ctx.currentTime;
        var i, v;
        for (i = 0; i < voices.length; i++) {
          v = voices[i];
          v.osc.frequency.setTargetAtTime(crank * v.order, t, 0.03);
        }
        filter.frequency.setTargetAtTime(cutoff, t, 0.05);
        master.gain.setTargetAtTime(target, t, 0.06);
        if (ctx.state === 'suspended') ctx.resume();
        sounding = true;
      } catch (e) {
        sounding = false;
      }
    }

    // Playback paused / stopped / log unloaded: ramp to silence and suspend
    // the context immediately. Cheap and idempotent.
    function suspend() {
      muteFast();
    }

    function destroy() {
      stopWatchdog();
      enabled = false;
      sounding = false;
      var i;
      for (i = 0; i < voices.length; i++) {
        try { voices[i].osc.stop(); } catch (e) { /* noop */ }
        try { voices[i].osc.disconnect(); } catch (e2) { /* noop */ }
      }
      voices = [];
      if (ctx) {
        try { ctx.close(); } catch (e3) { /* noop */ }
      }
      ctx = null; master = null; filter = null; shaper = null;
    }

    function isEnabled() {
      return enabled && supported && !!ctx;
    }

    function state() {
      return {
        enabled: enabled,
        sounding: sounding,
        hasContext: !!ctx,
        volume: volume,
        supported: supported
      };
    }

    return {
      setEnabled: setEnabled,
      setVolume: setVolume,
      update: update,
      suspend: suspend,
      destroy: destroy,
      isEnabled: isEnabled,
      _state: state
    };
  }

  P66.engineSoundFreq = engineSoundFreq;
  P66.engineSoundHarmonics = engineSoundHarmonics;
  P66.engineSoundCutoff = engineSoundCutoff;
  P66.createEngineSound = createEngineSound;
})(typeof window !== 'undefined' ? window : global);
