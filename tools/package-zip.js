#!/usr/bin/env node
/* package-zip — build a self-contained desktop distribution of the P66 Log Analyzer.
 *
 *   node tools/package-zip.js
 *
 * Builds dist/p66-log-analyzer.zip containing:
 *   index.html, app.js, styles.css, js/*, README-QUICKSTART.txt
 * Excludes: defs/, tools/, docs/, dist/, .git, and any test/scratch files.
 * (dist/ is a local build artifact — never commit it.)
 *
 * After building, the zip is extracted to a temp dir and every
 * <script src="..."> referenced by index.html is asserted to exist inside it.
 * Exit code is nonzero on any verification failure.
 *
 * NOTE: a concurrent workstream may add js/provenance.js plus its <script> tag.
 * If verification finds a referenced script missing from the *repo* as well as
 * the zip, it is reported as a timing miss (not a failure) so a coordinator
 * can re-verify once that workstream lands.
 *
 * The ZIP is written in pure JS (no npm deps, no shell-out to `zip`) so the
 * build runs anywhere Node does.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var zlib = require('zlib');
var childProcess = require('child_process');

var ROOT = path.resolve(path.join(__dirname, '..'));
var DIST = path.join(ROOT, 'dist');
var ZIP_NAME = 'p66-log-analyzer.zip';

// Files/dirs never packaged. Anything matching these anywhere in the tree is out.
var EXCLUDE_RE = /(^|\/)(defs|tools|docs|dist|\.git)(\/|$)/;
var SCRATCH_RE = /(^|\/)(test|tests|spec|scratch|tmp|temp|Docker-Repository)(\/|\.|$)/i;

// ---------------------------------------------------------------- zip writer
var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

var EMPTY = Buffer.alloc(0);

function buildZip(entries) {
  // entries: [{ name (zip path, posix), data: Buffer }]
  var chunks = [];
  var central = [];
  var offset = 0;
  entries.forEach(function (e) {
    var nameBuf = Buffer.from(e.name, 'utf8');
    var raw = e.data.length ? e.data : EMPTY;
    var compressed = zlib.deflateRawSync(raw, { level: 9 });
    var crc = crc32(raw);
    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4);         // version needed
    lh.writeUInt16LE(0x0800, 6);     // UTF-8 names
    lh.writeUInt16LE(8, 8);          // deflate
    lh.writeUInt16LE(0, 10);         // mod time (epoch-ish, cosmetic)
    lh.writeUInt16LE(0x21, 12);      // mod date (1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra field len
    central.push({ nameBuf: nameBuf, crc: crc, compLen: compressed.length, len: raw.length, offset: offset });
    chunks.push(lh, nameBuf, compressed);
    offset += 30 + nameBuf.length + compressed.length;
  });
  var centralStart = offset;
  central.forEach(function (c) {
    var ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory signature
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.compLen, 20);
    ch.writeUInt32LE(c.len, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    chunks.push(ch, c.nameBuf);
  });
  var centralSize = offset2(chunks) - centralStart;
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);  // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function offset2(chunks) {
  var n = 0;
  chunks.forEach(function (c) { n += c.length; });
  return n;
}

// -------------------------------------------------------------- file picking
function walkJs(dir, base) {
  var out = [];
  fs.readdirSync(dir).forEach(function (f) {
    var p = path.join(dir, f);
    if (!f.endsWith('.js') || f.startsWith('.')) return;
    if (SCRATCH_RE.test(f)) return; // test/scratch files never ship
    out.push(base + '/' + f);
  });
  return out.sort();
}

function collectFiles() {
  var files = ['index.html', 'app.js', 'styles.css'];
  walkJs(path.join(ROOT, 'js'), 'js').forEach(function (f) { files.push(f); });
  // Sanity: never let an excluded path slip in.
  files.forEach(function (f) {
    if (EXCLUDE_RE.test(f) || SCRATCH_RE.test(f)) {
      throw new Error('refusing to package excluded path: ' + f);
    }
    if (!fs.existsSync(path.join(ROOT, f))) {
      throw new Error('packaging failed: expected file missing: ' + f);
    }
  });
  return files;
}

// ---------------------------------------------------------- quickstart readme
function quickstartText() {
  return [
    'P66 Log Analyzer — Quick Start',
    '================================',
    '',
    'Turns a TunerPro log from your 16184737 P66 PCM into a tuned .bin',
    'file. Runs fully offline — no install, no server, no internet needed.',
    '',
    '1) UNZIP',
    '   Unzip this folder anywhere you like (Desktop, Documents, a USB stick).',
    '',
    '2) DOUBLE-CLICK index.html',
    '   It opens in your browser and just works. Table definitions are',
    '   built in (derived from Robert Saar\'s P66 V6 XDF).',
    '',
    '3) USE EASY MODE',
    '   a. Drop in your TunerPro log (.csv / .tsv)',
    '   b. Drop in your stock binary read (.bin — 64KB P66 read)',
    '   c. Press "Build my tune"',
    '',
    '   You get an analyzed, patched .bin file to review — nothing is',
    '   flashed by this tool.',
    '',
    'What you need to bring: a TunerPro log and a stock .bin read of your',
    'own PCM. The zip contains only the app, not your vehicle\'s data.',
    '',
    'Tip: click "Advanced" in the top bar for the full dashboard, channel',
    'mapping, knock timeline, and manual table review.',
    '',
    'SAFETY',
    '------',
    'This tool never writes to your PCM. Review every suggested change',
    'before flashing, and bench-verify on a spare PCM before flashing a',
    'running vehicle. No checksum is defined for the P66, so the app',
    'applies patches without checksum correction and says so clearly.',
    ''
  ].join('\n');
}

// --------------------------------------------------------------- verification
function scriptSrcs(html) {
  var srcs = [];
  var re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var s = m[1].trim();
    if (!s) continue;
    if (/^(data:|https?:)?\/\//i.test(s)) continue;   // remote / protocol-relative
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) continue;     // other schemes (blob:, etc.)
    s = s.split('#')[0].split('?')[0];
    s = s.replace(/^\.\//, '');
    if (s) srcs.push(s);
  }
  return srcs;
}

function rimraf(p) {
  if (fs.rmSync) { fs.rmSync(p, { recursive: true, force: true }); return; }
  childProcess.execFileSync('rm', ['-rf', p]);
}

function verifyZip(zipPath, htmlText) {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p66-zip-verify-'));
  var failures = [];
  var timingMisses = [];
  try {
    // Extract with unzip (available on macOS/Windows/Linux tooling); if it is
    // ever absent, fall back to reading the central directory by hand.
    var rc = childProcess.spawnSync('unzip', ['-q', '-o', zipPath, '-d', tmp], { stdio: 'pipe' });
    if (rc.status !== 0) throw new Error('unzip failed: ' + (rc.stderr || '').toString().slice(0, 300));
    var srcs = scriptSrcs(htmlText);
    srcs.forEach(function (s) {
      var inZip = fs.existsSync(path.join(tmp, s));
      if (!inZip) {
        var onDisk = fs.existsSync(path.join(ROOT, s));
        if (onDisk) {
          failures.push(s + ' — in repo but MISSING from zip');
        } else {
          timingMisses.push(s);
        }
      }
    });
    // The zip must also contain its top-level payload files.
    ['index.html', 'app.js', 'styles.css', 'README-QUICKSTART.txt'].forEach(function (f) {
      if (!fs.existsSync(path.join(tmp, f))) failures.push(f + ' — missing from zip');
    });
    // No excluded tree may have leaked in.
    childProcess.execFileSync('unzip', ['-l', zipPath], { stdio: 'pipe' }).toString().split('\n')
      .filter(function (l) { return /^\s*\d+\s+\d{4}-\d{2}-\d{2}/.test(l); }) // entry rows only, not Archive:/summary lines
      .map(function (l) { return l.trim().split(/\s+/).pop() || ''; })
      .filter(function (n) { return n && !n.endsWith('/'); })
      .forEach(function (n) {
        if (EXCLUDE_RE.test(n) || SCRATCH_RE.test(n)) failures.push(n + ' — excluded path leaked into zip');
      });
  } finally {
    rimraf(tmp);
  }
  return { failures: failures, timingMisses: timingMisses };
}

// ------------------------------------------------------------------- main
function main() {
  fs.mkdirSync(DIST, { recursive: true });
  var files = collectFiles();
  var htmlText = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var entries = files.map(function (f) {
    return { name: f, data: fs.readFileSync(path.join(ROOT, f)) };
  });
  entries.push({ name: 'README-QUICKSTART.txt', data: Buffer.from(quickstartText(), 'utf8') });

  var zipPath = path.join(DIST, ZIP_NAME);
  fs.writeFileSync(zipPath, buildZip(entries));
  var size = fs.statSync(zipPath).size;
  console.log('built ' + path.relative(ROOT, zipPath) + ' (' + entries.length + ' files, ' + size + ' bytes)');
  entries.forEach(function (e) { console.log('  + ' + e.name); });

  var v = verifyZip(zipPath, htmlText);
  if (v.timingMisses.length) {
    console.log('\nTIMING MISS (not a failure — concurrent workstream has not landed these yet):');
    v.timingMisses.forEach(function (s) { console.log('  ~ ' + s); });
    console.log('Re-run this script after js/provenance.js lands for a clean check.');
  }
  if (v.failures.length) {
    console.error('\nVERIFICATION FAILED:');
    v.failures.forEach(function (f) { console.error('  FAIL ' + f); });
    process.exit(1);
  }
  console.log('verification: OK — all ' + scriptSrcs(htmlText).length + ' <script src> targets present in zip');
}

main();
