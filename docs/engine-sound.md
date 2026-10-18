# Engine sound (synth) — `js/engine-sound.js`

A synthesized engine-note generator that tracks log RPM during playback. Opt-in
via a toggle in the playback HUD; when enabled, a Web Audio synth follows the
playback cursor's RPM for pitch and MAP/TPS for load, so a throttle stab in the
log sounds like the engine loading up — brighter and louder, not just higher
pitched.

> ## ⚠️ HONESTY NOTE
>
> This module nails the **60° V6 firing-order character** (the 3-per-rev thrum,
> the half-order lope at idle), but it is **100% synthesized** — sawtooth
> oscillators, a waveshaper, and a lowpass filter. It is **NOT a recording of
> Dale's Camaro exhaust**. Do not imply otherwise anywhere in the UI, docs, or
> promo copy. Suggested HUD label: **"Engine sound (synth)"**.

## The firing-order math

Target engine: 4-stroke 60° V6 → **3 firings per crank revolution**, evenly
spaced 120° apart.

- Dominant firing frequency: `f = RPM / 60 × 3`
  - 800 RPM (idle) → **40 Hz**
  - 3000 RPM → **150 Hz**
  - 6000 RPM → **300 Hz**
- Pure function: `P66.engineSoundFreq(rpm)` (0 for non-finite/negative RPM).
- Timbre: one sawtooth oscillator per crank-order multiple, weighted by
  `P66.engineSoundHarmonics()` → `{ '1': 0.16, '1.5': 0.55, '3': 1.0, '6': 0.48 }`
  - **3rd order (firing) dominates** — the V6 signature.
  - 1.5 (half-order) and 6th are moderate: lope and top-end sizzle.
  - 1st (crank rotation) is light: idle lopes instead of thumping.
- The voices sum through a WaveShaper (tanh soft-clip ≈ exhaust growl, not
  fuzz) into a lowpass BiquadFilter, then a master gain.

## Control mapping

| Input | Drives | How |
|---|---|---|
| RPM | Pitch | each voice freq = `(RPM/60) × order`, smoothed with `setTargetAtTime` (τ = 30 ms) — no zipper noise |
| RPM + load | Lowpass cutoff | `P66.engineSoundCutoff(rpm, load01)`: ~400 Hz at idle → ~1200 Hz at high RPM/load, monotonic in both, clamped [400, 1200], smoothed (τ = 50 ms) |
| RPM + load | Loudness | gain target `(0.12 + 0.88·rpmNorm^1.4) × (0.30 + 0.70·load01)`, smoothed (τ = 60 ms) |
| MAP (kPa) + TPS (%) | Load cue | `load01 = 0.65·clamp(MAP/100) + 0.35·clamp(TPS/100)` — MAP is the true load signal, TPS catches the tip-in transient |

`update(rpm, mapKpa, tpsPct)` is cheap (a handful of `setTargetAtTime` calls —
smoothing happens on the audio thread) and safe to call every animation frame.
NaN/missing/zero RPM mutes instead of throwing.

## Safety: never leave a drone running

- **Opt-in only.** No `AudioContext` is created until the user flips the
  toggle — that click is the user gesture the context is created/resumed
  inside (autoplay policy).
- **Pause / NaN RPM / toggle-off** → master gain ramps to 0 in ~30 ms, then
  the context suspends.
- **Watchdog:** a 500 ms interval auto-mutes (gain → 0, context suspends) if
  `update()` hasn't been called for > 1.5 s — e.g. the playback loop died
  while enabled.
- `suspend()` is idempotent and cheap: call it on playback pause/stop and log
  unload. `destroy()` tears the whole graph down.

## Node compatibility

Web Audio doesn't exist under node, and the repo's test suites `eval` js files
under node. Every `AudioContext` reference is `typeof`-guarded:

- the file loads cleanly with no `AudioContext` defined;
- `createEngineSound()` still returns a working (silent) handle;
- `setEnabled(true)` returns `false` and `isEnabled()` stays `false` without
  Web Audio, so the UI can disable the toggle;
- all pure math (`engineSoundFreq`, `engineSoundHarmonics`,
  `engineSoundCutoff`) is fully testable under node.

`tools/engine-sound-test.js` (75 checks) additionally exercises the whole graph
path under node through a fake `AudioContext`.

## API

```js
var snd = P66.createEngineSound();
snd.setEnabled(true);        // from the toggle click; returns false if no Web Audio
snd.setVolume(0.7);          // clamped to 0..1
snd.update(rpm, mapKpa, tpsPct); // per rAF frame; NaN-safe
snd.suspend();               // pause/stop: ramp to silence, suspend context
snd.destroy();               // tear down
snd.isEnabled();             // enabled && Web Audio available && context built
snd._state();                // debug/test hook: { enabled, sounding, hasContext, volume, supported }
```

## Upgrade path (documented, NOT built)

If Dale records **~10 seconds of his actual Camaro** — a few seconds of idle
plus one clean rev — the oscillator stack can be replaced with a
**granular / pitch-shifting sampler**: loop a short exhaust slice through a
grain player whose playback rate tracks `RPM / recordedRPM`, keeping the same
`update(rpm, mapKpa, tpsPct)` signature and the same cutoff/gain mapping. The
synth then becomes the fallback for logs without a recording. Nothing in the
wiring below needs to change for that swap — only the module internals.

## Wiring (for the coordinator — NOT done in this change)

`js/playback.js` and `app.js` are under active refactor by other builders, so
this module is **not wired in yet**. When the coordinator wires it:

**1. Script tag** — add to `index.html` with the other js/ includes (before
`app.js`):

```html
<script src="js/engine-sound.js"></script>
```

(`tools/package-zip.js` globs `js/*`, so no packager change is needed.)

**2. HUD controls** — toggle checkbox + volume slider in the playback HUD
(near the play/pause transport). Label must say it's synthesized:

```html
<label class="hud-sound-toggle">
  <input type="checkbox" id="hud-sound-toggle"> Engine sound (synth)
</label>
<input type="range" id="hud-sound-vol" min="0" max="100" value="70"
       aria-label="Engine sound volume">
```

**3. Hook-up** — in the playback controller setup (app.js):

```js
// --- engine sound (synth), opt-in ---
var engineSnd = P66.createEngineSound();
var sndToggle = document.getElementById('hud-sound-toggle');
var sndVol = document.getElementById('hud-sound-vol');
if (!engineSnd._state().supported && sndToggle) {
  sndToggle.disabled = true;
  sndToggle.title = 'Web Audio not available in this browser';
}
// The click IS the user gesture: the AudioContext is created/resumed here.
sndToggle.addEventListener('click', function (e) {
  var ok = engineSnd.setEnabled(e.target.checked);
  if (!ok) e.target.checked = false; // no Web Audio — stay off
});
sndVol.addEventListener('input', function (e) {
  engineSnd.setVolume(e.target.value / 100);
});
```

**4. Per-frame drive** — inside the existing playback rAF loop, after the
cursor advances (use whatever RPM/MAP/TPS accessors the columnar refactor
provides):

```js
// in the playback rAF tick:
engineSnd.update(currentRpm, currentMapKpa, currentTpsPct);
```

**5. Pause/stop/unload** — wherever playback pauses, stops, or a new log
loads:

```js
engineSnd.suspend();
```

That's the whole integration: one script tag, two HUD controls, one
`update()` call per frame, one `suspend()` on pause. No changes to the module
itself are needed.
