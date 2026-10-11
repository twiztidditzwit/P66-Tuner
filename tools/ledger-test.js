/* Cumulative patch ledger tests.
 * Run: node tools/ledger-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/ledger.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fuelPatch(addr, pct) {
  return { table: 'Main VE', addressHex: addr, deltaPct: pct, oldValue: 100, newValue: 100 + pct };
}
function sparkPatch(addr, deg) {
  return { table: 'Main Spark', addressHex: addr, deltaDeg: deg };
}

// Simulate a real tune cycle gap so the double-download dedup doesn't kick in.
function ageEntries(store, fp, hours) {
  var raw = JSON.parse(store.getItem('p66-ledger-v1') || '{}');
  (raw[fp] || []).forEach(function (e) {
    e.date = new Date(new Date(e.date).getTime() - hours * 3600 * 1000).toISOString();
  });
  store.setItem('p66-ledger-v1', JSON.stringify(raw));
}

console.log('ledger: compounding fuel deltas');
var store1 = P66._ledgerMemoryStore();
var l1 = P66.createLedger(store1);
l1.record('fp1', [fuelPatch('0xEAA', 5)]);
ageEntries(store1, 'fp1', 5);
l1.record('fp1', [fuelPatch('0xEAA', 5)]);
ageEntries(store1, 'fp1', 5);
// 1.05 * 1.05 - 1 = 10.25%
var w1 = l1.check('fp1', [fuelPatch('0xEAA', 5)]);
check('warns at 15.76% (1.05^3-1 > 15 limit)', w1.length === 1,
  'warnings=' + w1.length);
check('warning names the cell', w1[0] && /0xEAA/.test(w1[0].message));
check('cumulative compounds (15.76%)', w1[0] && Math.abs(w1[0].cumulative - 15.76) < 0.01,
  'cumulative=' + (w1[0] && w1[0].cumulative));

console.log('ledger: under the limit stays quiet');
var l2 = P66.createLedger(P66._ledgerMemoryStore());
l2.record('fp1', [fuelPatch('0xEAA', 5)]);
var w2 = l2.check('fp1', [fuelPatch('0xEAA', 5)]);
check('no warning at 10.25%', w2.length === 0, 'warnings=' + w2.length);

console.log('ledger: spark adds in degrees');
var store3 = P66._ledgerMemoryStore();
var l3 = P66.createLedger(store3);
l3.record('fp1', [sparkPatch('0x39', -2)]);
ageEntries(store3, 'fp1', 5);
l3.record('fp1', [sparkPatch('0x39', -2)]);
ageEntries(store3, 'fp1', 5);
var w3 = l3.check('fp1', [sparkPatch('0x39', -2)]);
check('warns past 6 degrees', w3.length === 1 && w3[0].cumulative === -6,
  JSON.stringify(w3.map(function (x) { return x.cumulative; })));

console.log('ledger: fingerprint isolation');
var l4 = P66.createLedger(P66._ledgerMemoryStore());
l4.record('fpA', [fuelPatch('0xEAA', 10)]);
l4.record('fpA', [fuelPatch('0xEAA', 10)]); // 21% on fpA
var w4 = l4.check('fpB', [fuelPatch('0xEAA', 5)]);
check('different bin starts clean', w4.length === 0, 'warnings=' + w4.length);

console.log('ledger: per-address keys');
var l5 = P66.createLedger(P66._ledgerMemoryStore());
l5.record('fp1', [fuelPatch('0xEAA', 10), fuelPatch('0xEAB', 10)]);
var w5 = l5.check('fp1', [fuelPatch('0xEAA', 10)]);
check('only the repeated address warns', w5.length === 1 && /0xEAA/.test(w5[0].key),
  JSON.stringify(w5.map(function (x) { return x.key; })));

console.log('ledger: history and prune');
var store6 = P66._ledgerMemoryStore();
var l6 = P66.createLedger(store6);
for (var i = 0; i < 25; i++) {
  l6.record('fp1', [fuelPatch('0xEAA', 1)]);
  ageEntries(store6, 'fp1', 2);
}
check('prunes to 20 entries', l6.history('fp1').length === 20, 'len=' + l6.history('fp1').length);
l6.clear('fp1');
check('clear works', l6.history('fp1').length === 0);

console.log('ledger: double-download dedup (time-windowed)');
var l8 = P66.createLedger(P66._ledgerMemoryStore());
l8.record('fp1', [fuelPatch('0xEAA', 5)]);
l8.record('fp1', [fuelPatch('0xEAA', 5)]);
check('immediate repeat not double-counted', l8.history('fp1').length === 1, 'len=' + l8.history('fp1').length);
l8.record('fp1', [fuelPatch('0xEAA', 6)]);
check('different patches recorded', l8.history('fp1').length === 2, 'len=' + l8.history('fp1').length);
// Backdate the last entry: a genuine later re-tune counts.
var store8 = P66._ledgerMemoryStore();
var l8b = P66.createLedger(store8);
l8b.record('fp1', [fuelPatch('0xEAA', 5)]);
var raw8 = JSON.parse(store8.getItem('p66-ledger-v1'));
raw8.fp1[0].date = new Date(Date.now() - 3600 * 1000).toISOString();
store8.setItem('p66-ledger-v1', JSON.stringify(raw8));
l8b.record('fp1', [fuelPatch('0xEAA', 5)]);
check('repeat after an hour counts', l8b.history('fp1').length === 2, 'len=' + l8b.history('fp1').length);

console.log('ledger: empty inputs are safe');
var l7 = P66.createLedger(P66._ledgerMemoryStore());
check('check with no fingerprint', l7.check(null, [fuelPatch('0x1', 99)]).length === 0);
check('check with no patches', l7.check('fp1', []).length === 0);
l7.record('fp1', []);
check('record empty is a no-op', l7.history('fp1').length === 0);

console.log('ledger: persists across instances (same store)');
var store = P66._ledgerMemoryStore();
var la = P66.createLedger(store);
la.record('fp1', [fuelPatch('0xEAA', 12)]);
var lb = P66.createLedger(store);
var wb = lb.check('fp1', [fuelPatch('0xEAA', 5)]);
check('second instance sees history', wb.length === 1, 'warnings=' + wb.length);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
