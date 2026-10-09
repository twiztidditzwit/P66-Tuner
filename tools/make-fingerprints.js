#!/usr/bin/env node
/* make-fingerprints — build the known-stock calibration fingerprint module.
 *
 *   node tools/make-fingerprints.js
 *
 * Samples deterministic byte offsets (prime stride, skipping the two
 * calibration-ID fields) from each known-stock P66 binary and writes
 * js/fingerprints.js. The runtime safety check compares an uploaded
 * binary against these fingerprints to confirm it is genuinely a P66
 * image before any patch is generated — no full reference binaries
 * ship with the app.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var STRIDE = 251; // prime: spreads samples across the whole image
var IMAGE_SIZE = 65536;
var SKIP = [[0x0000, 0x0004], [0x8000, 0x8004]]; // calibration ID fields

function skipped(off) {
  return SKIP.some(function (r) { return off >= r[0] && off < r[1]; });
}

function calIdFromBin(bin) {
  function field(at) {
    var digits = '';
    for (var i = 0; i < 4; i++) {
      var b = bin[at + i];
      var hi = (b >> 4) & 0xF, lo = b & 0xF;
      if (hi > 9 || lo > 9) return null;
      digits += hi.toString() + lo.toString();
    }
    return digits;
  }
  var a = field(0x0000), b = field(0x8000);
  return a && a === b ? a : null;
}

var files = {
  '16212614': 'defs/bins/bcc/cal-16212614-95-f-auto-fed.bin',
  '16212294': 'defs/bins/bcc/cal-16212294-95-f-auto-fed.bin',
  '16212604': 'defs/bins/bcc/cal-16212604-95-f-auto-fed.bin',
  '16203281': 'defs/bins/bcc/cal-16203281-94-f-auto-fed.bin',
  '16203271': 'defs/bins/bcc/cal-16203271-94-f-auto-cal.bin'
};

var cals = Object.keys(files).map(function (calId) {
  var bin = fs.readFileSync(path.join(ROOT, files[calId]));
  if (bin.length !== IMAGE_SIZE) throw new Error('unexpected size for ' + calId);
  var embedded = calIdFromBin(bin);
  if (embedded !== calId) throw new Error('cal ID mismatch in ' + calId + ': got ' + embedded);
  var bytes = [];
  for (var off = 0; off < IMAGE_SIZE; off += STRIDE) {
    if (skipped(off)) continue;
    bytes.push(bin[off]);
  }
  return { calId: calId, samples: bytes.length, stride: STRIDE, hex: Buffer.from(bytes).toString('hex') };
});

var lines = [
  '/* P66 known-stock calibration fingerprints \u2014 GENERATED, do not edit.',
  ' * Built by tools/make-fingerprints.js on ' + new Date().toISOString().slice(0, 10),
  ' * from the five F-body P66 stock binaries (Robert Saar archive).',
  ' * ' + cals[0].samples + ' deterministic byte samples per calibration (prime stride ' + STRIDE + ', calibration-ID fields excluded).',
  ' * Used by js/safety.js to confirm an uploaded binary is genuinely a P66 image before patching.',
  ' */',
  '(function (global) {',
  '  "use strict";',
  '  var P66 = (global.P66 = global.P66 || {});',
  '  P66.KNOWN_CALS = ' + JSON.stringify(cals) + ';',
  '  P66.FINGERPRINT = { stride: ' + STRIDE + ', imageSize: ' + IMAGE_SIZE + ', skip: ' + JSON.stringify(SKIP) + ' };',
  '})(typeof window !== "undefined" ? window : global);',
  ''
];
var out = lines.join('\n');

fs.writeFileSync(path.join(ROOT, 'js', 'fingerprints.js'), out);
console.log('wrote js/fingerprints.js: ' + cals.length + ' calibrations, ' + cals[0].samples + ' samples each');
