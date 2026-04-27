# Recipe Authoring DX + Curated Provider Wave 2 — Agent Plan

**Goal (M4.5):** Make authoring a recipe feel as good as authoring a shell script — fast feedback, strong types, rich editor support, visual debugging — and extend the curated provider set to cover the next tier of high-leverage SaaS.

**Goal (M5):** Turn recipes from "local YAML files" into a **community distribution loop** — install/update flow, provenance, safe discovery, and a lightweight publishing path that validates demand before a custom registry or monetization stack.

**Wave 2 providers:** Confluence, Zendesk, Intercom, HubSpot, Datadog, Stripe (read-only)
**Prioritization:** Fills customer gaps after Wave 1 (Jira/Notion/PagerDuty/Drive/Docs) — support surfaces (Zendesk/Intercom), knowledge surfaces (Confluence), CRM/revenue surfaces (HubSpot), ops (Datadog), and billing visibility (Stripe, but read-only until a separate financial-actions milestone hardens compliance and audit controls).

Produced as companion to [`recipe-chaining-wave1-plan.md`](./recipe-chaining-wave1-plan.md). Tracks v0.2.0-alpha.33 state (2026-04-27).

---

## Context

### What shipped in Wave 1

- **Chaining engine** (`src/recipes/chainedRunner.ts`, `templateEngine.ts`, `dependencyGraph.ts`, `outputRegistry.ts`, `nestedRecipeStep.ts`) — outputs-as-inputs, `when:` conditions, recipe-as-step, dependency graph with parallel execution.
- **BaseConnector** (`src/connectors/baseConnector.ts`) — shared auth/retry/rate-limit primitives.
- **Jira connector** (`src/connectors/jira.ts`) — first Wave 1 provider landed; Notion/PagerDuty/Drive/Docs follow in the same pattern.
- **Mobile oversight** — phone-path auth + push dispatch for approval-gated steps.

### What already landed toward 4.5

- **Generated recipe schema** — `src/recipes/schemaGenerator.ts` now covers chained recipes, nested recipe steps, legacy-normalized trigger fields, and chained-step metadata such as `id`, `awaits`, `when`, `optional`, and `risk`.
- **Schema-aware lint path** — `src/commands/recipe.ts` now recognizes `trigger.type: chained`, validates nested recipe steps and template refs, and recursively validates bundled examples under schema lint.
- **Command-layer authoring loop** — `patchwork recipe new`, `lint`, `test`, `record`, `fmt`, `run --dry-run`, `run --step`, `watch`, and `preflight [--watch]` already exist in `src/commands/recipe.ts`.
- **Fixture-based local test/record flow** — `recipe test` and `recipe record` now run through `yamlRunner` dependency injection rather than connector-specific special cases.
- **Hot reload semantics** — `patchwork recipe watch` already reruns on save, debounces changes, and queues exactly one follow-up run while preserving the in-flight run.
- **Chained example coverage** — bundled chained examples now exercise dry-plan ordering, nested recipe flow, `when`, `optional`, `risk`, `parallelGroups`, and `maxDepth`.
- **`isConnector` on `ToolMetadata`** — tool registry entries now carry `isConnector?: boolean`; all connector-backed tools are flagged. Dry-run plan, schema generation, and dashboard consumers use this to distinguish connector calls from pure-compute steps.
- **Stable `DryRunPlan` JSON contract** (`schemaVersion: 1`) — fields `risk`, `isWrite`, `isConnector`, `resolvedParams`, `parallelGroups`, `dependencies`, `maxDepth` are stable for external consumption. Schema served at `GET /schemas/dry-run-plan.v1.json`.
- **Schema HTTP serving** (`GET /schemas/*`) — bridge serves generated schemas unauthenticated. YAML-LSP editors can point `$schema` at `http://localhost:<port>/schemas/recipe.v1.json` for live autocomplete against the registered tool set. Index at `GET /schemas/`.
- **`patchwork recipe preflight [--watch]`** — validates a recipe against the live registry without executing; exits 0/1 for CI; `--watch` reruns on save for live editor feedback. `runPreflightWatch` exported as library fn.
- ✅ **Notion connector** (alpha.23) — Wave 2 provider #1. `notion.queryDatabase`, `notion.getPage`, `notion.search`, `notion.createPage`, `notion.appendBlock`. Token-paste auth via dashboard modal. HTTP routes under `/connections/notion/*`.
- ✅ **`expect` block runtime assertions** (alpha.23) — `evaluateExpect()` pure fn, four assertion types, persisted to run log, surfaced in dashboard assertion failures panel.
- ✅ **`patchwork recipe test --watch`** (alpha.23) — `runTestWatch` exported; same debounce/requeue semantics as `preflight --watch`. Completes two-thirds of the watch-mode trilogy.
- ✅ **`into` chaining validation** (alpha.23) — builtin shadow error, duplicate key warning, chained-agent `into` false-positive bug fixed.
- ✅ **Dashboard assertion failures** (alpha.23) — `/runs/[seq]` panel + `/runs` list badge + expanded-row bullet list.
- ✅ **`patchwork recipe fmt --watch`** (alpha.24) — completes the watch-mode trilogy. `runFmtWatch` exported. All three authoring subcommands (`preflight`, `test`, `fmt`) now have `--watch` and an exported library fn.
- ✅ **Confluence connector** (alpha.25) — Wave 2 provider #2. `confluence.getPage`, `confluence.search`, `confluence.createPage`, `confluence.appendToPage`, `confluence.listSpaces`. API-token + email Basic auth. HTTP routes under `/connections/confluence/*`. Completes Atlassian trifecta (Jira → Notion → Confluence).
- ✅ **`onRecipeSave` automation hook** (alpha.25) — fires on `.yaml`/`.yml` save; default prompt runs preflight automatically; wired through full automation DSL (HookType, parser, interpreter, validator, status).

