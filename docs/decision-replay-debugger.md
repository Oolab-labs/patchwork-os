# Decision Replay Debugger — design doc

> **Status:** design only, not implemented. Last updated 2026-05-02.
> **Source:** [Memory/Ecosystem strategic-plan agent §4](strategic/2026-05-02/memory-ecosystem-report.md).
> **Effort estimate:** 2–3 weeks once prerequisites land.

## What this is

> *"Given last Tuesday's inputs, what would have happened under today's policy?"*

A read-only fold over historical approval rows that runs a *new* policy against captured *old* inputs. Output: per-row `[old → new]` decisions with a summary of `{total, agree, disagree, newApprovals, newRejections}`.

The use cases the strategic plan calls out:

- **Tightening a policy.** *"If I move `gitPush` from `ask` to `deny`, how many approvals last quarter would have changed?"*
- **Loosening a policy.** *"If I move `Read` from `ask` to `allow`, do I lose any rejections that mattered?"*
- **Trust graduation.** *"This recipe has been auto-approving for 30 days. What would the rejection count have been if it had stayed on `ask`?"*
- **Compliance audit.** *"Show me every decision in Q3 that the current policy disagrees with."*

## Why this matters

Every other answer to those questions today is a guess. The codebase already knows the right answer — it's sitting in `~/.patchwork/decision_traces.jsonl` and the activity log. We just don't have a way to ask.

