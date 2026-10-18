/* Tune journal forum-export tests.
 * Run: node tools/journal-export-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/journal.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function lines(t) { return t.split('\n'); }
function maxLen(t) {
  return lines(t).reduce(function (m, l) { return Math.max(m, l.length); }, 0);
}

console.log('export: exports exist');
check('journalToForumText is a function', typeof P66.journalToForumText === 'function');
check('copyJournalText is a function', typeof P66.copyJournalText === 'function');
check('journalCopyButton is a function', typeof P66.journalCopyButton === 'function');
check('mountJournalExport is a function', typeof P66.mountJournalExport === 'function');

var entries = [
  {
    id: 'j1', date: '2026-10-18T14:00:00.000Z', logName: 'pull2.csv', rows: 10576,
    patchCount: 80, patchKinds: { 'Idle VE': { count: 36, delta: '±3%' }, 'Main VE': { count: 44, delta: '±5%' } },
    note: 'flashed, knock gone at 3000 but idle hunts a little on cold start'
  },
  {
    id: 'j2', date: '2026-10-11T09:30:00.000Z', logName: 'yesss.csv', rows: 10576,
    patchCount: 0, note: 'baseline log, 42% idle, no WOT yet'
  },
  { id: 'j3', date: '2026-10-12T20:00:00.000Z', note: 'no log this session, just thinking about tip-in AE' }
];

console.log('export: format shape');
var t = P66.journalToForumText(entries);
check('header has app name', t.indexOf('P66-Tuner tune journal') === 0);
check('header has date range', t.indexOf('2026-10-11 to 2026-10-18') !== -1);
check('entry date rendered', t.indexOf('2026-10-18') !== -1);
check('log name rendered', t.indexOf('pull2.csv') !== -1);
check('rows rendered', t.indexOf('10,576 rows') !== -1);
check('total patch count rendered', t.indexOf('Patches: 80') !== -1);
check('patch kinds rendered', t.indexOf('Idle VE: 36') !== -1 && t.indexOf('Main VE: 44') !== -1);
check('kind deltas rendered', t.indexOf('±3%') !== -1 && t.indexOf('±5%') !== -1);
check('note rendered', t.indexOf('idle hunts a little') !== -1);
check('entry order preserved', t.indexOf('pull2.csv') < t.indexOf('yesss.csv'));

console.log('export: line length cap');
var longNote = new Array(60).join('word ') + 'finalword';
var tLong = P66.journalToForumText([{ id: 'x', date: '2026-10-18T00:00:00.000Z', note: longNote }]);
check('long notes wrapped to <=100', maxLen(tLong) <= 100, 'max=' + maxLen(tLong));
check('all sample lines <=100', maxLen(t) <= 100, 'max=' + maxLen(t));
check('no HTML tags', !/<[a-z][^>]*>/i.test(t));

console.log('export: empty journal');
var tEmpty = P66.journalToForumText([]);
check('empty message present', tEmpty.indexOf('No journal entries yet') !== -1);
check('empty still has header', tEmpty.indexOf('P66-Tuner tune journal') === 0);
check('empty lines <=100', maxLen(tEmpty) <= 100);
check('non-array input safe', P66.journalToForumText(null).indexOf('P66-Tuner') === 0);

console.log('export: safety footer');
check('footer mentions bench-verify', t.indexOf('bench-verify') !== -1);
check('footer mentions before flashing', t.indexOf('before flashing') !== -1);
check('footer disclaims checksum', t.indexOf('checksum') !== -1);
check('footer never implies safety', t.indexOf('safe to flash') === -1 && t.indexOf('is safe') === -1);

console.log('export: journal.add passes new fields through');
var j = P66.createJournal(P66._journalMemoryStore());
var e = j.add({ note: 'x', logName: 'a.csv', rows: 500, patchKinds: { VE: { count: 3, delta: '+2%' } } });
check('rows stored', e.rows === 500);
check('patchKinds stored', !!e.patchKinds && e.patchKinds.VE.count === 3);
var tStored = P66.journalToForumText(j.list());
check('stored entry formats', tStored.indexOf('a.csv') !== -1 && tStored.indexOf('VE: 3 (+2%)') !== -1);

console.log('export: copyJournalText under node');
var threw = false, res;
try { res = P66.copyJournalText(entries); } catch (err) { threw = true; }
check('does not throw', !threw);
check('returns false under node', res === false);

console.log('export: copyJournalText with fake clipboard');
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: function () { return Promise.resolve(); } } },
  configurable: true, writable: true
});
var p = P66.copyJournalText(entries);
check('returns a promise with clipboard', p && typeof p.then === 'function');
p.then(function (ok) {
  check('clipboard copy resolves true', ok === true);
  delete globalThis.navigator;
  finish();
}, function (err) {
  check('clipboard copy rejects', false, String(err));
  delete globalThis.navigator;
  finish();
});

function finish() {
  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}
