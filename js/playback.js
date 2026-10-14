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
   * Build the per-row timestamp array. Falls back to row-index timing when
   * the TIME channel is missing or non-numeric.
   * Returns { times: number[], indexed: boolean }.
   */
  function pbBuildTimes(rows, timeCol) {
    var times = new Array(rows.length);
    var ok = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = timeCol ? parseFloat(rows[i][timeCol]) : NaN;
      if (isFinite(t)) { times[i] = t; ok++; } else { times[i] = NaN; }
    }
    if (ok < rows.length * 0.9) {
      // Not enough usable timestamps — scrub by row index instead.
      for (var j = 0; j < rows.length; j++) times[j] = j;
      return { times: times, indexed: true };
    }
    // Fill rare gaps by interpolation so the search never sees NaN.
    var last = times[0];
    for (var k = 0; k < times.length; k++) {
      if (isFinite(times[k])) { last = times[k]; } else { times[k] = last; }
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
   * Render the playback HUD into container. Re-rendering stops any previous
   * playback loop attached to the same container.
   */
  function renderPlayback(container, parsedLog, mapResult) {
    if (typeof document === 'undefined') return;
    if (container._pbStop) { container._pbStop(); container._pbStop = null; }
    container.innerHTML = '';

    var rows = (parsedLog && parsedLog.rows) || [];
    if (!rows.length) {
      container.innerHTML = '<p class="muted">Load a log to play it back.</p>';
      return;
    }

    var timeCol = P66.columnFor ? P66.columnFor(mapResult, 'TIME') : null;
    var tb = pbBuildTimes(rows, timeCol);
    var times = tb.times;
    var cols = pbResolveColumns(mapResult);

    // ---- transport bar ----
    var bar = document.createElement('div');
    bar.className = 'pb-transport';
    bar.innerHTML =
      '<button type="button" class="pb-play" aria-label="Play or pause">▶</button>' +
      '<input type="range" class="pb-scrub" min="0" max="' + (rows.length - 1) + '" value="0" step="1" aria-label="Scrub log" />' +
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
    var valEls = HUD_GAUGES.map(function (g, gi) {
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
      var unit = document.createElement('div');
      unit.className = 'pb-unit';
      unit.textContent = g.unit;
      tile.appendChild(lab);
      tile.appendChild(val);
      tile.appendChild(unit);
      grid.appendChild(tile);
      return val;
    });
    container.appendChild(grid);

    // ---- state ----
    var speeds = [0.25, 0.5, 1, 2, 4];
    var state = {
      playing: false,
      speed: 1,
      cur: times[0],
      raf: 0,
      lastWall: 0
    };
    var tMin = times[0], tMax = times[times.length - 1];

    function paint(idx) {
      var row = rows[idx];
      for (var gi = 0; gi < HUD_GAUGES.length; gi++) {
        var g = HUD_GAUGES[gi];
        var col = cols[gi];
        var v = col ? row[col] : null;
        if (g.toAfr) v = pbToAfr(v);
        valEls[gi].textContent = pbFmt(v, g.decimals);
      }
      scrub.value = String(idx);
      timeLabel.textContent = fmtClock(state.cur, tb.indexed) + ' / ' + fmtClock(tMax, tb.indexed);
    }

    function tick(wall) {
      if (!state.playing) return;
      var dt = (wall - state.lastWall) / 1000 * state.speed;
      state.lastWall = wall;
      state.cur += dt;
      if (state.cur >= tMax) {
        state.cur = tMax;
        setPlaying(false);
      }
      paint(pbRowIndexAt(times, state.cur));
      if (state.playing) state.raf = requestAnimationFrame(tick);
    }

    function setPlaying(on) {
      state.playing = on;
      playBtn.textContent = on ? '⏸' : '▶';
      playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
      if (on) {
        state.lastWall = performance.now();
        state.raf = requestAnimationFrame(tick);
      } else if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
    }

    playBtn.addEventListener('click', function () {
      if (!state.playing && state.cur >= tMax) state.cur = tMin; // replay from start
      setPlaying(!state.playing);
    });

    scrub.addEventListener('input', function () {
      var idx = Math.max(0, Math.min(rows.length - 1, parseInt(scrub.value, 10) || 0));
      state.cur = times[idx];
      paint(idx);
    });

    speeds.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-speed-btn' + (s === 1 ? ' active' : '');
      b.textContent = (s < 1 ? s : s + 'x');
      if (s === 1) b.textContent = '1x';
      b.addEventListener('click', function () {
        state.speed = s;
        var btns = speedBox.querySelectorAll('.pb-speed-btn');
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
        b.classList.add('active');
      });
      speedBox.appendChild(b);
    });

    paint(0);

    container._pbStop = function () {
      setPlaying(false);
    };
  }

  P66.HUD_GAUGES = HUD_GAUGES;
  P66.pbFmt = pbFmt;
  P66.pbToAfr = pbToAfr;
  P66.pbBuildTimes = pbBuildTimes;
  P66.pbRowIndexAt = pbRowIndexAt;
  P66.pbResolveColumns = pbResolveColumns;
  P66.renderPlayback = renderPlayback;
})(typeof window !== 'undefined' ? window : global);