### What's still missing for 4.5 (Authoring DX)

1. **Editor-distribution story is partial** — `$schema` header + local bridge resolve in dev; SchemaStore publication needed for offline/non-bridge editors. PR body drafted at [docs/recipe-schemastore-pr.md](./recipe-schemastore-pr.md). Hover-quality descriptions on tool params not yet driven from `ToolMetadata`.
2. **Registry consolidation is near-complete but not done** — `isConnector` + `isWrite` now on `ToolMetadata`; dashboard docs and input/output JSON schemas per tool step still manually maintained.
3. **Scaffolding is basic, not polished** — `patchwork recipe new` exists with `$schema` header, but connector-aware interactive prompting described in this milestone is not yet built.
4. **Local test harness deepened but not complete** — `recipe test` now evaluates `expect` block assertions at runtime (`evaluateExpect`), surfaces structured `AssertionFailure[]`, and has `--watch` mode. Per-provider fixture breadth still needs work.
5. ✅ **Dashboard run timeline** — `/runs/[seq]` step-timeline + dry-run plan tab shipped (alpha.22). Assertion failures panel shipped (alpha.23).

### What's missing for 5 (Ecosystem)

1. **No public registry** — recipes live in `~/.patchwork/recipes/` or `examples/recipes/`. No way to install `@acme/pr-triage`.
2. **No versioning / install** — can't pin recipe versions; no `patchwork recipe install` beyond local file copy.
3. **No provenance** — no signing, no author identity, no way to know if a recipe is safe.
4. **No social signal** — no stars, reviews, run-count, "recipes like this."
5. **No revenue path** — no mechanism for partners to charge for premium recipes.

---

## Milestone 4.5 — Authoring DX + Wave 2 Providers

### Agent A0 — Tool registry consolidation + connector foundation

**Owner:** Platform team

#### What to build

1. **Tool registry consolidation** (`src/recipes/toolRegistry.ts`)
   - Today: `src/recipes/toolRegistry.ts` exists, built-in tools self-register under `src/recipes/tools/*`, `src/recipes/yamlRunner.ts` dispatches through the registry, and `src/recipes/schemaGenerator.ts` already consumes registry metadata.
   - Next: finish moving remaining dry-run, authoring, and documentation consumers onto the same source of truth.
   - Target state: tool metadata lives in one place and drives runner dispatch, schema generation, dry-run mocking, and dashboard docs.

2. **OAuth 2.0 refresh primitives in `BaseConnector`**
   - Add standard refresh-token lifecycle handling before Wave 2 agents start.
   - Store refresh/access tokens in OS keychain via `keytar`, not plain JSON files.

3. **Feature flags + rollback hooks**
   - Every new surface ships behind `bridge.config.features.<featureName>`.
   - Default-off in alpha, opt-in in beta, default-on only after two weeks without P1 regressions.