Critically: **this is the load-bearing reason approval-input capture (PR #126) was the highest-leverage memory-track investment per LoC.** Without `(params, tier, riskSignals)` on every `approval_decision` row, there's nothing to fold a new policy over. With them, replay is a pure function.

## Prerequisites

| Prereq | Status | Source |
|---|---|---|
| Approval inputs (`params`, `tier`, `riskSignals`) on every decision row | ✅ Shipped | [PR #126](https://github.com/Oolab-labs/patchwork-os/pull/126) |
| Trace export bundle (`patchwork traces export`) | ✅ Shipped | [PR #128](https://github.com/Oolab-labs/patchwork-os/pull/128), [PR #132](https://github.com/Oolab-labs/patchwork-os/pull/132) |
| Policy as data, not code (the work in step 2 below) | ❌ Not yet | This doc |
| HTTP/CLI surface (the work in step 3 below) | ❌ Not yet | This doc |
| Dashboard `/replay` page | ❌ Not yet | This doc |

The first prerequisite was the structural unlock; everything else is now a straightforward code-shaping exercise.

## Architecture (5 parts, mapping the agent's 5 needs)

### 1. Approval-input capture — DONE

Already shipped. Every `approval_decision` row in [src/activityLog.ts](../src/activityLog.ts) now carries `{toolName, sessionId, params (redacted/truncated like captureForRunlog), tier, riskSignals}`. Backfill is impossible — older rows lack these fields and replay must skip them with a count surfaced in the result.

### 2. Policy as data, not code

Today, [src/riskTier.ts](../src/riskTier.ts) and [src/approvalHttp.ts](../src/approvalHttp.ts) decide tier inline as part of request handling. To replay a *different* policy we need the policy to be a callable that takes `(toolName, params, sessionContext)` and returns `{tier, decision, reasons}` with **no side effects**.

Concretely, extract:

```ts
// src/policyEngine.ts (new)
export interface PolicyContext {
  /** Snapshot of CC permission rules at evaluation time. */
  ccRules: { allow: string[]; ask: string[]; deny: string[] };
  /** Approval gate setting at evaluation time. */
  approvalGate: "off" | "high" | "all";
  /** Workspace path — used for path-escape signals. */
  workspace: string;
  /** Permission mode at decision time (auto / dontAsk / plan / interactive). */
  permissionMode?: "auto" | "dontAsk" | "plan" | "interactive";
}

export interface PolicyEvaluation {
  decision: "allow" | "deny" | "queue";
  reason: string;
  tier: RiskTier;
  riskSignals: RiskSignal[];
}

export function evaluatePolicy(
  toolName: string,
  params: Record<string, unknown>,
  ctx: PolicyContext,
): PolicyEvaluation;
```

The current [`handleApprovalRequest`](../src/approvalHttp.ts) becomes a thin shell over `evaluatePolicy`, plus the queue-and-await machinery. The replay path calls `evaluatePolicy` repeatedly with different `ctx` over historical rows.

### 3. CLI / HTTP surface

```
POST /approvals/replay
{
  "policyVersion": "current" | { ccRules, approvalGate, workspace },
  "since": "2026-04-01T00:00:00Z",
  "until": "2026-05-01T00:00:00Z"
}
→
{
  "total": 4521,
  "skippedNoInputs": 312,           // pre-#126 rows
  "agree": 4022,
  "disagree": 187,
  "newApprovals": 94,                // would-be-allow under new policy, was deny
  "newRejections": 93,               // would-be-deny under new policy, was allow
  "examples": [
    {
      "id": 14029,
      "timestamp": "2026-04-12T08:32:14Z",
      "toolName": "Bash",
      "old": { "decision": "allow", "reason": "cc_allow_rule" },
      "new": { "decision": "deny", "reason": "cc_deny_rule" }
    },
    // … capped at 100 by default
  ]
}
```

CLI counterpart: `patchwork approvals replay [--since DATE] [--until DATE] [--policy-file <path>]`.

### 4. Dashboard `/replay` page

One page, three components:

1. **Policy editor** — show current policy as JSON (read-only) with a "load alternative" button that accepts a JSON file. Future: form-mode editor for the common deltas.
2. **Range picker + run** — date range, run button, live progress.
3. **Diff table** — paginated list of rows where old ≠ new. Each row: timestamp, toolName, redacted params snippet, `[old → new]` chip, reason chips.

Reuse the marketplace page's React patterns ([dashboard/src/app/marketplace/](../dashboard/src/app/marketplace/)).

### 5. No-side-effects guarantee

Same model as the existing recipe `replayRun.ts`. Hard invariants:

- Replay does **not** unblock the original promises — that ship sailed when the original decision was made.
- Replay does **not** trigger any downstream tool calls.
- Replay does **not** emit `approval_decision` lifecycle events. (Otherwise the next replay would see the previous replay's events.)
- Replay does **not** mutate any state outside the response payload. Pure fold.

These are documented in the design doc *and* enforced in [src/approvalQueue.ts](../src/approvalQueue.ts) by gating any state mutation behind a `replayMode: false` precondition.

## Effort estimate

| Step | Effort | Depends on |
|---|---|---|
| Extract `policyEngine.ts` from `approvalHttp.ts` + `riskTier.ts` | 2 days | nothing |
| `POST /approvals/replay` HTTP handler + CLI | 2 days | step 1 |
| Tests for the fold (pure function, easy to test exhaustively) | 2 days | step 2 |
| Dashboard `/replay` page | 5 days | step 2 |
| Documentation + worked example | 1 day | step 4 |

**Total: ~12 days of focused work.** Strategic-plan agent estimate (2-3 weeks) accounts for review cycles, integration testing, and the realistic ratio of focused work to elapsed days.

## Open questions

1. **Should replay support partial policy changes?** A user might want to ask "what if I only change `runCommand`'s tier?" without rewriting the whole policy. The `policyVersion` payload above is whole-policy; supporting deltas would be a thin wrapper.
2. **How are CC permission rules versioned across replay?** Today `ccPermissions` are read live from `~/.claude/settings.json`. For replay to be reproducible, we may want to snapshot the rule set at decision time and replay against that snapshot — otherwise editing your settings.json invalidates last week's "agree" count.
3. **What about replay over an exported bundle?** A future enhancement: `patchwork approvals replay --bundle traces-export-*.jsonl.gz` for offline analysis on a different machine. Trivial extension once step 1 is done.
4. **Multi-policy A/B?** Run two candidate policies against the same range, surface their disagreement on top of the historical disagreement. Useful for "which of these two tightenings has fewer surprises?" Probably a v2 feature.

## Why this is in the queue, not in flight

The strategic plan flagged trace durability and approval-input capture as the prerequisite layer. Both are now done. The next decision belongs to the maintainer:

- **Ship now**, after canonical-positioning and recipe-lifecycle work has merged. ~12 days of focused engineering.
- **Defer** until at least one strategic Phase 2 PR (Trust Graduation, Run Timeline) lands, on the theory that those will inform the policy-as-data shape. Not unreasonable — Trust Graduation specifically needs `evaluatePolicy` as a callable.
- **Combine** with Trust Graduation as one PR — they share the policy-engine extraction and would benefit from coordinated design.

Recommendation per the original 2026-05-02 walk-through: defer, build alongside Trust Graduation. The two features share so much structural work that splitting them is wasteful.

## See also

- [PR #126 — approval-input capture](https://github.com/Oolab-labs/patchwork-os/pull/126) (the prerequisite)
- [PR #128 — `patchwork traces export`](https://github.com/Oolab-labs/patchwork-os/pull/128) (offline analysis target)
- [PR #132 — `--encrypt` for traces export](https://github.com/Oolab-labs/patchwork-os/pull/132) (compliance overlap)
- [strategic/2026-05-02/memory-ecosystem-report.md](strategic/2026-05-02/memory-ecosystem-report.md) §4 (the source brief)
- [src/approvalHttp.ts](../src/approvalHttp.ts) (current monolith to be split)
- [src/riskTier.ts](../src/riskTier.ts) (the inline policy that becomes data)
