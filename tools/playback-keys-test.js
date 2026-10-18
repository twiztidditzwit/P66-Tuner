/* Playback keyboard shortcut tests.
 * Run: node tools/playback-keys-test.js
 *
 * Drives P66.playbackKeyAction / P66.playbackKeyShouldIgnore directly —
 * the DOM keydown listener in renderPlayback is a thin wrapper over these,
 * so the whole keymap is covered under node with no DOM.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
['js/playback.js'].forEach(function (f) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8')); // eslint-disable-line no-eval
});
var P66 = global.P66;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

function mods(o) {
  o = o || {};
  return { shift: !!o.shift, ctrl: !!o.ctrl, meta: !!o.meta, alt: !!o.alt };
}
function st(index, rowCount, events) {
  return { index: index, rowCount: rowCount, eventIndices: events || [] };
}
function action(key, m, s) { return P66.playbackKeyAction(key, m, s); }

// ---- exports ----
check('mapper + guard exported',
  typeof P66.playbackKeyAction === 'function' &&
  typeof P66.playbackKeyShouldIgnore === 'function');

// ---- space ----
var a = action(' ', mods(), st(5, 100));
check('space toggles', a && a.type === 'toggle');
a = action('Spacebar', mods(), st(5, 100));
check('legacy Spacebar toggles', a && a.type === 'toggle');
a = action(' ', mods({ shift: true }), st(5, 100));
check('shift+space still toggles', a && a.type === 'toggle');
check('ctrl+space not hijacked', action(' ', mods({ ctrl: true }), st(5, 100)) === null);
check('meta+space not hijacked', action(' ', mods({ meta: true }), st(5, 100)) === null);
check('alt+space not hijacked', action(' ', mods({ alt: true }), st(5, 100)) === null);

// ---- arrows ----
a = action('ArrowLeft', mods(), st(5, 100));
check('ArrowLeft seeks -1', a && a.type === 'seek' && a.index === 4);
a = action('ArrowLeft', mods(), st(0, 100));
check('ArrowLeft clamps at 0', a && a.type === 'seek' && a.index === 0);
a = action('ArrowLeft', mods({ shift: true }), st(25, 100));
check('Shift+ArrowLeft seeks -10', a && a.type === 'seek' && a.index === 15);
a = action('ArrowLeft', mods({ shift: true }), st(5, 100));
check('Shift+ArrowLeft clamps at 0', a && a.type === 'seek' && a.index === 0);
a = action('ArrowRight', mods(), st(5, 100));
check('ArrowRight seeks +1', a && a.type === 'seek' && a.index === 6);
a = action('ArrowRight', mods(), st(99, 100));
check('ArrowRight clamps at last', a && a.type === 'seek' && a.index === 99);
a = action('ArrowRight', mods({ shift: true }), st(95, 100));
check('Shift+ArrowRight seeks +10 clamped', a && a.type === 'seek' && a.index === 99);
check('ctrl+arrow not hijacked',
  action('ArrowRight', mods({ ctrl: true }), st(5, 100)) === null);

// ---- bracket event jumps ----
a = action('[', mods(), st(35, 100, [10, 30, 50]));
check('[ jumps to previous event', a && a.type === 'seek' && a.index === 30);
a = action('[', mods(), st(30, 100, [10, 30, 50]));
check('[ on an event goes to the earlier one', a && a.type === 'seek' && a.index === 10);
check('[ with no earlier event does nothing',
  action('[', mods(), st(5, 100, [10, 30, 50])) === null);
check('[ with no events does nothing',
  action('[', mods(), st(50, 100, [])) === null);
a = action(']', mods(), st(35, 100, [10, 30, 50]));
check('] jumps to next event', a && a.type === 'seek' && a.index === 50);
a = action(']', mods(), st(50, 100, [10, 30, 50]));
check('] sitting on last event does nothing', a === null);
check('] with no later event does nothing',
  action(']', mods(), st(55, 100, [10, 30, 50])) === null);

// ---- home / end ----
a = action('Home', mods(), st(42, 100));
check('Home seeks first sample', a && a.type === 'seek' && a.index === 0);
a = action('End', mods(), st(42, 100));
check('End seeks last sample', a && a.type === 'seek' && a.index === 99);
a = action('Home', mods(), st(0, 100));
check('Home at start is a no-op seek to 0', a && a.type === 'seek' && a.index === 0);

// ---- unrecognized keys ----
check('letter key ignored', action('x', mods(), st(5, 100)) === null);
check('Enter ignored', action('Enter', mods(), st(5, 100)) === null);
check('undefined key ignored', action(undefined, mods(), st(5, 100)) === null);

// ---- focus guard ----
function tgt(tagName, editable) {
  return { tagName: tagName, isContentEditable: !!editable };
}
check('input keeps space', P66.playbackKeyShouldIgnore(tgt('INPUT'), ' ') === true);
check('textarea keeps arrows', P66.playbackKeyShouldIgnore(tgt('textarea'), 'ArrowLeft') === true);
check('select keeps keys', P66.playbackKeyShouldIgnore(tgt('select'), 'Home') === true);
check('range input (scrubber) keeps arrows',
  P66.playbackKeyShouldIgnore(tgt('input'), 'ArrowRight') === true);
check('contentEditable keeps keys',
  P66.playbackKeyShouldIgnore(tgt('div', true), ' ') === true);
check('button keeps space', P66.playbackKeyShouldIgnore(tgt('button'), ' ') === true);
check('button allows brackets (focus usually sits on play button after a click)',
  P66.playbackKeyShouldIgnore(tgt('button'), '[') === false);
check('button allows arrows', P66.playbackKeyShouldIgnore(tgt('button'), 'ArrowRight') === false);
check('plain div allows space', P66.playbackKeyShouldIgnore(tgt('div'), ' ') === false);
check('body allows space', P66.playbackKeyShouldIgnore(tgt('body'), ' ') === false);
check('null target allows keys', P66.playbackKeyShouldIgnore(null, ' ') === false);

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
