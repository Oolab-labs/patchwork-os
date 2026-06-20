# QUMO-style Honest Desk — PRE-COMMIT THRESHOLDS (FROZEN)

**Status:** FROZEN · **Date:** 2026-06-18 · **Phase:** 0 (pre-registration & guardrails)

> Everything here is FROZEN before any history accrues, so no threshold is tuned-to-look-good later. Each cell is keyed `cellName + methodVersion + runTs`; `methodVersion` is bumped (never silently edited) if any frozen value changes, logged as a NEW pre-registration — never a retro-tune of an existing arm.
>
> Source: `DESIGN.md` §6 (moat + authorized addition + deterministic≠validated), §9 (phased plan); honesty matrix §4; surfaces §5.
>
> Separate ledger path (frozen): `~/.patchwork/qumo-ledger.jsonl` — **never** the shared `ta-ledger.jsonl`.

---

## 1. Desk-posture selection rule (deterministic, engine-decided)

`{Holding | Holding-defensive | Standing aside | Watching X | Alarm fired}` — closed, no-license vocabulary. **"Attack" is BANNED** (reads as an entry license). Verb computed ONLY by this rule — never LLM, never vibe.

Inputs:
- **tri-count** — `{nRisk, nWatch, nConfirm}` verbatim tallies from our own live ledger files.
- **feed-health** — per load-bearing feed `{fresh | stale | offline}`. "Load-bearing" = any feed a live posture depends on (tri-count ledger feeds + breadth price feed). Atlas/archived/pending feeds are NOT load-bearing.
- **alarm-closes** — count of pre-registered alarm/invalidation levels with a 4h **bar CLOSE** through them. Intrabar wick does NOT fire.

### Evaluation order (first match wins — strictly ordered, deterministic)

| # | Condition (top-down) | Posture |
|---|---|---|
| 1 | `alarm-closes ≥ 1` | **Alarm fired** |
| 2 | **CONSERVATIVE DEFAULT** — any load-bearing feed `stale`/`offline` **OR** `nConfirm == 0` | **Standing aside** |
| 3 | `nRisk ≥ 1` **AND** `nConfirm ≥ 1` | **Holding-defensive** |
| 4 | `nConfirm ≥ 1` **AND** `nRisk == 0` | **Holding** |
| 5 | `nWatch ≥ 1` (no confirm, no risk) | **Watching X** (X = named watch item(s)) |
| 6 | otherwise (all zero, feeds healthy) | **Standing aside** |

**Frozen invariants:**
- Rule 1 outranks everything — a closed alarm reports even when feeds degraded.
- Rule 2 is the user-authorized conservative default: *any* degraded load-bearing feed **OR** zero confirms ⇒ **Standing aside**. Degradation never silently upgrades to a hold.
- `Holding`/`Holding-defensive` reachable ONLY with `nConfirm ≥ 1` AND all load-bearing feeds fresh.
- `Watching X` requires a named target; no target ⇒ falls through to rule 6 (Standing aside).
- Posture must be ∈ `allowedPostures`; judge rejects any posture outside the set (§6.3 L3).
- Deterministic rule, NOT a validated forward signal (§6.4) — a context label, not a call.

---

## 2. Rekt Shield — liq-distance posture bands (frozen)

