#!/usr/bin/env node
/* guard-test — self-test for the layered binary safety guard.
 *
 *   node tools/guard-test.js
 *
 * Proves, against the real stock binaries:
 *   1. Dale's stock bin passes at ok level (closest match 16212614,
 *      high confidence), and every archive bin passes ok ranking itself first.
 *   2. A non-P66 / random 64KB image blocks (as do wrong-size and empty images).
 *   3. A slightly-modified P66 image warns — both via the family lattice and
 *      via the dense-stable layer when the sparse lattice still reads 100%.
 *   4. A one-byte nudge between the two closest '95 cals yields an ambiguous
 *      ranking with top candidates listed, never a claimed identity.
 *   5. Guard messages never present a single matched calibration as proven
 *      fact, and the fingerprint module is internally consistent.
 * Exits nonzero on any unexpected result.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'fingerprints.js'));
require(path.join(ROOT, 'js', 'safety.js'));
var P66 = global.P66;

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function loadBin(p) { return new Uint8Array(fs.readFileSync(path.join(ROOT, p))); }
var stockBin = loadBin('defs/bins/stock-1995-camaro-l32.bin');
var archive = {
  '16212614': loadBin('defs/bins/bcc/cal-16212614-95-f-auto-fed.bin'),
  '16212294': loadBin('defs/bins/bcc/cal-16212294-95-f-auto-fed.bin'),
  '16212604': loadBin('defs/bins/bcc/cal-16212604-95-f-auto-fed.bin'),
  '16203281': loadBin('defs/bins/bcc/cal-16203281-94-f-auto-fed.bin'),
  '16203271': loadBin('defs/bins/bcc/cal-16203271-94-f-auto-cal.bin')
};

function inSkip(off) {
  return P66.FINGERPRINT.skip.some(function (r) { return off >= r[0] && off < r[1]; });
}
function onFamilyLattice(off) { return off % P66.FINGERPRINT.stride === 0; }
var discSet = {};
P66.DISCRIMINANT.offsets.forEach(function (o) { discSet[o] = true; });

console.log('1. stock bins pass at ok with honest closest-match reporting');
var g = P66.checkBinary(stockBin);
check('Dale stock bin level ok', g.level === 'ok', g.level);
check('closest match 16212614', g.matchedCal === '16212614', g.matchedCal);
check('confidence high', g.confidence === 'high', g.confidence);
check('top candidate 100%', g.candidates[0] && g.candidates[0].calId === '16212614' && g.candidates[0].pct === 100,
  JSON.stringify(g.candidates.slice(0, 2)));
check('family 100%', g.detail.familyPct === 100, String(g.detail.familyPct));
check('dense 100%', g.detail.densePct === 100, String(g.detail.densePct));
check('landmarks 100%', g.detail.landmarkPct === 100, String(g.detail.landmarkPct));
check('anchors 100%', g.detail.anchorPct === 100, String(g.detail.anchorPct));
var msg = g.messages.join(' ');
check('says closest known, not verified identity',
  /Closest known stock calibration: 16212614/.test(msg), msg.slice(0, 120));
check('no proven-identity phrasing',
  !/matches stock P66 calibration|Verified: this binary matches/.test(msg), msg.slice(0, 120));
check('honesty note present', /best-match estimate/.test(msg));

Object.keys(archive).forEach(function (calId) {
  var r = P66.checkBinary(archive[calId]);
  check(calId + ' ok + ranks itself first at 100%',
    r.level === 'ok' && r.matchedCal === calId && r.candidates[0].pct === 100,
    r.level + ' ' + r.matchedCal + ' ' + JSON.stringify(r.candidates[0]));
});

console.log('2. non-P66 images block');
var rnd = new Uint8Array(65536);
var seed = 12345;
for (var i = 0; i < rnd.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rnd[i] = seed & 0xFF; }
var gr = P66.checkBinary(rnd);
check('random 64KB blocked', gr.level === 'block', gr.level + ' ' + gr.matchPct + '%');
check('no candidates on block', gr.candidates.length === 0);
check('wrong size blocked', P66.checkBinary(new Uint8Array(100)).level === 'block');
check('all-FF blocked', P66.checkBinary(new Uint8Array(65536).fill(0xFF)).level === 'block');
check('all-00 blocked', P66.checkBinary(new Uint8Array(65536).fill(0)).level === 'block');

console.log('3. modified P66 images warn');
// 3a. bytes flipped exactly on dense-stable sample points (but off the sparse
//     family lattice and outside landmark/anchor spans): the sparse lattice
//     still reads 100%, but the dense-stable layer sees the modification ->
//     warn, not ok.
function inLandmark(off) {
  return P66.LANDMARKS.windows.some(function (w) { return off >= w.addr && off < w.addr + w.hex.length / 2; });
}
function inAnchorSpan(off) {
  return P66.TABLE_ANCHORS.tables.some(function (t) {
    return off >= t.address && off < t.address + t.rows * t.cols * (t.bits / 8);
  });
}
var sneaky = new Uint8Array(stockBin);
var sneakyOffs = P66.STABLE_DENSE.offsets.filter(function (o) {
  return !onFamilyLattice(o) && !inLandmark(o) && !inAnchorSpan(o);
}).slice(0, 3);
check('test offsets usable', sneakyOffs.length === 3, sneakyOffs.join(','));
sneakyOffs.forEach(function (o) { sneaky[o] ^= 0xFF; });
var gs = P66.checkBinary(sneaky);
check('3-byte tune warns (dense layer)', gs.level === 'warn', gs.level);
check('family still 100%', gs.detail.familyPct === 100, String(gs.detail.familyPct));
check('dense below 100%', gs.detail.densePct < 100, String(gs.detail.densePct));
check('warn message cites dense deviation', /dense-stable samples differ/.test(gs.messages.join(' ')));
// 3b. flips on the family lattice: 12 -> warn, 80 -> block (matches verify-test).
function tamperAt(bin, count) {
  var out = new Uint8Array(bin);
  var fp = P66.FINGERPRINT, done = 0;
  for (var s = 0; s < 100000 && done < count; s++) {
    var off = s * fp.stride;
    if (off >= out.length) break;
    if (inSkip(off)) continue;
    out[off] ^= 0xFF; done++;
  }
  return out;
}
var g12 = P66.checkBinary(tamperAt(stockBin, 12));
check('12 lattice flips warn', g12.level === 'warn', g12.level + ' ' + g12.matchPct + '%');
var g80 = P66.checkBinary(tamperAt(stockBin, 80));
check('80 lattice flips block', g80.level === 'block', g80.level + ' ' + g80.matchPct + '%');

console.log('4. ambiguous ranking lists candidates instead of naming one cal');
// 16212614 and 16212294 differ at exactly 2 discriminant addresses; flip one
// toward 16212294 so both rank 346/347 -> tie -> ambiguous.
var sep = P66.DISCRIMINANT.offsets.filter(function (o) {
  return archive['16212614'][o] !== archive['16212294'][o];
});
check('two separators between 16212614/16212294', sep.length === 2, sep.join(','));
var nudge = new Uint8Array(archive['16212614']);
nudge[sep[0]] = archive['16212294'][sep[0]];
var ga = P66.checkBinary(nudge);
check('nudged bin still ok-track', ga.level === 'ok' || ga.level === 'warn', ga.level);
check('confidence ambiguous', ga.confidence === 'ambiguous', ga.confidence);
check('top two candidates listed',
  ga.candidates.length >= 2 &&
  ((ga.candidates[0].calId === '16212614' && ga.candidates[1].calId === '16212294') ||
   (ga.candidates[0].calId === '16212294' && ga.candidates[1].calId === '16212614')),
  JSON.stringify(ga.candidates.slice(0, 2)));
check('tie at 346/347', ga.candidates[0].pct === ga.candidates[1].pct,
  ga.candidates[0].pct + ' vs ' + ga.candidates[1].pct);
check('ambiguous message names candidates',
  /Cannot name a single closest calibration/.test(ga.messages.join(' ')) &&
  /16212614/.test(ga.messages.join(' ')) && /16212294/.test(ga.messages.join(' ')));

console.log('5. fingerprint module internally consistent');
check('discriminant hex lengths match offsets',
  P66.DISCRIMINANT.cals.every(function (c) { return c.hex.length === P66.DISCRIMINANT.offsets.length * 2; }));
check('dense hex length matches offsets',
  P66.STABLE_DENSE.hex.length === P66.STABLE_DENSE.offsets.length * 2);
check('dense offsets in bounds + skip cal-ID',
  P66.STABLE_DENSE.offsets.every(function (o) { return o >= 0 && o < 65536 && !inSkip(o); }));
check('landmark windows in bounds',
  P66.LANDMARKS.windows.every(function (w) { return w.addr + w.hex.length / 2 <= 65536; }));
check('anchor tables in bounds',
  P66.TABLE_ANCHORS.tables.every(function (t) {
    var cells = t.rows * t.cols, bytes = cells * (t.bits / 8);
    return t.address >= 0 && t.address + bytes <= 65536 &&
      t.anchors.every(function (a) { return a.r < t.rows && a.c < t.cols; });
  }));
check('discriminant excludes cal-ID fields',
  P66.DISCRIMINANT.offsets.every(function (o) { return !inSkip(o); }));

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
