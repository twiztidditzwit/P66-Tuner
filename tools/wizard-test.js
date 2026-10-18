/* First-run wizard tests (pure logic + node-safe behavior).
 * js/wizard.js builds DOM in the browser, but all of its step order,
 * validation, navigation, hook payloads, and dismissal memory are pure and
 * covered here. Run: node tools/wizard-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/wizard.js'].forEach(function (f) {
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

function fakeFile(name, size) { return { name: name, size: size }; }

// ---- step order ----
check('exports 3 steps', P66.WIZARD_STEPS.length === 3);
check('step 1 is log', P66.WIZARD_STEPS[0].key === 'log');
check('step 2 is bin', P66.WIZARD_STEPS[1].key === 'bin');
check('step 3 is mode', P66.WIZARD_STEPS[2].key === 'mode');
check('steps have titles + intros', P66.WIZARD_STEPS.every(function (s) { return !!s.title && !!s.intro; }));
check('modes are easy + advanced', P66.WIZARD_MODES.map(function (m) { return m.id; }).join(',') === 'easy,advanced');

// ---- validation blocks advance without files ----
var s1 = P66.createWizardState({});
check('starts at step 0', s1.index === 0 && s1.progress().label === 'Step 1 of 3');
check('log step blocks without files', s1.canAdvance().ok === false);
check('log step gives a reason', !!s1.canAdvance().message);
check('next() refuses without files', s1.next() === false && s1.index === 0);

s1.logFiles = [fakeFile('drive1.csv', 1234), fakeFile('drive2.csv', 2345)];
check('log step passes with files', s1.canAdvance().ok === true);
check('next() advances with files', s1.next() === true && s1.index === 1);
check('bin step blocks without file', s1.canAdvance().ok === false);
check('next() refuses at bin step without file', s1.next() === false && s1.index === 1);

s1.binFile = fakeFile('stock.bin', 65536);
check('bin step passes with file', s1.canAdvance().ok === true);

// ---- onFilesReady payload ----
var payload = null;
var s2 = P66.createWizardState({
  onFilesReady: function (p) { payload = p; },
  onModeSelect: function (m) { payload = payload || {}; payload.mode = m; }
});
s2.logFiles = [fakeFile('a.csv', 100), fakeFile('b.csv', 200)];
s2.binFile = fakeFile('stock.bin', 65536);
s2.next(); // -> bin step
s2.next(); // -> mode step (fires onFilesReady)
check('onFilesReady fires leaving bin step', !!payload && Array.isArray(payload.logFiles));
check('payload carries both log files', payload.logFiles.length === 2 && payload.logFiles[0].name === 'a.csv');
check('payload carries bin file', payload.binFile && payload.binFile.name === 'stock.bin');
check('payload xdfSource is built-in', payload.xdfSource === 'built-in');
check('lands on mode step', s2.index === 2 && s2.progress().label === 'Step 3 of 3');
check('next() refuses past last step', s2.next() === false && s2.index === 2);

// ---- mode select + finish ----
check('finish refuses without a mode', s2.finish() === false && !s2.done);
check('rejects bad mode', s2.selectMode('expert') === null && s2.mode === null);
check('accepts easy', s2.selectMode('easy') === 'easy');
check('finish fires onModeSelect(easy)', s2.finish() === true && payload.mode === 'easy');
check('finish marks seen', P66.wizardSeen() === true);

// ---- back navigation ----
P66.resetWizardSeen();
var s3 = P66.createWizardState({});
s3.logFiles = [fakeFile('a.csv', 1)];
s3.binFile = fakeFile('stock.bin', 65536);
check('back at step 0 refuses', s3.back() === false && s3.index === 0);
s3.next(); // -> 1
check('back from step 1', s3.back() === true && s3.index === 0);
s3.next(); s3.next(); // -> 2
check('back from step 2', s3.back() === true && s3.index === 1);

// ---- skip path ----
P66.resetWizardSeen();
var skipped = false;
var s4 = P66.createWizardState({ onSkip: function () { skipped = true; } });
check('skip flags skipped', s4.skip() === true && s4.skipped === true);
check('skip calls onSkip', skipped === true);
check('skip marks seen', P66.wizardSeen() === true);
check('skip twice still once', s4.skip() === true); // idempotent, no double hook harm
check('nav dead after skip', s4.next() === false && s4.back() === false);

// ---- dismissal flag logic ----
P66.resetWizardSeen();
check('not seen after reset', P66.wizardSeen() === false);
P66.markWizardSeen();
check('seen after mark', P66.wizardSeen() === true);
check('SEEN_KEY is p66-wizard-seen', P66.WIZARD_SEEN_KEY === 'p66-wizard-seen');

// ---- bin size note ----
check('64KB file: no note', P66.binSizeNote(fakeFile('stock.bin', 65536)) === null);
check('wrong size: warns', typeof P66.binSizeNote(fakeFile('odd.bin', 131072)) === 'string');
check('warn mentions 64KB', P66.binSizeNote(fakeFile('odd.bin', 131072)).indexOf('64KB') !== -1);
check('no file: no note', P66.binSizeNote(null) === null);

// ---- node-safe DOM entry ----
check('createWizard returns null without document', P66.createWizard(null, {}) === null);

done();
