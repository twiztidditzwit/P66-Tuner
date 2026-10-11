/* Tune journal tests.
 * Run: node tools/journal-test.js
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

console.log('journal: add and list');
var j1 = P66.createJournal(P66._journalMemoryStore());
var e1 = j1.add({ logName: 'pull1.csv', patchCount: 80, note: 'flashed, knock gone at 3000' });
check('add returns entry with id', !!e1 && !!e1.id);
check('entry keeps fields', e1.logName === 'pull1.csv' && e1.patchCount === 80);
check('entry dated', !!e1.date);
check('list has it', j1.list().length === 1);

console.log('journal: newest first');
var e2 = j1.add({ note: 'second note' });
check('newest first', j1.list()[0].id === e2.id);

console.log('journal: rejects empty notes');
var e3 = j1.add({ note: '   ' });
check('empty note refused', e3 === null);
check('list unchanged', j1.list().length === 2);

console.log('journal: remove');
j1.remove(e2.id);
check('removed', j1.list().length === 1 && j1.list()[0].id === e1.id);

console.log('journal: persists across instances');
var store = P66._journalMemoryStore();
var ja = P66.createJournal(store);
ja.add({ note: 'hello' });
var jb = P66.createJournal(store);
check('second instance sees it', jb.list().length === 1 && jb.list()[0].note === 'hello');

console.log('journal: caps at 50');
var j2 = P66.createJournal(P66._journalMemoryStore());
for (var i = 0; i < 55; i++) j2.add({ note: 'note ' + i });
var all = j2.list();
check('capped', all.length === 50, 'len=' + all.length);
check('keeps newest', all[0].note === 'note 54' && all[49].note === 'note 5');

console.log('journal: clear');
j2.clear();
check('cleared', j2.list().length === 0);

console.log('journal: corrupt storage is safe');
var bad = P66._journalMemoryStore();
bad.setItem('p66-journal-v1', 'not json{{{');
var j3 = P66.createJournal(bad);
check('loads empty on corrupt data', j3.list().length === 0);
var e4 = j3.add({ note: 'recovery works' });
check('can still add', !!e4 && j3.list().length === 1);

console.log('\n' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);
