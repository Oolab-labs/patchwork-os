# Threat model

Patchwork OS runs agents that hold your credentials and can act on your behalf.
This document states what it is designed to resist, what it is not, and where
the honest gaps are.

**It is deliberately not reassuring.** A threat model that finds everything
mitigated is not credible, and a reviewer will discount the whole document on
seeing it. Every section below ends with residual risk, and several of those are
real. Where a mitigation is partial, it says partial.

Scope: the single-workspace product in this repository — bridge, runtime,
recipes, workers, connectors, dashboard, IDE extensions, plugin loader, and the
push relay in `services/push-relay/`. Organisation-scale concerns (SSO, policy
inheritance, off-site evidence) are out of scope because they are not built; see
[LICENSING.md](LICENSING.md).

Related: [SECURITY.md](SECURITY.md) (reporting, supported versions),
[docs/privacy-policy.md](docs/privacy-policy.md) (data handling),
[docs/push-relay-data-flow.md](docs/push-relay-data-flow.md) (the phone path in
full).

---

## The trust model in one paragraph

Everything runs as **you**, on **your** machine, with **your** credentials. There
is no privilege boundary between the bridge and your user account: a process
running as your user can read the same files the bridge can. The security
properties this system provides are therefore not about containment from
yourself — they are about **stopping an agent from doing something consequential
without you seeing it first**, and about **leaving a record when it does**. Read
every mitigation below with that framing.

---

## T1 — Prompt injection reaching a worker with write-capable connectors

**Threat.** An agent reads attacker-controlled text — an email, an issue
comment, a PR description, a Slack message, a web page — containing instructions.
The agent treats them as instructions. It then calls a write-capable connector:
files an issue, pushes a branch, sends a message, charges a card. This is OWASP
ASI06 territory, and its defining property is temporal decoupling: the payload is
planted now and acted on later, invisibly, in a session that looks normal.

**Mitigations.**

- **Reversibility gate, not a content filter.** `decideWorkerAction`
  (`src/workers/workerGate.ts`) classifies every tool call by action class.
  Reversible actions flow; compensable ones need earned L2; irreversible ones
  need L4 or a human. Injection that produces a *risky* action hits the approval
  queue regardless of how convincing the text was. This is the load-bearing
  control, because it does not depend on detecting the injection.
- **Forbid rules** (`src/workers/forbidPolicy.ts`) are evaluated **first** —
  before the agent carve-out, before reversibility, before any trust maths — so
  no branch can route around them. A forbidden action is refused outright; no
  human approval unlocks it (ADR-0017).
- **Agent-step sandbox.** `disallowedToolsForAgentStep` re-applies the gate to
  the subprocess: every tool the worker cannot currently run autonomously is
  added to `--disallowed-tools`, in both bare and `mcp__patchwork__` forms.
  Without this, an agent could do *inside* its reasoning step exactly what the
  gate would have queued.
- **Provenance ceilings on memory.** Butler's fact store
  (`src/butler/types.ts`) caps connector-derived text at trust 0.3 —
  *strictly below* the 0.6 originate threshold — so text the agent merely *read*
  cannot establish a durable belief. Promotion requires a human act.
- **Kill switch.** `patchwork panic` disables writes globally (ADR-0013).

**Residual risk — significant.**

- **Reversible actions are not gated at all.** An injection that stays inside
  reversible territory — writing files, local commits, reading widely — executes
  without asking. That is a deliberate trade (a worker that halts on everything
  is unusable), but it means injection *can* act; it just cannot act
  irreversibly without a human.
- **The queue depends on the human reading it.** Approval fatigue is a real
  attack path: bury the malicious request in a run of routine ones. Nothing in
  the product measures or resists that.
- **The summary a human approves is agent-influenced.** The approval card shows
  a summary derived from the step. A sufficiently clever injection can shape how
  its own request is described. There is no independent rendering of intent.
- **No injection detection exists.** There is no classifier, no delimiter
  discipline enforced across connectors, no provenance tainting *through* an
  agent step. The design bet is entirely on the gate.

---

## T2 — Credential and token storage on disk

**Threat.** Connector OAuth tokens, API keys and the bridge auth token are read
from disk by malware, a backup, a sync client, a crash dump, or another user on
a shared machine.

**Mitigations.**

- **OS keychain by default.** `src/connectors/tokenStorage.ts` uses macOS
  Keychain, Windows DPAPI, or Linux Secret Service. `PATCHWORK_TOKEN_STORAGE_BACKEND=native`
  makes that mandatory and **fails loudly** rather than silently falling back —
  a stale-keychain-vs-fresh-file split was fixed deliberately (audit 2026-06-03).
