/* Minifier tests: every shipped JS file minifies to parseable output, and
 * minified output behaves identically to the original on samples
 * (differential check in isolated vm sandboxes).
 * Run: node tools/minify-test.js
 */
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var minifyString = require('./minify.js').minifyString;

var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// Shipped scripts: js/*.js (no scratch/test files) + app.js — the same
// rule tools/package-zip.js uses when collecting the zip payload.
function shippedJs() {
  var out = fs.readdirSync(path.join(ROOT, 'js')).filter(function (f) {
    return f.endsWith('.js') && f[0] !== '.' &&
      !/(^|\/)(test|tests|spec|scratch|tmp|temp)(\/|\.|$)/i.test(f);
  }).map(function (f) { return 'js/' + f; }).sort();
  out.push('app.js');
  return out;
}

console.log('minify: every shipped file minifies and still parses');
var tot0 = 0, tot1 = 0;
shippedJs().forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  var code = minifyString(src).code;
  tot0 += src.length;
  tot1 += code.length;
  check(f + ' minifies smaller', code.length > 0 && code.length < src.length,
    src.length + ' -> ' + code.length);
  var tmp = path.join(os.tmpdir(), 'p66-minify-test-' + process.pid + '.js');
  fs.writeFileSync(tmp, code);
  var r = cp.spawnSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  check(f + ' minified passes node --check', r.status === 0,
    (r.stderr || '').toString().slice(0, 160));
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
});
console.log('  totals: ' + tot0 + ' -> ' + tot1 +
  ' (' + (100 * (1 - tot1 / tot0)).toFixed(1) + '% smaller)');

