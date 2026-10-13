/* P66-Tuner UI wiring
 * Connects file inputs to the P66 engine (parser -> mapper -> analyzer -> tuner).
 */
(function () {
  'use strict';

  var fileInputs = {
    xdf: document.getElementById('xdf-input'),
    ads: document.getElementById('ads-input'),
    bin: document.getElementById('bin-input'),
    log: document.getElementById('log-input'),
  };

  var fileSummary = document.getElementById('file-summary');
  var consoleOutput = document.getElementById('console');
  var mappingTable = document.getElementById('mapping-table');
  var analysisResults = document.getElementById('analysis-results');
  var tuneResults = document.getElementById('tune-results');
  var modeSelect = document.getElementById('mode');
  var altitudeInput = document.getElementById('altitude-ft');

  // Altitude (feet) for the baro plausibility check. Persisted per browser;
  // defaults to 2840 ft. Read fresh at analysis time so the input always wins.
  function currentAltitudeFt() {
    if (typeof P66.createAltitudeStore === 'function') {
      var store = P66.createAltitudeStore();
      if (altitudeInput && altitudeInput.value.trim() !== '') {
        var v = parseFloat(altitudeInput.value);
        if (isFinite(v)) store.set(v);
      }
      return store.get();
    }
    return 2840;
  }
  if (altitudeInput && typeof P66.createAltitudeStore === 'function') {
    try { altitudeInput.value = P66.createAltitudeStore().get(); } catch (e) { /* ignore */ }
    altitudeInput.addEventListener('change', function () {
      var v = parseFloat(altitudeInput.value);
      if (isFinite(v) && P66.createAltitudeStore().set(v)) {
        writeConsole('Altitude set to ' + Math.round(v) + ' ft — baro check will use it on the next analysis.');
      } else {
        writeConsole('Altitude not saved: enter a number between -1000 and 15000 ft.');
      }
    });
  }
  var dashParts = {
    heatmap: document.getElementById('heatmap'),
    coverage: document.getElementById('coverage'),
    journal: document.getElementById('journal'),
    regions: document.getElementById('region-chart'),
    knock: document.getElementById('knock-chart'),
    lambda: document.getElementById('lambda-chart'),
    comparison: document.getElementById('comparison')
  };

  // Seamless background loop: two stacked videos crossfade over the last
  // 1.4s of each loop so the restart never visibly cuts.
  (function smoothBgLoop() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var videos = Array.prototype.slice.call(document.querySelectorAll('.bg-video'));
    if (videos.length < 2) return;
    var PLAYBACK_RATE = 1.0;   // the file itself is a 20s slow-motion render;
                             // keep playback at 1x so frames stay buttery
    var WALL_FADE = 1.4;       // crossfade length in wall-clock seconds
    var FADE = WALL_FADE * PLAYBACK_RATE; // ...in video seconds
    var active = 0, fading = false;
    videos.forEach(function (v) {
      try { v.playbackRate = PLAYBACK_RATE; } catch (e) {}
      v.addEventListener('timeupdate', function () {
        if (v !== videos[active] || fading || !v.duration || v.duration === Infinity) return;
        if (v.duration - v.currentTime <= FADE) {
          fading = true;
          var next = videos[active === 0 ? 1 : 0];
          active = active === 0 ? 1 : 0;
          try { next.currentTime = 0; } catch (e) {}
          var p = next.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
          next.classList.add('is-active');
          v.classList.remove('is-active');
          setTimeout(function () {
            try { v.pause(); v.currentTime = 0; } catch (e) {}
            fading = false;
          }, WALL_FADE * 1000 + 250);
        }
      });
    });
  })();

  // Rain on the windshield: droplets bead up on the glass, then trail
  // down with a wobble, absorbing smaller drops as they go. Full-viewport
  // canvas above the UI; pointer-events:none so clicks pass through.
  (function rainOnGlass() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'rain-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0;
    var PIVOT = { x: 0, y: 0 }, BLADE_LEN = 0, SWATH = 34;

    // Offscreen trail layer (half res): wet trails persist and fade slowly.
    var SCALE = 0.5;
    var trailC = document.createElement('canvas');
    var tg = trailC.getContext('2d');

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      trailC.width = Math.max(2, Math.round(W * SCALE));
      trailC.height = Math.max(2, Math.round(H * SCALE));
      PIVOT.x = W / 2; PIVOT.y = H + 60;
      BLADE_LEN = Math.hypot(W / 2, H) + 80;
    }
    resize();
    window.addEventListener('resize', resize);

    // Wetness grid: coarse physics map so water follows water.
    var GW = 64, GH = 36;
    var wet = new Float32Array(GW * GH);
    function addWet(x, y, r, amt) {
      var gx = Math.floor(x / W * GW), gy = Math.floor(y / H * GH);
      var gr = Math.max(1, Math.ceil(r / W * GW * 2));
      for (var oy = -gr; oy <= gr; oy++) {
        for (var ox = -gr; ox <= gr; ox++) {
          var ix = gx + ox, iy = gy + oy;
          if (ix < 0 || iy < 0 || ix >= GW || iy >= GH) continue;
          if (ox * ox + oy * oy > gr * gr) continue;
          var k = iy * GW + ix;
          wet[k] = Math.max(0, Math.min(1, wet[k] + amt));
        }
      }
    }
    function wetAt(x, y) {
      var gx = Math.floor(x / W * GW), gy = Math.floor(y / H * GH);
      if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return 0;
      return wet[gy * GW + gx];
    }
    function pickWetSpot() {
      for (var t = 0; t < 24; t++) {
        var gx = (Math.random() * GW) | 0, gy = (Math.random() * GH) | 0;
        var w = wet[gy * GW + gx];
        if (w > 0.25 && Math.random() < w) {
          return { x: (gx + 0.5) / GW * W, y: (gy + 0.5) / GH * H };
        }
      }
      return null;
    }

    // Lens-like drop sprite: contact shadow, bright rim, refracted dim
    // center, inverted glint, specular highlight.
    function makeDropSprite(r) {
      var pad = Math.ceil(r * 0.9);
      var s = Math.ceil(r * 2 + pad * 2);
      var c = document.createElement('canvas');
      c.width = c.height = s;
      var g = c.getContext('2d');
      var cx = s / 2, cy = s / 2;
      var sh = g.createRadialGradient(cx + r * 0.18, cy + r * 0.3, r * 0.2,
                                      cx + r * 0.18, cy + r * 0.3, r * 1.15);
      sh.addColorStop(0, 'rgba(5,8,14,0.30)');
      sh.addColorStop(1, 'rgba(5,8,14,0)');
      g.fillStyle = sh;
      g.beginPath(); g.arc(cx + r * 0.18, cy + r * 0.3, r * 1.15, 0, 6.3); g.fill();
      var body = g.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
      body.addColorStop(0, 'rgba(150,175,205,0.16)');
      body.addColorStop(0.62, 'rgba(170,195,225,0.10)');
      body.addColorStop(0.86, 'rgba(215,232,250,0.42)');
      body.addColorStop(1, 'rgba(215,232,250,0)');
      g.fillStyle = body;
      g.beginPath(); g.arc(cx, cy, r, 0, 6.3); g.fill();
      var glint = g.createRadialGradient(cx, cy + r * 0.42, 0, cx, cy + r * 0.42, r * 0.5);
      glint.addColorStop(0, 'rgba(235,244,255,0.5)');
      glint.addColorStop(1, 'rgba(235,244,255,0)');
      g.fillStyle = glint;
      g.beginPath(); g.arc(cx, cy + r * 0.42, r * 0.5, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.arc(cx - r * 0.34, cy - r * 0.36, Math.max(0.6, r * 0.2), 0, 6.3); g.fill();
      return { c: c, half: s / 2 };
    }
    var SPRITES = [1.1, 2.2, 3.6, 6].map(makeDropSprite);

    function makeTrailSprite() {
      var r = 3, s = r * 2 + 4;
      var c = document.createElement('canvas');
      c.width = c.height = s;
      var g = c.getContext('2d');
      var cx = s / 2, cy = s / 2;
      var b = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      b.addColorStop(0, 'rgba(8,12,20,0.20)');
      b.addColorStop(0.7, 'rgba(8,12,20,0.12)');
      b.addColorStop(1, 'rgba(8,12,20,0)');
      g.fillStyle = b;
      g.beginPath(); g.arc(cx, cy, r, 0, 6.3); g.fill();
      return { c: c, half: s / 2 };
    }
    var TRAIL_SPRITE = makeTrailSprite();

    function rand(a, b) { return a + Math.random() * (b - a); }

    var statics = [], mists = [], runners = [], ripples = [];
    var MAX_STATIC = 60, MAX_MIST = 130, MAX_RUNNERS = 7;

    function spawnStatic(instant) {
      var d = { x: rand(0, W), y: rand(0, H), r: rand(1.4, 3.2),
        a: 0, targetA: rand(0.4, 0.85), tw: rand(0, 6.28) };
      if (instant) d.a = d.targetA;
      else ripples.push({ x: d.x, y: d.y, r: d.r, age: 0 });
      statics.push(d);
    }
    function spawnMist(instant) {
      var d = { x: rand(0, W), y: rand(0, H), r: rand(0.6, 1.3),
        a: 0, targetA: rand(0.15, 0.4), tw: rand(0, 6.28) };
      if (instant) d.a = d.targetA;
      mists.push(d);
    }
    function spawnRunner() {
      var spot = Math.random() < 0.55 ? pickWetSpot() : null;
      runners.push({
        x: spot ? spot.x + rand(-8, 8) : rand(0, W),
        y: spot ? spot.y : rand(-30, H * 0.2),
        r: rand(3.2, 5.5),
        vy: rand(25, 60), vx: 0,
        wob: rand(0, 6.28), wobF: rand(1.2, 3),
        trail: []
      });
    }

    // ---- windshield wiper ----
    // A blade pivots from below the viewport and sweeps an arc, squeegeeing
    // a swath clear: droplets in the band vanish, the wetness grid is
    // zeroed, and the persistent trail layer is erased along the blade.
    var wiper = null, wipeDir = 1, lastWipeAt = -10000;

    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now) ?
        performance.now() : Date.now();
    }
    function startWipe() {
      lastWipeAt = nowMs();
      var from = wipeDir > 0 ? -1.15 : 1.15; // alternate sweep direction
      wipeDir *= -1;
      wiper = { t: 0, dur: 1.15, from: from, to: -from };
    }
    function maybeWipe() {
      if (wiper) return;
      if (nowMs() - lastWipeAt < 1200) return;
      startWipe();
    }
    // Is point (x,y) inside the blade's cleared band at angle ang?
    // ang measured from vertical, like the blade.
    function inSwath(x, y, ang) {
      var dx = x - PIVOT.x, dy = y - PIVOT.y;
      var r = Math.sqrt(dx * dx + dy * dy);
      if (r > BLADE_LEN || r < 2) return false;
      var a = Math.atan2(dx, -dy);
      return Math.abs(a - ang) < (SWATH / 2) / r;
    }
    function clearSwath(ang) {
      var i, d;
      for (i = statics.length - 1; i >= 0; i--) {
        if (inSwath(statics[i].x, statics[i].y, ang)) statics.splice(i, 1);
      }
      for (i = mists.length - 1; i >= 0; i--) {
        if (inSwath(mists[i].x, mists[i].y, ang)) mists.splice(i, 1);
      }
      for (i = ripples.length - 1; i >= 0; i--) {
        d = ripples[i];
        if (inSwath(d.x, d.y, ang)) ripples.splice(i, 1);
      }
      for (i = runners.length - 1; i >= 0; i--) {
        d = runners[i];
        if (inSwath(d.x, d.y, ang)) { runners.splice(i, 1); spawnRunner(); }
      }
      // zero the wetness grid along the blade
      var steps = 24, sN, rr, bx, by;
      for (sN = 0; sN <= steps; sN++) {
        rr = (sN / steps) * BLADE_LEN;
        bx = PIVOT.x + Math.sin(ang) * rr;
        by = PIVOT.y - Math.cos(ang) * rr;
        addWet(bx, by, SWATH * 0.75, -1);
      }
      // erase the persistent trail layer along the blade
      tg.save();
      tg.globalCompositeOperation = 'destination-out';
      tg.strokeStyle = 'rgba(0,0,0,0.95)';
      tg.lineWidth = SWATH * SCALE;
      tg.lineCap = 'round';
      tg.beginPath();
      tg.moveTo(PIVOT.x * SCALE, PIVOT.y * SCALE);
      tg.lineTo((PIVOT.x + Math.sin(ang) * BLADE_LEN) * SCALE,
                (PIVOT.y - Math.cos(ang) * BLADE_LEN) * SCALE);
      tg.stroke();
      tg.restore();
    }

    function absorb(rx, ry, r) {
      var rr = r.r + 5, rr2 = rr * rr, i, d, dx, dy;
      for (i = statics.length - 1; i >= 0; i--) {
        d = statics[i]; dx = d.x - rx; dy = d.y - ry;
        if (dx * dx + dy * dy < rr2) { statics.splice(i, 1); r.r = Math.min(r.r + 0.1, 7.5); }
      }
      for (i = mists.length - 1; i >= 0; i--) {
        d = mists[i]; dx = d.x - rx; dy = d.y - ry;
        if (dx * dx + dy * dy < rr2) mists.splice(i, 1);
      }
    }

    function drawDots(list, t) {
      for (var i = list.length - 1; i >= 0; i--) {
        var d = list[i];
        if (d.a < d.targetA) d.a = Math.min(d.targetA, d.a + 0.03);
        var shimmer = 0.85 + 0.15 * Math.sin(t / 900 + d.tw);
        var spr = SPRITES[d.r < 1.6 ? 0 : (d.r < 2.7 ? 1 : 2)];
        ctx.globalAlpha = d.a * shimmer;
        ctx.drawImage(spr.c, d.x - spr.half, d.y - spr.half);
      }
      ctx.globalAlpha = 1;
    }

    var i;
    for (i = 0; i < MAX_STATIC; i++) spawnStatic(true);
    for (i = 0; i < MAX_MIST; i++) spawnMist(true);
    for (i = 0; i < MAX_RUNNERS; i++) spawnRunner();

    var last = 0;
    function frame(t) {
      requestAnimationFrame(frame);
      if (!last) last = t;
      var dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      ctx.clearRect(0, 0, W, H);

      // wet trails linger: slow-fade the trail layer (~15s half-life feel)
      tg.globalCompositeOperation = 'destination-out';
      tg.fillStyle = 'rgba(0,0,0,' + (dt * 0.05).toFixed(4) + ')';
      tg.fillRect(0, 0, trailC.width, trailC.height);
      tg.globalCompositeOperation = 'source-over';

      var decay = Math.pow(0.955, dt), wi;
      for (wi = 0; wi < wet.length; wi++) wet[wi] *= decay;

      if (statics.length < MAX_STATIC && Math.random() < 0.3) spawnStatic(false);
      if (mists.length < MAX_MIST && Math.random() < 0.4) spawnMist(false);

      // persistent wet trails under everything
      ctx.drawImage(trailC, 0, 0, W, H);

      // impact ripples where drops landed
      for (var ri = ripples.length - 1; ri >= 0; ri--) {
        var rp = ripples[ri];
        rp.age += dt;
        var rl = rp.age / 0.45;
        if (rl >= 1) { ripples.splice(ri, 1); continue; }
        ctx.globalAlpha = 0.22 * (1 - rl);
        ctx.strokeStyle = 'rgba(220,235,250,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, rp.r + rl * 9, 0, 6.3);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      drawDots(mists, t);
      drawDots(statics, t);

      for (i = runners.length - 1; i >= 0; i--) {
        var r = runners[i];
        // steer toward wetness ahead: water follows water
        var aheadY = r.y + 26;
        var wl = wetAt(r.x - 18, aheadY), wr = wetAt(r.x + 18, aheadY);
        r.vx += ((wr - wl) * 90 - r.vx * 3) * dt;
        r.vy = Math.min(r.vy + dt * 30, 175);
        r.x += r.vx * dt;
        r.y += r.vy * dt;
        r.wob += dt * r.wobF;
        var rx = r.x + Math.sin(r.wob) * 8;
        r.trail.push({ x: rx, y: r.y });
        if (r.trail.length > 10) r.trail.shift();
        // stamp the persistent trail + wetness grid
        tg.globalAlpha = 0.5;
        tg.drawImage(TRAIL_SPRITE.c, rx * SCALE - TRAIL_SPRITE.half, r.y * SCALE - TRAIL_SPRITE.half);
        tg.globalAlpha = 1;
        addWet(rx, r.y, r.r * 2.2, 0.5);
        absorb(rx, r.y, r);
        // fresh glints along the new trail
        for (var m = 0; m < r.trail.length; m++) {
          var p = r.trail[m];
          ctx.globalAlpha = 0.30 * (m / r.trail.length);
          var tsp = SPRITES[0];
          ctx.drawImage(tsp.c, p.x - tsp.half, p.y - tsp.half);
        }
        // head stretches with speed
        var stretch = 1 + Math.min(r.vy / 160, 0.8) * 0.55;
        var hspr = SPRITES[r.r < 4.6 ? 2 : 3];
        ctx.globalAlpha = 0.95;
        ctx.drawImage(hspr.c, rx - hspr.half, r.y - hspr.half * stretch,
                      hspr.c.width, hspr.c.height * stretch);
        ctx.globalAlpha = 1;
        if (r.y > H + 30 || r.x < -40 || r.x > W + 40) { runners.splice(i, 1); spawnRunner(); }
      }

      // windshield wiper: sweep the blade, squeegee the swath clear
      if (wiper) {
        wiper.t += dt;
        var wk = Math.min(wiper.t / wiper.dur, 1);
        var e = wk < 0.5 ? 4 * wk * wk * wk : 1 - Math.pow(-2 * wk + 2, 3) / 2;
        var ang = wiper.from + (wiper.to - wiper.from) * e;
        clearSwath(ang);
        var fadeA = Math.min(wk / 0.12, (1 - wk) / 0.12, 1);
        var tipX = PIVOT.x + Math.sin(ang) * BLADE_LEN;
        var tipY = PIVOT.y - Math.cos(ang) * BLADE_LEN;
        ctx.globalAlpha = 0.95 * Math.max(0, fadeA);
        ctx.strokeStyle = '#14181f';
        ctx.lineWidth = 11;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(PIVOT.x, PIVOT.y); ctx.lineTo(tipX, tipY); ctx.stroke();
        ctx.strokeStyle = 'rgba(150,165,185,0.85)';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(PIVOT.x, PIVOT.y);
        ctx.lineTo(PIVOT.x + Math.sin(ang) * BLADE_LEN * 0.55,
                   PIVOT.y - Math.cos(ang) * BLADE_LEN * 0.55);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (wk >= 1) wiper = null;
      }
    }
    requestAnimationFrame(frame);

    // A scroll wipes the windshield (throttled); plus one demo wipe after
    // load so the effect is discoverable.
    window.addEventListener('scroll', maybeWipe, { capture: true, passive: true });
    setTimeout(function () { if (!wiper) startWipe(); }, 1400);
  })();

  // Background video: if the asset file is missing (e.g. a clone without
  // the binary), hide the wrapper so the page falls back to the dark theme.
  (function bgVideoFallback() {
    var v = document.querySelector('.bg-video');
    if (!v) return;
    v.addEventListener('error', function () {
      var w = v.closest('.bg-video-wrap');
      if (w) w.style.display = 'none';
    }, true);
    var src = v.querySelector('source');
    if (src) src.addEventListener('error', function () {
      var w = v.closest('.bg-video-wrap');
      if (w) w.style.display = 'none';
    });
  })();

  // Dashboard category tabs: one visible panel at a time.
  (function wireDashTabs() {
    var tabBtns = document.querySelectorAll('.tabs[role="tablist"] button');
    if (!tabBtns.length) return;
    Array.prototype.forEach.call(tabBtns, function (btn) {
      btn.addEventListener('click', function () {
        var tablist = btn.closest('.tabs');
        Array.prototype.forEach.call(tablist.querySelectorAll('button'), function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        var card = tablist.closest('.card');
        Array.prototype.forEach.call(card.querySelectorAll('.tab-panel'), function (p) {
          p.classList.toggle('active', p.getAttribute('data-panel') === btn.getAttribute('data-tab'));
        });
      });
    });
  })();

  var CANONICAL_LABELS = {
    RPM: 'RPM', MAP: 'MAP', MAF: 'MAF', TPS: 'TPS',
    STFT: 'STFT', STFT_B1: 'STFT Bank 1', STFT_B2: 'STFT Bank 2',
    LTFT: 'LTFT', LTFT_B1: 'LTFT Bank 1', LTFT_B2: 'LTFT Bank 2',
    KR: 'Knock Retard', IAT: 'IAT', ECT: 'ECT',
    CMD_LAMBDA: 'Commanded AFR/Lambda', WB_LAMBDA: 'Wideband AFR/Lambda',
    O2_B1: 'O2 Bank 1 (narrowband)', O2_B2: 'O2 Bank 2 (narrowband)', O2: 'O2 (narrowband)',
    SPARK_ADV: 'Spark Advance', INJ_PW: 'Injector PW',
    VSS: 'Vehicle Speed', BARO: 'Baro', TIME: 'Time'
  };

  // Session state
  var files = { xdf: null, ads: null, bin: null, log: null };
  var parsedLog = null;
  var mapResult = null;
  var sessionReport = null;
  var sessionHistory = []; // past reports for before/after comparison
  var xdfCatalog = null;
  var binBytes = null;
  var lastPatches = null;

  function resetDashboardPlaceholders() {
    var msgs = {
      heatmap: 'Run analysis to render the heatmap.',
      coverage: 'Run analysis to score log coverage.',
      journal: 'Run analysis to open the journal.',
      regions: 'Run analysis to render region breakdown.',
      knock: 'Run analysis to render knock events.',
      lambda: 'Run analysis to render the lambda trace.',
      comparison: 'Run analysis on two sessions to compare before/after.'
    };
    Object.keys(dashParts).forEach(function (k) {
      if (dashParts[k]) dashParts[k].innerHTML = '<p class="muted">' + msgs[k] + '</p>';
    });
  }

  function writeConsole(message) {
    var ts = new Date().toLocaleTimeString();
    consoleOutput.textContent = '[' + ts + '] ' + message + '\n' + consoleOutput.textContent;
  }

  function fileLabel(file) {
    if (!file) return 'not loaded';
    return file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
  }

  function refreshSummary() {
    fileSummary.innerHTML =
      '<ul>' +
      '<li><strong>XDF:</strong> ' + fileLabel(files.xdf) +
      (xdfCatalog ? ' — ' + xdfCatalog.tables.length + ' tables parsed' : '') + '</li>' +
      '<li><strong>ADS:</strong> ' + fileLabel(files.ads) + '</li>' +
      '<li><strong>BIN:</strong> ' + fileLabel(files.bin) +
      (binBytes ? ' — ' + binBytes.length + ' bytes' : '') + '</li>' +
      '<li><strong>LOG:</strong> ' + fileLabel(files.log) +
      (parsedLog ? ' — ' + parsedLog.rowCount + ' rows parsed' : '') + '</li>' +
      '</ul>';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMappingPreview() {
    if (!mapResult) {
      // Fallback: show canonical list awaiting a log.
      mappingTable.innerHTML = Object.keys(CANONICAL_LABELS).map(function (sig) {
        return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
          '<td class="muted">load a log to map</td>' +
          '<td class="status-warn">Pending</td></tr>';
      }).join('');
      return;
    }
    mappingTable.innerHTML = Object.keys(CANONICAL_LABELS).map(function (sig) {
      var m = mapResult.mapping[sig];
      if (m) {
        var cls = m.confidence === 'high' ? 'status-ok' : 'status-warn';
        var label = m.confidence === 'high' ? 'High' : 'Medium';
        return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
          '<td>' + esc(m.column) + '</td>' +
          '<td class="' + cls + '">' + label + '</td></tr>';
      }
      return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
        '<td class="muted">—</td><td class="status-bad">Missing</td></tr>';
    }).join('');
  }

  function readLogFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  function readBinaryFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(file);
    });
  }

  Object.entries(fileInputs).forEach(function (entry) {
    var key = entry[0], input = entry[1];
    input.addEventListener('change', function () {
      files[key] = input.files[0] || null;
      if (key === 'log' && files.log) {
        readLogFile(files.log).then(function (text) {
          parsedLog = P66.parseLogText(text);
          mapResult = P66.mapChannels(parsedLog.headers);
          sessionReport = null; // invalidate previous analysis
          analysisResults.innerHTML = '<p class="muted">Log reloaded — run analysis again.</p>';
          tuneResults.innerHTML = '<p class="muted">Generate tune suggestions after analysis.</p>';
          resetDashboardPlaceholders();
          refreshSummary();
          renderMappingPreview();
          writeConsole('LOG parsed: ' + parsedLog.rowCount + ' rows, ' +
            parsedLog.columnCount + ' columns (delimiter: ' +
            (parsedLog.delimiter === '\t' ? 'TAB' : parsedLog.delimiter) + ').');
          parsedLog.warnings.forEach(writeConsole);
          var mapped = Object.keys(mapResult.mapping).length;
          writeConsole('Channel mapping: ' + mapped + ' signals mapped, ' +
            mapResult.unmapped.length + ' columns unmapped.');
        }).catch(function (err) {
          writeConsole('Failed to read log file: ' + err);
        });
      } else if (key === 'xdf' && files.xdf) {
        readLogFile(files.xdf).then(function (text) {
          try {
            xdfCatalog = P66.parseXdfXml(text);
            writeConsole('XDF parsed: ' + xdfCatalog.deftitle + ' — ' +
              xdfCatalog.tables.length + ' tables, ' + xdfCatalog.constants.length + ' constants.');
          } catch (err) {
            xdfCatalog = null;
            writeConsole('XDF parse failed: ' + (err && err.message ? err.message : err));
          }
          refreshSummary();
        }).catch(function (err) {
          writeConsole('Failed to read XDF file: ' + err);
        });
      } else if (key === 'bin' && files.bin) {
        readBinaryFile(files.bin).then(function (bytes) {
          binBytes = bytes;
          lastPatches = null;
          refreshSummary();
          writeConsole('BIN loaded: ' + bytes.length + ' bytes.');
        }).catch(function (err) {
          writeConsole('Failed to read BIN file: ' + err);
        });
      } else {
        if (key === 'log') { parsedLog = null; mapResult = null; sessionReport = null; }
        if (key === 'xdf') { xdfCatalog = null; }
        if (key === 'bin') { binBytes = null; lastPatches = null; }
        refreshSummary();
        renderMappingPreview();
      }
      if (files[key]) writeConsole(key.toUpperCase() + ' file loaded: ' + files[key].name);
    });
  });

  document.getElementById('validate-btn').addEventListener('click', function () {
    var missing = ['xdf', 'ads'].filter(function (k) { return !files[k]; });
    if (missing.length) {
      writeConsole('Validation warning: missing ' + missing.join(', ').toUpperCase() + ' file(s). Log-only analysis still available.');
    } else {
      writeConsole('Validation passed: XDF and ADS loaded.');
    }
    if (!parsedLog) {
      writeConsole('No log parsed yet — load a CSV/TSV log to enable analysis.');
      return;
    }
    var required = ['RPM', 'MAP'];
    var absent = required.filter(function (s) { return !mapResult.mapping[s]; });
    if (absent.length) {
      writeConsole('Validation warning: log is missing key channels: ' + absent.join(', ') + '.');
    } else {
      writeConsole('Log channels OK: RPM, MAP present. ' +
        Object.keys(mapResult.mapping).length + ' signals mapped.');
    }
  });

  function renderAnalysis(report) {
    var dist = report.regionDistribution;
    var total = report.rowCount || 1;
    function pct(n) { return Math.round((100 * n) / total) + '%'; }

    var html = '<p><strong>' + report.rowCount + '</strong> rows analyzed.</p>';
    html += '<table><thead><tr><th>Region</th><th>Samples</th><th>Share</th></tr></thead><tbody>';
    P66.REGIONS.forEach(function (r) {
      html += '<tr><td>' + r + '</td><td>' + (dist[r] || 0) + '</td><td>' + pct(dist[r] || 0) + '</td></tr>';
    });
    html += '</tbody></table>';

    if (report.missingChannels.length) {
      html += '<p class="status-warn">Missing channels: ' + esc(report.missingChannels.join(', ')) +
        ' — region classification degraded.</p>';
    }

    // Fuel trims
    var ft = report.fuelTrims;
    html += '<h3>Fuel Trim Bias (top cells)</h3>';
    if (ft.available && ft.cells.length) {
      html += '<p class="muted">Overall avg |trim|: ' + ft.overallAvgAbsTrim + '% across ' +
        ft.totalSamples + ' samples, ' + ft.cellCount + ' cells.</p>';
      html += '<table><thead><tr><th>RPM</th><th>MAP kPa</th><th>Avg Trim %</th><th>Samples</th></tr></thead><tbody>';
      ft.cells.slice(0, 8).forEach(function (c) {
        var cls = Math.abs(c.avgTrim) >= 5 ? 'status-bad' : (Math.abs(c.avgTrim) >= 3 ? 'status-warn' : 'status-ok');
        html += '<tr><td>' + esc(c.rpmBin) + '</td><td>' + esc(c.mapBin) + '</td>' +
          '<td class="' + cls + '">' + (c.avgTrim > 0 ? '+' : '') + c.avgTrim + '</td>' +
          '<td>' + c.samples + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="muted">' + esc(ft.reason || 'No fuel trim data.') + '</p>';
    }

    // Knock
    var k = report.knock;
    html += '<h3>Knock</h3>';
    if (k.available) {
      var kcls = k.knockSamples === 0 ? 'status-ok' : (k.maxKR >= 4 ? 'status-bad' : 'status-warn');
      html += '<p class="' + kcls + '">' + k.knockSamples + ' knock samples (' + k.knockPct +
        '%), max KR ' + k.maxKR + '°, avg when active ' + k.avgKRWhenActive + '°.</p>';
    } else {
      html += '<p class="muted">' + esc(k.reason || 'No knock data.') + '</p>';
    }

    // Lambda
    var l = report.lambda;
    html += '<h3>Commanded vs Measured Lambda</h3>';
    if (l.available) {
      var lcls = l.meanAbsError <= 0.03 ? 'status-ok' : 'status-warn';
      html += '<p class="' + lcls + '">Mean abs error ' + l.meanAbsError + ' λ, ' +
        l.pctWithin3Pct + '% within ±0.03 λ (' + l.samples + ' samples).</p>';
    } else {
      html += '<p class="muted">' + esc(l.reason || 'No lambda data.') + '</p>';
    }

    // Altitude & baro
    var baro = report.baro;
    html += '<h3>Altitude &amp; Baro</h3>';
    if (baro && baro.available) {
      var bcls = baro.status === 'ok' ? 'status-ok' : (baro.status === 'warn' ? 'status-warn' : 'status-bad');
      html += '<p class="' + bcls + '">' + esc(baro.note) + '</p>';
      html += '<p class="muted">Altitude setting: ' + esc(String(report.altitudeFt)) + ' ft → expected baro ~' +
        baro.expectedKpa + ' kPa. PCM reported ' + baro.pcmMedianKpa + ' kPa (median of ' +
        baro.samples + ' samples).</p>';
      if (baro.wotMapFlag) {
        html += '<p class="status-bad">' + esc(baro.wotMapFlag) + '</p>';
      }
    } else {
      html += '<p class="muted">' + esc((baro && baro.reason) || 'Baro check unavailable.') + '</p>';
    }

    // Bank imbalance
    var bi = report.bankImbalance;
    html += '<h3>Bank Balance</h3>';
    if (bi && bi.available) {
      if (bi.findingCount) {
        html += '<p class="status-bad"><strong>' + bi.findingCount + ' cell(s) with a bank-to-bank trim split.</strong> ' +
          'This is usually mechanical (vacuum leak, injector, O2 sensor) — not a VE table problem. ' +
          'Fix the cause before changing fueling.</p>';
        html += '<table><thead><tr><th>Cell</th><th>Bank 1 trim</th><th>Bank 2 trim</th><th>|Δ|</th><th>Samples</th></tr></thead><tbody>';
        bi.findings.slice(0, 8).forEach(function (f) {
          var b1cls = f.bank1Avg > 0 ? 'trim-pos' : (f.bank1Avg < 0 ? 'trim-neg' : '');
          var b2cls = f.bank2Avg > 0 ? 'trim-pos' : (f.bank2Avg < 0 ? 'trim-neg' : '');
          html += '<tr><td>' + esc(f.cell) + '</td>' +
            '<td class="' + b1cls + '">' + (f.bank1Avg > 0 ? '+' : '') + f.bank1Avg + '%</td>' +
            '<td class="' + b2cls + '">' + (f.bank2Avg > 0 ? '+' : '') + f.bank2Avg + '%</td>' +
            '<td class="status-bad">' + Math.abs(f.delta) + '%</td>' +
            '<td>' + f.samples1 + '/' + f.samples2 + '</td></tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<p class="status-ok">Banks agree — no bank-to-bank trim split found.</p>';
      }
    } else {
      html += '<p class="muted">' + esc((bi && bi.reason) || 'Need both banks’ trim channels for this check.') + '</p>';
    }

    // Narrowband O2
    var nb = report.narrowband;
    html += '<h3>Narrowband O2</h3>';
    if (nb.available) {
      html += '<p class="muted">Sensor health: ' +
        nb.crossCounts.map(function (c) {
          return esc(c.bank) + ' ' + esc(c.health) +
            (c.perMin !== null ? ' (' + c.perMin + '/min)' : '');
        }).join(', ') + '. WOT check: ' + esc(nb.wotCheck.status) + '.</p>';
      if (nb.cells.length) {
        html += '<table><thead><tr><th>RPM</th><th>MAP kPa</th><th>Avg O2 mV</th><th>Bias</th><th>Samples</th></tr></thead><tbody>';
        nb.cells.slice(0, 8).forEach(function (c) {
          var cls = c.bias === 'lean' ? 'status-bad' : (c.bias === 'rich' ? 'status-warn' : 'status-ok');
          html += '<tr><td>' + esc(c.rpmBin) + '</td><td>' + esc(c.mapBin) + '</td>' +
            '<td>' + c.avgMv + '</td><td class="' + cls + '">' + c.bias + '</td>' +
            '<td>' + c.samples + '</td></tr>';
        });
        html += '</tbody></table>';
      }
    } else {
      html += '<p class="muted">' + esc(nb.reason || 'No O2 data.') + '</p>';
    }

    analysisResults.innerHTML = html;
  }

  document.getElementById('analyze-btn').addEventListener('click', function () {
    if (!parsedLog || !mapResult) {
      writeConsole('Analyze blocked: load a log file first.');
      return;
    }
    try {
      sessionReport = P66.analyzeSession(parsedLog, mapResult, { altitudeFt: currentAltitudeFt() });
      sessionHistory.push(sessionReport);
      if (sessionHistory.length > 10) sessionHistory.shift();
      renderAnalysis(sessionReport);
      P66.renderDashboard(dashParts, sessionReport, parsedLog, mapResult, sessionHistory,
        { logName: files.log ? files.log.name : '' });
      writeConsole('Analysis complete: ' + sessionReport.rowCount + ' rows, ' +
        Object.keys(sessionReport.regionDistribution).length + ' regions classified. ' +
        '(session ' + sessionHistory.length + ' in history)');
    } catch (err) {
      writeConsole('Analysis failed: ' + (err && err.message ? err.message : err));
    }
  });

  function renderTune(result) {
    var html = '<p><strong>' + esc(result.summary) + '</strong></p>';
    if (result.actionable.length) {
      html += '<h3>Actionable</h3><table><thead><tr><th>Table</th><th>Cell</th><th>Action</th><th>Detail</th><th>Confidence</th></tr></thead><tbody>';
      result.actionable.forEach(function (s) {
        var detail = s.deltaPct !== undefined && s.deltaPct !== 0
          ? (s.deltaPct > 0 ? '+' : '') + s.deltaPct + '%'
          : (s.deltaDeg !== undefined ? s.deltaDeg + '°' : '—');
        var cls = s.confidence === 'high' ? 'status-ok' : 'status-warn';
        html += '<tr><td>' + esc(s.table) + '</td><td>' + esc(s.cell) + '</td>' +
          '<td>' + esc(s.action) + '</td><td>' + esc(detail) + '</td>' +
          '<td class="' + cls + '">' + esc(s.confidence) + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<h3>Why</h3><ul>';
      result.actionable.forEach(function (s) {
        html += '<li><strong>' + esc(s.table) + ' / ' + esc(s.cell) + ':</strong> ' + esc(s.reason) + '</li>';
      });
      html += '</ul>';
    }
    if (result.blocked.length) {
      html += '<h3>Held by safety gates</h3><ul>';
      result.blocked.forEach(function (s) {
        html += '<li><strong>' + esc(s.table) + ' / ' + esc(s.cell) + ':</strong> ' + esc(s.reason) + '</li>';
      });
      html += '</ul>';
    }
    html += '<p class="status-warn"><strong>Review every suggestion manually before flashing. ' +
      'Re-log after applying changes and iterate.</strong></p>';

    // Concrete binary patches when XDF + BIN are loaded.
    lastPatches = null;
    var allPatches = [];
    var finalImage = null;
    if (xdfCatalog && binBytes) {
      // Safety gate: confirm the binary is a genuine P66 image before
      // generating any patch. Strangers will use this tool — never patch
      // a file we cannot identify.
      var binGuard = (typeof P66.checkBinary === 'function')
        ? P66.checkBinary(binBytes)
        : { level: 'block', calId: null, matchedCal: null, matchPct: 0, messages: ['Safety guard not loaded (js/safety.js + js/fingerprints.js).'] };
      if (binGuard.level === 'block') {
        html += '<h3>Binary Patches — blocked</h3>';
        html += '<p class="status-warn"><strong>Patching is blocked for your safety.</strong> No changes were generated and no binary is offered.</p><ul>';
        binGuard.messages.forEach(function (m) { html += '<li>' + esc(m) + '</li>'; });
        html += '</ul>';
      } else {
      if (binGuard.level === 'warn') {
        html += '<p class="status-warn"><strong>Binary warning:</strong> ' + esc(binGuard.messages.join(' ')) + '</p>';
      } else {
        html += '<p class="status-ok">' + esc(binGuard.messages.join(' ')) + '</p>';
      }
      try {
        var patchResult = P66.applyFuelSuggestions(xdfCatalog, binBytes, result.actionable);
        // Each stage patches on top of the previous stage's image so the
        // final binary carries everything. Stages touch disjoint regions,
        // so old-values read downstream still match the source binary.
        var sparkBase = (patchResult.patched && !patchResult.error) ? patchResult.patched : binBytes;
        var sparkResult = (typeof P66.applySparkSuggestions === 'function')
          ? P66.applySparkSuggestions(xdfCatalog, sparkBase, result.actionable)
          : { patches: [], patched: null, error: 'Spark patcher not loaded (js/xdf-map.js).' };
        var peBase = (sparkResult.patched && !sparkResult.error) ? sparkResult.patched : sparkBase;
        var peResult = (typeof P66.applyPeSuggestions === 'function')
          ? P66.applyPeSuggestions(xdfCatalog, peBase, result.actionable)
          : { patches: [], patched: null, error: 'PE patcher not loaded (js/xdf-map.js).' };
        var allPatches = (patchResult.patches || []).concat(sparkResult.patches || [], peResult.patches || []);
        var finalImage = peResult.patched || sparkResult.patched || patchResult.patched;
        var patchErrors = [patchResult.error, sparkResult.error, peResult.error].filter(function (e) { return !!e; });
        if (allPatches.length === 0 && patchErrors.length) {
          html += '<p class="status-warn">Binary patching unavailable: ' + esc(patchErrors.join(' / ')) + '</p>';
        } else if (patchErrors.length) {
          html += '<p class="status-warn">Partial patching: ' + esc(patchErrors.join(' / ')) + '</p>';
        }
        if (allPatches.length) {
          // Reliability gate: verify every patch against the source binary
          // and catalog before the patched binary is offered for download.
          var verification = null;
          try {
            verification = (typeof P66.verifyPatches === 'function')
              ? P66.verifyPatches(xdfCatalog, binBytes, { patches: allPatches, patched: finalImage, error: null })
              : { ok: false, checked: 0, failures: [{ addressHex: null, check: 'missing', message: 'Verifier not loaded (js/verify.js).' }], warnings: [] };
          } catch (verr) {
            verification = { ok: false, checked: 0, failures: [{ addressHex: null, check: 'exception', message: 'Verifier threw: ' + (verr && verr.message ? verr.message : verr) }], warnings: [] };
          }
          if (!verification.ok) {
            lastPatches = null;
            html += '<h3>Binary Patches — verification FAILED</h3>';
            html += '<p class="status-warn"><strong>' + verification.failures.length +
              ' check(s) failed on ' + verification.checked + ' patch(es). The patched binary is NOT offered for download.</strong></p>';
            html += '<ul>';
            verification.failures.forEach(function (f) {
              html += '<li><strong>' + esc(f.addressHex || '—') + ' [' + esc(f.check) + ']:</strong> ' + esc(f.message) + '</li>';
            });
            html += '</ul>';
          } else {
            // Output-provenance hard rule: diff the actual source-vs-patched
            // bytes. Any differing byte NOT covered by a verified patch
            // address blocks the download — this is an additional gate on
            // top of the verify.js checks, not a replacement.
            var provenance = null;
            try {
              provenance = (typeof P66.buildProvenance === 'function')
                ? P66.buildProvenance(binBytes, finalImage, allPatches,
                    { app: 'p66-tuner (advanced)', catalog: xdfCatalog })
                : { ok: false, sourceSha256: null, patchedSha256: null, changedByteCount: 0,
                    changeReport: '', uncovered: [],
                    message: 'Provenance module not loaded (js/provenance.js).' };
            } catch (perr) {
              provenance = { ok: false, sourceSha256: null, patchedSha256: null, changedByteCount: 0,
                changeReport: '', uncovered: [],
                message: 'Provenance check threw: ' + (perr && perr.message ? perr.message : perr) };
            }
            if (!provenance.ok) {
              lastPatches = null;
              html += '<h3>Binary Patches — provenance FAILED</h3>';
              html += '<p class="status-warn"><strong>' + esc(provenance.message) +
                ' The patched binary is NOT offered for download.</strong></p>';
              if (provenance.uncovered && provenance.uncovered.length) {
                html += '<ul>';
                provenance.uncovered.forEach(function (u) {
                  html += '<li><strong>' + esc(u.startHex + (u.end > u.start ? '..' + u.endHex : '')) +
                    '</strong> — ' + u.count + ' changed byte(s) with no covering patch.</li>';
                });
                html += '</ul>';
              }
              if (provenance.changeReport) {
                html += '<pre>' + esc(provenance.changeReport) + '</pre>';
              }
            } else {
            lastPatches = { patches: allPatches, patched: finalImage, provenance: provenance };
            // Cumulative runaway guard: warn when this patch set would push
            // any cell's multi-session total past the guardrails. Keyed by
            // source fingerprint, so a different binary starts clean.
            if (typeof P66.createLedger === 'function' && provenance.sourceSha256) {
              var ledgerWarnings = P66.createLedger().check(provenance.sourceSha256, allPatches);
              if (ledgerWarnings.length) {
                html += '<p class="status-warn"><strong>Cumulative change guardrail:</strong> ' +
                  ledgerWarnings.length + ' cell(s) reach the multi-session limit across downloaded tunes. ' +
                  'Each tune was capped on its own, but the totals have stacked up.</p><ul>';
                ledgerWarnings.slice(0, 8).forEach(function (w) {
                  html += '<li>' + esc(w.message) + '</li>';
                });
                html += '</ul>';
              }
            }
            html += '<h3>Binary Patches</h3>';
            html += '<p class="status-ok"><strong>Verification passed:</strong> ' + verification.checked +
              ' patch(es) — addresses in range and inside their table\'s XDF region, ' +
              'old values match the source binary, no conflicting writes, read-back OK.</p>';
            if (verification.warnings.length) {
              html += '<ul>';
              verification.warnings.forEach(function (w) {
                html += '<li class="status-warn"><strong>' + esc(w.addressHex) + ' [' + esc(w.check) + ']:</strong> ' + esc(w.message) + '</li>';
              });
              html += '</ul>';
            }
          html += '<table><thead><tr><th>Table</th><th>Address</th><th>Cell</th><th>Old</th><th>New</th><th>Δ</th></tr></thead><tbody>';
          allPatches.forEach(function (p) {
            var delta;
            if (p.deltaAfrPct !== undefined && p.deltaAfrPct !== null) delta = p.deltaAfrPct + '% AFR';
            else if (p.deltaDeg !== undefined && p.deltaDeg !== null) delta = p.deltaDeg + '°';
            else delta = (p.deltaPct > 0 ? '+' : '') + p.deltaPct + '%';
            html += '<tr><td>' + esc(p.table) + '</td><td>' + esc(p.addressHex) + '</td>' +
              '<td>' + p.rpm + ' RPM / ' + p.map + ' kPa' + (p.smoothed ? ' (smoothed)' : '') + '</td>' +
              '<td>' + p.oldValue + '</td><td>' + p.newValue + '</td>' +
              '<td>' + delta + '</td></tr>';
          });
          html += '</tbody></table>';
          html += '<h3>VE Table: Before vs After</h3>';
          html += '<div id="ve-compare"><p class="muted">Rendering VE table…</p></div>';
          html += '<p><strong>Audit trail</strong></p>';
          html += '<p><strong>Source SHA-256:</strong><br><code>' + esc(provenance.sourceSha256) + '</code></p>';
          html += '<p><strong>Patched SHA-256:</strong><br><code>' + esc(provenance.patchedSha256) + '</code></p>';
          html += '<p><strong>Changed bytes:</strong> ' + provenance.changedByteCount + '</p>';
          html += '<p><button id="download-bin-btn" style="width:auto;padding:0.55rem 1.2rem;">Download patched binary</button> ' +
            '<button id="download-report-btn" style="width:auto;padding:0.55rem 1.2rem;">Download change report (.txt)</button></p>';
          html += '<p class="status-warn"><strong>Before you flash:</strong> save a backup copy of your ORIGINAL binary somewhere safe — ' +
            'if anything behaves unexpectedly you will need it to go back.</p>';
          html += '<p class="status-warn"><strong>Checksum status: none found.</strong> ' +
            'No checksum definition exists in the P66 XDF, no common GM checksum scheme ' +
            'validates on the stock binary, and community practice is to flash P66 bins ' +
            'without manual checksum correction. Bench-verify on a spare PCM before ' +
            'flashing a running vehicle.</p>';
          }
          } // end provenance-ok else
        } else {
          html += '<p class="muted">No patches applied (no actionable fuel, spark, or PE suggestions).</p>';
        }
      } catch (err) {
        html += '<p class="status-warn">Patch generation failed: ' + esc(err && err.message ? err.message : err) + '</p>';
      }
      } // end safety-guard else (binGuard.level !== 'block')
    } else {
      html += '<p class="muted">Load an XDF + stock binary to get concrete binary patches.</p>';
    }

    // Plain-English summary first: nobody should flash a binary they
    // cannot describe in their own words.
    if (typeof P66.summarizeTune === 'function') {
      var tuneSummary = P66.summarizeTune(result.actionable, allPatches);
      var sh = '<h3>What this tune does</h3><p><strong>' + esc(tuneSummary.headline) + '</strong></p>';
      if (tuneSummary.bullets.length) {
        sh += '<ul>';
        tuneSummary.bullets.forEach(function (b) { sh += '<li>' + esc(b) + '</li>'; });
        sh += '</ul>';
      }
      html = sh + html;
    }

    tuneResults.innerHTML = html;

    var veCompare = document.getElementById('ve-compare');
    if (veCompare && typeof P66.renderVeComparison === 'function' && xdfCatalog && binBytes) {
      try {
        P66.renderVeComparison(veCompare, xdfCatalog, binBytes, lastPatches ? lastPatches.patches : []);
      } catch (verr) {
        veCompare.innerHTML = '<p class="muted">VE table render failed: ' +
          esc(verr && verr.message ? verr.message : verr) + '</p>';
      }
    }

    var dlBtn = document.getElementById('download-bin-btn');
    if (dlBtn && lastPatches && lastPatches.patched) {
      dlBtn.addEventListener('click', function () {
        var blob = new Blob([lastPatches.patched], { type: 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'p66-tuned.bin';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
        // Record the download in the cumulative ledger: the best available
        // proxy for "about to flash". Feeds the multi-session guardrail.
        if (typeof P66.createLedger === 'function' && lastPatches.provenance.sourceSha256) {
          P66.createLedger().record(lastPatches.provenance.sourceSha256, lastPatches.patches, { note: 'advanced flow' });
        }
        writeConsole('Patched binary downloaded (' + lastPatches.patches.length + ' patches). No checksum correction applied (none found for P66) — bench-verify before flashing.');
      });
    }
    var rptBtn = document.getElementById('download-report-btn');
    if (rptBtn && lastPatches && lastPatches.provenance) {
      rptBtn.addEventListener('click', function () {
        var blob = new Blob([lastPatches.provenance.changeReport], { type: 'text/plain' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'p66-change-report.txt';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
        writeConsole('Change report downloaded (source SHA-256 ' + lastPatches.provenance.sourceSha256.slice(0, 12) + '…, ' +
          lastPatches.provenance.changedByteCount + ' bytes changed).');
      });
    }
  }

  document.getElementById('tune-btn').addEventListener('click', function () {
    if (!sessionReport) {
      writeConsole('Tune blocked: run analysis first.');
      return;
    }
    var mode = modeSelect ? modeSelect.value : 'conservative';
    try {
      var result = P66.generateSuggestions(sessionReport, mode, xdfCatalog);
      renderTune(result);
      writeConsole('Tune suggestions generated (' + mode + ' mode): ' + result.summary);
    } catch (err) {
      writeConsole('Tune generation failed: ' + (err && err.message ? err.message : err));
    }
  });

  refreshSummary();
  renderMappingPreview();
})();
