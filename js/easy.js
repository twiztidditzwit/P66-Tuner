/* P66 easy-mode wizard
 * Three steps for non-tuners: drop a TunerPro log, drop a stock binary,
 * get an analyzed bin. Table definitions are built in
 * (js/bundled-catalog.js) — no XDF upload needed.
 *
 * Safety is the same pipeline as advanced mode, locked to the safest
 * settings: conservative suggestions, binary fingerprint guard,
 * full patch verification, plain-English summary, backup + bench warnings.
 * Nothing here flashes a car — the output is a file to review.
 */
(function () {
  'use strict';

  var MODE_KEY = 'p66-ui-mode';

  var state = {
    log: null, // { name, parsed, mapResult }
    bin: null  // { name, bytes, guard }
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- mode toggle ---------- */

  function setMode(mode) {
    if (mode !== 'easy' && mode !== 'advanced') mode = 'easy';
    document.body.setAttribute('data-ui-mode', mode);
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }
    $('mode-easy-btn').classList.toggle('active', mode === 'easy');
    $('mode-advanced-btn').classList.toggle('active', mode === 'advanced');
  }

  /* ---------- friendly signal names ---------- */

  var FRIENDLY = [
    ['RPM', 'engine speed'],
    ['MAP', 'engine load'],
    ['TPS', 'throttle position'],
    ['KR', 'knock sensor'],
    ['O2_B1', 'oxygen sensor'],
    ['O2_B2', 'oxygen sensor'],
    ['O2', 'oxygen sensor'],
    ['ECT', 'coolant temp'],
    ['STFT_B1', 'fuel trims'], ['STFT', 'fuel trims'],
    ['LTFT_B1', 'fuel trims'], ['LTFT', 'fuel trims']
  ];

  function foundSignals(mapResult) {
    var out = [];
    FRIENDLY.forEach(function (pair) {
      if (P66.columnFor(mapResult, pair[0]) !== null && out.indexOf(pair[1]) === -1) {
        out.push(pair[1]);
      }
    });
    return out;
  }

  function markStep(n, done) {
    $('estep-' + n).classList.toggle('done', !!done);
  }

  function refreshBuildButton() {
    var ok = state.log && state.bin && state.bin.guard.level !== 'block';
    $('easy-build-btn').disabled = !ok;
  }

  /* ---------- step 1: log ---------- */

  function onLogFile(file) {
    var info = $('easy-log-info');
    info.innerHTML = '<p class="muted">Reading…</p>';
    markStep(1, false);
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = P66.parseLogText(String(reader.result));
        var mapResult = P66.mapChannels(parsed.headers);
        if (P66.columnFor(mapResult, 'RPM') === null) {
          info.innerHTML = '<p class="status-warn"><strong>Couldn\'t find engine speed (RPM) in this file.</strong> ' +
            'Make sure it\'s a TunerPro CSV log with an RPM column.</p>';
          state.log = null;
        } else {
          state.log = { name: file.name, parsed: parsed, mapResult: mapResult };
          var sigs = foundSignals(mapResult);
          info.innerHTML = '<p class="status-ok"><strong>' + esc(file.name) + '</strong> — ' +
            parsed.rows.length.toLocaleString('en-US') + ' rows.</p>' +
            '<p class="muted">Found: ' + esc(sigs.join(', ') || 'basic channels') + '.</p>';
          markStep(1, true);
        }
      } catch (err) {
        info.innerHTML = '<p class="status-warn"><strong>Couldn\'t read that file:</strong> ' +
          esc(err && err.message ? err.message : err) + '</p>';
        state.log = null;
      }
      refreshBuildButton();
    };
    reader.onerror = function () {
      info.innerHTML = '<p class="status-warn">Couldn\'t read that file.</p>';
      refreshBuildButton();
    };
    reader.readAsText(file);
  }

  /* ---------- step 2: binary ---------- */

  function onBinFile(file) {
    var info = $('easy-bin-info');
    info.innerHTML = '<p class="muted">Checking…</p>';
    markStep(2, false);
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var guard = (typeof P66.checkBinary === 'function')
          ? P66.checkBinary(bytes)
          : { level: 'block', messages: ['Safety guard not loaded.'] };
        state.bin = { name: file.name, bytes: bytes, guard: guard };
        if (guard.level === 'block') {
          info.innerHTML = '<p class="status-warn"><strong>Can\'t use this file.</strong></p><ul>' +
            guard.messages.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
        } else {
          var cls = guard.level === 'ok' ? 'status-ok' : 'status-warn';
          info.innerHTML = '<p class="' + cls + '"><strong>' + esc(file.name) + '</strong> — ' +
            esc(guard.messages.join(' ')) + '</p>';
          markStep(2, true);
        }
      } catch (err) {
        info.innerHTML = '<p class="status-warn"><strong>Couldn\'t read that file:</strong> ' +
          esc(err && err.message ? err.message : err) + '</p>';
        state.bin = null;
      }
      refreshBuildButton();
    };
    reader.onerror = function () {
      info.innerHTML = '<p class="status-warn">Couldn\'t read that file.</p>';
      refreshBuildButton();
    };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- step 3: build ---------- */

  function onBuild() {
    var out = $('easy-results');
    markStep(3, false);
    out.innerHTML = '<p class="muted">Analyzing your log…</p>';
    // Let the UI paint before the synchronous pipeline runs.
    setTimeout(function () {
      try {
        buildTune(out);
      } catch (err) {
        out.innerHTML = '<p class="status-warn"><strong>Something went wrong:</strong> ' +
          esc(err && err.message ? err.message : err) + '</p>';
      }
    }, 30);
  }

  function buildTune(out) {
    var catalog = P66.BUNDLED_CATALOG;
    if (!catalog) {
      out.innerHTML = '<p class="status-warn">Built-in table definitions failed to load. Try the Advanced tab instead.</p>';
      return;
    }
    var report = P66.analyzeSession(state.log.parsed, state.log.mapResult);
    var sug = P66.generateSuggestions(report, 'conservative'); // easy mode: safest settings, always
    var binBytes = state.bin.bytes;

    var fuel = P66.applyFuelSuggestions(catalog, binBytes, sug.actionable);
    var sparkBase = (fuel.patched && !fuel.error) ? fuel.patched : binBytes;
    var spark = (typeof P66.applySparkSuggestions === 'function')
      ? P66.applySparkSuggestions(catalog, sparkBase, sug.actionable)
      : { patches: [], patched: null, error: null };
    var peBase = (spark.patched && !spark.error) ? spark.patched : sparkBase;
    var pe = (typeof P66.applyPeSuggestions === 'function')
      ? P66.applyPeSuggestions(catalog, peBase, sug.actionable)
      : { patches: [], patched: null, error: null };
    var allPatches = (fuel.patches || []).concat(spark.patches || [], pe.patches || []);
    var finalImage = pe.patched || spark.patched || fuel.patched;

    var verification = (typeof P66.verifyPatches === 'function')
      ? P66.verifyPatches(catalog, binBytes, { patches: allPatches, patched: finalImage, error: null })
      : { ok: false, checked: 0, failures: [{ addressHex: null, check: 'missing', message: 'Verifier not loaded.' }], warnings: [] };

    var summary = P66.summarizeTune(sug.actionable, allPatches);

    var html = '<h3>What this tune does</h3>';
    html += '<p><strong>' + esc(summary.headline) + '</strong></p>';
    if (summary.bullets.length) {
      html += '<ul>';
      summary.bullets.forEach(function (b) { html += '<li>' + esc(b) + '</li>'; });
      html += '</ul>';
    }

    html += '<h3>Safety checklist</h3><ul class="checklist">';
    var guard = state.bin.guard;
    html += '<li>' + (guard.level === 'ok' ? '✅' : '⚠️') + ' Binary check: ' + esc(guard.messages.join(' ')) + '</li>';
    html += '<li>' + (verification.ok ? '✅' : '❌') + ' Patch check: ' +
      (verification.ok
        ? verification.checked + ' changes verified — every address confirmed against your binary.'
        : verification.failures.length + ' check(s) failed. No download offered.') + '</li>';
    if (verification.warnings.length) {
      verification.warnings.forEach(function (w) {
        html += '<li>⚠️ ' + esc(w.addressHex + ': ' + w.message) + '</li>';
      });
    }
    html += '<li>⚠️ No checksum is defined for the P66 — the file is offered as-is.</li>';
    html += '</ul>';

    if (!allPatches.length) {
      html += '<p class="status-ok"><strong>Your log looks healthy — nothing to change, nothing to flash.</strong></p>';
    } else if (verification.ok) {
      html += '<p><button id="easy-download-btn" style="width:auto;padding:0.6rem 1.4rem;">Download tuned binary</button></p>';
      html += '<p class="status-warn"><strong>Before you flash:</strong></p><ul>' +
        '<li>Save a backup copy of your <strong>original</strong> binary somewhere safe.</li>' +
        '<li>If you can, test on a spare computer (PCM) first — not your daily driver.</li>' +
        '<li>After flashing, drive gently, pull another log, and run it through here again.</li></ul>';
    } else {
      html += '<p class="status-warn"><strong>No download — the safety checks did not all pass.</strong></p><ul>';
      verification.failures.forEach(function (f) {
        html += '<li><strong>' + esc(f.addressHex || '—') + ':</strong> ' + esc(f.message) + '</li>';
      });
      html += '</ul>';
    }

    out.innerHTML = html;
    markStep(3, verification.ok && allPatches.length > 0);

    var dl = $('easy-download-btn');
    if (dl && finalImage) {
      dl.addEventListener('click', function () {
        var blob = new Blob([finalImage], { type: 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'p66-tuned.bin';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    }
  }

  /* ---------- wire up ---------- */

  function init() {
    $('mode-easy-btn').addEventListener('click', function () { setMode('easy'); });
    $('mode-advanced-btn').addEventListener('click', function () { setMode('advanced'); });
    var saved = null;
    try { saved = localStorage.getItem(MODE_KEY); } catch (e) { /* ignore */ }
    setMode(saved === 'advanced' ? 'advanced' : 'easy');

    $('easy-log-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) onLogFile(e.target.files[0]);
    });
    $('easy-bin-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) onBinFile(e.target.files[0]);
    });
    $('easy-build-btn').addEventListener('click', onBuild);
    refreshBuildButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
