/* P66-Tuner UI wiring
 * Connects file inputs to the P66 engine (parser -> mapper -> analyzer -> tuner).
 */
(function () {
  'use strict';

  var fileInputs = {
    xdf: document.getElementById('xdf-input'),
    ads: document.getElementById('ads-input'),
    bin: document.getElementById('bin-input'),
    log: document.getElementById('log-input'),
  };

  var fileSummary = document.getElementById('file-summary');
  var consoleOutput = document.getElementById('console');
  var mappingTable = document.getElementById('mapping-table');
  var analysisResults = document.getElementById('analysis-results');
  var tuneResults = document.getElementById('tune-results');
  var modeSelect = document.getElementById('mode');
  var dashParts = {
    heatmap: document.getElementById('heatmap'),
    regions: document.getElementById('region-chart'),
    knock: document.getElementById('knock-chart'),
    lambda: document.getElementById('lambda-chart'),
    comparison: document.getElementById('comparison')
  };

  var CANONICAL_LABELS = {
    RPM: 'RPM', MAP: 'MAP', MAF: 'MAF', TPS: 'TPS',
    STFT: 'STFT', STFT_B1: 'STFT Bank 1', STFT_B2: 'STFT Bank 2',
    LTFT: 'LTFT', LTFT_B1: 'LTFT Bank 1', LTFT_B2: 'LTFT Bank 2',
    KR: 'Knock Retard', IAT: 'IAT', ECT: 'ECT',
    CMD_LAMBDA: 'Commanded AFR/Lambda', WB_LAMBDA: 'Wideband AFR/Lambda',
    O2_B1: 'O2 Bank 1 (narrowband)', O2_B2: 'O2 Bank 2 (narrowband)', O2: 'O2 (narrowband)',
    SPARK_ADV: 'Spark Advance', INJ_PW: 'Injector PW',
    VSS: 'Vehicle Speed', BARO: 'Baro', TIME: 'Time'
  };

  // Session state
  var files = { xdf: null, ads: null, bin: null, log: null };
  var parsedLog = null;
  var mapResult = null;
  var sessionReport = null;
  var sessionHistory = []; // past reports for before/after comparison
  var xdfCatalog = null;
  var binBytes = null;
  var lastPatches = null;

  function resetDashboardPlaceholders() {
    var msgs = {
      heatmap: 'Run analysis to render the heatmap.',
      regions: 'Run analysis to render region breakdown.',
      knock: 'Run analysis to render knock events.',
      lambda: 'Run analysis to render the lambda trace.',
      comparison: 'Run analysis on two sessions to compare before/after.'
    };
    Object.keys(dashParts).forEach(function (k) {
      if (dashParts[k]) dashParts[k].innerHTML = '<p class="muted">' + msgs[k] + '</p>';
    });
  }

  function writeConsole(message) {
    var ts = new Date().toLocaleTimeString();
    consoleOutput.textContent = '[' + ts + '] ' + message + '\n' + consoleOutput.textContent;
  }

  function fileLabel(file) {
    if (!file) return 'not loaded';
    return file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
  }

  function refreshSummary() {
    fileSummary.innerHTML =
      '<ul>' +
      '<li><strong>XDF:</strong> ' + fileLabel(files.xdf) +
      (xdfCatalog ? ' — ' + xdfCatalog.tables.length + ' tables parsed' : '') + '</li>' +
      '<li><strong>ADS:</strong> ' + fileLabel(files.ads) + '</li>' +
      '<li><strong>BIN:</strong> ' + fileLabel(files.bin) +
      (binBytes ? ' — ' + binBytes.length + ' bytes' : '') + '</li>' +
      '<li><strong>LOG:</strong> ' + fileLabel(files.log) +
      (parsedLog ? ' — ' + parsedLog.rowCount + ' rows parsed' : '') + '</li>' +
      '</ul>';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMappingPreview() {
    if (!mapResult) {
      // Fallback: show canonical list awaiting a log.
      mappingTable.innerHTML = Object.keys(CANONICAL_LABELS).map(function (sig) {
        return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
          '<td class="muted">load a log to map</td>' +
          '<td class="status-warn">Pending</td></tr>';
      }).join('');
      return;
    }
    mappingTable.innerHTML = Object.keys(CANONICAL_LABELS).map(function (sig) {
      var m = mapResult.mapping[sig];
      if (m) {
        var cls = m.confidence === 'high' ? 'status-ok' : 'status-warn';
        var label = m.confidence === 'high' ? 'High' : 'Medium';
        return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
          '<td>' + esc(m.column) + '</td>' +
          '<td class="' + cls + '">' + label + '</td></tr>';
      }
      return '<tr><td>' + esc(CANONICAL_LABELS[sig]) + '</td>' +
        '<td class="muted">—</td><td class="status-bad">Missing</td></tr>';
    }).join('');
  }

  function readLogFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  function readBinaryFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(file);
    });
  }

  Object.entries(fileInputs).forEach(function (entry) {
    var key = entry[0], input = entry[1];
    input.addEventListener('change', function () {
      files[key] = input.files[0] || null;
      if (key === 'log' && files.log) {
        readLogFile(files.log).then(function (text) {
          parsedLog = P66.parseLogText(text);
          mapResult = P66.mapChannels(parsedLog.headers);
          sessionReport = null; // invalidate previous analysis
          analysisResults.innerHTML = '<p class="muted">Log reloaded — run analysis again.</p>';
          tuneResults.innerHTML = '<p class="muted">Generate tune suggestions after analysis.</p>';
          resetDashboardPlaceholders();
          refreshSummary();
          renderMappingPreview();
          writeConsole('LOG parsed: ' + parsedLog.rowCount + ' rows, ' +
            parsedLog.columnCount + ' columns (delimiter: ' +
            (parsedLog.delimiter === '\t' ? 'TAB' : parsedLog.delimiter) + ').');
          parsedLog.warnings.forEach(writeConsole);
          var mapped = Object.keys(mapResult.mapping).length;
          writeConsole('Channel mapping: ' + mapped + ' signals mapped, ' +
            mapResult.unmapped.length + ' columns unmapped.');
        }).catch(function (err) {
          writeConsole('Failed to read log file: ' + err);
        });
      } else if (key === 'xdf' && files.xdf) {
        readLogFile(files.xdf).then(function (text) {
          try {
            xdfCatalog = P66.parseXdfXml(text);
            writeConsole('XDF parsed: ' + xdfCatalog.deftitle + ' — ' +
              xdfCatalog.tables.length + ' tables, ' + xdfCatalog.constants.length + ' constants.');
          } catch (err) {
            xdfCatalog = null;
            writeConsole('XDF parse failed: ' + (err && err.message ? err.message : err));
          }
          refreshSummary();
        }).catch(function (err) {
          writeConsole('Failed to read XDF file: ' + err);
        });
      } else if (key === 'bin' && files.bin) {
        readBinaryFile(files.bin).then(function (bytes) {
          binBytes = bytes;
          lastPatches = null;
          refreshSummary();
          writeConsole('BIN loaded: ' + bytes.length + ' bytes.');
        }).catch(function (err) {
          writeConsole('Failed to read BIN file: ' + err);
        });
      } else {
        if (key === 'log') { parsedLog = null; mapResult = null; sessionReport = null; }
        if (key === 'xdf') { xdfCatalog = null; }
        if (key === 'bin') { binBytes = null; lastPatches = null; }
        refreshSummary();
        renderMappingPreview();
      }
      if (files[key]) writeConsole(key.toUpperCase() + ' file loaded: ' + files[key].name);
    });
  });

  document.getElementById('validate-btn').addEventListener('click', function () {
    var missing = ['xdf', 'ads'].filter(function (k) { return !files[k]; });
    if (missing.length) {
      writeConsole('Validation warning: missing ' + missing.join(', ').toUpperCase() + ' file(s). Log-only analysis still available.');
    } else {
      writeConsole('Validation passed: XDF and ADS loaded.');
    }
    if (!parsedLog) {
      writeConsole('No log parsed yet — load a CSV/TSV log to enable analysis.');
      return;
    }
    var required = ['RPM', 'MAP'];
    var absent = required.filter(function (s) { return !mapResult.mapping[s]; });
    if (absent.length) {
      writeConsole('Validation warning: log is missing key channels: ' + absent.join(', ') + '.');
    } else {
      writeConsole('Log channels OK: RPM, MAP present. ' +
        Object.keys(mapResult.mapping).length + ' signals mapped.');
    }
  });

  function renderAnalysis(report) {
    var dist = report.regionDistribution;
    var total = report.rowCount || 1;
    function pct(n) { return Math.round((100 * n) / total) + '%'; }

    var html = '<p><strong>' + report.rowCount + '</strong> rows analyzed.</p>';
    html += '<table><thead><tr><th>Region</th><th>Samples</th><th>Share</th></tr></thead><tbody>';
    P66.REGIONS.forEach(function (r) {
      html += '<tr><td>' + r + '</td><td>' + (dist[r] || 0) + '</td><td>' + pct(dist[r] || 0) + '</td></tr>';
    });
    html += '</tbody></table>';

    if (report.missingChannels.length) {
      html += '<p class="status-warn">Missing channels: ' + esc(report.missingChannels.join(', ')) +
        ' — region classification degraded.</p>';
    }

    // Fuel trims
    var ft = report.fuelTrims;
    html += '<h3>Fuel Trim Bias (top cells)</h3>';
    if (ft.available && ft.cells.length) {
      html += '<p class="muted">Overall avg |trim|: ' + ft.overallAvgAbsTrim + '% across ' +
        ft.totalSamples + ' samples, ' + ft.cellCount + ' cells.</p>';
      html += '<table><thead><tr><th>RPM</th><th>MAP kPa</th><th>Avg Trim %</th><th>Samples</th></tr></thead><tbody>';
      ft.cells.slice(0, 8).forEach(function (c) {
        var cls = Math.abs(c.avgTrim) >= 5 ? 'status-bad' : (Math.abs(c.avgTrim) >= 3 ? 'status-warn' : 'status-ok');
        html += '<tr><td>' + esc(c.rpmBin) + '</td><td>' + esc(c.mapBin) + '</td>' +
          '<td class="' + cls + '">' + (c.avgTrim > 0 ? '+' : '') + c.avgTrim + '</td>' +
          '<td>' + c.samples + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="muted">' + esc(ft.reason || 'No fuel trim data.') + '</p>';
    }

    // Knock
    var k = report.knock;
    html += '<h3>Knock</h3>';
    if (k.available) {
      var kcls = k.knockSamples === 0 ? 'status-ok' : (k.maxKR >= 4 ? 'status-bad' : 'status-warn');
      html += '<p class="' + kcls + '">' + k.knockSamples + ' knock samples (' + k.knockPct +
        '%), max KR ' + k.maxKR + '°, avg when active ' + k.avgKRWhenActive + '°.</p>';
    } else {
      html += '<p class="muted">' + esc(k.reason || 'No knock data.') + '</p>';
    }

    // Lambda
    var l = report.lambda;
    html += '<h3>Commanded vs Wideband Lambda</h3>';
    if (l.available) {
      var lcls = l.meanAbsError <= 0.03 ? 'status-ok' : 'status-warn';
      html += '<p class="' + lcls + '">Mean abs error ' + l.meanAbsError + ' λ, ' +
        l.pctWithin3Pct + '% within ±0.03 λ (' + l.samples + ' samples).</p>';
    } else {
      html += '<p class="muted">' + esc(l.reason || 'No lambda data.') + '</p>';
    }

    // Narrowband O2
    var nb = report.narrowband;
    html += '<h3>Narrowband O2</h3>';
    if (nb.available) {
      html += '<p class="muted">Sensor health: ' +
        nb.crossCounts.map(function (c) {
          return esc(c.bank) + ' ' + esc(c.health) +
            (c.perMin !== null ? ' (' + c.perMin + '/min)' : '');
        }).join(', ') + '. WOT check: ' + esc(nb.wotCheck.status) + '.</p>';
      if (nb.cells.length) {
        html += '<table><thead><tr><th>RPM</th><th>MAP kPa</th><th>Avg O2 mV</th><th>Bias</th><th>Samples</th></tr></thead><tbody>';
        nb.cells.slice(0, 8).forEach(function (c) {
          var cls = c.bias === 'lean' ? 'status-bad' : (c.bias === 'rich' ? 'status-warn' : 'status-ok');
          html += '<tr><td>' + esc(c.rpmBin) + '</td><td>' + esc(c.mapBin) + '</td>' +
            '<td>' + c.avgMv + '</td><td class="' + cls + '">' + c.bias + '</td>' +
            '<td>' + c.samples + '</td></tr>';
        });
        html += '</tbody></table>';
      }
    } else {
      html += '<p class="muted">' + esc(nb.reason || 'No O2 data.') + '</p>';
    }

    analysisResults.innerHTML = html;
  }

  document.getElementById('analyze-btn').addEventListener('click', function () {
    if (!parsedLog || !mapResult) {
      writeConsole('Analyze blocked: load a log file first.');
      return;
    }
    try {
      sessionReport = P66.analyzeSession(parsedLog, mapResult);
      sessionHistory.push(sessionReport);
      if (sessionHistory.length > 10) sessionHistory.shift();
      renderAnalysis(sessionReport);
      P66.renderDashboard(dashParts, sessionReport, parsedLog, mapResult, sessionHistory);
      writeConsole('Analysis complete: ' + sessionReport.rowCount + ' rows, ' +
        Object.keys(sessionReport.regionDistribution).length + ' regions classified. ' +
        '(session ' + sessionHistory.length + ' in history)');
    } catch (err) {
      writeConsole('Analysis failed: ' + (err && err.message ? err.message : err));
    }
  });

  function renderTune(result) {
    var html = '<p><strong>' + esc(result.summary) + '</strong></p>';
    if (result.actionable.length) {
      html += '<h3>Actionable</h3><table><thead><tr><th>Table</th><th>Cell</th><th>Action</th><th>Detail</th><th>Confidence</th></tr></thead><tbody>';
      result.actionable.forEach(function (s) {
        var detail = s.deltaPct !== undefined && s.deltaPct !== 0
          ? (s.deltaPct > 0 ? '+' : '') + s.deltaPct + '%'
          : (s.deltaDeg !== undefined ? s.deltaDeg + '°' : '—');
        var cls = s.confidence === 'high' ? 'status-ok' : 'status-warn';
        html += '<tr><td>' + esc(s.table) + '</td><td>' + esc(s.cell) + '</td>' +
          '<td>' + esc(s.action) + '</td><td>' + esc(detail) + '</td>' +
          '<td class="' + cls + '">' + esc(s.confidence) + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<h3>Why</h3><ul>';
      result.actionable.forEach(function (s) {
        html += '<li><strong>' + esc(s.table) + ' / ' + esc(s.cell) + ':</strong> ' + esc(s.reason) + '</li>';
      });
      html += '</ul>';
    }
    if (result.blocked.length) {
      html += '<h3>Held by safety gates</h3><ul>';
      result.blocked.forEach(function (s) {
        html += '<li><strong>' + esc(s.table) + ' / ' + esc(s.cell) + ':</strong> ' + esc(s.reason) + '</li>';
      });
      html += '</ul>';
    }
    html += '<p class="status-warn"><strong>Review every suggestion manually before flashing. ' +
      'Re-log after applying changes and iterate.</strong></p>';

    // Concrete binary patches when XDF + BIN are loaded.
    lastPatches = null;
    if (xdfCatalog && binBytes) {
      try {
        var patchResult = P66.applyFuelSuggestions(xdfCatalog, binBytes, result.actionable);
        if (patchResult.error) {
          html += '<p class="status-warn">Binary patching unavailable: ' + esc(patchResult.error) + '</p>';
        } else if (patchResult.patches.length) {
          lastPatches = patchResult;
          html += '<h3>Binary Patches (Main VE)</h3>';
          html += '<table><thead><tr><th>Address</th><th>Cell</th><th>Old</th><th>New</th><th>Δ</th></tr></thead><tbody>';
          patchResult.patches.forEach(function (p) {
            html += '<tr><td>' + esc(p.addressHex) + '</td>' +
              '<td>' + p.rpm + ' RPM / ' + p.map + ' kPa</td>' +
              '<td>' + p.oldValue + '</td><td>' + p.newValue + '</td>' +
              '<td>' + (p.deltaPct > 0 ? '+' : '') + p.deltaPct + '%</td></tr>';
          });
          html += '</tbody></table>';
          html += '<p><button id="download-bin-btn" style="width:auto;padding:0.55rem 1.2rem;">Download patched binary</button></p>';
          html += '<p class="status-bad"><strong>Checksum not corrected.</strong> ' +
            'The P66 XDF carries no checksum definition — validate and fix the checksum ' +
            'before flashing, or the PCM may reject the image.</p>';
        } else {
          html += '<p class="muted">No fuel patches applied (no actionable fuel suggestions).</p>';
        }
      } catch (err) {
        html += '<p class="status-warn">Patch generation failed: ' + esc(err && err.message ? err.message : err) + '</p>';
      }
    } else {
      html += '<p class="muted">Load an XDF + stock binary to get concrete binary patches.</p>';
    }

    tuneResults.innerHTML = html;

    var dlBtn = document.getElementById('download-bin-btn');
    if (dlBtn && lastPatches && lastPatches.patched) {
      dlBtn.addEventListener('click', function () {
        var blob = new Blob([lastPatches.patched], { type: 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'p66-tuned.bin';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
        writeConsole('Patched binary downloaded (' + lastPatches.patches.length + ' patches). Checksum NOT corrected — validate before flashing.');
      });
    }
  }

  document.getElementById('tune-btn').addEventListener('click', function () {
    if (!sessionReport) {
      writeConsole('Tune blocked: run analysis first.');
      return;
    }
    var mode = modeSelect ? modeSelect.value : 'conservative';
    try {
      var result = P66.generateSuggestions(sessionReport, mode);
      renderTune(result);
      writeConsole('Tune suggestions generated (' + mode + ' mode): ' + result.summary);
    } catch (err) {
      writeConsole('Tune generation failed: ' + (err && err.message ? err.message : err));
    }
  });

  refreshSummary();
  renderMappingPreview();
})();
