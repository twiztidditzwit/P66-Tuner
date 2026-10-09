#!/usr/bin/env node
/* make-fingerprints — build the known-stock calibration fingerprint module.
 *
 *   node tools/make-fingerprints.js
 *
 * Builds js/fingerprints.js from the five F-body P66 stock binaries (Robert
 * Saar archive), Dale's stock read (stability reference), and the XDF slim
 * catalog (table geometry for anchors). The runtime safety gate
 * (js/safety.js) layers four checks over an uploaded binary:
 *
 *   1. FAMILY LATTICE (P66.KNOWN_CALS) — 261 deterministic byte samples per
 *      calibration, prime stride 251, calibration-ID fields excluded. This is
 *      the P66-family gate: >=99% ok-track, >=90% warn, <90% block. Sparse
 *      sampling alone cannot NAME a calibration (the three '95 cals differ
 *      by only 2-9 bytes of 65536), so it is used only as a family check.
 *   2. DISCRIMINANT (P66.DISCRIMINANT) — every address where any known stock
 *      image differs from any other (347 bytes, cal-ID fields excluded),
 *      with each calibration's byte values there. Ranks calibrations to
 *      report a closest match + confidence, or top candidates when ambiguous.
 *   3. STABLE-DENSE (P66.STABLE_DENSE) — a denser lattice (stride 61, ~1068
 *      samples) over regions identical across ALL known images, versus the
 *      consensus bytes. Catches small modifications (tunes) the sparse
 *      family lattice can miss; any deviation keeps the verdict at warn.
 *   4. LANDMARKS + TABLE ANCHORS — fixed firmware byte windows identical
 *      across all known images (P66-family firmware landmarks), and known
 *      cell values in engine tables whose address/geometry come from the
 *      XDF catalog (Main VE, Main Spark Advance, Idle VE). Catches wrong-
 *      PCM images and XDF-geometry mismatches.
 *
 * No full reference binaries ship with the app — only these derived values.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var STRIDE = 251; // prime: spreads family samples across the whole image
var DENSE_STRIDE = 61; // prime: denser lattice over stable regions
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

function hexOf(bin, off, len) {
  var s = '';
  for (var i = 0; i < len; i++) s += (bin[off + i] < 16 ? '0' : '') + bin[off + i].toString(16);
  return s;
}

// ---- load binaries -------------------------------------------------------
var files = {
  '16212614': 'defs/bins/bcc/cal-16212614-95-f-auto-fed.bin',
  '16212294': 'defs/bins/bcc/cal-16212294-95-f-auto-fed.bin',
  '16212604': 'defs/bins/bcc/cal-16212604-95-f-auto-fed.bin',
  '16203281': 'defs/bins/bcc/cal-16203281-94-f-auto-fed.bin',
  '16203271': 'defs/bins/bcc/cal-16203271-94-f-auto-cal.bin'
};

var calIds = Object.keys(files);
var cals = calIds.map(function (calId) {
  var bin = fs.readFileSync(path.join(ROOT, files[calId]));
  if (bin.length !== IMAGE_SIZE) throw new Error('unexpected size for ' + calId);
  var embedded = calIdFromBin(bin);
  if (embedded !== calId) throw new Error('cal ID mismatch in ' + calId + ': got ' + embedded);
  return { calId: calId, bin: bin };
});

// Dale's stock read: must be 64KB; used as an extra stability reference
// (it is stock 16212614 with a custom cal-ID stamp).
var dalesBin = fs.readFileSync(path.join(ROOT, 'defs/bins/stock-1995-camaro-l32.bin'));
if (dalesBin.length !== IMAGE_SIZE) throw new Error('unexpected size for Dale stock bin');
var allBins = cals.map(function (c) { return c.bin; }).concat([dalesBin]);

function stableAt(off) {
  var v = allBins[0][off];
  for (var k = 1; k < allBins.length; k++) if (allBins[k][off] !== v) return false;
  return true;
}

// ---- 1. family lattice (unchanged format) ---------------------------------
var family = cals.map(function (c) {
  var bytes = [];
  for (var off = 0; off < IMAGE_SIZE; off += STRIDE) {
    if (skipped(off)) continue;
    bytes.push(c.bin[off]);
  }
  return { calId: c.calId, samples: bytes.length, stride: STRIDE, hex: Buffer.from(bytes).toString('hex') };
});

// ---- 2. discriminant: every address separating known stock images ---------
var discOffsets = [];
for (var off = 0; off < IMAGE_SIZE; off++) {
  if (skipped(off)) continue;
  if (!stableAt(off)) discOffsets.push(off);
}
var discriminant = {
  skip: SKIP,
  offsets: discOffsets,
  cals: cals.map(function (c) {
    return {
      calId: c.calId,
      hex: discOffsets.map(function (o) {
        return (c.bin[o] < 16 ? '0' : '') + c.bin[o].toString(16);
      }).join('')
    };
  })
};

// ---- 3. dense stable lattice: consensus over all-known-identical regions --
var denseOffsets = [];
for (var off = 0; off < IMAGE_SIZE; off += DENSE_STRIDE) {
  if (skipped(off)) continue;
  if (stableAt(off)) denseOffsets.push(off);
}
var denseHex = denseOffsets.map(function (o) {
  return (allBins[0][o] < 16 ? '0' : '') + allBins[0][o].toString(16);
}).join('');

// ---- 4a. firmware landmarks: fixed windows, identical in all known images -
var LANDMARK_WINDOWS = [0x0004, 0x8004, 0x4000, 0xC000, 0xE000, 0xF000];
var LANDMARK_LEN = 16;
var landmarks = LANDMARK_WINDOWS.map(function (addr) {
  if (!stableAt(addr)) throw new Error('landmark base not stable at 0x' + addr.toString(16));
  for (var i = 1; i < LANDMARK_LEN; i++) {
    if (!stableAt(addr + i)) throw new Error('landmark window not stable at 0x' + (addr + i).toString(16));
  }
  return { addr: addr, hex: hexOf(allBins[0], addr, LANDMARK_LEN) };
});

// ---- 4b. table anchors: known cell values from the XDF catalog -----------
var catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'defs', 'xdf', 'p66-v6-34l.catalog.json'), 'utf8'));
var ANCHOR_TABLES = ['Main VE', 'Main Spark Advance', 'Idle VE'];

function readCell(bin, address, bits, r, c, cols) {
  var idx = r * cols + c;
  if (bits === 16) return (bin[address + idx * 2] << 8) | bin[address + idx * 2 + 1]; // big-endian
  return bin[address + idx];
}

var anchorTables = ANCHOR_TABLES.map(function (title) {
  var t = catalog.tables.filter(function (x) { return x.title === title; })[0];
  if (!t) throw new Error('table not in catalog: ' + title);
  var address = parseInt(t.address, 16);
  var bits = parseInt(t.elementSizeBits, 10);
  var rows = t.rows, cols = t.cols;
  var midR = Math.floor(rows / 2), midC = Math.floor(cols / 2);
  var cells = [[0, 0], [0, cols - 1], [rows - 1, 0], [rows - 1, cols - 1],
               [midR, midC], [0, midC], [midR, 0], [rows - 1, midC]];
  var anchors = cells.map(function (cell) {
    var v = readCell(allBins[0], address, bits, cell[0], cell[1], cols);
    for (var k = 1; k < allBins.length; k++) {
      if (readCell(allBins[k], address, bits, cell[0], cell[1], cols) !== v) {
        throw new Error('anchor cell not stable: ' + title + ' [' + cell[0] + ',' + cell[1] + ']');
      }
    }
    return { r: cell[0], c: cell[1], v: v };
  });
  return { title: title, address: address, rows: rows, cols: cols, bits: bits, anchors: anchors };
});

// ---- emit ----------------------------------------------------------------
var lines = [
  '/* P66 known-stock calibration fingerprints — GENERATED, do not edit.',
  ' * Built by tools/make-fingerprints.js on ' + new Date().toISOString().slice(0, 10),
  ' * from the five F-body P66 stock binaries (Robert Saar archive), Dale\'s',
  ' * stock read (stability reference), and the XDF slim catalog (table anchors).',
  ' *',
  ' * Layers (see js/safety.js):',
  ' *  - KNOWN_CALS: ' + family[0].samples + ' sparse family samples/cal (stride ' + STRIDE + ', cal-ID excluded)',
  ' *  - DISCRIMINANT: ' + discOffsets.length + ' addresses separating known stock cals (cal ranking only)',
  ' *  - STABLE_DENSE: ' + denseOffsets.length + ' dense samples (stride ' + DENSE_STRIDE + ') over all-known-identical regions',
  ' *  - LANDMARKS: ' + landmarks.length + ' firmware windows identical across all known images',
  ' *  - TABLE_ANCHORS: known cell values in ' + anchorTables.length + ' catalog tables (geometry sanity)',
  ' * Used by js/safety.js to confirm an uploaded binary is genuinely a P66 image before patching.',
  ' */',
  '(function (global) {',
  '  "use strict";',
  '  var P66 = (global.P66 = global.P66 || {});',
  '  P66.KNOWN_CALS = ' + JSON.stringify(family) + ';',
  '  P66.FINGERPRINT = { stride: ' + STRIDE + ', imageSize: ' + IMAGE_SIZE + ', skip: ' + JSON.stringify(SKIP) + ' };',
  '  P66.DISCRIMINANT = ' + JSON.stringify(discriminant) + ';',
  '  P66.STABLE_DENSE = ' + JSON.stringify({
    stride: DENSE_STRIDE, imageSize: IMAGE_SIZE, skip: SKIP,
    offsets: denseOffsets, hex: denseHex
  }) + ';',
  '  P66.LANDMARKS = ' + JSON.stringify({ windows: landmarks }) + ';',
  '  P66.TABLE_ANCHORS = ' + JSON.stringify({ tables: anchorTables }) + ';',
  '})(typeof window !== "undefined" ? window : global);',
  ''
];

var out = lines.join('\n');
fs.writeFileSync(path.join(ROOT, 'js', 'fingerprints.js'), out);
console.log('wrote js/fingerprints.js:');
console.log('  family: ' + family.length + ' cals x ' + family[0].samples + ' samples (stride ' + STRIDE + ')');
console.log('  discriminant: ' + discOffsets.length + ' addresses');
console.log('  stable-dense: ' + denseOffsets.length + ' samples (stride ' + DENSE_STRIDE + ')');
console.log('  landmarks: ' + landmarks.length + ' windows x ' + LANDMARK_LEN + ' bytes');
console.log('  table anchors: ' + anchorTables.reduce(function (n, t) { return n + t.anchors.length; }, 0) +
  ' cells in ' + anchorTables.length + ' tables');
