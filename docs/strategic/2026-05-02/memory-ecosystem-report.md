# Memory & Ecosystem — Verified Gap Analysis

> Scope: Phases 3 (memory/replay/personalization), 4 (audience expansion), 5 (marketplace). Every claim about existing primitives in the strategic brief has been re-checked against source. File:line citations throughout. Report does not modify any code.

---

## 1. Trace substrate inventory (Phase 3 ground truth)

Patchwork has **four** persistent decision-trail logs. They share a common shape (JSONL, append-only, in-memory ring + on-disk file, monotonic `seq`, size+line rotation) but were authored independently — there is no shared base class.

### 1.1 Files on disk

All four live under the bridge "ide dir" — typically `~/.patchwork/` (the orchestrator dir; Daniel-set via `RUNLOG_DIR`/`opts.dir`). Mode `0o600`, parent dir `0o700`.

| Log | File | Constructor | Schema source |
|---|---|---|---|
| Recipe runs | `runs.jsonl` | `src/runLog.ts:128-132` | `RecipeRun` interface, `src/runLog.ts:55-86` |
| Decision traces (`ctxSaveTrace`) | `decision_traces.jsonl` | `src/decisionTraceLog.ts:94-98` | `DecisionTrace`, `src/decisionTraceLog.ts:26-43` |
| Commit↔issue links | `commit_issue_links.jsonl` | `src/commitIssueLinkLog.ts:75` | `CommitIssueLink` |
| Activity (tool/lifecycle events, **incl. approval decisions**) | path is caller-supplied via `setPersistPath()`; default `activity.jsonl` | `src/activityLog.ts:41-66` | `ActivityEntry` / `LifecycleEntry` (`src/activityTypes.ts`) |

Approval decisions are **not** their own log — they are lifecycle rows with `event === "approval_decision"` inside the activity log (`src/activityLog.ts:262-285`, written by `src/approvalHttp.ts:531`).

### 1.2 Rotation policy (consistent across all four)

- `MAX_PERSIST_BYTES = 1 MB` (1024×1024)
- `MAX_PERSIST_LINES = 10 000`
- `runLog.ts:101-102`, `decisionTraceLog.ts:52-53`, `activityLog.ts:27-28`
- On every append: `statSync(file)`; if `size > MAX_PERSIST_BYTES` → `rotateDisk()` reads the file, slices to last N lines, halves repeatedly until under the byte cap, rewrites. Edge case: a single oversized line is dropped with a warning (`runLog.ts:425`, `decisionTraceLog.ts:219-225`).
- In-memory caps: runs 500 (`runLog.ts:99`), decisions 2 000 (`decisionTraceLog.ts:45`), activity 500 default (`activityLog.ts:51`).

**Implication:** at sustained volume, anything older than ~10 000 events is unrecoverable. The 1 MB cap is generous for a single user's hand-saved decision traces but tight for the activity log on a busy automation policy. There is **no copy-out, no tar archive, no S3, no encrypted backup**.

### 1.3 What `ctxQueryTraces` actually returns

`src/tools/ctxQueryTraces.ts:23-44` — unifies all four logs behind a single shape:

```ts
{ traceType: "approval"|"enrichment"|"recipe_run"|"decision",
  ts: number, key: string, summary: string, body: Record<string,unknown> }
```

Approval rows are reconstructed from `ActivityLog.queryTimeline({last: 500})` and filtered to `event === "approval_decision"` (`ctxQueryTraces.ts:48-72`). Each per-source query is hard-coded to `limit: 500`; the user's `limit` arg is applied **after** cross-source merge (comment on line 50 confirms). So at ≥500 rows per source, oldest events disappear from this view before the rotation cap kicks in.

`ctxSaveTrace` writes only into `decision_traces.jsonl`. Validation: ref/problem/solution required, problem+solution clipped to 500 chars each, ≤10 tags of ≤32 chars (`decisionTraceLog.ts:113-149`).

### 1.4 Replay primitives that already exist

`src/recipes/replayRun.ts` (144 lines) implements **mocked replay**:

- Reads a `RecipeRun` from `runLog`.
- Builds `mockedOutputs: Map<stepId, value>` from each step's captured `output` (line 56-99).
- Re-runs the recipe via `runChainedRecipe` with executors short-circuited to those captured values.
- New run gets `triggerSource: "replay:<originalSeq>"`.
- Steps without captures, or captures with the truncation envelope `[truncated]:true`, are skipped from the mock map and fall through to **real execution** (returned in `unmockedSteps`). The route at `recipeRoutes.ts:495-526` exposes this via `POST /runs/:seq/replay`.

The header comment (`replayRun.ts:13-17`) is explicit: real-mode replay (write tools really fire) is intentionally not built — it needs confirmation UX + kill switch + read/write connector split.

`captureForRunlog.ts` (130 lines) does the per-step capture: sensitive-key redaction + 8 KB cap + truncation envelope. So step inputs/outputs in `runs.jsonl` are already privacy-aware.

### 1.5 Activity log — co-occurrence

`src/fp/activityAnalytics.ts:77-110` — `computeCoOccurrence(entries, windowMs, maxPairs=50)` returns `Array<{pair: "A|B", count}>` for tool pairs called within the window. Map cap 200, evicts lowest-count. Default window 5 minutes (`activityLog.ts:32`). Surfaced through `src/tools/activityLog.ts:78-122` when the caller asks for it.

---

## 2. Verified-vs-aspirational matrix

| Phase 3 deliverable | Status | Evidence |
|---|---|---|
| Trace Backup & Sync | **NOT BUILT** — no encryption, no export command, no Git/S3, no merge | Grep for `encrypt`/`cipher` in trace files: 0 hits. `src/index.ts` CLI dispatch (lines 203-2400) has no `export`/`backup`/`sync` subcommand. Rotation drops data permanently. |
| Decision Replay Debugger (mocked, recipe-level) | **PARTIAL — recipe replay only** | `replayRun.ts` works for recipes; `POST /runs/:seq/replay` exposed. **No** policy-replay (re-running a *new* policy against *old* approvals). **No** UI diff. **No** approval-history replay. |
| Passive Risk Personalization | **NOT BUILT** — primitives present, surfacing absent | Approval decisions persist (`activityLog.ts:262-285`); risk tiers exist (`riskTier.ts`). Nothing reads "you approved 27 similar". Approval prompt UI (`approvalHttp.ts`) does not consult history. |
| Activity-Based Suggestions | **NOT BUILT — substrate ready** | `computeCoOccurrence` exists; `activityLog` tool exposes it. No code suggests "create a recipe from these pairs." No surface in dashboard for unused tools. |
| Recent-decisions digest at session start | **BUILT** | `src/tools/recentTracesDigest.ts:1-80`, ≤2 KB, top 5, 12-hour window, injected into instructions block. |
| Cross-source query (`ctxQueryTraces`) | **BUILT** | `ctxQueryTraces.ts:23-100` covers all four logs. |

---

## 3. Trace durability gap analysis

What's missing for "move machines without losing years of decisions":

| Gap | Concrete deliverable | Effort |
|---|---|---|
| No export format | `patchwork traces export [--since N --type T] > out.jsonl.gz` — gzip stream of merged JSONL with header line `{exportVersion:1, generatedAt, types}` | **1-2 days** |
| No import / merge | `patchwork traces import file.jsonl.gz` — dedup by `(traceType, seq, ts, key)` tuple; reject overlaps, keep highest-seq winner; conflict report | **1 week** (merge correctness + tests) |
| No encryption at rest | Optional `--trace-encryption-key <path>` → AES-256-GCM per-line (still JSONL-shaped, line = `{n, c, t}` nonce/cipher/tag base64). Key stored in OS keychain by default | **1 week** (key management is the slow part) |
| Rotation drops data silently | Move from "drop oldest" to "rotate to `runs.jsonl.1`, keep N rotated files" — same shape as logrotate | **1-2 days** |
| No Git-backed backend | Periodic commit of `~/.patchwork/traces/` to a user-owned repo. `--trace-backup git+ssh://...` flag. Push on rotation event. | **1 week** (auth UX, conflict handling) |
| No S3-compatible backend | `--trace-backup s3://...` using AWS SDK v3 + minio-compatible. Stream rotated files, never raw write path. | **2 weeks** (testing across providers, retry, lifecycle) |
| No JSONL-merge tool for the four logs | Library: `mergeJsonl({type, source, dest})` honoring per-type dedup keys. Unit-tested against deliberately-overlapping fixtures. | **3-4 days** |

