/* Altitude / baro awareness tests.
 * Run: node tools/altitude-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/altitude.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function fakeMap(withBaro) {
  var mapping = {
    RPM: { column: 'rpm' }, MAP: { column: 'map' }, TPS: { column: 'tps' }
  };
  if (withBaro) mapping.BARO = { column: 'baro' };
  return { mapping: mapping, unmapped: [] };
}

function baroRows(baroKpa, n, wotMap) {
  var rows = [];
  for (var i = 0; i < (n || 100); i++) {
    rows.push({ rpm: 2500, map: 60, tps: 30, baro: baroKpa });
  }
  if (wotMap) {
    for (var j = 0; j < 20; j++) {
      rows.push({ rpm: 4000, map: wotMap, tps: 95, baro: baroKpa });
    }
  }
  return rows;
}

console.log('altitude: standard atmosphere');
check('sea level ~101.3', Math.abs(P66.baroForAltitude(0) - 101.325) < 0.01);
check('2840 ft ~91.3', Math.abs(P66.baroForAltitude(2840) - 91.3) < 0.3,
  'got ' + P66.baroForAltitude(2840).toFixed(2));
check('monotonic decrease', P66.baroForAltitude(5000) < P66.baroForAltitude(2840));
check('negative clamps to sea level', P66.baroForAltitude(-500) === P66.baroForAltitude(0));

console.log('altitude: store defaults and persistence');
var s1 = P66.createAltitudeStore(P66._altitudeMemoryStore());
check('default 2840', s1.get() === 2840, 'got ' + s1.get());
check('set works', s1.set(5280) === true && s1.get() === 5280);
check('rejects garbage', s1.set('nope') === false && s1.get() === 5280);
check('rejects absurd', s1.set(99999) === false);
var shared = P66._altitudeMemoryStore();
var sa = P66.createAltitudeStore(shared);
sa.set(1000);
check('persists across instances', P66.createAltitudeStore(shared).get() === 1000);

console.log('altitude: baro ok (Dale-like values)');
var ok = P66.analyzeBaro(baroRows(93.4), fakeMap(true), 2840);
check('available', ok.available === true);
check('status ok', ok.status === 'ok', ok.status + ' | ' + ok.note);
check('expected ~91.3', Math.abs(ok.expectedKpa - 91.3) < 0.3);

console.log('altitude: faulty baro flagged');
var bad = P66.analyzeBaro(baroRows(101.3), fakeMap(true), 2840);
check('status fault', bad.status === 'fault', bad.status);
check('note blames baro not VE', /baro sensor/.test(bad.note) && /VE/.test(bad.note));

console.log('altitude: warn band');
var warn = P66.analyzeBaro(baroRows(95.0), fakeMap(true), 2840);
check('status warn at 3.7 delta', warn.status === 'warn', warn.status);
check('note suggests checking altitude setting', /altitude/.test(warn.note));

console.log('altitude: WOT MAP above baro flagged');
var wot = P66.analyzeBaro(baroRows(91, 100, 99), fakeMap(true), 2840);
check('wot flag raised', !!wot.wotMapFlag, wot.status);
check('status escalated', wot.status !== 'ok');

console.log('altitude: no BARO channel');
var noch = P66.analyzeBaro(baroRows(91), fakeMap(false), 2840);
check('unavailable with reason', noch.available === false && /No barometric/.test(noch.reason));
check('still reports expected', Math.abs(noch.expectedKpa - 91.3) < 0.3);

console.log('altitude: baro drift noted');
var driftRows = [];
for (var i = 0; i < 100; i++) driftRows.push({ rpm: 2500, map: 60, tps: 30, baro: 87 + i * 0.1 });
var drift = P66.analyzeBaro(driftRows, fakeMap(true), 2840);
check('drift note appended', /drifted/.test(drift.note), drift.note.slice(-80));

console.log('altitude: garbage baro values filtered');
var junk = [{ rpm: 1, map: 1, tps: 1, baro: 0 }, { rpm: 1, map: 1, tps: 1, baro: 999 }];
var j = P66.analyzeBaro(junk, fakeMap(true), 2840);
check('too few valid samples', j.available === false);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
