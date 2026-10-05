#!/usr/bin/env node
/*
 * xdf-audit — audit an XDF definition against a binary image.
 *
 * Maps every XDF table/constant/flag to its byte range in the binary and reports:
 *   - coverage: what fraction of the image is defined
 *   - overlaps: two definitions claiming the same bytes (possible errors)
 *   - gaps: undefined regions with entropy analysis (candidates for new definitions)
 *   - out-of-range: definitions pointing outside the image
 *
 * Usage:
 *   node tools/xdf-audit.js <file.xdf> <file.bin> [--json out.json] [--min-gap 16]
 */
'use strict';

var fs = require('fs');
require('../js/xdf-map.js');
var P66 = global.P66;

function parseAddr(a) {
  if (typeof a === 'number') return a;
  var s = String(a || '').trim();
  return s.slice(0, 2).toLowerCase() === '0x' ? parseInt(s, 16) : parseInt(s, 10);
}

function defByteSize(d) {
  var bits = parseInt(d.elementSizeBits || '8', 10) || 8;
  var bytesPerEl = bits / 8;
  var rows = parseInt(d.rows, 10) || 1;
  var cols = parseInt(d.cols, 10) || 1;
  return Math.ceil(rows * cols * bytesPerEl);
}

function shannonEntropy(b, start, end) {
  var counts = new Array(256).fill(0);
  var n = 0;
  for (var i = start; i < end; i++) { counts[b[i]]++; n++; }
  if (!n) return 0;
  var h = 0;
  for (var k = 0; k < 256; k++) {
    if (!counts[k]) continue;
    var p = counts[k] / n;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 100) / 100;
}

function main() {
  var xdfFile = null, binFile = null, jsonOut = null, minGap = 16, mapOut = null;
  var argv = process.argv;
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') jsonOut = argv[++i];
    else if (argv[i] === '--map') mapOut = argv[++i];
    else if (argv[i] === '--min-gap') minGap = parseInt(argv[++i], 10) || 16;
    else if (!xdfFile) xdfFile = argv[i];
    else if (!binFile) binFile = argv[i];
  }
  if (!xdfFile || !binFile) {
    console.error('Usage: node tools/xdf-audit.js <file.xdf> <file.bin> [--json out.json] [--min-gap 16]');
    process.exit(1);
  }

  var catalog = P66.parseXdfXml(fs.readFileSync(xdfFile, 'utf8'));
  var bin = fs.readFileSync(binFile);
  var N = bin.length;

  // Collect all definitions with byte ranges.
  var defs = [];
  function addDef(kind, d) {
    if (!d.address && d.address !== 0) return;
    var addr = parseAddr(d.address);
    if (!isFinite(addr)) return;
    var size = defByteSize(d);
    defs.push({ kind: kind, title: d.title, address: addr, size: size, id: d.id });
  }
  catalog.tables.forEach(function (t) { addDef('table', t); });
  catalog.constants.forEach(function (c) { addDef('constant', c); });
  catalog.flags.forEach(function (f) { addDef('flag', f); });

  console.log('definitions: ' + defs.length + ' (' + catalog.tables.length + ' tables, ' +
    catalog.constants.length + ' constants, ' + catalog.flags.length + ' flags)');

  // Out-of-range check.
  var oor = defs.filter(function (d) { return d.address < 0 || d.address + d.size > N; });
  console.log('\nout-of-range definitions: ' + oor.length);
  oor.slice(0, 10).forEach(function (d) {
    console.log('  0x' + d.address.toString(16).toUpperCase() + ' +' + d.size + '  [' + d.kind + '] ' + d.title.slice(0, 60));
  });

  // Coverage map: which defs cover each byte.
  var cover = new Array(N).fill(0);
  var coverBy = new Array(N);
  defs.forEach(function (d, di) {
    if (d.address < 0 || d.address >= N) return;
    var end = Math.min(d.address + d.size, N);
    for (var a = d.address; a < end; a++) {
      cover[a]++;
      if (cover[a] === 1) coverBy[a] = di;
      else if (cover[a] === 2) coverBy[a] = -1; // mark overlap
    }
  });

  var coveredBytes = cover.filter(function (c) { return c > 0; }).length;
  console.log('\ncoverage: ' + coveredBytes + ' / ' + N + ' bytes (' +
    (100 * coveredBytes / N).toFixed(1) + '%)');

  // Overlaps.
  var overlapAddrs = [];
  for (var o = 0; o < N; o++) if (cover[o] > 1) overlapAddrs.push(o);
  // Group into regions.
  function group(addrs) {
    var regions = [], s = null, p = null;
    addrs.forEach(function (a) {
      if (s === null) { s = a; p = a; return; }
      if (a === p + 1) { p = a; return; }
      regions.push([s, p]); s = a; p = a;
    });
    if (s !== null) regions.push([s, p]);
    return regions;
  }
  var overlapRegions = group(overlapAddrs);
  console.log('overlapping regions: ' + overlapRegions.length);
  overlapRegions.slice(0, 10).forEach(function (r) {
    var names = {};
    for (var a = r[0]; a <= Math.min(r[1], r[0] + 64); a++) {
      defs.forEach(function (d) {
        if (a >= d.address && a < d.address + d.size) names[d.title] = true;
      });
    }
    console.log('  0x' + r[0].toString(16).toUpperCase() + '-0x' + r[1].toString(16).toUpperCase() +
      ' (' + (r[1] - r[0] + 1) + ' bytes): ' + Object.keys(names).slice(0, 3).join(' / ').slice(0, 80));
  });

  // Gaps: uncovered regions.
  var gapAddrs = [];
  for (var g = 0; g < N; g++) if (cover[g] === 0) gapAddrs.push(g);
  var gaps = group(gapAddrs).filter(function (r) { return (r[1] - r[0] + 1) >= minGap; });
  console.log('\nundefined gaps (>= ' + minGap + ' bytes): ' + gaps.length);
  var gapInfo = gaps.map(function (r) {
    var size = r[1] - r[0] + 1;
    return {
      start: r[0], end: r[1], size: size,
      startHex: '0x' + r[0].toString(16).toUpperCase(),
      entropy: shannonEntropy(bin, r[0], r[1] + 1)
    };
  });
  // Show the largest gaps.
  gapInfo.sort(function (a, b) { return b.size - a.size; });
  gapInfo.slice(0, 15).forEach(function (gi) {
    var kind = gi.entropy < 1 ? 'empty/padding' : (gi.entropy < 5 ? 'structured?' : 'code?');
    console.log('  ' + gi.startHex + ' +' + gi.size + '  entropy ' + gi.entropy.toFixed(2) + '  ' + kind);
  });

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      coveragePct: Math.round(1000 * coveredBytes / N) / 10,
      outOfRange: oor,
      overlapRegions: overlapRegions.map(function (r) {
        return { startHex: '0x' + r[0].toString(16).toUpperCase(), size: r[1] - r[0] + 1 };
      }),
      gaps: gapInfo
    }, null, 1));
    console.log('\nwrote ' + jsonOut);
  }

  if (mapOut) {
    writeMap(mapOut, bin, defs, cover, N);
  }
}

