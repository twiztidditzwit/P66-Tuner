const fileInputs = {
  xdf: document.getElementById('xdf-input'),
  ads: document.getElementById('ads-input'),
  log: document.getElementById('log-input'),
};

const fileSummary = document.getElementById('file-summary');
const consoleOutput = document.getElementById('console');
const mappingTable = document.getElementById('mapping-table');

const canonicalSignals = [
  'RPM',
  'MAP',
  'MAF',
  'STFT',
  'LTFT',
  'KR',
  'Commanded AFR/Lambda',
  'Wideband AFR/Lambda',
];

let files = { xdf: null, ads: null, log: null };

function writeConsole(message) {
  const ts = new Date().toLocaleTimeString();
  consoleOutput.textContent = `[${ts}] ${message}\n${consoleOutput.textContent}`;
}

function fileLabel(file) {
  if (!file) return 'not loaded';
  return `${file.name} (${Math.round(file.size / 1024)} KB)`;
}

function refreshSummary() {
  fileSummary.innerHTML = `
    <ul>
      <li><strong>XDF:</strong> ${fileLabel(files.xdf)}</li>
      <li><strong>ADS:</strong> ${fileLabel(files.ads)}</li>
      <li><strong>LOG:</strong> ${fileLabel(files.log)}</li>
    </ul>
  `;
}

function guessChannel(signal, logName, adsName) {
  const n = `${logName || ''} ${adsName || ''}`.toLowerCase();
  const checks = {
    RPM: ['rpm', 'engine speed'],
    MAP: ['map', 'manifold'],
    MAF: ['maf', 'airflow'],
    STFT: ['stft', 'short fuel'],
    LTFT: ['ltft', 'long fuel'],
    KR: ['kr', 'knock retard'],
    'Commanded AFR/Lambda': ['commanded', 'eq ratio', 'desired afr'],
    'Wideband AFR/Lambda': ['wideband', 'afr', 'lambda'],
  };

  const matched = (checks[signal] || []).some((term) => n.includes(term));
  if (matched) return { channel: 'Auto-detected candidate', status: 'Likely', cls: 'status-ok' };
  return { channel: 'No clear hint yet', status: 'Needs mapping', cls: 'status-warn' };
}

function renderMappingPreview() {
  const logName = files.log?.name;
  const adsName = files.ads?.name;

  mappingTable.innerHTML = canonicalSignals
    .map((signal) => {
      const result = guessChannel(signal, logName, adsName);
      return `<tr>
        <td>${signal}</td>
        <td>${result.channel}</td>
        <td class="${result.cls}">${result.status}</td>
      </tr>`;
    })
    .join('');
}

Object.entries(fileInputs).forEach(([key, input]) => {
  input.addEventListener('change', () => {
    files[key] = input.files[0] || null;
    refreshSummary();
    renderMappingPreview();
    if (files[key]) {
      writeConsole(`${key.toUpperCase()} file loaded: ${files[key].name}`);
    }
  });
});

function missingRequired() {
  const required = ['xdf', 'ads'];
  return required.filter((k) => !files[k]);
}

document.getElementById('validate-btn').addEventListener('click', () => {
  const missing = missingRequired();
  if (missing.length) {
    writeConsole(`Validation warning: missing ${missing.join(', ').toUpperCase()} file(s).`);
    return;
  }
  writeConsole('Validation passed: XDF and ADS loaded. Ready for analysis.');
});

document.getElementById('analyze-btn').addEventListener('click', () => {
  if (!files.log) {
    writeConsole('Analyze blocked: load a log file first.');
    return;
  }
  writeConsole('Analysis run complete (UI preview): generated baseline error-map placeholders.');
});

document.getElementById('tune-btn').addEventListener('click', () => {
  const missing = missingRequired();
  if (missing.length) {
    writeConsole('Auto-tune blocked: load XDF + ADS first.');
    return;
  }
  writeConsole('Generated conservative tune suggestion set (preview mode). Review manually before use.');
});

refreshSummary();
renderMappingPreview();
