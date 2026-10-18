/* PWA tests: manifest.webmanifest, sw.js, icon.svg.
 * Run: node tools/pwa-test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var child = require('child_process');

var ROOT = path.join(__dirname, '..');
var failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log('  ok: ' + name); }
  else { failures++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- manifest -------------------------------------------------------
var manifestPath = path.join(ROOT, 'manifest.webmanifest');
var manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('manifest.webmanifest parses as JSON', true);
} catch (e) {
  check('manifest.webmanifest parses as JSON', false, String(e));
}
if (manifest) {
  check('manifest name is "p66-tuner"', manifest.name === 'p66-tuner', JSON.stringify(manifest.name));
  check('manifest start_url is "."', manifest.start_url === '.', JSON.stringify(manifest.start_url));
  check('manifest scope is "."', manifest.scope === '.', JSON.stringify(manifest.scope));
  check('manifest display is "standalone"', manifest.display === 'standalone', JSON.stringify(manifest.display));
  var icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check('manifest has icons', icons.length > 0);
  var sizes = icons.map(function (i) { return i.sizes; }).join(' ');
  check('manifest covers 192 and 512 (or "any" vector)',
    icons.length > 0 && (/192/.test(sizes) || /any/.test(sizes)) && (/512/.test(sizes) || /any/.test(sizes)),
    JSON.stringify(sizes));
  icons.forEach(function (icon, i) {
    var p = path.join(ROOT, icon.src);
    check('icon #' + i + ' exists: ' + icon.src, fs.existsSync(p), p);
  });
  check('manifest theme_color present', !!manifest.theme_color, JSON.stringify(manifest.theme_color));
  check('manifest background_color present', !!manifest.background_color, JSON.stringify(manifest.background_color));
}

// ---- service worker ---------------------------------------------------
var swPath = path.join(ROOT, 'sw.js');
var swOk = fs.existsSync(swPath);
check('sw.js exists', swOk);
if (swOk) {
  var out = child.spawnSync(process.execPath, ['--check', swPath], { encoding: 'utf8' });
  check('sw.js parses (node --check)', out.status === 0, out.stderr);
  var sw = fs.readFileSync(swPath, 'utf8');
  check('sw.js defines a versioned cache name', /var CACHE_NAME\s*=\s*['"]p66-tuner-v\d+['"]/.test(sw));
  check('sw.js has an install handler', /addEventListener\s*\(\s*['"]install['"]/.test(sw));
  check('sw.js has an activate handler', /addEventListener\s*\(\s*['"]activate['"]/.test(sw));
  check('sw.js has a fetch handler', /addEventListener\s*\(\s*['"]fetch['"]/.test(sw));
  check('sw.js cleans old caches on activate', /caches\.keys\(\)/.test(sw) && /caches\.delete\(/.test(sw));
  check('sw.js has an offline fallback to index.html',
    /caches\.match\(['"]index\.html['"]\)/.test(sw));
  ['index.html', 'styles.css', 'app.js', 'js/analyzer.js', 'manifest.webmanifest'].forEach(function (f) {
    check('sw.js precaches ' + f, sw.indexOf("'" + f + "'") >= 0 || sw.indexOf('"' + f + '"') >= 0);
  });
  check('sw.js skips non-GET requests', /req\.method\s*!==\s*['"]GET['"]/.test(sw));
}

// ---- icon ---------------------------------------------------------------
var iconPath = path.join(ROOT, 'icon.svg');
check('icon.svg exists', fs.existsSync(iconPath));
if (fs.existsSync(iconPath)) {
  var icon = fs.readFileSync(iconPath, 'utf8');
  check('icon.svg is valid XML/SVG', /<svg[\s>]/.test(icon) && /<\/svg>/.test(icon));
  check('icon.svg uses the dark theme background', icon.indexOf('#10151d') >= 0);
}

console.log(checks + ' checks, ' + failures + ' failures.');
process.exit(failures ? 1 : 0);
