# ADR-0009: Webhook Fan-out for Automation Hooks

**Status:** Accepted
**Date:** 2026-05-09

## Context

The bridge ships an automation policy DSL ([src/fp/automationProgram.ts](../../src/fp/automationProgram.ts)) that fires Claude tasks on IDE events: file save, diagnostic state change, compaction, test run, etc. Each hook entry is a `{ prompt | promptName, cooldownMs, ... }` record that flows through the `AutomationProgram` ADT, gets parsed by [src/fp/policyParser.ts](../../src/fp/policyParser.ts), and runs through [src/fp/automationInterpreter.ts](../../src/fp/automationInterpreter.ts).

Recipe 6 (`examples/recipes/bridge-dev/compaction-snapshot-pre.yaml` and `compaction-snapshot-post.yaml`) wants to capture and restore IDE state across compaction. Both recipes use `trigger.type: webhook`, which means they fire when the bridge POSTs to a configured URL. But the existing `onCompaction` hook only knows how to enqueue a Claude task — it has no native way to POST to a webhook. So recipe 6 is currently unrunnable from automation; the operator has to manually fire it from the dashboard or wire a `curl` into the CC `PreCompact` hook command.

## Decision

Extend the `Hook` ADT node with an optional `webhook?: WebhookConfig` field and the `Backend` interface with `postWebhook(opts)`. The interpreter fires the webhook AFTER the inline prompt has been enqueued (sequential, not parallel) on the success path of every Hook node that has it set.

Wire the new field through the parser ONLY for `onCompaction` hook types (`onPreCompact` / `onPostCompact`) in this slice. Other hook types parse the field successfully — the schema is forward-compatible — but the parser silently drops it for non-opted-in types, gated by a single `WEBHOOK_ENABLED_HOOK_TYPES` set in [src/fp/policyParser.ts](../../src/fp/policyParser.ts). Adding `onGitCommit`, `onTestRun`, etc. is then a one-line change.

A new `PromptSourceNode` variant `{ kind: "none" }` represents webhook-only hook entries — entries with no inline prompt and no named prompt, just a webhook. The interpreter's Hook case skips the task enqueue but still proceeds to the webhook fan-out. `WithCooldown` was extended to detect webhook firing (delta in `lastWebhookFiredAt`) so cooldowns gate webhook-only hooks the same way they gate prompt-bearing ones.

`AutomationState` gains a `lastWebhookFiredAt: ReadonlyMap<string, number>` field. Recorded on every webhook attempt regardless of HTTP outcome — operators debugging webhook delivery want the "we tried at T" timestamp. Merged via max-per-key in `mergeAutomationStates`.

### Body shape (v1)

```json
{
  "hookType": "onPreCompact",
  "phase": "pre",
  "timestamp": 1700000000000
}
```

Plus any keys in the hook's `eventData` map (compaction has none today; future hooks will add their own placeholders).

### Failure semantics

`Backend.postWebhook` is contractually "never rejects" — it always resolves with `{ ok, status?, error? }`. The interpreter wraps the call in a defensive try/catch anyway (a buggy backend could throw). Failures are recorded as interpreter errors and logged; they do NOT block other hooks in the same run, and they do NOT block the prompt enqueue (which already happened, sequentially before the webhook). 10 second timeout. Non-2xx counts as failure.

### SSRF policy

The production `VsCodeBackend` allows webhook URLs that are loopback (127.0.0.0/8, ::1, localhost, *.localhost) OR public, and BLOCKS all other RFC 1918 / link-local / ULA / CGNAT / 0.0.0.0/8 ranges by default. Opt out via constructor flag (CLI `--automation-allow-private-webhooks` is a follow-up).

This is a deliberate divergence from `sendHttpRequest` (which blocks ALL private addresses by default, loopback included). The reasoning:

- A `sendHttpRequest` URL is potentially LLM-controlled — a compromised session could craft URLs. SSRF is real attack surface.
- An automation webhook URL comes from a trusted policy file the operator wrote. Loopback is the intended common case, not the exceptional one. Recipe-6 webhooks target `http://127.0.0.1:${BRIDGE_PORT}/...` — the bridge talking to itself.

Other private ranges (10/8, 192.168/16, etc.) are still blocked by default — those would mostly indicate misconfiguration where a webhook URL accidentally points at the operator's home network or a shared dev VPC. The opt-in covers the rare case where an operator does want that.

## Alternatives considered

1. **Run webhook in `Parallel` with prompt** — rejected. The interpreter changed `Parallel` to be sequential (see commit history, automationInterpreter.ts case `"Parallel"`) precisely because branches need to see each other's state writes. A webhook firing in parallel with a prompt enqueue would race `lastWebhookFiredAt` against `lastTrigger`, and one would clobber the other in the cooldown record. Sequential is correct.

2. **Add a `notify` URL to the existing `Backend.notify` channel** — rejected. `notify` is a fire-and-forget log line, not a structured HTTP call. Conflating them would make the test ergonomics ugly (`notifications: string[]` vs `webhookCalls: BackendWebhookOpts[]`).

3. **New top-level node type `WebhookNode`** — rejected. Would require duplicating cooldown/dedup/rateLimit wrapping to apply to webhook-only entries. Attaching `webhook` to `HookNode` lets all the existing combinators (`WithCooldown`, `WithRetry`, `WithDedup`, `WithRateLimit`) wrap it for free.

4. **Loopback-by-default, no opt-in for other private** — rejected. Power users will run the bridge inside Docker / k8s / WSL2 where the "loopback" target is reachable only via 172.x or 10.x. They need an escape hatch.

## Consequences

- Recipe 6 unblocks once recipes are wired in via `compaction-snapshot-pre.yaml`'s webhook path (operator points the policy's `webhook.url` at the recipe's webhook trigger endpoint).
- New `webhook` field accepted on every hook config but no-op for non-opted-in types. Operators who set it on `onGitCommit` today will see no effect; we can flip the bit later.
- One new state field; all serialization (state checkpoint, dashboards) needs to keep accepting state without it for backward compat. `EMPTY_AUTOMATION_STATE` covers initial construction; `mergeAutomationStates` covers the reconciliation path.
- `Backend` interface gained one method — every implementation (prod + test + future) must add it.
