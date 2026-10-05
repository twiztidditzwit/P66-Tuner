# BCC Diff — 16184737 family (P66 3.4L V6)

Tool: `tools/bcc-diff.js`
Data: `docs/bcc-diff.json` (full region list)

## Bins compared (6-way)

| File | Cal (BCD @0x0000) | Description |
|---|---|---|
| `defs/bins/stock-1995-camaro-l32.bin` | `00f762f7` (non-BCD) | Dale's read, 1995 Camaro L32 (reference) |
| `defs/bins/bcc/cal-16212614-95-f-auto-fed.bin` | 16212614 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16212294-95-f-auto-fed.bin` | 16212294 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16212604-95-f-auto-fed.bin` | 16212604 | 95 F-body auto federal |
| `defs/bins/bcc/cal-16203281-94-f-auto-fed.bin` | 16203281 | 94 F-body auto federal |
| `defs/bins/bcc/cal-16203271-94-f-auto-cal.bin` | 16203271 | 94 F-body auto california |

Source: `P66 V6.zip` (Robert Saar's stock archive, via gearhead-efi P66 thread).
BCC→file mapping could not be established — no BCC ASCII strings exist in any
bin. Files are identified by calibration number.

## Headline findings

1. **Dale's bin is stock 16212614.** It differs from the stock 16212614 file by
   exactly 8 bytes, all inside the two calibration-ID fields (0x0000, 0x8000).
   Everything else — every table, every constant — is byte-identical.
2. **Engine calibration is identical across all BCCs.** Main VE (0xEAA),
   Main Spark (0x39), Idle VE (0x69B): 0 bytes differ across all six bins.
   The per-BCC differences are transmission calibration only.
3. **31 differing regions, 292 bytes (0.45%).** All but one are already defined
   in Saar's XDF — overwhelmingly transmission tables (shift times, line
   pressure, downshift/upshift schedules). The XDF's coverage of the
   varying regions is essentially complete.
4. **New discovery: BCD calibration ID at 0x0000–0x0003.** The cal number is
   stored packed-BCD at 0x0000 and again at 0x8000. The XDF already defines
   0x8000 ("T-Side Module Calibration Part Number"); **0x0000 is undefined —
   proposed XDF addition** (4 bytes, BCD, "Calibration Part Number (copy)").
5. **The 0x6DAB mystery region does not vary** between any BCC → it is not
   per-BCC calibration data (consistent with DTC parameter records, not tables).
6. Dale's `00 f7 62 f7` at 0x0000/0x8000 (vs BCD in stock files) is unexplained
   but confined to the ID fields — possibly a read artifact or PCM revision
   marker. It does not affect any calibration data.

## Region summary

| Address | Size | XDF definition | Varies in |
|---|---|---|---|
| 0x0000–0x0003 | 4 | **UNDEFINED** (BCD cal ID — proposed add) | all 5 |
| 0x006D–0x0070 | 4 | Main Spark Advance | 16203271 |
| 0x007E–0x0081 | 4 | Main Spark Advance | 16203271 |
| 0x075E–0x0761 | 4 | Target O2 Voltage vs airflow | 16203271 |
| 0x0E39–0x0E3E | 6 | EGR Duty Cycle Multiplier vs Coolant Temp | 16203271 |
| 0x8000–0x8003 | 4 | T-Side Module Calibration Part Number | all 5 |
| 0x80FA–0x8104 | 11 | IAC Throttle Follower Step Decay/Delay vs MPH? | 94 cals |
| 0x8584–0x8589 | 6 | 2nd Gear Start Downshifts | 94 cals |
| 0x85D4–0x85D7 | 4 | Normal Downshifts | 94 cals |
| 0x8618–0x861B | 4 | Cruise Control Downshifts | 94 cals |
| 0x8645–0x8649 | 5 | ??? Upshifts | 94 cals |
| 0x8813–0x8834 | 34 | TPS multiplier for commanded pressure (3rd/4th) | 94 cals |
| 0x8857–0x8867 | 17 | 8857 - vs TPS% | 94 cals |
| 0x8D2A–0x8D3A | 17 | Forward Line Pressure Compensation vs Temp vs RPM | 94 cals |
| 0x8DB5–0x8DC5 | 17 | Reverse Line Pressure Compensation vs Temp vs RPM | 94 cals |
| 0x8E98–0x8EEB | 8×(4–5) | Line Pressure Correction vs TPS% vs Trans Temp | 94 cals |
| 0x916B–0x917A | 16 | 916A (shifting pressure offsets?) | 94 cals |
| 0x9182–0x9196 | 2×7 | 916A (shifting pressure offsets?) | 94 cals |
| 0x91C8–0x91D8 | 17 | 91C8, 4th gear line pressure offset | 94 cals |
| 0x935D–0x93D3 | 4×17 | Desired Shift Times vs TPS vs Gear (4 variants) | 94 cals |

("94 cals" = 16203281 + 16203271 differ from the 95s and Dale's; the three 95
cals differ from Dale's only in the cal-ID fields.)
