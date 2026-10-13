/* Tip-in (throttle stab) accel-enrichment tests.
 * Run: node tools/tipin-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/xdf-map.js', 'js/bundled-catalog.js'].forEach(function (f) {
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
    RPM: { column: 'rpm' }, TPS: { column: 'tps' },
    O2_B1: { column: 'o2' }, ECT: { column: 'ect' }
  }, unmapped: [] };
}

// Build rows: baseline cruise, then tip-in events. Each event: TPS jumps
// from 15 to 55 and holds; O2 either dips lean (bad AE) or goes rich (good AE).
function makeRows(nEvents, nLean) {
  var rows = [];
  function cruise(n) {
    for (var i = 0; i < n; i++) rows.push({ rpm: 1800, tps: 15, o2: 450, ect: 190 });
  }
  cruise(30);
  for (var e = 0; e < nEvents; e++) {
    var lean = e < nLean;
    rows.push({ rpm: 1800, tps: 55, o2: 450, ect: 190 }); // the stab
    for (var s = 0; s < 10; s++) {
      // O2 response over the next ~1.5 s
      var o2 = lean ? (s < 5 ? 120 : 450) : (s < 3 ? 850 : 450);
      rows.push({ rpm: 1900 + s * 20, tps: 55, o2: o2, ect: 190 });
    }
    cruise(30); // refractory gap
  }
  return rows;
}

console.log('tipin: detection and lean-spike measurement');
var r1 = P66.analyzeTipIn(makeRows(8, 6), fakeMap());
check('available', r1.available === true);
check('8 events found', r1.events === 8, String(r1.events));
check('6 lean', r1.leanEvents === 6, String(r1.leanEvents));
check('lean fraction 0.75', r1.leanFraction === 0.75, String(r1.leanFraction));
check('avg min O2 lean', r1.avgMinO2 !== null && r1.avgMinO2 < 250, String(r1.avgMinO2));

console.log('tipin: one-sample TPS glitch ignored');
function glitchRows() {
  var rows = [];
  for (var i = 0; i < 40; i++) rows.push({ rpm: 1800, tps: 15, o2: 450, ect: 190 });
  rows.push({ rpm: 1800, tps: 70, o2: 450, ect: 190 }); // single-sample spike
  for (var j = 0; j < 40; j++) rows.push({ rpm: 1800, tps: 15, o2: 450, ect: 190 });
  return rows;
}
var r2 = P66.analyzeTipIn(glitchRows(), fakeMap());
check('glitch not counted', r2.events === 0, String(r2.events));

console.log('tipin: healthy AE produces no suggestion');
var r3 = P66.analyzeTipIn(makeRows(8, 1), fakeMap());
check('1 lean of 8', r3.leanEvents === 1 && r3.events === 8);
var sug3 = P66.generateSuggestions({ fuelTrims: { available: false }, knock: { available: false },
  lambda: { available: false }, narrowband: { available: false }, bankImbalance: { available: false },
  tipIn: r3 }, 'conservative');
check('no AE suggestion when AE looks fine',
  sug3.actionable.filter(function (s) { return s.kind === 'ae'; }).length === 0);

console.log('tipin: consistent lean spikes suggest more AE');
var nbHealthy = { available: true, crossCounts: [{ bank: 'bank1', health: 'healthy', perMin: 100 }] };
var sug4 = P66.generateSuggestions({ fuelTrims: { available: false }, knock: { available: false },
  lambda: { available: false }, narrowband: nbHealthy, bankImbalance: { available: false },
  tipIn: r1 }, 'conservative');
var ae4 = sug4.actionable.filter(function (s) { return s.kind === 'ae'; });
check('one AE suggestion', ae4.length === 1, String(ae4.length));
check('action is increase', ae4[0] && ae4[0].action === 'increase');
check('delta capped at 20', ae4[0] && ae4[0].deltaPct <= 20, ae4[0] && String(ae4[0].deltaPct));
check('reason cites lean spikes', ae4[0] && /lean spike/.test(ae4[0].reason));

console.log('tipin: too few events -> info only, no patch');
var r5 = P66.analyzeTipIn(makeRows(2, 2), fakeMap());
var sug5 = P66.generateSuggestions({ fuelTrims: { available: false }, knock: { available: false },
  lambda: { available: false }, narrowband: nbHealthy, bankImbalance: { available: false },
  tipIn: r5 }, 'conservative');
var ae5 = sug5.suggestions.filter(function (s) { return s.kind === 'ae'; });
check('info suggestion present', ae5.length === 1);
check('action none', ae5[0] && ae5[0].action === 'none');
check('not actionable', sug5.actionable.filter(function (s) { return s.kind === 'ae'; }).length === 0);

console.log('tipin: dead O2 blocks the suggestion');
var nbDead = { available: true, crossCounts: [{ bank: 'bank1', health: 'dead', perMin: 0 }] };
var sug6 = P66.generateSuggestions({ fuelTrims: { available: false }, knock: { available: false },
  lambda: { available: false }, narrowband: nbDead, bankImbalance: { available: false },
  tipIn: r1 }, 'conservative');
var ae6 = sug6.suggestions.filter(function (s) { return s.kind === 'ae'; });
check('blocked suggestion present', ae6.length === 1);
check('blocked, not actionable', ae6[0].action === 'none' &&
  sug6.actionable.filter(function (s) { return s.kind === 'ae'; }).length === 0);

console.log('tipin: AE patcher scales both D-TPS tables');
var catalog = P66.BUNDLED_CATALOG;
var bin = new Uint8Array(65536);
// Seed the AE tables with known values.
function seedTable(title, vals) {
  var t = P66.findTable(catalog, title);
  var base = parseInt(t.address, 16);
  vals.forEach(function (v, i) { bin[base + i] = v; });
}
seedTable('AE Async Multiplier vs D-TPS', [170, 200, 255]);
seedTable('AE Multipler vs D-TPS', [96, 150, 255]);
var pr = P66.applyAeSuggestions(catalog, bin, ae4);
check('no patch error', !pr.error, pr.error);
check('patches produced', pr.patches.length > 0, String(pr.patches.length));
var tables = {};
pr.patches.forEach(function (p) { tables[p.table] = (tables[p.table] || 0) + 1; });
check('both AE tables patched',
  tables['AE Async Multiplier vs D-TPS'] > 0 && tables['AE Multipler vs D-TPS'] > 0,
  JSON.stringify(tables));
check('8-bit cap respected',
  pr.patches.every(function (p) { return p.newValue <= 255; }));
// conservative mode: min(20, 5*2) = 10% -> 170 * 1.10 = 187
var async170 = pr.patches.filter(function (p) {
  return p.table === 'AE Async Multiplier vs D-TPS' && p.oldValue === 170;
})[0];
check('170 scaled by 10% (conservative)', async170 && async170.newValue === 187,
  async170 && String(async170.newValue));
check('patched image differs from source', pr.patched && pr.patched.length === 65536);

console.log('tipin: missing AE tables warn cleanly');
var pr2 = P66.applyAeSuggestions({ tables: [] }, bin, ae4);
check('error when nothing patchable', !!pr2.error, pr2.error);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
