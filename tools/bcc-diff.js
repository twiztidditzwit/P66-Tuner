#!/usr/bin/env node
/*
 * bcc-diff — GM BCC calibration diffing harness.
 *
 * Compares 2+ binary images for the same PCM service number (e.g. the six
 * BCCs for 16184737: BHLD, BJPM, BJRM, BKWU, BKWW, BNFM) and maps every
 * differing region. Regions that differ between calibrations of identical
 * hardware are calibration data — the fastest route to table addresses
 * for XDF development.
 *
 * Usage:
 *   node tools/bcc-diff.js --ref bnfm.bin --cmp bjpm.bin bhld.bin [--json out.json] [--min-region 4]
 *   node tools/bcc-diff.js --single bnfm.bin   # entropy reconnaissance on one image
 *
 * A region's byte values are calibration candidates when they differ across
 * BCCs; identical regions are shared code or common data.
 */
'use strict';

var fs = require('fs');
var path = require('path');

function usage() {
  console.log('Usage:');
  console.log('  node tools/bcc-diff.js --ref <bin> --cmp <bin...> [--json out.json] [--min-region N]');
  console.log('  node tools/bcc-diff.js --single <bin> [--json out.json]');
  process.exit(1);
}

function parseArgs(argv) {
  var args = { ref: null, cmp: [], single: null, json: null, minRegion: 4 };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--ref') args.ref = argv[++i];
    else if (a === '--cmp') { while (argv[i + 1] && argv[i + 1][0] !== '-') args.cmp.push(argv[++i]); }
    else if (a === '--single') args.single = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--min-region') args.minRegion = parseInt(argv[++i], 10) || 4;
    else usage();
  }
  return args;
}

function loadBin(p) {
  if (!fs.existsSync(p)) { console.error('not found: ' + p); process.exit(1); }
  return { name: path.basename(p), path: p, data: fs.readFileSync(p) };
}

