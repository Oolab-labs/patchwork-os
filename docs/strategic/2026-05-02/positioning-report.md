# Positioning Report — Patchwork OS as a Personal AI Runtime

> Phase 0 + Phase 1 deliverable for the strategic plan in
> `docs/strategic/2026-05-02/strategic-plan.md`.
> Author: Positioning agent. Date: 2026-05-02.
> Source-of-truth verification only — no code or doc edits made.

---

## 1. Current narrative audit

The repo's top-of-funnel surfaces are `README.md`, `documents/platform-docs.md`,
and the dashboard pages under `dashboard/src/app/`. None of them lead with
"personal AI runtime." Instead they lead with three overlapping but distinct
stories that conflict with the strategic thesis.

**A. README.md hero (lines 1-13)** opens with:

> "One npm package. Two products. Pick the layer you need."
> followed by a table where Bridge = "MCP bridge connecting Claude Code to
> your IDE" and Patchwork OS = "everything in the bridge plus YAML recipes,
> approval queue, oversight dashboard…"

This is a developer-tool framing. The word "runtime" never appears. Patchwork
is positioned as an *additive layer on top of an IDE bridge*, not as a
standalone personal AI substrate.

**B. README.md:78** (Patchwork section):

> "Think of it as a background agent that acts on your behalf — but asks
> before sending, writing, or modifying anything consequential."

"Background agent" is the *only* persona phrase in the README and it implies
"works while you sleep" (one of the two phrases the strategic plan
explicitly wants to retire).

**C. documents/platform-docs.md:1-3**:

> "Claude IDE Bridge — Platform Documentation
> Version **0.2.0-alpha.3** · 170+ tools · 72 MCP prompts · 20 automation
> hooks · **4 connectors**"

Two problems:
- Repo title is "Claude IDE Bridge," not Patchwork OS.
- "4 connectors" contradicts README's enumeration of 19+ connectors
  (Slack, GitHub, Linear, Gmail, Google Calendar, Sentry, Notion, …). This
  is a Phase-0 doc-reconciliation item.

**D. CLI binaries (README:236-242)** — three names (`claude-ide-bridge`,
`patchwork`, `patchwork-os`) for the same code. The runtime story currently
has to fight three brand identities at once.

**E. Dashboard** — `dashboard/src/app/page.tsx` uses neutral operations
language ("Pending approvals", "Running tasks", "Recent activity").
Re-positionable cheaply; nothing in the dashboard explicitly calls itself a
runtime today.

**Phrases that conflict with "personal AI runtime":**

| Where | Phrase | Conflict |
|---|---|---|
| README:1 | "One npm package. Two products." | Splits the story; runtime is supposed to be one thing |
| README:5 | "MCP bridge connecting Claude Code to your IDE" | Frames primary identity as IDE plumbing |
| README:78 | "Background agent that acts on your behalf" | "Sleep" framing the plan asked us to retire |
| README:230 | "What's shipped" matrix | No runtime/policy/trace primitives surfaced — flat feature list |
| platform-docs.md:1 | "Claude IDE Bridge — Platform Documentation" | Document itself disowns the Patchwork OS name |
| platform-docs.md:3 | "4 connectors" vs README's 19 | Stale; undermines credibility of any new claim |

---

## 2. Verified-vs-aspirational matrix

Five strategic-plan claims, each verified against the source.

### 2.1 Plugin hot reload — **BUILT**

- `src/pluginWatcher.ts` (179 lines) — `PluginWatcher` class wraps
  `fs.watch`, debounces 300 ms (line 12), reloads via
  `loadOnePluginFull` with a `isHotReload` flag (line 127).
- Failure-rollback path restores the prior plugin tools if
  `transport.replaceTool` throws (lines 152-167).
- `sendListChanged()` broadcasts `notifications/tools/list_changed` after
  reload (line 177). Connected MCP clients see the new tool without
  reconnecting.
- CLI flag `--plugin-watch` documented and parsed in `src/config.ts`;
  test coverage in `src/__tests__/pluginWatcher.test.ts` and
  `pluginWatcher-shadow.test.ts` (collision detection on reload).

**End-to-end loop is real.** Strategic plan claim is accurate. Live
Toolsmithing is the most defensible "demo this in 60 seconds" feature.

