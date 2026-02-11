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

- [ ] Build robust log parser and schema mapper.
- [ ] Add configurable rule packs for P66 strategies.
- [ ] Implement confidence-scored VE/MAF correction model.
- [ ] Add spark/knock adaptive tuning assistant.
- [ ] Create UI dashboard for trend inspection and pass comparison.
- [ ] Add import/export adapters for common tuning tool formats.

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
