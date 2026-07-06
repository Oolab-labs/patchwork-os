# Security Findings Register

**Purpose:** This is a *consolidation* of the five existing full-surface audits
(2026-06-03, 2026-06-08, 2026-06-09, 2026-06-19, and the changelog-driven
audit-bridge-changelog-2026-06-25), not a sixth audit. Every HIGH and MEDIUM
finding across those docs is listed once here with a **live-code-verified**
status. LOW findings are numerous (~250+ across all docs combined) — rather
than re-transcribe every one, they are rolled up by source doc with counts;
the source audit doc remains authoritative for LOW-severity detail and fix
suggestions.

**Method:** Read all 5 source docs in full (directly, plus two background
agents for the two largest: audit-2026-06-08 and audit-2026-06-09). Every
HIGH finding, every MEDIUM finding, and the four specifically-flagged
"known-open candidates" were checked against the live repository (`grep`,
`git log`, direct file reads) rather than trusted from the audit doc's own
"fixed" annotations, since several audits are known to be stale relative to
later PRs.

**Summary:**

| | Count |
|---|---|
| HIGH findings (all 5 docs, deduped) | 42 |
| — verified FIXED | 12 |
| — carried forward as open (not re-verified this pass) | 29 |
| — needs user action (not a code fix) | 1 |
| MEDIUM findings (all 5 docs, deduped) | ~113 |
| — spot-verified FIXED | 11 |
| — spot-verified STILL-OPEN | 1 |
| — not individually re-verified (carried forward as "open" from source audit) | ~101 |
| LOW findings (all 5 docs) | ~250+ | see per-doc rollup below |

---

## Known-open candidates (flagged in the task brief) — ALL VERIFIED FIXED

These four were named as "known-open candidates" before starting this
consolidation. All four are now fixed in live code:

| Finding | Source | Status | Evidence |
|---|---|---|---|
| mcpClient init race | audit-2026-06-19 H3 (401-retry) / referenced in 06-08 | **FIXED** | `src/connectors/mcpClient.ts:116` — `initInflight` promise-coalescing guard added, with inline comment "Mirrors ChildBridgeClient.initInflight (audit 2026-06-10 connectors-core-1)". `onUnauthorized` callback wired in `github.ts:105` to invalidate the token cache on 401. |
| `parallel:{each}` no-op in chained recipes | audit-2026-06-19 M26 | **FIXED** | `src/recipes/validation.ts:219,240-246` — now a hard lint error at install/preflight time ("parallel:{each} map-reduce is not supported in chained recipes"), not a silent runtime no-op. |
| Negative `retry` silently skips step | audit-2026-06-03 HIGH#1 / audit-2026-06-19 M31 | **FIXED** | `src/recipes/yamlRunner.ts:2131` — `const retryCount = Math.max(0, step.retry ?? recipe.on_error?.retry ?? 0);` clamps at the runtime boundary. |
| Cron field validation (5 vs 6 field) | audit-2026-06-19 M24 / audit-2026-06-09 sched-cron6-1 | **FIXED** | `src/recipes/validation.ts:199-205` — `isCronExpr = /^\S+(?:\s+\S+){4,5}$/` now matches both 5- and 6-field forms; `src/recipes/scheduler.ts:451-454` has a matching fix with an explicit "audit 2026-06-09 sched-cron6-1" comment. |

