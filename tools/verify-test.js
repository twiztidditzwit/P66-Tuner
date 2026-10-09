#!/usr/bin/env node
/* verify-test — self-test for js/verify.js against the stock binary.
 *
 *   node tools/verify-test.js
 *
 * Exercises the full log->patches->verify loop with synthetic fuel
 * suggestions, plus negative cases: wrong base binary, out-of-range
 * address, conflicting patches, corrupted patched image, table-region
 * violation, and a known XDF overlap region (warning only).
 * Exits nonzero on any unexpected result.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'xdf-map.js'));
require(path.join(ROOT, 'js', 'verify.js'));
var P66 = global.P66;

var catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'defs', 'xdf', 'p66-v6-34l.catalog.json'), 'utf8'));
var stockBin = new Uint8Array(fs.readFileSync(path.join(ROOT, 'defs', 'bins', 'stock-1995-camaro-l32.bin')));

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function hasCheck(result, kind, checkName) {
  return result[kind].some(function (f) { return f.check === checkName; });
}

// Synthetic fuel suggestions hitting real Main VE cells.
function suggestions() {
  return [
    { kind: 'fuel', table: 'VE/MAF', cell: '2000-2800 RPM / 80-100 kPa', action: 'add fuel', deltaPct: 6, confidence: 'high', samples: 120 },
    { kind: 'fuel', table: 'VE/MAF', cell: '800-1200 RPM / 30-40 kPa', action: 'remove fuel', deltaPct: -5, confidence: 'high', samples: 200 }
  ];
}

console.log('1. happy path: apply + verify against stock bin');
var pr = P66.applyFuelSuggestions(catalog, stockBin, suggestions());
check('patches generated', pr.patches.length > 0, 'got ' + pr.patches.length);
check('no apply error', !pr.error, pr.error);
var v = P66.verifyPatches(catalog, stockBin, pr);
check('verification passes', v.ok === true, JSON.stringify(v.failures));
check('all patches checked', v.checked === pr.patches.length);

console.log('2. wrong base binary: one byte changed before verify');
var tampered = new Uint8Array(stockBin);
var victim = pr.patches[0];
tampered[victim.address] ^= 0xFF;
var v2 = P66.verifyPatches(catalog, tampered, pr);
check('verification fails', v2.ok === false);
check('old-value failure reported', hasCheck(v2, 'failures', 'old-value'));

console.log('3. out-of-range address');
var bad = {
  patches: [{ table: 'Main VE', address: 0xFFFFFF, addressHex: '0xFFFFFF', sizeBytes: 2, oldValue: 0, newValue: 1, deltaPct: 1 }],
  patched: new Uint8Array(stockBin)
};
var v3 = P66.verifyPatches(catalog, stockBin, bad);
check('verification fails', v3.ok === false);
check('range failure reported', hasCheck(v3, 'failures', 'range'));

console.log('4. conflicting patches on the same address');
var dup = {
  patches: [
    { table: 'Main VE', address: victim.address, addressHex: victim.addressHex, sizeBytes: 2, oldValue: victim.oldValue, newValue: victim.newValue, deltaPct: 1 },
    { table: 'Main VE', address: victim.address, addressHex: victim.addressHex, sizeBytes: 2, oldValue: victim.oldValue, newValue: victim.newValue, deltaPct: 1 }
  ],
  patched: new Uint8Array(stockBin)
};
var v4 = P66.verifyPatches(catalog, stockBin, dup);
check('verification fails', v4.ok === false);
check('conflict failure reported', hasCheck(v4, 'failures', 'conflict'));

console.log('5. corrupted patched image (read-back mismatch)');
var pr2 = P66.applyFuelSuggestions(catalog, stockBin, suggestions());
pr2.patched[pr2.patches[0].address] ^= 0xFF;
var v5 = P66.verifyPatches(catalog, stockBin, pr2);
check('verification fails', v5.ok === false);
check('read-back failure reported', hasCheck(v5, 'failures', 'read-back'));

console.log('6. address outside the table XDF region');
var outside = {
  patches: [{ table: 'Main VE', address: 0x100, addressHex: '0x100', sizeBytes: 1, oldValue: stockBin[0x100], newValue: stockBin[0x100], deltaPct: 0 }],
  patched: new Uint8Array(stockBin)
};
var v6 = P66.verifyPatches(catalog, stockBin, outside);
check('verification fails', v6.ok === false);
check('table-region failure reported', hasCheck(v6, 'failures', 'table'));

console.log('7. known XDF overlap region -> warning, not failure');
var ov = {
  patches: [{ table: 'Main VE', address: 0xB5D, addressHex: '0xB5D', sizeBytes: 1, oldValue: stockBin[0xB5D], newValue: stockBin[0xB5D], deltaPct: 0 }],
  patched: new Uint8Array(stockBin)
};
// 0xB5D is outside Main VE, so expect a table failure AND an overlap warning.
var v7 = P66.verifyPatches(catalog, stockBin, ov);
check('overlap warning reported', hasCheck(v7, 'warnings', 'overlap'), JSON.stringify(v7.warnings));

console.log('8. empty patch result with error');
var v8 = P66.verifyPatches(catalog, stockBin, { patches: [], patched: null, error: 'Main VE table not readable' });
check('verification fails', v8.ok === false);
check('input failure reported', hasCheck(v8, 'failures', 'input'));

console.log('9. overlap fallback: uploaded XDF without audit block');
var noAudit = JSON.parse(JSON.stringify(catalog));
delete noAudit.audit;
var v9 = P66.verifyPatches(noAudit, stockBin, ov);
check('overlap warning via fallback', hasCheck(v9, 'warnings', 'overlap'), JSON.stringify(v9.warnings));
var foreign = JSON.parse(JSON.stringify(catalog));
delete foreign.audit;
foreign.deftitle = 'Some Other XDF';
var v9b = P66.verifyPatches(foreign, stockBin, ov);
check('no stale warning for foreign XDF', !hasCheck(v9b, 'warnings', 'overlap'));

console.log('10. spark patches: knock retard via equation scaling');
function sparkSug() {
  return [{ kind: 'spark', table: 'Spark Advance', cell: 'cruise region', action: 'retard timing',
            deltaDeg: -2, confidence: 'high', samples: 50, knockCells: [{ rpm: 3000, map: 83 }] }];
}
check('rawPerDegree X*(90/255)', P66.rawPerDegree('X*(90/255)') === 255 / 90);
check('rawPerDegree X*0.5', P66.rawPerDegree('X*0.5') === 2);
check('rawPerDegree X/2', P66.rawPerDegree('X/2') === 2);
check('rawPerDegree X', P66.rawPerDegree('X') === 1);
check('rawPerDegree garbage', P66.rawPerDegree('X*X+1') === null);
var spr = P66.applySparkSuggestions(catalog, stockBin, sparkSug());
check('spark patches generated', spr.patches.length > 0, 'got ' + spr.patches.length);
check('no spark error', !spr.error, spr.error);
var targeted = spr.patches.filter(function (p) { return !p.smoothed; });
check('targeted cell retarded by round(-2*255/90)=-6 raw',
  targeted.length > 0 && targeted[0].newValue === targeted[0].oldValue - 6,
  targeted.length ? (targeted[0].oldValue + '->' + targeted[0].newValue) : 'none');
var vs = P66.verifyPatches(catalog, stockBin, spr);
check('spark verification passes', vs.ok === true, JSON.stringify(vs.failures));

console.log('11. spark refuses unsupported equation');
var badEq = JSON.parse(JSON.stringify(catalog));
badEq.tables.forEach(function (t) { if (t.title === 'Main Spark Advance') t.zAxis.equation = 'X*X+1'; });
var sprBad = P66.applySparkSuggestions(badEq, stockBin, sparkSug());
check('error returned', !!sprBad.error && /Unsupported spark equation/.test(sprBad.error), sprBad.error);
check('no patches emitted', sprBad.patches.length === 0);

console.log('12. spark action none -> no patches');
var sprNone = P66.applySparkSuggestions(catalog, stockBin,
  [{ kind: 'spark', action: 'none', deltaDeg: 0, knockCells: [{ rpm: 3000, map: 83 }] }]);
check('no patches', sprNone.patches.length === 0 && !sprNone.error);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
