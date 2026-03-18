# Changelog

All notable changes to claude-ide-bridge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2.4.0] — 2026-03-18

### Added
- **OAuth 2.0 Authorization Server** (`src/oauth.ts`) — full RFC 6749 authorization code grant with PKCE (S256), RFC 8414 discovery metadata, and RFC 7009 token revocation. Enables authenticated remote MCP server registration on claude.ai.
  - `GET /.well-known/oauth-authorization-server` — RFC 8414 discovery document
  - `GET /oauth/authorize` — approval page (requires bridge token to initiate)
  - `POST /oauth/authorize` — form submission; issues single-use auth codes (5 min TTL)
  - `POST /oauth/token` — exchanges code + PKCE verifier for access token (1 h TTL)
  - `POST /oauth/revoke` — RFC 7009 token revocation
  - Backward-compatible: existing static bearer tokens continue to work
- `--issuer-url <url>` CLI flag and `CLAUDE_IDE_BRIDGE_ISSUER_URL` env var to set the OAuth issuer URL
- `docs/privacy-policy.md` — privacy policy for the plugin marketplace submission
- `docs/ip-allowlist.md` — network access and IP allowlist documentation for self-hosters
- `claude-ide-bridge-plugin/examples/` — three working example walkthroughs for the plugin directory listing:
  - `01-debug-failing-test.md`
  - `02-review-pull-request.md`
  - `03-refactor-with-lsp.md`

### Changed
- Safety annotations: `setHandoffNote` now declares `destructiveHint: true, idempotentHint: true`; `getHandoffNote` declares `readOnlyHint: true`

### Tests
- 23 new tests for `OAuthServerImpl` covering discovery, authorize GET/POST, token issuance, PKCE verification, code reuse rejection, revocation, and `resolveBearerToken`

---

## [2.3.0] — 2026-03-01

### Fixed (SSH remote issues)
- `runInTerminal` subprocess fallback for SSH remotes
- LSP cold-start retry with 0→4→8s exponential backoff
- Probe detects `tsc`, `biome`, `rg` via `node_modules/.bin`
- `searchAndReplace` glob normalisation (`*.ts` → `**/*.ts`)
- `closeTab` `realpathSync` fix
- `captureScreenshot` headless error message

### Added
- `@vscode/ripgrep` dependency with postinstall symlink
- `smoke-test-v2.mjs` regression gate (26 PASS / 0 FAIL baseline)
- Extension v1.0.9

### Tests
- 1237 unit tests across 101 test files
