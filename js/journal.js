/* P66-Tuner tune journal
 *
 * Tuning is an iterative loop: log -> analyze -> patch -> flash -> drive ->
 * log again. The journal is where the human writes down what happened
 * between the numbers: "flashed 10/11, pulled 2° at 3000rpm, knock gone but
 * idle hunts." The next session's numbers only make sense with those notes.
 *
 * Entries persist in localStorage (memory shim when unavailable, injectable
 * for tests):
 *
 *   var journal = P66.createJournal();
 *   journal.add({ logName, binFingerprint, patchCount, note }) -> entry
 *   journal.list()   // newest first
 *   journal.remove(id)
 *   journal.clear()
 *
 * Export: P66.journalToForumText(entries) renders the journal as forum-ready
 * plain text (pure); P66.copyJournalText(entries) copies it to the clipboard
 * with a textarea fallback. A "Copy for forum" button is injected at the top
 * of the dashboard journal panel automatically (browser only, idempotent).
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  var STORE_KEY = 'p66-journal-v1';
  var MAX_ENTRIES = 50;

  function memoryStore() {
    var data = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; }
    };
  }

  function defaultStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* private mode */ }
    return memoryStore();
  }

  function load(store) {
    try {
      var raw = store.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function save(store, entries) {
    try { store.setItem(STORE_KEY, JSON.stringify(entries)); } catch (e) { /* storage full/blocked */ }
  }

  function makeId() {
    return 'j' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function createJournal(store) {
    store = store || defaultStore();

    return {
      add: function (entry) {
        entry = entry || {};
        var note = String(entry.note || '').trim();
        if (!note) return null; // empty notes are noise; refuse politely
        var entries = load(store);
        var full = {
          id: makeId(),
          date: new Date().toISOString(),
          logName: entry.logName || '',
          binFingerprint: entry.binFingerprint || '',
          patchCount: entry.patchCount || 0,
          rows: entry.rows || 0,
          patchKinds: entry.patchKinds || null,
          note: note
        };
        entries.unshift(full); // newest first
        while (entries.length > MAX_ENTRIES) entries.pop();
        save(store, entries);
        return full;
      },

      list: function () {
        return load(store);
      },

      remove: function (id) {
        var entries = load(store).filter(function (e) { return e.id !== id; });
        save(store, entries);
      },

      clear: function () {
        save(store, []);
      }
    };
  }

  /* ---------- forum export ----------
   *
   * One-click copy of the journal as plain text for gearhead-efi / Facebook.
   * No HTML, no markdown, fixed-width friendly, every line <= 100 chars.
   *
   *   P66.journalToForumText(entries)  // pure; entries as returned by list()
   *   P66.copyJournalText(entries)     // clipboard + textarea fallback
   *   P66.journalCopyButton(getEntries) // DOM button with transient feedback
   *   P66.mountJournalExport(panel, getEntries) // inject button at panel top
   *   P66.autoMountJournalExport()     // no-op outside a browser
   *
   * Entry fields rendered: date, logName (+ rows), patch counts by kind with
   * deltas (patchCount total, or patchKinds: { VE: {count, delta} | n, ... }),
   * and the note. Input order is preserved (journal.list() is newest first).
   */

  var FORUM_LINE_MAX = 100;

  function forumDate(v) {
    var s = String(v || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : 'unknown date';
  }

  function group3(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function forumWrap(prefix, text, max) {
    max = max || FORUM_LINE_MAX;
    var words = String(text).split(/\s+/).filter(function (w) { return w.length; });
    var lines = [];
    var cur = prefix;
    words.forEach(function (w) {
      while (w.length > max - prefix.length) { // hard-split a monster word
        var room = max - cur.length;
        if (room > 1) { cur += (cur === prefix ? '' : ' ') + w.slice(0, room); w = w.slice(room); }
        lines.push(cur); cur = prefix;
      }
      var add = (cur === prefix ? '' : ' ') + w;
      if ((cur + add).length > max) { lines.push(cur); cur = prefix + w; }
      else { cur += add; }
    });
    if (cur !== prefix || !lines.length) lines.push(cur);
    return lines;
  }

  function kindCount(k) {
    if (k && typeof k === 'object') return Number(k.count) || 0;
    return Number(k) || 0;
  }

  function kindDelta(k) {
    if (k && typeof k === 'object' && k.delta) return String(k.delta);
    return '';
  }

  function patchSummary(e) {
    var kinds = (e && e.patchKinds && typeof e.patchKinds === 'object') ? e.patchKinds : null;
    var total = Number((e && e.patchCount) || 0);
    var parts = [];
    var sum = 0;
    if (kinds) {
      Object.keys(kinds).forEach(function (name) {
        var c = kindCount(kinds[name]);
        var d = kindDelta(kinds[name]);
        sum += c;
        parts.push(name + ': ' + group3(c) + (d ? ' (' + d + ')' : ''));
      });
    }
    if (!parts.length && total) sum = total;
    else if (!parts.length && !total) return '';
    var head = total ? 'Patches: ' + group3(total) : 'Patches: ' + group3(sum);
    return parts.length ? head + ' — ' + parts.join(', ') : head;
  }

  function journalToForumText(entries) {
    entries = Array.isArray(entries) ? entries : [];
    var lines = [];
    var dates = entries
      .map(function (e) { return e && e.date ? String(e.date).slice(0, 10) : ''; })
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); })
      .sort();
    var header = 'P66-Tuner tune journal';
    if (dates.length) header += ' — ' + dates[0] + ' to ' + dates[dates.length - 1];
    lines.push(header);
    lines.push(new Array(Math.min(header.length, FORUM_LINE_MAX) + 1).join('='));
    lines.push('');
    if (!entries.length) {
      lines.push('No journal entries yet — add a note after your next flash or log review.');
      lines.push('');
    }
    entries.forEach(function (e, i) {
      e = e || {};
      var head = forumDate(e.date);
      if (e.logName) {
        head += ' — ' + String(e.logName);
        if (Number(e.rows)) head += ' (' + group3(Number(e.rows)) + ' rows)';
      }
      forumWrap('', head, FORUM_LINE_MAX).forEach(function (l) { lines.push(l); });
      var ps = patchSummary(e);
      if (ps) forumWrap('  ', ps, FORUM_LINE_MAX).forEach(function (l) { lines.push(l); });
      forumWrap('  Note: ', String(e.note || ''), FORUM_LINE_MAX).forEach(function (l) { lines.push(l); });
      if (i < entries.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('--');
    lines.push('SAFETY: these are suggestions, not a finished tune. Review every change manually');
    lines.push('and bench-verify on a spare PCM before flashing. No checksum is defined for the');
    lines.push('P66 PCM and no checksum correction is applied — flashing is at your own risk.');
    return lines.join('\n');
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function copyJournalText(entries) {
    var text = journalToForumText(entries);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () { return true; },
          function () {
            return (typeof document !== 'undefined') ? legacyCopy(text) : false;
          }
        );
      }
    } catch (e) { /* clipboard blocked; fall through */ }
    if (typeof document !== 'undefined') {
      try { return Promise.resolve(legacyCopy(text)); }
      catch (e) { return Promise.resolve(false); }
    }
    return false; // node / no clipboard: nothing to copy into, but never throws
  }

  function showCopyFallback(afterEl, text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.rows = 12;
    ta.style.width = '100%';
    ta.style.boxSizing = 'border-box';
    ta.style.marginTop = '0.5rem';
    afterEl.parentNode.insertBefore(ta, afterEl.nextSibling);
    ta.focus();
    ta.select();
    return ta;
  }

  function journalCopyButton(getEntries) {
    if (typeof document === 'undefined') return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'journal-copy-forum-btn';
    btn.style.width = 'auto';
    btn.style.marginBottom = '0.5rem';
    btn.textContent = 'Copy for forum';
    btn.title = 'Copy the journal as plain text for gearhead-efi / Facebook';
    btn.addEventListener('click', function () {
      var entries = [];
      try { entries = getEntries() || []; } catch (e) { entries = []; }
      var text = journalToForumText(entries);
      function report(ok) {
        btn.textContent = ok ? 'Copied ✓' : 'Copy failed — select the text manually';
        if (!ok) showCopyFallback(btn, text);
        setTimeout(function () { btn.textContent = 'Copy for forum'; }, ok ? 2000 : 6000);
      }
      var done = copyJournalText(entries);
      if (done && typeof done.then === 'function') {
        done.then(report, function () { report(false); });
      } else {
        report(!!done);
      }
    });
    return btn;
  }

  function mountJournalExport(panel, getEntries) {
    if (typeof document === 'undefined' || !panel) return null;
    if (panel.querySelector('#journal-copy-forum-btn')) return null; // already there
    var btn = journalCopyButton(getEntries);
    if (!btn) return null;
    if (panel.firstChild) panel.insertBefore(btn, panel.firstChild);
    else panel.appendChild(btn);
    return btn;
  }

  // The journal panel DOM is painted by dashboard.js's renderJournal (repainted
  // on every add/remove). Watch for it and keep the export button at the top.
  // Guarded and idempotent; no-op under node.
  function autoMountJournalExport() {
    try {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return false;
      var journal = createJournal();
      function ensure() {
        try {
          var panel = document.getElementById('journal');
          if (panel) mountJournalExport(panel, function () { return journal.list(); });
        } catch (e) { /* panel mid-render */ }
      }
      function start() {
        ensure();
        try { new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true }); }
        catch (e) { /* observer unavailable */ }
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
      return true;
    } catch (e) {
      return false;
    }
  }

  P66.createJournal = createJournal;
  P66.journalToForumText = journalToForumText;
  P66.copyJournalText = copyJournalText;
  P66.journalCopyButton = journalCopyButton;
  P66.mountJournalExport = mountJournalExport;
  P66._journalMemoryStore = memoryStore;

  try { autoMountJournalExport(); } catch (e) { /* never break the app on load */ }
})(typeof window !== 'undefined' ? window : global);