Badge over `liqDistancePct` (= `1/lev − maintenance`, det arithmetic on the user-supplied hypothetical trade). Reframed from CLEAN/CONTESTED/**DANGEROUS** → WIDE/NEAR/CONTESTED ("DANGEROUS" reads as a forward call; dropped). Rendered **inline** as a det-rule label.

| Band | Threshold on `liqDistancePct` |
|---|---|
| **WIDE** | `≥ 15%` |
| **NEAR** | `5% ≤ d < 15%` |
| **CONTESTED** | `< 5%` |

**Frozen invariants:**
- Inclusive-lower as written: `≥15` WIDE; `[5,15)` NEAR; `<5` CONTESTED.
- Deterministic label on realized arithmetic — NOT a liquidation probability. No 0-100 DANGER score; no stop-hunt/liq-cluster sub-score (paid feed — dropped).
- Wrapped in the mandatory no-license line. Idle if no trade supplied (renders "idle", not blank).
- Logs a claim row to `qumo-ledger.jsonl`, graded at window close.

---

## 3. BTC-DNA lean thresholds (frozen)

**Only two inputs may emit a directional lean.** All else = RAW ARCHIVED FACT, NO lean (`status: archived-unvalidated`). Per §6.4 deterministic computation is NOT validation, so un-earned positioning data is archived raw.

### 3a. Price-trend strand — LEAN ALLOWED (price-only, validated). Raw input ALWAYS printed alongside label.

| Label | Rule (24h% vs MA-slope) |
|---|---|
| **CONSISTENT** | `sign(24h%) == sign(MA-slope)` **AND** `|24h%| ≥ 1.0%` |
| **INCONSISTENT** | `sign(24h%) ≠ sign(MA-slope)` |
| **FLAT / no-lean** | `|24h%| < 1.0%` (below pinned magnitude floor) |

- MA-slope: sign only, over the trailing window pinned in `surfaces.ts` (`methodVersion`-keyed). No magnitude composite.

### 3b. Funding-stress strand — LEAN ALLOWED ONLY IF funding claim type matured; else RAW

| Label | Rule |
|---|---|
| **funding-stress lean** | ONLY if funding claim type matured (≥40 decided, positive edge vs paired dartboard) → route by pinned funding threshold, input printed |
| **raw (default)** | NOT matured → raw funding value, `status: archived-unvalidated`, NO lean |

- v1 reality: funding is **PENDING** until backtest matures → renders RAW.

### 3c. RAW-ARCHIVED, NO LEAN (frozen — never leaned in v1)

- **spot-confirm taker-buy%** — `archived-unvalidated`, raw only (benched by existing brief; promotion needs the extended kline parser — field 9 `takerBuy` currently discarded).
- **leverage-fragility** (crowd long% + OI) — `archived-unvalidated`, raw only.

### 3d. PENDING (feed offline — render verbatim, NO lean)

- whale / liquidity-trap / ETF / max-pain — `status: pending`.
- Coverage footer "N of 7 strands live" kept. "k of n families agree" dropped. 0-100 strand scores + CONF dropped. ICHI **banned**.

---

## 4. Ichimoku — no-edge LOCATION CONTEXT only (frozen)

Ichimoku is **NOT a signal/lean**; the **ICHI ledger cell is BANNED** (Ichimoku family falsified+closed 2026-06-11; banned even as reference — judge rejects `ichimoku`/`ICHI`). May appear ONLY as no-edge geometric location context (anchor for an alarm/invalidation level), never a force, magnet, support, draw, or call.

**Frozen settings (standard / class-specified — pinned, not tuned):**

| Component | Period |
|---|---|
| Tenkan-sen (conversion) | **9** |
| Kijun-sen (base) | **26** |
| Senkou Span B (leading B) | **52** |
| Chikou / displacement | **26** |

- Reported as: price location vs cloud (above / inside / below) + cloud level coordinates — **location only**. No "return to cloud", no bullish/bearish-cloud framing, no crossover signal.
- Periods FROZEN; any change → new `methodVersion`, logged, never a retro-tune.

---

## 5. Validated-vs-archived claim list + PENDING cells (frozen)

Provenance keys: `det | live-feed-fresh-asOf | matured-ledger-row`.

### VALIDATED / HONEST in v1

| Claim / cell | Source | Why honest |
|---|---|---|
| Desk posture verb (closed vocab) | engine deterministic rule §1 | engine-decided; det label (NOT a forward %) |
| Tri-count `{nRisk,nWatch,nConfirm}` | own live ledger files | verbatim tallies |
| Breadth `{nGreen,nRed,universeN}` | free price | realized count |
| Rekt Shield liqPrice/liqDistancePct/R:R/leg%/cap-at-risk% + WIDE/NEAR/CONTESTED | det arithmetic on user trade | risk bookkeeping; R not-a-target; det label |
| BTC-DNA price-trend CONSISTENT/INCONSISTENT §3a | free price + pinned threshold | price-only validated input |
| Atlas 7d realized sector returns + leaders | NEW CoinGecko-categories feed | realized return, location only (offline if unbuilt) |
| Perf-Ledger `ScoreSummary` holdRate/baselineRate/edge + matured/scorable N | REAL `scoreLedger` | audited frequency w/ N + baseline shown |
| Kill-gate N/40 + permutation p (altsetup arms) | REAL `altsetup-killgate.ts` | earned via paired dartboard + sign-flip |
| Falsified/banned audit (price-fifty, ichimoku by name) | ledger state | visible-not-hidden; survivorship guard |
| LIVE SIGNAL AUDIT (forward out-of-sample rows, graded at window close) | forward log | strongest falsification surface |
| NAV / workflow scaffolding + engine/feed-health line | static + feedHealth | "Assess/Protect Risk" reframed |
| Every printed number ↔ numbersIndex | code provenance assert + judge grep | enforced traceability |

### ARCHIVED-UNVALIDATED in v1 (RAW fact, NO lean, NO % — `status: archived-unvalidated`)

| Claim | Reason |
|---|---|
| BTC-DNA spot-confirm taker-buy% | deterministic ≠ validated; benched by existing brief |
| BTC-DNA leverage-fragility (crowd long% + OI) | deterministic ≠ validated; un-earned positioning |

### PENDING until history accrues / backtest matures (render "pending"/"feed offline" — NO number, NO lean)

> "History starts `<engine launch date>`" — derivative-conditioned cells accrete history in `~/.patchwork/qumo-cache/*.jsonl` from launch. PENDING/Watch with N (never graded) until matured past the gate.

| Cell | Pending reason |
|---|---|
| BTC-DNA funding-stress lean §3b | leans only after funding claim type matures (≥40 decided, positive edge vs paired dartboard); RAW until then |
| BTC-DNA whale / liquidity-trap / ETF / max-pain | paid/scrape/options feed offline — render verbatim |
| WP / Kodama / REKO / PRS / PHNX expectancy cells | unbuilt signal defs — freeze mechanically, pre-register, mature vs paired dartboard first |
| PRSM pattern alerts (hitPct/fires/window) | walk-forward does not exist — vaporware; build + pre-register + mature first |
| Scenario distribution (41/36/23%) + stop-sweep% (56%) | per-arm conditional-frequency claims not matured; only UNRANKED IF/THEN branches meanwhile |
| Atlas categories feed (if unbuilt/rate-limited) | ships OFFLINE `available:false` — most fragile v1 surface |
| Derivative-conditioned ledger cells | building history since `<launch date>`; price-only cells backtest on existing 1d cache |

### BANNED outright (never shown, not even as reference)

- ICHI cell (Ichimoku family falsified+closed 2026-06-11).
- price-fifty / price-thirds as *signals* (shown only by name in the falsified audit view).
- 0-100 pressure / DANGER / strand / CONF scores; "k of n families agree"; totalR/avgR/edge-grade A/B/C/weightedWinPct; "where capital wants attention NEXT"; stop-placement sweep% + ranked tables; V4 STACK + DECISION STATE.
- Any banned token in the serialized payload fails the BUILD (§6.3 L1): `probabilityPct`, `confScore`, `dangerScore`, `strandScore`, `sweepPct`, `grade`, `avgR`, `totalR`, `weightedWinPct`, `freqPct`-without-fires.

---

## 6. Phase-2 cell battery pre-registration (frozen 2026-06-19)

Pre-registered before any history accrues. `methodVersion` bumped if any param changes; prior accrual resets.

### 6.1 wp-volume-climax @1d (METHOD_VERSION = "wpvc-1d-v1") — REGISTERED 2026-06-19

Already live in `src/ta/desk/cells/wpVolumeClimax.ts`. Status: WATCH (N=115, p=0.088).

| Param | Value |
|---|---|
| VOL_SMA_BARS | 20 |
| VOL_MULTIPLIER | 2.5 |
| REJECTION_THRESHOLD | 0.60 |
| OUTCOME_WINDOW_BARS | 10 |
| R_MULTIPLIER | 1.0 |
| UNIVERSE | ["BTCUSDT","ETHUSDT"] |
| PERMUTATION_SEED | 777 |
| NULL_SEED | 4242 |

### 6.2 wp-ma-rejection @1d (METHOD_VERSION = "wpmr-1d-v1") — REGISTERED 2026-06-19

Hypothesis: a daily bar that wicks below the 20-bar SMA but closes back above it (MA support rejection) returns at a win-rate greater than chance over a 10-bar outcome window.

Fire condition (LONG only — tests support hypothesis):
1. Fire bar's `low < sma20` (wick pierced below MA)
2. Fire bar's `close > sma20` (closed back above MA = rejection)
3. Rejection depth: `(sma20 - low) / close ≥ 0.002` (min 0.2% wick depth below MA, avoids hairline touches)

Entry: `close` of fire bar. Invalidation: `low` of fire bar. rRef: `close + 1.0 × (close - low)` (1R target).

| Param | Value |
|---|---|
| MA_BARS | 20 |
| MIN_WICK_DEPTH | 0.002 |
| OUTCOME_WINDOW_BARS | 10 |
| R_MULTIPLIER | 1.0 |
| UNIVERSE | ["BTCUSDT","ETHUSDT"] |
| PERMUTATION_SEED | 777 |
| NULL_SEED | 4242 |

FAMILY_N bumps from 1 → 2 when this cell joins the battery.

---

## Frozen-items summary

1. **Desk-posture selection rule** — strictly-ordered 6-row table over tri-count + feed-health + alarm-closes; conservative default = any degraded load-bearing feed OR zero confirms → Standing aside; Alarm fired outranks all; Holding/Holding-defensive reachable only with nConfirm≥1 + all load-bearing feeds fresh; "Attack" banned.
2. **Rekt Shield liq-distance bands** — WIDE ≥15%, NEAR [5%,15%), CONTESTED <5% (inclusive-lower); det label not a probability; DANGER score dropped.
3. **BTC-DNA lean thresholds** — only price-trend (sign agreement + |24h%|≥1.0% floor) and matured-funding may lean; spot-confirm + leverage-fragility raw-archived (no lean); whale/trap/ETF/max-pain pending.
4. **Ichimoku** — no-edge location context only; ICHI cell banned; settings frozen 9 / 26 / 52 / 26.
5. **Validated-vs-archived claim list** — validated set, archived-unvalidated set, PENDING set, banned set; PENDING cells named with their maturation gate; separate ledger path `~/.patchwork/qumo-ledger.jsonl`.
