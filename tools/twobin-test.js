#!/usr/bin/env node
/* twobin-test — self-test for js/twobin.js (the two-bin upload workflow)
 * plus its provenance.js integration.
 *
 *   node tools/twobin-test.js
 *
 * Proves:
 *   1. slot model: the "analyzed" bin slot is REQUIRED, the "stock /
 *      reference" slot is OPTIONAL (P66.BIN_SLOTS);
 *   2. same-file detection: P66.binsIdentical is true only for
 *      byte-identical non-empty binaries (drives the isStockFirstTune
 *      flag — a stock PCM doing its first tune);
 *   3. stickiness: P66.createTwoBinStore round-trips a real 64KB bin
 *      through a simulated localStorage (survives a fresh store
 *      instance), falls back to a session-only memory copy on quota
 *      errors, and clear() drops it;
 *   4. provenance: buildProvenance records the analyzed bin's filename
 *      in the result and names it in the change report;
 *   5. drift-view defaulting: P66.resolveBinDiffSlots puts the stock /
 *      reference bin in slot B when present, never overrides a B file
 *      the user picked themselves, and never defaults slot A.
 * Exits nonzero on any unexpected result.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'twobin.js'));
require(path.join(ROOT, 'js', 'xdf-map.js'));
require(path.join(ROOT, 'js', 'provenance.js'));
var P66 = global.P66;

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Minimal localStorage stand-in: getItem/setItem/removeItem.
function fakeStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}
// localStorage that blows up on write (quota-blocked browser).
function quotaStorage() {
  return {
    getItem: function () { return null; },
    setItem: function () { throw new Error('QuotaExceededError: quota exceeded'); },
    removeItem: function () {}
  };
}

var stockBin = new Uint8Array(fs.readFileSync(path.join(ROOT, 'defs', 'bins', 'stock-1995-camaro-l32.bin')));

console.log('1. slot model (P66.BIN_SLOTS)');
check('two slots defined', Array.isArray(P66.BIN_SLOTS) && P66.BIN_SLOTS.length === 2);
var analyzed = P66.BIN_SLOTS[0], stock = P66.BIN_SLOTS[1];
check('analyzed slot key', analyzed.key === 'analyzed');
check('analyzed slot is REQUIRED', analyzed.required === true);
check('analyzed label names the PCM-at-log-time bin',
  /PCM/i.test(analyzed.label) && /log/i.test(analyzed.label), analyzed.label);
check('stock slot key', stock.key === 'stock');
check('stock slot is OPTIONAL', stock.required === false);

console.log('2. same-file detection (P66.binsIdentical)');
var same = new Uint8Array(stockBin);
var oneOff = new Uint8Array(stockBin);
oneOff[12345] ^= 0xFF;
check('byte-identical bins -> true', P66.binsIdentical(stockBin, same) === true);
check('one byte differs -> false', P66.binsIdentical(stockBin, oneOff) === false);
check('length mismatch -> false',
  P66.binsIdentical(stockBin, stockBin.subarray(0, 1000)) === false);
check('null side -> false',
  P66.binsIdentical(null, stockBin) === false && P66.binsIdentical(stockBin, null) === false);
check('empty bins -> false (not "the same file")',
  P66.binsIdentical(new Uint8Array(0), new Uint8Array(0)) === false);
check('first-tune message is plain language',
  /same bin in both slots/i.test(P66.stockFirstTuneMessage()) &&
  /stock pcm/i.test(P66.stockFirstTuneMessage()));

console.log('3. stickiness (P66.createTwoBinStore)');
var mem = fakeStorage();
var store1 = P66.createTwoBinStore(mem);
var setRes = store1.set('stock-1995-camaro-l32.bin', stockBin);
check('set reports stored', setRes.ok === true && setRes.stored === true);
// Fresh store on the same backing storage = a new session.
var store2 = P66.createTwoBinStore(mem);
var got = store2.get();
check('survives a fresh store instance (new session)', got !== null, 'got null');
check('name survives', got && got.name === 'stock-1995-camaro-l32.bin', got && got.name);
check('64KB bytes round-trip exactly', got && bytesEqual(got.bytes, stockBin),
  got && 'length ' + got.bytes.length);
store2.clear();
check('clear drops the bin', P66.createTwoBinStore(mem).get() === null);
// Quota-blocked: keep working in-memory for this session.
var qstore = P66.createTwoBinStore(quotaStorage());
var qres = qstore.set('ref.bin', stockBin);
check('quota failure still ok (session-only)', qres.ok === true && qres.stored === false, qres.message);
var qgot = qstore.get();
check('memory fallback serves the bin this session', qgot && bytesEqual(qgot.bytes, stockBin));
// No storage at all (node default path): memory only.
var nstore = P66.createTwoBinStore(null);
nstore.set('mem.bin', stockBin.subarray(0, 64));
check('null storage keeps a session copy', nstore.get() !== null && nstore.get().name === 'mem.bin');

console.log('4. provenance names the source bin');
var patched = new Uint8Array(stockBin);
patched[0x10] ^= 0x01;
var prov = P66.buildProvenance(stockBin, patched,
  [{ address: 0x10, sizeBytes: 1, table: 'Main VE' }],
  { app: 'twobin-test', sourceBinName: 'pcm-read-at-log-time.bin',
    sourceBinLabel: 'analyzed bin (in the PCM when the log was recorded)' });
check('provenance ok', prov.ok === true, prov.message);
check('result carries the source bin name', prov.sourceBinName === 'pcm-read-at-log-time.bin');
check('result carries the source bin label',
  prov.sourceBinLabel === 'analyzed bin (in the PCM when the log was recorded)');
check('change report names the source bin file',
  prov.changeReport.indexOf('Source binary: pcm-read-at-log-time.bin') !== -1);
check('change report carries the slot label',
  prov.changeReport.indexOf('analyzed bin (in the PCM when the log was recorded)') !== -1);
// Old callers that don't pass a name still work.
var provPlain = P66.buildProvenance(stockBin, patched,
  [{ address: 0x10, sizeBytes: 1, table: 'Main VE' }], { app: 'twobin-test' });
check('provenance ok without a name', provPlain.ok === true);
check('name defaults to null', provPlain.sourceBinName === null);
check('report says the name was not recorded',
  provPlain.changeReport.indexOf('Source binary: (file name not recorded)') !== -1);

console.log('5. drift-view slot defaulting (P66.resolveBinDiffSlots)');
var pickedA = new Uint8Array(stockBin); pickedA[0x20] ^= 0x02;
var pickedB = new Uint8Array(stockBin); pickedB[0x30] ^= 0x03;
var d1 = P66.resolveBinDiffSlots({ stockBytes: stockBin, stockName: 'stock.bin' });
check('stock present, nothing picked -> B gets the stock bin', d1.b === stockBin);
check('B default flagged', d1.bDefaulted === true);
check('default note is plain language', /defaulted/i.test(d1.note) && /stock.bin/.test(d1.note), d1.note);
check('slot A is never defaulted', d1.a === null);
var d2 = P66.resolveBinDiffSlots({ pickedA: pickedA, pickedB: pickedB, stockBytes: stockBin });
check('user-picked B wins over the stock default', d2.b === pickedB && d2.bDefaulted === false);
check('user-picked A passes through', d2.a === pickedA);
var d3 = P66.resolveBinDiffSlots({ pickedA: pickedA });
check('no stock bin -> B stays empty', d3.b === null && d3.bDefaulted === false);
check('no stock bin -> no note', d3.note === '');

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