4. **Global write-tier kill switch**
   - Replace connector-specific panic behavior with a bridge-wide kill switch for all write-tier tools.
   - Surface state in dashboard and CLI; do not require users to know about a lock-file convention.

#### Testing
- Unit: registry metadata matches executor coverage for every built-in tool.
- Integration: OAuth refresh path exercised against a sandbox provider before any Wave 2 connector merges.

---

### Agent A1 — Recipe JSON Schema + LSP-aware editor support

**Owner:** Platform + editor tooling team

#### What to build

1. **Composable JSON Schema set** ✅ *Shipped alpha.22* — `GET /schemas/recipe.v1.json`, `GET /schemas/tools/<ns>.json` served from bridge. Composable via `$ref`. Per-namespace tool schemas from registry.
   - **Still open:** publish to SchemaStore so offline/non-bridge editors get autocomplete. PR body drafted at [docs/recipe-schemastore-pr.md](./recipe-schemastore-pr.md).

2. **`yaml-language-server` metadata block** ✅ *Shipped* — `patchwork recipe new` writes `# yaml-language-server: $schema=https://patchwork.sh/schema/recipe.v1.json`. Local bridge URL also works in dev.

3. **Schema versioning** ✅ *Shipped alpha.33* — Recipes declare `apiVersion: patchwork.sh/v1`. Migration layer landed in `src/recipes/migrations/` (`types.ts`, `v1.ts`, `index.ts`) and is invoked from `normalizeRecipeForRuntime(...)` so every load path (yaml-runner load, lint, fmt) routes through it. Unversioned recipes are auto-stamped with a single deprecation warning; unknown future apiVersions pass through unchanged so schema lint enforces the enum. Future versions register additional `RecipeMigration` entries that chain `from` → `to`. Sibling schemas (`recipe.v2.json`, …) remain TODO.

4. **Output-schema-aware linting** ✅ *Shipped alpha.33* — `recipe lint` now validates dotted template references against the registered tool's `outputSchema` for prior steps. Refs to fields the runtime context-flattener does not expose (e.g. `{{saved.bogusField}}` when `file.write` only exposes `path` / `bytesWritten` / `.json`) emit a warning naming the offending tool and the allowed keys. Tools without a registered `outputSchema` continue to skip the check to avoid false positives.

#### Testing
- Schema validation unit tests: every `examples/recipes/**/*.yaml` must validate against generated schema.
- CI step: `patchwork recipe lint examples/recipes/` runs in GitHub Actions.

---

### Agent A2 — `patchwork recipe` CLI UX overhaul

**Owner:** CLI team

#### What to build

Current state before the remaining polish work:

- `patchwork recipe new` already scaffolds recipes from templates.
- `patchwork recipe lint`, `test`, `record`, `fmt`, `run --dry-run`, `run --step`, and `watch` already exist in `src/commands/recipe.ts`.
- CLI integration already covers local `recipe run` output and `recipe watch` rerun-on-save behavior.

Current commands and remaining polish targets in `src/commands/recipe.ts`:

 | Command | Behaviour |
 |---|---|
| `patchwork recipe new [name]` | Template-based scaffold today. Writes `~/.patchwork/recipes/<name>.yaml` + `$schema` header; interactive connector-aware prompting remains future polish. |
| `patchwork recipe lint <file>` | Validates against JSON Schema, checks template refs against available recipe context, and warns when dotted refs are not exposed by the upstream tool's registered `outputSchema`. Exit 1 on error. |
| `patchwork recipe test <file>` | Runs recipe against mock connectors (fixtures in `~/.patchwork/fixtures/`). No network. Asserts final output against optional `expect:` block. |
| `patchwork recipe run <file> --dry-run` | Already spec'd in Wave 1 — formalise output format (JSON execution plan). |
| `patchwork recipe run <file> --step <id>` | Run a single YAML step selected by `id`, `into`, or `tool`, with optional `--var KEY=VALUE` seed context for template rendering. |
| `patchwork recipe watch <file>` | Hot-reload. Re-runs on file save, debounced 300ms; if a run is already in flight, queue exactly one follow-up run with the newest file contents. |
| `patchwork recipe record <file>` | Runs a recipe against live connectors and records connector fixture libraries (default `~/.patchwork/fixtures/<provider>.json`, overrideable via `--fixtures`) for later `recipe test` replay. |
| `patchwork recipe fmt <file>` | YAML canonicaliser with consistent formatting and key order; comment preservation is not yet guaranteed. |

 **Hot reload semantics**
 - Saving during an active run never mutates that in-flight run.
 - One queued rerun maximum; subsequent saves collapse into the newest pending version.
