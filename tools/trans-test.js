/* Transmission analysis + tuning tests.
 * Run: node tools/trans-test.js
 *
 * Covers: gear inference from RPM/VSS (mph + kph auto-detect), upshift /
 * downshift detection, flare (shift slipping) measurement, TCC apply /
 * release detection, kickdown delay measurement, shift-hunting detection,
 * suggestion gating, the trans patchers (line pressure, downshift
 * schedule, hysteresis), the kickdown structural cap (downshift may never
 * reach its upshift cell), and the patch-ledger trans guardrail.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/tuner.js',
 'js/xdf-map.js', 'js/ledger.js', 'js/verify.js', 'js/bundled-catalog.js'].forEach(function (f) {
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
    RPM: { column: 'rpm' }, VSS: { column: 'vss' }, TPS: { column: 'tps' }
  }, unmapped: [] };
}

// 4L60E RPM/MPH band centers used by the analyzer.
var BAND = { 1: 136, 2: 72, 3: 44.5, 4: 31 };
function rpmFor(gear, mph, slip) {
  return Math.round(mph * BAND[gear] * (slip || 1));
}
function cruise(rows, n, gear, mph, tps, slip) {
  for (var i = 0; i < n; i++) rows.push({ rpm: rpmFor(gear, mph, slip), vss: mph, tps: tps });
  return rows;
}
// An upshift: steady in the old gear, a quick ratio sweep (with optional
// flare = RPM spike mid-shift), then steady in the new gear.
function upshift(rows, fromGear, toGear, mph, tps, flareRpm) {
  cruise(rows, 10, fromGear, mph, tps, 1.05);
  var r0 = rpmFor(fromGear, mph, 1.05), r1 = rpmFor(toGear, mph, 1.02);
  var steps = 4;
  for (var s = 1; s <= steps; s++) {
    var r = r0 + (r1 - r0) * (s / steps);
    if (flareRpm && s === 2) r = r0 + flareRpm; // slipping clutch: RPM flares
    rows.push({ rpm: Math.round(r), vss: mph, tps: tps });
  }
  cruise(rows, 10, toGear, mph, tps, 1.02);
  return rows;
}
function downshift(rows, fromGear, toGear, mph, tps) {
  cruise(rows, 10, fromGear, mph, tps, 1.02);
  var r0 = rpmFor(fromGear, mph, 1.02), r1 = rpmFor(toGear, mph, 1.05);
  for (var s = 1; s <= 4; s++) {
    rows.push({ rpm: Math.round(r0 + (r1 - r0) * (s / 4)), vss: mph, tps: tps });
  }
  cruise(rows, 10, toGear, mph, tps, 1.05);
  return rows;
}

console.log('trans: gear inference + shift detection');
var rows = [];
cruise(rows, 30, 4, 55, 18, 1.02);
upshift(rows, 1, 2, 22, 30, 0);
cruise(rows, 20, 2, 30, 25, 1.03);
upshift(rows, 2, 3, 38, 30, 0);
cruise(rows, 20, 3, 45, 22, 1.03);
upshift(rows, 3, 4, 55, 25, 0);
cruise(rows, 30, 4, 58, 18, 1.02);
var r = P66.analyzeTransmission(rows, fakeMap());
check('available', r.available === true, r.reason);
check('vss read as mph', r.vssUnit === 'mph', r.vssUnit);
check('3 upshifts found', r.upshifts === 3, String(r.upshifts));
check('shift 1-2 rpm sane', r.avgShiftRpm12 > 2800 && r.avgShiftRpm12 < 3600, String(r.avgShiftRpm12));
check('gear 4 has most samples', r.gearSamples[4] > r.gearSamples[1], JSON.stringify(r.gearSamples));

console.log('trans: kph auto-detect');
var krows = [];
for (var k = 0; k < 60; k++) krows.push({ rpm: 1700, vss: 88.5, tps: 18 }); // 55 mph in kph
var rk = P66.analyzeTransmission(krows, fakeMap());
check('kph detected', rk.vssUnit === 'kph->mph', rk.vssUnit);
check('kph cruise reads gear 4', rk.gearSamples[4] >= 58, JSON.stringify(rk.gearSamples));

console.log('trans: flare detection');
var frows = [];
cruise(frows, 20, 2, 32, 30, 1.03);
upshift(frows, 2, 3, 38, 35, 220); // slipping 2-3: +220 RPM flare
cruise(frows, 20, 3, 45, 25, 1.02);
upshift(frows, 3, 4, 58, 30, 0);   // clean 3-4
cruise(frows, 20, 4, 60, 20, 1.02);
var rf = P66.analyzeTransmission(frows, fakeMap());
check('2 upshifts', rf.upshifts === 2, String(rf.upshifts));
check('1 flared', rf.flaredShifts === 1, String(rf.flaredShifts));
check('flare magnitude ~220', rf.flaredDetail[0] && Math.abs(rf.flaredDetail[0].flareRpm - 220) < 60,
  JSON.stringify(rf.flaredDetail[0]));

console.log('trans: TCC apply/release');
var trows = [];
cruise(trows, 40, 4, 55, 18, 1.12); // converter open: ratio reads high
cruise(trows, 40, 4, 55, 18, 1.0);  // TCC locked: ratio at band floor
cruise(trows, 40, 4, 55, 18, 1.12); // released again
var rt = P66.analyzeTransmission(trows, fakeMap());
check('1 apply detected', rt.tccApplies === 1, String(rt.tccApplies));
check('1 release detected', rt.tccReleases === 1, String(rt.tccReleases));

console.log('trans: kickdown delay');
// Tight kickdown: stab, short pause, then the downshift lands inside the
// detection window with a >1.5 s delay (slow).
var drows = [];
cruise(drows, 30, 4, 55, 20, 1.02);
drows.push({ rpm: rpmFor(4, 55, 1.02), vss: 55, tps: 65 }); // the stab
for (var d = 0; d < 8; d++) drows.push({ rpm: rpmFor(4, 55, 1.02), vss: 55, tps: 65 });
var kd0 = rpmFor(4, 55, 1.02), kd1 = rpmFor(3, 55, 1.05);
for (var s2 = 1; s2 <= 4; s2++) drows.push({ rpm: Math.round(kd0 + (kd1 - kd0) * s2 / 4), vss: 55, tps: 62 });
cruise(drows, 20, 3, 55, 55, 1.03);
var rd = P66.analyzeTransmission(drows, fakeMap());
check('1 kickdown', rd.kickdowns === 1, String(rd.kickdowns));
check('delay measured and slow (>1.5 s)',
  rd.avgKickdownDelaySec !== null && rd.avgKickdownDelaySec > 1.5,
  String(rd.avgKickdownDelaySec));

console.log('trans: missing kickdown');
var mrows = [];
cruise(mrows, 30, 4, 55, 20, 1.02);
mrows.push({ rpm: rpmFor(4, 55, 1.02), vss: 55, tps: 65 });
cruise(mrows, 40, 4, 55, 65, 1.02); // stays in 4th: no kickdown
var rm = P66.analyzeTransmission(mrows, fakeMap());
check('stab counted, no downshift', rm.kickdowns === 1 && rm.kickdownNoShift === 1,
  rm.kickdowns + '/' + rm.kickdownNoShift);

console.log('trans: shift hunting');
var hrows = [];
cruise(hrows, 30, 4, 52, 22, 1.02);
for (var h = 0; h < 3; h++) { // 3-4-3-4-3-4: six reversals
  downshift(hrows, 4, 3, 50, 25);
  upshift(hrows, 3, 4, 52, 22, 0);
}
cruise(hrows, 30, 4, 52, 22, 1.02);
var rh = P66.analyzeTransmission(hrows, fakeMap());
check('hunting episode found', rh.huntingEpisodes >= 1, String(rh.huntingEpisodes));

console.log('trans: needs RPM+VSS');
var bad = P66.analyzeTransmission([{ rpm: 1500, tps: 20 }], { mapping: { RPM: { column: 'rpm' } }, unmapped: [] });
check('unavailable without VSS', bad.available === false);

function miniReport(transmission) {
  return { transmission: transmission,
    fuelTrims: { available: false }, knock: { available: false },
    lambda: { available: false }, narrowband: { available: false },
    tipIn: { available: false }, peEntry: { available: false } };
}

console.log('trans: suggestions — firmness from flare');
// Three flaring 2-3 upshifts, spaced >300 samples apart so the
// intervening 3-2 downshifts don't read as hunting.
var srows = [];
for (var sf = 0; sf < 3; sf++) {
  cruise(srows, 15, 2, 30, 30, 1.03);
  upshift(srows, 2, 3, 38, 35, 200);
  cruise(srows, 15, 3, 45, 25, 1.02);
  downshift(srows, 3, 2, 32, 25);
  cruise(srows, 320, 2, 30, 28, 1.03);
}
var sugs = P66.generateSuggestions(miniReport(P66.analyzeTransmission(srows, fakeMap())), 'conservative');
var firm = sugs.actionable.filter(function (s) { return s.kind === 'trans-firmness'; });
check('firmness suggested', firm.length === 1, JSON.stringify(sugs.actionable.map(function (s) { return s.kind; })));
check('firmness delta 5% in conservative', firm[0] && firm[0].deltaPct === 5, String(firm[0] && firm[0].deltaPct));

console.log('trans: suggestions — kickdown from slow kickdown');
// Three slow kickdowns: stab, pause, late downshift (missing-kickdown also
// qualifies — a stab with no downshift at all is the strongest evidence).
var k2rows = [];
for (var kk = 0; kk < 3; kk++) {
  cruise(k2rows, 20, 4, 58, 20, 1.02);
  k2rows.push({ rpm: rpmFor(4, 58, 1.02), vss: 58, tps: 65 });
  for (var w = 0; w < 8; w++) k2rows.push({ rpm: rpmFor(4, 58, 1.02), vss: 58, tps: 65 });
  var q0 = rpmFor(4, 58, 1.02), q1 = rpmFor(3, 58, 1.05);
  for (var q = 1; q <= 4; q++) k2rows.push({ rpm: Math.round(q0 + (q1 - q0) * q / 4), vss: 58, tps: 62 });
  cruise(k2rows, 15, 3, 58, 55, 1.03);
  upshift(k2rows, 3, 4, 60, 30, 0);
  cruise(k2rows, 10, 4, 60, 20, 1.02);
}
var sugs2 = P66.generateSuggestions(miniReport(P66.analyzeTransmission(k2rows, fakeMap())), 'balanced');
var kick = sugs2.actionable.filter(function (s) { return s.kind === 'trans-kickdown'; });
check('kickdown suggested', kick.length === 1, JSON.stringify(sugs2.actionable.map(function (s) { return s.kind; })));
check('kickdown raises (positive delta)', kick[0] && kick[0].deltaPct > 0, String(kick[0] && kick[0].deltaPct));

console.log('trans: suggestions — hunting');
var sugs3 = P66.generateSuggestions(miniReport(rh), 'conservative');
var hunt = sugs3.actionable.filter(function (s) { return s.kind === 'trans-hunting'; });
check('hunting suggested', hunt.length === 1, JSON.stringify(sugs3.actionable.map(function (s) { return s.kind; })));

console.log('trans: patcher — line pressure region targeting');
var bin = new Uint8Array(fs.readFileSync(path.join(ROOT, 'defs', 'bins', 'stock-1995-camaro-l32.bin')));
var cat = P66.BUNDLED_CATALOG;
var firmSug = [{ kind: 'trans-firmness', table: 'Main Line Pressure', action: 'increase',
  deltaPct: 8, region: { mph: 60, from: 3, to: 4 }, confidence: 'high' }];
var pr = P66.applyTransSuggestions(cat, bin, firmSug);
check('no error', !pr.error, pr.error);
check('patches produced', pr.patches.length > 0, String(pr.patches.length));
var lpTables = {};
pr.patches.forEach(function (p) { lpTables[p.table] = (lpTables[p.table] || 0) + 1; });
check('both pressure tables touched',
  lpTables['Main Line Pressure 0-64MPH'] > 0 && lpTables['Main Line Pressure 64-128MPH'] > 0,
  JSON.stringify(lpTables));
var mphs = pr.patches.map(function (p) { return p.mph; });
check('patches within ±10 MPH of 60',
  Math.min.apply(null, mphs) >= 50 && Math.max.apply(null, mphs) <= 70,
  Math.min.apply(null, mphs) + '..' + Math.max.apply(null, mphs));
// Verify a patch actually raised the byte.
var p0 = pr.patches[0];
check('byte raised ~8%', pr.patched[p0.address] === Math.min(255, Math.round(p0.oldValue * 1.08)),
  p0.oldValue + '->' + pr.patched[p0.address]);

console.log('trans: patcher — kickdown cap vs upshift schedule');
var kickSug = [{ kind: 'trans-kickdown', table: 'Normal Downshifts', action: 'raise',
  deltaPct: 8, region: { mph: 55 }, confidence: 'medium' }];
// Chained the way the app does it: kickdown patches on top of the
// firmness stage's image.
var kr2 = P66.applyTransSuggestions(cat, pr.patched, kickSug);
check('no error', !kr2.error, kr2.error);
check('downshift patches produced', kr2.patches.length > 0, String(kr2.patches.length));
// Structural guard: no downshift cell may reach 90% of its matching upshift cell.
var upLabels = ['1-2', '2-3', '3-4'];
var capOk = true, capDetail = '';
kr2.patches.forEach(function (p) {
  if (p.table !== 'Normal Downshifts') return;
  // find row/col of this address in the downshift table
  var base = parseInt('0x85C2', 16);
  var idx = p.address - base, col = idx % 3, row = Math.floor(idx / 3);
  var mirror = ['2-1', '3-2', '4-3'][col].split('-').reverse().join('-');
  var uc = upLabels.indexOf(mirror);
  var upBase = parseInt('0x858F', 16);
  var upVal = kr2.patched[upBase + row * 3 + uc];
  if (!(p.newValue < upVal * 0.9 + 1)) { capOk = false; capDetail = p.addressHex + ':' + p.newValue + ' vs up ' + upVal; }
});
check('downshift < 90% of matching upshift cell', capOk, capDetail);
var raised = kr2.patches.every(function (p) { return p.newValue >= p.oldValue; });
check('all kickdown moves raise (never lower)', raised);

console.log('trans: patcher — hunting widens hysteresis');
var huntSug = [{ kind: 'trans-hunting', table: 'Normal Upshifts/Downshifts', action: 'widen',
  deltaPct: 5, region: { mph: 52, tps: 22, pair: '3-4' }, confidence: 'medium' }];
var hr = P66.applyTransSuggestions(cat, kr2.patched, huntSug);
var upP = hr.patches.filter(function (p) { return p.table === 'Normal Upshifts'; });
var dnP = hr.patches.filter(function (p) { return p.table === 'Normal Downshifts'; });
check('upshift cells raised', upP.length > 0 && upP.every(function (p) { return p.newValue > p.oldValue; }),
  String(upP.length));
check('downshift cells lowered', dnP.length > 0 && dnP.every(function (p) { return p.newValue < p.oldValue; }),
  String(dnP.length));

console.log('trans: patcher — hunting pair normalization (downshift-first episode)');
var huntSug2 = [{ kind: 'trans-hunting', table: 'Normal Upshifts/Downshifts', action: 'widen',
  deltaPct: 5, region: { mph: 21, tps: 10.59, pair: '3-2' }, confidence: 'medium' }];
var hr2 = P66.applyTransSuggestions(cat, bin, huntSug2);
var upP2 = hr2.patches.filter(function (p) { return p.table === 'Normal Upshifts'; });
var dnP2 = hr2.patches.filter(function (p) { return p.table === 'Normal Downshifts'; });
check('downshift-first pair still patches both tables', upP2.length > 0 && dnP2.length > 0,
  upP2.length + '/' + dnP2.length);

console.log('trans: patcher — verify + ledger guard');
// All three stages chained above (firmness -> kickdown -> hunting), so the
// final image carries everything the patch lists claim.
var allP = pr.patches.concat(kr2.patches, hr.patches);
var final = hr.patched;
var v = P66.verifyPatches(cat, bin, { patches: allP, patched: final, error: null });
check('verify ok', v.ok, JSON.stringify(v.failures && v.failures.slice(0, 2)));
var ledger = P66.createLedger(P66._ledgerMemoryStore());
// Simulate two aggressive sessions on the same cell to trip the ±20% guard.
var cellPatch = { table: 'Main Line Pressure 0-64MPH', addressHex: '0x8F25', deltaPct: 12 };
ledger.record('fp1', [cellPatch], {});
var warns = ledger.check('fp1', [{ table: 'Main Line Pressure 0-64MPH', addressHex: '0x8F25', deltaPct: 10 }]);
check('ledger warns past ±20% cumulative', warns.length === 1 && /20/.test(warns[0].message),
  JSON.stringify(warns.map(function (w) { return w.message; })));

console.log('trans: PCM shift-time channels + TCC channel');
function chanMap() {
  return { mapping: {
    RPM: { column: 'rpm' }, VSS: { column: 'vss' }, TPS: { column: 'tps' },
    TCC: { column: 'tcc' }, SHIFT_T12: { column: 'st12' }
  }, unmapped: [] };
}
var crows = [];
for (var ci = 0; ci < 30; ci++) crows.push({ rpm: 1700, vss: 55, tps: 18, tcc: 0, st12: 0.68 });
for (var cj = 0; cj < 30; cj++) crows.push({ rpm: 1700, vss: 55, tps: 18, tcc: 100, st12: 0.68 });
for (var ck = 0; ck < 30; ck++) crows.push({ rpm: 1700, vss: 55, tps: 18, tcc: 0, st12: 0.72 });
var rch = P66.analyzeTransmission(crows, chanMap());
check('tcc read from channel', rch.tccSource === 'channel', rch.tccSource);
check('channel apply+release', rch.tccApplies === 1 && rch.tccReleases === 1,
  rch.tccApplies + '/' + rch.tccReleases);
check('pcm 1-2 shifts counted on change', rch.pcmShiftCount12 === 1, String(rch.pcmShiftCount12));
check('pcm typical 1-2 time', rch.pcmTypicalShift12 === 0.72, String(rch.pcmTypicalShift12));

console.log('trans: TCC cycling is report-only');
// Two full lock/unlock cycles at cruise -> the report-only suggestion.
var crows = [];
cruise(crows, 40, 4, 55, 18, 1.12);
cruise(crows, 40, 4, 55, 18, 1.0);
cruise(crows, 40, 4, 55, 18, 1.12);
cruise(crows, 40, 4, 55, 18, 1.0);
var rc = P66.analyzeTransmission(crows, fakeMap());
var tccSugs = P66.generateSuggestions(miniReport(rc), 'aggressive');
var tcc = tccSugs.suggestions.filter(function (s) { return s.kind === 'trans-tcc'; });
check('2+ tcc cycles seen', rc.tccCycles >= 2, String(rc.tccCycles));
check('tcc suggestion exists but blocked', tcc.length === 1 && tcc[0].action === 'none',
  JSON.stringify(tccSugs.actionable.map(function (s) { return s.kind; })));

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