### 2.2 Approval gate / risk tiers / policy precedence — **BUILT**

- `--approval-gate {off|high|all}` parsed in `src/config.ts:640-644`,
  default `off`, threaded through `src/server.ts` and `src/transport.ts`.
- Risk tier registry in `src/riskTier.ts` (178 lines) — three tiers
  (`low|medium|high`) plus a CC-aligned `ToolBehavior` taxonomy
  (`readOnly|localWrite|shellExec|externalEffect`) at lines 26-39.
  Unknown tools default to `medium` (file comment line 6: "safer than
  auto-approving").
- Approval queue in `src/approvalQueue.ts` (264 lines) and HTTP surface
  in `src/approvalHttp.ts`.
- Policy precedence in `src/ccPermissions.ts:22` — `RuleSource =
  "managed" | "project-local" | "project" | "user"`, ordered. `managedPath`
  is the highest precedence and cannot be overridden by users
  (config.ts:36-37, 821).
- Test coverage: `approvalGate.e2e.test.ts`, `approvalHttp.test.ts`,
  `mobileOversight.e2e.test.ts`, `server-settings.test.ts`,
  `bridge-activation-metrics.test.ts`.

**Reframing as "Delegation Policy" is purely a rename**: every primitive
the plan wants (tiers, precedence, dashboard surface) already exists.

### 2.3 Edit transaction system — **PARTIAL** (atomic-rollback claim is **FALSE**)

This is where the strategic plan's caveat is correct and the marketing
needs to be careful.

- `src/tools/transaction.ts` (389 lines) implements four tools:
  `beginTransaction`, `stageEdit`, `commitTransaction`,
  `rollbackTransaction`.
- `stageEdit` (lines 111-262) does NOT touch disk — it reads original
  content, computes the new content via `applyLineRange` /
  `applySearchReplace`, and stores both in the in-memory `Transaction`
  map (line 255). Verified accurate.
- `rollbackTransaction` (lines 343-381) is sound — just deletes the
  in-memory record; nothing has been written.
- `commitTransaction` is **NOT atomic**. From the tool's own description
  at line 268:
  > "Write all staged edits atomically. All files are written; on
  > partial failure, written files are NOT rolled back (use
  > rollbackTransaction before commitTransaction to verify)."

  The handler (lines 304-340) iterates each staged edit and calls
  `fs.promises.writeFile` in a loop. If edit N fails, edits 1..N-1 are
  already on disk; the code records the error and continues, returning
  `{committed, files, errors}`. **No undo of partial writes.**
- TTL is 30 minutes (line 27); state lives in a module-scoped `Map`
  (line 30) — does NOT survive process restart.

**What is truthful to claim**: "Stage multi-file edits, inspect the full
diff, then commit or discard before touching disk. Pre-commit rollback
is total and disk-safe." That is exactly true.

**What is NOT truthful**: "Atomic rollback after commit." The plan's
caveat is correct and must be preserved verbatim in any marketing copy.

### 2.4 Webhook-triggered recipes — **BUILT** (with one historical-comment
gotcha)

- HTTP endpoint live in `src/server.ts:811-849`: `POST /hooks/<path>`
  reads the body, JSON-parses if possible, dispatches to `webhookFn`.
- Dispatch wired in `src/recipeOrchestration.ts:263-319` —
  `findWebhookRecipe()` scans `~/.patchwork/recipes`, supports both YAML
  and prompt formats, seeds `hook_path`, `webhook_path`, `payload`,
  `webhook_payload` into the recipe context, then enqueues via the
  Claude orchestrator.
- Body cap: 8 KB payload truncation at line 286.
- 503 if orchestrator missing (server.ts:828-837) — explicit error
  message tells the user to start with `--claude-driver subprocess`.
- Schema accepts `trigger.type: "webhook"` (`src/recipes/schema.ts:12`,
  validation.ts:60-168, parser tests at parser.test.ts:8-63).

**One stale comment to be aware of**: `src/recipes/compiler.ts:167-170`
still throws "webhook trigger requires the /hooks/* HTTP endpoint, not
yet wired. Skip until Phase-2 HTTP patch." That message is dead — the
HTTP path is wired; the compiler simply doesn't drive webhook recipes
(the `webhookFn` path does). Worth a comment-only cleanup but does not
break the user-facing feature.