console.log('minify: differential behavior on a tricky sample');
var tricky = [
  'var out = {};',
  'function div(a, b) { return a / b / 2; }',   // division, not regex
  'out.div = div(9, 3);',
  'var re = /a\\/b\\/c/gi; out.re = re.test("a/b/c");', // regex w/ escapes+flags
  'out.reSrc = /ab+c/.source;',
  'var s = "not // a comment"; out.s = s;',      // comment-lookalikes in strings
  "var s2 = '/* not a comment */'; out.s2 = s2;",
  'var t = `tpl ${div(9, 3)} /* kept */ // kept`; out.t = t;', // template
  'var nest = `a${`b${1 + 2}c`}d`; out.nest = nest;',          // nested ${}
  'var x = 1',            // ASI across newlines must survive
  'x = x + 1',
  'out.x = x;',
  'function f() {',
  '  return',             // return-newline: stays undefined, not 42
  '  42;',
  '}',
  'out.f = f();',
  'var y = 5; out.pp = y + ++y;',  // +/- token spacing
  'var z = 5; out.mm = z - --z;',
  'out.dot = (255).toString(16);',
  'var q = 7 .toString(); out.q = q;',  // number-dot spacing preserved
  'if (true) {} out.blk = /x$/.test("ax");', // regex after a block
  'var d2 = 8 / 2 / 2; out.d2 = d2;',
  'var e = 1e3 + 0x10 + 0b101; out.e = e;',
  'out.typeofRe = typeof /re/;',
  'var arr = [1, 2, 3]; out.sum = arr[0] + arr[2];'
].join('\n');
function newSandbox() {
  // The P66 scripts close over `typeof window !== 'undefined' ? window :
  // global`, so the sandbox needs a `global` binding (and no `window`).
  var sandbox = { window: undefined };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
function runInSandbox(code) {
  var sandbox = newSandbox();
  vm.runInContext(code + '\n;this.__out = out;', sandbox);
  return JSON.parse(JSON.stringify(sandbox.__out));
}
var expected = runInSandbox(tricky);
var got = runInSandbox(minifyString(tricky).code);
check('tricky sample behaves identically',
  JSON.stringify(got) === JSON.stringify(expected),
  'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(got));

console.log('minify: differential behavior on real modules (dashboard + ve3d)');
var DEPS = ['js/log-parser.js', 'js/channel-mapper.js', 'js/xdf-map.js',
            'js/dashboard.js', 'js/ve3d.js', 'js/bundled-catalog.js'];
var probe = [
  'JSON.stringify([',
  '  P66._veRotate(1, 2, 3, 0.5, 0.9),',
  '  P66._veBilinear(1, 2, 3, 4, 0.25, 0.75),',
  '  P66._veFaceLight(1.5, -2, Math.cos(0.7), Math.sin(0.7), Math.cos(0.95), Math.sin(0.95)),',
  '  P66._trimColor(5), P66._trimColor(-5), P66._valueRamp(0.5),',
  '  P66.vePointsSample([{RPM: 1000, MAP: 50}, {RPM: 1100, MAP: 55}], "RPM", "MAP", 10),',
  '  P66.veAxisFrac([0, 100, 200], 150),',
  '  P66.vePointsInRange([{rpm: 800, map: 30}, {rpm: 900, map: 200}], [400, 1000], [20, 100]).length',
  '])'
].join('\n');
function loadAndProbe(minified) {
  var sandbox = newSandbox();
  DEPS.forEach(function (f) {
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(minified ? minifyString(src).code : src, sandbox, { filename: f });
  });
  return vm.runInContext(probe, sandbox);
}
var probeOrig = loadAndProbe(false);
var probeMin = loadAndProbe(true);
check('dashboard+ve3d helpers behave identically minified',
  probeMin === probeOrig, 'orig=' + probeOrig + ' min=' + probeMin);

console.log('minify: veSurfaceModel identical on a synthetic table');
var modelProbe = [
  '(function () {',
  '  var catalog = P66.BUNDLED_CATALOG;',
  '  var ve = P66.readTable(catalog, "Main VE", new Uint8Array(65536));',
  '  var bin = new Uint8Array(65536);',
  '  for (var r = 0; r < ve.rows; r++) for (var c = 0; c < ve.cols; c++) {',
  '    var v = 500 + r * 10 + c, a = ve.base + (r * ve.cols + c) * ve.elementBytes;',
  '    bin[a] = (v >> 8) & 255; bin[a + 1] = v & 255;',
  '  }',
  '  function patch(r, c, pct) {',
  '    var a = ve.base + (r * ve.cols + c) * ve.elementBytes;',
  '    return { table: "Main VE", address: a, oldValue: 600,',
  '             newValue: Math.round(600 * (1 + pct / 100)), deltaPct: pct };',
  '  }',
  '  var data = P66.veComparisonData(catalog, bin, [patch(2, 3, 8), patch(4, 4, -4)]);',
  '  var m = P66.veSurfaceModel(data, "change");',
  '  var b = P66.veSurfaceModel(data, "before");',
  '  return JSON.stringify({ ch: m.nodes[2][3], ch0: m.nodes[0][0],',
  '    bh: b.nodes[0][0].h, rows: m.rows, cols: m.cols });',
  '})()'
].join('\n');
function modelAndProbe(minified) {
  var sandbox = newSandbox();
  DEPS.forEach(function (f) {
    var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(minified ? minifyString(src).code : src, sandbox, { filename: f });
  });
  return vm.runInContext(modelProbe, sandbox);
}
var modelOrig = modelAndProbe(false);
var modelMin = modelAndProbe(true);
check('veSurfaceModel identical minified', modelMin === modelOrig,
  'orig=' + modelOrig + ' min=' + modelMin);

console.log('minify: loadScriptOnce is node-safe (rejects without a document)');
(function () {
  var sandbox = newSandbox();
  var lazySrc = fs.readFileSync(path.join(ROOT, 'js/lazy.js'), 'utf8');
  vm.runInContext(minifyString(lazySrc).code, sandbox, { filename: 'js/lazy.js (min)' });
  var verdict = vm.runInContext(
    'P66.loadScriptOnce("js/ve3d.js").then(' +
    'function () { return "resolved"; },' +
    'function (e) { return "rejected: " + e.message; })', sandbox);
  // verdict is a Promise; settle it via a second tick
  var settled = null;
  verdict.then(function (v) { settled = v; }, function (e) { settled = 'threw: ' + e; });
  setTimeout(function () {
    check('loadScriptOnce rejects with no document',
      typeof settled === 'string' && settled.indexOf('rejected:') === 0, settled);
    finish();
  }, 50);
})();

function finish() {
  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}
// finish() is called after the async lazy check; guard against double-run.
var finished = false;
var origFinish = finish;
finish = function () {
  if (finished) return;
  finished = true;
  origFinish();
};