- Cron/file-watch trigger registration updates only after the current run settles.

#### Testing
- Snapshot tests for each subcommand against fixture recipes.
- Integration: `new` → `lint` → `test` → `run --dry-run` pipeline passes on zero-input recipe.

---

### Agent A3 — Visual recipe debugger in dashboard

**Owner:** Dashboard team

#### What to build

Replace the current flat "Runs" row with a **step-timeline view** at `/runs/<seq>`:

1. **Timeline component** (`dashboard/src/app/runs/[seq]/page.tsx`)
   - Vertical list of steps, each collapsible.
   - Per step: status pill, duration, input (resolved template → concrete value), output (JSON tree), error (if any), agent prompt + model + token usage (if agent step), approval state (if gated).
   - Replay button per step (POST to `/api/recipes/replay-step` — re-runs one step with the registry from the original run).

2. **Registry diff view** — when a step's input contains a chain reference, show the upstream step ID highlighted and hoverable ("this came from `steps.fetch_issues.data.issues[0].id`").

3. **Live tail mode** — WebSocket to bridge pushes step status events as the run executes; UI fills in rows in realtime.

4. **Read-only timeline + explicit edit handoff**
   - Timeline view stays read-only.
   - "Open in editor" launches the recipe in the user's configured editor/CLI flow.
   - Rerun remains an explicit separate action; no inline draft editing on the run page.

#### Testing
- Playwright E2E: trigger a test recipe, assert timeline renders all steps, replay step produces new run.
- Visual regression snapshot on `/runs/[seq]` for a canonical fixture run.

---

### Agent A4 — Mock connector harness + fixture library

**Owner:** Connectors team

#### What to build

1. **`MockConnector` base** (`src/connectors/__mocks__/mockBase.ts`)
   - Extends `BaseConnector`; `apiCall()` reads from fixtures instead of network.
   - Fixture path convention: provider fixture libraries at `~/.patchwork/fixtures/<provider>.json`, with replay keyed by recorded `operation` + stable-rendered input.

2. **Fixture generation** — `patchwork recipe record <file> [--fixtures <dir>]` runs a recipe once against real connectors and captures each connector-backed tool call into its provider fixture library. Subsequent `patchwork recipe test <file>` runs replay those recorded inputs/outputs. (Model after `nock-record` / VCR.)

 3. **Per-connector fixtures** for every Wave 1 + Wave 2 provider — checked in, covering the happy path of every recipe tool each connector exposes.

 4. **Dry-run tool resolution** — in `--dry-run` and `recipe test`, `executeStep` dispatches to mock registry first. Connectors never instantiate real HTTP clients.

 5. **Mocked LLM execution for preview/test**
   - `recipe test` and future `recipe preview` never call a real model.
   - Agent steps run against canned responses so untrusted recipes cannot consume real API keys or attempt prompt-injection against the operator's environment.

#### Testing
- Round-trip: every existing connector test runs against fixtures and matches live-recorded payloads.
- Nightly CI: refresh sandbox fixtures, diff against checked-in versions, and open an issue automatically if drift exceeds threshold.

---

### Agent A5 — Curated provider Wave 2 (Confluence, Zendesk, Intercom, HubSpot, Datadog, Stripe)

**Owner:** Connectors team (one agent per connector pair)

Follows the exact Wave 1 pattern (`BaseConnector` extension, read/write tools, approval-gated writes, MCP evaluation, fixture set). Condensed:

| Provider | Pair | Auth | Recipe leverage | Approval-gated writes |
|---|---|---|---|---|
| **Confluence** | Bundles with Jira (Atlassian OAuth) | Reuse Jira auth | Docs/ADR/runbook → Linear/Jira; search org wiki | `confluence.create_page`, `update_page` |
| **Zendesk** | With Intercom | OAuth 2.0 / API token | Support ticket → engineering issue; tag/prioritise | `zendesk.update_ticket`, `add_comment` |
| **Intercom** | With Zendesk | OAuth 2.0 | Conversations → issues; draft replies | `intercom.send_reply`, `close_conversation` |
| **HubSpot** | Solo | OAuth 2.0 / private app token | CRM events → Slack/Jira; lead qualification; revenue-adjacent workflows | `hubspot.create_note`, `update_deal_stage` |
| **Datadog** | Solo | API + app keys | Monitor fires → Linear/Jira; SLO reports; log queries | Read-only initially; `dd.post_event` later |
| **Stripe** | Solo (**read-only in Wave 2**) | Restricted API key | Billing visibility, dispute evidence, subscription health, revenue reporting | None in Wave 2 |

