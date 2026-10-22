/* Knock-based spark learning tests (js/knock-spark.js).
 *
 * Covers the cross-session rules:
 *  - Real knock repeating in the same Main Spark cell across >= 2 distinct
 *    sessions -> exactly one -1 degree suggestion for that cell.
 *  - Single-session knock -> no suggestion.
 *  - False knock only (tip-out, single-sample noise) -> no suggestion.
 *  - Cell already at the ledger's cumulative +/-6 deg spark guardrail ->
 *    no pull, but a 'none' suggestion naming the guardrail in the reason.
 *  - Knock in different cells per session -> no suggestion.
 *  - Knock repeating only in old sessions but gone in the current one ->
 *    no suggestion (the pull must be driven by new data).
 *  - Transient-region knock -> no suggestion (drivetrain noise).
 *  - Plain-language reasons; patcher-compatible shape (kind/action/
 *    deltaDeg/knockCells); Main Spark Advance cell mapping matches the
 *    bundled catalog's axes (nearest breakpoint, like tuner.js).
 *
 * Cell geography used here (bundled catalog, Main Spark Advance):
 *   2972-2990 RPM -> 2800 row (idx 11); 83-86 kPa -> 85 col (idx 13);
 *   address 0x39 + (11*17 + 13) = 0x101.
 *
 * Run: node tools/knock-spark-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/bundled-catalog.js', 'js/ledger.js', 'js/knock-spark.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// --- fixtures ---
function realEv(rpm, map, peak, region, samples) {
  return {
    samples: samples || 8, region: region || 'cruise', peakKR: peak,
    avgKR: Math.round(peak / 2 * 100) / 100, rpm: rpm, map: map,
    tpsDrop: 2, tipOut: false, suspectNoise: false
  };
}
function falseEv(kind, rpm, map) {
  var e = realEv(rpm || 2972, map || 84.5, 3.5);
  if (kind === 'tipout') { e.tipOut = true; e.tpsDrop = 45; }
  if (kind === 'noise') { e.samples = 1; e.suspectNoise = true; e.peakKR = 22.5; }
  return e;
}
function knockReport(events) {
  return {
    available: true,
    knockSamples: events.reduce(function (a, e) { return a + e.samples; }, 0),
    knockEvents: events.length, totalSamples: 2000, events: events
  };
}
function journalEntry(id, logName, date, events) {
  return { id: id, logName: logName, date: date, note: 'flash note',
    report: { knock: knockReport(events) } };
}
function freshLedger() {
  return P66.createLedger(P66._ledgerMemoryStore());
}
function actionable(sugs) {
  return sugs.filter(function (s) { return s.action === 'retard timing'; });
}

console.log('1. repeating real knock across two sessions -> exactly one -1 deg suggestion');
(function () {
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [realEv(2960, 86, 4.2), realEv(2980, 84, 3.1)])];
  var report = { knock: knockReport([realEv(2972, 84.5, 3.8), realEv(2990, 83, 2.9)]) };
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp1' });
  check('exactly one suggestion', sugs.length === 1, String(sugs.length));
  var s = sugs[0];
  check('action is retard timing', s.action === 'retard timing', String(s.action));
  check('deltaDeg is -1', s.deltaDeg === -1, String(s.deltaDeg));
  check('table is Main Spark Advance', s.table === 'Main Spark Advance', String(s.table));
  check('kind is spark', s.kind === 'spark', String(s.kind));
  check('rpmIdx maps to the 2800 row', s.rpmIdx === 11, String(s.rpmIdx));
  check('mapIdx maps to the 85 col', s.mapIdx === 13, String(s.mapIdx));
  check('addressHex is 0x101', s.addressHex === '0x101', String(s.addressHex));
  check('evidence.sessions is 2', s.evidence && s.evidence.sessions === 2,
    JSON.stringify(s.evidence && s.evidence.sessions));
  check('evidence lists all 4 events', s.evidence && s.evidence.events.length === 4,
    JSON.stringify(s.evidence && s.evidence.events.length));
  check('reason is plain language (mentions 1 deg pull)', /Pulling 1° of timing/.test(s.reason),
    s.reason.slice(0, 120));
  check('reason names the cell in plain words', /2800 RPM \/ 85 kPa/.test(s.reason),
    s.reason.slice(0, 120));
  check('knockCells present for the patcher', Array.isArray(s.knockCells) && s.knockCells.length === 4,
    JSON.stringify(s.knockCells && s.knockCells.length));
})();

console.log('2. single-session knock -> no suggestion');
(function () {
  var report = { knock: knockReport([realEv(2972, 84.5, 3.8), realEv(2990, 83, 2.9)]) };
  var sugs = P66.suggestKnockSpark(report, [], freshLedger(), { fingerprint: 'fp2' });
  check('no suggestions at all', sugs.length === 0, String(sugs.length));
})();

console.log('3. false-knock-only across sessions -> no suggestion');
(function () {
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [falseEv('tipout'), falseEv('noise')])];
  var report = { knock: knockReport([falseEv('tipout', 2980, 84), falseEv('noise', 2960, 86)]) };
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp3' });
  check('no suggestions from ghosts', sugs.length === 0, String(sugs.length));
  // Mixed: one real event in each session plus false knock -> real ones still learn.
  var journal2 = [journalEntry('j2', 'logB.csv', '2026-10-21T18:00:00Z',
    [falseEv('tipout'), realEv(2972, 84.5, 3.0)])];
  var report2 = { knock: knockReport([falseEv('noise'), realEv(2990, 83, 3.4)]) };
  var sugs2 = P66.suggestKnockSpark(report2, journal2, freshLedger(), { fingerprint: 'fp3b' });
  check('mixed real+false still yields one suggestion', actionable(sugs2).length === 1,
    String(actionable(sugs2).length));
})();

console.log('4. cell already at the -6 deg cumulative guardrail -> no pull, reason says why');
(function () {
  var ledger = freshLedger();
  var past = [];
  for (var i = 0; i < 6; i++) {
    past.push({ table: 'Main Spark Advance', addressHex: '0x101', deltaDeg: -1 });
  }
  ledger.record('fp-guard', past, { note: 'six prior 1-deg pulls' });
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [realEv(2972, 84.5, 2.1)])];
  var report = { knock: knockReport([realEv(2990, 83, 2.4)]) };
  var sugs = P66.suggestKnockSpark(report, journal, ledger, { fingerprint: 'fp-guard' });
  check('no actionable pull', actionable(sugs).length === 0, String(actionable(sugs).length));
  check('one guardrail note emitted', sugs.length === 1, String(sugs.length));
  check('guardrail note has action none', sugs[0] && sugs[0].action === 'none',
    sugs[0] && sugs[0].action);
  check('reason names the guardrail', sugs[0] && /guardrail/.test(sugs[0].reason),
    sugs[0] && sugs[0].reason.slice(0, 140));
  check('reason names the 6-degree total', sugs[0] && /6°/.test(sugs[0].reason),
    sugs[0] && sugs[0].reason.slice(0, 140));
  check('guardrail note keeps cell coordinates', sugs[0] && sugs[0].rpmIdx === 11 &&
    sugs[0].mapIdx === 13 && sugs[0].addressHex === '0x101',
    JSON.stringify(sugs[0] && [sugs[0].rpmIdx, sugs[0].mapIdx, sugs[0].addressHex]));
})();

console.log('5. knock in different cells per session -> no suggestion');
(function () {
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [realEv(2972, 84.5, 3.8)])];
  var report = { knock: knockReport([realEv(4000, 55, 3.8)]) }; // 4000 row / 55 col
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp5' });
  check('no suggestions when cells differ', sugs.length === 0, String(sugs.length));
})();

console.log('6. knock repeated in old sessions but gone in the current one -> no suggestion');
(function () {
  var journal = [
    journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z', [realEv(2972, 84.5, 3.8)]),
    journalEntry('j2', 'logB.csv', '2026-10-21T18:00:00Z', [realEv(2985, 84, 3.2)])
  ];
  var report = { knock: knockReport([]) }; // clean log this time
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp6' });
  check('no suggestion without current-session evidence', sugs.length === 0, String(sugs.length));
})();

console.log('7. transient-region knock -> no suggestion (drivetrain noise)');
(function () {
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [realEv(2972, 84.5, 3.8, 'transient')])];
  var report = { knock: knockReport([realEv(2990, 83, 3.2, 'transient')]) };
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp7' });
  check('no suggestions from transient knock', sugs.length === 0, String(sugs.length));
})();

console.log('8. robustness: missing knock report, journal entries without reports');
(function () {
  check('missing knock -> empty', P66.suggestKnockSpark({}, [], freshLedger(), {}).length === 0, '');
  check('knock unavailable -> empty',
    P66.suggestKnockSpark({ knock: { available: false } }, [], freshLedger(), {}).length === 0, '');
  var journal = [{ id: 'j1', logName: 'logA.csv', date: '2026-10-20', note: 'no report attached' }];
  var report = { knock: knockReport([realEv(2972, 84.5, 3.8)]) };
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(), {});
  check('journal entries without reports are skipped', sugs.length === 0, String(sugs.length));
  // Bare knock report (not wrapped in a session report) also works.
  var bare = knockReport([realEv(2972, 84.5, 3.8)]);
  var sugs2 = P66.suggestKnockSpark(bare,
    [{ id: 'j2', report: knockReport([realEv(2985, 84, 3.2)]) }], freshLedger(), {});
  check('bare knock report shapes accepted', actionable(sugs2).length === 1,
    String(actionable(sugs2).length));
})();

console.log('9. current session already in the journal is not double-counted');
(function () {
  // Coordinator attached the current session's report to its journal entry.
  var journal = [journalEntry('j1', 'logA.csv', '2026-10-20T18:00:00Z',
    [realEv(2972, 84.5, 3.8)])];
  var report = { knock: knockReport([realEv(2972, 84.5, 3.8)]) };
  var sugs = P66.suggestKnockSpark(report, journal, freshLedger(),
    { fingerprint: 'fp9', logName: 'logA.csv' });
  check('one session counted once -> no suggestion', sugs.length === 0, String(sugs.length));
  var sugs2 = P66.suggestKnockSpark(report, journal, freshLedger(), { fingerprint: 'fp9b' });
  check('same entry as a distinct past session -> suggestion',
    actionable(sugs2).length === 1, String(actionable(sugs2).length));
})();

console.log('\n' + (failures ? failures + ' FAILURE(S) of ' + checks : 'ALL ' + checks + ' TESTS PASSED'));
process.exit(failures ? 1 : 0);
