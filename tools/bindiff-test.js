/* Bin-vs-bin diff tests.
 * Run: node tools/bindiff-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/bundled-catalog.js', 'js/bindiff.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

var STOCK = path.join(ROOT, 'defs/bins/stock-1995-camaro-l32.bin');
var stock = new Uint8Array(fs.readFileSync(STOCK));

// ---- module surface ----
check('diffBins exported', typeof P66.diffBins === 'function');
check('diffSummary exported', typeof P66.diffSummary === 'function');
check('renderDiffHTML exported', typeof P66.renderDiffHTML === 'function');
check('decodeMathEquation exported', typeof P66.decodeMathEquation === 'function');
check('image size constant is 65536', P66.BINDIFF_IMAGE_SIZE === 65536);

// ---- decodeMathEquation: mirrors xdf-map rawPerDegree forms, forward ----
check("decode 'X'", P66.decodeMathEquation('X', 48) === 48);
check("decode 'X*(90/255)'", approx(P66.decodeMathEquation('X*(90/255)', 255), 90));
check("decode 'X/10'", approx(P66.decodeMathEquation('X/10', 50), 5));
check("decode 'X/256'", approx(P66.decodeMathEquation('X/256', 256), 1));
check("decode 'X*(100/255)'", approx(P66.decodeMathEquation('X*(100/255)', 255), 100));
check("decode 'X/2'", approx(P66.decodeMathEquation('X/2', 100), 50));
check('decode with whitespace', approx(P66.decodeMathEquation(' X * (90/255) ', 255), 90));
check("unsupported 'X-128' -> null", P66.decodeMathEquation('X-128', 200) === null);
check("unsupported 'X*X' -> null", P66.decodeMathEquation('X*X', 200) === null);
check("empty equation -> null", P66.decodeMathEquation('', 200) === null);

// ---- identical bins ----
var same = P66.diffBins(stock, new Uint8Array(stock));
check('identical: changedBytes 0', same.changedBytes === 0, 'got ' + same.changedBytes);
check('identical: regions empty', same.regions.length === 0);
check('identical: flag set', same.identical === true);
check('identical: byteCount 65536', same.byteCount === 65536);

var sumSame = P66.diffSummary(same);
check('summary identical: no tables', sumSame.tables.length === 0);
check('summary identical: flag set', sumSame.identical === true);

var htmlSame = P66.renderDiffHTML(same);
check('render identical: contains empty-state string',
  htmlSame.indexOf(P66.BINDIFF_EMPTY_TEXT) !== -1, htmlSame);
check('render identical: empty-state class', htmlSame.indexOf('p66-bindiff-empty') !== -1);

// ---- single-byte change: one region, unlabeled area ----
var one = new Uint8Array(stock);
one[0x400] = stock[0x400] ^ 0xFF;
var d1 = P66.diffBins(stock, one);
check('single byte: 1 region', d1.regions.length === 1);
check('single byte: region length 1',
  d1.regions.length === 1 && d1.regions[0].length === 1);
check('single byte: start 0x400',
  d1.regions.length === 1 && d1.regions[0].start === 0x400 &&
  d1.regions[0].startHex === '0x000400', JSON.stringify(d1.regions[0]));
check('single byte: changedBytes 1', d1.changedBytes === 1);
check('single byte: no catalog tables', d1.regions[0].tables.length === 0);
check('single byte: slices hold old/new',
  d1.regions[0].oldBytes[0] === stock[0x400] && d1.regions[0].newBytes[0] === one[0x400]);

// ---- adjacent changes coalesce; distant changes stay separate ----
var adj = new Uint8Array(stock);
adj[0x200] ^= 0x01; adj[0x201] ^= 0x02; adj[0x202] ^= 0x04;
adj[0x300] ^= 0x08;
var d2 = P66.diffBins(stock, adj);
check('adjacent+gap: 2 regions', d2.regions.length === 2, 'got ' + d2.regions.length);
check('adjacent: first region length 3, 0x200-0x202',
  d2.regions.length === 2 && d2.regions[0].length === 3 &&
  d2.regions[0].start === 0x200 && d2.regions[0].end === 0x202);
check('gap: second region at 0x300',
  d2.regions.length === 2 && d2.regions[1].start === 0x300 && d2.regions[1].length === 1);
check('changedBytes sums across regions',
  d2.changedBytes === d2.regions.reduce(function (a, r) { return a + r.length; }, 0));

// ---- validation ----
function throws(f) { try { f(); return false; } catch (e) { return e; } }
var e1 = throws(function () { P66.diffBins(new Uint8Array(10), stock); });
check('short binA throws', !!e1);
check('error mentions 65536', !!e1 && /65536/.test(e1.message), e1 && e1.message);
check('null binA throws', !!throws(function () { P66.diffBins(null, stock); }));
check('short binB throws', !!throws(function () { P66.diffBins(stock, new Uint8Array(100)); }));

// ---- table labeling on the real stock bin with a synthetic modified copy ----
var mod = new Uint8Array(stock);
// Main VE (0xEAA, 17x13, 16-bit): rewrite first two elements fully.
mod[0xEAA] = 0x12; mod[0xEAA + 1] = 0x34;
mod[0xEAA + 2] = 0x56; mod[0xEAA + 3] = 0x78;
// Main Spark Advance (0x39, 8-bit): single byte.
var sparkOld = stock[0x39];
mod[0x39] = (sparkOld + 17) & 0xFF;
// TPS% Threshold to Enter PE vs RPM (0x917, X*(100/255)): raw 100 -> decode 39.2157.
mod[0x917] = 100;
// Uncatalogued byte.
mod[0x2000] ^= 0xAA;

var d3 = P66.diffBins(stock, mod);
check('4 change sites -> 4 regions', d3.regions.length === 4,
  'got ' + d3.regions.length + ': ' +
  d3.regions.map(function (r) { return r.startHex; }).join(','));

function tableNames(region) {
  return region.tables.map(function (t) { return t.name; });
}
var rVe = d3.regions.filter(function (r) { return r.start === 0xEAA; })[0];
var rSpark = d3.regions.filter(function (r) { return r.start === 0x39; })[0];
var rTps = d3.regions.filter(function (r) { return r.start === 0x917; })[0];
var rUnl = d3.regions.filter(function (r) { return r.start === 0x2000; })[0];
check('Main VE region labeled', !!rVe && tableNames(rVe).indexOf('Main VE') !== -1,
  rVe && JSON.stringify(tableNames(rVe)));
check('Main VE overlap window exact',
  !!rVe && rVe.tables[0].overlapStart === 0xEAA && rVe.tables[0].overlapEnd === 0xEAD,
  rVe && JSON.stringify(rVe.tables[0]));
check('spark region labeled Main Spark Advance',
  !!rSpark && tableNames(rSpark).indexOf('Main Spark Advance') !== -1);
check('TPS threshold region labeled',
  !!rTps && tableNames(rTps).indexOf('TPS% Threshold to Enter PE vs RPM') !== -1);
check('uncatalogued region has no tables', !!rUnl && rUnl.tables.length === 0);

// ---- diffSummary decode sanity ----
var s3 = P66.diffSummary(d3);
function tableEntry(name) {
  return s3.tables.filter(function (t) { return t.name === name; })[0];
}
var tVe = tableEntry('Main VE');
check('summary has Main VE', !!tVe);
check('Main VE decoded (equation X)', !!tVe && tVe.decoded === true);
check('Main VE 2 elements changed, 4 bytes',
  !!tVe && tVe.changedElements === 2 && tVe.changedBytes === 4, tVe && JSON.stringify(tVe));
var veOld0 = (stock[0xEAA] << 8) | stock[0xEAA + 1];
var veOld1 = (stock[0xEAA + 2] << 8) | stock[0xEAA + 3];
check('Main VE old range matches stock raws',
  !!tVe && tVe.oldMin === Math.min(veOld0, veOld1) &&
  tVe.oldMax === Math.max(veOld0, veOld1),
  tVe && tVe.oldMin + '/' + tVe.oldMax + ' vs ' + veOld0 + '/' + veOld1);
check('Main VE new range 0x1234/0x5678',
  !!tVe && tVe.newMin === 0x1234 && tVe.newMax === 0x5678,
  tVe && tVe.newMin + '/' + tVe.newMax);

var tSpark = tableEntry('Main Spark Advance');
check('summary has Main Spark Advance', !!tSpark);
check('spark decoded via X*(90/255)',
  !!tSpark && approx(tSpark.oldMin, sparkOld * (90 / 255)) &&
  approx(tSpark.newMin, ((sparkOld + 17) & 0xFF) * (90 / 255)),
  tSpark && tSpark.oldMin + ' / ' + tSpark.newMin);

var tTps = tableEntry('TPS% Threshold to Enter PE vs RPM');
check('summary has TPS threshold', !!tTps);
check('TPS decode X*(100/255): new = 39.2157',
  !!tTps && approx(tTps.newMin, 100 * (100 / 255), 1e-6),
  tTps && String(tTps.newMin));
check('TPS units present', !!tTps && typeof tTps.units === 'string');

check('unlabeled bytes counted', s3.unlabeled.bytes === 1 && s3.unlabeled.regions === 1,
  JSON.stringify(s3.unlabeled));
check('summary regionCount 4', s3.regionCount === 4);
check('summary changedBytes matches', s3.changedBytes === d3.changedBytes);

// ---- partial element (region boundary inside a 16-bit element) ----
var part = new Uint8Array(stock);
part[0xEAA] ^= 0x01; // first byte of first Main VE element only
var dp = P66.diffBins(stock, part);
var sp = P66.diffSummary(dp);
var tpVe = sp.tables.filter(function (t) { return t.name === 'Main VE'; })[0];
check('partial: 1 changed element', !!tpVe && tpVe.changedElements === 1);
check('partial: flagged', !!tpVe && tpVe.partialElements === 1,
  tpVe && JSON.stringify(tpVe));
check('partial: 1 changed byte', !!tpVe && tpVe.changedBytes === 1);

// ---- renderDiffHTML: non-empty ----
var html = P66.renderDiffHTML(d3);
check('render: contains Main VE', html.indexOf('Main VE') !== -1);
check('render: contains Main Spark Advance', html.indexOf('Main Spark Advance') !== -1);
check('render: contains TPS threshold', html.indexOf('TPS% Threshold to Enter PE vs RPM') !== -1);
check('render: per-table change bar', html.indexOf('p66-bindiff-bar') !== -1);
check('render: old→new arrow', html.indexOf('→') !== -1);
check('render: unlabeled section', html.indexOf('outside catalog tables') !== -1);
check('render: informational note, no flash-safety claim',
  html.indexOf('Informational only') !== -1 && html.indexOf('safe to flash') !== -1 &&
  !/safe to flash/i.test(html.replace(/does not indicate whether a binary is safe to flash/, '')),
  html.slice(html.indexOf('p66-bindiff-note')));
check('render: no empty-state text', html.indexOf(P66.BINDIFF_EMPTY_TEXT) === -1);

// ---- swapped bins still decode (old/new follow argument order) ----
var dSwap = P66.diffBins(mod, stock);
var sSwap = P66.diffSummary(dSwap);
var tSwap = sSwap.tables.filter(function (t) { return t.name === 'Main VE'; })[0];
check('swap: old becomes new',
  !!tSwap && tSwap.oldMin === 0x1234 && tSwap.newMax === Math.max(veOld0, veOld1),
  tSwap && tSwap.oldMin + '/' + tSwap.newMax);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
