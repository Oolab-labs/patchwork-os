# src/workers/ — Worker Autonomy Gate

Trust-ramp-aware permission gating for recipe-bound worker identities. Each
worker (a named recipe identity, e.g. `release-notes`) accrues a Bayesian
trust posterior per `(worker × action-class)` pair from real run outcomes, and
the gate decides whether an action flows automatically or waits for human
approval based on earned trust, a policy ceiling, and live situational risk.
Two parallel code paths exist: a live gate (`workerGate.ts`, acts on real
runs when the feature flag is on) and a shadow gate (`shadowGate.ts` +
`runWorkerShadow.ts`, replays logs to recommend/report without ever affecting
behavior) used for dogfooding and cold-start calibration.

## The 5 files that matter and why

- **`actionClass.ts`** — defines the unit trust is scoped to: `domain:reversibility:blastTier`. Read this first — it fixes the tool→domain map and explains why competence never transfers across classes.
- **`trustLevel.ts`** — the Bayesian Beta posterior + lower-confidence-bound → L0–L4 rung math. This is the core statistical model everything else consumes.
- **`workerGate.ts`** — the LIVE decision function (`min(earned, ceiling, contextCeiling)`); read the file-header comment for the full reversibility-scoped rationale and the never-widen guarantee.
- **`worker.ts`** — the `WorkerManifest` schema (identity, `owns`, `autonomyCeiling`, competence prior) — what a worker *is* on disk.
- **`shadowObserver.ts`** — folds real run/gate logs into per-worker trust state outside the live path; this is what `patchwork workers shadow`/`backtest` and the dogfood monitoring are built on.

Everything else (`contextRisk*.ts`, `graduation.ts`, `outcomeStore.ts`,
`outcomesCli.ts`, `workerLevelStore.ts`, `workerLoader.ts`, `shadowGate.ts`,
`shadowReport.ts`, `shadowRun.ts`, `backtest.ts`) is support: dwell/demotion
policy, disposition persistence, manifest loading, and CLI/report plumbing
around the same core model.

## Invariants you must not break

Full policy detail: [`docs/worker-autonomy-policy-gate.md`](../../docs/worker-autonomy-policy-gate.md),
[`docs/runbooks/worker-autonomy-dogfood.md`](../../docs/runbooks/worker-autonomy-dogfood.md),
and CLAUDE.md's "Workers / Autonomy Gate" section. Do not restate that policy
here — only code-level rules that aren't obvious from those docs:

- Trust is keyed per `(workerName × actionClassKey)`, never global — do not add any aggregate/cross-class trust shortcut.
- `effectiveLevel = min(earned, autonomyCeiling, contextCeiling)` — `contextCeiling` (from `contextRisk.ts`) is descending-only; a new signal may only lower autonomy, never raise it. NaN/out-of-range context risk must resolve to "no de-rate," not a crash or an accidental widen.
- Demotion is instant and can skip rungs (one high-weight failure craters the posterior mid-dwell); promotion is gated by dwell-time + post-demote cooldown and only climbs to the next reachable rung — never bypass this asymmetry when touching `graduation.ts`.
- `shadowGate`/`shadowObserver` must never mutate anything the live gate reads — the shadow path is read-only replay, kept structurally separate so dogfooding can't accidentally change production behavior.
- An `unknown` outcome disposition (`outcomeStore.ts`) is withheld, not folded in as neutral/good evidence — only `confirmed` (human positive act) may raise a worker's `issue` dial; a durable but unactioned filing must never earn trust by sitting unopened.
- `PATCHWORK_FLAG_WORKER_AUTONOMY` off ⇒ the live gate must be a no-op, byte-identical to pre-ramp behavior.

## How to test it

`npm test -- src/workers` runs the full suite; tests live in
`src/workers/__tests__/`, one file per module (e.g. `workerGate.test.ts`,
`trustLevel.test.ts`, `graduation.test.ts`). Any change to threshold
constants, the reversibility→level mapping, or the composition rule should
also bump `GATE_POLICY_VERSION` in `workerGate.ts` (decisions must be
replayable against the policy that produced them).