function shannonEntropy(buf, start, end) {
  var counts = new Array(256).fill(0);
  var n = 0;
  for (var i = start; i < end; i++) { counts[buf[i]]++; n++; }
  if (!n) return 0;
  var h = 0;
  for (var b = 0; b < 256; b++) {
    if (!counts[b]) continue;
    var p = counts[b] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function hexPreview(buf, start, len) {
  len = Math.min(len, 16, buf.length - start);
  var out = [];
  for (var i = 0; i < len; i++) {
    out.push(buf[start + i].toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}

function fmtOffset(n) { return '0x' + n.toString(16).toUpperCase().padStart(6, '0'); }

// Heuristic label for a differing region.
function classifyRegion(size, entropies) {
  var avgE = entropies.reduce(function (a, e) { return a + e; }, 0) / entropies.length;
  var tableSizes = [16, 24, 32, 48, 64, 96, 128, 144, 192, 256, 288, 384, 512];
  if (tableSizes.indexOf(size) !== -1) return 'table-candidate (common table size)';
  if (size >= 16 && size % 16 === 0) return 'table-candidate (16-byte aligned block)';
  if (size <= 8) return avgE > 4 ? 'likely code or pointer' : 'likely scalar/flag';
  if (size < 64) return 'small calibration block or code patch';
  return 'large block — structured data or code region';
}

function diffBinaries(bins, minRegion) {
  var ref = bins[0];
  var size = ref.data.length;
  bins.forEach(function (b) {
    if (b.data.length !== size) {
      console.error('size mismatch: ' + ref.name + ' (' + size + ') vs ' + b.name + ' (' + b.data.length + ')');
      process.exit(1);
    }
  });

  // Find differing offsets.
  var diffOffsets = [];
  for (var i = 0; i < size; i++) {
    var v0 = ref.data[i];
    for (var k = 1; k < bins.length; k++) {
      if (bins[k].data[i] !== v0) { diffOffsets.push(i); break; }
    }
  }

  // Group into contiguous regions.
  var regions = [];
  var start = null, prev = null;
  diffOffsets.forEach(function (off) {
    if (start === null) { start = off; prev = off; return; }
    if (off === prev + 1) { prev = off; return; }
    regions.push({ start: start, end: prev });
    start = off; prev = off;
  });
  if (start !== null) regions.push({ start: start, end: prev });

  // Filter tiny regions (likely noise/checksum-adjacent) and enrich.
  return regions
    .filter(function (r) { return (r.end - r.start + 1) >= minRegion; })
    .map(function (r) {
      var len = r.end - r.start + 1;
      var differs = [];
      for (var k = 1; k < bins.length; k++) {
        var same = true;
        for (var i = r.start; i <= r.end; i++) {
          if (bins[k].data[i] !== ref.data[i]) { same = false; break; }
        }
        if (!same) differs.push(bins[k].name);
      }
      var entropies = bins.map(function (b) {
        return Math.round(shannonEntropy(b.data, r.start, r.end + 1) * 100) / 100;
      });
      return {
        start: r.start, end: r.end, size: len,
        startHex: fmtOffset(r.start), endHex: fmtOffset(r.end),
        differsIn: differs,
        entropy: entropies,
        classification: classifyRegion(len, entropies),
        preview: bins.map(function (b) { return b.name + ': ' + hexPreview(b.data, r.start, 16); })
      };
    });
}

function entropyMapSingle(bin, windowSize) {
  windowSize = windowSize || 256;
  var out = [];
  for (var off = 0; off < bin.data.length; off += windowSize) {
    var end = Math.min(off + windowSize, bin.data.length);
    out.push({
      startHex: fmtOffset(off),
      entropy: Math.round(shannonEntropy(bin.data, off, end) * 100) / 100,
      // rough guess: very low entropy = padding/empty (0xFF), mid = tables, high = code
      guess: null
    });
  }
  out.forEach(function (w) {
    w.guess = w.entropy < 1 ? 'padding/empty' : (w.entropy < 5 ? 'structured data?' : 'code?');
  });
  return out;
}

function main() {
  var args = parseArgs(process.argv);

  if (args.single) {
    var bin = loadBin(args.single);
    console.log(bin.name + ': ' + bin.data.length + ' bytes');
    var map = entropyMapSingle(bin);
    // Print only interesting transitions to keep output readable.
    var lastGuess = null;
    map.forEach(function (w) {
      if (w.guess !== lastGuess) {
        console.log('  ' + w.startHex + '  entropy ' + w.entropy.toFixed(2) + '  -> ' + w.guess);
        lastGuess = w.guess;
      }
    });
    if (args.json) fs.writeFileSync(args.json, JSON.stringify({ file: bin.name, size: bin.data.length, windows: map }, null, 1));
    return;
  }

  if (!args.ref || !args.cmp.length) usage();
  var bins = [loadBin(args.ref)].concat(args.cmp.map(loadBin));
  console.log('reference: ' + bins[0].name + ' (' + bins[0].data.length + ' bytes)');
  console.log('compared : ' + bins.slice(1).map(function (b) { return b.name; }).join(', '));

  var regions = diffBinaries(bins, args.minRegion);
  var totalDiffBytes = regions.reduce(function (a, r) { return a + r.size; }, 0);
  console.log('differing regions (>= ' + args.minRegion + ' bytes): ' + regions.length +
    ', total ' + totalDiffBytes + ' bytes (' +
    (100 * totalDiffBytes / bins[0].data.length).toFixed(2) + '% of image)');
  console.log('');
  regions.forEach(function (r) {
    console.log(r.startHex + ' - ' + r.endHex + '  (' + r.size + ' bytes)  [' + r.classification + ']');
    console.log('  differs in: ' + (r.differsIn.length ? r.differsIn.join(', ') : '(none — below min-region?)'));
    r.preview.forEach(function (p) { console.log('  ' + p); });
    console.log('');
  });

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      reference: bins[0].name,
      compared: bins.slice(1).map(function (b) { return b.name; }),
      imageSize: bins[0].data.length,
      regions: regions.map(function (r) {
        var c = Object.assign({}, r);
        delete c.preview;
        return c;
      })
    }, null, 1));
    console.log('wrote ' + args.json);
  }
}

main();
