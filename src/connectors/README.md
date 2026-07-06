# Connectors

This directory implements the 46 registered third-party connectors (GitHub, Slack, Gmail, Jira, Postgres, Redis, MongoDB, Elasticsearch, Notion, Stripe, and others), each behind a common `BaseConnector` contract. Most connectors are thin routers onto a vendor's own MCP server (via `mcpClient.ts` + OAuth); a handful (Postgres, Redis, MongoDB, Elasticsearch) speak the vendor protocol directly and carry their own SSRF/query-safety guards. Shared infra (token storage, OAuth state, redirect URIs, secrets) lives alongside the per-vendor files so every connector follows the same auth/storage lifecycle.

## The 5 files that matter and why

- **`baseConnector.ts`** — abstract base class every connector extends. Defines `authenticate()`, `getOAuthConfig()`, token-refresh-on-expiry, `healthCheck()`, `normalizeError()`, `getStatus()`. Read this first; it's the contract, not any one vendor file.
- **`mcpClient.ts`** — generic client for connectors that route through a vendor's MCP server (GitHub, etc.). Owns `initInflight` promise-coalescing so concurrent callers don't double-send `initialize` (fixed post audit 2026-06-08 connectors-core-1), and wires a 401-triggered `invalidateAccessTokenCache` callback so a revoked token isn't served from cache (2026-06-19 H3).
- **`mcpOAuth.ts`** — OAuth token exchange, refresh, and per-vendor config for MCP-backed connectors. Owns `safeOAuthErrorCode` usage at the exchange site — never surfaces the raw IdP response body.
- **`tokenStorage.ts`** — credential storage (macOS keychain via `security` CLI, encrypted-file fallback). Writes secrets via positional shell params, not full-JSON argv, and evicts stale keychain entries before falling back to file storage.
- **`github.ts`** — worked example of the MCP-router pattern: routes through `https://api.githubcopilot.com/mcp/`, wires HTTP routes for authorize/callback/test/delete, and re-exports legacy sync-looking functions (`listIssues`, etc.) now backed by async calls for yamlRunner compatibility. Use this as the template for new MCP-backed connectors; `slack.ts` is a comparable second reference.

## Invariants you must not break

- **SSRF guard**: any connector accepting a user-supplied host, URL, or self-hosted instance URL (Postgres, Redis, MongoDB, Elasticsearch, GitLab self-hosted, Jira/Confluence instance URLs, etc.) must call `isPrivateHost` / the URL-validation helpers in `../ssrfGuard.ts` before connecting. All four DB connectors were retrofitted for this (2026-06-19 H1) — new connectors must not regress it.
- **Never persist OAuth client secrets alongside stored tokens.** `_client_id` / `_client_secret` must not be written into the token file/keychain entry (Google Drive/Calendar/Docs and Gmail were fixed for this — see `docs/security/register.md` H2).
- **Sanitize token-exchange error bodies.** Never embed or echo the raw IdP response body/snippet in an error, log, or HTML page — use `safeOAuthErrorCode()` from `oauthError.ts` instead (fixed across Discord/Asana/GitLab/Monday/GoogleDocs/mcpOAuth.ts, 2026-06-09/06-08).
- Full history and status of these and other connector-security fixes: `docs/security/register.md`. Env var / OAuth-app-override reference: root `CLAUDE.md` "Connector credential env vars" table and "OAuth 2.0 Mode" section. Scope/rollout rationale: `docs/adr/0008-connector-scope-decision.md`.

## How to test it

Tests live in `src/connectors/__tests__/`, one file per connector plus shared-infra tests (`baseConnector.test.ts`, `baseConnector.security.test.ts`, `baseConnector.refreshRace.test.ts`, `connector-ssrf-guard.test.ts`, `connectorTokenLeak.redaction.test.ts`, `connectorRedirectUri.test.ts`). Run the whole subsystem with:

```bash
npx vitest run src/connectors/
```

or a single connector: `npx vitest run src/connectors/__tests__/github.test.ts`. New connectors need their own test file following the existing naming convention, plus SSRF/token-leak coverage if they accept user-supplied hosts or handle OAuth exchange.
