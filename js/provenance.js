/* P66-Tuner output provenance
 * Audit trail for every patched binary the app offers for download.
 *
 *   P66.buildProvenance(sourceBytes, patchedBytes, patches, meta)
 *     -> { ok, sourceSha256, patchedSha256, changedByteCount,
 *          changeReport, uncovered, message }
 *
 * What it does:
 *   - SHA-256-hashes the source binary and the patched image
 *     (compact pure-JS implementation, synchronous, dependency-free —
 *     no crypto.subtle, so it works under node as well as in the browser).
 *   - Diffs the two images byte by byte and counts every changed byte.
 *   - Hard rule: every differing byte must be covered by a verified patch
 *     address. If ANY differing byte is not covered, ok === false and the
 *     caller must not offer the download — the patched image was altered
 *     outside the verified patch list.
 *   - Builds changeReport: a human-readable multi-line string with one
 *     line per changed table (address range, table name where known,
 *     and old->new values for every changed byte).
 *
 * This is an additional gate on top of js/verify.js, not a replacement:
 * verify.js proves each patch is individually safe; provenance proves the
 * final image contains nothing besides those patches.
 *
 * Depends on P66.findTable from js/xdf-map.js only for nicer table titles
 * (falls back to the patch's own table name when unavailable).
 * Works in browser and node.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  /* ---------- compact pure-JS SHA-256 (sync, no dependencies) ---------- */

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // bytes: Uint8Array (a Buffer works too). Returns lowercase hex digest.
  function sha256Hex(bytes) {
    var len = bytes.length;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    // Pad: append 0x80, zero-fill, then the 64-bit big-endian bit length.
    var padded = ((len + 9 + 63) >> 6) << 6;
    var msg = new Uint8Array(padded);
    msg.set(bytes, 0);
    msg[len] = 0x80;
    var dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    dv.setUint32(padded - 8, Math.floor((len * 8) / 0x100000000) >>> 0, false);
    dv.setUint32(padded - 4, (len * 8) >>> 0, false);

    var w = new Array(64);
    for (var off = 0; off < padded; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4, false);
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var out = '';
    for (var i = 0; i < 8; i++) {
      out += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
    }
    return out;
  }

  /* ---------- provenance ---------- */

  function parseAddr(a) {
    if (typeof a === 'number') return a;
    var s = String(a || '').trim();
    return s.slice(0, 2).toLowerCase() === '0x' ? parseInt(s, 16) : parseInt(s, 10);
  }

  function hex(addr) {
    return '0x' + addr.toString(16).toUpperCase();
  }

  function tableTitle(catalog, patchTable) {
    if (catalog && typeof P66.findTable === 'function' && patchTable) {
      try {
        var t = P66.findTable(catalog, patchTable);
        if (t && t.title) return t.title;
      } catch (e) { /* fall through to raw name */ }
    }
    return patchTable || '(unnamed table)';
  }

  /**
   * Build the provenance record for a patched image.
   * sourceBytes  Uint8Array — the original binary
   * patchedBytes Uint8Array — the binary offered for download
   * patches      array of { address, addressHex, sizeBytes, table, ... }
   * meta         { app, catalog, generatedAt } (all optional)
   */
  function buildProvenance(sourceBytes, patchedBytes, patches, meta) {
    meta = meta || {};
    var result = {
      ok: false,
      sourceSha256: null,
      patchedSha256: null,
      sourceLength: 0,
      changedByteCount: 0,
      changeReport: '',
      uncovered: [], // [{ start, end, startHex, endHex, count }]
      message: ''
    };

    if (!sourceBytes || !patchedBytes) {
      result.message = 'Download blocked: no binary image to audit — the source or patched binary is missing.';
      return result;
    }
    if (sourceBytes.length !== patchedBytes.length) {
      result.message = 'Download blocked: the patched image is ' + patchedBytes.length +
        ' bytes but the source binary is ' + sourceBytes.length +
        ' bytes — the image was rebuilt or corrupted outside the patch list.';
      return result;
    }
    if (sourceBytes.length === 0) {
      result.message = 'Download blocked: the binary image is empty — nothing to audit.';
      return result;
    }

    var n = sourceBytes.length;
    result.sourceLength = n;
    result.sourceSha256 = sha256Hex(sourceBytes);
    result.patchedSha256 = sha256Hex(patchedBytes);

    // Byte coverage claimed by the verified patch list.
    var covered = new Uint8Array(n);
    (patches || []).forEach(function (p) {
      var addr = parseAddr(p.address);
      var size = p.sizeBytes === 2 ? 2 : 1;
      for (var i = 0; i < size; i++) {
        if (addr + i >= 0 && addr + i < n) covered[addr + i] = 1;
      }
    });

    // Actual byte-by-byte diff of the two images.
    var diff = [];
    for (var a = 0; a < n; a++) {
      if (sourceBytes[a] !== patchedBytes[a]) diff.push(a);
    }
    result.changedByteCount = diff.length;

    // Hard rule: any differing byte not covered by a verified patch
    // address blocks the download.
    var uncoveredRuns = [];
    var cur = null;
    diff.forEach(function (addr) {
      if (covered[addr]) {
        cur = null;
      } else if (cur && addr === cur.end + 1) {
        cur.end = addr;
      } else {
        cur = { start: addr, end: addr };
        uncoveredRuns.push(cur);
      }
    });
    result.uncovered = uncoveredRuns.map(function (r) {
      return { start: r.start, end: r.end, startHex: hex(r.start), endHex: hex(r.end), count: r.end - r.start + 1 };
    });

    if (result.uncovered.length) {
      var where = result.uncovered.map(function (u) {
        return u.startHex + (u.end > u.start ? '..' + u.endHex : '');
      }).join(', ');
      result.message = 'Download blocked: the patched binary differs from your source binary at ' +
        diff.length + ' byte(s) that no verified patch covers (' + where +
        '). Something changed the image outside the verified patch list — do not flash this file. ' +
        'Re-run the tune; if this keeps happening, keep your original binary and report the issue.';
      result.changeReport = buildReport(result, meta, sourceBytes, patchedBytes, patches, true);
      return result;
    }

    result.ok = true;
    result.changeReport = buildReport(result, meta, sourceBytes, patchedBytes, patches, false);
    return result;
  }

  // One report line per changed table: name, address range, and every
  // changed byte's old->new value. Uncovered bytes get their own lines
  // under "(no patch covers these bytes)".
  function buildReport(result, meta, sourceBytes, patchedBytes, patches, includeUncovered) {
    var lines = [];
    lines.push('P66-Tuner change report — ' + (meta.app || 'p66-tuner'));
    lines.push('Generated (UTC): ' + (meta.generatedAt || new Date().toISOString()));
    lines.push('Source SHA-256:  ' + result.sourceSha256 + ' (' + result.sourceLength + ' bytes)');
    lines.push('Patched SHA-256: ' + result.patchedSha256 + ' (' + result.sourceLength + ' bytes)');
    lines.push('Changed bytes: ' + result.changedByteCount);
    lines.push('');

    // Group changed bytes by table via the patch list.
    var groups = {}; // table name -> { first, last, changes: ['0xEAA: 72 -> 76'] }
    var order = [];
    (patches || []).forEach(function (p) {
      var addr = parseAddr(p.address);
      var size = p.sizeBytes === 2 ? 2 : 1;
      var name = p.table || '(unnamed table)';
      for (var i = 0; i < size; i++) {
        var b = addr + i;
        if (b < 0 || b >= sourceBytes.length) continue;
        if (sourceBytes[b] === patchedBytes[b]) continue;
        var g = groups[name];
        if (!g) {
          g = groups[name] = { first: b, last: b, changes: [] };
          order.push(name);
        }
        if (b < g.first) g.first = b;
        if (b > g.last) g.last = b;
        g.changes.push(hex(b) + ': ' + sourceBytes[b] + ' -> ' + patchedBytes[b]);
      }
    });

    if (!order.length && result.changedByteCount === 0) {
      lines.push('(no bytes changed — the patched image is identical to the source binary)');
    }
    order.forEach(function (name) {
      var g = groups[name];
      var range = hex(g.first) + (g.last > g.first ? '..' + hex(g.last) : '');
      lines.push('"' + tableTitle(meta.catalog, name) + '" ' + range +
        ' — ' + g.changes.length + ' byte(s) changed: ' + g.changes.join('; '));
    });

    if (includeUncovered) {
      result.uncovered.forEach(function (u) {
        var changes = [];
        for (var b = u.start; b <= u.end; b++) {
          changes.push(hex(b) + ': ' + sourceBytes[b] + ' -> ' + patchedBytes[b]);
        }
        var range = u.startHex + (u.end > u.start ? '..' + u.endHex : '');
        lines.push('"(no patch covers these bytes)" ' + range +
          ' — ' + u.count + ' byte(s) changed: ' + changes.join('; '));
      });
    }

    return lines.join('\n');
  }

  P66.sha256Hex = sha256Hex;
  P66.buildProvenance = buildProvenance;
})(typeof window !== 'undefined' ? window : global);
