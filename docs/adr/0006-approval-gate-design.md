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

High-tier tools are tagged with `riskSignals` ([src/approvalHttp.ts](../../src/approvalHttp.ts) `computeRiskSignals`) that the dashboard surfaces as badges:

- Destructive flags: `rm -rf`, `--force`, `sudo`, `DROP TABLE`, `TRUNCATE`, shell chaining.
- Domain reputation: non-HTTPS, raw IP hostname.
- Path escape: `file_path` outside workspace.

Signals are advisory — they don't change the decision, they help the human decide.

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
