/* P66-Tuner binary safety guard
 * Decides whether an uploaded binary is safe to patch — before a single
 * byte is changed. This is the gate that protects strangers: it confirms
 * the file is genuinely a 64KB P66 image and resembles a known stock
 * calibration, using the fingerprints in js/fingerprints.js (load it first).
 *
 *   P66.checkBinary(binBytes)
 *     -> { level: 'ok' | 'warn' | 'block',
 *          calId, matchedCal, matchPct, messages: [] }
 *
 *   ok    verified stock (or near-stock) P66 calibration — patch freely
 *   warn  P66-shaped but modified/unrecognized — patch, but tell the user
 *         plainly that it differs from stock and to review the summary
 *   block do not patch: wrong size, empty image, or does not resemble
 *         any known P66 calibration
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

  function fingerprintMatch(bin, fp, cal) {
    // Must mirror tools/make-fingerprints.js exactly: stride offsets,
    // skipping the calibration-ID fields, samples indexed sequentially.
    var ref = [];
    for (var i = 0; i < cal.hex.length; i += 2) ref.push(parseInt(cal.hex.substr(i, 2), 16));
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

  /**
   * Safety gate for an uploaded binary. Returns a level plus human-readable
   * messages suitable for display.
   */
  function checkBinary(binBytes) {
    var messages = [];
    var n = binBytes ? binBytes.length : 0;
    var fp = P66.FINGERPRINT;
    var cals = P66.KNOWN_CALS || [];

    if (!binBytes || !n) {
      return { level: 'block', calId: null, matchedCal: null, matchPct: 0, messages: ['No binary loaded.'] };
    }
    if (!fp || !cals.length) {
      return { level: 'block', calId: null, matchedCal: null, matchPct: 0, messages: ['Reference fingerprints not loaded (js/fingerprints.js) — cannot verify this binary.'] };
    }
    if (n !== fp.imageSize) {
      return { level: 'block', calId: null, matchedCal: null, matchPct: 0, messages: ['This file is ' + n + ' bytes — a P66 binary must be exactly ' + fp.imageSize + ' bytes (64KB). It may be truncated, the wrong PCM, or not a binary at all.'] };
    }

    // Empty / erased image check.
    var ff = 0, zero = 0;
    for (var i = 0; i < n; i += 997) { // sparse sample is enough
      if (binBytes[i] === 0xFF) ff++;
      if (binBytes[i] === 0x00) zero++;
    }
    var samples = Math.ceil(n / 997);
    if (ff === samples || zero === samples) {
      return { level: 'block', calId: null, matchedCal: null, matchPct: 0, messages: ['This file looks empty (all 0xFF / all 0x00) — probably a failed read. Re-read the PCM and try again.'] };
    }

    // Fingerprint against known stock calibrations.
    var best = null, bestPct = 0;
    cals.forEach(function (cal) {
      var pct = fingerprintMatch(binBytes, fp, cal);
      if (pct > bestPct) { bestPct = pct; best = cal; }
    });
    var matchPct = Math.round(bestPct * 1000) / 10;

    var cal = readCalId(binBytes);
    var calNote = cal.calId
      ? 'Calibration ID ' + cal.calId + '.'
      : 'Calibration ID fields are not readable packed-BCD (custom or overwritten ID stamp) — identifying by image fingerprint instead.';

    if (bestPct >= 0.99) {
      messages.push('Verified: this binary matches stock P66 calibration ' + best.calId + ' (' + matchPct + '% fingerprint match). ' + calNote);
      return { level: 'ok', calId: cal.calId || best.calId, matchedCal: best.calId, matchPct: matchPct, messages: messages };
    }
    if (bestPct >= 0.90) {
      messages.push('This binary resembles P66 calibration ' + best.calId + ' (' + matchPct + '% match) but differs from stock — it may have been tuned before. Patches are computed against YOUR binary\'s current values, which is correct, but review the change summary carefully before flashing. ' + calNote);
      return { level: 'warn', calId: cal.calId || best.calId, matchedCal: best.calId, matchPct: matchPct, messages: messages };
    }
    messages.push('This file does not resemble any known P66 calibration (best match ' + matchPct + '% against ' + (best ? best.calId : 'none') + '). It may be the wrong PCM, a corrupted read, or not a P66 binary at all. Patching is blocked — re-read the PCM and make sure it is a 1994–1995 3.4L P66 (service 16184737).');
    return { level: 'block', calId: cal.calId, matchedCal: best ? best.calId : null, matchPct: matchPct, messages: messages };
  }

  P66.checkBinary = checkBinary;
  P66.readCalId = readCalId;
})(typeof window !== 'undefined' ? window : global);