**Smallest-credible-shipment:** the export command alone (1-2 days) closes the "I'm migrating laptops" use case for >90% of users; everything else can ship later. Ship it first.

---

## 4. Decision Replay Debugger — architecture sketch

**What exists:** mocked recipe replay (`replayRun.ts`). Captures live in `RunStepResult.output`, redacted + 8 KB capped (`captureForRunlog.ts`).

**What is needed for "would this new policy have approved last Tuesday's 27 calls?":**

1. **Approval-input capture, not just decision capture.** Today `activityLog.ts:262-285` records the *decision* (approve/reject + reason). The *inputs* the policy saw — tool name, params, risk tier, risk signals — are computed inline in `approvalHttp.ts` and not all persisted. **New work:** extend the approval lifecycle row to include `{toolName, sessionId, params (redacted/truncated like captureForRunlog), tier, riskSignals}` so a policy can be re-evaluated offline. Backfill is impossible — older rows lack params.
2. **Policy as data, not code.** `src/riskTier.ts` and `approvalHttp.ts` decide tier inline. To replay a *new* policy we need the policy to be a callable that takes `(toolName, params, sessionContext)` and returns `{tier, decision, reasons}` with no side effects. Once isolated, replay is a pure fold over the captured inputs.
3. **CLI/HTTP surface.** `POST /approvals/replay { policyVersion, since, until }` returns `{total, agree, disagree, newApprovals, newRejections, examples[]}`. Mirror `/runs/:seq/replay`.
4. **Diff UX.** Dashboard page `/replay` showing `[old → new]` per row; reuse the marketplace page's React patterns.
5. **No-side-effects guarantee.** Same approach as `replayRun.ts`: short-circuit the executor. Document explicitly that replayed approvals do **not** unblock the original promises (that ship has sailed) and do **not** trigger downstream tool calls.

**Effort:** 2-3 weeks if approval-input capture lands first as a separate 3-day PR.

---

## 5. Passive Risk Personalization — heuristic catalog

All shippable today against the existing activity + approval lifecycle, **no fine-tuning, no model**. Each row: heuristic / data source / surface / FP risk.

1. **"You approved similar actions N times."** — `activityLog.queryTimeline` filtered to `approval_decision` for same `(toolName, sessionId|workspace)`. Surface: extra line on approval modal. FP: same toolName ≠ same intent (e.g. `runCommand` for `ls` vs `rm -rf`). Mitigate by also matching first param when present.
2. **"You rejected this tool in this context before."** — same source, decision = `rejected`. Surface: warning banner. FP low — explicit prior rejection is signal.
3. **"This recipe has never sent email before."** — `RecipeRunLog.query({recipe})` ∩ tools used (in `stepResults[].tool`). Surface: novel-side-effect callout. FP: recipe variants share name. Acceptable.
4. **"First use of this connector."** — connector inventory (`src/connectors/`) ∩ activity log. Trivial to compute. Surface: "first call to gmail this session/ever."
5. **"This tool was last called T days ago."** — `activityLog` lookback. Surface: subtle timestamp on approval modal. FP near zero.
6. **"This call mirrors a recipe step you trust."** — match `(toolName, redacted-params)` against successful `RecipeRun.stepResults`. Surface: "matches step `notify-slack` from `morning-brief` (12 successful runs)." FP medium — params shape may differ.
7. **"Risk tier escalation."** — current tier vs rolling p50 tier the user actually approves. If the user typically approves `low` and this is `high`, mark accordingly. Source: `riskTier` + approval decisions. FP low.
8. **"Co-occurring tools today suggest a pattern."** — `coOccurrence(15min)` cross-referenced against past co-occurrence baseline. Surface: small chip "this often runs alongside X". FP medium — purely informational.
9. **"Workspace mismatch."** — workspace recorded on each approval row (lifecycle metadata). If today's call comes from a workspace that has never approved this tool, flag. FP low.
10. **"Time-of-day anomaly."** — hour-of-day histogram per tool from activity log. If first-ever call at 03:14 local, flag. FP medium — noisy for power users; gate behind a setting.
11. **"Path/URL pattern novelty."** — for `runCommand`, `sendHttpRequest`, `searchAndReplace`: check the first significant param against past redacted param prefixes. Cheap n-gram or simple set membership. FP medium-high — needs careful redaction reuse.
12. **"Cooldown breach."** — same `(toolName, params-hash)` triggered N times within window. Already partly detected via `ApprovalQueue.inflightKey` (`approvalQueue.ts:38-60`); surface count cumulatively, not just inflight.