- **Encrypted-file fallback.** AES-256-GCM, atomic write via temp+rename, mode
  `0o600`, directory `0o700`, key file created with `O_EXCL`.
- **Bridge auth token** lives in `~/.claude/ide/<port>.lock`, mode `0o600`,
  created with `O_EXCL` to defeat symlink races (ADR-0003), compared with
  `timingSafeEqual`.
- **OAuth tokens issued *by* the bridge are stored as hashes, never raw.**
  `persistTokens` (`src/oauth.ts:911`) writes `SHA-256(token) → {clientId,
  scope, expiresAt}` through the same keychain/encrypted-file layer as
  connector credentials, so a client survives a restart without
  re-authorising and the token cannot be recovered from the record. Auth
  codes are memory-only, 5 min, single-use.
- **Secrets are stripped from logs.** `logErrorSafe` in the relay redacts PEM
  blocks and long base64 runs; connector `client_secret` values were removed
  from stored token payloads (audit 2026-06-19, H2).

**Residual risk — the file fallback is weaker than it sounds.**

- **On the file backend, the encryption key sits in the same directory as the
  ciphertext** (`tokenStorage.ts:331`, mode `0o600`). This defends against a
  *partial* exfiltration — a single file copied out, a selective backup, another
  user on the box — and against nothing else. Any process running as your user
  can read both halves. "Encrypted at rest" here does not mean what it means on
  a server with a KMS.
- **Anything running as you has your tokens.** No mitigation in this repository
  changes that, including the keychain path, since the bridge can read the
  keychain by definition.
- **`PATCHWORK_HOME` splits your data across two directories** (see the privacy
  policy) — a backup scoped to one may silently miss credentials in the other,
  or capture them unexpectedly.

---

## T3 — Connector token scope and blast radius on compromise

**Threat.** One connector token leaks. What can be done with it, and is the
damage bounded?

**Mitigations.**

- **Per-connector isolation.** Each connector holds its own token under its own
  storage key; there is no shared credential and no cross-connector escalation
  path in the token store.
- **Revocation on disconnect.** Google connectors revoke the *refresh* token,
  not just the access token, so disconnecting kills the grant rather than one
  short-lived credential (audit 2026-06-19, M3).
- **401 handling invalidates the cache** before retry, so a revoked token is not
  replayed (H3).
- **Writes are gated regardless of token power.** A token with broad scope still
  passes through the action-class gate on the way out.
- **SSRF guards** on `sendHttpRequest` and the DB connectors block private and
  reserved ranges with DNS re-resolution, so a connector cannot be aimed at
  cloud metadata endpoints (H1).

**Residual risk — scopes are the connector's, not ours.**

- **This project does not narrow OAuth scopes.** Scope is whatever the provider's
  app requests at consent time. If the Gmail app asks for broad access, a leaked
  token has broad access. There is no per-recipe or per-worker scope narrowing,
  and no down-scoped token exchange.
- **No scope inventory is published.** A reviewer asking "what can the GitHub
  connector do with my account?" has to read the connector source. That is a
  documentation gap, not a code one.
- **PAT-style connectors** (Jira, Notion, Datadog, Linear, PagerDuty, …) take a
  user-supplied token whose scope the user chose. Bounding it is entirely on the
  user, and nothing warns when a token is over-scoped.
- **Blast radius is per-connector, but a worker may hold several.** A recipe with
  GitHub + Slack + Gmail can chain them; the gate sees each call individually and
  has no notion of a multi-step exfiltration pattern.

> `TODO(owner):` publish a scope inventory — for each OAuth connector, the scopes
> requested and what they permit. This is the single most-asked security-review
> question about a connector product.

---

## T4 — Gaming the worker autonomy ramp

**Threat.** A worker accumulates a track record on cheap, safe actions and
converts it into permission to do something dangerous — either through a design
flaw, or through an attacker deliberately farming successes.

**Mitigations.**

- **Trust is per `(worker × action-class)`, never global.** Competence on
  `issue:compensable:high` confers nothing on `vcs-push:*`. This is the core
  defence and it is structural, not a heuristic.
- **Blast-weighted outcomes.** `outcomeWeight` makes one high-blast failure
  outweigh many trivial successes, so farming low-value successes is a poor
  investment.
- **Magnitude bands in the class key.** `payments:irreversible:high:band<=50`
  and `band>500` are *different cells*. €5 and €5,000 no longer share trust.
  An unreadable amount bands as the **widest** bucket, so a malformed parameter
  cannot reach the cheap cell.
