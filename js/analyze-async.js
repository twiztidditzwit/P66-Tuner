/* P66-Tuner async analysis wrapper.
 * Runs P66.analyzeSession off the main thread in a Web Worker with coarse
 * progress reporting, falling back to the synchronous path when Workers
 * are unavailable or fail (node, file:// CORS restrictions, load errors).
 *
 * Plain script — attaches to the global P66 namespace (browser + node
 * compatible). In the browser load it AFTER js/analyzer.js (see index.html);
 * the worker entry (js/analyzer-worker.js) also loads it via importScripts
 * for the shared tableToTransport/tableFromTransport helpers.
 *
 * API:
 *   P66.analyzeSessionAsync(table, mapResult, onProgress, opts)
 *     -> Promise<report>, where report is the same object P66.analyzeSession
 *        returns (structured-clone safe: no functions, no circular refs).
 *     table      — log table (or anything P66.asTable accepts)
 *     mapResult  — channel mapping from P66.mapChannels (posted to the worker)
 *     onProgress — optional function (pct, stageKey); pct is 0-100,
 *                  non-decreasing, and ends at 100
 *     opts       — passed through to P66.analyzeSession ({ altitudeFt })
 *
 * TRANSFER DESIGN: the worker needs the Float32Array columns. postMessage
 * with a transfer list moves the ArrayBuffers zero-copy — but transfer
 * NEUTERS the sender's buffers, and the app keeps using the main-thread
 * table after analysis (dashboard, playback, re-analysis). So the main
 * thread sends COPIES: each numeric column is slice()d, and the copies'
 * buffers are transferred. The original table is untouched; the extra
 * memcpy is far cheaper than a main-thread analysis jank on large logs.
 */
(function (global) {
  'use strict';

  var P66 = (global.P66 = global.P66 || {});

  // Human labels for the P66.ANALYSIS_STAGES keys, for progress UI.
  var ANALYSIS_STAGE_LABELS = {
    segments: 'Classifying regions',
    features: 'Extracting features',
    fuel: 'Fuel trims',
    knock: 'Knock',
    lambda: 'Lambda',
    narrowband: 'O2 sensors',
    tipIn: 'Tip-in enrichment',
    peEntry: 'Power-enrichment entry',
    transmission: 'Transmission',
    bankImbalance: 'Bank balance',
    baro: 'Baro check',
    report: 'Finishing'
  };

  /**
   * Serialize a log table into plain worker-postable data. Numeric columns
   * are COPIED (see header note) so the caller's table survives the
   * transfer; the returned `columns` entries are the copies whose buffers
   * should go on the postMessage transfer list.
   */
  function tableToTransport(t) {
    t = P66.asTable(t);
    var columns = (t.columns || []).map(function (c) {
      return (c instanceof Float32Array) ? c.slice() : null;
    });
    var colIndex = {};
    Object.keys(t.colIndex || {}).forEach(function (k) { colIndex[k] = t.colIndex[k]; });
    return {
      headers: (t.headers || []).slice(),
      colIndex: colIndex,
      rowCount: t.rowCount || 0,
      columnCount: t.columnCount || 0,
      delimiter: t.delimiter || ',',
      warnings: (t.warnings || []).slice(),
      stringCols: t.stringCols || {},
      regions: t.regions || null,
      columns: columns
    };
  }

  /**
   * Rebuild a working log table from tableToTransport() data (worker side,
   * after the column buffers arrive — transferred or cloned).
   */
  function tableFromTransport(data) {
    return P66.rewrapTable(data);
  }

  function workerSupported() {
    return typeof Worker !== 'undefined';
  }

  function emitProgress(onProgress, pct, stageKey) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(pct, stageKey); } catch (e) { /* listener error */ }
  }

  // Synchronous analysis with progress forwarded through the same
  // onStage hook the worker uses, so both paths report identically.
  function syncAnalyze(t, mapResult, opts, onProgress) {
    emitProgress(onProgress, 0, 'start');
    var report = P66.analyzeSession(t, mapResult, opts, function (key, pct) {
      emitProgress(onProgress, pct, key);
    });
    return report;
  }

  function runInWorker(t, mapResult, opts, onProgress) {
    var transport = tableToTransport(t);
    var worker = new Worker('js/analyzer-worker.js');
    return new Promise(function (resolve, reject) {
      var settled = false;
      function cleanup() { try { worker.terminate(); } catch (e) { /* noop */ } }
      function finishOk(report) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(report);
      }
      // Worker-side failure that smells environmental (script failed to
      // load, e.g. file:// CORS or a 404): fall back to the sync path
      // rather than failing the analysis outright.
      function fallback(err) {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(syncAnalyze(t, mapResult, opts, onProgress));
        } catch (e2) {
          reject(e2);
        }
      }
      worker.onmessage = function (e) {
        var m = (e && e.data) || {};
        if (m.type === 'progress') {
          emitProgress(onProgress, m.pct, m.stage);
        } else if (m.type === 'done') {
          finishOk(m.report);
        } else if (m.type === 'error') {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(m.message || 'analysis worker failed'));
        }
      };
      worker.onerror = function () { fallback(new Error('worker load error')); };
      var transfer = [];
      transport.columns.forEach(function (c) {
        if (c) transfer.push(c.buffer);
      });
      try {
        worker.postMessage({
          table: transport,
          mapResult: mapResult,
          opts: opts || {}
        }, transfer);
      } catch (postErr) {
        // postMessage can throw synchronously on some origins (e.g. file://
        // origin checks): treat as environmental and fall back to sync.
        fallback(postErr);
      }
    });
  }

  /**
   * Analyze a log, off the main thread when Workers are available.
   * Always returns a Promise of the analyzeSession report; the report is
   * identical to the synchronous one (same code, same inputs).
   */
  function analyzeSessionAsync(table, mapResult, onProgress, opts) {
    var t = P66.asTable(table);
    var options = opts || {};
    if (workerSupported()) {
      try {
        return runInWorker(t, mapResult, options, onProgress);
      } catch (err) {
        // Worker construction threw (e.g. file:// CORS): sync fallback.
      }
    }
    return new Promise(function (resolve, reject) {
      try {
        resolve(syncAnalyze(t, mapResult, options, onProgress));
      } catch (err) {
        reject(err);
      }
    });
  }

  P66.ANALYSIS_STAGE_LABELS = ANALYSIS_STAGE_LABELS;
  P66.tableToTransport = tableToTransport;
  P66.tableFromTransport = tableFromTransport;
  P66.workerSupported = workerSupported;
  P66.analyzeSessionAsync = analyzeSessionAsync;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
