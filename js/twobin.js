/* P66-Tuner two-bin upload workflow
 * The bin model everything else builds on.
 *
 * Two slots on the Load step:
 *   (a) "analyzed" — the bin that was in the PCM when the log was recorded.
 *       REQUIRED: trim analysis must attribute PCM behavior to the tables
 *       actually in the PCM at log time, so this is the bin that gets
 *       analyzed and patched.
 *   (b) "stock" — a stock / reference bin. OPTIONAL: it defaults into
 *       slot B of the compare-two-binaries drift view (js/bindiff.js) and
 *       serves as the restore baseline.
 *
 * Same-file detection: when both slots hold byte-identical binaries the PCM
 * is still stock and this is its first tune — P66.binsIdentical() drives the
 * isStockFirstTune flag, and P66.stockFirstTuneMessage() is the plain-English
 * line surfaced in the console/UI.
 *
 * Stickiness: the stock/reference bin survives across sessions via
 * P66.createTwoBinStore() (localStorage, base64, try/catch quota fallback),
 * the same "last-used" idea as js/xdf-library.js but simpler — one 64KB bin
 * is ~87KB of base64, well under localStorage quotas.
 *
 * Works in browser and node (no DOM, no FileReader).
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  /* ---------- slot model ---------- */

  // The two bin slots: analyzed is required, stock is optional.
  // UI code reads these so the slot contract lives in one place.
  P66.BIN_SLOTS = [
    {
      key: 'analyzed',
      label: 'Bin in the PCM when this log was recorded',
      required: true,
      hint: 'The tune is built from this bin — it must be the one that was in the PCM when the log was recorded.'
    },
    {
      key: 'stock',
      label: 'Stock / reference bin',
      required: false,
      hint: 'Optional. Defaults into slot B of the compare-two-binaries drift view and serves as the restore baseline.'
    }
  ];

  /* ---------- same-file detection ---------- */

  // True only when both sides exist, have the same length, and match byte
  // for byte. Comparing the bytes directly (instead of hashing) is exact
  // and exits early on the first difference.
  function binsIdentical(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    if (a.length === 0) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Plain-language line for the console/UI when both slots hold the same
  // file: the PCM is still stock and this is its first tune.
  function stockFirstTuneMessage() {
    return 'Same bin in both slots — treating this as a stock PCM\'s first tune. ' +
      'Patches are computed against your stock binary, which stays on as the restore baseline.';
  }

  /* ---------- base64 (browser + node) ---------- */

  // Chunked so String.fromCharCode never gets a 64K-argument call
  // (some browsers cap argument counts).
  function bytesToB64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(bytes).toString('base64');
    }
    var CHUNK = 8192;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    if (typeof btoa !== 'function') throw new Error('P66 two-bin store: no base64 encoder available.');
    return btoa(parts.join(''));
  }

  function b64ToBytes(str) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return new Uint8Array(Buffer.from(str, 'base64'));
    }
    if (typeof atob !== 'function') throw new Error('P66 two-bin store: no base64 decoder available.');
    var raw = atob(str);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* ---------- sticky stock/reference bin ---------- */

  var STOCK_BIN_KEY = 'p66-stock-bin';

  /**
   * P66.createTwoBinStore([storage]) -> { set, get, clear, KEY }
   * storage defaults to window.localStorage when available; pass an
   * object with getItem/setItem/removeItem to inject a fake (tests) or
   * pass null for memory-only.
   *
   * set(name, bytes) -> { ok, stored, message }: ok is true when the bytes
   *   round-tripped; stored is false when localStorage was unavailable or
   *   quota-blocked — then the bin is kept in memory for this session only.
   * get() -> { name, bytes } | null
   * clear() drops the stored bin.
   */
  function createTwoBinStore(storage) {
    if (storage === undefined) {
      storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
    }
    // In-memory fallback: used when there is no localStorage (node) and
    // when a quota error blocks the write — the bin still works for this
    // session, it just doesn't survive a reload.
    var mem = null;

    function set(name, bytes) {
      mem = { name: name, bytes: bytes };
      if (!storage) {
        return { ok: true, stored: false, message: 'no persistent storage available — kept for this session only' };
      }
      try {
        storage.setItem(STOCK_BIN_KEY, JSON.stringify({ name: name, b64: bytesToB64(bytes) }));
        return { ok: true, stored: true, message: 'saved for next session' };
      } catch (e) {
        // QuotaExceededError and friends: fall back to memory.
        return {
          ok: true, stored: false,
          message: 'could not save to local storage (' + (e && e.message ? e.message : e) + ') — kept for this session only'
        };
      }
    }

    function get() {
      if (storage) {
        try {
          var raw = storage.getItem(STOCK_BIN_KEY);
          if (raw) {
            var rec = JSON.parse(raw);
            if (rec && typeof rec.b64 === 'string') {
              return { name: rec.name || '(stored bin)', bytes: b64ToBytes(rec.b64) };
            }
          }
        } catch (e) {
          // Corrupt entry or blocked read: fall through to the memory copy.
        }
      }
      return mem;
    }

    function clear() {
      mem = null;
      if (storage) {
        try { storage.removeItem(STOCK_BIN_KEY); } catch (e) { /* ignore */ }
      }
    }

    return { set: set, get: get, clear: clear, KEY: STOCK_BIN_KEY };
  }

  /* ---------- compare-two-binaries slot defaulting ---------- */

  /**
   * P66.resolveBinDiffSlots(opts) -> { a, b, bDefaulted, note }
   * opts: { pickedA, pickedB, analyzedBytes, stockBytes, stockName }
   * (each a Uint8Array or null; pickedA/pickedB are files the user chose
   * inside the drift view itself.)
   *
   * The stock/reference bin defaults into slot B when present and the user
   * hasn't picked a B file themselves. Slot A is never defaulted — the
   * analyzed bin gets compared only once the user picks (or re-picks) A.
   */
  function resolveBinDiffSlots(opts) {
    opts = opts || {};
    var a = opts.pickedA || null;
    var b = opts.pickedB || opts.stockBytes || null;
    var bDefaulted = !opts.pickedB && !!opts.stockBytes;
    var note = bDefaulted
      ? 'Binary B defaulted to your stock/reference bin (' + (opts.stockName || 'stored bin') +
        ') — pick a file in slot B to compare against a different binary.'
      : '';
    return { a: a, b: b, bDefaulted: bDefaulted, note: note };
  }

  P66.binsIdentical = binsIdentical;
  P66.stockFirstTuneMessage = stockFirstTuneMessage;
  P66.createTwoBinStore = createTwoBinStore;
  P66.resolveBinDiffSlots = resolveBinDiffSlots;
})(typeof window !== 'undefined' ? window : global);