**Stripe write actions are explicitly deferred** to a later financial-actions milestone with separate compliance, audit-log retention, and rollout review. Wave 2 only ships read-only Stripe operations.

#### Decision log
- **Deferred to Wave 3:** Salesforce, Snowflake/BigQuery, GitLab/Bitbucket (GitHub covers 85%), Figma (read-only value only).
- **Community seed track:** ClickUp, Monday, Airtable — at least one will be seeded in-house under a `@community/*` namespace during M5 to avoid empty-shelf launch dynamics.

---

## Milestone 5 — Community recipes + ecosystem foundation

### Agent B1 — GitHub-backed recipe distribution

**Owner:** Platform + web team

#### What to build

1. **GitHub-backed install source**
   - Do not build a custom Node/Postgres registry in M5.
   - Recipes live either in a curated `patchwork-recipes` org or in third-party repos tagged with a `patchwork-recipe` topic.
   - CLI install syntax: `patchwork recipe install gh:acme/pr-triage@v1.2.0`.

2. **Explicit enable flow after install**
   - Install verifies provenance, writes recipe locally, and leaves it disabled by default.
   - User must run `patchwork recipe enable <name>` before cron/file-watch/manual triggers become active.

3. **Static gallery bootstrap** (`recipes.patchwork.sh`)
   - Built from GitHub metadata plus checked-in recipe manifests.
   - Shows README, install command, connector tags, signature status, maintainer identity, and safety report.

#### Decision log
- **Chosen for M5:** piggyback on GitHub distribution to validate supply/demand quickly.
- **Deferred to M6:** custom publish API, custom package storage, custom semver resolver, and first-party social graph.

---

### Agent B2 — Keyless signing + provenance + advisory safety review

**Owner:** Security team

#### What to build

1. **Sigstore-style keyless signing**
   - Authors sign publishes with short-lived OIDC-issued certs; no long-lived private keys under `~/.patchwork/keys/`.
   - Verification happens on install and in gallery indexing.

2. **2FA requirement for write-tier recipes**
   - Any recipe exposing write-tier tools requires step-up auth at publish time.

3. **Transparency log**
   - Use public Sigstore Rekor in M5.
   - `patchwork recipe audit gh:acme/pr-triage@v1.2.0` shows signature, cert chain, and transparency-log entry.

4. **Advisory safety scan + human review**
   - Static checks flag obvious filesystem and write-tier risk patterns.
   - Scanner output is advisory, never a blanket proof of safety.
   - Recipes touching two or more write-tier connectors require human review before they receive a "Reviewed" badge.

5. **Sandbox preview**
   - `patchwork recipe preview` runs against mock connectors and a mocked LLM only.
   - No external network, no real model/API keys, no automatic enable.

---

### Agent B3 — Discovery, seed content, and telemetry bootstrap

**Owner:** DX + community

#### What to build

1. **Discovery signals**
   - Use GitHub stars, maintainer metadata, connector tags, and freshness for ranking.
   - "Recipes like this" uses connector/tag similarity until telemetry volume is high enough for behavioral ranking.

2. **Seed inventory**
   - Launch with first-party recipes plus at least one in-house-seeded `@community/*` recipe to prove the non-core path works on day one.
   - Publish a small cookbook (`docs/cookbook/*.md`) and 3 starter walkthroughs.

3. **Opt-in ecosystem telemetry**
   - Track installs, enables, weekly runs, and success buckets for community recipes.
   - Never collect recipe contents or step payloads.

---

## Deferred to M6 — Full registry + monetization + community scale

- **Custom registry service** — own publish API, storage, search index, and social graph.
- **Ratings and reviews** — first-party review system after install volume exists.
- **Premium recipes + payouts** — only via merchant-of-record provider such as Paddle or Lemon Squeezy; not Stripe Connect directly.
- **Large-scale community programs** — contest budget, partner tracks, and maintainer incentives after distribution mechanics prove demand.

