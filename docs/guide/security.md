# Security

The operator-facing view: what protects a running bridge, what you must do yourself when you expose it, and where to report a problem. The design-level view — what the system is built to resist and what it deliberately is not — is [THREAT-MODEL.md](../../THREAT-MODEL.md); the policy and supported channels are in [SECURITY.md](../../SECURITY.md).

## The bridge token

Every bridge generates a random UUID at start and writes it to its lock file, `~/.claude/ide/<port>.lock`, created with `O_EXCL` and mode `0o600`. Every client — Claude Code over WebSocket, the shim, the dashboard, remote MCP clients over HTTP — must present it, and comparisons are constant-time. `patchwork print-token` reads it for you.

The token rotates on every restart unless you start with `--fixed-token <uuid>` (or `CLAUDE_IDE_BRIDGE_TOKEN`). Rotation is the safe default on a laptop; a fixed token is what a dashboard or an external client that cannot re-read the lock file needs. Treat a fixed token as a credential: never commit it, never put it in a plist in clear when a config file will do.

Preserve the lock file's permissions. Anything that can read it can call every tool the bridge exposes.

## Loopback by default, and why that is a defence

The bridge binds `127.0.0.1`. It also rejects any request whose `Host` header is not a loopback address, which defeats DNS-rebinding: a hostile web page cannot make your browser talk to the bridge by resolving a public name to `127.0.0.1`. Keep both unless you have a reason not to.

## Exposing the bridge beyond localhost

`--bind 0.0.0.0` (or `BRIDGE_BIND_ADDRESS`) makes the bridge listen on every interface. **On its own that is not a deployment.** It must sit behind a TLS-terminating reverse proxy (nginx or Caddy), and remote MCP clients then authenticate with OAuth 2.0 rather than a shared token. The supported path is in [remote-access.md](../remote-access.md), with templates and scripts under [deploy/](../../deploy/README.md); network restriction options are in [ip-allowlist.md](../ip-allowlist.md).

When behind a proxy, set `CLAUDE_IDE_BRIDGE_TRUST_PROXY` so rate limits and lockouts key on the real client address, and never set it when there is no proxy, or any client can forge its address.

The `--vps` and `--db` flags widen the command allowlist that `runCommand` enforces (to `curl`, `systemctl`, `docker`, `psql` and so on). Tools such as git hooks, `npm run` and Docker Compose execute project-controlled code by design, so do not point a widened bridge at a workspace you do not trust.

## OAuth 2.0 mode

Starting with `--issuer-url <public-https-url>` turns on an OAuth 2.0 authorisation server for remote connectors (claude.ai, Codex, Gemini CLI and similar). PKCE is mandatory, authorisation codes are single-use with a five-minute life, access tokens are opaque with a 24-hour life and there are no refresh tokens, so a client re-authorises daily. The bridge token is the resource-owner credential entered on the approval page. An HTTP session is bound to the hash of the bearer that initialised it; a different bearer on the same session is refused. `--cors-origin` (repeatable) or `CLAUDE_IDE_BRIDGE_CORS_ORIGINS` sets the origins allowed to call it.

Never commit an issuer URL, a CORS origin or a fixed token: they identify a deployment. The connectors the bridge itself dials out to (GitHub, Gmail and so on) do use refresh tokens, stored under `~/.patchwork/tokens/` or in the keychain; what each one can do with its grant is in [connector-scopes.md](../connector-scopes.md).

## Webhooks

`POST /hooks/<name>` fires a webhook-triggered recipe. Two authentication paths are accepted: the bearer token, or — when the bridge was started with `--webhook-secret <hex>` (at least 32 hex characters, or `BRIDGE_WEBHOOK_SECRET`) — an `X-Hub-Signature-256: sha256=<hmac>` header computed over the raw body, compared in constant time. HMAC is additive, so bearer access keeps working. A request that presents a signature when no secret is configured is refused with `webhook_secret_not_configured` rather than silently accepted. Webhook payloads are untrusted input; under `governed` connector-derived content is wrapped as untrusted in any prompt it reaches.

## Outbound requests and SSRF

