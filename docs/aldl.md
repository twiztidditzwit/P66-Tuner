# P66 ALDL Protocol

Source: Robert Saar's P66 V6.adx (8192 baud, 292 objects), parsed by tools/adx-parse.js
into defs/adx/p66-v6.catalog.json. Service numbers: 16172693, 16184164, 16184737, 16196397.

## Connect sequence

Per the ADX header notes: **send Mode 8 before connecting**. Mode 9 re-enables
normal communications; Mode 10 clears codes.

## Request frames

| Command | Frame (hex) | Purpose |
|---|---|---|
| Mode 1 Message 0(Main Data) | E4 57 01 00 C4 | |
| Mode 1 Message 2(Codes) | E4 57 01 02 C2 | |
| Mode 8(Disable Communications) | E4 56 08 BE | |
| Mode 10(Clear Codes) | E4 56 0A BC | |
| Mode 1 Message 4(VIN) | E4 57 01 04 C0 | |
| Mode 9(Enable Communications) | E4 56 09 | |

Last byte of each frame is the checksum. The ADX also carries quick-send
frames (commanded AFR overrides, etc.) — see the catalog JSON for the full list
(25 commands total).

## Main datastream (Mode 1 Message 0)

Byte offsets into the response packet. Equations convert the raw byte(s) X to
physical units; the analyzer maps these titles to canonical signals.

| Offset | Title | Units | Bits | Equation | Analyzer signal |
|---|---|---|---|---|---|
| 0x02 | Coolant | F | 8 | `X * 1.350000 + -40.000000` | ECT |
| 0x04 | MAT | F | 8 | `X` | IAT |
| 0x05 | MAP | kPa | 8 | `X * 0.369000 + 10.354000` | MAP |
| 0x06 | Barometric | kPa | 8 | `X * 0.369000 + 10.354000` | BARO |
| 0x07 | TPS | Volts | 8 | `X * 0.019608 + 0.000000` | TPS |
| 0x08 | TPS | % | 8 | `X * 0.392157 + 0.000000` | TPS |
| 0x0A | Vehicle Speed | MPH | 8 | `X` | VSS |
| 0x0B | Desired Idle Speed | RPM | 8 | `X * 12.500000 + 0.000000` | — |
| 0x0C | Engine Speed | RPM | 16 | `1310720/X` | RPM |
| 0x10 | Knock Retard | * | 8 | `X * 0.175781 + 0.000000` | KR |
| 0x12 | BLM Cell | — | 8 | `X` | BLM_CELL |
| 0x13 | Target Air/Fuel Ratio | — | 8 | `X * 0.100000 + 0.000000` | CMD_LAMBDA |
| 0x14 | Base Pulse Width | mSec | 16 | `X * 0.015259 + 0.000000` | INJ_PW |
| 0x16 | Right/Rear BLM | — | 8 | `X` | LTFT_B2 |
| 0x17 | Right/Rear INT | — | 8 | `X` | STFT_B2 |
| 0x18 | Right/Rear O2 Sensor | mV | 8 | `X * 4.420000 + 0.000000` | O2_B2 |
| 0x19 | Left/Front BLM | — | 8 | `X` | LTFT_B1 |
| 0x1A | Left/Front INT | — | 8 | `X` | STFT_B1 |
| 0x1B | Left/Front O2 Sensor | mV | 8 | `X*4.42` | O2_B1 |
| 0x1C | IAC Position | Steps | 8 | `X` | — |
| 0x20 | Spark Advance | * | 16 | `X*(90/255)` | SPARK_ADV |

Full channel list (62 raw + 17 TunerPro-computed):
see defs/adx/p66-v6.catalog.json.

## Notes

- BLM/INT are raw counts (eq `X`); the analyzer normalizes via count128: trim% = (v-128)/128*100.
- O2 sensors report millivolts (X * 4.42); narrowband switching ~450 mV.
- Knock Retard: X * 0.175781 degrees.
- Engine Speed is 16-bit with an inverse equation: RPM = 1310720 / X.
- Spark Advance is 16-bit: X * (90/255) degrees.