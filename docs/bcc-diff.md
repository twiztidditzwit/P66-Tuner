# BCC Diff — 16184737 family (P66 3.4L V6)

Tool: `tools/bcc-diff.js` (re-run byte-level, `--min-region 1` equivalent — the
earlier report used `--min-region 4` and never inspected sub-4-byte runs)

Classification source: `defs/xdf/p66-v6-34l.catalog.json` (Saar's P66 V6 XDF,
283/285 tables, 560/571 constants, 202/227 flags with addresses).

## Bins compared (6-way)

| File | Cal (BCD @0x0000) | Description |
|---|---|---|
| `defs/bins/stock-1995-camaro-l32.bin` | `00 f7 62 f7` (non-BCD) | Dale's read, 1995 Camaro L32 (reference) |
| `defs/bins/bcc/cal-16212614-95-f-auto-fed.bin` | 16212614 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16212604-95-f-auto-fed.bin` | 16212604 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16212294-95-f-auto-fed.bin` | 16212294 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16203281-94-f-auto-fed.bin` | 16203281 | 94 F-body auto federal |
| `defs/bins/bcc/cal-16203271-94-f-auto-cal.bin` | 16203271 | 94 F-body auto california |

Source: `defs/bins/bcc/P66-V6-stock-archive.zip` (Robert Saar's stock archive,
via gearhead-efi P66 thread).

## Corrected headline findings

The earlier version of this report claimed all per-BCC differences were
transmission-only and that Main Spark was identical across calibrations. **Both
claims were wrong** — the sub-4-byte runs were never inspected, and the raw
diff contradicts the summary.

1. **Dale's bin is stock 16212614.** Exactly 8 bytes differ, all inside the two
   calibration-ID fields (0x0000–0x0003, 0x8000–0x8003). Every other byte is
   identical.
2. **The 94 California cal (16203271) differs in ENGINE calibration too, not
   just transmission.** 36 bytes / 14 runs: Main Spark Advance, Coolant Temp
   Spark Modifier, highway-mode spark/fuel constants, Target O2 Voltage,
   EGR tables/constants, plus one IAC constant and one cruise-downshift byte.
   The 94 federal cal (16203281) shares the transmission differences but NOT
   the engine differences.
3. **Main VE and Idle VE really are identical across all six bins** — no diffs
   anywhere in their table spans. Main Spark Advance is identical EXCEPT the
   two 4-byte runs in 16203271 (light-load, 800–1000 RPM, ~3° less spark).
4. **64 runs, 355 bytes (0.54%)** — not 31 runs / 292 bytes. The old report's
   `--min-region 4` filter hid 33 sub-4-byte runs (including three
   16212604-only differences and the 3-way speed-limiter split).
5. **10 runs have no XDF definition** (gaps between defined entries), not 1.
   Most are in the transmission constant area (kickdown shift constants at
   0x844F–0x845F, the FMC/PE line-pressure offset block at 0x8C7F–0x8CC1,
   byte 0x91C5 right before the 91C8 4th-gear offset table) plus the cal-ID
   copy at 0x0000.
6. **New discovery: BCD calibration ID at 0x0000–0x0003** (in addition to
   0x8000–0x8003, which the XDF already defines as "T-Side Module Calibration
   Part Number"). **0x0000 is undefined — proposed XDF addition** (4 bytes,
   packed BCD, "Calibration Part Number (copy)"). Every stock bin stores its
   cal number here as packed BCD (`16 21 26 14`, etc.).
7. Dale's `00 f7 62 f7` at 0x0000 (`00 f7 62 f8` at 0x8000) vs packed BCD in
   the stock files is unexplained but confined to the ID fields — possibly a
   read artifact or PCM revision marker. It does not affect calibration data.
8. The 0x6DAB mystery region does not vary between any BCC → it is not
   per-BCC calibration data (consistent with DTC parameter records).

## What actually differs, per calibration

### Dale's bin vs stock 16212614 — 8 bytes, cal-ID fields only
- 0x0000–0x0003: `00 f7 62 f7` vs BCD `16 21 26 14`
- 0x8000–0x8003: `00 f7 62 f8` vs BCD `16 21 26 14`

### 94 cals (16203281, 16203271) vs the 95s — 302 bytes / 44 runs, transmission
Idle/throttle-follower: 0x80FA–0x8104 (11B, "IAC Throttle Follower Step
Decay Rate/Delay vs MPH?"); 0x828E (1B, no XDF def); 0x843C–0x843D (2B),
0x8454, 0x8457, 0x8460–0x8461 (gaps between the kickdown shift MPH/RPM
constants, no XDF def); 0x86BD (1B, "Lock Delay Due to ???": 0x78→0x30, X/10).

Downshift schedules: 0x8584–0x8589 (6B, 2nd Gear Start Downshifts),
0x85D4–0x85D7 (4B, Normal Downshifts), 0x8618–0x861B (4B, Cruise Control
Downshifts), 0x8645–0x8649 (5B, "??? Upshifts"), 0x867B–0x867C (2B),
0x8681 (1B, "??? Downshifts"), 0x869F (1B, 0x7f→0x6f — bit 4 cleared; this
byte carries the Coolant Temp / Downshift / Negative D-TPS / Range / Trans
Temp Contingency flags).

Cruise lock/line pressure: 0x87F4–0x87F6 (3B, "87F1 - vs TPS% (4th) (cruise
Lock)"), 0x8813–0x8834 (34B, TPS multiplier for commanded pressure comp to
TCC Unlock PWM, 3rd/4th), 0x8857–0x8867 (17B, "8857 - vs TPS%", 0x0f→0x00),
0x8A21–0x8A23 (3B, Trans Temp Compensation to 3-2 DC), 0x8C91 (1B),
0x8C93–0x8C95 (3B), 0x8CA4 (1B — gaps between "FMC Hysteresis vs Trans Temp"
and "PE Activated Line Pressure Offset vs Trans Input RPM", no XDF def),
0x8D2A–0x8D3A (17B, Forward Line Pressure Compensation vs Temp vs RPM),
0x8DB5–0x8DC5 (17B, Reverse Line Pressure Compensation vs Temp vs RPM),
0x8E98–0x8EEB split into eight runs (4×5B + 4×4B, Line Pressure Correction
vs TPS% vs Trans Temp (2nd) and (3rd)), 0x8EF6–0x8F19 split into four 3B
runs (same table, (4th)), 0x916B–0x917A (16B), 0x9182–0x9188, 0x9190–0x9196
(7B each, "916A (shifting pressure offsets?)"), 0x91C5 (1B, no XDF def),
0x91C8–0x91D8 (17B, "91C8, 4th gear line pressure offset").

Desired shift times: 0x935D–0x936D, 0x937F–0x938F, 0x93A1–0x93B1,
0x93C3–0x93D3 (17B each: Normal / Low Baro / 2GS-Performance / 2GS Low Baro
Desired Shift Times vs TPS vs Gear).

### 16203271 (California) only — 36 bytes / 14 runs, ENGINE calibration
This is the important correction: the CA cal differs from every other bin,
including the 94 federal cal, in engine spark, O2 target, and EGR:

- **Main Spark Advance** (0x39, 17×17, X×90/255): 0x006D–0x0070 and
  0x007E–0x0081 (cells at 800/1000 RPM × 25–40 kPa): 0x50 0x50 0x50 0x50
  → 0x47 0x4a 0x4a 0x4d and 0x50 0x5b 0x61 0x66 → 0x4d 0x50 0x55 0x5b
  — roughly 3° less spark in light-load cruise.
- **Coolant Temp Based Spark Advance Modifier** (0x160, X×90/255−35.29):
  0x0190–0x0192, 0x0198–0x019A, 0x01A0–0x01A2 (three 3B runs): 0x64
  (0.0°) → 0x55–0x61 (−5.3°…−1.1°) — the CA cal pulls spark via the
  coolant modifier where federal adds none.
- **Highway-mode spark/fuel constants**: 0x01E5–0x01E6 — "Max MAP for
  Highway Fuel/Spark" 0xe0→0x86 (X×.3125+20: 90 → 62 kPa) and "Minimum
  Coolant Temp for Highway Spark/Fuel" 0x8c→0xa8 (X×1.35−40: 149 → 187°F).
- **Highway Spark Mode Spark Adder** (0x1eb, X×90/255): 0x01EF (1B):
  0x0b→0x06 (3.9° → 2.1°).
- **Target O2 Voltage vs airflow** (0x75d, X×4.42): 0x075E–0x0761 (4B):
  60 64 66 6a → 64 70 75 75 (424–468 mV → 442–531 mV; CA targets a richer
  O2-sensor voltage at higher airflow).
- **EGR**: "1st Gear EGR Multiplier" const 0x0D9E: 0x80→0xcc (X/256:
  0.50 → 0.80); "EGR Solenoid Combination" table (0xddd):
  0x0DE9–0x0DEA, 0x0DF5: 0x00→0x10 (X/32: 0 → 0.50); "EGR Duty Cycle
  Multiplier vs Coolant Temp" (0xe39, X/128): 0x0E39–0x0E3E (6B):
  0d 26 40 53 6d 80 → 40 40 80 80 80 a0 (federal 0.10→1.00 vs CA
  0.50→1.25 — CA runs substantially more EGR at cold coolant temps).
- Idle: "Additional IAC Steps from A/C at Low RPM" 0x8094: 0x10→0x0e
  (16 → 14 steps). Cruise downshifts byte 0x8621: 0x4b→0x4a.

### 16212604 (one of the 95 cals) only — 7 bytes / 3 runs, downshift tails
0x8505–0x8506 (Trans Hot Downshifts), 0x856A–0x856C (2nd Gear Start
Downshifts), 0x85D1–0x85D2 (Normal Downshifts): 0x40→0x38 in each — a
small downshift-MPH reduction unique to this cal among the 95s.

### Speed limiter — 3-way split (2 bytes)
0x0B2A–0x0B2B ("Vehicle Speed Limiter Cut" / "Restore", units MPH):
dale+16212614 = 76/74 (118/116 MPH); 16212294+16203281+16203271 = 6c/6a
(108/106 MPH); 16212604 = 7e/7c (126/124 MPH).

## Full region list (64 runs)

Pattern keys: D=Dale's, 14=16212614, 04=16212604, 94=16212294,
81=16203281, 71=16203271.

| Address | Size | XDF definition | Differs in |
|---|---|---|---|
| 0x0000–0x0003 | 4 | **UNDEFINED** (BCD cal ID — proposed XDF add) | all 5 stocks (D non-BCD) |
| 0x006D–0x0070 | 4 | Main Spark Advance | 71 |
| 0x007E–0x0081 | 4 | Main Spark Advance | 71 |
| 0x0190–0x0192 | 3 | Coolant Temp Based Spark Advance Modifier | 71 |
| 0x0198–0x019A | 3 | Coolant Temp Based Spark Advance Modifier | 71 |
| 0x01A0–0x01A2 | 3 | Coolant Temp Based Spark Advance Modifier | 71 |
| 0x01E5–0x01E6 | 2 | Max MAP for Highway Fuel/Spark; Min Coolant Temp for Highway Spark/Fuel | 71 |
| 0x01EF–0x01EF | 1 | Highway Spark Mode Spark Adder | 71 |
| 0x075E–0x0761 | 4 | Target O2 Voltage vs airflow | 71 |
| 0x0B2A–0x0B2B | 2 | Vehicle Speed Limiter Cut/Restore | 94+81+71, 04 (two steps) |
| 0x0D9E–0x0D9E | 1 | 1st Gear EGR Multiplier | 71 |
| 0x0DE9–0x0DEA | 2 | EGR Solenoid Combination | 71 |
| 0x0DF5–0x0DF5 | 1 | EGR Solenoid Combination | 71 |
| 0x0E39–0x0E3E | 6 | EGR Duty Cycle Multiplier vs Coolant Temp | 71 |
| 0x8000–0x8003 | 4 | T-Side Module Calibration Part Number | all 5 stocks (D non-BCD) |
| 0x8094–0x8094 | 1 | Additional IAC Steps from A/C at Low RPM | 71 |
| 0x80FA–0x8104 | 11 | IAC Throttle Follower Step Decay Rate/Delay vs MPH? | 81+71 |
| 0x828E–0x828E | 1 | **UNDEFINED** | 81+71 |
| 0x843C–0x843D | 2 | **UNDEFINED** (between kickdown shift consts) | 81+71 |
| 0x8454–0x8454 | 1 | **UNDEFINED** (between kickdown shift consts) | 81+71 |
| 0x8457–0x8457 | 1 | **UNDEFINED** (between kickdown shift consts) | 81+71 |
| 0x8460–0x8461 | 2 | **UNDEFINED** (between kickdown shift consts) | 81+71 |
| 0x8505–0x8506 | 2 | Trans Hot Downshifts | 04 only |
| 0x856A–0x856C | 3 | 2nd Gear Start Downshifts | 04 only |
| 0x8584–0x8589 | 6 | 2nd Gear Start Downshifts | 81+71 |
| 0x85D1–0x85D2 | 2 | Normal Downshifts | 04 only |
| 0x85D4–0x85D7 | 4 | Normal Downshifts | 81+71 |
| 0x8618–0x861B | 4 | Cruise Control Downshifts | 81+71 |
| 0x8621–0x8621 | 1 | Cruise Control Downshifts | 71 |
| 0x8645–0x8649 | 5 | ??? Upshifts | 81+71 |
| 0x867B–0x867C | 2 | ??? Downshifts | 81+71 |
| 0x8681–0x8681 | 1 | ??? Downshifts | 81+71 |
| 0x869F–0x869F | 1 | contingency flags byte (bit 4 cleared) | 81+71 |
| 0x86BD–0x86BD | 1 | Lock Delay Due to ??? | 81+71 |
| 0x87F4–0x87F6 | 3 | 87F1 - vs TPS% (4th) (cruise Lock) | 81+71 |
| 0x8813–0x8834 | 34 | TPS multiplier for commanded pressure (3rd/4th) | 81+71 |
| 0x8857–0x8867 | 17 | 8857 - vs TPS% | 81+71 |
| 0x8A21–0x8A23 | 3 | Trans Temp Compensation to 3-2 DC | 81+71 |
| 0x8C91–0x8C91 | 1 | **UNDEFINED** (FMC/PE gap) | 81+71 |
| 0x8C93–0x8C95 | 3 | **UNDEFINED** (FMC/PE gap) | 81+71 |
| 0x8CA4–0x8CA4 | 1 | **UNDEFINED** (FMC/PE gap) | 81+71 |
| 0x8D2A–0x8D3A | 17 | Forward Line Pressure Compensation vs Temp vs RPM | 81+71 |
| 0x8DB5–0x8DC5 | 17 | Reverse Line Pressure Compensation vs Temp vs RPM | 81+71 |
| 0x8E98–0x8E9C | 5 | Line Pressure Correction vs TPS% vs Trans Temp (2nd) | 81+71 |
| 0x8EA3–0x8EA7 | 5 | Line Pressure Correction vs TPS% vs Trans Temp (2nd) | 81+71 |
| 0x8EAE–0x8EB2 | 5 | Line Pressure Correction vs TPS% vs Trans Temp (2nd) | 81+71 |
| 0x8EB9–0x8EBD | 5 | Line Pressure Correction vs TPS% vs Trans Temp (2nd) | 81+71 |
| 0x8EC7–0x8ECA | 4 | Line Pressure Correction vs TPS% vs Trans Temp (3rd) | 81+71 |
| 0x8ED2–0x8ED5 | 4 | Line Pressure Correction vs TPS% vs Trans Temp (3rd) | 81+71 |
| 0x8EDD–0x8EE0 | 4 | Line Pressure Correction vs TPS% vs Trans Temp (3rd) | 81+71 |
| 0x8EE8–0x8EEB | 4 | Line Pressure Correction vs TPS% vs Trans Temp (3rd) | 81+71 |
| 0x8EF6–0x8EF8 | 3 | Line Pressure Correction vs TPS% vs Trans Temp (4th) | 81+71 |
| 0x8F01–0x8F03 | 3 | Line Pressure Correction vs TPS% vs Trans Temp (4th) | 81+71 |
| 0x8F0C–0x8F0E | 3 | Line Pressure Correction vs TPS% vs Trans Temp (4th) | 81+71 |
| 0x8F17–0x8F19 | 3 | Line Pressure Correction vs TPS% vs Trans Temp (4th) | 81+71 |
| 0x916B–0x917A | 16 | 916A (shifting pressure offsets?) | 81+71 |
| 0x9182–0x9188 | 7 | 916A (shifting pressure offsets?) | 81+71 |
| 0x9190–0x9196 | 7 | 916A (shifting pressure offsets?) | 81+71 |
| 0x91C5–0x91C5 | 1 | **UNDEFINED** (before 91C8 table) | 81+71 |
| 0x91C8–0x91D8 | 17 | 91C8, 4th gear line pressure offset | 81+71 |
| 0x935D–0x936D | 17 | 935D Normal Desired Shift Times vs TPS vs Gear | 81+71 |
| 0x937F–0x938F | 17 | 937F Low Baro Normal Desired Shift Times vs TPS vs Gear | 81+71 |
| 0x93A1–0x93B1 | 17 | 93A1 2GS/Performance Shift Desired Shift Times vs TPS vs Gear | 81+71 |
| 0x93C3–0x93D3 | 17 | 93C3 2GS/Performance Shift Low Baro Desired Shift Times vs TPS vs Gear | 81+71 |

## Caveats (unchanged)

- **BCC-code-to-file mapping was never established.** No BCC ASCII strings
  exist in any bin, so the six bins are identified by their calibration
  number only; we do not know which file is BHLD/BJPM/BJRM/BKWU/BKWW/BNFM.
- **Checksum: none found.** No checksum scheme validates against the bins
  (checked with `tools/checksum.js` on 2026-10-04). That is absence of a
  found checksum, not proof none exists — bench-verify before flashing.
- XDF region names are Saar's labels (some, like "??? Upshifts", are his own
  uncertainty markers), not independently validated semantics. The 10
  undefined runs are gaps in that XDF, not necessarily unimportant data —
  several sit between defined transmission constants and are worth
  defining in a future XDF pass.