### 2.5 OAuth surface — **BUILT**

- `--issuer-url` flag in `src/config.ts:681-685` activates OAuth.
- Endpoints live in `src/oauth.ts` (1215 lines) and `src/oauthRoutes.ts`
  (145 lines):
  - `/.well-known/oauth-authorization-server` (RFC 8414)
  - `/.well-known/oauth-protected-resource` (RFC 9396)
  - `/oauth/register` (RFC 7591)
  - `/oauth/authorize` (oauthRoutes.ts:83, oauth.ts:1188 form)
  - `/oauth/token`, `/oauth/revoke`
- PKCE S256 mandatory (oauth.ts:1074: `if (codeChallengeMethod !==
  "S256") return { error: "invalid_request" };`).
- CIMD fetch with 8 KB cap + 5-min cache + SSRF guard — confirmed by
  `src/__tests__/oauth-cimd-ssrf.test.ts`.

**Personal AI API story is real and shippable.** What's missing is a
*reference app* (the strategic plan's PWA) — that's a Phase 1 deliverable,
not a verification gap.

### Summary table

| Feature | Claim | Verdict | Key evidence |
|---|---|---|---|
| Plugin hot reload | Live Toolsmithing | **BUILT** | `src/pluginWatcher.ts:14-178` |
| Approval gate + risk tiers + policy precedence | Delegation Policy | **BUILT** | `src/riskTier.ts`, `src/ccPermissions.ts:22-97`, `src/config.ts:640` |
| Edit transactions | "Reversible refactoring" | **PARTIAL** — pre-commit rollback works; **post-commit rollback does NOT exist** (`src/tools/transaction.ts:268, 304-340`) | See §2.3 |
| Webhook recipes | "Anything can trigger your AI" | **BUILT** | `src/server.ts:811`, `src/recipeOrchestration.ts:263` |
| OAuth | "Personal AI API" | **BUILT (no reference app)** | `src/oauth.ts:254-1215`, `src/config.ts:681` |

---

## 3. Canonical positioning sentence

> **Patchwork OS is a local-first personal AI runtime: pluggable model
> providers, hot-reloadable tools, YAML recipes, a delegation policy with
> approval queue, and a durable trace memory — all running on your
> machine, all under your policy.**

**Why this and not the other two candidates:**

- "Local-first AI delegation platform" — accurate but "platform" reads
  as enterprise B2B, weakens the personal-runtime story for indie
  hackers and life-automation users (Phase 4 targets).
- "Policy-controlled AI automation layer" — accurate but "layer" implies
  Patchwork sits *on top of* something. The codebase is a runtime in
  every meaningful sense (process, tool registry, approval gate, policy
  precedence, OAuth surface). Calling it a "layer" gives away the
  category.

The chosen sentence is one sentence, lists five concrete primitives, and
ends on the trust statement ("under your policy"). Each clause maps to a
verified feature in §2.

---

## 4. Homepage rewrite draft (~200 words)

> # Patchwork OS
>
> **A local-first personal AI runtime.** Patchwork runs on your machine
> and gives any AI model — Claude, GPT, Gemini, Grok, Ollama — a
> consistent set of tools, a YAML recipe layer, a delegation policy
> with approval queue, and a trace memory that compounds over time.
>
> You decide which model. You decide which actions need a human nod.
> You own the credentials, the logs, and the deployment. Nothing phones
> home.
>
> **Five primitives, one runtime:**
>
> - **Tools** — 170+ built-in (LSP, git, terminal, debugger, files) plus
>   any plugin you write. Plugins hot-reload — your AI can author a tool
>   mid-session and call it on the next turn.
> - **Recipes** — YAML automations triggered by cron, file save, git
>   commit, test run, or webhook. Anything that can POST a JSON payload
>   can fire a recipe.
> - **Delegation Policy** — three risk tiers, four-source precedence
>   (managed → project-local → project → user). Auto-approve safe,
>   require approval for risky, block dangerous.
> - **Trace memory** — every approval, every recipe run, every
>   enrichment is durable JSONL. Past decisions are surfaced into future
>   sessions automatically.
> - **OAuth** — turn your runtime into a private personal API. PKCE S256,
>   dynamic client registration, deployable on a VPS in minutes.
>
> ```bash
> npm i -g patchwork-os && patchwork patchwork-init
> ```

---

## 5. Comparison page draft

**Patchwork OS vs. an MCP server.** An MCP server exposes tools to one
model client. Patchwork is a runtime *around* the tool surface: model
providers are pluggable, tools hot-reload, recipes run on triggers,
calls flow through a delegation policy, and every decision is written
to a queryable trace log. Pointing an MCP client at a Patchwork bridge
gets you all of that without changing the client. Pointing it at a bare
MCP server gets you a tool list.

**Patchwork OS vs. Zapier / Make / n8n.** SaaS automation tools host
your credentials, your data, and your workflows on their infrastructure.
Patchwork runs on your machine — credentials stay in your OS keychain,
recipes are plain YAML you can dotfile, traces are JSONL you can grep.
The trade-off is honest: Zapier has a polished GUI and 5,000+ pre-built
integrations; Patchwork has a smaller connector library, a CLI-first
authoring loop, and zero data exfiltration. Pick by who you trust with
your tokens.

**Patchwork OS vs. hosted AI assistants (ChatGPT plugins, Claude
projects, Copilot Workspace).** Hosted assistants give you one model
behind their UI with their tool catalogue and their policy. Patchwork
inverts every part of that: any model, your tools, your policy, your
machine. The cost is setup — you provision the runtime, you write the
recipes, you wire the OAuth. The benefit is that swapping model
providers is a config change, not a migration.

**Patchwork OS vs. local agents (LangGraph, AutoGPT, CrewAI, Open
Interpreter).** Local agent frameworks are libraries — you write Python
to compose chains. Patchwork is a runtime — you write YAML recipes,
declare a policy, and call tools over MCP from any compatible client.
Agent frameworks excel at programmatic orchestration; Patchwork excels
at policy, observability, and giving non-developers (via webhooks,
mobile approvals, conversational recipe authoring) a way in.

---

## 6. Architecture diagram spec

Single page, landscape. Eight boxes plus arrows.

**Boxes (left to right, top to bottom):**

1. **Model Providers** (top-left) — vertically stacked: Claude, GPT,
   Gemini, Grok, Ollama. Label: "Pluggable. Subscriptions or API keys."
2. **Triggers** (left edge) — vertically stacked: Cron, File save, Git
   event, Test run, Webhook (HTTP), CLI, Phone (Shortcut/PWA). Label:
   "Anything that can fire."
3. **Patchwork Bridge Runtime** (center, large) — encapsulates 4 inner
   sub-boxes:
   - **Tool Registry** (170+ built-in + plugins). Annotation: "hot
     reload via `--plugin-watch`."
   - **Recipe Engine** — `RecipeOrchestrator`, parser, scheduler.
   - **Delegation Policy** — risk tiers + four-source precedence
     (managed → project-local → project → user) + approval queue.
   - **Trace Memory** — `decision_traces.jsonl`, `RecipeRunLog`,
     `ActivityLog`, `ctxQueryTraces`.
4. **MCP Transports** (right of bridge) — three lanes: WebSocket
   (Claude Code CLI), stdio shim (Claude Desktop), Streamable HTTP
   (claude.ai, Codex, mobile PWA).
5. **OAuth Surface** (top-right) — `/.well-known/*`, `/oauth/*`,
   PKCE S256, CIMD. Label: "Optional. Activate with `--issuer-url`."
6. **Dashboard + Mobile PWA** (bottom-right) — `localhost:3100` +
   push approvals.
7. **VS Code / JetBrains Extension** (bottom-left) — LSP, debugger,
   editor state.
8. **External Targets** (far right) — connectors (Slack, GitHub,
   Linear, Gmail, …), the user's filesystem, the user's terminal.

**Arrows:**

- Triggers → Recipe Engine (input).
- Model Providers ↔ Bridge Runtime (LLM calls).
- Bridge Runtime → Tool Registry → External Targets (tool dispatch).
- *Every* outbound arrow from Tool Registry passes through Delegation
  Policy first; show that as an explicit checkpoint glyph (gate icon).
- Delegation Policy → Approval Queue → Dashboard / Mobile PWA (when
  human nod required).
- Tool Registry, Approval Queue, Recipe Engine all → Trace Memory
  (write).
- Trace Memory → Bridge Runtime (read; "session-start digest, recent
  decisions").
- MCP clients (CLI, Desktop, claude.ai, mobile) → MCP Transports →
  Bridge Runtime.
- OAuth Surface gates the Streamable HTTP transport when active.

**Caption**: "One runtime. Bring your own model. Bring your own
triggers. Every action passes through a policy you wrote and a log you
own."

---

## 7. Three demo scripts

### 7.1 Live Toolsmithing (~150 words)

**Setup:** `claude-ide-bridge --workspace . --plugin ./scratch-plugin
--plugin-watch` (in tmux pane 1). Claude Code attached in pane 2.

**Script:**

1. User in Claude Code: *"I need a tool that returns the line count of
   every TS file in src/. Write the plugin."*
2. Claude calls `editText` to create `scratch-plugin/index.ts`
   exporting `register(ctx)` that adds tool `scratchLineCounts` calling
   `glob('src/**/*.ts')` then `fs.readFileSync` per file.
3. Claude saves the file. Pane 1 prints
   `[plugin-watch] Plugin "scratch" reloaded — 1 tool: scratchLineCounts`.
4. Claude calls `getToolCapabilities` → confirms
   `scratchLineCounts` in the list.
5. Claude calls `scratchLineCounts {}` → returns the line counts table.
6. Same session, no reconnect.

**Expected output:** A markdown table with file paths and line counts,
plus the watcher log line above. Total wall time ≤ 90 s.

### 7.2 iPhone Shortcut → webhook recipe → mobile approval (~150 words)

**Setup:** Patchwork running on a VPS at `https://patch.example.com`
with `--issuer-url`, `--approval-gate high`, mobile PWA enrolled.
Recipe `~/.patchwork/recipes/capture-thought.yaml` declares
`trigger: { type: webhook, path: "/hooks/capture" }`.

**Script:**

1. Build an iPhone Shortcut: ask for text, then "Get Contents of URL"
   POST to `https://patch.example.com/hooks/capture` with bearer token
   and JSON body `{"text": "<dictated>"}`.
2. From the lock screen, dictate: *"Add to inbox: revisit the
   transaction-rollback caveat in the readme."*
3. Server logs (real): `POST /hooks/capture 200`. Recipe enqueues a
   Claude task with `webhook_payload` seeded.
4. Recipe step "write to inbox" is tier `medium` → approval queue.
5. Phone receives push; approve. `~/.patchwork/inbox/<ts>.md` created.
6. `ctxQueryTraces { traceType: "approval" }` shows the entry, who
   approved, latency.

**Expected output:** One inbox file, one approval trace, end-to-end
under 30 s.

### 7.3 Reversible refactor — staged transaction with honest semantics (~150 words)

> Re-scoped from the strategic plan's "atomic rollback" framing because
> `commitTransaction` does not undo partial writes (see §2.3). Demo
> shows what the code actually does.

**Setup:** Plain workspace. Claude Code attached.

**Script:**

1. User: *"Rename `oldFn` → `newFn` across src/."*
2. Claude calls `beginTransaction {}` → `transactionId: "abc"`.
3. Claude calls `searchWorkspace` to find every match, then
   `stageEdit` once per file (operation `searchReplace`). Nothing on
   disk has changed.
4. Claude calls `getGitStatus` — clean. Confirms staging is in-memory.
5. User reviews the staged diff (Claude prints each
   `(filePath, originalContent → newContent)` pair).
6. **Branch A — discard:** user says "no, undo." Claude calls
   `rollbackTransaction {transactionId:"abc"}` → `{rolledBack: 12}`.
   Workspace untouched.
7. **Branch B — commit:** user says "ship it." Claude calls
   `commitTransaction` → all 12 files written. *Honest caveat:* if
   write 7/12 fails the prior 6 stay written; the response includes an
   `errors` array so the agent can recover.

---

## 8. Delegation Policy reframing plan

### What to rename

- "Approval gate" → **"Delegation Policy"** (user-facing).
  Internally `--approval-gate`, `approvalGate` config field, and
  `approvalQueue` module names can stay; this is a docs/UI rename only,
  not a code rename. Add an alias flag `--delegation-policy` that
  forwards to the same parser, keep `--approval-gate` working
  indefinitely.
- "Risk tier" → keep the term but pair it everywhere with the
  CC-aligned `ToolBehavior` (`readOnly | localWrite | shellExec |
  externalEffect`) already defined in `src/riskTier.ts:29-39`. Users
  understand "this writes a file" better than "tier medium."
- "Approval queue" → **"Pending delegations"** in the dashboard. Code
  identifier stays.

### What to add to the dashboard

`dashboard/src/app/approvals/page.tsx` (and the inbox surface) should,
for each pending item, render:

1. **Mode banner** — "Delegation policy: high" / "all" / "off."
2. **Why this needed approval** — the matched rule + source. Pull from
   `ccPermissions.ts` evaluation result; expose a structured
   `{matchedRule, source, tier}` field on each pending entry.
3. **Tool behavior chip** — `readOnly | localWrite | shellExec |
   externalEffect` (one-word, color-coded).
4. **Past decisions for similar calls** — `ctxQueryTraces({traceType:
   "approval", key: tool})` last 5; surface "approved 27 / rejected 2"
   counts.
5. **Suggested rule** — if user has approved this tool+arg pattern N
   times, surface "auto-approve in future?" CTA that writes a project
   policy entry.

### Five example policy snippets

> Format follows `~/.claude/settings.json` permissions schema (the
> precedence chain Patchwork already honors).

**1. Conservative (default for new install)**
```json
{ "permissions": {
  "allow": ["read*", "get*", "find*", "search*"],
  "ask":   ["editText", "createFile", "gitCommit", "gitPush",
            "githubCreatePR", "sendHttpRequest", "runInTerminal"],
  "deny":  []
}}
```

**2. Developer (loosens local writes, gates anything external)**
```json
{ "permissions": {
  "allow": ["read*", "get*", "find*", "search*",
            "editText", "createFile", "renameSymbol", "formatDocument"],
  "ask":   ["gitPush", "githubCreatePR", "sendHttpRequest",
            "runInTerminal:rm*", "runInTerminal:curl*"],
  "deny":  []
}}
```

**3. Headless CI (no approvals possible — fail closed)**
```json
{ "permissions": {
  "allow": ["read*", "get*", "find*", "search*",
            "editText", "createFile", "runInTerminal:npm*",
            "runInTerminal:pnpm*", "runInTerminal:vitest*"],
  "ask":   [],
  "deny":  ["gitPush", "githubCreatePR", "sendHttpRequest",
            "runInTerminal:rm*", "runInTerminal:curl*"]
}}
```

**4. Regulated industry (managed precedence — user cannot loosen)**
```json
{ "managedPath": "/etc/patchwork/managed.json",
  "permissions": {
    "allow": ["read*", "get*", "find*"],
    "ask":   ["editText", "createFile"],
    "deny":  ["sendHttpRequest", "runInTerminal", "gitPush",
              "githubCreatePR", "*Connector*"]
}}
```
Place at `--managed-settings /etc/patchwork/managed.json`. The
`managed` source overrides project and user (see
`src/ccPermissions.ts:22-97`).

**5. Personal assistant (life automation, mobile-approval default)**
```json
{ "permissions": {
  "allow": ["read*", "get*", "find*", "search*", "ctxQueryTraces"],
  "ask":   ["sendHttpRequest", "editText", "createFile",
            "runRecipe:capture-thought", "runRecipe:morning-brief"],
  "deny":  ["gitPush", "githubCreatePR", "runInTerminal"]
},
  "approvalRoute": "mobile-pwa-push"
}
```

---

## 9. Risks + caveats — claims I cannot fully ground

Listed in priority order. Each is an item that the strategic plan
assumes is true but I either could not verify or found weaker than
described.

1. **"Atomic rollback" of edit transactions is FALSE today.** The
   plan's caveat (line 92-94) is correct but easy for a careless
   marketing pass to revert. `src/tools/transaction.ts:268` and
   handler at lines 304-340 show that `commitTransaction` writes files
   sequentially and on partial failure leaves earlier writes on disk.
   *Fix paths:* (a) market only the pre-commit story (recommended,
   honest); (b) implement true atomicity via temp files + rename
   (write all to `.path.tmp.<txid>` then sequentially `fs.rename`;
   still not atomic across N files but better) or via a journal file
   the bridge replays on next start. Either fix is non-trivial.

2. **Persistent state for transactions does not survive process
   restart.** `transactions = new Map()` lives in module scope
   (transaction.ts:30). Strategic plan's "show active transactions in
   dashboard" implies durability. Today, restarting the bridge silently
   discards all in-flight transactions. Worth disclosing in the docs
   or building a JSONL spool before claiming the dashboard surface.

3. **Stale "not yet wired" message in compiler** (`src/recipes/compiler.ts:167-170`)
   says webhook recipes throw a compile error. They don't, in
   practice — the HTTP path bypasses the compiler — but anyone reading
   the compiler in isolation will reach the wrong conclusion. The
   strategic plan's "Anything Can Trigger Your AI" demo will not be
   blocked by this, but it does undermine code-reading credibility.

4. **Connector count discrepancy.** `documents/platform-docs.md:3`
   says "4 connectors"; `README.md` enumerates 19+ (lines around 165).
   Phase-0 doc-reconciliation is the strategic plan's named
   deliverable; pick a number that's defensible (count what's wired
   in `src/connectors/`) and use it everywhere.

5. **Three CLI binaries (`claude-ide-bridge`, `patchwork`,
   `patchwork-os`)** for one runtime. The plan implicitly wants a
   single product story. Naming all three on the homepage hurts that.
   Recommend: lead with `patchwork`, footnote `claude-ide-bridge` as
   "bridge-only mode for IDE-only users," retire the
   `patchwork-os` alias from docs (binary can stay).

6. **Reference OAuth app does not exist yet.** The "Personal AI API"
   story is real at the protocol level (§2.5) but there is no minimal
   PWA reference app in the repo. The strategic plan calls this out
   in Phase 1 §5 — flagging it again here so it's not assumed
   shippable in the 0–2 week window.

7. **Trust-tier "graduation" terminology is not in the code.**
   Strategic plan's Phase 2 §4 (draft → trusted within scope) has no
   field, table, or trace type today. It's pure greenfield. Ensure
   marketing for the 0–2 week wave does not imply this exists.

8. **"Conversational recipe builder" does not exist.** Strategic
   plan's Phase 2 §1 is greenfield. Today recipes are written by hand
   in YAML (`templates/recipes/*.yaml`). Do not include this in the
   Phase-0 messaging round.

9. **"Activity-based automation suggestions"** (Phase 3 §4) — the
   substrate exists (co-occurrence stats, `ActivityLog`,
   `ctxQueryTraces`), but no surface today suggests "create a recipe
   from this pattern." Greenfield UX work.

10. **Dashboard does not yet show "which rule matched" for an
    approval.** The data is computable from `ccPermissions.ts`, but
    the React surface in `dashboard/src/app/approvals/page.tsx` does
    not render it. §8 of this report assumes that wiring lands as
    part of the Delegation Policy rename — flagging that it's net-new
    UI plus a new field on the pending-approvals API contract.

---

## Appendix — files referenced

| Path | Why |
|---|---|
| `src/pluginWatcher.ts` | Hot reload (§2.1) |
| `src/pluginLoader.ts` | Plugin loading (§2.1) |
| `src/tools/transaction.ts` | Transaction semantics (§2.3, §9.1) |
| `src/riskTier.ts` | Risk tiers (§2.2, §8) |
| `src/ccPermissions.ts` | Policy precedence (§2.2, §8) |
| `src/approvalQueue.ts`, `src/approvalHttp.ts` | Approval surface |
| `src/server.ts:811-849` | Webhook HTTP endpoint (§2.4) |
| `src/recipeOrchestration.ts:263-319` | Webhook dispatch (§2.4) |
| `src/recipes/compiler.ts:167` | Stale webhook error (§9.3) |
| `src/oauth.ts`, `src/oauthRoutes.ts` | OAuth surface (§2.5) |
| `src/config.ts:640, 681, 821` | CLI flags |
| `README.md`, `documents/platform-docs.md` | Current narrative (§1) |

End.