**Surfacing pattern:** a single new field on the approval modal — `signals: Array<{label, severity, source}>`. Keep transparency: every signal links back to the rows that triggered it.

---

## 6. Activity-Based Automation Suggestions — query catalog

All runnable against `ActivityLog.entries` (`src/activityLog.ts`) + `RecipeRunLog.runs` (`src/runLog.ts`):

```js
// "You often call X after Y."
// Restriction of computeCoOccurrence with directional bias
const pairs = computeCoOccurrence(entries, 5*60_000, 50)
  .filter(p => p.count >= 5)            // minimum confidence
  .filter(p => !pairAlreadyInRecipe(p, runs)); // never appears together in a run

// "Tools commonly called together this week."
const weekly = computeCoOccurrence(
  entries.filter(e => Date.now() - +new Date(e.timestamp) < 7*24*3600_000),
  10*60_000, 30);

// "Installed tool, never used."
const installedTools = listToolNames();        // from registry/getToolCapabilities
const used = new Set(entries.map(e => e.tool));
const unused = installedTools.filter(t => !used.has(t));

// "Repeated manual workflow."
// 3+ identical (toolName, redacted-first-param) sequences within 24h
const sequences = mineSequences(entries, {minLen: 2, minSupport: 3, windowMs: 24*3600_000});

// "Recipe step always succeeds — graduate?"
const graduates = runs
  .reduce(byRecipe, new Map())
  .entries()
  .filter(([_, list]) => list.length >= 10 && list.every(r => r.status === 'done'));
```

`mineSequences` is the only new primitive — a 50-line PrefixSpan-lite over the activity ring; everything else uses functions in `src/fp/activityAnalytics.ts` already.

---

## 7. Phase 4 — audience-fit analysis

**Distance-to-fit ranking (lowest first):**

| Segment | Distance | Why |
|---|---|---|
| **Indie hackers** | LOW | OAuth shipped (`oauthRoutes.ts`, `oauth.ts` 1 360 lines); `--issuer-url`, PKCE, dynamic client registration, CIMD — all live. Reference PWA is the missing artifact, not engineering. **Target first.** |
| **Power users / life-automation** | MEDIUM | Webhook recipes work (`recipeRoutes.ts:843`); `patchwork recipe install github:owner/repo` works; mobile approval path exists (`approvalQueue.ts:36`, push relay). Missing: NL recipe authoring, iOS-Shortcut walkthrough, Stream Deck examples. |
| **Regulated professionals** | HIGH | Local-first execution and credential storage are real, but compliance documentation is missing entirely. Audit log claim collapses on inspection: trace rotation silently drops history at 1 MB / 10 000 lines (§1.2). No data-retention story, no encryption at rest, no signed audit chain. |

**Onboarding friction by segment:**

- *Indie hackers:* the friction is "show me a 50-line PWA hitting `/mcp` with OAuth and listing recipes." The reference app from the strategic plan would close 80% of distance.
- *Power users:* the friction is YAML. The Phase-2 conversational recipe builder is the unlock.
- *Regulated:* friction is "can I prove what happened?" — not solved by features, only by documentation + the durability work in §3.

---

## 8. Compliance-friendly deployment guide outline

To be credible for regulated professionals, Patchwork needs to **document** (most artefacts already exist; gap is mostly verbal):

