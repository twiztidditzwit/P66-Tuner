# Throttle Response Parameter Review — P66 3.4L V6

Systematic review of every XDF parameter affecting throttle snappiness
(sharpness of engine response to throttle input), stock values from the
1995 Camaro L32 calibration, and what the tuner does about each.

## 1. Accel Enrichment (tip-in fuel) — PRIMARY tip-in factor

When the throttle opens suddenly, manifold pressure jumps before fuel
delivery catches up. AE adds a shot of fuel proportional to throttle
movement rate (D-TPS). Too little AE = lean stumble on tip-in ("dead"
throttle). Too much = rich bog.

| Table | Addr | Size | Stock (physical) | Tuner |
|---|---|---|---|---|
| AE Async Multiplier vs D-TPS | 0xA26 | 17×8-bit | 0.66→1.00 (X/256) | ✅ scales on lean-spike evidence |
| AE Multipler vs D-TPS | 0xA59 | 17×8-bit | 0.375→1.00 (X/256) | ✅ scales on lean-spike evidence |
| AE Multiplier vs Coolant, in D | 0xA6B | 9×8-bit | 1.00→0.00 (X/128) | ❌ not tuned (see note) |
| AE Multiplier vs Coolant, in P/N | 0xA7A | 9×8-bit | 1.00→0.06 (X/128) | ❌ not tuned (see note) |
| AE Multiplier vs MPH | 0xA84 | 9×8-bit | 1.00→0.375 (X/256) | ❌ not tuned (axis unknown) |
| AE Multiplier vs MAP | 0xB13 | 6×8-bit | 1.00→0.17 (X/256) | ❌ not tuned (axis unknown) |
| AE Multiplier vs MAT | 0xA9E | 9×8-bit | 1.00→0.25 (X/128) | ❌ not tuned (axis unknown) |
| Barometric Multiplier for AE | 0xA74 | — | — | ❌ not tuned |
| AE Pulse Width Modifier vs Injections in AE | 0xAA7 | 33×8-bit | 1.00→0.004 decay | ❌ not tuned (shape is fine) |
| Max Injections to Allow AE vs Coolant | 0xA8D | 17×8-bit | 80 across | ❌ not tuned |

**How the tuner handles it:** `analyzeTipIn` finds throttle stabs
(TPS jump ≥10% in one sample, sustained) and watches narrowband O2 for
~1.2 s. O2 dipping below 250 mV = lean spike = AE too small. With ≥5
events and ≥50% lean (warm events preferred, O2 health gated), the tuner
suggests +10–20% AE and the patcher scales both D-TPS tables together,
preserving their curve shape (rows at 255 stay at 255).

**Note on the coolant/MAP/MPH AE tables:** their D-TPS-style axis
breakpoints are implicit in the PCM, not in the XDF (axis labels read
`0.00`), so per-row targeting is impossible. Worse, the coolant tables
read 1.00→0.00 with rising index — if the axis is temperature-ascending,
the stock calibration commands *zero* AE when fully warm in Drive, which
would be a drivability bug; more likely the axis is descending or the
equation is mislabeled in the XDF. Either way, the tuner does not touch
tables it cannot interpret. The D-TPS pair is unambiguous (monotonic
gain curves, X/256) and is the correct lever.

## 2. Power Enrichment entry (WOT response)

PE is the wide-open-throttle fueling mode. Late PE = the engine stays
near stoich while the driver is asking for full power.

| Table | Addr | Stock | Tuner |
|---|---|---|---|
| TPS% Threshold to Enter PE vs RPM | 0x917 | 70% (60% at high RPM) | ✅ lowered on late/missing PE evidence |
| TPS Offset for PE Entry vs Coolant Temp | 0x87D | 0–20% | ❌ not tuned |
| PE Entrance Delay based on D-TPS | 0x93A | 0 (no delay) | ✅ already optimal |
| Barometric Correction to PE Threshold | 0x928 | 0 | ✅ already optimal |
| Power Enrichment Target AFR | 0x86C | — | ✅ tuned by existing PE logic |

**How the tuner handles it:** `analyzePeEntry` finds sustained
high-throttle episodes (TPS ≥60%, ~1 s) and checks commanded lambda for
PE engagement (<0.95) and delay. With ≥3 episodes and <50% engagement
(or >2 s delay), the tuner suggests −10% on the threshold table; the
patcher floors every cell at raw 128 (~50% TPS) so repeated passes can't
drag PE into cruise. Needs commanded lambda/AFR in the log — without it
the check reports unavailable rather than guessing.

## 3. IAC Throttle Follower (air during transitions)

| Table | Addr | Stock |
|---|---|---|
| IAC Throttle Follower Step Decay Rate/Delay vs MPH? | 0x80F6 | 9→2 |
| Max Throttle Follower Steps Mult vs Coolant | 0x814B | 0.45→1.00 |
| Max Throttle Follower Steps vs MPH | 0x8159 | — |
| Max Throttle Follower Steps vs RPM | 0x817C | 50→80 |

**Not tuned.** The throttle follower prevents stalling on throttle
closure, not tip-in sharpness, and mis-tuning it causes idle surge/stall.
No log signal isolates its behavior. Left alone deliberately.

## 4. Torque Management (shift sharpness)

| Table | Addr | Stock |
|---|---|---|
| 1-2 upshift spark removal | 0x5DB | 0 (no retard) |
| 2-3 upshift spark removal | 0x5E5 | 0 (no retard) |
| Baro Correction to 1-2/2-3 Upshift spark removal | 0x5EF | — |
| Stall TM vs RPM and RPM Ratio (1st/2nd/4th) | 0x3A9 | — |
| Stall TM vs RPM and RPM Ratio (3rd) | 0x445 | — |
| Stall TM for RPM vs MAP | 0x4E1 | — |

**Already optimal / not tuned.** Upshift spark removal is already zero —
the factory isn't dulling shifts. Stall TM only matters for
brake-torque launches; not log-detectable, not touched.

## 5. Spark advance

Covered by existing knock logic: repeatable knock → retard at the knock
cell; knock attack/recovery rates (0x378/0x394) left at stock. Advancing
the main table for "snappiness" without knock evidence is how engines
get hurt — the tuner doesn't do it.

## 6. EGR

~20 tables (duty cycle, flow, spark adders, temp compensations).
EGR dulls part-throttle response and deleting it is a common hot-rod mod,
but it's a static calibration choice with emissions consequences, not a
log-driven correction. **Not tuned;** documented here so the choice is
explicit.

## 7. Transmission (shift firmness/scheduling)

Shift tables exist in the XDF but shift *feel* is a separate domain from
engine throttle response, with its own risks (clutch life). **Out of
scope** for the engine tuner.

## 8. DFCO / decel

No DFCO-specific tables surfaced under expected names in this XDF
revision. Tip-in after decel is covered indirectly: the tip-in detector
doesn't exclude post-decel stabs, so a lean hole there still counts
toward the AE evidence.

## Summary of what the tuner now does for throttle snappiness

1. **Tip-in AE** — detects lean spikes on throttle stabs, scales the AE
   vs D-TPS tables (+10–20%/pass, O2-health gated).
2. **PE entry** — detects late/missing power enrichment, lowers the TPS
   entry threshold (−10%/pass, floored at ~50% TPS).
3. Everything else above is either already optimal (PE delay, upshift
   TM), not log-detectable (stall TM, EGR, trans), unsafe to auto-tune
   (IAC follower, main spark advance), or uninterpretable in the XDF
   (AE coolant/MAP/MPH axes).
