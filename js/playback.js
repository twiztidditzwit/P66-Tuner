/* P66 Log Playback — TunerPro-style HUD dashboard.
 *
 * Renders a 4x4 gauge grid resembling the TunerPro dashboard (Engine Speed,
 * Vehicle Speed, Spark Advance, Knock Retard, Injector Duty Cycle, IAC
 * Position, MAP, Coolant, O2 sensors, INTs, BLMs, Target AFR, TPS) and plays
 * the parsed log back through it with transport controls (play/pause,
 * scrubber, speed). Gauges whose channel is not mapped show a dash.
 *
 * Everything is driven by raw log values — no analysis, no patching.
 */
(function (global) {
  'use strict';
  var P66 = (global.P66 = global.P66 || {});

  // 16 gauges, in the same order as the TunerPro dashboard screenshot.
  // color: value text color. border: tile border color.
  var HUD_GAUGES = [
    { signal: 'RPM',       label: 'Engine Speed',        unit: 'RPM',  decimals: 0, color: '#eef1f6', border: '#e0574f' },
    { signal: 'VSS',       label: 'Vehicle Speed',       unit: 'MPH',  decimals: 0, color: '#eef1f6', border: '#e0574f' },
    { signal: 'SPARK_ADV', label: 'Spark Advance',       unit: '°',    decimals: 2, color: '#eef1f6', border: '#e0574f' },
    { signal: 'KR',        label: 'Knock Retard',        unit: '°',    decimals: 2, color: '#ffd60a', border: '#e0574f' },
    { signal: 'INJ_DC',    label: 'Injector Duty Cycle', unit: '%',    decimals: 2, color: '#eef1f6', border: '#e0574f' },
    { signal: 'IAC',       label: 'IAC Position',        unit: 'Steps', decimals: 0, color: '#6b9bff', border: '#e0574f' },
    { signal: 'MAP',       label: 'MAP',                 unit: 'kPa',  decimals: 2, color: '#eef1f6', border: '#e0574f' },
    { signal: 'ECT',       label: 'Coolant',             unit: '°F',   decimals: 2, color: '#9aa4b2', border: '#6b9bff' },
    { signal: 'O2_B1',     label: 'Left/Front O2 Sensor',  unit: 'mV', decimals: 2, color: '#6b9bff', border: '#6b9bff' },
    { signal: 'O2_B2',     label: 'Right/Rear O2 Sensor',  unit: 'mV', decimals: 2, color: '#6b9bff', border: '#6b9bff' },
    { signal: 'STFT_B1',   label: 'Left/Front INT',      unit: '',     decimals: 2, color: '#ff7a59', border: '#3fb950', fallback: ['STFT'] },
    { signal: 'STFT_B2',   label: 'Right/Rear INT',      unit: '',     decimals: 0, color: '#ff7a59', border: '#3fb950', fallback: ['STFT'] },
    { signal: 'LTFT_B1',   label: 'Left/Front BLM',      unit: '',     decimals: 2, color: '#ff7a59', border: '#3fb950', fallback: ['LTFT'] },
    { signal: 'LTFT_B2',   label: 'Right/Rear BLM',      unit: '',     decimals: 0, color: '#ff7a59', border: '#ffd60a', fallback: ['LTFT'] },
    { signal: 'CMD_LAMBDA', label: 'Target Air/Fuel Ratio', unit: 'AFR', decimals: 2, color: '#ff9f43', border: '#ff9f43', toAfr: true },
    { signal: 'TPS',       label: 'TPS',                 unit: '%',    decimals: 2, color: '#ff9f43', border: '#e0574f' }
  ];

  /**
   * Format one gauge value. Non-finite or missing values become a dash.
   */
  function pbFmt(v, decimals) {
    if (v === null || v === undefined) return '—';
    var n = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(n)) return '—';
    return n.toFixed(decimals);
  }

  /**
   * Convert a commanded value to AFR. Logs carry this either as lambda
   * (0.5–2.5) or already as AFR (>5); lambda gets scaled by 14.7.
   */
  function pbToAfr(v) {
    var n = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(n)) return NaN;
    if (n >= 0.2 && n <= 2.5) return n * 14.7;
    return n;
  }

  /**
   * Value color under the 128 rule: below 128 (rich / removing fuel) renders
   * red, above 128 (lean / adding fuel) renders blue, exactly 128 keeps the
   * gauge's default color. Non-numeric values keep the default color too.
   */
  var PB_RED = '#ff5a5a';
  var PB_BLUE = '#6b9bff';
  function pbValueColor(g, v) {
    var n = (typeof v === 'number') ? v : parseFloat(v);
    if (!isFinite(n)) return g.color;
    if (n < 128) return PB_RED;
    if (n > 128) return PB_BLUE;
    return g.color;
  }
  /**
   * Build the per-row timestamp array. Falls back to row-index timing when
   * the TIME channel is missing or non-numeric.
   * rows: a log table or a legacy array of row objects.
   * Returns { times: number[], indexed: boolean }.
   */
  function pbBuildTimes(rows, timeCol) {
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    // numView parses string-channel cells per cell, mirroring the old
    // row-object parseFloat behavior for odd TIME formats.
    var tc = P66.numView(t, timeCol);
    var times = new Array(n);
    var ok = 0;
    for (var i = 0; i < n; i++) {
      var v = tc ? tc[i] : NaN;
      if (isFinite(v)) { times[i] = v; ok++; } else { times[i] = NaN; }
    }
    if (ok < n * 0.9) {
      // Not enough usable timestamps — scrub by row index instead.
      for (var j = 0; j < n; j++) times[j] = j;
      return { times: times, indexed: true };
    }
    // Fill rare gaps by interpolation so the search never sees NaN.
    var last = times[0];
    for (var k = 0; k < times.length; k++) {
      if (times[k] === times[k]) { last = times[k]; } else { times[k] = last; }
    }
    return { times: times, indexed: false };
  }

  /**
   * Binary search: index of the last row with time <= t.
   */
  function pbRowIndexAt(times, t) {
    var lo = 0, hi = times.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  /**
   * Resolve each gauge to its log column, honoring fallbacks.
   * Returns an array parallel to HUD_GAUGES: column name or null.
   */
  function pbResolveColumns(mapResult) {
    return HUD_GAUGES.map(function (g) {
      var col = P66.columnFor ? P66.columnFor(mapResult, g.signal) : null;
      if (!col && g.fallback) {
        for (var i = 0; i < g.fallback.length; i++) {
          col = P66.columnFor ? P66.columnFor(mapResult, g.fallback[i]) : null;
          if (col) break;
        }
      }
      return col;
    });
  }

  function fmtClock(t, indexed) {
    if (indexed) return 'row ' + Math.round(t);
    return t.toFixed(1) + 's';
  }

  /**
   * Pure keyboard-shortcut mapper (no DOM — fully unit-testable).
   *
   * key:   KeyboardEvent.key (legacy 'Spacebar' accepted too).
   * mods:  { shift, ctrl, meta, alt } booleans.
   * state: { index, rowCount, eventIndices } — eventIndices sorted ascending,
   *        from P66.computePlaybackEvents (same source as the tick strip).
   *
   * Returns an action descriptor — { type: 'toggle' } or
   * { type: 'seek', index } — or null when the key does nothing.
   * Ctrl/Meta/Alt combinations are never hijacked (browser shortcuts win).
   */
  function playbackKeyAction(key, mods, state) {
    mods = mods || {};
    if (mods.ctrl || mods.meta || mods.alt) return null;
    state = state || {};
    var rowCount = Math.max(1, state.rowCount | 0);
    var idx = Math.max(0, Math.min(rowCount - 1, state.index | 0));
    var events = state.eventIndices || [];
    var k = (key === 'Spacebar') ? ' ' : key;
    if (k === ' ') return { type: 'toggle' };
    if (k === 'ArrowLeft') return { type: 'seek', index: Math.max(0, idx - (mods.shift ? 10 : 1)) };
    if (k === 'ArrowRight') return { type: 'seek', index: Math.min(rowCount - 1, idx + (mods.shift ? 10 : 1)) };
    if (k === '[') {
      // Previous event strictly below the current index.
      var prev = -1;
      for (var i = 0; i < events.length && events[i] < idx; i++) prev = events[i];
      return prev >= 0 ? { type: 'seek', index: prev } : null;
    }
    if (k === ']') {
      // Next event strictly above the current index.
      for (var j = 0; j < events.length; j++) {
        if (events[j] > idx) return { type: 'seek', index: events[j] };
      }
      return null;
    }
    if (k === 'Home') return { type: 'seek', index: 0 };
    if (k === 'End') return { type: 'seek', index: rowCount - 1 };
    return null;
  }

  /**
   * Focus guard for playback shortcuts: typing contexts (input, textarea,
   * select, contentEditable) keep every keystroke, and buttons keep Space so
   * the native button activation still fires.
   */
  function playbackKeyShouldIgnore(target, key) {
    if (!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (target.isContentEditable) return true;
    var k = (key === 'Spacebar') ? ' ' : key;
    if (k === ' ' && tag === 'button') return true;
    return false;
  }

  /**
   * Playback controller: time-based engine other views (strip charts, event
   * ticks, sparklines) can synchronize with. Owns the rAF loop and notifies
   * subscribers with the current row index on every painted frame.
   *
   *   var ctl = P66.createPlaybackController(parsedLog, mapResult);
   *   ctl.onFrame(function (idx, ctl) { ... });
   *   ctl.seek(120); ctl.play(); ctl.pause(); ctl.toggle();
   *   ctl.setSpeed(2); ctl.getIndex(); ctl.getState(); ctl.stop();
   *   ctl.valueAt(gaugeIdx, rowIdx); // display number or NaN
   *   ctl.table;                     // the columnar log table
   *
   * Returns null when there are no rows.
   */
  function createPlaybackController(parsedLog, mapResult) {
    var t = P66.asTable(parsedLog);
    if (!t || !t.rowCount) return null;
    var n = t.rowCount;

    var timeCol = P66.columnFor ? P66.columnFor(mapResult, 'TIME') : null;
    var tb = pbBuildTimes(t, timeCol);
    var times = tb.times;
    // Resolve each gauge to its column storage once — valueAt then indexes
    // the Float32Array (or string array) directly. NaN = missing cell.
    var colArrs = pbResolveColumns(mapResult).map(function (name) { return name ? t.col(name) : null; });
    var listeners = [];
    var state = {
      playing: false,
      speed: 1,
      cur: times[0],
      index: 0,
      raf: 0,
      lastWall: 0
    };
    var tMin = times[0], tMax = times[times.length - 1];

    function emit() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state.index, api); } catch (e) { /* keep loop alive */ }
      }
    }

    function setIndex(idx) {
      idx = Math.max(0, Math.min(n - 1, idx | 0));
      state.index = idx;
      state.cur = times[idx];
      emit();
    }

    function rafFn(fn) {
      if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(fn);
      return setTimeout(function () { fn(Date.now()); }, 50);
    }
    function cafFn(id) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(id);
      else clearTimeout(id);
    }

    function tick(wall) {
      if (!state.playing) return;
      var dt = (wall - state.lastWall) / 1000 * state.speed;
      state.lastWall = wall;
      state.cur += dt;
      if (state.cur >= tMax) {
        state.cur = tMax;
        state.index = n - 1;
        setPlaying(false);
        emit();
        return;
      }
      var idx = pbRowIndexAt(times, state.cur);
      if (idx !== state.index) {
        state.index = idx;
        emit();
      }
      if (state.playing) state.raf = rafFn(tick);
    }

    function setPlaying(on) {
      state.playing = on;
      if (on) {
        state.lastWall = (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
        state.raf = rafFn(tick);
      } else if (state.raf) {
        cafFn(state.raf);
        state.raf = 0;
      }
      emit();
    }

    var api = {
      table: t,
      times: times,
      indexed: tb.indexed,
      tMin: tMin,
      tMax: tMax,
      gauges: HUD_GAUGES,
      getIndex: function () { return state.index; },
      getState: function () { return { playing: state.playing, speed: state.speed, cur: state.cur }; },
      onFrame: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      seek: setIndex,
      play: function () {
        if (state.cur >= tMax) { state.index = 0; state.cur = tMin; }
        setPlaying(true);
      },
      pause: function () { setPlaying(false); },
      toggle: function () {
        if (state.playing) setPlaying(false);
        else {
          if (state.cur >= tMax) { state.index = 0; state.cur = tMin; }
          setPlaying(true);
        }
      },
      setSpeed: function (s) { state.speed = s; emit(); },
      valueAt: function (gi, idx) {
        var g = HUD_GAUGES[gi];
        var arr = colArrs[gi];
        if (!g || !arr || idx < 0 || idx >= n) return NaN;
        var raw = arr[idx];
        var num = (typeof raw === 'number') ? raw : parseFloat(raw);
        if (g.toAfr) num = pbToAfr(num);
        return num;
      },
      stop: function () { setPlaying(false); listeners.length = 0; }
    };
    return api;
  }

  /**
   * Render the playback HUD into container. Re-rendering stops any previous
   * playback loop attached to the same container. Returns the playback
   * controller so other views can synchronize with it.
   */
  function renderPlayback(container, parsedLog, mapResult) {
    if (typeof document === 'undefined') return null;
    if (container._pbStop) { container._pbStop(); container._pbStop = null; }
    container.innerHTML = '';

    var ctl = createPlaybackController(parsedLog, mapResult);
    if (!ctl) {
      container.innerHTML = '<p class="muted">Load a log to play it back.</p>';
      return null;
    }
    var n = ctl.table.rowCount;

    // ---- transport bar ----
    var bar = document.createElement('div');
    bar.className = 'pb-transport';
    bar.innerHTML =
      '<button type="button" class="pb-play" aria-label="Play or pause">▶</button>' +
      '<input type="range" class="pb-scrub" min="0" max="' + (n - 1) + '" value="0" step="1" aria-label="Scrub log" />' +
      '<span class="pb-time muted">0.0s</span>' +
      '<span class="pb-speed" role="group" aria-label="Playback speed"></span>';
    container.appendChild(bar);
    var playBtn = bar.querySelector('.pb-play');
    var scrub = bar.querySelector('.pb-scrub');
    var timeLabel = bar.querySelector('.pb-time');
    var speedBox = bar.querySelector('.pb-speed');

    // ---- gauge grid ----
    var grid = document.createElement('div');
    grid.className = 'pb-grid';
    var sparkEls = [];
    var valEls = ctl.gauges.map(function (g) {
      var tile = document.createElement('div');
      tile.className = 'pb-tile';
      tile.style.borderColor = g.border;
      var lab = document.createElement('div');
      lab.className = 'pb-label';
      lab.style.color = g.color;
      lab.textContent = g.label;
      var val = document.createElement('div');
      val.className = 'pb-value';
      val.style.color = g.color;
      val.textContent = '—';
      var spark = document.createElement('canvas');
      spark.className = 'pb-spark';
      spark.width = 160;
      spark.height = 30;
      spark.setAttribute('aria-hidden', 'true');
      var unit = document.createElement('div');
      unit.className = 'pb-unit';
      unit.textContent = g.unit;
      tile.appendChild(lab);
      tile.appendChild(val);
      tile.appendChild(spark);
      tile.appendChild(unit);
      grid.appendChild(tile);
      sparkEls.push(spark);
      return val;
    });
    container.appendChild(grid);

    // ---- playback wiring ----
    var speeds = [0.25, 0.5, 1, 2, 4];

    function paint(idx) {
      for (var gi = 0; gi < ctl.gauges.length; gi++) {
        var g = ctl.gauges[gi];
        var num = ctl.valueAt(gi, idx);
        valEls[gi].textContent = pbFmt(num, g.decimals);
        valEls[gi].style.color = pbValueColor(g, num);
        if (P66.drawSparkline && P66.sparklineWindow) {
          P66.drawSparkline(sparkEls[gi],
            P66.sparklineWindow(ctl, gi, 120), { color: g.border });
        }
      }
      scrub.value = String(idx);
      var st = ctl.getState();
      timeLabel.textContent = fmtClock(st.cur, ctl.indexed) + ' / ' + fmtClock(ctl.tMax, ctl.indexed);
    }

    ctl.onFrame(function (idx, c) {
      paint(idx);
      var playing = c.getState().playing;
      playBtn.textContent = playing ? '⏸' : '▶';
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });

    playBtn.addEventListener('click', function () { ctl.toggle(); });

    scrub.addEventListener('input', function () {
      ctl.seek(parseInt(scrub.value, 10) || 0);
    });

    speeds.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-speed-btn' + (s === 1 ? ' active' : '');
      b.textContent = (s < 1 ? s : s + 'x');
      if (s === 1) b.textContent = '1x';
      b.addEventListener('click', function () {
        ctl.setSpeed(s);
        var btns = speedBox.querySelectorAll('.pb-speed-btn');
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
        b.classList.add('active');
      });
      speedBox.appendChild(b);
    });

    paint(ctl.getIndex());

    // ---- keyboard shortcuts ----
    // Event indices come from the events module — the same source the tick
    // strip renders from, so [ / ] hop between the visible ticks.
    var evIdx = [];
    if (typeof P66.computePlaybackEvents === 'function') {
      try {
        evIdx = P66.computePlaybackEvents(parsedLog, mapResult)
          .map(function (ev) { return ev.index; })
          .sort(function (a, b) { return a - b; });
      } catch (e) { evIdx = []; }
    }

    var hint = document.createElement('div');
    hint.className = 'pb-keys-hint muted';
    hint.textContent = 'Space play/pause · ←/→ scrub (⇧ = 10) · [ ] jump events · Home/End';
    bar.appendChild(hint);

    // ---- engine sound (item 21): synthesized V6 note tracking RPM ----
    // Honest label: "(synth)" — this is synthesized, not his exhaust.
    var sndWrap = document.createElement('div');
    sndWrap.className = 'pb-sound muted';
    sndWrap.innerHTML =
      '<label><input type="checkbox" class="pb-snd-toggle"> Engine sound (synth)</label> ' +
      '<input type="range" class="pb-snd-vol" min="0" max="100" value="70" ' +
      'aria-label="Engine sound volume" style="width:90px;vertical-align:middle">';
    bar.appendChild(sndWrap);
    var sndToggle = sndWrap.querySelector('.pb-snd-toggle');
    var sndVol = sndWrap.querySelector('.pb-snd-vol');
    var engineSnd = null;
    var sndUnsub = null;
    function gaugeIdx(sig) {
      var gs = P66.HUD_GAUGES || [];
      for (var gi = 0; gi < gs.length; gi++) if (gs[gi].signal === sig) return gi;
      return -1;
    }
    var GI_RPM = gaugeIdx('RPM'), GI_MAP = gaugeIdx('MAP'), GI_TPS = gaugeIdx('TPS');
    sndToggle.addEventListener('change', function () {
      // User gesture: the module creates/resumes the AudioContext here
      // (autoplay policy).
      if (sndToggle.checked) {
        if (typeof P66.createEngineSound !== 'function') { sndToggle.checked = false; sndToggle.disabled = true; return; }
        if (!engineSnd) engineSnd = P66.createEngineSound();
        if (!engineSnd.setEnabled(true)) { sndToggle.checked = false; sndToggle.disabled = true; return; }
        engineSnd.setVolume(sndVol.value / 100);
      } else if (engineSnd) {
        engineSnd.setEnabled(false);
      }
    });
    sndVol.addEventListener('input', function () {
      if (engineSnd) engineSnd.setVolume(sndVol.value / 100);
    });
    if (typeof P66.createEngineSound === 'function') {
      // Feed current RPM/MAP/TPS on every emitted frame; the module's
      // watchdog auto-mutes when frames stall (pause/scrub-end), so a drone
      // can never be left running.
      sndUnsub = ctl.onFrame(function (idx) {
        if (!engineSnd || !engineSnd.isEnabled()) return;
        try {
          engineSnd.update(ctl.valueAt(GI_RPM, idx), ctl.valueAt(GI_MAP, idx), ctl.valueAt(GI_TPS, idx));
        } catch (e) { /* never break playback for audio */ }
      });
    }

    function pbUiVisible() {
      if (!container || typeof container.getBoundingClientRect !== 'function') return true;
      var r = container.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    }

    function onPbKey(e) {
      if (P66.playbackKeyShouldIgnore(e.target, e.key)) return;
      if (container.isConnected === false || !pbUiVisible()) return;
      var action = P66.playbackKeyAction(e.key,
        { shift: !!e.shiftKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey, alt: !!e.altKey },
        { index: ctl.getIndex(), rowCount: n, eventIndices: evIdx });
      if (!action) return;
      e.preventDefault();
      if (action.type === 'toggle') ctl.toggle();
      else if (action.type === 'seek') ctl.seek(action.index);
    }
    document.addEventListener('keydown', onPbKey);

    container._pbStop = function () {
      ctl.stop();
      document.removeEventListener('keydown', onPbKey);
      if (sndUnsub) { try { sndUnsub(); } catch (e) {} sndUnsub = null; }
      if (engineSnd) { try { engineSnd.destroy(); } catch (e) {} engineSnd = null; }
    };
    return ctl;
  }

  P66.HUD_GAUGES = HUD_GAUGES;
  P66.pbFmt = pbFmt;
  P66.pbToAfr = pbToAfr;
  P66.pbBuildTimes = pbBuildTimes;
  P66.pbRowIndexAt = pbRowIndexAt;
  P66.pbValueColor = pbValueColor;
  P66.pbResolveColumns = pbResolveColumns;
  P66.playbackKeyAction = playbackKeyAction;
  P66.playbackKeyShouldIgnore = playbackKeyShouldIgnore;
  P66.createPlaybackController = createPlaybackController;
  P66.renderPlayback = renderPlayback;
})(typeof window !== 'undefined' ? window : global);