1. **Architecture: local-first.** Single binary, no SaaS, `~/.patchwork/` data dir. No telemetry by default (verify against `analyticsSend.ts`).
2. **Credentials.** Where OAuth tokens for connectors live, encrypted at rest with what algorithm. (Current state: check `connectors/` token storage; document or fix.)
3. **Audit log.**
   - Today: 1 MB / 10 000-line cap is **inadequate for regulated use**. State this explicitly.
   - Mitigation: ship trace export + `--audit-mode strict` flag that disables rotation and requires an external sink.
   - Add a hash-chain (`sha256(prev || row)` per line) for tamper-evidence — 1-day work in `runLog.ts`/`decisionTraceLog.ts`.
4. **Data residency.** "All trace data on the user's machine; backups go where the user configures." (Once §3 export ships.)
5. **Network egress.** Document blocklist behavior in `ssrfGuard.ts`; document command allowlist in `runCommand`. Both already exist; not surfaced.
6. **Model providers.** Subscription drivers (Claude, Gemini) keep prompts in vendor accounts. Local-only path via Ollama: needs to be documented as a first-class path, not a footnote.
7. **Approval policy as control.** Map delegation policy modes to common compliance vocabulary (least-privilege, dual control, audit).
8. **No-SaaS deployment.** VPS or local-only — covered in `docs/remote-access.md` and `deploy/`. Bridge the gap to compliance language.

**Honest single-paragraph framing:** "Patchwork OS executes locally, stores traces locally, and never phones home for telemetry. Auditability today is best-effort (rotated 1 MB ring); strict-audit mode is on the roadmap (Phase 3, §3 of this report) and will offer hash-chained, externally-sinked logs."

---

## 9. Phase 5 — current marketplace state, honest accounting

The strategic plan asserts "marketplace commands, recipe registry, dashboard marketplace code, install flows" already exist. Resolved status:

| Asset | Status | Evidence |
|---|---|---|
| `claude-ide-bridge marketplace list/install/search` (skills) | **BUILT — but it is a skills marketplace**, not a recipe/plugin one | `src/commands/marketplace.ts` (164 lines). Registry shape: `{name, description, npmPackage, type:"skill", version, author, builtin, stars}`. Source: hardcoded URL `Oolab-labs/claude-ide-bridge/main/scripts/marketplace/registry.json`. |
| Bundled fallback skills registry | **BUILT** | `scripts/marketplace/registry.json` — currently Oolab Labs-authored entries with `builtin: true`. |
| `patchwork recipe install <github:...>` | **BUILT** | `src/commands/recipeInstall.ts` (895 lines) + `src/recipes/installer.ts`. Supports `github:owner/repo[/sub][@ref]`, `gh:`, `https://github.com/...`, local paths. SSRF-guarded redirect chain (lines 253-340). Validates manifest, compiles, writes to `~/.patchwork/recipes/`. |
| `RecipeManifest` schema | **BUILT** | `src/recipes/manifest.ts` (214 lines): `{name, version, description, author?, license?, tags?, connectors?, recipes:{main, children?}, variables?, homepage?, repository?}`. |
| `POST /recipes/install` HTTP endpoint | **BUILT** | `src/recipeRoutes.ts:843` (recently hardened in `phase1: A-PR2 nested + SSRF + body cap`). Restricted prefix `github:patchworkos/recipes/recipes/` for the public registry. |
| Recipes registry (separate from skills) | **PARTIAL** | `dashboard/src/app/marketplace/page.tsx` reads a `RegistryData` (recipe entries with `connectors`, `install`, `downloads`). Bridge endpoint `/templates` registry mentioned at `recipeRoutes.ts:6`. Fallback data hard-coded in dashboard page. There is **no separate recipes-registry.json**, no plugin registry. |
| Dashboard `/marketplace` and `/marketplace/[...slug]` pages | **BUILT** | `dashboard/src/app/marketplace/page.tsx`, `[...slug]/page.tsx`. `/recipes/marketplace` redirects to `/marketplace`. |
| **Plugin** marketplace | **NOT BUILT** | No plugin registry. Plugins are installed by `--plugin <path|npm-package>` only (`pluginLoader.ts:48`). |
| Capability bundles | **NOT BUILT** | No bundle format, no install flow. Each asset (skill, recipe, plugin) is its own world. |
| Trust metadata on registry rows | **PARTIAL** | Recipes carry `connectors[]`. Skills carry `stars` only. No risk level, approval behavior, network access, file access fields. |

