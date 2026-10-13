/* Idle VE table awareness tests.
 * Run: node tools/idle-ve-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/xdf-map.js', 'js/dashboard.js', 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap() {
  return { mapping: {
    RPM: { column: 'rpm' }, MAP: { column: 'map' },
    TPS: { column: 'tps' }, VSS: { column: 'vss' },
    STFT: { column: 'stft' }, LTFT: { column: 'ltft' }
  }, unmapped: [] };
}

// 60 idle rows (rpm 800, tps 0, vss 0, +8% trim) then
// 60 cruise rows (rpm 2500, tps 25, vss 45, -6% trim).
function makeRows() {
  var rows = [];
  var i;
  for (i = 0; i < 60; i++) {
    rows.push({ rpm: 800, map: 35, tps: 0, vss: 0,
      stft: 8, ltft: 0, _region: 'cruise' });
  }
  for (i = 0; i < 60; i++) {
    rows.push({ rpm: 2500, map: 60, tps: 25, vss: 45,
      stft: -6, ltft: 0, _region: 'cruise' });
  }
  return rows;
}

console.log('idle-ve: analyzer tracks idle fraction per cell');
var fr = P66.analyzeFuelTrims(makeRows(), fakeMap());
check('fuel report available', fr.available === true);
function cellByBin(rpmBin) {
  for (var i = 0; i < fr.cells.length; i++) {
    if (fr.cells[i].rpmBin === rpmBin) return fr.cells[i];
  }
  return null;
}
var idleCell = cellByBin('500-1000');
var cruiseCell = cellByBin('2500-3000');
check('idle cell found', !!idleCell);
check('cruise cell found', !!cruiseCell);
check('idle cell fully idle', idleCell && idleCell.idleFraction === 1,
  idleCell && String(idleCell.idleFraction));
check('cruise cell not idle', cruiseCell && cruiseCell.idleFraction === 0,
  cruiseCell && String(cruiseCell.idleFraction));
check('idle cell trim avg +8', idleCell && idleCell.avgTrim === 8,
  idleCell && String(idleCell.avgTrim));

console.log('idle-ve: analyzer falls back to RPM-only without TPS/VSS');
var noTpsMap = fakeMap();
delete noTpsMap.mapping.TPS;
delete noTpsMap.mapping.VSS;
var fr2 = P66.analyzeFuelTrims(makeRows(), noTpsMap);
var idleCell2 = null;
fr2.cells.forEach(function (c) { if (c.rpmBin === '500-1000') idleCell2 = c; });
check('rpm-only fallback still flags idle', idleCell2 && idleCell2.idleFraction === 1,
  idleCell2 && String(idleCell2.idleFraction));

console.log('idle-ve: tuner routes majority-idle cells to Idle VE');
var report = {
  fuelTrims: { available: true, cells: [
    { rpmBin: '500-1000', mapBin: '30-40', samples: 60, avgTrim: 8, stddev: 1, idleFraction: 1 },
    { rpmBin: '2500-3000', mapBin: '60-70', samples: 60, avgTrim: -6, stddev: 1, idleFraction: 0 }
  ] },
  narrowband: { available: false },
  bankImbalance: { available: false },
  knock: { available: false },
  lambda: { available: false }
};
var sug = P66.generateSuggestions(report, 'conservative');
function sugFor(rpmBin) {
  for (var i = 0; i < sug.actionable.length; i++) {
    if (sug.actionable[i].cell.indexOf(rpmBin) === 0) return sug.actionable[i];
  }
  return null;
}
var idleSug = sugFor('500-1000');
var cruiseSug = sugFor('2500-3000');
check('idle suggestion targets Idle VE', idleSug && idleSug.table === 'Idle VE',
  idleSug && idleSug.table);
check('idle suggestion adds fuel', idleSug && idleSug.action === 'add fuel',
  idleSug && idleSug.action);
check('cruise suggestion targets Main VE', cruiseSug && cruiseSug.table === 'Main VE',
  cruiseSug && cruiseSug.table);
check('cruise suggestion removes fuel', cruiseSug && cruiseSug.action === 'remove fuel',
  cruiseSug && cruiseSug.action);
check('idle reason names the table', idleSug && /Idle VE table/.test(idleSug.reason),
  idleSug && idleSug.reason.slice(0, 80));

console.log('idle-ve: patcher writes each table to its own address range');
var catalog = P66.BUNDLED_CATALOG;
var bin = new Uint8Array(65536);
var suggestions = [
  { kind: 'fuel', table: 'Idle VE', cell: '500-1000 RPM / 30-40 kPa',
    action: 'add fuel', deltaPct: 5, confidence: 'high' },
  { kind: 'fuel', table: 'Main VE', cell: '2000-2500 RPM / 30-40 kPa',
    action: 'remove fuel', deltaPct: -4, confidence: 'high' }
];
var pr = P66.applyFuelSuggestions(catalog, bin, suggestions, { smooth: false });
check('no patch error', !pr.error, pr.error);
var idlePatches = pr.patches.filter(function (p) { return p.table === 'Idle VE'; });
var mainPatches = pr.patches.filter(function (p) { return p.table === 'Main VE'; });
check('idle patches produced', idlePatches.length > 0, String(idlePatches.length));
check('main patches produced', mainPatches.length > 0, String(mainPatches.length));
var IDLE_BASE = 0x69B, IDLE_END = 0x69B + 7 * 13 * 2;
var MAIN_BASE = 0xEAA, MAIN_END = 0xEAA + 17 * 13 * 2;
check('idle patches inside idle table range',
  idlePatches.every(function (p) { return p.address >= IDLE_BASE && p.address < IDLE_END; }));
check('main patches inside main table range',
  mainPatches.every(function (p) { return p.address >= MAIN_BASE && p.address < MAIN_END; }));
check('idle patch rpm within idle table axis',
  idlePatches.every(function (p) { return p.rpm >= 400 && p.rpm <= 1600; }));
check('patched image is a copy', pr.patched && pr.patched.length === 65536 && pr.patched !== bin);

console.log('idle-ve: patcher falls back gracefully when a table is missing');
var pr2 = P66.applyFuelSuggestions({ tables: [] }, bin, suggestions, { smooth: false });
check('total failure errors cleanly', !!pr2.error && pr2.patched === null, pr2.error);

console.log('idle-ve: comparison view separates the tables');
var idlePatch = { table: 'Idle VE', address: 0x69B, addressHex: '0x69B',
  deltaPct: 5, oldValue: 100, newValue: 105 };
var mainPatch = { table: 'Main VE', address: 0xEAA, addressHex: '0xEAA',
  deltaPct: -3, oldValue: 100, newValue: 97 };
var dIdle = P66.veComparisonData(catalog, bin, [idlePatch, mainPatch], 'Idle VE');
check('idle view counts only idle patches', !dIdle.error && dIdle.changed === 1,
  dIdle.error || String(dIdle.changed));
check('idle view title', dIdle.tableTitle === 'Idle VE', dIdle.tableTitle);
var dMain = P66.veComparisonData(catalog, bin, [idlePatch, mainPatch], 'Main VE');
check('main view counts only main patches', !dMain.error && dMain.changed === 1,
  dMain.error || String(dMain.changed));
var dDef = P66.veComparisonData(catalog, bin, [idlePatch, mainPatch]);
check('default view is Main VE', dDef.tableTitle === 'Main VE' && dDef.changed === 1,
  dDef.tableTitle);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
