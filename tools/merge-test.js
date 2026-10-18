/* Multi-log session merge tests (Phase 1, item 4).
 *
 * Covers js/log-merge.js (P66.mergeLogTables / P66.mergeCompatible /
 * P66.SRC_LOG):
 *   - union of headers with NaN fill for missing numeric channels
 *   - string-channel merge and numeric-vs-string coercion to string
 *   - _srclog provenance column correctness (Uint16Array, per-row source)
 *   - mergeCompatible warnings (no shared channels, type clashes, empties)
 *   - merged table analyzes cleanly through P66.analyzeSession
 *   - worker transport round-trip keeps a merged table analyzable
 *   - report provenance lists every merged filename + row count
 *   - KEY CORRECTNESS TEST: yesss.csv split into two halves, merged, then
 *     analyzed — the report must be identical to analyzing the whole file
 *     at once.
 *
 * Run: node tools/merge-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/log-parser.js', 'js/log-merge.js', 'js/channel-mapper.js', 'js/segments.js',
 'js/altitude.js', 'js/analyzer.js', 'js/analyze-async.js', 'js/report.js'
].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// NaN-tolerant deep equal (report math can legitimately contain NaN).
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && a !== a && b !== b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(function (k) {
    return Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]);
  });
}

console.log('1. union merge with NaN fill');
var t1 = P66.parseLogText(
  'RPM,MAP,TPS\n800,32,1.2\n1200,45,2.0\n2500,70,20.0\n3000,83,25.0\n');
var t2 = P66.parseLogText(
  'RPM,MAP,KR\n900,35,0\n1500,55,1.4\n2800,90,0\n');
var m = P66.mergeLogTables([t1, t2], [{ name: 'a.csv' }, { name: 'b.csv' }]);
check('rowCount concatenates in order', m.rowCount === 7, String(m.rowCount));
check('headers are the union, first-seen order',
  JSON.stringify(m.headers) === JSON.stringify(['RPM', 'MAP', 'TPS', 'KR', '_srclog']),
  JSON.stringify(m.headers));
check('P66.SRC_LOG is _srclog', P66.SRC_LOG === '_srclog');
check('values preserved from first table', m.num('RPM', 0) === 800 && m.num('TPS', 3) === 25);
check('values preserved from second table', m.num('RPM', 4) === 900 && m.num('KR', 6) === 0);
check('missing numeric channel fills NaN (TPS in log 2)',
  m.num('TPS', 4) === null && isNaN(m.col('TPS')[5]), String(m.num('TPS', 4)));
check('missing numeric channel fills NaN (KR in log 1)',
  m.num('KR', 0) === null && isNaN(m.col('KR')[2]));
check('shared channels still dense', m.num('MAP', 1) === 45 && m.num('MAP', 5) === 55);

console.log('2. _srclog provenance column');
var srclogCol = m.columns[m.colIndex._srclog];
check('_srclog storage is Uint16Array', srclogCol instanceof Uint16Array);
check('_srclog marks source index per row',
  JSON.stringify(Array.prototype.slice.call(srclogCol)) === '[0,0,0,0,1,1,1]',
  JSON.stringify(Array.prototype.slice.call(srclogCol)));
check('col() exposes _srclog', m.col('_srclog') === srclogCol);
check('num() reads _srclog', m.num('_srclog', 0) === 0 && m.num('_srclog', 6) === 1);
check('_srclog is not a mapped signal',
  P66.mapChannels(m.headers).unmapped.indexOf('_srclog') !== -1);
check('row() slow path handles _srclog',
  m.row(4)._srclog === 1 && m.row(0)._srclog === 0 && m.row(4).TPS === null);

console.log('3. string channels');
var s1 = P66.parseLogText('RPM,FLAG\n800,open\n1200,closed\n');
var s2 = P66.parseLogText('RPM,NOTE\n900,idle\n1500,cruise\n');
var ms = P66.mergeLogTables([s1, s2], [{ name: 's1.csv' }, { name: 's2.csv' }]);
check('string channel values preserved', ms.col('FLAG')[0] === 'open' && ms.col('FLAG')[1] === 'closed');
check('missing string channel fills null', ms.col('NOTE')[0] === null && ms.col('NOTE')[2] === 'idle');
check('isNumeric false for string channel', ms.isNumeric('FLAG') === false);
check('isNumeric true for numeric channel', ms.isNumeric('RPM') === true);

console.log('4. numeric-vs-string clash coerces to string');
var c1 = P66.parseLogText('RPM,STATE\n800,3\n1200,7\n');
var c2 = P66.parseLogText('RPM,STATE\n900,hot\n1500,cold\n');
var mc = P66.mergeLogTables([c1, c2], [{ name: 'c1.csv' }, { name: 'c2.csv' }]);
check('clashed channel merged as string',
  mc.isNumeric('STATE') === false && mc.col('STATE')[0] === '3' && mc.col('STATE')[2] === 'hot',
  JSON.stringify(mc.col('STATE')));
var cc = P66.mergeCompatible([c1, c2]);
check('mergeCompatible warns on the clash',
  cc.ok === true && cc.problems.some(function (p) { return /STATE/.test(p); }),
  JSON.stringify(cc.problems));

console.log('5. mergeCompatible pre-checks');
var d1 = P66.parseLogText('AAA,BBB\n1,2\n');
var d2 = P66.parseLogText('CCC,DDD\n3,4\n');
var dc = P66.mergeCompatible([d1, d2]);
check('warns when logs share no channels',
  dc.ok === true && dc.problems.some(function (p) { return /no common channels/.test(p); }),
  JSON.stringify(dc.problems));
check('empty input is not ok', P66.mergeCompatible([]).ok === false);
check('all-empty tables are not ok',
  P66.mergeCompatible([P66.parseLogText('')]).ok === false);
var sc = P66.mergeCompatible([t1]);
check('single table is compatible with no warnings',
  sc.ok === true && sc.problems.length === 0, JSON.stringify(sc.problems));
var oc = P66.mergeCompatible([t1, t2]);
check('overlapping tables merge cleanly',
  oc.ok === true && oc.problems.length === 0, JSON.stringify(oc.problems));

console.log('6. reserved _srclog name in a source log');
var r1 = P66.parseLogText('RPM,_srclog\n800,99\n');
var mr = P66.mergeLogTables([r1, t2], [{ name: 'r.csv' }, { name: 'b.csv' }]);
check('source _srclog renamed, merge provenance wins',
  mr.headers.indexOf('_srclog_orig') !== -1 && mr.num('_srclog', 0) === 0,
  JSON.stringify(mr.headers));

console.log('7. merged table analyzes cleanly');
var map = P66.mapChannels(m.headers);
var rep = P66.analyzeSession(m, map, { altitudeFt: 2840 });
check('report rowCount matches merged rows', rep.rowCount === 7, String(rep.rowCount));
check('report shape sane',
  !!rep.regionDistribution && Array.isArray(rep.missingChannels),
  Object.keys(rep).slice(0, 8).join(','));

console.log('8. worker transport round-trip on a merged table');
var transport = P66.tableToTransport(m);
var rebuilt = P66.tableFromTransport(transport);
var repRebuilt = P66.analyzeSession(rebuilt, map, { altitudeFt: 2840 });
check('analysis identical after worker-style round-trip', deepEq(rep, repRebuilt));
check('source table columns not neutered by transport',
  m.col('RPM')[0] === 800 && m.columns[m.colIndex._srclog][6] === 1);

console.log('9. provenance in the merged table and the report');
check('logSources lists both files',
  deepEq(m.logSources, [{ name: 'a.csv', rows: 4 }, { name: 'b.csv', rows: 3 }]),
  JSON.stringify(m.logSources));
check('logName joins filenames', m.logName === 'a.csv + b.csv', String(m.logName));
var rdata = P66.buildReportData(m, map);
check('report data carries logSources',
  rdata.logSources && rdata.logSources.length === 2 &&
  rdata.logSources[0].name === 'a.csv' && rdata.logSources[1].rows === 3,
  JSON.stringify(rdata.logSources));

console.log('10. yesss.csv split/merge identity (key correctness test)');
var logPath = path.join(process.env.HOME, 'workspace/user/files/yesss.csv');
if (fs.existsSync(logPath)) {
  var text = fs.readFileSync(logPath, 'utf8');
  var lines = text.split(/\r?\n/);
  // Header = the line with the most fields among the first few non-blank
  // lines (mirrors the parser's own header detection).
  var headerIdx = 0, headerFields = 0;
  for (var li = 0; li < Math.min(10, lines.length); li++) {
    if (!lines[li].trim()) continue;
    var fc = lines[li].split(',').length;
    if (fc > headerFields) { headerFields = fc; headerIdx = li; }
  }
  var headerLine = lines[headerIdx];
  var dataLines = lines.slice(headerIdx + 1).filter(function (l) { return l.trim().length > 0; });
  var half = Math.floor(dataLines.length / 2);
  var halfAText = headerLine + '\n' + dataLines.slice(0, half).join('\n') + '\n';
  var halfBText = headerLine + '\n' + dataLines.slice(half).join('\n') + '\n';
  var h1 = P66.parseLogText(halfAText);
  var h2 = P66.parseLogText(halfBText);
  check('halves cover all 10576 rows', h1.rowCount + h2.rowCount === 10576,
    h1.rowCount + ' + ' + h2.rowCount);
  var mergedY = P66.mergeLogTables([h1, h2],
    [{ name: 'yesss-a.csv', rows: h1.rowCount }, { name: 'yesss-b.csv', rows: h2.rowCount }]);
  check('merged headers are whole-file headers plus _srclog', (function () {
    var whole0 = P66.parseLogText(text);
    var mh = mergedY.headers.filter(function (h) { return h !== P66.SRC_LOG; });
    return JSON.stringify(mh) === JSON.stringify(whole0.headers) &&
      mergedY.headers[mergedY.headers.length - 1] === P66.SRC_LOG;
  })());
  var whole = P66.parseLogText(text);
  var ymap = P66.mapChannels(whole.headers);
  var rWhole = P66.analyzeSession(whole, ymap, { altitudeFt: 2840 });
  var rMerged = P66.analyzeSession(mergedY, ymap, { altitudeFt: 2840 });
  check('merged analysis report deep-equals whole-file analysis', deepEq(rWhole, rMerged));
  check('merged provenance lists both halves',
    deepEq(mergedY.logSources,
      [{ name: 'yesss-a.csv', rows: h1.rowCount }, { name: 'yesss-b.csv', rows: h2.rowCount }]));
  var ydata = P66.buildReportData(mergedY, ymap);
  check('report subtitle names both halves',
    ydata.logSources.length === 2 && ydata.logSources[0].name === 'yesss-a.csv');
} else {
  console.log('  (skipped real-log checks: yesss.csv not found)');
}

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