// SVG coverage map: 256x256 grid, one cell per byte, run-length merged per row.
function writeMap(outFile, bin, defs, cover, N) {
  var COLS = 256, CELL = 3, W = COLS * CELL, H = (N / COLS) * CELL;
  var colors = { table: '#4a90d9', constant: '#5cb85c', flag: '#f0ad4e', overlap: '#d9534f', gap: '#1a1a1a', code: '#333333' };
  // kind per byte (first def wins; overlap flagged)
  var kindOf = new Array(N);
  defs.forEach(function (d) {
    if (d.address < 0 || d.address >= N) return;
    var end = Math.min(d.address + d.size, N);
    for (var a = d.address; a < end; a++) {
      if (cover[a] > 1) kindOf[a] = 'overlap';
      else if (!kindOf[a]) kindOf[a] = d.kind;
    }
  });
  var parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + (W + 220) + '" height="' + (H + 60) + '" viewBox="0 0 ' + (W + 220) + ' ' + (H + 60) + '">');
  parts.push('<rect width="' + (W + 220) + '" height="' + (H + 60) + '" fill="#0d0d0d"/>');
  parts.push('<text x="10" y="28" fill="#eee" font-family="monospace" font-size="16">P66 XDF coverage map — 64KB, 1px per byte (green=constant blue=table amber=flag red=overlap)</text>');
  // Merge runs per row for compactness.
  for (var row = 0; row < N / COLS; row++) {
    var runKind = null, runStart = 0;
    for (var col = 0; col <= COLS; col++) {
      var k = col < COLS ? (kindOf[row * COLS + col] || 'gap') : null;
      if (k !== runKind) {
        if (runKind) {
          parts.push('<rect x="' + (10 + runStart * CELL) + '" y="' + (40 + row * CELL) + '" width="' + ((col - runStart) * CELL) + '" height="' + CELL + '" fill="' + colors[runKind] + '"/>');
        }
        runKind = k; runStart = col;
      }
    }
  }
  // Address labels every 16KB.
  for (var m = 0; m <= 4; m++) {
    var y = 40 + m * 64 * CELL;
    parts.push('<text x="' + (W + 20) + '" y="' + (y + 4) + '" fill="#888" font-family="monospace" font-size="11">0x' + (m * 16384).toString(16).toUpperCase().padStart(4, '0') + '</text>');
  }
  parts.push('</svg>');
  fs.writeFileSync(outFile, parts.join('\n'));
  console.log('wrote ' + outFile);
}

main();
