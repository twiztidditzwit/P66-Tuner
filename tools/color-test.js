/* Colormap tests: value ramp, diverging trim ramp, text contrast.
 * Run: node tools/color-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/xdf-map.js', 'js/dashboard.js', 'js/bundled-catalog.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function rgb(s) {
  var m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(s);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

console.log('color: value ramp');
var t0 = rgb(P66._valueRamp(0)), t1 = rgb(P66._valueRamp(1));
check('ramp(0) is the deep indigo stop', t0 && t0.join() === '35,25,70', P66._valueRamp(0));
check('ramp(1) is the red stop', t1 && t1.join() === '215,45,35', P66._valueRamp(1));
var seen = {};
[0, 0.2, 0.4, 0.6, 0.8, 1].forEach(function (t) { seen[P66._valueRamp(t)] = true; });
check('ramp varies across the range (6 distinct colors)', Object.keys(seen).length === 6);
var mid = rgb(P66._valueRamp(0.5));
check('ramp(0.5) is green (multi-hue, not single-hue)',
  mid && mid[1] > mid[0] && mid[1] > mid[2], P66._valueRamp(0.5));
var third = rgb(P66._valueRamp(1 / 3));
check('ramp(1/3) is cyan-ish', third && third[2] > 150 && third[1] > 120, P66._valueRamp(1 / 3));
var lum = [0, 1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6, 1].map(function (t) {
  var c = rgb(P66._valueRamp(t));
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
});
// Spectral ramps peak in lightness at yellow by physics (pure red is darker
// than orange) — assert the peak sits at the yellow stop and the hue order
// reads indigo -> ... -> red via dominant channels at the ends.
check('ramp lightness peaks at the yellow stop',
  lum.indexOf(Math.max.apply(null, lum)) === 4, lum.map(Math.round).join(','));
var firstDom = rgb(P66._valueRamp(0)), lastDom = rgb(P66._valueRamp(1));
check('ramp hue order: blue-dominant start, red-dominant end',
  firstDom[2] > firstDom[0] && lastDom[0] > lastDom[2]);

console.log('color: trim diverging ramp');
var n0 = rgb(P66._trimColor(0));
check('trim(0) is the dark neutral', n0 && n0.join() === '38,48,62', P66._trimColor(0));
var lp = rgb(P66._trimColor(10)), ln = rgb(P66._trimColor(-10));
check('trim(+10) is blue (add fuel = lean)', lp && lp[2] > 200 && lp[0] < 100, P66._trimColor(10));
check('trim(-10) is red (remove fuel = rich)', ln && ln[0] > 200 && ln[2] < 100, P66._trimColor(-10));
var mp = rgb(P66._trimColor(5)), mn = rgb(P66._trimColor(-5));
check('trim(+5) passes through cyan', mp && mp[1] > 150 && mp[2] > 200 && mp[0] < 140, P66._trimColor(5));
check('trim(-5) passes through orange', mn && mn[0] > 200 && mn[1] > 120 && mn[1] < 220 && mn[2] < 120, P66._trimColor(-5));
check('trim clamps beyond +-10', P66._trimColor(99) === P66._trimColor(10) && P66._trimColor(-99) === P66._trimColor(-10));

console.log('color: cell text contrast');
check('dark text on bright yellow', P66._cellTextColor(P66._valueRamp(0.85)) === '#141a23');
check('inherits (light) text on dark indigo end', P66._cellTextColor(P66._valueRamp(0.05)) === '');
check('inherits text on neutral trim', P66._cellTextColor(P66._trimColor(0)) === '');

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
