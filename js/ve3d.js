/* P66-Tuner 3D surface views — lazy-loaded.
 *
 * Extracted from js/dashboard.js (item 18: lazy-load the heavy views).
 * There is intentionally no <script> tag for this file in index.html:
 * dashboard.js's ensureVe3d() gate fetches it on the first 3D view
 * request via P66.loadScriptOnce('js/ve3d.js') (see js/lazy.js).
 *
 * Load order: veSurfaceModel colors nodes through P66._trimColor and
 * P66._valueRamp, attached by js/dashboard.js at load. dashboard.js is a
 * static <script> tag and always runs before this file is lazy-loaded,
 * so those helpers are read at CALL time here, never cached at load.
 *
 * All public names attach to the shared P66 namespace exactly as before,
 * so existing callers keep working:
 *   P66.renderVeSurface, P66.veSurfaceModel, P66.setVePointsSource,
 *   P66.vePointsSample, P66.vePointsInRange, P66.veAxisFrac,
 *   P66.vePointModel, P66._vePointsResolve, P66.VE_POINTS_MAX,
 *   P66._veRotate, P66._veBilinear, P66._veFaceLight
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Operating points on the VE 3D surface: stride-sampled (rpm, map) log
  // samples drawn as dots on the surface. The log source is provided by
  // the host app via P66.setVePointsSource(); it stays null until a log
  // is loaded, in which case the toggle shows a disabled/hint state.
  var VE_POINTS_MAX = 2000;
  var vePointsSource = null; // { parsedLog, mapResult } | null

  // Sequential value color, mirroring veValueColor() in js/dashboard.js:
  // the node value mapped through the shared multi-hue P66._valueRamp.
  function veValueColor(v, min, max) {
    var t = max > min ? (v - min) / (max - min) : 0.5;
    return P66._valueRamp(Math.max(0, Math.min(1, t)));
  }

  /* ---------- VE table 3D surface ---------- */

  /**
   * Pure rotation helper (testable): azimuth about Y, then elevation about X.
   * Returns camera-space { x1, y2, z2 }; larger z2 = closer to viewer.
   */
  function veRotate(x, y, z, az, el) {
    var cosA = Math.cos(az), sinA = Math.sin(az);
    var x1 = x * cosA - z * sinA;
    var z1 = x * sinA + z * cosA;
    var cosE = Math.cos(el), sinE = Math.sin(el);
    return { x1: x1, y2: y * cosE - z1 * sinE, z2: y * sinE + z1 * cosE };
  }

  /**
   * Private copy: js/dashboard.js keeps its own cssToRgb for cellTextColor.
   * Parse a CSS color ('#rrggbb' or 'rgb(r,g,b)') into [r, g, b].
   * The VE palette helpers return rgb() strings, so handle both.
   */
  function cssToRgb(css) {
    var m = /^#([0-9a-f]{6})$/i.exec(css);
    if (m) {
      var n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(css);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    return [35, 44, 58]; // fallback: dark neutral
  }

  /**
   * Pure bilinear interpolation (testable).
   * Corners: a00 at (u=0,v=0), a10 at (1,0), a01 at (0,1), a11 at (1,1).
   */
  function veBilinear(a00, a10, a01, a11, u, v) {
    return a00 * (1 - u) * (1 - v) + a10 * u * (1 - v) +
           a01 * (1 - u) * v + a11 * u * v;
  }

  // Fixed camera-space light direction (toward the light), normalized.
  var VE_LIGHT = (function () {
    var l = [-0.42, 0.82, 0.39];
    var n = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
    return [l[0] / n, l[1] / n, l[2] / n];
  })();

  /**
   * Pure face brightness (testable): dhdx/dhdz are dy/dx, dy/dz in grid
   * units. The surface normal is rotated into camera space and dotted
   * with a fixed camera-space light. Returns 0.55..1.
   */
  function veFaceLight(dhdx, dhdz, cosA, sinA, cosE, sinE) {
    var inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    var nx = -dhdx * inv, ny = inv, nz = -dhdz * inv;
    var x1 = nx * cosA - nz * sinA;
    var z1 = nx * sinA + nz * cosA;
    var y2 = ny * cosE - z1 * sinE;
    var z2 = ny * sinE + z1 * cosE;
    var dot = x1 * VE_LIGHT[0] + y2 * VE_LIGHT[1] + z2 * VE_LIGHT[2];
    if (dot < 0.12) dot = 0.12;
    if (dot > 1) dot = 1;
    return 0.55 + 0.45 * dot;
  }

  /**
   * Pure stride sampler for operating points (testable in node).
   * Evenly samples up to maxPoints { rpm, map } pairs across the WHOLE
   * log (not just the first rows). rows: a log table or a legacy array of
   * parsed-log row objects keyed by header name; rpmCol/mapCol: column
   * names from P66.columnFor().
   * Rows with non-numeric rpm/map are dropped; the stride is computed
   * over the valid rows so coverage still spans the session.
   */
  function vePointsSample(rows, rpmCol, mapCol, maxPoints) {
    maxPoints = maxPoints === undefined ? VE_POINTS_MAX : maxPoints;
    var t = P66.asTable(rows);
    var n = t ? t.rowCount : 0;
    if (!n || !rpmCol || !mapCol || !(maxPoints > 0)) return [];
    var rpmC = P66.numView(t, rpmCol);
    var mapC = P66.numView(t, mapCol);
    if (!rpmC || !mapC) return [];
    var valid = [];
    for (var i = 0; i < n; i++) {
      if (rpmC[i] === rpmC[i] && mapC[i] === mapC[i]) valid.push(i);
    }
    if (!valid.length) return [];
    var count = Math.min(maxPoints, valid.length);
    var pts = [];
    for (var k = 0; k < count; k++) {
      var r = valid[Math.floor(k * valid.length / count)];
      pts.push({ rpm: rpmC[r], map: mapC[r] });
    }
    return pts;
  }

  /**
   * Pure range filter for operating points (testable in node).
   * Drops points outside the table's RPM x MAP axis range (inclusive).
   * Breakpoints may run ascending or descending.
   */
  function vePointsInRange(points, rpmBp, mapBp) {
    if (!points || !points.length) return [];
    if (!rpmBp || rpmBp.length < 2 || !mapBp || mapBp.length < 2) return [];
    var rmin = Math.min.apply(null, rpmBp), rmax = Math.max.apply(null, rpmBp);
    var mmin = Math.min.apply(null, mapBp), mmax = Math.max.apply(null, mapBp);
    if (!isFinite(rmin) || !isFinite(rmax) || !isFinite(mmin) || !isFinite(mmax)) return [];
    return points.filter(function (p) {
      return p.rpm >= rmin && p.rpm <= rmax && p.map >= mmin && p.map <= mmax;
    });
  }

  /**
   * Pure: map a physical value to a fractional cell coordinate on a
   * monotone breakpoint axis (testable in node). Returns 0..bps.length-1,
   * or null when outside the axis range. Handles ascending or descending
   * breakpoints, clamping at exact endpoints.
   */
  function veAxisFrac(bps, v) {
    if (!bps || bps.length < 2) return null;
    var asc = bps[bps.length - 1] > bps[0];
    var lo = asc ? bps[0] : bps[bps.length - 1];
    var hi = asc ? bps[bps.length - 1] : bps[0];
    if (!(v >= lo && v <= hi)) return null;
    for (var i = 0; i < bps.length - 1; i++) {
      var a = bps[i], b = bps[i + 1];
      var inSeg = asc ? (v >= a && v <= b) : (v <= a && v >= b);
      if (inSeg) {
        var t = (b === a) ? 0 : (v - a) / (b - a);
        return i + Math.max(0, Math.min(1, t));
      }
    }
    return bps.length - 1; // exact endpoint missed by the scan (float dust)
  }

  /**
   * Pure: model-space position of an operating point for the 3D view
   * (testable in node). p: { rpm, map }; model: veSurfaceModel result
   * ({ nodes, rows, cols }); data: veComparisonData result (rpmBp/mapBp);
   * heightScale: the same height scale the renderer uses.
   * Returns { x, y, z } matching the vertex-grid math (x = MAP column,
   * z = RPM row, y = interpolated surface height), or null when the point
   * falls outside the table's axis range.
   */
  function vePointModel(p, model, data, heightScale) {
    if (!p || !model || !model.nodes || !data) return null;
    var rf = veAxisFrac(data.rpmBp, p.rpm);
    var cf = veAxisFrac(data.mapBp, p.map);
    if (rf === null || cf === null) return null;
    var nodes = model.nodes;
    var r0 = Math.min(Math.floor(rf), data.rows - 2), fv = rf - r0, r1 = r0 + 1;
    var c0 = Math.min(Math.floor(cf), data.cols - 2), fu = cf - c0, c1 = c0 + 1;
    if (!nodes[r0] || !nodes[r1] || !nodes[r0][c0] || !nodes[r1][c1]) return null;
    var h = veBilinear(nodes[r0][c0].h, nodes[r0][c1].h,
                       nodes[r1][c0].h, nodes[r1][c1].h, fu, fv);
    return {
      x: cf - (data.cols - 1) / 2,
      y: h * heightScale,
      z: rf - (data.rows - 1) / 2
    };
  }

  /**
   * Set (or clear) the parsed-log source used by the operating-points
   * overlay. Call after a log is parsed:
   *   P66.setVePointsSource({ parsedLog: parsedLog, mapResult: mapResult });
   * Call with null when the log is cleared.
   */
  function setVePointsSource(source) {
    vePointsSource = (source && source.parsedLog && source.mapResult) ? source : null;
  }

  /**
   * Resolve sampled operating points for the current 3D table view.
   * Returns { points, rpmCol, mapCol } or null when no usable log source
   * (no source set, or RPM/MAP columns not mapped).
   */
  function vePointsResolve(data) {
    if (!vePointsSource || typeof P66.columnFor !== 'function') return null;
    var rpmCol = P66.columnFor(vePointsSource.mapResult, 'RPM');
    var mapCol = P66.columnFor(vePointsSource.mapResult, 'MAP');
    if (!rpmCol || !mapCol || !vePointsSource.parsedLog) return null;
    var pts = vePointsInRange(
      vePointsSample(vePointsSource.parsedLog, rpmCol, mapCol, VE_POINTS_MAX),
      data.rpmBp, data.mapBp);
    return { points: pts, rpmCol: rpmCol, mapCol: mapCol };
  }

  /**
   * Pure surface model for the 3D view (testable in node).
   * dataset: 'before' | 'after' | 'change'.
   * Returns per-NODE { h, rgb } so the renderer can bilinearly subdivide
   * into a smooth continuous surface. Node heights: before/after -> 0..1,
   * change -> -1..1 (signed).
   * The change dataset reads a cell's signed delta through tableDelta():
   * fuel views carry deltaPct, spark views carry deltaDeg — same diverging
   * palette either way (positive/add = blue, negative/remove = red).
   */
  function tableDelta(d) {
    if (!d) return null;
    if (d.deltaDeg !== undefined && d.deltaDeg !== null) return d.deltaDeg;
    return d.deltaPct;
  }

  function veSurfaceModel(data, dataset) {
    var vmin = Infinity, vmax = -Infinity, maxAbs = 0;
    data.before.forEach(function (row) {
      row.forEach(function (v) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      });
    });
    data.deltas.forEach(function (row) {
      row.forEach(function (d) {
        var dv = tableDelta(d);
        if (dv !== null && Math.abs(dv) > maxAbs) maxAbs = Math.abs(dv);
      });
    });
    var nodes = [];
    for (var r = 0; r < data.rows; r++) {
      var row = [];
      for (var c = 0; c < data.cols; c++) {
        var d = data.deltas[r][c];
        var h, rgb;
        if (dataset === 'change') {
          var dv = tableDelta(d);
          if (dv === null) dv = 0;
          h = maxAbs > 0 ? dv / maxAbs : 0;
          rgb = cssToRgb(d ? P66._trimColor(Math.max(-10, Math.min(10, dv))) : '#232c3a');
        } else {
          var v = dataset === 'before' ? data.before[r][c] : data.after[r][c];
          h = (vmax > vmin) ? (v - vmin) / (vmax - vmin) : 0.5;
          rgb = cssToRgb(veValueColor(v, vmin, vmax));
        }
        // Cell provenance (optional, attached by the caller as
        // data.provenance): desaturate interpolated cells so unmeasured
        // regions read as less trustworthy. Never touches fuel blue/red.
        try {
          var provCell = data.provenance && data.provenance.cells[r] &&
            data.provenance.cells[r][c];
          if (provCell && provCell.kind === 'interpolated' &&
              typeof P66.veProvenanceColor === 'function') {
            var ps = P66.veProvenanceColor(provCell,
              'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')');
            var pm = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(ps || '');
            if (pm) rgb = [+pm[1], +pm[2], +pm[3]];
          }
        } catch (perr) { /* provenance is decorative */ }
        row.push({ h: h, rgb: rgb });
      }
      nodes.push(row);
    }
    return { nodes: nodes, rows: data.rows, cols: data.cols };
  }

  /**
   * Interactive 3D VE surface on a canvas. No dependencies — hand-rolled
   * orthographic projection on canvas 2D, so the offline zip still works.
   * Slow auto-rotate, drag to rotate, scroll to zoom. Returns stop().
   * opts (optional): { getShowPoints(), getPoints() } — when getShowPoints()
   * is true, stride-sampled operating points are drawn as small dots just
   * above the surface using the same projection as the surface itself.
   */
  function renderVeSurface(canvas, data, getDataset, opts) {
    var ctx = canvas.getContext('2d');
    var DPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var W = 620, H = 440;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = '100%';
    canvas.style.maxWidth = W + 'px';
    canvas.style.height = 'auto';
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    var rows = data.rows, cols = data.cols;
    var cx0 = (cols - 1) / 2, cz0 = (rows - 1) / 2;
    var heightScale = Math.min(cols, rows) * 0.55;
    var baseScale = Math.min(W / (cols + 5), H / (rows + 5)) * 0.92;

    var az = -0.65, el = 0.95, zoom = 1;
    var dragging = false, lastX = 0, lastY = 0, lastInteract = 0;
    var AUTO_SPEED = 0.0038; // rad/frame — a full turn takes ~28s
    var raf = 0, stopped = false;

    // Operating-points overlay: the host supplies live getters so the
    // toggle and sample stay in sync without rebuilding the surface.
    var getShowPoints = opts && typeof opts.getShowPoints === 'function'
      ? opts.getShowPoints : function () { return false; };
    var getPoints = opts && typeof opts.getPoints === 'function'
      ? opts.getPoints : function () { return []; };

    // Subdivision quality: each table cell becomes KxK sub-quads with
    // bilinearly interpolated heights/colors for a smooth surface.
    // Drops automatically if the frame rate sags.
    var K = 4, emaDt = 16, lastT = 0;

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function proj(x, y, z) {
      var p = veRotate(x - cx0, y, z - cz0, az, el);
      var s = baseScale * zoom;
      return { sx: W / 2 + p.x1 * s, sy: H / 2 + 14 - p.y2 * s, depth: p.z2 };
    }

    function frame() {
      if (stopped) return;
      var now = Date.now();
      if (!dragging && now - lastInteract > 2500) az += AUTO_SPEED;

      if (typeof performance !== 'undefined' && performance.now) {
        var t = performance.now();
        if (lastT) {
          emaDt = emaDt * 0.94 + (t - lastT) * 0.06;
          if (emaDt > 46 && K > 2) { K--; emaDt = 16; }
        }
        lastT = t;
      }

      var cosA = Math.cos(az), sinA = Math.sin(az);
      var cosE = Math.cos(el), sinE = Math.sin(el);
      var s = baseScale * zoom;
      var ox = W / 2, oy = H / 2 + 14;

      ctx.clearRect(0, 0, W, H);
      var m = veSurfaceModel(data, getDataset());
      var nodes = m.nodes;

      // Subdivided vertex grid shared between sub-quads (no cracks).
      var vR = (rows - 1) * K + 1, vC = (cols - 1) * K + 1;
      var nv = vR * vC;
      var sx = new Array(nv), sy = new Array(nv), dep = new Array(nv);
      var vr = new Array(nv), vg = new Array(nv), vb = new Array(nv);
      var idx = 0;
      for (var vi = 0; vi < vR; vi++) {
        var r0 = Math.min((vi / K) | 0, rows - 2), fv = vi / K - r0, r1 = r0 + 1;
        for (var vj = 0; vj < vC; vj++) {
          var c0 = Math.min((vj / K) | 0, cols - 2), fu = vj / K - c0, c1 = c0 + 1;
          var n00 = nodes[r0][c0], n10 = nodes[r0][c1];
          var n01 = nodes[r1][c0], n11 = nodes[r1][c1];
          var h = veBilinear(n00.h, n10.h, n01.h, n11.h, fu, fv);
          var y = h * heightScale;
          var x = (c0 + fu) - cx0, z = (r0 + fv) - cz0;
          var x1 = x * cosA - z * sinA;
          var z1 = x * sinA + z * cosA;
          var y2 = y * cosE - z1 * sinE;
          var z2 = y * sinE + z1 * cosE;
          sx[idx] = ox + x1 * s;
          sy[idx] = oy - y2 * s;
          dep[idx] = z2;
          vr[idx] = veBilinear(n00.rgb[0], n10.rgb[0], n01.rgb[0], n11.rgb[0], fu, fv);
          vg[idx] = veBilinear(n00.rgb[1], n10.rgb[1], n01.rgb[1], n11.rgb[1], fu, fv);
          vb[idx] = veBilinear(n00.rgb[2], n10.rgb[2], n01.rgb[2], n11.rgb[2], fu, fv);
          idx++;
        }
      }

      var faces = [];
      for (var cr = 0; cr < rows - 1; cr++) {
        for (var cc = 0; cc < cols - 1; cc++) {
          var h00 = nodes[cr][cc].h, h10 = nodes[cr][cc + 1].h;
          var h01 = nodes[cr + 1][cc].h, h11 = nodes[cr + 1][cc + 1].h;
          for (var i = 0; i < K; i++) {
            for (var j = 0; j < K; j++) {
              var a = (cr * K + i) * vC + (cc * K + j);
              var b = a + 1, c2 = a + vC + 1, d2 = a + vC;
              var uc = (j + 0.5) / K, vc = (i + 0.5) / K;
              // Analytic slope of the bilinear patch at the sub-quad center.
              var dhdu = (h10 - h00) * (1 - vc) + (h11 - h01) * vc;
              var dhdv = (h01 - h00) * (1 - uc) + (h11 - h10) * uc;
              var bright = veFaceLight(dhdu * heightScale, dhdv * heightScale,
                                       cosA, sinA, cosE, sinE);
              var fr = (vr[a] + vr[b] + vr[c2] + vr[d2]) * 0.25 * bright;
              var fg = (vg[a] + vg[b] + vg[c2] + vg[d2]) * 0.25 * bright;
              var fb = (vb[a] + vb[b] + vb[c2] + vb[d2]) * 0.25 * bright;
              faces.push({
                a: a, b: b, c: c2, d: d2,
                depth: (dep[a] + dep[b] + dep[c2] + dep[d2]) * 0.25,
                color: 'rgb(' + (fr | 0) + ',' + (fg | 0) + ',' + (fb | 0) + ')'
              });
            }
          }
        }
      }
      faces.sort(function (p, q) { return p.depth - q.depth; }); // far first

      // Zero plane for the change view: translucent reference, drawn first.
      var dataset = getDataset();
      if (dataset === 'change') {
        var zc = [proj(0, 0, 0), proj(cols - 1, 0, 0), proj(cols - 1, 0, rows - 1), proj(0, 0, rows - 1)];
        ctx.beginPath();
        zc.forEach(function (p, i) { if (i) ctx.lineTo(p.sx, p.sy); else ctx.moveTo(p.sx, p.sy); });
        ctx.closePath();
        ctx.fillStyle = 'rgba(120,140,170,0.10)';
        ctx.fill();
      }

      // Operating points: stride-sampled log samples as small dots just
      // above the surface. Drawn before the faces (after the zero plane)
      // so the surface occludes far-side points correctly. Each point is
      // interpolated onto the CURRENT dataset's surface and rotated with
      // the same projection the surface uses.
      if (getShowPoints()) {
        var opPts = getPoints() || [];
        if (opPts.length) {
          var lift = heightScale * 0.04;
          ctx.fillStyle = 'rgba(170,220,255,0.5)';
          for (var pi = 0; pi < opPts.length; pi++) {
            var pm = vePointModel(opPts[pi], m, data, heightScale);
            if (!pm) continue;
            var pr = veRotate(pm.x, pm.y + lift, pm.z, az, el);
            ctx.beginPath();
            ctx.arc(ox + pr.x1 * s, oy - pr.y2 * s, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      for (var fi = 0; fi < faces.length; fi++) {
        var f = faces[fi];
        ctx.beginPath();
        ctx.moveTo(sx[f.a], sy[f.a]);
        ctx.lineTo(sx[f.b], sy[f.b]);
        ctx.lineTo(sx[f.c], sy[f.c]);
        ctx.lineTo(sx[f.d], sy[f.d]);
        ctx.closePath();
        ctx.fillStyle = f.color;
        ctx.fill();
      }

      // Axis labels: RPM along z, MAP along x, ticks at min/mid/max.
      ctx.fillStyle = '#9fa9b8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      function axisLabel(x, z, text) {
        var p = proj(x, 0, z);
        ctx.fillText(text, p.sx, p.sy + 14);
      }
      var midC = (cols - 1) / 2, midR = (rows - 1) / 2;
      var rpmBp = data.rpmBp, mapBp = data.mapBp;
      if (mapBp.length >= 3) {
        axisLabel(0, rows - 1, String(mapBp[0]));
        axisLabel(midC, rows - 1, String(mapBp[Math.floor(mapBp.length / 2)]));
        axisLabel(cols - 1, rows - 1, String(mapBp[mapBp.length - 1]));
      }
      axisLabel(cols - 1 + 0.6, rows - 1, 'MAP kPa');
      if (rpmBp.length >= 3) {
        ctx.textAlign = 'right';
        axisLabel(cols - 1, 0, String(rpmBp[0]));
        axisLabel(cols - 1, midR, String(rpmBp[Math.floor(rpmBp.length / 2)]));
        axisLabel(cols - 1, rows - 1, String(rpmBp[rpmBp.length - 1]));
        ctx.textAlign = 'center';
      }
      axisLabel(cols - 1 + 0.6, 0, 'RPM');

      raf = requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      canvas.style.cursor = 'grab';
      lastInteract = Date.now();
    }
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      az += (e.clientX - lastX) * 0.008;
      el = clamp(el + (e.clientY - lastY) * 0.006, 0.2, 1.45);
      lastX = e.clientX; lastY = e.clientY;
      lastInteract = Date.now();
    });
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = clamp(zoom * Math.pow(1.0015, -e.deltaY), 0.5, 2.5);
      lastInteract = Date.now();
    }, { passive: false });

    raf = requestAnimationFrame(frame);
    return function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }

  // Exposed for callers and tests (same attach names as before)
  P66.veSurfaceModel = veSurfaceModel;
  P66.renderVeSurface = renderVeSurface;
  P66.setVePointsSource = setVePointsSource;
  P66.vePointsSample = vePointsSample;
  P66.vePointsInRange = vePointsInRange;
  P66.veAxisFrac = veAxisFrac;
  P66.vePointModel = vePointModel;
  P66._vePointsResolve = vePointsResolve;
  P66.VE_POINTS_MAX = VE_POINTS_MAX;
  P66._veRotate = veRotate;
  P66._veBilinear = veBilinear;
  P66._veFaceLight = veFaceLight;
})(typeof window !== 'undefined' ? window : global);
