/* P66-Tuner analysis Web Worker entry.
 *
 * Loaded via `new Worker('js/analyzer-worker.js')` — NEVER via a <script>
 * tag. Moves P66.analyzeSession off the main thread with coarse progress
 * reporting so large logs don't hang the tab.
 *
 * Protocol (main -> worker):
 *   { table, mapResult, opts }
 *     table     — P66.tableToTransport() output: plain table fields plus
 *                 COPIES of the Float32Array columns (transferred buffers)
 *     mapResult — channel mapping ({ mapping, unmapped }), structured-cloned
 *     opts      — analyzeSession opts ({ altitudeFt })
 * Protocol (worker -> main):
 *   { type: 'progress', pct, stage }   — coarse stage progress, pct 0-100
 *   { type: 'done', report }           — the analyzeSession report
 *                                         (structured-clone safe)
 *   { type: 'error', message }         — analysis threw; message is a string
 */

// --- dependency closure, explicit and ordered ---
// The plain scripts below attach to `(typeof window !== 'undefined' ? window
// : global)`. Workers have no `window`, so alias the worker global before
// loading them; all P66.* state then lives on the worker scope.
var window = self;

importScripts(
  // 1. columnar log table: P66.asTable, P66.numView, P66.regionAt,
  //    P66.rewrapTable (worker-side table rebuild)
  'log-parser.js',
  // 2. channel mapping: P66.columnFor, P66.fuelTrimBanks,
  //    P66.detectTrimStyle, P66.trimToPct
  'channel-mapper.js',
  // 3. drive segments: P66.classifySegment (used by feature extraction)
  'segments.js',
  // 4. altitude / baro plausibility: P66.analyzeBaro, P66.DEFAULT_ALTITUDE_FT
  'altitude.js',
  // 5. shared async helpers: P66.tableFromTransport (same file as the
  //    main-thread wrapper; only the transport helpers are used here)
  'analyze-async.js',
  // 6. the analyzer: P66.extractFeatures, P66.analyzeSession (with its
  //    onStage progress hook), P66.ANALYSIS_STAGES
  'analyzer.js'
);

onmessage = function (e) {
  var msg = (e && e.data) || {};
  try {
    // Rebuild the lightweight table wrapper around the transferred columns.
    var table = P66.tableFromTransport(msg.table);
    var report = P66.analyzeSession(
      table,
      msg.mapResult,
      msg.opts || {},
      function (stageKey, pct) {
        postMessage({ type: 'progress', pct: pct, stage: stageKey });
      }
    );
    postMessage({ type: 'done', report: report });
  } catch (err) {
    postMessage({
      type: 'error',
      message: (err && err.message) ? err.message : String(err)
    });
  }
};
