# ADR-0026: The governed profile and the effective-policy calculation

- **Status:** Accepted
- **Date:** 2026-09-01
- **Related:** ADR-0006 (approval gate), ADR-0013 (kill switch), ADR-0016
  (approval hook fail-closed), ADR-0017 (forbid), ADR-0021 (information
  boundary), ADR-0025 (evidence spine)

## Context

The 2026-09-01 due-diligence audit found that every headline governance
control was independently opt-in and independently fail-open: the approval
gate defaulted to `off`; automated triggers (cron, webhook, file-watch,
git-hook) were never consulted even under `approvalGate: all`; every `agent`
step spawned a CLI with `--dangerously-skip-permissions` and a denylist-filtered
environment that let connector credentials through; a recipe's `servers:` key
loaded arbitrary in-process code; the kill switch failed open when its state
could not be read and did not cover bridge MCP writes or subprocesses;
redaction was key-based so a secret interpolated into a string reached the
ledgers; and the recipe `http.post` tool had a weaker SSRF guard than the
bridge's own HTTP client.

Each control had a good reason to be opt-in: an existing install must not
change behaviour by upgrading. But a NEW install has no behaviour to protect,
and the sum of twelve reasonable opt-ins was a runtime that enforced nothing
while looking governed on the dashboard.

## Decision

### One profile, two modes

`config.json` gains a single key, `profile: "governed" | "compat"`
(`src/governance/profile.ts`). Absent or unrecognised ⇒ `compat`, which is
byte-identical to pre-profile behaviour. `patchwork init` writes `governed`
for a NEW config.json only; `patchwork profile governed|compat` changes an
existing one. There are deliberately no other modes and no per-control
overrides on the profile itself: an operator who wants a different mix uses
the underlying primitives, which all still exist.

The profile RESOLVES TO existing primitives; it introduces no new decision
function:

| Governed field | Feeds | Governed value |
|---|---|---|
| `approvalGate` | `Server.approvalGate`, `makeRecipeApprovalFn` | floor `high` (an explicit `all` is kept) |
| `gateAutomatedRuns` | runner consult predicate | every trigger consulted like a manual run |
| `workerAuthority` | `FLAG_WORKER_AUTONOMY` | on |
| `policyEnforce` | `FLAG_ENFORCE_POLICY` | on |
| `agentContainment` | `src/drivers/*` | contained by default (Read/Glob/Grep/LS; WebFetch, WebSearch, Bash denied; env allowlist; no bridge MCP) |
| `pluginPolicy` | `loadRecipeServers`, install, PUT, lint | allowlist (`config.plugins.allow`) |
| `killSwitchFailClosed` | `readKillSwitch` | unreadable ⇒ engaged |
| `unknownWriteTools` | `tierVerdict` | inferred-tier writes and NON-reversible writes queue |
| `unregisteredTools` | consult | halt, not skip |
| `untrustedEnvelope` | agent prompt render | connector output wrapped in `<untrusted>` |
| `recipeOptOutHonoured` | consult | a recipe cannot opt itself out |

The resolved profile is published once at bridge startup (`setActiveProfile`)
and read everywhere else. `POST /settings` cannot lower `approvalGate` below
the profile's floor; changing the posture takes `patchwork profile` on the
machine and a restart.

### One calculation, used by the runtime and by the explanation

`computeEffectivePolicy` (`src/governance/effectivePolicy.ts`) composes the
existing pure decisions — `readKillSwitch`, tool registration,
`decideWorkerAction` + `resolveGateOutcome`, `classifyTool` +
`classifyActionClass`, the trigger predicate, `decideBoundary` — into an
ordered list of stages with a verdict and a reason each, and a final
`ALLOW | HUMAN_APPROVAL_REQUIRED | REFUSED`.

Both runners call it at the per-step consult point and hand its final verdict
to the approval fn as `effective`; the tier gate defers to that verdict. The
worker gate fn still makes its own `decideWorkerAction` call at approval time
(it has the live trust store) and composes as a floor, exactly as before.

