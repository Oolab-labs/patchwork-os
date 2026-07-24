# ADR-0006: Approval Gate — Dashboard as Claude Code Permission UI

**Status:** Accepted
**Date:** 2026-04-18

## Context

Claude Code (CC) enforces tool permissions through `settings.json` rules (`allow` / `ask` / `deny` arrays) and a `permission_mode` (`default` / `auto` / `plan` / `dontAsk`). Rules are static — edited by hand, reloaded on session start. There is no interactive UI for "ask" rules; CC prompts the user in the terminal, which blocks the agent until the human is in front of the terminal.

Patchwork needs a runtime, UI-driven approval surface:

- Humans can be on a phone / away from the terminal when CC asks for permission.
- Security-sensitive operations (`gitPush`, `Bash(rm -rf …)`, write to paths outside workspace) deserve a dashboard with context — risk signals, recent activity, current session — not a terse y/N prompt.
- Teams running shared deployments need managed policy: admin-controlled deny rules that override user settings.
- The same approval surface must work whether CC invoked the tool natively or through the bridge's MCP transport.

The naive approach — reimplement CC's permission system inside Patchwork — drifts from CC's semantics, confuses users, and duplicates audit trails. We need to **align with CC's model, not replace it.**

## Decision

Treat the Patchwork dashboard as **the UI for CC's existing "ask" rules**, not a parallel permission system. The gate runs at two layers:

### 1. CC `PreToolUse` hook path (primary)

CC's `PreToolUse` hook fires before every tool invocation and can block by emitting `decision: "deny"` on stdout. We register a hook script that:

1. Parses the tool call from stdin JSON.
2. POSTs `{ toolName, specifier, params, summary, permissionMode, sessionId }` to `POST /approvals` on the local bridge.
3. Blocks until the bridge responds, then exits 0/2 accordingly.

Bridge handler ([src/approvalHttp.ts](../../src/approvalHttp.ts)) resolves the decision in strict precedence order:

```
CC deny rule        →  deny immediately        (reason: cc_deny_rule)
CC allow rule       →  allow immediately       (reason: cc_allow_rule)
permissionMode:
  dontAsk           →  deny (no UI to prompt)  (reason: dontAsk_mode)
  auto              →  allow (CC owns it)      (reason: auto_mode)
  plan + read tool  →  allow                   (reason: plan_mode_read)
  plan + write tool →  deny                    (reason: plan_mode_write)
approvalGate:
  off               →  allow                   (reason: gate_off)
  high + low-tier   →  allow                   (reason: gate_below_threshold)
  all / high+hi-tier → queue for dashboard → await resolve/reject
```

Only the final branch blocks on a human. Every other path short-circuits deterministically.

### 2. MCP transport path (secondary)

When Patchwork is the MCP server, the same `routeApprovalRequest` handler runs in the tool-dispatch middleware before executing any tool. Same precedence, same rules, same queue.

### Rule loader

CC settings are read live from disk ([src/ccPermissions.ts](../../src/ccPermissions.ts)), merged in the documented CC precedence:

```
managed (admin, highest) > project > user (lowest)
```

`loadCcPermissionsAttributed` returns the same rules but tagged with origin (`managed` / `project` / `user`) so the dashboard can show **why** a rule matched. This is exposed via `GET /cc-permissions` for the settings UI.

### Glob matching

Specifiers (e.g. `Bash(npm run *)`) are matched with glob semantics via `evaluateRules`. Exact tool-name matches (`Read`, `gitPush`) always take precedence over specifier patterns to avoid surprising overrides.

### Managed settings

`managedSettingsPath` points at an admin-writable JSON file with the same shape as user settings. It is merged at the top of the precedence chain and cannot be overridden from project or user scope. This is how an org enforces "never allow `gitPush` to main" across all developers.

### Gate tiers

`approvalGate` is a runtime knob surfaced in the settings dashboard:

- `off` — dev mode; bypass all queueing, approve everything.
- `high` — only queue high-tier tools (`classifyTool` returns `"high"` for writes, network, exec).
- `all` — queue every tool below the allow/deny short-circuits.

Changeable at runtime — no reconnect, no hook reinstall — because the gate is consulted on every request.

### Risk signals

Risk signals are computed by `computeRiskSignals` in [`src/riskSignals.ts`](../../src/riskSignals.ts) (shared module, replaces former inline logic in `src/approvalHttp.ts`) and surfaced as dashboard badges:

- Destructive flags: `rm -rf`, `--force`, `sudo`, `DROP TABLE`, `TRUNCATE`, shell chaining.
- Domain reputation: non-HTTPS, raw IP hostname.
- Path escape: `file_path` outside workspace.
- **Destructive command (HIGH)**: `git reset --hard`, `git clean -f/-d/--force`, `git push --force` without `--force-with-lease`, `eval`, `chmod 777`, `kill -9`, `pkill`. Also applied to structured `runCommand{command, args}` calls (args joined before pattern matching).
- **Data exfiltration (HIGH)**: network-egress upload flag co-occurring with a credential-path token (`~/.ssh`, `~/.aws`, `.env`, `id_rsa`, `.npmrc`, `.netrc`, etc.).