**Resolution of the "internally inconsistent" memory note:** there are *three* parallel marketplace surfaces — the skills CLI (Oolab-Labs registry, hardcoded), the recipe-install CLI (GitHub URLs, no central registry), and the dashboard `/marketplace` (a third registry shape, fallback-only when bridge offline). They share no schema. The user is correct: the codebase advertises one marketplace and ships three.

---

## 10. Capability bundle format — concrete spec

Directory layout:

```
my-bundle/
  bundle.json                 # manifest
  README.md                   # required
  recipes/                    # 0..n .yaml/.json (validated by parseRecipe)
  policy/                     # 0..1 delegation-policy fragments
    suggested.json
  plugin/                     # optional embedded plugin
    claude-ide-bridge-plugin.json
    dist/
  screenshots/                # optional
```

Manifest schema (`bundle.json`, schemaVersion 1):

```jsonc
{
  "schemaVersion": 1,                       // bump only on breaking change
  "name": "@org/gmail-vip-support",         // npm-style; matches NAME_RE in manifest.ts
  "version": "1.2.0",                       // semver
  "description": "...",                     // ≤200 chars
  "author": "...",
  "license": "MIT",
  "homepage": "...",
  "tags": ["support", "email"],

  "contains": {                             // declarative inventory
    "recipes": ["gmail-vip-triage.yaml"],   // basenames; isSafeRecipeBasename rules
    "policy": "policy/suggested.json",      // optional
    "plugin": "plugin/"                     // optional
  },

  "requires": {                             // hard preconditions; install fails if missing
    "patchworkVersion": ">=2.45.0",
    "connectors": ["gmail", "linear"],
    "tools": ["sendHttpRequest", "ctxSaveTrace"],
    "node": ">=20"
  },

  "trust": {                                // surfaced at install preview
    "riskLevel": "medium",                  // low|medium|high — required
    "networkAccess": [                      // domains the bundle may reach
      "api.linear.app", "gmail.googleapis.com"
    ],
    "fileAccess": ["read:workspace"],       // {read|write}:{workspace|home|none}
    "approvalBehavior": "ask-on-novel",     // never-ask|ask-once|ask-every-time|ask-on-novel
    "writesExternalState": true,            // sends emails, creates issues, etc.
    "destructive": false
  },

  "maintainer": {
    "name": "...",
    "email": "...",
    "verifiedSignature": "..."              // optional sigstore/cosign blob
  }
}
```

Justification per field:

- `requires.patchworkVersion` — install-time gate; today plugins use `minBridgeVersion` (warn-only), bundles need hard fail.
- `requires.connectors` / `requires.tools` — already inferred ad-hoc in `RecipeManifest.connectors`; lift to first-class so `/install` previews can check.
- `trust.riskLevel` — drives approval-modal default behavior; required, not optional. Prevents "I forgot to declare risk."
- `trust.networkAccess` — pairs with `ssrfGuard` enforcement at runtime; bundles that exceed declaration get blocked.
- `trust.fileAccess` — pairs with `resolveFilePath` workspace jail.
- `trust.approvalBehavior` — wires directly into the future Recipe Trust Graduation feature (Phase 2 §4).
- `trust.writesExternalState` / `destructive` — copy from MCP tool annotations; user-visible in the install preview.

**Validation rules:**
1. `name` matches `NAME_RE` from `manifest.ts:38`.
2. Every `contains.recipes` entry passes `isSafeRecipeBasename` (`manifest.ts:48-60`).
3. Embedded plugin manifest validates per `pluginLoader.ts:89-107`.
4. Every host in `trust.networkAccess` resolves to a public IP (SSRF re-check using `ssrfGuard`).
5. `requires.tools` are present in the running bridge's `getToolCapabilities`; if not, hard fail.
6. `riskLevel ∈ {low, medium, high}`.

