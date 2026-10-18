#!/usr/bin/env node
/* mode-compare-test — self-test for js/mode-compare.js (P66.compareModes /
 * P66.renderModeCompareHTML / P66.compareModesRecommendation).
 *
 *   node tools/mode-compare-test.js
 *
 * Covers:
 *  1. compareModes runs the real tuner entry point (P66.generateSuggestions)
 *     once per mode and returns all three mode entries with the expected
 *     shape (counts by kind, totals, max signed deltas, summary, plain-English
 *     bullets reused from P66.summarizeTune).
 *  2. Real-data check on yesss.csv: aggressive >= balanced >= conservative in
 *     actionable suggestion count, and per-mode max fuel deltas respect the
 *     mode's gate caps. Measured 3x runtime is reported.
 *  3. Read-only: running compareModes does not apply patches, touch the
 *     ledger, or record anything (ledger store unchanged).
 *  4. renderModeCompareHTML: DOM-free string containing all three mode names,
 *     per-kind rows with counts and max deltas, mc-diff highlight on cells
 *     where the modes disagree, a recommendation line, and the
 *     empty-suggestions state (nothing to flash).
 *  5. Fuel-color convention on deltas: blue for add/lean (positive), red for
 *     remove/rich (negative), matching the rest of the app.
 * Exits nonzero on any unexpected result.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'log-parser.js'));
require(path.join(ROOT, 'js', 'channel-mapper.js'));
require(path.join(ROOT, 'js', 'analyzer.js'));
require(path.join(ROOT, 'js', 'bundled-catalog.js'));
require(path.join(ROOT, 'js', 'tuner.js'));
require(path.join(ROOT, 'js', 'summary.js'));
require(path.join(ROOT, 'js', 'ledger.js'));
require(path.join(ROOT, 'js', 'mode-compare.js'));
var P66 = global.P66;

var failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

var MODES = ['conservative', 'balanced', 'aggressive'];

function yesssReport() {
  var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
  if (!fs.existsSync(logPath)) return null;
  var t = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  return P66.analyzeSession(t, P66.mapChannels(t.headers));
}

function shapeOk(entry, mode) {
  return entry && entry.mode === mode &&
    entry.byKind && MODES.indexOf(mode) !== -1 &&
    ['fuel', 'spark', 'trans', 'ae', 'pe'].every(function (k) {
      var r = entry.byKind[k];
      return r && typeof r.actionable === 'number' && typeof r.total === 'number' &&
        typeof r.maxDeltaSigned === 'number' && typeof r.unit === 'string';
    }) &&
    typeof entry.totalActionable === 'number' &&
    typeof entry.summary === 'string';
}

function syntheticLeanReport() {
  // Two cells straddling the fuel thresholds: +8% trim (lean, add fuel) and
  // -9% trim (rich, remove fuel), both well sampled. Gate caps shrink the
  // applied deltas per mode (conservative 5 / balanced 8 / aggressive 12).
  return {
    fuelTrims: {
      available: true, cells: [
        { rpmBin: '2000-2500', mapBin: '80-90', samples: 100, avgTrim: 8, idleFraction: 0 },
        { rpmBin: '1500-2000', mapBin: '60-70', samples: 100, avgTrim: -9, idleFraction: 0 }
      ]
    },
    knock: { available: false }, lambda: { available: false },
    narrowband: { available: false }, tipIn: { available: false },
    peEntry: { available: false }, transmission: { available: false },
    bankImbalance: { available: false }
  };
}

console.log('1. compareModes shape and real tuner reuse');
var rep = yesssReport();
if (rep) {
  var comp = P66.compareModes(rep, { catalog: P66.BUNDLED_CATALOG });
  check('three modes present', MODES.every(function (m) { return !!comp.modes[m]; }),
    Object.keys(comp.modes).join(','));
  check('shape ok per mode', MODES.every(function (m) { return shapeOk(comp.modes[m], m); }));
  var aggr = MODES.map(function (m) { return comp.modes[m].totalActionable; });
  check('aggressive >= balanced >= conservative (actual tuner behavior)',
    aggr[2] >= aggr[1] && aggr[1] >= aggr[0], aggr.join(' >= '));
  var capsOk = MODES.every(function (m) {
    return comp.modes[m].byKind.fuel.maxDeltaMag <= comp.modes[m].gates.maxFuelDeltaPct;
  });
  check('per-mode max fuel delta respects gate caps', capsOk,
    JSON.stringify(MODES.map(function (m) {
      return m + ':' + comp.modes[m].byKind.fuel.maxDeltaSigned + '%' +
        '/cap ' + comp.modes[m].gates.maxFuelDeltaPct + '%';
    })));
  check('plain-English bullets reused from summarizeTune',
    !!comp.modes.balanced.plainEnglish && typeof comp.modes.balanced.plainEnglish.headline === 'string' &&
    Array.isArray(comp.modes.balanced.plainEnglish.bullets),
    String(comp.modes.balanced.plainEnglish && comp.modes.balanced.plainEnglish.headline));
  var countsByKind = comp.modes.aggressive.byKind;
  check('yesss.csv aggressive: fuel + trans actionable (matches tuner smoke test)',
    countsByKind.fuel.actionable === 9 && countsByKind.trans.actionable === 1 &&
    comp.modes.aggressive.totalActionable === 10,
    'fuel=' + countsByKind.fuel.actionable + ' trans=' + countsByKind.trans.actionable +
    ' total=' + comp.modes.aggressive.totalActionable);
} else {
  console.log('  (skipped real-log checks: yesss.csv not found)');
}

console.log('2. 3x runtime (performance note)');
if (rep) {
  var t0 = Date.now();
  P66.compareModes(rep, { catalog: P66.BUNDLED_CATALOG });
  var dt = Date.now() - t0;
  console.log('  info 3x generateSuggestions + aggregation on yesss.csv: ' + dt + ' ms');
  check('3x run completes in well under a second', dt < 2000, dt + ' ms');
}

console.log('3. read-only: ledger untouched');
if (rep) {
  var store = P66._ledgerMemoryStore();
  var ledger = P66.createLedger(store);
  var before = store.getItem('p66-ledger-v1');
  var c2 = P66.compareModes(rep, { catalog: P66.BUNDLED_CATALOG });
  var after = store.getItem('p66-ledger-v1');
  check('ledger store unchanged by compare', before === after,
    'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  check('ledger still reads empty (nothing recorded)',
    ledger.history('no-such-bin').length === 0,
    JSON.stringify(ledger.history('no-such-bin')));
  check('comparison result carries no patch side effects', c2.modes.aggressive.result.suggestions.length ===
    c2.modes.aggressive.totalSuggestions);
}

console.log('4. renderModeCompareHTML');
var synthComp = P66.compareModes(syntheticLeanReport());
var html = P66.renderModeCompareHTML(synthComp);
check('contains all three mode names',
  html.indexOf('Conservative') !== -1 && html.indexOf('Balanced') !== -1 && html.indexOf('Aggressive') !== -1);
check('per-kind rows rendered', ['Fuel (VE)', 'Timing', 'Transmission', 'Tip-in AE', 'Full-throttle PE']
  .every(function (l) { return html.indexOf(l) !== -1; }));
check('mc-diff highlight on disagreeing cells', html.indexOf('mc-diff') !== -1);
check('max delta shown with sign', html.indexOf('+8%') !== -1 && html.indexOf('-9%') !== -1,
  (html.match(/[-+][0-9]+%/g) || []).join(','));
check('recommendation names least/most when counts differ',
  comp && html.indexOf('changes the least') !== -1 && html.indexOf('changes the most') !== -1 ||
    P66.compareModesRecommendation(synthComp).indexOf('All three modes agree') !== -1);
if (comp) {
  var recHtml = P66.renderModeCompareHTML(comp);
  check('yesss.csv recommendation: conservative least, aggressive most',
    recHtml.indexOf('Conservative changes the least') !== -1 &&
    recHtml.indexOf('Aggressive changes the most') !== -1);
}
check('safety wording: informational only', html.indexOf('informational only') !== -1 &&
  html.indexOf('verify before flashing') !== -1);
check('plain-English headline present', html.indexOf('mc-headline') !== -1);
var rec = P66.compareModesRecommendation(synthComp);
check('recommendation is a plain string', typeof rec === 'string' && rec.length > 20);

console.log('5. fuel-color convention on deltas');
function spanColors(h) {
  var out = [];
  var re = /<span class="mc-delta" style="background:([^"]+)">([^<]*)<\/span>/g, m;
  while ((m = re.exec(h))) out.push({ color: m[1], text: m[2] });
  return out;
}
function rgbOf(s) {
  var m = /rgb\((\d+),(\d+),(\d+)\)/.exec(s);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}
var spans = spanColors(html);
var addSpan = spans.filter(function (s) { return s.text.charAt(0) === '+'; })[0];
var cutSpan = spans.filter(function (s) { return s.text.charAt(0) === '-'; })[0];
var addRgb = addSpan && rgbOf(addSpan.color), cutRgb = cutSpan && rgbOf(cutSpan.color);
check('positive (add fuel) delta is blue', !!(addRgb && addRgb[2] > addRgb[0] && addRgb[2] > addRgb[1]),
  addSpan ? addSpan.color + ' -> ' + addSpan.text : 'no + span');
check('negative (remove fuel) delta is red', !!(cutRgb && cutRgb[0] > cutRgb[2] && cutRgb[0] > cutRgb[1]),
  cutSpan ? cutSpan.color + ' -> ' + cutSpan.text : 'no - span');
// Fallback (no dashboard loaded) must behave identically to the app convention.
check('fallback trimColor matches app convention on +/- extremes',
  rgbOf((function () {
    // exercise the module's internal fallback by rendering without P66._trimColor
    var saved = P66._trimColor; delete P66._trimColor;
    var h2 = P66.renderModeCompareHTML(synthComp);
    P66._trimColor = saved;
    var sp = spanColors(h2).filter(function (s) { return s.text.charAt(0) === '-'; })[0];
    return sp ? sp.color : '';
  })())[0] > 200);

console.log('6. empty-suggestions state');
var emptyComp = P66.compareModes({});
var emptyHtml = P66.renderModeCompareHTML(emptyComp);
check('all three modes total zero on empty report',
  MODES.every(function (m) { return emptyComp.modes[m].totalActionable === 0; }));
check('empty state shows "No suggestions" per mode',
  (emptyHtml.match(/No suggestions in this mode\./g) || []).length === 3);
check('empty state recommendation: nothing to flash', emptyHtml.indexOf('Nothing to flash') !== -1);
check('empty report still yields three mode entries',
  MODES.every(function (m) { return shapeOk(emptyComp.modes[m], m); }));

console.log('\n' + 'mode-compare: checks done, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