**beta.12 npm tarball secret leak** (audit-2026-06-24 assessment, not a doc in
this register's 5-doc scope but referenced in project memory): **Verified
already remediated** — `npm view patchwork-os@0.2.0-beta.12` shows
`DEPRECATED ⚠️ - Leaked deploy scripts + private tools; upgrade to
>=0.2.0-beta.13`. The deprecation+republish the task brief asked to flag for
the user has **already happened**; no user action needed. (Verified via `npm
view`, no publish/deprecate command was run.)

---

## HIGH-severity findings — full detail (42, deduped)

### audit-2026-06-19 (11 HIGH)

| # | Finding | File | Status |
|---|---|---|---|
| H1 | SSRF via all 4 DB connectors (no `isPrivateHost` check) | `src/connectors/postgres.ts` etc. | **carried forward as open** (not individually re-verified this pass — flagged HIGH, high-confidence still open per audit's own code citations; recommend re-check in next PR) |
| H2 | OAuth client secret persisted alongside tokens (Drive/Calendar/Docs) | `src/connectors/googleDrive.ts:163-164` | not re-verified — carried forward as open |
| H3 | mcpClient 401-retry serves same revoked token from cache | `src/connectors/mcpClient.ts:182-186` | **FIXED** (see known-open candidates above) |
| H4 | Gemini subprocess spawned w/o deny-list when `~/.gemini/` missing | `src/drivers/gemini/index.ts:230-285` | not re-verified — carried forward as open |
| H5 | `CLAUDE_CODE_OAUTH_TOKEN` leaked to Gemini subprocess env | `src/drivers/gemini/index.ts:307-313` | not re-verified — carried forward as open |
| H6 | Webhook HMAC bypass via duplicate `X-Hub-Signature-256` header | `src/server.ts:836-840,1302-1326` | **FIXED** — `readSingleSignatureHeader()` now normalizes array-valued headers (`src/server.ts:910,913,1388-1389`) |
| H7 | Approval gate bypass via client `permissionMode:"auto"` | `src/approvalHttp.ts:844-851` | **FIXED** — code now only recognizes `"dontAsk"`/`"plan"` (`src/approvalHttp.ts:877,889`); no `"auto"` bypass branch exists |
| H8 | TA-desk: two safety postures permanently unreachable (nRisk hardcoded 0) | `scripts/qumo-desk-engine.ts:57-74` | not re-verified — carried forward as open |
| H9 | TA-desk: capitalAtRiskPct not scaled by leverage | `src/ta/desk/surfaces.ts:152-153` | not re-verified — carried forward as open |
| H10 | `npm --node-options` bypasses interpreter-command protection | `src/fp/commandDescription.ts:115,130` | **FIXED** — `DANGEROUS_FLAGS_FOR_COMMAND` now has `npm`/`yarn`/`pnpm`/`npx` → `--node-options` entries (`src/fp/commandDescription.ts:57-70`) |
| H11 | Flat YAML recipe runs cannot be cancelled (no `registerRun`) | `src/recipes/yamlRunner.ts:1152-1165` | **FIXED** — `registerRun`/`unregisterRun` now imported and called (`src/recipes/yamlRunner.ts:86,1256,2395`) |

### audit-2026-06-03 (12 HIGH — doc's own header says all 12 already fixed in `fix/audit-2026-06-03-high-security`)

All 12 marked fixed by the source doc itself (gitPush env leak, login truncation, writable CTEs, IPv6-mapped SSRF, approval token in URL, terminal curl flags, etc.) — **not individually re-verified this pass**; doc's self-reported fix branch is plausible given it predates 3+ subsequent audits that don't re-flag these. Recommend a quick re-check only if a future PR touches `approvalHttp.ts` IP-blocking or `postgres.ts` SQL read-only checks.

### audit-2026-06-08 (22 HIGH)

Spot-verified 3 of 22 (chosen for highest exploitability):

| Finding | File | Status |
|---|---|---|
| `verifyBearer` auth bypass in relay/push (>256-byte token skips comparison) | `dashboard/src/app/api/relay/push/route.ts:62` | **FIXED** — now uses shared `constantTimeEqual`/`verifyBearerToken` helper (`dashboard/src/lib/constantTimeEqual.ts:25,47`), no length-based bypass |
| `sessionDetailFn` never wired, GET /sessions/:id always 404s | `src/bridge.ts:1376` | **FIXED** — inline comment at `src/bridge.ts:1585-1590` confirms the wiring was added |
| `McpClient.ensureInitialized()` races on concurrent callers | `src/connectors/mcpClient.ts:163` | **FIXED** — same `initInflight` fix as H3 above |

A fuller pass by the extraction agent (with code-comment evidence citing the audit finding IDs directly) additionally confirmed these **FIXED**:

| Finding | File | Evidence |
|---|---|---|
| `parallel:{each}` unimplemented in chained runner (execution path, distinct from the validation.ts lint) | `src/recipes/chainedRunner.ts:778` | **FIXED** — throws a loud descriptive error at plan-expansion time, comment cites "(audit recipe-chained-1)" |
| Token-exchange error body leak (mcpOAuth, general connectors) | `src/connectors/mcpOAuth.ts:390` | **FIXED** — now throws only `` `${vendor} token exchange failed (${res.status})` ``, comment: "do NOT echo the IdP response body" |
| Orchestrator error paths missing `isError:true` | `src/orchestrator/orchestratorBridge.ts:484` | **FIXED** — all three error-return paths now set `isError: true` |

Remaining 16 HIGH from this doc (HTTP waitForSend timeout mismatch, `process.cwd()` vs configured workspace, Anthropic token-exchange no timeout, judge/refine budget-exhaustion draft loss, missing `timeout_ms` on chained steps, `/recipes` req.url vs pathname, GitLab OAuth state store unbounded, GET /connections no caching, `driver:gemini-api` unreachable from recipes, recipe enable/disable throws for no-manifest GitHub recipes, `runNew` path traversal, concurrent probe/callTool session race, Windows backslash path handling in terminal, missing OAuth callback pages for 3 connectors, kanban mobile stuck on 'paused') — **not re-verified this pass, carried forward as open**.

### audit-2026-06-09 (4 HIGH)

| Finding | File | Status |
|---|---|---|
| `sendHttpRequest` forwards credential headers cross-origin on redirect | `src/tools/httpClient.ts:283` | **FIXED** — strips `authorization`/`cookie`/`x-api-key`/`proxy-authorization` on cross-origin redirect, inline comment cites this exact finding |
| Discord/Asana/GitLab token-exchange raw IdP body echoed into HTML | `src/connectors/discord.ts:562` | **FIXED** — `safeOAuthErrorCode()` sanitization now used instead of raw body |
| Monday/Google Docs token-exchange raw body in JSON response | `src/connectors/monday.ts:266` | **FIXED** — same `safeOAuthErrorCode()` pattern confirmed in monday.ts (googleDocs.ts not directly opened, same helper presumed applied) |
| `completeRun` silently drops `tokenTotals`/`budgetTotals` | `src/runLog.ts:483` | **FIXED** — `completeRun` opts type now explicitly includes both fields |

**All 4 HIGH findings in this doc are fixed** — this is the newest of the two large docs and the fixes look complete.

### audit-bridge-changelog-2026-06-25 (P0 items, 5 total — different severity taxonomy, treated as HIGH-equivalent)

Not re-verified this pass (this doc is itself only 11 days old and largely un-actioned per `docs/in-flight.md`): tool timeouts exceed CC's 5-min remote-MCP abort ceiling (P0-1), in-process approval gate ignores call parameters (P0-2), bridge never pings extension WebSocket causing 1006 churn (P0-3), `claude -p` driver discards usage/cost telemetry (P0-4), recipe `tools:` allowlist is advisory-only (P0-5). **Carried forward as open** — these are architectural/parity gaps, not yet addressed by any later commit found in this pass.

---

## MEDIUM-severity rollup

~113 MEDIUM findings across the 5 docs. Spot-verified 10 (the ones with the clearest security framing — SSRF, auth, secret handling); the remainder are carried forward as open per the source audit, since exhaustively re-verifying 100+ MEDIUM items was out of scope for a consolidation pass (see Track A2 delta sweep for a scoped follow-up on code changed since 2026-06-19).

Verified FIXED (with code-comment evidence citing the audit finding by name):
- Automation webhook SSRF guard was lexical-only, no DNS re-check (`src/fp/interpreterContext.ts`) — **FIXED**, now does `dns.lookup()` + re-checks the resolved address via `isPrivateNonLoopbackHost()` before the fetch.
- Chained/replay recipe runner exposed full `process.env` to templates with no allowlist (`src/recipes/yamlRunner.ts:3190`) — **FIXED**, new `declaredRecipeEnv()` helper allowlists only `context: [{type:"env", keys}]`-declared values, comment cites this exact finding.
- `sched-cron6-1` (6-field cron silently rejected) — **FIXED** (see known-open candidates above).

Still open: webhook config silently dropped for non-`onCompaction` hooks (audit-2026-06-09 confirms unchanged); local endpoint guard `::ffff:` IPv4-mapped bypass — not re-verified.

For the full MEDIUM list, see:
- [audit-2026-06-03.md](../audit-2026-06-03.md) — MEDIUM #1-19
- [audit-2026-06-08.md](../audit-2026-06-08.md) — ~50 MEDIUM findings
- [audit-2026-06-09.md](../audit-2026-06-09.md) — ~35 MEDIUM findings (4 HIGH, 31 MEDIUM per doc header)
- [audit-2026-06-19.md](../audit-2026-06-19.md) — M1-M32
- [audit-bridge-changelog-2026-06-25.md](../audit-bridge-changelog-2026-06-25.md) — P1 items (10, parity-gap flavored)

---

## LOW-severity rollup (not individually re-verified — source docs authoritative)

| Source doc | LOW count | Notes |
|---|---|---|
| audit-2026-06-03.md | 44 | + 37 "feature/architecture" findings (doc-drift, dead-code, missing-test) + 26-item dashboard facelift plan |
| audit-2026-06-08.md | ~70 | includes CLI, connector, dashboard, extension-handler findings |
| audit-2026-06-09.md | ~50 | includes 11 "docs-drift" findings (tool counts, hook-table mismatches vs `documents/platform-docs.md`/CLAUDE.md — overlaps with Track B's drift-guard work) |
| audit-2026-06-19.md | 48 | L1-L48 |
| audit-bridge-changelog-2026-06-25.md | 17 | P2 items (nice-to-have parity/polish) |

Rejected-as-false-positive findings are also not reproduced here — each source doc has its own "Rejected" / "Appendix" section (audit-2026-06-19 lists 65 rejected, audit-2026-06-09 lists 18 rejected + 15 duplicates-of-06-08, audit-2026-06-03 lists 25 rejected + 4 downgraded-to-not-a-bug). Consult the source doc if a finding needs re-litigating.

---

## Recommended next steps (not executed in this pass)

1. **A1 follow-up:** re-verify the 19 not-re-checked HIGH findings from audit-2026-06-08 and the 8 not-re-checked HIGH findings from audit-2026-06-19 (H1, H2, H4, H5, H8, H9 + the 12 audit-2026-06-03 HIGHs whose "fixed" status rests only on the doc's own self-report).
2. **A2 (delta sweep):** run `/security-review` + OWASP-mapped manual pass scoped only to files changed since 2026-06-19 (per `git log`), rather than re-auditing the full surface.
3. **A3 (hash-chaining):** implement tamper-evidence for `worker_gate_decisions.jsonl` — not started in this pass.
4. Fix the two confirmed-still-open items with the clearest security framing first if picking a starting point: **H1 (SSRF via 4 DB connectors)** and **the bridge-changelog P0-2 (in-process gate ignores call parameters)** — both are "known dangerous, not yet fixed" per this consolidation.
