/* Trim heatmap tests: per-cell BLM/INT aggregation on the fuel-trim grid,
 * bin-edge alignment with analyzeFuelTrims, blue-positive/red-negative
 * color reuse, thin-data de-emphasis, empty cells, and warmup/transient
 * gating reuse.
 * Run: node tools/trim-heatmap-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/channel-mapper.js', 'js/log-parser.js', 'js/analyzer.js', 'js/dashboard.js',
 'js/trim-heatmap.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function parseRgb(s) {
  var m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(s);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function fakeMap() {
  return { mapping: {
    RPM: { column: 'rpm' }, MAP: { column: 'map' },
    TPS: { column: 'tps' }, ECT: { column: 'ect' },
    STFT: { column: 'stft' }, LTFT: { column: 'ltft' }
  }, unmapped: [] };
}

// Fixture: steady cruise rows, a thin cell, cold rows, transient rows.
function makeTable() {
  var lines = ['rpm,map,tps,ect,stft,ltft'];
  var i, rows = [];
  function row(rpm, map, tps, ect, stft, ltft, region) {
    lines.push([rpm, map, tps, ect, stft, ltft].join(','));
    rows.push(region || 'cruise');
  }
  // 40 steady rows: bin 2500-3000 x 60-70, blm=6 int=2
  for (i = 0; i < 40; i++) row(2600, 65, 25, 200, 2, 6);
  // 8 steady rows: bin 500-1000 x 30-40, blm=-4 int=-3 (thin: n<25)
  for (i = 0; i < 8; i++) row(800, 35, 0, 200, -3, -4);
  // 10 cold rows in the main cell's bin: must be gated (ECT 120 < 160)
  for (i = 0; i < 10; i++) row(2600, 65, 25, 120, 50, 50);
  // 3 transient rows (marked via pre-segmented regions): must be gated
  for (i = 0; i < 3; i++) row(2600, 65, 25, 200, 50, 50, 'transient');
  var t = P66.parseLogText(lines.join('\n'));
  t.regions = rows;
  return t;
}

var mapResult = fakeMap();
var t = makeTable();
var features = P66.extractFeatures(t, mapResult);
var hm = P66.buildTrimHeatmap(t, features, { mapResult: mapResult });

function cellAt(rpmBin, mapBin) {
  var ri = hm.rpmBins.indexOf(rpmBin), mi = hm.mapBins.indexOf(mapBin);
  return (ri === -1 || mi === -1) ? undefined : hm.cells[mi][ri];
}

console.log('trim-heatmap: build');
check('available', hm.available === true);
check('rpm bins seen', hm.rpmBins.join(',') === '500-1000,2500-3000', hm.rpmBins.join(','));
check('map bins seen', hm.mapBins.join(',') === '30-40,60-70', hm.mapBins.join(','));

var main = cellAt('2500-3000', '60-70');
var thin = cellAt('500-1000', '30-40');
var empty = cellAt('500-1000', '60-70');

console.log('trim-heatmap: per-cell BLM/INT averaging');
check('main cell blmAvg', main && main.blmAvg === 6, main && String(main.blmAvg));
check('main cell intAvg', main && main.intAvg === 2, main && String(main.intAvg));
check('main cell count', main && main.count === 40, main && String(main.count));
check('thin cell values', thin && thin.blmAvg === -4 && thin.intAvg === -3,
  thin && JSON.stringify(thin));

console.log('trim-heatmap: bin-edge alignment with analyzeFuelTrims');
check('edges match fuel-trim grid', P66.TRIM_HEATMAP_RPM_WIDTH === 500 &&
  P66.TRIM_HEATMAP_MAP_WIDTH === 10);
check('labels identical to analyzer bins', !!cellAt('2500-3000', '60-70') && !!cellAt('500-1000', '30-40'));
var fr = P66.analyzeFuelTrims(t, mapResult, features);
var byKey = {};
fr.cells.forEach(function (c) { byKey[c.rpmBin + '|' + c.mapBin] = c; });
var alignOk = true;
hm.mapBins.forEach(function (mb, mi) {
  hm.rpmBins.forEach(function (rb, ri) {
    var c = hm.cells[mi][ri];
    if (!c) return;
    var f = byKey[rb + '|' + mb];
    if (!f || !near(c.blmAvg + c.intAvg, f.avgTrim, 0.02)) alignOk = false;
  });
});
check('blm+int == combined trim per cell (same bins)', alignOk);

console.log('trim-heatmap: warmup/transient gating reused');
check('gated 10 cold rows', hm.gating.gatedWarmup === 10, JSON.stringify(hm.gating));
check('gated 3 transient rows', hm.gating.gatedTransient === 3, JSON.stringify(hm.gating));
check('cold/transient trims excluded from main cell', main && main.count === 40 && main.blmAvg === 6);

console.log('trim-heatmap: color mapping follows the trim convention');
var blue = parseRgb(P66._trimColor(10)), red = parseRgb(P66._trimColor(-10));
check('_trimColor positive is blue', blue && blue[2] > blue[0] && blue[2] > blue[1], P66._trimColor(10));
check('_trimColor negative is red', red && red[0] > red[2] && red[0] > red[1], P66._trimColor(-10));
check('_trimColor zero is neutral', P66._trimColor(0) === 'rgb(38,48,62)', P66._trimColor(0));
// Fallback (dashboard not loaded) must be the identical mapping.
var saved = P66._trimColor;
delete P66._trimColor;
var fallbackOk = true;
[-10, -4, -0.5, 0, 2.5, 7, 10].forEach(function (v) {
  if (P66._trimHeatmapColor(v) !== saved(v)) fallbackOk = false;
});
P66._trimColor = saved;
check('fallback color identical to dashboard mapping', fallbackOk);

console.log('trim-heatmap: render HTML');
var htmlBlm = P66.renderTrimHeatmapHTML(hm, { layer: 'blm' });
var htmlInt = P66.renderTrimHeatmapHTML(hm, { layer: 'int' });
check('renders a grid table', /<table class="trim-grid">/.test(htmlBlm) &&
  /<thead>/.test(htmlBlm) && /<tbody>/.test(htmlBlm));
check('blm layer colors by BLM value', htmlBlm.indexOf('background:' + P66._trimColor(6)) !== -1);
check('int layer colors by INT value', htmlInt.indexOf('background:' + P66._trimColor(2)) !== -1);
check('default layer is blm', P66.renderTrimHeatmapHTML(hm).indexOf('data-layer="blm"') !== -1);
check('toggle needs no recompute (same object)', htmlBlm.indexOf('+6.00%') !== -1 &&
  htmlInt.indexOf('+2.00%') !== -1 && htmlInt.indexOf('background:' + P66._trimColor(6)) === -1);

console.log('trim-heatmap: thin-data de-emphasis');
check('thin flag set', thin && thin.thin === true && main.thin === false);
check('thin cell marked in html', /trim-thin/.test(htmlBlm));
check('thin tooltip names n and thin data', /n=8 — thin data/.test(htmlBlm));

console.log('trim-heatmap: empty cells');
check('empty cell is null in grid', empty === null);
check('empty cell neutral with no-data tooltip',
  htmlBlm.indexOf('background:#141a23') !== -1 &&
  htmlBlm.indexOf('no data') !== -1);
check('empty heatmap renders neutral message',
  P66.renderTrimHeatmapHTML(null).indexOf('No fuel trim data') !== -1 &&
  P66.renderTrimHeatmapHTML({ available: false }).indexOf('No fuel trim data') !== -1);

console.log('trim-heatmap: unavailable cases');
var noMap = P66.buildTrimHeatmap(t, features, {});
check('needs mapResult', noMap.available === false);
var noTrim = P66.buildTrimHeatmap(t, features,
  { mapResult: { mapping: { RPM: { column: 'rpm' }, MAP: { column: 'map' } }, unmapped: [] } });
check('needs trim channels', noTrim.available === false);

console.log('trim-heatmap: narrowband only — no wideband anywhere');
var src = fs.readFileSync(path.join(ROOT, 'js/trim-heatmap.js'), 'utf8');
// Strip comments — the doc header documents the narrowband-only rule and
// therefore names wideband there; only functional references are banned.
var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check('no wideband references', !/wideband/i.test(code));

console.log('trim-heatmap: ' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
