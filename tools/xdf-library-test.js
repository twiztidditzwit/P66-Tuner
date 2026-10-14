/* XDF library tests.
 * Run: node tools/xdf-library-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/xdf-library.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function done() {
  console.log(checks + ' checks, ' + failures + ' failures.');
  process.exit(failures ? 1 : 0);
}

// ---- pure helpers ----
var r1 = P66.makeXdfRecord('p66-v6.xdf', '<xml/>', []);
check('makeRecord strips extension', r1.name === 'p66-v6');
check('makeRecord records size', r1.size === 6);
check('makeRecord has id + timestamp', !!r1.id && !!r1.addedAt);
var r2 = P66.makeXdfRecord('p66-v6.xdf', '<xml/>', ['p66-v6']);
check('makeRecord dedupes names', r2.name === 'p66-v6 (2)');
var r3 = P66.makeXdfRecord('p66-v6.xdf', '<xml/>', ['p66-v6', 'p66-v6 (2)']);
check('makeRecord dedupes twice', r3.name === 'p66-v6 (3)');

var sorted = P66.sortXdfRecords([
  { name: 'old', addedAt: '2020-01-01T00:00:00.000Z' },
  { name: 'new', addedAt: '2026-01-01T00:00:00.000Z' }
]);
check('sortRecords newest first', sorted[0].name === 'new');

// ---- library roundtrip on the memory backend ----
var lib = P66.createXdfLibrary(P66.xdfMemoryBackend());
var savedId = null;
lib.save('p66-v6.xdf', '<XDF/>')
  .then(function (rec) {
    savedId = rec.id;
    check('save resolves record', rec.name === 'p66-v6' && !!rec.id);
    return lib.list();
  })
  .then(function (recs) {
    check('list finds saved record', recs.length === 1 && recs[0].id === savedId);
    return lib.save('p66-v6.xdf', '<XDF/>');
  })
  .then(function (rec2) {
    check('second save dedupes', rec2.name === 'p66-v6 (2)');
    return lib.get(savedId);
  })
  .then(function (rec) {
    check('get returns xml', rec && rec.xml === '<XDF/>');
    return lib.setLastUsed(savedId);
  })
  .then(function () { return lib.getLastUsed(); })
  .then(function (id) {
    check('lastUsed roundtrips', id === savedId);
    return lib.remove(savedId);
  })
  .then(function () { return lib.list(); })
  .then(function (recs) {
    check('remove deletes', recs.length === 1);
    check('removed record gone', recs.every(function (r) { return r.id !== savedId; }));
    return lib.get(savedId);
  })
  .then(function (rec) {
    check('get missing returns null', rec === null);
    return lib.getLastUsed();
  })
  .then(function (id) {
    check('lastUsed survives remove', id === savedId);
    done();
  })
  .catch(function (err) {
    failures++;
    console.log('  FAIL: promise chain — ' + (err && err.message ? err.message : err));
    done();
  });