`patchwork policy explain <recipe> [tool]` calls the same function with the
same inputs and prints the stages. `effectivePolicy.test.ts` runs the real
flat runner over a matrix of (profile × trigger × tool × opt-out) with a
recording approval fn and asserts that whether the runner consulted approval,
and the verdict it passed, equal the calculation's. The explanation cannot
drift from enforcement without that test failing.

`patchwork doctor` prints a governance section built from the same resolved
profile, live flags, the parsed destination registry, a plugin scan of
installed recipes and the secret-value registry — never from the raw config —
and ends `STATUS: GOVERNED` or `STATUS: NOT GOVERNED` with reasons.
`--require-governed` folds that into the exit code; without it the existing
`doctor && echo deployed` contract is unchanged.

### Enforcement order

```
EXECUTION REQUEST
  → kill switch            readKillSwitch (fail-closed under governed)
  → tool registration      refuse (governed) / skip (compat)
  → worker authority       forbid → REFUSE; gate → approval unless standing permission
  → tool tier              high, or non-reversible / inferred-tier write (governed) → approval
  → trigger                manual, or any trigger under governed / worker gate
  → privacy                executeAgent refuses anything but ALLOW
  → approval               queue (durable) — tier fn honours `effective`
  → dispatch               executeTool / driver (kill switch re-checked at dispatch)
  → evidence               run log, decision record, receipt, approval log
```

The same order is what `policy explain` prints.

## Consequences

- A fresh `patchwork init` is governed. An upgraded install is not, and
  `patchwork doctor` says so with the exact reasons.
- Under governed, a cron recipe that posts to Slack or sends mail queues for
  approval on every run until a worker manifest earns it autonomy or a standing
  permission is granted. That is the intended posture; a reversible write
  (`file.write`, rollback-able) still flows.
- A governed agent step cannot fetch URLs, run a shell, or see connector
  credentials unless the recipe widens it explicitly (`sandbox: { network:
  true }` etc.), and every widening is printed by `policy explain` and turns the
  step into one that needs approval.
- Gemini and Codex can only be contained coarsely (mode + exclusions, OS
  sandbox + network). The drivers say so in code, and the containment object
  records what could not be expressed.
- Secrets registered from env blocks, connector tokens, the bridge bearer and
  the secure store are redacted by VALUE (including URL-encoded, base64 and
  JSON-escaped forms) at every ledger sink; orchestrator prompts are no longer
  persisted in cleartext.

## Known remaining bypasses (recorded, not hidden)

- The worker gate is not rebuilt on the replay path (tier gate only); under governed a worker-owned recipe is therefore REFUSED for replay (`replay_refused_worker_owned_under_governed`) rather than replayed with fewer gates.
- The untrusted envelope is applied to flat and chained agent prompts, not to
  `fan_out` per-item prompts, nested-recipe child outputs, agent output derived
  from connector data, judge `reviews:` blocks, or orchestrator automation-hook
  prompts.
- API drivers receive the envelope in the user prompt; only the subprocess and
  no-bridge paths receive the governed system-prompt sentence.
- Per-tool `assertWriteAllowed` calls inside individual connector tools, and
  four direct `isWriteKillSwitchActive()` reads in `server.ts` /
  `recipeRoutes.ts`, are behind `executeTool` and not profile-aware.
- `recipe test` / `recipe record` fixture runs are not gated.
- No prompt size cap.

## Alternatives rejected

- **Nine more feature flags.** Every flag is one more thing an operator has to
  know about, and the audit's central finding was that the security posture
  had become a function of tribal knowledge.
- **Flipping defaults for everyone.** Would change behaviour on upgrade for
  every existing install, which this repository has consistently refused to do.
- **A second policy interpreter for the dashboard/CLI.** Would drift from the
  runner; the preview-equals-gate discipline already in `previewActions` is the
  pattern this follows.