---

## Cross-cutting concerns

### Security
- **Install source compromise blast radius:** limit via keyless signing, transparency log, explicit post-install enable, and sandbox preview. Assume any index or repo host can be hostile.
- **Supply chain:** pin connector versions in recipe. Recipe says `requires: { stripe: ">=2.0.0 <3" }`; bridge refuses to install if not available.
- **Secrets never travel** with recipes — only tool + param *names*. Users provide creds on install via `patchwork secrets set`.
- **Safety scans are advisory, not proof:** recipes with multiple write-tier connectors require human review before receiving a reviewed badge.

### Telemetry
- Opt-in, anonymised, aggregated. What we collect: recipe fingerprint (content hash), step count, success/failure, duration buckets. What we never collect: recipe content, step inputs/outputs, user identifiers.
- Used for: popularity signals, install/enable conversion, time-to-first-success, and eventually "recipes like this."

### Rollout
- All new surfaces ship behind feature flags and have one-command rollback.
- `recipe install` never auto-enables scheduled recipes.
- Preview/test never hit live connectors or live LLM endpoints.

### Versioning
- Recipes: semver. `apiVersion: patchwork.sh/v1` for wire compat.
- GitHub-backed recipe distribution uses git tags plus signed release manifests in M5; custom registry API versioning is deferred to M6.

### Planning assumptions
- Agents are **workstreams**, not headcount.
- Planning assumption for this document: **3-4 FTE** across M4.5 and **2 FTE** for M5 foundation work. If staffing is lower, M5 slips behind M4.5 instead of overlapping deeply.

---

## Sequencing

```
M4.5 (8-10 weeks)
├─ A0 Tool registry + connector foundation (week 1-2) ─┐
├─ A1 Schema + LSP                         (week 2-3) ──┼─> A3 Visual debugger (week 5-6)
├─ A2 CLI UX                               (week 2-4) ──┤
├─ A4 Mock harness + fixture refresh       (week 3-4) ──┤
├─ A5 Wave 2 × 6                           (week 3-8) ──┘
└─ feature-flagged beta + docs             (week 9-10)

M5 (4-6 weeks, begins after A1/A2 are stable)
├─ B1 GitHub-backed install + gallery bootstrap (week 1-2)
├─ B2 Keyless signing + advisory safety        (week 2-4)
└─ B3 Discovery + seed content + telemetry     (week 3-6)

M6 (deferred)
├─ custom registry service
├─ first-party reviews + social proof
├─ premium recipes + payouts
└─ broader community programs
```

**M5 depends on A0/A1/A2, not Stripe write support** — schema, lint, install safety, and provenance are enough to validate community demand. Financial actions and monetization are explicitly decoupled into M6.

---

## Definition of done

**M4.5 ships when:**
- A0 tool registry, OAuth refresh primitives, and feature-flag scaffolding have landed.
- `patchwork recipe new` → `lint` → `test` → `run --dry-run` → `run` works end-to-end on a recipe an LLM just wrote.
- Opening a `.patchwork.yaml` in VS Code (no extension) gives autocomplete via SchemaStore.
- Every recipe in `examples/recipes/**` and `templates/recipes/**` validates against schema and passes `lint`.
- `patchwork recipe watch` semantics are documented and tested: save-during-run queues exactly one rerun and never mutates the in-flight run.
- Wave 2 × 6 connectors have fixture-backed coverage and at least 2 curated recipes each; Stripe recipes remain read-only.
- `/runs/<seq>` timeline view is feature-flagged, read-only, and supports step replay.
- Dogfood metric: median time from scaffold → first successful run is under 15 minutes for internal users.

**M5 ships when:**
- `patchwork recipe install gh:patchwork-recipes/morning-inbox-triage@v1.0.0` verifies signature and installs end-to-end.
- Installed community recipes remain disabled until the user explicitly enables them.
- At least 5 third-party signed recipes are discoverable through the gallery.
- Safety reports are visible on recipe pages, and multi-write-tier recipes have a human-review path.
- Preview/test for community recipes uses mock connectors and mocked LLM execution only.
- Ecosystem metrics show real pull: ≥ 25 weekly installs and ≥ 10 workspaces running community recipes successfully.

**Deferred to M6:** marketplace monetization, first-party ratings/reviews, and any write-tier Stripe actions.