- **Ceilings only descend.** `effectiveLevel = min(earned, autonomyCeiling,
  contextCeiling)`. Live context-risk can lower autonomy; nothing raises it. An
  operator's `autonomyCeiling` is absolute.
- **Unknown outcomes are withheld, not counted good.** Fixed in #1064 — the
  original behaviour folded "we never found out" into success, which is
  trust-by-neglect. A rejected filing demotes **immediately** (#1072).
- **Standing permissions do not feed the ramp.** A pre-recorded human approval
  converts a queued action to flow at `resolveGateOutcome` — it never touches
  earned trust, precisely so a human's advance consent cannot become evidence
  the *worker* is reliable.
- **Every decision is recorded** with policy version and inputs, replayable via
  `patchwork gate explain` and `workers backtest`.

**Residual risk — the grader is the weak point.**

- **Not every domain has an outcome grader.** The shipped
  `butler-errands.worker.yaml` says so in its own manifest: nothing observes
  whether a created task was useful or junk, so on that path a success would
  fold `good:true` past the durability window on no evidence — the same
  trust-by-neglect closed for issues, still open here. The mitigation is a
  hard `autonomyCeiling: 1`, i.e. **the ceiling is doing the work the evidence
  cannot.** That is honest, and it is also a standing invitation to get it wrong
  by raising a ceiling before a grader exists.
- **Confirmation is a human act that can be automated away.** `outcomes confirm`
  is deliberately not a recipe step so a worker cannot self-confirm — but a user
  who scripts confirmations, or clicks through them, reintroduces the leak.
- **A nested recipe runs under its parent's gate** and its evidence is
  attributed to the parent (documented in the worker templates). A worker only
  earns its own dial when its recipe is the top-level run.
- **Cold-start priors are operator-set.** `competence: {mean, strength}` in a
  manifest is an assertion, not evidence. A generous prior is a legitimate
  configuration and also a way to start with unearned trust.

---

## T5 — The MCP tool surface (180 tools)

**Threat.** The bridge exposes 180 tools to whatever model is connected. Any of
them is reachable by a compromised or manipulated agent; some run commands,
write files, or reach the network.

**Mitigations.**

- **Schema validation at the transport layer.** AJV validates every tool
  argument before execution; failed validation does not consume rate-limit
  budget.
- **Command allowlist.** `runCommand` executes only allowlisted commands.
  Interpreter commands (node, python, bash…) are permanently barred from
  `--allow-command`. Argument splitting blocks `--flag=value` injection, and
  `--node-options` is blocked for npm/yarn/pnpm because it smuggles V8 flags
  past the interpreter guard (H10).
- **Path traversal defence.** `resolveFilePath` rejects null bytes, walks the
  ancestor chain for symlink escapes, and refuses paths outside the workspace.
- **Rate limits.** 200 requests/min, 500 notifications/min, per-session tool
  bucket (default 60/min).
- **Transport hardening.** Loopback binding by default; Host-header check
  against DNS rebinding; timing-safe token comparison; session binding to a
  bearer-token hash in OAuth mode.
- **Risk tiers + approval gate** sit in front of the dangerous subset.

**Residual risk.**

- **The surface is large and grows.** 180 tools is a lot to keep individually
  audited, and the count trends upward. The `audit-lsp-tools` and schema
  breaking-change gates enforce *shape*, not *safety*.
- **The allowlist is the security boundary for shell access, and allowlists
  rot.** A permitted command that gains a new flag with interpreter semantics
  reopens the hole — which is exactly what `--node-options` was.
- **Plugins run in-process** with the bridge's full privileges. The manifest
  capability allowlist is *intentionally empty* pending per-capability
  enforcement (stated in SECURITY.md), so installing a plugin is equivalent to
  running its code as you. There is no plugin sandbox.
- **Reads are ungated by design.** Approval gates writes. An agent that can read
  every file in the workspace and reach the network through an allowlisted
  connector has an exfiltration path that never touches the queue.

---

## T6 — The push relay path

**Threat.** Enabling mobile approvals moves approval metadata off the machine
and introduces a third party that could read or answer approvals.

Documented in full in
[docs/push-relay-data-flow.md](docs/push-relay-data-flow.md); summarised here.

**Mitigations.** Off by default. HTTPS-only egress with SSRF guard. Bearer auth
with HMAC-then-`timingSafeEqual` and no plaintext token at rest. Single-use
replay defence keyed on `(callId, approvalToken)`, failing closed at capacity.
Expiry clamped to ≤15 min. 16 KB body cap. Rate limits after the auth gate.
Device cap with oldest-eviction. `approvalToken` never placed in a URL. Risk
signals dropped at the relay. **The approve/reject decision never travels
through the relay** — the phone posts directly to your bridge.

**Residual risk — stated plainly because the shape invites the wrong assumption.**

- **The relay can read approval contents.** The `summary` is plaintext; there is
  no end-to-end encryption.
- **A compromised relay could answer one queued approval in your place.** It
  holds a valid single-use token and the callback base. Bounded to one action,
  once, on an approval your gate already raised — but real.
- **Apple and Google see the approval token**, along with the body. Keeping it
  out of the URL protects against logs and referrers, not against the push
  provider.
- **Redis device registrations have no TTL** — indefinite until removed or
  evicted by the 10-device cap.
- **Known gap:** the standalone relay never dismisses a cancelled approval
  (verified: a `{kind:"cancel"}` body returns `400`), so a stale card can sit on
  a lock screen. Fails safe — the token is already dead — but it is a divergence
  from the dashboard relay, which handles it.

---

## T7 — Supply chain

**Threat.** A malicious or compromised dependency executes at install time or
runtime with your credentials in reach. The npm ecosystem's install scripts make
this a first-class risk, not a theoretical one.

**Mitigations.**

- **Small direct surface.** 12 runtime and 12 dev direct dependencies at the
  root — modest for a project this size, which materially limits first-order
  exposure.
- **Lockfiles committed**, so builds are reproducible.
- **Transitive pinning via `overrides`** (`esbuild`, `postcss` at the root;
  `@tootallnate/once`, `uuid`, `protobufjs` and others in the relay) — used to
  force fixed versions above known advisories rather than waiting for upstream.
- **Dependabot is active** — 31 automated dependency commits in the last three
  months.
- **CodeQL** runs on pull requests (javascript-typescript, java-kotlin, actions).
- **Publishing** goes through GitHub Actions with OIDC where supported.

**Residual risk — the gaps here are concrete.**

- **The CVE gate covers production dependencies only.** A known advisory in
  the dev tree does not fail the build — deliberately (see below) — so
  test-tooling exposure is caught only when Dependabot opens a PR, which is
  *after* merge and on Dependabot's schedule.
- **Dependabot's configuration is not in the repository.** There is no
  `.github/dependabot.yml` — it is configured through repository settings. So the
  policy is not reviewable in the diff, not reproducible on a fork, and cannot be
  changed by a pull request.
- **Install scripts are not disabled.** Nothing sets `ignore-scripts`, so a
  compromised transitive package runs code at install time on every developer
  and CI machine.
- **No provenance or signature verification** on installed packages, and no SBOM
  is published.
- **The vendoring path is manual.** `patchwork-multitenant` copies this repo's
  `src/` verbatim into its tenant image; there is no automated check that the
  copy matches, so a fix here can silently fail to reach the image.

**Since writing the above, a CVE gate was added** — `npm audit --omit=dev
--audit-level=high`, scoped to production dependencies because that is what
ships to a consumer of the npm package. It is green today (0 vulnerabilities
in the shipped tree).

The dev tree is not clean and that is stated rather than hidden: at time of
writing `vitest → vite → postcss → nanoid` carries one high advisory
(GHSA-2v37-7h3g-55p8, nanoid <3.3.17; the lockfile pins 3.3.16). It is test
tooling, not shipped code. Gating on it would put this build at the mercy of
another project's release schedule, which is how a gate becomes something
people route around.

> `TODO(owner):` whether to commit `.github/dependabot.yml` so the dependency
> policy is reviewable in a diff and reproducible on a fork. It is currently
> configured through repository settings, so nobody can see or change it via
> a pull request.

---

## What is deliberately not defended

Stated so a reviewer does not have to infer it:

- **A malicious operator.** Everything runs with your authority by design.
- **A compromised host.** If your machine is owned, so is the bridge.
- **A malicious model provider.** The model sees whatever context you send.
- **A malicious plugin.** Plugins run in-process, unsandboxed.
- **Denial of service.** Rate limits exist to protect correctness and cost, not
  to survive a determined attacker.
- **Multi-user separation.** There is none. The identity roster
  (`src/identity/`) exists so decisions can *name* a person, and is explicitly
  **not wired to authorisation** — nothing consults it to permit or refuse a
  request, and `canApproveAction` is referenced by no production code. Per-member
  authentication is decided but unbuilt (ADR-0020).

---

## Reporting

Vulnerability reports: see [SECURITY.md](SECURITY.md). Please use GitHub private
vulnerability reporting rather than a public issue.
