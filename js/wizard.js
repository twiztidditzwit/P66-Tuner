/* P66-Tuner first-run guided wizard
 * A plain-English, three-step tour for newcomers (e.g. Dale's Facebook
 * tuning group): drop a TunerPro log, drop the ORIGINAL stock 64KB binary,
 * pick Easy or Advanced. The wizard only COLLECTS files and a mode choice —
 * it never touches analysis, suggestions, or tuning. When it has what it
 * needs it hands the files to the coordinator through the hooks below.
 *
 *   P66.createWizard(container, hooks) -> controller | null
 *     container : a DOM element the coordinator provides; the wizard builds
 *                 all of its own UI inside it. No static HTML needed.
 *                 (null in node / anywhere without `document`.)
 *     hooks : { onFilesReady({logFiles, binFile, xdfSource}),
 *               onModeSelect(mode), onSkip() }
 *       onFilesReady — called when the user leaves step 2 with a log and a
 *         binary in hand. logFiles is an array of File (several allowed —
 *         the coordinator merges them, see js/log-merge.js). binFile is a
 *         single File. xdfSource is 'built-in' (the P66 definitions ship
 *         with the app; no XDF upload needed to get started).
 *       onModeSelect — called when the user picks a mode and hits Start.
 *         mode is 'easy' or 'advanced'. The coordinator wires this to the
 *         real Easy/Advanced flows (js/easy.js, app.js).
 *       onSkip — optional; called when the user skips the tour.
 *     controller : { goto(n), next(), back(), skip(), getStep(),
 *                    destroy() }
 *                 All the navigation logic lives in the pure state machine
 *                 (P66.createWizardState); the controller just renders.
 *
 * Dismissal memory: once the user finishes or skips, the wizard marks
 * localStorage key 'p66-wizard-seen' so it never auto-shows again.
 * The coordinator can reset it with P66.resetWizardSeen().
 *
 * Pure helpers (node-safe; covered by tools/wizard-test.js):
 *   P66.WIZARD_SEEN_KEY, P66.WIZARD_STEPS, P66.createWizardState(hooks),
 *   P66.wizardSeen(), P66.markWizardSeen(), P66.resetWizardSeen(),
 *   P66.binSizeNote(file) -> warning string | null
 *
 * Works in browser and node. No dependencies.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var SEEN_KEY = 'p66-wizard-seen';
  P66.WIZARD_SEEN_KEY = SEEN_KEY;

  /* ---------- storage (localStorage with a memory fallback, like ledger.js) ---------- */

  function memoryStore() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  var fallbackStore = null; // one shared in-memory store when localStorage is unavailable (node, private mode)
  function wizardStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* private mode */ }
    if (!fallbackStore) fallbackStore = memoryStore();
    return fallbackStore;
  }

  function wizardSeen() {
    try { return wizardStore().getItem(SEEN_KEY) === '1'; }
    catch (e) { return false; }
  }

  function markWizardSeen() {
    try { wizardStore().setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
  }

  function resetWizardSeen() {
    try { wizardStore().removeItem(SEEN_KEY); } catch (e) { /* ignore */ }
  }

  P66.wizardSeen = wizardSeen;
  P66.markWizardSeen = markWizardSeen;
  P66.resetWizardSeen = resetWizardSeen;

  /* ---------- step definitions ---------- */

  // No jargon without a gloss: every technical term gets a plain-English
  // explanation in the same sentence.
  var STEPS = [
    {
      key: 'log',
      title: 'Drop your log',
      intro: 'A log is a recording of your engine while you drive — the PCM ' +
        '(your car\'s computer) spits out numbers like RPM, throttle, and ' +
        'fuel trims, and TunerPro RT (the free logging program) saves them ' +
        'as a CSV spreadsheet. In TunerPro RT, hit Record while you drive, ' +
        'then export the log to CSV and drop it here.',
      hint: 'Dropped more than one? They get stitched together into one ' +
        'longer drive — a longer log means a more trustworthy tune.'
    },
    {
      key: 'bin',
      title: 'Drop your ORIGINAL 64KB binary',
      intro: 'Your binary is the program read straight out of your PCM with ' +
        'your chip burner or flashing tool — the untouched, stock file, ' +
        'exactly as the car left the factory. The tuner calculates every ' +
        'change against this exact file, so it has to be the original read: ' +
        'never a file someone already tuned.',
      hint: 'A stock P66 read is exactly 64KB (65,536 bytes). If your file ' +
        'is a different size, double-check it\'s the right read before ' +
        'going on. Table definitions ship built in, so there\'s nothing ' +
        'else to upload.'
    },
    {
      key: 'mode',
      title: 'Easy or Advanced?',
      intro: 'Pick how you want to work. You can switch anytime later — ' +
        'nothing here is permanent.',
      hint: null
    }
  ];
  P66.WIZARD_STEPS = STEPS;

  var MODES = [
    {
      id: 'easy',
      title: 'Easy',
      desc: 'Guided, a few clicks: the safest settings are locked in and ' +
        'the app walks you through the whole thing. Start here if this is ' +
        'your first tune.'
    },
    {
      id: 'advanced',
      title: 'Advanced',
      desc: 'All the tables and knobs — the full analyzer, every ' +
        'suggestion, every override. For when you\'ve done this before ' +
        'and want full control.'
    }
  ];
  P66.WIZARD_MODES = MODES;

  /* ---------- 64KB size note (non-blocking; the app's own guard rechecks) ---------- */

  var BIN_BYTES = 65536;
  function binSizeNote(file) {
    if (!file || typeof file.size !== 'number') return null;
    if (file.size === BIN_BYTES) return null;
    return 'That file is ' + file.size.toLocaleString('en-US') + ' bytes, not 64KB ' +
      '(65,536 bytes). A stock P66 read should be exactly 64KB — ' +
      'make sure you picked the original read off your PCM.';
  }
  P66.binSizeNote = binSizeNote;

  /* ---------- pure state machine: step order, validation, dismissal ---------- */

  // createWizardState(hooks) -> state
  //   state: { index, logFiles, binFile, mode, done, skipped }
  //   state.canAdvance()   -> { ok, message }
  //   state.next()         -> true if the step changed (fires onFilesReady
  //                           when leaving the binary step)
  //   state.back()         -> true if the step changed
  //   state.skip()         -> marks seen, flags skipped
  //   state.selectMode(id) -> 'easy' | 'advanced' | null
  //   state.finish()       -> marks seen, flags done, fires onModeSelect
  //   state.progress()     -> { index, total, label: 'Step 1 of 3' }
  function createWizardState(hooks) {
    hooks = hooks || {};
    var state = {
      index: 0,
      logFiles: [],
      binFile: null,
      mode: null,
      done: false,
      skipped: false
    };

    function ok() { return { ok: true, message: null }; }
    function fail(message) { return { ok: false, message: message }; }

    function canAdvance() {
      if (state.index === 0) {
        return state.logFiles.length ? ok()
          : fail('Drop at least one log file first — that\'s what the tuner reads.');
      }
      if (state.index === 1) {
        return state.binFile ? ok()
          : fail('Drop your original 64KB binary to continue — the tuner needs the untouched file to work from.');
      }
      return ok();
    }

    function next() {
      var gate = canAdvance();
      if (!gate.ok || state.done || state.skipped) return false;
      if (state.index >= STEPS.length - 1) return false;
      state.index++;
      if (state.index === 2 && typeof hooks.onFilesReady === 'function') {
        hooks.onFilesReady({
          logFiles: state.logFiles.slice(),
          binFile: state.binFile,
          xdfSource: 'built-in'
        });
      }
      return true;
    }

    function back() {
      if (state.index <= 0 || state.done || state.skipped) return false;
      state.index--;
      return true;
    }

    function skip() {
      if (state.done) return false;
      state.skipped = true;
      markWizardSeen();
      if (typeof hooks.onSkip === 'function') hooks.onSkip();
      return true;
    }

    function selectMode(id) {
      if (id !== 'easy' && id !== 'advanced') return null;
      state.mode = id;
      return id;
    }

    function finish() {
      if (!state.mode || state.done || state.skipped) return false;
      state.done = true;
      markWizardSeen();
      if (typeof hooks.onModeSelect === 'function') hooks.onModeSelect(state.mode);
      return true;
    }

    function progress() {
      return {
        index: state.index,
        total: STEPS.length,
        label: 'Step ' + (state.index + 1) + ' of ' + STEPS.length
      };
    }

    state.canAdvance = canAdvance;
    state.next = next;
    state.back = back;
    state.skip = skip;
    state.selectMode = selectMode;
    state.finish = finish;
    state.progress = progress;
    return state;
  }
  P66.createWizardState = createWizardState;

  /* ---------- DOM rendering (browser only) ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function fileNames(files) {
    return files.map(function (f) { return f.name || '(unnamed file)'; });
  }

  // createWizard(container, hooks) -> controller | null
  // Renders the wizard into `container`. The controller returns:
  //   { goto(n), next(), back(), skip(), selectMode(id), finish(),
  //     getStep(), destroy() }
  function createWizard(container, hooks) {
    if (typeof document === 'undefined' || !container) return null;
    hooks = hooks || {};
    var state = createWizardState(hooks);

    var root = el('div', 'p66wiz');
    var progressEl = el('p', 'p66wiz-progress muted');
    var dotsEl = el('div', 'p66wiz-dots');
    var bodyEl = el('div', 'p66wiz-body');
    var warnEl = el('p', 'p66wiz-warn status-warn');
    warnEl.style.display = 'none';
    var navEl = el('div', 'p66wiz-nav');
    var backBtn = el('button', 'p66wiz-back', '← Back');
    var nextBtn = el('button', 'p66wiz-next', 'Next →');
    var skipLink = el('button', 'p66wiz-skip linklike', 'Skip the tour — take me to the normal app');
    navEl.appendChild(backBtn);
    navEl.appendChild(nextBtn);
    root.appendChild(progressEl);
    root.appendChild(dotsEl);
    root.appendChild(bodyEl);
    root.appendChild(warnEl);
    root.appendChild(navEl);
    root.appendChild(skipLink);
    container.appendChild(root);

    function showWarn(msg) {
      if (msg) { warnEl.innerHTML = esc(msg); warnEl.style.display = ''; }
      else { warnEl.innerHTML = ''; warnEl.style.display = 'none'; }
    }

    function dropzone(label, multi, accept, onFiles, currentNote) {
      var zone = el('div', 'p66wiz-drop');
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      if (multi) input.multiple = true;
      input.style.display = 'none';
      var lab = el('p', 'p66wiz-drop-label', esc(label));
      var note = el('p', 'p66wiz-drop-note muted', currentNote || 'or click to pick a file');
      zone.appendChild(input);
      zone.appendChild(lab);
      zone.appendChild(note);
      function handle(list) {
        var arr = [];
        for (var i = 0; i < list.length; i++) arr.push(list[i]);
        if (arr.length) onFiles(arr);
      }
      zone.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () { handle(input.files); input.value = ''; });
      ;['dragenter', 'dragover'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
      });
      ;['dragleave', 'drop'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
      });
      zone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) handle(e.dataTransfer.files);
      });
      return zone;
    }

    function fileList(names) {
      if (!names.length) return '';
      return '<ul class="p66wiz-files">' +
        names.map(function (n) { return '<li>✅ ' + esc(n) + '</li>'; }).join('') +
        '</ul>';
    }

    function render() {
      var step = STEPS[state.index];
      var prog = state.progress();
      progressEl.textContent = prog.label + ' — ' + step.title;
      dotsEl.innerHTML = '';
      STEPS.forEach(function (s, i) {
        var d = el('span', 'p66wiz-dot' + (i === state.index ? ' active' : '') + (i < state.index ? ' past' : ''));
        d.title = s.title;
        dotsEl.appendChild(d);
      });
      bodyEl.innerHTML = '';
      showWarn(null);

      var h = el('h2', 'p66wiz-title', esc(step.title));
      bodyEl.appendChild(h);
      bodyEl.appendChild(el('p', 'p66wiz-intro', esc(step.intro)));

      if (step.key === 'log') {
        bodyEl.appendChild(dropzone('Drop your TunerPro log here', true, '.csv,.tsv,.txt',
          function (files) {
            state.logFiles = files;
            render();
          }, 'CSV, TSV, or TXT — several at once is fine'));
        var listWrap = el('div', 'p66wiz-filelist', fileList(fileNames(state.logFiles)));
        bodyEl.appendChild(listWrap);
      } else if (step.key === 'bin') {
        bodyEl.appendChild(dropzone('Drop your ORIGINAL binary here', false, '.bin',
          function (files) {
            state.binFile = files[0] || null;
            render();
          }, 'exactly 64KB — the untouched stock read'));
        if (state.binFile) {
          bodyEl.appendChild(el('div', 'p66wiz-filelist',
            fileList([state.binFile.name + ' (' + state.binFile.size.toLocaleString('en-US') + ' bytes)'])));
          var note = binSizeNote(state.binFile);
          if (note) bodyEl.appendChild(el('p', 'p66wiz-note status-warn', esc(note)));
        }
      } else if (step.key === 'mode') {
        var cards = el('div', 'p66wiz-modes');
        MODES.forEach(function (m) {
          var card = el('button', 'p66wiz-mode' + (state.mode === m.id ? ' selected' : ''));
          card.innerHTML = '<strong>' + esc(m.title) + '</strong><span>' + esc(m.desc) + '</span>';
          card.addEventListener('click', function () {
            state.selectMode(m.id);
            render();
          });
          cards.appendChild(card);
        });
        bodyEl.appendChild(cards);
      }

      if (step.hint) bodyEl.appendChild(el('p', 'p66wiz-hint muted', esc(step.hint)));

      // Bench-verify reminder, in the repo's safety wording: a patched
      // binary is never implied safe to flash.
      if (step.key === 'mode') {
        bodyEl.appendChild(el('p', 'p66wiz-safety muted',
          'Heads up, same as always: whatever comes out of here is a file ' +
          'to review and bench-verify — never flash a binary you haven\'t ' +
          'checked on a spare PCM first.'));
      }

      backBtn.style.visibility = state.index === 0 ? 'hidden' : 'visible';
      nextBtn.style.display = state.index < STEPS.length - 1 ? '' : 'none';
      nextBtn.textContent = 'Next →';
      refreshNav();
    }

    function refreshNav() {
      var gate = state.canAdvance();
      if (state.index === STEPS.length - 1) {
        // Mode step: a separate Start button appears instead of Next.
        var start = root.querySelector('.p66wiz-start');
        if (!start) {
          start = el('button', 'p66wiz-start', 'Start tuning →');
          start.addEventListener('click', function () {
            if (!state.mode) {
              showWarn('Pick Easy or Advanced first — you can change your mind later.');
              return;
            }
            state.finish();
            destroy();
          });
          navEl.appendChild(start);
        }
        nextBtn.style.display = 'none';
      } else {
        var old = root.querySelector('.p66wiz-start');
        if (old) old.remove();
        nextBtn.disabled = !gate.ok;
        nextBtn.title = gate.ok ? '' : (gate.message || '');
      }
    }

    backBtn.addEventListener('click', function () { if (state.back()) render(); });
    nextBtn.addEventListener('click', function () {
      var gate = state.canAdvance();
      if (!gate.ok) { showWarn(gate.message); return; }
      if (state.next()) render();
    });
    skipLink.addEventListener('click', function () {
      state.skip();
      destroy();
    });

    function destroy() {
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    render();

    return {
      goto: function (n) {
        if (typeof n !== 'number' || n < 0 || n >= STEPS.length) return false;
        state.index = n;
        render();
        return true;
      },
      next: function () { var r = state.next(); render(); return r; },
      back: function () { var r = state.back(); render(); return r; },
      skip: function () { var r = state.skip(); destroy(); return r; },
      selectMode: function (id) { var r = state.selectMode(id); render(); return r; },
      finish: function () { var r = state.finish(); if (r) destroy(); return r; },
      getStep: function () { return state.index; },
      destroy: destroy
    };
  }
  P66.createWizard = createWizard;

})(typeof window !== 'undefined' ? window : global);