**Install flow (extension of existing `recipes/installer.ts`):**
1. Fetch `bundle.json` + recipe files (existing `httpsGet` redirect-chain code, `recipeInstall.ts:275`).
2. Validate manifest.
3. Show preview (§11).
4. On approve: copy recipes to `~/.patchwork/recipes/`, copy plugin to `~/.patchwork/plugins/`, write policy to `~/.patchwork/policies/<bundle-name>.json`, register in `~/.patchwork/bundles.json` (provenance: source URL, hash, installedAt, version).
5. Reload via `pluginWatcher` if plugin present.

---

## 11. Marketplace trust UX

**Install-preview screen** (CLI + dashboard parity):

```
Install @org/gmail-vip-support v1.2.0?

  Source       github:org/gmail-vip-support@v1.2.0
  Risk         medium  (declared by author)
  Maintainer   Org Inc.  (signature: verified ✓)

  Adds:
    • 1 recipe        gmail-vip-triage.yaml (webhook)
    • 1 policy frag   suggested.json — auto-approve gmail.list, ask gmail.send
    • 0 plugins

  Wants to:
    • Read your gmail        (connector: gmail — already authorized)
    • Write to Linear        (connector: linear — not authorized; will prompt)
    • Network: api.linear.app, gmail.googleapis.com
    • Workspace files: read-only

  Approval behaviour: ask-on-novel  (first time per recipient)
  Writes external state: yes (emails, issues)

  This bundle has been installed by 12 users (registry signal).

[Install]  [View recipe]  [Cancel]
```

**Approval rules at install time:**
1. `trust.riskLevel === "high"` ⇒ require explicit "type the bundle name to confirm" (mirrors GitHub destructive flows).
2. Any host in `trust.networkAccess` not in a per-user pre-approved set ⇒ surface as new permission grant.
3. Embedded plugins always shown separately — plugin code runs in-process and deserves its own line.
4. Re-install with version bump must show a diff (recipes added/removed/changed, trust deltas) — not just "installed".

**Connection to Delegation Policy:**

- Bundle's `policy/suggested.json` is a *fragment*, not authoritative. On install, dashboard offers: `Apply suggested policy` / `Apply with edits` / `Skip — keep current`.
- The fragment writes into the same delegation-policy structure consumed by `approvalHttp`, `riskTier`, and the approval modal.
- A bundle never silently lowers approval friction; the user's action above is the consent gate.
- Installed bundles appear as *trust origins* in the approval modal: "this call originates from `@org/gmail-vip-support` recipe `gmail-vip-triage`," giving the user a stable name to trust/distrust as a unit.

---

## 12. Prioritized backlog (leverage per effort)

### 1-2 day items
- **P3-A — `patchwork traces export`** (gzipped JSONL of all four logs). Closes laptop-migration use case. Unblocks every Phase-3 narrative. *Highest-leverage single PR.*
- **P5-A — Resolve marketplace surface inconsistency** in docs only — explicitly call out the three surfaces, declare bundle as the unification path. (Docs PR; no code.)
- **P3-B — Hash-chained trace rows** (sha256 per-line fold) in `runLog.ts` + `decisionTraceLog.ts`. Closes "tamper-evident" claim for compliance.
- **P3-C — Capture full approval inputs** (params + risk signals) into the lifecycle row. Prereq for policy replay. Tiny PR; big downstream effect.
- **P4-A — One-page compliance brief** mapping existing primitives (SSRF guard, command allowlist, local-only execution) to compliance vocabulary.

### 1-2 week items
- **P3-D — `patchwork traces import` + JSONL merge library** with dedup tests.
- **P3-E — Passive personalization v0**: heuristics 1, 2, 4, 7 from §5 wired into the approval modal as a `signals[]` field. No new ML, no new infra.
- **P3-F — Activity-based suggestion tool** exposing the three queries in §6 (`coOccurrencePairs`, `unusedTools`, `repeatedManualWorkflows`). Single MCP tool, JSON output.
- **P5-B — Capability bundle MVP**: manifest schema + validator + install flow; defer policy fragments and embedded plugins to v1.1.
- **P4-B — Reference OAuth PWA** (closes indie-hacker fit). 200-line app: login → list recipes → run recipe → approve.

