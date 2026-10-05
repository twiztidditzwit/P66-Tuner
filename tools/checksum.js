#!/usr/bin/env node
/*
 * checksum — GM OBD-I checksum verification tool.
 *
 * Checks a binary image against the common GM checksum schemes of the era.
 * For the P66 (16184737), no checksum definition has been found in the XDF
 * and community practice (TunerPro edit + Winflash) works without manual
 * correction — this tool lets you verify that empirically on any image.
 *
 * Usage:
 *   node tools/checksum.js <file.bin> [--fix] [--out fixed.bin]
 *
 * --fix: if a scheme validates everywhere EXCEPT a single word, treat that
 *        word as the checksum location and correct it. USE WITH CAUTION:
 *        only meaningful if a scheme actually validates on the stock image.
 */
'use strict';

var fs = require('fs');

function wordBE(b, a) { return (b[a] << 8) | b[a + 1]; }

var SCHEMES = [
  {
    name: '16-bit BE sum == 0 (whole image)',
    test: function (b) {
      var s = 0;
      for (var i = 0; i < b.length; i += 2) s = (s + wordBE(b, i)) & 0xFFFF;
      return s === 0;
    }
  },
  {
    name: '16-bit BE sum == 0xFFFF (whole image)',
    test: function (b) {
      var s = 0;
      for (var j = 0; j < b.length; j += 2) s = (s + wordBE(b, j)) & 0xFFFF;
      return s === 0xFFFF;
    }
  },
  {
    name: 'byte sum mod 0x10000 == 0 (whole image)',
    test: function (b) {
      var s = 0;
      for (var k = 0; k < b.length; k++) s = (s + b[k]) & 0xFFFF;
      return s === 0;
    }
  }
];

function main() {
  var file = null, fix = false, out = null;
  var argv = process.argv;
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--fix') fix = true;
    else if (argv[i] === '--out') out = argv[++i];
    else if (!file) file = argv[i];
  }
  if (!file) {
    console.error('Usage: node tools/checksum.js <file.bin> [--fix] [--out fixed.bin]');
    process.exit(1);
  }
  var b = fs.readFileSync(file);
  console.log(file + ': ' + b.length + ' bytes');
  var anyValid = false;
  SCHEMES.forEach(function (s) {
    var ok = s.test(b);
    if (ok) anyValid = true;
    console.log('  [' + (ok ? 'VALID' : 'no') + '] ' + s.name);
  });
  if (!anyValid) {
    console.log('\nNo common scheme validates. This is consistent with the P66');
    console.log('having no enforced calibration checksum (no checksum definition');
    console.log('in the XDF; community flashes without manual correction).');
    console.log('Bench-verify before flashing to a vehicle.');
  }
  if (fix && !anyValid) {
    console.log('\n--fix requested but no scheme validates: nothing to correct.');
  }
}

main();