One guard covers every outbound HTTP call the bridge or a recipe makes: private, loopback and link-local ranges are refused (including unusual IPv4 spellings and IPv4-mapped IPv6), DNS is resolved once and pinned, and redirects are re-validated per hop with credentials dropped across origins. `--allow-private-http` relaxes this for a bridge that legitimately runs beside the services it calls; `--automation-allow-private-webhooks` and `--push-service-allow-private` do the same for those two paths. Each is a deliberate widening — note it in your deployment record.

## Dashboard authentication

Set both `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET` (random, at least 32 bytes) before the dashboard is reachable from anywhere but your own machine. The password mints a signed, stateless session cookie. Changing the password does **not** end existing sessions — rotate the session secret to do that. `DASHBOARD_ALLOW_UNAUTHENTICATED=1` exists for local development and nothing else. Failed logins are rate-limited and locked out, keyed on the trusted client address; the `DASHBOARD_AUTH_*` variables tune the windows.

The shared password produces an **unattributed** (v1) session. A member of the workspace roster who sets their own credential —

```bash
patchwork members set-password <memberId>
```

— logs in to an **attributed** (v2) session that names them, and only such a session can approve a gated action, because an approval needs a subject to record. The roster lives in `members.json`; `patchwork members` lists who holds a credential. The design is in [ADR-0020](../adr/0020-per-member-authentication.md).

## Secrets in the ledgers

Values registered as secrets — declared `env` blocks, connector tokens, the bridge bearer — are redacted **by value** from the run log, approval queue, activity log and decision traces, including URL-encoded, base64 and JSON-escaped forms. Orchestrator prompts persist as a hash, a preview and ciphertext, never clear text. Boundary receipts carry no payload field at all. None of that makes the ledgers public: they still hold real task titles and third-party record ids, which is why every reader that prints rows is marked as operator data in the [CLI reference](cli.md).

## Telemetry

Off by default. Nothing is sent unless you opt in with `--analytics on` or the dashboard toggle, and then only aggregate counts and latencies — never paths, prompts, file contents, arguments or anything under `~/.patchwork`. `patchwork analytics show` prints the active endpoint and its source; `patchwork analytics configure` points it at your own collector with a shared secret, kept in a mode-0600 config file rather than an environment variable in a plist. The full statement is in [privacy-policy.md](../privacy-policy.md).

## Hardening checklist

- Pin an exact `patchwork-os` version when reproducibility matters; the `canary` channel is untriaged.
- Keep `~/.claude/ide/*.lock` at mode `0o600` and `~/.patchwork/tokens/` out of any unencrypted backup.
- Use `patchwork init` on a new machine so the install starts `governed`; on an existing one, `patchwork profile governed` and a restart. Confirm with `patchwork doctor --require-governed`.
- Behind a proxy: TLS, OAuth mode, `CLAUDE_IDE_BRIDGE_TRUST_PROXY`, and an IP allowlist if the client set is known.
- Set `--webhook-secret` on any bridge that accepts webhooks from the internet.
- Plugins: under `governed` only entries in `config.plugins.allow` load; set `integrity` on each so a replaced entrypoint is refused.
- Run `patchwork evidence verify` after any restore and on a schedule; it is the only check that can tell a ledger edited after the fact from one that was quiet.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting from the repository's [Security tab](https://github.com/Oolab-labs/patchwork-os/security) — the process, response times and scope are in [SECURITY.md](../../SECURITY.md). A finding whose disclosure is itself the harm (where confidential material is, or was) belongs there and nowhere public.

## Published advisories

Advisories are published at <https://github.com/Oolab-labs/patchwork-os/security/advisories>. Current entries:

| Advisory | Fixed in |
|---|---|
| GHSA-5vg2-m59m-6v26 — an empty `X-Hub-Signature-256` header bypassed both the bearer gate and HMAC verification on `POST /hooks/*` | 1.2.0-beta.3 |
| GHSA-888g-53g6-4874 — recipe execution did not bind to the specific action a human had approved | 1.2.0-beta.3 |

Each advisory names the affected versions and the fixed release; the [CHANGELOG](../../CHANGELOG.md) entry for the fixing version links back to it.