### 1-2 month items
- **P3-G — Decision Replay Debugger** (policy replay, dashboard diff page).
- **P3-H — Trace encryption at rest + Git/S3 backends.**
- **P5-C — Bundle marketplace registry** (separate from skills + recipes; or, better, a single unified registry that subsumes them). Trust metadata, install previews, dashboard polish.
- **P3-I — Local model for novel-risk classification** (only after passive heuristics ship).

### Top 3 by overall leverage

1. **P3-A — trace export.** One-day PR; unblocks the entire "logs are durable" thesis; immediate compliance + migration story.
2. **P3-C — capture full approval inputs.** Tiny PR; unlocks both replay debugger AND personalization heuristics 1/2/6/7. Highest leverage per LOC.
3. **P5-B — capability bundle MVP.** Single artifact replaces three inconsistent marketplace surfaces; required for credible Phase-5 story.

---

## 13. Open questions for the maintainer

1. **Single marketplace registry — or three permanent silos?** Can `scripts/marketplace/registry.json` evolve into a unified bundle registry (skills become bundles with no recipes/plugins)? Or do we accept long-term coexistence?
2. **Per-trace encryption key — keychain vs file vs prompt?** Affects UX significantly. Default should not be "type a passphrase every session."
3. **Strict-audit mode — block on rotation, or just disable rotation?** Compliance posture choice. Disabling rotation lets disks fill; blocking is annoying.
4. **Should bundles be allowed to ship plugins?** Plugin code runs in-process — same trust model as `--plugin <npm-package>`. Yes/no/sandboxed?
5. **Approval-input capture: redact what?** Reuse `captureForRunlog` redaction list, or compliance-stricter? Some regulated users want zero param capture.
6. **Replay scope for v1**: recipes only (already partial), or approval-policy too? The latter has bigger story value, more design work.
7. **Co-occurrence suggestions — opt-in or default-on?** "We noticed you call X after Y" can feel surveilling. Default-off probably correct.

---

## 14. Honesty section — strategic-plan claims that don't match code

| Plan claim | Reality |
|---|---|
| "Trace and activity substrates exist — `decision_traces.jsonl`, `ctxQueryTraces`, `ActivityLog`, co-occurrence stats, recent digest injection." | True — but rotation silently drops at 1 MB / 10 000 lines per file. "Substrate" yes; "moat" no, until durability ships. |
| Phase 3 §1 "Local JSONL is durable enough for a session, not for years." | Stronger than implied — at sustained volume, "years" is "weeks." |
| Phase 5 "Plugin manifests, npm-distributed plugins, marketplace commands, recipe registry, dashboard marketplace code, install flows." | Three disjoint surfaces (skills CLI, recipe-install CLI, dashboard `/marketplace`). The strategic-plan sentence reads as "this is integrated" — it is not. |
| "Run logs, replay, dashboard run surfaces" (Executive thesis) | Mocked recipe replay only. No policy replay. No replay UI diff. The `/runs/:seq/replay` endpoint exists but is mocked-mode-only by design (`replayRun.ts:13-17`). |
| Phase 1 §3 "current implementation stages edits without disk writes, but the commit path needs review" | The plan correctly flags this; not investigated in this report (out of scope) but the caveat in the plan is appropriate, not aspirational. |
| Phase 5 trust metadata as already-present | Recipes have `connectors[]` only. There is no `riskLevel`/`networkAccess`/`fileAccess`/`approvalBehavior` field anywhere today. Build it. |
| `documents/platform-docs.md:669` "Run history persists as JSONL at `~/.patchwork/runs.jsonl` via `RecipeRunLog` (append-only file + bounded in-memory ring)" | Accurate — but omits the rotation cap. Docs should disclose. |

**Bottom line:** the strategic plan is approximately right about *what exists*, but consistently optimistic about *how durable / integrated / production-grade* the existing pieces are. The fixes are mostly small, well-scoped PRs (trace export, hash chain, approval-input capture, bundle manifest) — not new architecture. Phase 3 §1 (durability) and Phase 5 (bundle format unification) are the two areas where the plan understates the work.
