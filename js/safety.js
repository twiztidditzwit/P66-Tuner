/* P66-Tuner binary safety guard
 * Decides whether an uploaded binary is safe to patch — before a single
 * byte is changed. This is the gate that protects strangers: it confirms
 * the file is genuinely a P66-family image using the layered fingerprints
 * in js/fingerprints.js (load it first).
 *
 * Layers (must mirror tools/make-fingerprints.js):
 *   1. FAMILY LATTICE — 261 sparse samples/cal (stride 251). The P66-family
 *      gate: >=99% ok-track, >=90% warn, <90% block. Sparse sampling cannot
 *      NAME a calibration (the three '95 cals differ by only 2-9 bytes of
 *      65536), so it is used only as a family check.
 *   2. DISCRIMINANT — 347 addresses where known stock images differ from
 *      each other. Ranks calibrations to report a closest match + confidence,
 *      or top candidates when the ranking is ambiguous. Never presented as
 *      proven identity.
 *   3. STABLE-DENSE — ~1070 denser samples over regions identical across all
 *      known images. Catches small modifications (tunes) the sparse lattice
 *      misses; any deviation keeps the verdict at warn, never ok.
 *   4. LANDMARKS + TABLE ANCHORS — fixed firmware byte windows identical
 *      across all known images, and known cell values in catalog tables
 *      (Main VE, Main Spark Advance, Idle VE). Catches wrong-PCM images and
 *      XDF-geometry mismatches.
 *
 *   P66.checkBinary(binBytes)
 *     -> { level: 'ok' | 'warn' | 'block',
 *          calId, matchedCal, matchPct, candidates, confidence,
 *          detail: { familyPct, densePct, landmarkPct, anchorPct },
 *          messages: [] }
 *
 *   ok    verified P66-family image matching known stock on every layer —
 *         patch freely. "Closest calibration" is a best-match estimate.
 *   warn  P66-shaped but modified, unrecognized, or ambiguous — patch, but
 *         tell the user plainly how it differs and to review the summary
 *   block do not patch: wrong size, empty image, or does not resemble
 *         a P66 image
 *
 * Works in browser and node.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  function readCalId(bin) {
    function field(at) {
      var digits = '';
      for (var i = 0; i < 4; i++) {
        var b = bin[at + i];
        var hi = (b >> 4) & 0xF, lo = b & 0xF;
        if (hi > 9 || lo > 9) return null; // not packed BCD
        digits += hi.toString() + lo.toString();
      }
      return digits;
    }
    var a = field(0x0000), b = field(0x8000);
    return { id0000: a, id8000: b, matched: !!(a && b && a === b), calId: (a && a === b) ? a : null };
  }

  function hexToBytes(hex) {
    var out = [];
    for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function familyMatch(bin, fp, cal) {
    // Must mirror tools/make-fingerprints.js exactly: stride offsets,
    // skipping the calibration-ID fields, samples indexed sequentially.
    var ref = hexToBytes(cal.hex);
    var total = 0, hits = 0, s = 0;
    for (var off = 0; off < fp.imageSize && s < ref.length; off += fp.stride) {
      if (fp.skip.some(function (r) { return off >= r[0] && off < r[1]; })) continue;
      if (off >= bin.length) break;
      total++;
      if (bin[off] === ref[s]) hits++;
      s++;
    }
    return total ? hits / total : 0;
  }

  function discriminantScores(bin) {
    // Fraction of discriminant addresses matching each known cal.
    var d = P66.DISCRIMINANT;
    if (!d || !d.offsets || !d.cals || !d.cals.length) return null;
    return d.cals.map(function (cal) {
      var ref = hexToBytes(cal.hex);
      var total = 0, hits = 0;
      for (var i = 0; i < d.offsets.length && i < ref.length; i++) {
        var off = d.offsets[i];
        if (off >= bin.length) break;
        total++;
        if (bin[off] === ref[i]) hits++;
      }
      return { calId: cal.calId, pct: total ? hits / total : 0 };
    }).sort(function (a, b) { return b.pct - a.pct; });
  }

  function denseScore(bin) {
    // Fraction of dense stable-region samples matching the consensus.
    var sd = P66.STABLE_DENSE;
    if (!sd || !sd.offsets) return null;
    var ref = hexToBytes(sd.hex);
    var total = 0, hits = 0;
    for (var i = 0; i < sd.offsets.length && i < ref.length; i++) {
      var off = sd.offsets[i];
      if (off >= bin.length) break;
      total++;
      if (bin[off] === ref[i]) hits++;
    }
    return total ? { pct: hits / total, hits: hits, total: total } : null;
  }

  function landmarkScore(bin) {
    // Fraction of firmware landmark windows fully matching.
    var lm = P66.LANDMARKS;
    if (!lm || !lm.windows || !lm.windows.length) return null;
    var ok = 0;
    lm.windows.forEach(function (w) {
      var ref = hexToBytes(w.hex);
      var match = true;
      for (var i = 0; i < ref.length; i++) {
        if (w.addr + i >= bin.length || bin[w.addr + i] !== ref[i]) { match = false; break; }
      }
      if (match) ok++;
    });
    return { pct: ok / lm.windows.length, hits: ok, total: lm.windows.length };
  }

  function anchorScore(bin) {
    // Fraction of catalog table anchor cells matching (big-endian 16-bit).
    var ta = P66.TABLE_ANCHORS;
    if (!ta || !ta.tables || !ta.tables.length) return null;
    var ok = 0, total = 0;
    ta.tables.forEach(function (t) {
      t.anchors.forEach(function (a) {
        total++;
        var idx = a.r * t.cols + a.c;
        var v = t.bits === 16
          ? (bin[t.address + idx * 2] << 8) | bin[t.address + idx * 2 + 1]
          : bin[t.address + idx];
        if (v === a.v) ok++;
      });
    });
    return total ? { pct: ok / total, hits: ok, total: total } : null;
  }

  function pct1(x) { return Math.round(x * 1000) / 10; }

  /**
   * Safety gate for an uploaded binary. Returns a level plus human-readable
   * messages suitable for display. Calibration "identity" is always reported
   * as a closest match with confidence — never as proven fact.
   */
  function checkBinary(binBytes) {
    var messages = [];
    var n = binBytes ? binBytes.length : 0;
    var fp = P66.FINGERPRINT;
    var cals = P66.KNOWN_CALS || [];

    function blocked(msg) {
      return { level: 'block', calId: null, matchedCal: null, matchPct: 0,
               candidates: [], confidence: null, detail: {}, messages: [msg] };
    }

    if (!binBytes || !n) return blocked('No binary loaded.');
    if (!fp || !cals.length) {
      return blocked('Reference fingerprints not loaded (js/fingerprints.js) — cannot verify this binary.');
    }
    if (n !== fp.imageSize) {
      return blocked('This file is ' + n + ' bytes — a P66 binary must be exactly ' + fp.imageSize +
        ' bytes (64KB). It may be truncated, the wrong PCM, or not a binary at all.');
    }

    // Empty / erased image check.
    var ff = 0, zero = 0;
    for (var i = 0; i < n; i += 997) { // sparse sample is enough
      if (binBytes[i] === 0xFF) ff++;
      if (binBytes[i] === 0x00) zero++;
    }
    var samples = Math.ceil(n / 997);
    if (ff === samples || zero === samples) {
      return blocked('This file looks empty (all 0xFF / all 0x00) — probably a failed read. Re-read the PCM and try again.');
    }

    // Layer 1: P66-family gate (sparse lattice, best match over known cals).
    var bestFam = null, bestFamPct = 0;
    cals.forEach(function (cal) {
      var pct = familyMatch(binBytes, fp, cal);
      if (pct > bestFamPct) { bestFamPct = pct; bestFam = cal; }
    });
    var familyPct = pct1(bestFamPct);

    // Layer 2: discriminant ranking (closest match, never identity).
    var ranked = discriminantScores(binBytes);
    var candidates = (ranked || []).map(function (r) {
      return { calId: r.calId, pct: pct1(r.pct) };
    });
    var top = candidates[0] || null;
    var second = candidates[1] || null;
    var confidence = null;
    if (ranked && top) {
      var gap = top.pct - (second ? second.pct : 0);
      if (top.pct === 100 && gap >= 0.5) confidence = 'high';
      else if (top.pct >= 99 && gap >= 0.25) confidence = 'medium';
      else confidence = 'ambiguous';
    }

    // Layers 3+4: stock-conformity sub-checks.
    var dense = denseScore(binBytes);
    var landmark = landmarkScore(binBytes);
    var anchor = anchorScore(binBytes);

    var cal = readCalId(binBytes);
    var calNote = cal.calId
      ? 'Calibration ID fields read as ' + cal.calId + '.'
      : 'Calibration ID fields are not readable packed-BCD (custom or overwritten ID stamp) — identifying by image fingerprint instead.';

    function closestLine() {
      if (!top) return 'No calibration ranking available (discriminant data missing).';
      var line = 'Closest known stock calibration: ' + top.calId +
        ' (discriminant match ' + top.pct + '%' +
        (confidence && confidence !== 'ambiguous' ? ', confidence ' + confidence : '') + ').';
      if (confidence === 'ambiguous' && candidates.length > 1) {
        var near = candidates.filter(function (c) { return top.pct - c.pct < 1.0; }).slice(0, 3);
        line += ' Cannot name a single closest calibration — top candidates: ' +
          near.map(function (c) { return c.calId + ' (' + c.pct + '%)'; }).join(', ') + '.';
      }
      line += ' This is a best-match estimate: the three 1995 calibrations differ by only a handful of bytes, so exact identity cannot be proven from the image alone.';
      return line;
    }

    var base = {
      calId: cal.calId || (top ? top.calId : null),
      matchedCal: top ? top.calId : (bestFam ? bestFam.calId : null),
      matchPct: familyPct,
      candidates: candidates,
      confidence: confidence,
      detail: {
        familyPct: familyPct,
        densePct: dense ? pct1(dense.pct) : null,
        landmarkPct: landmark ? pct1(landmark.pct) : null,
        anchorPct: anchor ? pct1(anchor.pct) : null
      },
      messages: messages
    };

    if (bestFamPct < 0.90) {
      messages.push('This file does not look like a P66 image (best family match ' + familyPct +
        '% against known stock images). It may be the wrong PCM, a corrupted read, or not a P66 binary at all.' +
        ' Patching is blocked — re-read the PCM and make sure it is a 1994–1995 3.4L P66 (service 16184737).');
      base.level = 'block';
      base.candidates = [];
      base.confidence = null;
      return base;
    }

    if (bestFamPct < 0.99) {
      messages.push('P66-family image, but it differs from known stock images (' + familyPct +
        '% family match) — it may have been tuned before, or the read may have glitches. ' + closestLine());
      messages.push('Patches are computed against YOUR binary\'s current values, which is correct — but review the change summary carefully before flashing. ' + calNote);
      base.level = 'warn';
      return base;
    }

    // Family >= 99%: stock-conformity decides ok vs warn.
    var devs = [];
    if (dense && dense.pct < 1) devs.push((dense.total - dense.hits) + ' of ' + dense.total + ' dense-stable samples differ from known stock');
    if (landmark && landmark.pct < 1) devs.push((landmark.total - landmark.hits) + ' of ' + landmark.total + ' firmware landmarks differ');
    if (anchor && anchor.pct < 1) devs.push((anchor.total - anchor.hits) + ' of ' + anchor.total + ' table anchors differ');
    if (devs.length) {
      messages.push('P66-family image (' + familyPct + '% family match), but ' + devs.join('; ') +
        ' — small modifications, a tuned file, or a stock variant we have not fingerprinted. Treating it as modified. ' + closestLine());
      messages.push('Patches are computed against YOUR binary\'s current values, which is correct — but review the change summary carefully before flashing. ' + calNote);
      base.level = 'warn';
      return base;
    }

    messages.push('P66-family image confirmed: ' + familyPct + '% family match against known stock images, with all ' +
      (dense ? dense.total : '?') + ' dense-stable samples, ' +
      (landmark ? landmark.total : '?') + ' firmware landmarks, and ' +
      (anchor ? anchor.total : '?') + ' table anchors matching known stock. ' + closestLine());
    messages.push(calNote);
    base.level = 'ok';
    return base;
  }

  P66.checkBinary = checkBinary;
  P66.readCalId = readCalId;
})(typeof window !== 'undefined' ? window : global);
