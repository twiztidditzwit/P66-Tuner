#!/usr/bin/env node
/* provenance-test — self-test for js/provenance.js.
 *
 *   node tools/provenance-test.js
 *
 * Proves:
 *   1. the pure-JS SHA-256 matches FIPS 180-4 known vectors
 *      ("" , "abc", and the 56-byte "abcdbc..." vector) and agrees with
 *      node's crypto on the real 64 KB stock binary;
 *   2. end-to-end against the stock binary: applyFuelSuggestions ->
 *      buildProvenance reports ok, correct hashes, the exact changed-byte
 *      count, and a sane changeReport (table name, address range,
 *      old->new values);
 *   3. the hard rule: flipping one extra byte outside the patch set makes
 *      ok === false, names the uncovered address, and explains the block
 *      in plain English;
 *   4. edge cases: identical images (0 changes, ok), length mismatch
 *      (blocked), empty images (blocked).
 * Exits nonzero on any unexpected result.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'xdf-map.js'));
require(path.join(ROOT, 'js', 'provenance.js'));
var P66 = global.P66;

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function bytesOf(str) {
  return new Uint8Array(Buffer.from(str, 'utf8'));
}
function nodeSha256(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

console.log('1. SHA-256 known vectors (FIPS 180-4)');
check('empty string',
  P66.sha256Hex(new Uint8Array(0)) ===
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('"abc"',
  P66.sha256Hex(bytesOf('abc')) ===
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('56-byte "abcdbc..." vector (multi-block after padding)',
  P66.sha256Hex(bytesOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) ===
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
check('1,000,000 x "a"',
  P66.sha256Hex(new Uint8Array(1000000).fill(97)) ===
  'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

console.log('2. end-to-end: applyFuelSuggestions -> buildProvenance on the stock bin');
var catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'defs', 'xdf', 'p66-v6-34l.catalog.json'), 'utf8'));
var stockBin = new Uint8Array(fs.readFileSync(path.join(ROOT, 'defs', 'bins', 'stock-1995-camaro-l32.bin')));
var sug = [
  { kind: 'fuel', table: 'VE/MAF', cell: '2000-2800 RPM / 80-100 kPa', action: 'add fuel', deltaPct: 6, confidence: 'high', samples: 120 },
  { kind: 'fuel', table: 'VE/MAF', cell: '800-1200 RPM / 30-40 kPa', action: 'remove fuel', deltaPct: -5, confidence: 'high', samples: 200 }
];
var pr = P66.applyFuelSuggestions(catalog, stockBin, sug);
check('patches generated', pr.patches.length > 0, 'got ' + pr.patches.length);
check('no apply error', !pr.error, pr.error);

var prov = P66.buildProvenance(stockBin, pr.patched, pr.patches, { app: 'provenance-test', catalog: catalog });
check('provenance ok', prov.ok === true, prov.message);
check('source hash matches node crypto', prov.sourceSha256 === nodeSha256(stockBin));
check('patched hash matches node crypto', prov.patchedSha256 === nodeSha256(pr.patched));
check('hashes differ when bytes changed', prov.sourceSha256 !== prov.patchedSha256);
// Independent byte-diff recount.
var manual = 0;
for (var i = 0; i < stockBin.length; i++) if (stockBin[i] !== pr.patched[i]) manual++;
check('changedByteCount matches manual diff (' + manual + ')', prov.changedByteCount === manual);
check('no uncovered bytes', prov.uncovered.length === 0);
// changeReport sanity.
var r = prov.changeReport;
check('report names the app', r.indexOf('provenance-test') !== -1);
check('report shows both hashes', r.indexOf(prov.sourceSha256) !== -1 && r.indexOf(prov.patchedSha256) !== -1);
check('report shows changed-byte count', r.indexOf('Changed bytes: ' + manual) !== -1);
check('report names a table', /"[^"]*(Main VE|VE[^"]*)"/.test(r), r.split('\n').slice(5, 8).join(' | '));
check('report shows an address range and old->new values', /0x[0-9A-F]+/.test(r) && /\d+ -> \d+/.test(r));
// Every byte that actually changed inside a patch's span must appear in
// the report lists changed bytes, not patch base addresses — a 2-byte
// patch whose high byte didn't change only lists the changed byte).
var first = pr.patches[0];
var firstSpan = [];
var fsize = first.sizeBytes === 2 ? 2 : 1;
for (var fb = 0; fb < fsize; fb++) {
  if (stockBin[first.address + fb] !== pr.patched[first.address + fb]) firstSpan.push(first.address + fb);
}
check('report covers every changed byte of the first patch (' + first.addressHex + ')',
  firstSpan.length > 0 &&
  firstSpan.every(function (b) {
    return r.indexOf('0x' + b.toString(16).toUpperCase()) !== -1;
  }),
  firstSpan.map(function (b) { return '0x' + b.toString(16).toUpperCase(); }).join(','));

console.log('3. hard rule: one extra byte flipped outside the patch set');
var tampered = new Uint8Array(pr.patched);
// Find an address that differs from stock but is NOT covered by any patch,
// or simply pick a byte guaranteed outside the patches (scan for one).
var covered = {};
pr.patches.forEach(function (p) {
  var size = p.sizeBytes === 2 ? 2 : 1;
  for (var k = 0; k < size; k++) covered[p.address + k] = true;
});
var victim = -1;
for (var v = 0; v < stockBin.length; v++) {
  if (!covered[v] && stockBin[v] !== 0x00) { victim = v; break; }
}
if (victim < 0) { for (var v2 = 0; v2 < stockBin.length; v2++) { if (!covered[v2]) { victim = v2; break; } } }
tampered[victim] ^= 0xFF;
var prov2 = P66.buildProvenance(stockBin, tampered, pr.patches, { app: 'provenance-test', catalog: catalog });
check('provenance blocked (ok === false)', prov2.ok === false);
check('uncovered names the flipped address',
  prov2.uncovered.length === 1 && prov2.uncovered[0].start === victim,
  JSON.stringify(prov2.uncovered));
check('message is plain-English', /no verified patch covers|outside the verified patch list/.test(prov2.message),
  prov2.message);
check('report still lists the uncovered byte',
  prov2.changeReport.indexOf('0x' + victim.toString(16).toUpperCase()) !== -1 &&
  prov2.changeReport.indexOf('(no patch covers these bytes)') !== -1);
check('changedByteCount counts the extra byte', prov2.changedByteCount === manual + 1);

console.log('4. edge cases');
var same = P66.buildProvenance(stockBin, new Uint8Array(stockBin), [], { app: 'provenance-test' });
check('identical images: ok, 0 changed', same.ok === true && same.changedByteCount === 0);
check('identical images: hashes equal', same.sourceSha256 === same.patchedSha256);
var short = P66.buildProvenance(stockBin, stockBin.subarray(0, 100), [], {});
check('length mismatch blocked', short.ok === false && /bytes/.test(short.message));
var empty = P66.buildProvenance(new Uint8Array(0), new Uint8Array(0), [], {});
check('empty images blocked', empty.ok === false);
var missing = P66.buildProvenance(null, pr.patched, pr.patches, {});
check('missing source blocked', missing.ok === false);

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
