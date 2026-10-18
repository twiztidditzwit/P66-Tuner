/* Columnar log-table tests (Phase 1 data foundation).
 *
 * Covers the new P66.parseLogText columnar API:
 *   - parse correctness vs the old row-object semantics
 *   - NaN for missing/empty numeric cells (replaces the old null)
 *   - string-column handling (stringCols, isNumeric)
 *   - colIndex / col() / num() / row() accessors
 *   - delimiter detection unchanged
 *   - legacy adapters: P66.asTable / P66.tableFromRows / P66.filterTable
 *   - segmentRows annotating tables (.regions) and legacy arrays (._region)
 *   - end-to-end: analyzers running directly on a parsed table
 *
 * Run: node tools/columnar-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/channel-mapper.js', 'js/analyzer.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- basic parse -> columnar shape ----
var csv = 'RPM,MAP,TPS,KR\n' +
  '800,32,1.2,0\n' +
  '1200,45,,1.41\n' +
  '2500,70,20,0\n';
var t = P66.parseLogText(csv);
check('headers parsed', JSON.stringify(t.headers) === JSON.stringify(['RPM', 'MAP', 'TPS', 'KR']));
check('rowCount', t.rowCount === 3, String(t.rowCount));
check('columnCount', t.columnCount === 4, String(t.columnCount));
check('delimiter detected', t.delimiter === ',');
check('no warnings on clean log', t.warnings.length === 0, JSON.stringify(t.warnings));
check('columns parallel to headers', t.columns.length === 4);
check('numeric channels are Float32Array',
  t.columns.every(function (c) { return c instanceof Float32Array; }));
check('no stringCols on all-numeric log', Object.keys(t.stringCols).length === 0);
check('colIndex maps names', t.colIndex.RPM === 0 && t.colIndex.KR === 3,
  JSON.stringify(t.colIndex));
check('col() returns the column', t.col('MAP') instanceof Float32Array && t.col('MAP')[1] === 45);
check('col() null for unknown', t.col('NOPE') === null);
check('isNumeric true for numbers', t.isNumeric('RPM') === true);
check('isNumeric false for unknown', t.isNumeric('NOPE') === false);

// ---- NaN for missing (replaces old null) ----
check('empty cell -> NaN', isNaN(t.col('TPS')[1]), String(t.col('TPS')[1]));
check('num() maps NaN -> null', t.num('TPS', 1) === null);
check('num() returns value', t.num('RPM', 2) === 2500);
check('num() null for unknown channel', t.num('NOPE', 0) === null);

// ---- row(i): slow-path compat with OLD semantics ----
var r1 = t.row(1);
check('row() materializes values', r1.RPM === 1200 && Math.abs(r1.KR - 1.41) < 1e-6, JSON.stringify(r1));
check('row() missing -> null (old semantics)', r1.TPS === null, JSON.stringify(r1));
check('row() has all headers', Object.keys(r1).length === 4);

// ---- quoted fields, title line, units row ----
var messy = 'Engine data log recorded on 2026-02-06\n' +
  'RPM,MAP,Note,TPS\n' +
  'RPM,kPa,,%\n' +
  '800,32,"idle, cold",1.2\n' +
  '1200,45,,2.5\n';
var tm = P66.parseLogText(messy);
check('title line skipped', tm.rowCount === 2, String(tm.rowCount));
check('title warning present', tm.warnings.some(function (w) { return /title line/.test(w); }),
  JSON.stringify(tm.warnings));
check('units row skipped', tm.warnings.some(function (w) { return /non-data row/.test(w); }),
  JSON.stringify(tm.warnings));
check('quoted comma preserved in string col', tm.stringCols.Note[0] === 'idle, cold',
  JSON.stringify(tm.stringCols.Note));
check('mixed channel -> stringCols', tm.col('Note') instanceof Array &&
  !(tm.col('Note') instanceof Float32Array));
check('isNumeric false for string channel', tm.isNumeric('Note') === false);
check('numeric sibling unaffected', tm.col('RPM')[0] === 800);
check('empty string cell -> null in stringCols', tm.stringCols.Note[1] === null,
  JSON.stringify(tm.stringCols.Note));
check('num() null on string channel', tm.num('Note', 0) === null);

// ---- duplicate headers ----
var dup = P66.parseLogText('A,A,B\n1,2,3\n');
check('duplicate headers deduped',
  JSON.stringify(dup.headers) === JSON.stringify(['A', 'A_1', 'B']),
  JSON.stringify(dup.headers));
check('colIndex follows dedupe', dup.colIndex.A === 0 && dup.colIndex.A_1 === 1);

// ---- delimiter detection ----
var tsv = P66.parseLogText('RPM\tMAP\n800\t32\n900\t35\n');
check('tab delimiter detected', tsv.delimiter === '\t' && tsv.rowCount === 2,
  tsv.delimiter + ' / ' + tsv.rowCount);
var semi = P66.parseLogText('RPM;MAP\n800;32\n');
check('semicolon delimiter detected', semi.delimiter === ';' && semi.rowCount === 1);
check('detectDelimiter unchanged export', P66.detectDelimiter('a\tb\n1\t2\n') === '\t');

// ---- empty input ----
var te = P66.parseLogText('   \n');
check('empty file -> 0 rows + warning', te.rowCount === 0 && te.warnings.length > 0);

// ---- legacy adapters ----
check('isLogTable true for parsed', P66.isLogTable(t) === true);
check('isLogTable false for array', P66.isLogTable([{ a: 1 }]) === false);
check('asTable identity on table', P66.asTable(t) === t);
check('asTable null -> null', P66.asTable(null) === null);

var legacy = [
  { rpm: 800, tps: '1.5', kr: 0 },
  { rpm: 1200, tps: '', kr: null, _region: 'idle' },
  { rpm: 2500, tps: '20', kr: 2.5, flag: 'OL' }
];
var tl = P66.asTable(legacy);
check('legacy: table created', P66.isLogTable(tl) && tl.rowCount === 3);
check('legacy: numeric strings coerced', tl.col('tps')[0] === 1.5 && tl.col('tps')[2] === 20);
check('legacy: empty/null -> NaN', isNaN(tl.col('tps')[1]) && isNaN(tl.col('kr')[1]));
check('legacy: headers exclude _region', tl.headers.indexOf('_region') === -1,
  JSON.stringify(tl.headers));
check('legacy: _region lifted to regions', tl.regions && tl.regions[1] === 'idle',
  JSON.stringify(tl.regions));
check('legacy: non-numeric channel -> stringCols', tl.isNumeric('flag') === false &&
  tl.stringCols.flag[2] === 'OL');

var shaped = P66.asTable({ headers: ['x'], rows: [{ x: 5 }] });
check('asTable handles {rows} shape', shaped.rowCount === 1 && shaped.col('x')[0] === 5);

// ---- filterTable ----
var tf = P66.filterTable(tl, function (i) { return i !== 1; });
check('filterTable rowCount', tf.rowCount === 2, String(tf.rowCount));
check('filterTable compacts columns', tf.col('rpm')[0] === 800 && tf.col('rpm')[1] === 2500);
check('filterTable keeps stringCols', tf.stringCols.flag[1] === 'OL');
check('filterTable filters regions', tf.regions[0] === undefined && tf.regions[1] === undefined,
  JSON.stringify(tf.regions));

// ---- segmentRows on both shapes ----
var segT = P66.parseLogText(csv);
var segMap = { mapping: {
  RPM: { column: 'RPM' }, MAP: { column: 'MAP' }, TPS: { column: 'TPS' }
}, unmapped: [] };
P66.segmentRows(segT, segMap);
check('segmentRows sets table.regions',
  Array.isArray(segT.regions) && segT.regions.length === 3, JSON.stringify(segT.regions));
check('segmentRows idle detected', segT.regions[0] === 'idle', JSON.stringify(segT.regions));

var segLegacy = [{ rpm: 800, tps: 0.5 }, { rpm: 3000, tps: 1 }];
P66.segmentRows(segLegacy, { mapping: { RPM: { column: 'rpm' }, TPS: { column: 'tps' } }, unmapped: [] });
check('segmentRows mutates legacy rows', segLegacy[0]._region === 'idle' && segLegacy[1]._region === 'cruise',
  JSON.stringify(segLegacy.map(function (r) { return r._region; })));

// ---- end-to-end: analyzers on a parsed table ----
var full = 'RPM,MAP,TPS,KR,STFT,LTFT,ECT\n' +
  '800,32,1,0,2,1,190\n' +
  '2000,45,20,0,3,1,195\n' +
  '2000,45,20,0,3,1,195\n' +
  '3000,80,40,0,2,0,200\n';
var ft = P66.parseLogText(full);
var fmap = { mapping: {
  RPM: { column: 'RPM' }, MAP: { column: 'MAP' }, TPS: { column: 'TPS' },
  KR: { column: 'KR' }, STFT: { column: 'STFT' }, LTFT: { column: 'LTFT' },
  ECT: { column: 'ECT' }
}, unmapped: [] };
P66.segmentRows(ft, fmap);
var ftr = P66.analyzeFuelTrims(ft, fmap);
check('fuel trims run on table', ftr.available === true && ftr.totalSamples === 2,
  JSON.stringify({ a: ftr.available, n: ftr.totalSamples }));
var kn = P66.analyzeKnock(ft, fmap);
check('knock runs on table', kn.available === true && kn.knockEvents === 0);
var q = P66.qualityRows(ft, fmap);
check('qualityRows table -> table', P66.isLogTable(q.rows) && q.rows.rowCount === 2,
  String(q.rows.rowCount));
check('qualityRows gated the 2 transient rows', q.gatedTransient === 2,
  String(q.gatedTransient));
var q2 = P66.qualityRows([{ rpm: 1, ect: 100 }, { rpm: 2, ect: 200 }],
  { mapping: { RPM: { column: 'rpm' }, ECT: { column: 'ect' } }, unmapped: [] });
check('qualityRows legacy -> kept row objects',
  Array.isArray(q2.rows) && q2.rows.length === 1 && q2.rows[0].rpm === 2,
  JSON.stringify(q2.rows));

// ---- real log regression ----
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
if (fs.existsSync(logPath)) {
  var real = P66.parseLogText(fs.readFileSync(logPath, 'utf8'));
  check('real log parses 10576 rows', real.rowCount === 10576, String(real.rowCount));
  check('real log headers non-empty', real.headers.length > 10, String(real.headers.length));
  check('real log RPM numeric', real.isNumeric(real.headers.filter(function (h) { return /rpm/i.test(h); })[0]) !== false);
  var rmap = P66.mapChannels(real.headers);
  var sess = P66.analyzeSession(real, rmap);
  check('analyzeSession on table: 4 knock events', sess.knock.knockEvents === 4,
    String(sess.knock.knockEvents));
  check('analyzeSession rowCount', sess.rowCount === 10576, String(sess.rowCount));
} else {
  console.log('  (skipped real-log checks: yesss.csv not found)');
}

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
