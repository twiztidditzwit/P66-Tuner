# P66-Tuner

A **16184737 BNFM code P66 PCM LOG analyzer and master auto tuner** focused on turning raw PCM logs into actionable calibration guidance.

## UI Preview Included

This repository now includes a lightweight browser UI to start using the project flow immediately:

- load `.xdf`, `.ads`, and log files
- validate required definitions
- run analyzer/tuner preview actions
- review a basic channel-mapping preview and output console

### Run the UI

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## Overview

P66-Tuner is intended to help tuners and engineers:

- Parse and normalize P66 PCM log files.
- Inspect critical fueling, spark, airflow, and knock behavior in one place.
- Generate repeatable, rules-driven tune recommendations.
- Apply safety gates so automated suggestions stay within defined bounds.

## Core Capabilities

### 1) PCM Log Analyzer

- Import log files (CSV/TSV style exports).
- Auto-map common channels (RPM, MAP, MAF, STFT/LTFT, KR, IAT, ECT, commanded/actual AFR, injector pulse width).
- Segment logs by operating region:
  - idle
  - cruise
  - transient
  - power enrichment / WOT
- Calculate quality metrics:
  - fuel trim bias by cell
  - knock retard frequency and severity
  - airflow model error
  - commanded vs actual lambda error

### 2) Master Auto Tuner Engine

- Rule-based correction engine for repeatable baseline tuning.
- Cell-level histogram weighting (time-in-cell + confidence scoring).
- Adaptive correction limits (small steps with saturation caps).
- Safety-first constraints:
  - max AFR correction delta
  - max spark advance delta
  - no changes in low-confidence cells
  - automatic rollback recommendations when knock trends worsen

### 3) Output & Reporting

- Session summary with confidence score.
- Recommended calibration deltas by table and cell.
- Before/after comparison report for each tuning pass.
- Export-ready outputs for manual review before flashing.

## Proposed Workflow

1. Import one or more logs from the target vehicle.
2. Validate channel mapping and log quality.
3. Run analyzer to produce baseline error maps.
4. Run auto-tuner in conservative mode.
5. Review suggested deltas, approve manually.
6. Re-log and iterate until targets are met.

## Safety Notes

- This project should be used by experienced calibrators.
- Always verify changes manually before writing to a PCM.
- Never rely on automated corrections without monitoring knock, AFR, and temperatures.

## Roadmap

- [x] Build robust log parser and schema mapper.
- [x] Implement confidence-scored VE/MAF correction model.
- [x] Add spark/knock adaptive tuning assistant.
- [x] Create UI dashboard for trend inspection and pass comparison.
- [x] Narrowband O2 analysis (cell bias, cross-count health, WOT richness check).
- [x] BCC diffing harness (`tools/bcc-diff.js`) for XDF table discovery.
- [ ] Add configurable rule packs for P66 strategies.
- [ ] Add import/export adapters for common tuning tool formats.

## BCC Diffing Harness

`tools/bcc-diff.js` compares binary images for the same service number to find
calibration data. The six known BCCs for 16184737
(BHLD, BJPM, BJRM, BKWU, BKWW, BNFM) share identical hardware — every byte that
differs between two BCC images is a calibration candidate, and identical
regions are shared code.

```bash
# Diff BCC images against a reference
node tools/bcc-diff.js --ref bnfm.bin --cmp bjpm.bin bhld.bin --json diff.json

# Entropy reconnaissance on a single image
node tools/bcc-diff.js --single bnfm.bin
```

Regions are classified heuristically (`table-candidate`, `scalar/flag`,
`code?`) by size and entropy. Feed the region map into XDF development:
table-candidate addresses are where VE, spark, and PE tables live.

## Narrowband O2 Analysis

For cars without a wideband (the common case on this platform), the analyzer
uses the factory narrowband O2 sensors (mV):

- per-cell rich/lean bias (RPM × MAP) to corroborate fuel-trim suggestions
- cross-count rate per bank for sensor health (lazy/dead detection)
- WOT richness safety check — flags lean-at-WOT immediately

Fuel-trim suggestions automatically gain confidence when the narrowband O2
agrees with the trim direction, and are flagged for caution when they disagree.

## Supplying XDF/ADS Files (When Chat Upload Is Blocked)

If the chat interface does not allow attachments, use one of these paths:

1. **Commit directly to the repo**
   - place files in:
     - `defs/xdf/` for `.xdf`
     - `defs/ads/` for `.ads`
     - optional logs in `samples/logs/`
   - commit and push, then share commit hash/branch.

2. **Share a GitHub/GitLab repo or gist link**
   - include the raw files or a zip archive.

3. **Paste minimal text excerpts** (when files are large)
   - XDF header + one 2D table + one 3D table definition.
   - ADS channel block for RPM, MAP, MAF, KR, STFT, LTFT, AFR/Lambda.

### Suggested Layout

```text
defs/
  xdf/
    p66-16184737-bnfm.xdf
  ads/
    p66-main.ads
samples/
  logs/
    baseline-drive.csv
notes/
  strategy.txt
```

`notes/strategy.txt` should include service number, OS/broadcast code, logger tool, and any known unit quirks.
