/* Patch impact preview tests.
 * Run: node tools/patch-preview-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/ledger.js', 'js/patch-preview.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fuelPatch(table, addr, pct) {
  return { table: table || 'Main VE', addressHex: addr, deltaPct: pct, oldValue: 100, newValue: 100 + pct };
}
function pePatch(addr, pct) {
  // Power Enrichment Target AFR patches carry deltaAfrPct, not deltaPct.
  return { table: 'Power Enrichment Target AFR', addressHex: addr, deltaAfrPct: pct, oldValue: 12.5, newValue: 11.5 };
}
function sparkPatch(addr, deg) {
  return { table: 'Main Spark', addressHex: addr, deltaDeg: deg };
}
function transPatch(table, addr, pct) {
  return { table: table, addressHex: addr, deltaPct: pct };
}
function tccPatch() {
  return { table: 'TCC lock/unlock scheduling', addressHex: '0xTCC', deltaPct: 0 };
}

// Same seeding pattern as tools/ledger-test.js: age entries so the
// double-download dedup treats them as genuine earlier tune cycles.
function ageEntries(store, fp, hours) {
  var raw = JSON.parse(store.getItem('p66-ledger-v1') || '{}');
  (raw[fp] || []).forEach(function (e) {
    e.date = new Date(new Date(e.date).getTime() - hours * 3600 * 1000).toISOString();
  });
  store.setItem('p66-ledger-v1', JSON.stringify(raw));
}

function ledgedImpact(recordedSets, newPatches) {
  var store = P66._ledgerMemoryStore();
  var ledger = P66.createLedger(store);
  (recordedSets || []).forEach(function (set) {
    ledger.record('fp1', set);
    ageEntries(store, 'fp1', 5);
  });
  var before = store.getItem('p66-ledger-v1');
  var impact = P66.previewPatchImpact(newPatches, { fingerprint: 'fp1', ledger: ledger });
  return { store: store, ledger: ledger, impact: impact, before: before };
}

console.log('preview: guardrails come from the ledger, not a copy');
var i0 = P66.previewPatchImpact([fuelPatch('Main VE', '0xEAA', 5)], null);
var L = P66.LEDGER_LIMITS;
check('fuel guardrail === LEDGER_LIMITS.fuelPct', i0.groups.fuel.guardrail === L.fuelPct, 'got ' + i0.groups.fuel.guardrail);
check('spark guardrail === LEDGER_LIMITS.sparkDeg', i0.groups.spark.guardrail === L.sparkDeg);
check('trans guardrail === LEDGER_LIMITS.transPct', i0.groups.trans.guardrail === L.transPct);
check('warn fraction exposed', P66.PATCH_PREVIEW_WARN_FRACTION === 0.8);

console.log('preview: requires the ledger module');
var savedLimits = P66.LEDGER_LIMITS;
delete P66.LEDGER_LIMITS;
var threw = false;
try { P66.previewPatchImpact([], null); } catch (e) { threw = /ledger/.test(e.message); }
check('throws without P66.LEDGER_LIMITS', threw);
P66.LEDGER_LIMITS = savedLimits;

console.log('preview: grouping across patch shapes');
var mixed = [
  fuelPatch('Main VE', '0xEAA', 5),
  fuelPatch('Idle VE', '0x69B', 4),
  pePatch('0xC00', -8),
  sparkPatch('0x39', -2),
  transPatch('Main Line Pressure 0-64MPH', '0x8F25', 10),
  transPatch('Normal Upshifts', '0x9000', 5),
  transPatch('Normal Downshifts', '0x9100', -5),
  tccPatch()
];
var ig = P66.previewPatchImpact(mixed, null);
check('fuel group gets VE + PE patches', ig.groups.fuel.count === 3, 'got ' + ig.groups.fuel.count);
check('spark group gets 1', ig.groups.spark.count === 1);
check('trans group gets line pressure + upshift + downshift', ig.groups.trans.count === 3, 'got ' + ig.groups.trans.count);
check('TCC patch excluded, never shown', ig.tccExcluded === 1 &&
  ig.groups.fuel.count + ig.groups.spark.count + ig.groups.trans.count === 7);
check('max single trans delta', ig.groups.trans.maxDelta === 10);
check('flags ok when under guardrails', ig.flags.fuel === 'ok' && ig.flags.spark === 'ok' && ig.flags.trans === 'ok',
  JSON.stringify(ig.flags));

console.log('preview: session math mirrors the ledger');
var iFuel = P66.previewPatchImpact([fuelPatch('Main VE', '0xEAA', 5), fuelPatch('Main VE', '0xEAB', 5)], null);
check('fuel session total compounds (10.25%)', Math.abs(iFuel.groups.fuel.sessionTotal - 10.25) < 0.001,
  'got ' + iFuel.groups.fuel.sessionTotal);
var iSpark = P66.previewPatchImpact([sparkPatch('0x39', -2), sparkPatch('0x3A', -1.5)], null);
check('spark session total adds degrees (-3.5)', iSpark.groups.spark.sessionTotal === -3.5,
  'got ' + iSpark.groups.spark.sessionTotal);
var iPe = P66.previewPatchImpact([pePatch('0xC00', -8)], null);
check('PE AFR patch counts as fuel via deltaAfrPct', iPe.groups.fuel.sessionTotal === -8,
  'got ' + iPe.groups.fuel.sessionTotal);

console.log('preview: warn at >80% of a guardrail');
var w = ledgedImpact(
  [[fuelPatch('Main VE', '0xEAA', 8)]],
  [fuelPatch('Main VE', '0xEAA', 5)]
);
// 1.08 * 1.05 - 1 = 13.4% -> 13.4/15 = 89% -> warn
var wg = w.impact.groups.fuel;
check('warn flag', wg.flag === 'warn', 'got ' + wg.flag);
check('worst cell cumulative 13.4%', Math.abs(wg.worstCell.cumulative - 13.4) < 0.01,
  'got ' + (wg.worstCell && wg.worstCell.cumulative));
check('usage fraction ~0.893', Math.abs(wg.usageFraction - 13.4 / 15) < 0.001, 'got ' + wg.usageFraction);
check('blockedCells empty', w.impact.blockedCells.length === 0);
check('spark still ok', w.impact.flags.spark === 'ok');

console.log('preview: blocked when the ledger would reject');
var b = ledgedImpact(
  [[fuelPatch('Main VE', '0xEAA', 10)]],
  [fuelPatch('Main VE', '0xEAA', 5)]
);
// 1.10 * 1.05 - 1 = 15.5% >= 15 -> ledger.check warns -> blocked
var bg = b.impact.groups.fuel;
check('blocked flag', bg.flag === 'blocked', 'got ' + bg.flag);
check('blockedCells names the cell', b.impact.blockedCells.length === 1 && /0xEAA/.test(b.impact.blockedCells[0].key),
  JSON.stringify(b.impact.blockedCells.map(function (x) { return x.key; })));
check('worst cell cumulative 15.5%', Math.abs(bg.worstCell.cumulative - 15.5) < 0.01,
  'got ' + (bg.worstCell && bg.worstCell.cumulative));

console.log('preview: spark guardrail from the ledger');
var sb = ledgedImpact(
  [[sparkPatch('0x39', -4)]],
  [sparkPatch('0x39', -2.5)]
);
check('spark blocked at -6.5 deg vs 6 deg limit', sb.impact.flags.spark === 'blocked',
  'got ' + sb.impact.flags.spark);
check('spark cumulative -6.5', sb.impact.groups.spark.worstCell.cumulative === -6.5);

console.log('preview: trans guardrail from the ledger');
var tb = ledgedImpact(
  [[transPatch('Main Line Pressure 0-64MPH', '0x8F25', 12)]],
  [transPatch('Main Line Pressure 0-64MPH', '0x8F25', 8)]
);
// 1.12 * 1.08 - 1 = 20.96% >= 20 -> blocked
check('trans blocked at 20.96% vs 20% limit', tb.impact.flags.trans === 'blocked',
  'got ' + tb.impact.flags.trans);

console.log('preview: is read-only');
check('store unchanged after preview', w.before === w.store.getItem('p66-ledger-v1'));
check('history length unchanged', w.ledger.history('fp1').length === 1);
check('impact marked readOnly', w.impact.readOnly === true);

console.log('preview: empty state');
var ie = P66.previewPatchImpact([], null);
check('empty flag', ie.empty === true);
check('groups exist with zero counts', ie.groups.fuel.count === 0 && ie.groups.spark.count === 0 && ie.groups.trans.count === 0);
check('all flags ok when empty', ie.flags.fuel === 'ok' && ie.flags.spark === 'ok' && ie.flags.trans === 'ok');
var he = P66.renderPatchPreviewHTML(ie);
check('HTML says no patches to preview', /No patches to preview/.test(he));
check('HTML names all three groups', /Fuel/.test(he) && /Spark/.test(he) && /Transmission/.test(he));

console.log('preview: HTML rendering');
var hr = P66.renderPatchPreviewHTML(w.impact);
check('HTML names all three groups', /Fuel/.test(hr) && /Spark/.test(hr) && /Transmission/.test(hr));
check('HTML shows counts and deltas', /1 patch\(es\)/.test(hr) && /13\.4%/.test(hr));
check('HTML has a change bar', /background:#c98a1b/.test(hr), 'warn color expected for fuel warn');
check('HTML shows worst cell', /0xEAA/.test(hr));
check('HTML carries the one-liner', /This session adds \+5% fuel to Main VE/.test(hr));
check('HTML carries guardrail wording', /±15%/.test(hr));
check('HTML has the safety disclaimer', /safe to flash/.test(hr));
check('HTML is a string with no DOM dependency', typeof hr === 'string');

console.log('preview: TCC exclusion renders a note');
var ht = P66.renderPatchPreviewHTML(P66.previewPatchImpact([tccPatch()], null));
check('TCC-only set is empty', P66.previewPatchImpact([tccPatch()], null).empty === true);
check('TCC note in HTML', /TCC is report-only/.test(ht));

console.log('preview: non-array input is safe');
check('null patches -> empty', P66.previewPatchImpact(null, null).empty === true);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
