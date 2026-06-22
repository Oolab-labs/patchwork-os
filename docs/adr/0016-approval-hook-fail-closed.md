# ADR-0016: Approval Hook Fails Closed When the Bridge Is Unreachable

**Status:** Accepted
**Date:** 2026-06-22

## Context

`scripts/patchwork-approval-hook.sh` is the Claude Code `PreToolUse` hook that
routes every gated tool call through the bridge `/approvals` endpoint and blocks
until a human (or policy) decides. It is the enforcement edge of the approval
gate (see [ADR-0013](0013-kill-switch.md) for the sibling write-tier
kill-switch).

The original hook failed **open**: when the bridge could not be reached it
allowed the tool call. Three code paths did this:

1. No bridge lock discoverable (no `port`/`token`) → `exit 0`.
2. The `curl` POST to `/approvals` failed (connection refused, timeout, crash
   mid-request) → the `|| echo '{"decision":"allow",...}'` fallback synthesized
   an allow.
3. A non-JSON / non-object response body → the decision parser defaulted the
   missing field to `"allow"`.

This inverts the security property the gate exists to provide. An attacker (or
a flaky environment) who can crash, partition, or wedge the bridge thereby
*disables* the gate entirely — every subsequent tool call is auto-approved with
no record. A safety control that evaporates the moment its dependency is
unavailable is worse than none, because operators believe they are protected.
(Audit 2026-06-19; bundled with the H6 webhook-auth and L43/L44 `/hooks`
hardening on the same security-floor pass.)

## Decision

The hook **fails closed**. Any unreachable / degenerate-response condition
denies the tool call (`exit 2` with a structured `permissionDecision: "deny"`
payload for modern Claude Code, plus a human-readable stderr line for older
versions). The three paths above now all route through a single
`handle_unreachable <reason>` helper with reason tokens `no_bridge`,
`request_failed`, `empty_response`, and `bad_response`.

An explicit escape hatch restores the legacy behavior:
**`PATCHWORK_APPROVAL_FAIL_OPEN=1`** (or `=true`). When set, an unreachable
bridge allows the call and logs that it did so. This is for installs that wire
the hook but legitimately run offline or without a bridge (local dev), where a
hard deny on every tool call would be unusable.

Intentional *skips* are unchanged and still allow: empty tool name (CC startup
probes), `bypassPermissions` / `auto` permission modes (CC owns those), and
`mcp__*` tools (already gated by CC's allow list). These are not
bridge-unreachable conditions — they are "the gate does not apply here".

### VPS crypto-brief audit (precondition)

Before flipping the default we audited the production crypto-brief cron, which
runs `claude -p` as the `patchwork` user on the prod VPS. Its active
`~/.claude/settings.json` is `{}` — **no `PreToolUse` hook is wired** (only a
stale `.bak-root-copy`). The cron therefore does not depend on fail-open and is
unaffected by this change. This matches the standing rule that the automation
user must run with a clean settings file.

## Alternatives considered

1. **Keep fail-open, warn loudly.** Rejected — a warning does not stop the
   tool call; the gate is still bypassed.
2. **Fail-closed with no escape hatch.** Rejected — breaks every offline/dev
   install that has the hook wired but no bridge running. The env var keeps the
   default safe while leaving an explicit, auditable opt-out.
3. **Default `decision` to `"allow"` only for HTTP 200 + parseable JSON.**
   This is effectively what the fix does, but expressed as "anything that is
   not an explicit, well-formed decision is unreachable → deny", which closes
   the malformed-body path too rather than treating it as allow.

## Consequences

- A crashed or wedged bridge now blocks tool calls for any session with the
  hook wired. Operators who want offline tolerance must set
  `PATCHWORK_APPROVAL_FAIL_OPEN=1` explicitly — the trade-off is now a
  conscious decision rather than a silent default.
- The hook references the repo script directly in some local installs, so a
  transient lock-discovery miss can deny a call mid-session; the escape hatch
  is the supported mitigation for dev machines.
- Tests: `src/__tests__/approvalHookScript.test.ts` covers fail-closed on
  request failure, no-lock discovery, malformed body, and the
  `PATCHWORK_APPROVAL_FAIL_OPEN` override.