**Amendment (PR #1015):** Signals are now **escalatory**, not advisory. A sub-high-tier tool that carries any HIGH-severity signal (`hasHighSeverity = true`) is promoted from bypass → queue. Both WebSocket and Streamable-HTTP transports are content-aware via `evaluateInProcessGate()` (previously both hardcoded `riskSignals:[]`).

## Consequences

**Positive:**

- **One source of truth.** CC's `settings.json` is the permission config; the dashboard is the UI. Edit either, the other stays in sync.
- **Predictable short-circuits.** Static rules resolve without a human. Only true "ask" calls block, and they always surface in the UI.
- **Runtime-adjustable gate.** Flip `approvalGate` from the settings page — takes effect on the next request, no CC restart.
- **Managed settings give orgs real enforcement** without forking CC.
- **MCP and native paths share one handler** — no duplicate logic, same audit trail.

**Negative:**

- **Hook script must be installed** per workspace. Failure to install = no approval gate on the native CC path. Mitigated by onboarding check surfaced in `getBridgeStatus`.
- **Polling model for the hook** — hook script blocks on HTTP until the bridge responds. If the bridge dies mid-request, the hook hangs until CC times it out. Acceptable; bridge crashes are rare and CC's timeout is bounded.
- **`dontAsk` maps to deny, not allow.** Some users expect `dontAsk` to mean "trust me, allow everything silently." We intentionally invert that: if there's no UI to prompt and no explicit allow rule, we deny — safer default. Documented in [documents/platform-docs.md](../../documents/platform-docs.md).

**Audit rules:**

- Every new permission-mode branch must emit via `onDecision` with a stable `reason` string. Dashboard filters and analytics depend on these.
- Every response body on `/approvals` POST must include `{ decision, reason }`. New branches without `reason` break the audit log.
- Glob rules must be evaluated through `evaluateRules` — never re-implement matching inline.

## Amendment: Mobile / Phone-Path Approval (2026-04-22)

The existing gate queues calls and surfaces them in the **desktop dashboard**. A parallel
phone path has been added so approvals can be acted on from a mobile device without the
bridge token.

### Push notification path

After a call is queued, `handleApprovalRequest` now fires a second background task
(`dispatchPushNotification`) parallel to the existing webhook dispatch:

```
queue entry created
  ├── dispatchApprovalWebhook (existing — generic HTTP webhook)
  └── dispatchPushNotification (new — push relay for FCM/APNS)
        POST ${PATCHWORK_PUSH_URL}/push  {callId, toolName, tier, approvalToken, …}
```

The push relay (`services/push-relay/`) receives the payload, looks up the user's
registered FCM/APNS device tokens, and sends a notification within seconds.

### Per-callId approval tokens

To allow the phone to call back without the bridge bearer token, each queued entry
gains an optional `approvalToken` (256-bit hex, `crypto.randomBytes(32)`):

- Only generated when `pushServiceUrl` is configured (zero overhead for local-only users).
- Delivered in the push notification payload.
- Single-use: cleared from the queue entry after first validation, regardless of outcome.
- Validated with `crypto.timingSafeEqual` (timing-safe).
- Expires when the queue entry expires (per-tier TTL — see the risk-tiered
  timeout amendment below; no longer a single flat 5 min for every tier).

### Phone-path bearer bypass

`POST /approve/:callId` and `POST /reject/:callId` in `src/server.ts` normally require the
`Authorization: Bearer <bridge-token>` header. When an `x-approval-token` header is present
on these two paths, bearer auth is skipped and token validation is delegated to
`ApprovalQueue.validateToken()`. The decision resolution path is otherwise identical.

### Invariants

- `approvalToken` is **never** returned by `GET /approvals` — only delivered via the push relay.
- The push notification call is fire-and-forget: it never delays or blocks the approval flow.
- Disabling `pushServiceUrl` at runtime drops token generation for new requests immediately.
- Phone-path tokens and bridge tokens are independent — compromise of one does not affect the other.

## Amendment: Risk-Tiered Approval Timeout (2026-07-24)

### Problem

Every queued approval — regardless of `RiskTier` — shared one flat 5-minute
TTL (`ApprovalQueue`'s `setTimeout`, hardcoded). This is a documented
anti-pattern ("approval fatigue"): a short countdown on a *high-risk* action
(`gitPush`, `npm publish`, PR merge) pressures the reviewer into
rubber-stamping to beat the clock, defeating the point of gating it at all.
Conversely, a flat window that's too generous for *low-risk* reads wastes a
queue slot needlessly. See `aipatternbook.com/approval-fatigue` and
`developersdigest.tech`'s "Approval Fatigue Is an Agent Security Bug" for the
broader pattern this follows.

### Decision

`ApprovalQueue` resolves its expiry TTL per `RiskTier` (`low`/`medium`/`high`)
instead of one process-wide constant (`src/approvalQueue.ts`,
`ApprovalQueue.DEFAULT_TTL_MS`):

```
low    → 5 min   (fail-fast — matches the pre-amendment behavior)
medium → 60 min
high   → 4 hours
```

A tier's configured value of `0` (or CLI/config `"none"`/`"infinite"`) means
**no expiry** — the entry is held until a human explicitly approves/rejects
or the originating caller cancels. **A fired timer always resolves
`"expired"`, never `"approved"`** — timeouts cannot silently escalate
privilege regardless of tier; "no expiry" only removes the forced-fail path,
it never adds a forced-allow path.

**Compatibility note:** before this amendment, `high` shared the same 5-min
window as everything else — an unattended high-risk approval failed closed
quickly. The new 4-hour default is a deliberate fail-safe tradeoff: long
enough to not pressure a reviewer, still bounded so an unattended approval
eventually fails closed rather than hanging forever by default. Operators
who want a genuinely unbounded hold opt in explicitly via
`--approval-timeout-high none` (or the equivalent dashboard/config value).

### Configuration surfaces

- **CLI**: `--approval-timeout-<low|medium|high> <duration>` at bridge
  startup. Duration accepts `"none"`/`"infinite"`, a bare ms integer, or
  `"30s"`/`"5m"`/`"2h"`. Rejected above ~24.8 days
  (`MAX_APPROVAL_TIMEOUT_MS`, Node's `setTimeout` ceiling) — Node silently
  fires a timer immediately past that instead of waiting, which would
  otherwise silently defeat a long intended window.
- **`~/.patchwork/config.json`**: `approvalTimeouts: {low, medium, high}`
  (ms). Loaded non-fatally — a corrupted/malformed value is dropped per-tier
  with a warning (`sanitizeApprovalTimeouts`, `src/config.ts`) rather than
  crashing the bridge, since this file is dashboard-writable.
- **`POST /settings`** (runtime, no restart): `{ approvalTimeouts: {low?,
  medium?, high?} }`, same validation as the CLI plus one addition — a
  tier's value of **`null`** explicitly clears that tier's override back to
  `DEFAULT_TTL_MS` (distinct from omitting the key, which leaves whatever is
  already saved untouched). Merges into the existing per-tier map rather
  than replacing it wholesale, mirroring `cfg.dashboard`'s existing
  partial-update convention. Applied live via `ApprovalQueue.setTtlByTier()`
  — **only affects entries queued after the change**; anything already
  pending keeps the deadline it was given at enqueue time. Dashboard control
  lives in the "Approval policy" settings card, same duration syntax as the
  CLI, with the same in-progress-edit-survives-a-poll dirty-tracking the
  `approvalGate` select already uses.

### Consequences

**Positive:**

- Matches documented best practice for risk-tiered HITL timeouts — not
  novel, catching up to how GitHub Actions environment-protection wait
  timers and similar agent-oversight guides already recommend tiering.
- `expiresAt` on a pending entry (`src/approvalQueue.ts`) is now a real
  computed field (`number | null`), not implicitly re-derived at every call
  site — webhook/push payloads and the dashboard countdown all read the
  same value instead of three independently-hardcoded `+5min` assumptions
  (one of which, in the dashboard, was found to be actively wrong for `null`
  during this work — see below).

**Negative / risks accepted:**

- **A no-expiry (`0`/`"none"`) high-tier approval can sit indefinitely** if
  the reviewer walks away and never decides. Accepted tradeoff — the kill
  switch (ADR-0013) remains the fail-safe of last resort for "operator is
  gone and something sensitive is open," and the *default* is bounded (4h),
  so this only bites operators who explicitly opted into unbounded holds.
- **Dashboard `expiresAt === null` handling was a live bug during
  development**, not just a design risk: the countdown component's `??`
  fallback treated an explicit "no expiry" `null` the same as "missing
  field," rendering a fake 5-minute countdown for every high-tier approval
  and immediately reading "Expired" (since `Math.max(0, null - Date.now())`
  coerces to `0`). Fixed by threading `number | null` through
  `CountdownTimer`, `approvals/page.tsx`, and `approvals/[callId]/page.tsx`
  explicitly, with a distinct "No expiry" badge state.
- **Settings-page dirty-tracking pitfall**: an early version of the
  dashboard's per-tier duration inputs mutated a ref as a side effect
  inside a `setState` functional updater to track "last synced from
  server" vs. "user's in-progress draft" in one combined ref. Since React
  may invoke a state updater more than once (dev double-invoke, bailed-out
  replays), this could rebase the dirty-check baseline against itself
  mid-edit and silently drop or misapply a concurrent change. Fixed by
  splitting into two refs — mirroring the existing `gateValueRef` /
  `gatePendingRef` split for the `approvalGate` control exactly — and doing
  the ref mutation as a plain statement outside any updater callback.

### Audit rules (new)

- Any new call site that computes an approval's display deadline must read
  `PendingApproval.expiresAt` (or `ApprovalQueue.peek()`) rather than
  re-deriving `requestedAt + <assumed constant>` — the constant is
  config-dependent per tier and can be `null`.
- Any new per-tier config surface (CLI, config file, or `/settings`) must
  reject/clamp values above `MAX_APPROVAL_TIMEOUT_MS`, not just type-check
  them — Node's `setTimeout` fails silently (fires immediately), not with a
  thrown error, above that ceiling.
