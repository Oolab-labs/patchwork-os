# Plan: Make Patchwork OS Legible as a Personal AI Runtime

> Source: external strategic-planning input, 2026-05-02. Captured here as the canonical
> brief for the Positioning, Recipe Lifecycle, and Memory/Ecosystem planning agents.
> Some claims may be aspirational — agents must verify against code before designing.

## Executive thesis

Stop presenting Patchwork OS primarily as "developer automation" or "AI that works while
you sleep." Reframe as:

> **A local-first personal AI runtime with tools, recipes, approval policy, trace
> memory, and pluggable model providers.**

The repo already supports much of this thesis:

- **Plugin hot reload exists** — `--plugin-watch`, `PluginWatcher`, dynamic reload.
- **Recipe/webhook/orchestration primitives exist** — webhook-triggered YAML recipes,
  chained recipes, run logs, replay, dashboard run surfaces.
- **Approval gates and risk controls exist** — `--approval-gate`, policy config,
  dashboard approvals, audit events.
- **Trace and activity substrates exist** — `decision_traces.jsonl`, `ctxQueryTraces`,
  `ActivityLog`, co-occurrence stats, recent digest injection.
- **OAuth/VPS/personal API direction exists** — `--issuer-url`, PKCE, bearer auth,
  CORS controls.

The opportunity is to **package, connect, and productize** these primitives.

---

# Phase 0 — Reality check + messaging cleanup

## Goal

Separate what is shipped from what is implied or aspirational. Adopt a single
positioning sentence.

## Deliverables

- **Feature inventory**: built+marketable / built+needs-UX / partial / not built.
- **Docs reconciliation**: connector counts, marketplace status, lazy/deferred tools,
  dashboard observability claims.
- **Positioning decision**: pick one canonical phrase.
  - Personal AI Runtime
  - Local-first AI delegation platform
  - Policy-controlled AI automation layer

## Success criteria

A user does not need to read source to understand why Patchwork is structurally
different from "another MCP server."

---

# Phase 1 — Surface buried power features

## 1. Live Toolsmithing

> Write tools while the AI is running.

Plugin hot reload (`--plugin-watch`) enables Claude to author a tool, save it, and
have the running session pick it up.

- **Docs**: `Build a tool while Claude is running`, `Hot-reloadable plugins`,
  `Turn a local script into an AI tool`.
- **Demo**: User asks for missing capability → Claude writes plugin → reload → same
  session calls the new tool.
- **Starter template**: minimal plugin manifest, one example tool, TS + JS variants.

**Priority: HIGH.** Strong differentiator vs. ordinary MCP servers.

## 2. Delegation Policy (not just "approval gates")

> Define what AI may do, what needs approval, and what is forbidden.

- **Docs**: first delegation policy, auto-approve safe, require approval for risky,
  block dangerous, policy precedence (managed/project/user).
- **Dashboard**: show active mode, show why an action required approval, show matched
  rule + risk tier.
- **Examples**: conservative, developer, headless CI, regulated-industry,
  personal-assistant.

**Priority: HIGH.** Trust foundation for everything else.

## 3. Reversible Agentic Refactoring

> Let agents attempt large edits without committing to disk immediately.

The transaction system should be elevated from tool documentation to a headline
trust feature.

- **Caveat**: current implementation stages edits without disk writes, but the commit
  path needs review before claiming "perfect atomic rollback." Market the safer
  workflow accurately: "stage, inspect, commit, or discard before touching disk."
- **Docs**: safe multi-file edits, speculative refactors, rollback-first agent
  workflows.
- **Workflow**: agent starts transaction → stages edits → user reviews diff → tests
  run → commit or rollback.
- **Dashboard/CLI**: show active transactions, staged file list, TTL,
  commit/rollback controls.

**Priority: MEDIUM-HIGH.** Powerful for developers; less relevant to non-developer
expansion.

## 4. Anything Can Trigger Your AI

> Any device that can send HTTP can become an AI input.

Webhook recipes are the bridge from developer automation to physical-world / life
automation.

- **Examples**: iPhone Shortcut, Stream Deck, Home Assistant, NFC tag, `curl`.
- **Templates**: morning brief, capture thought, meeting prep, incident intake,
  customer escalation.
- **Dashboard**: copyable webhook URL, last payload, test webhook button, example
  request.

**Priority: HIGH.** Easiest path into non-code use cases.

## 5. Personal AI API

> Run your own OAuth-protected AI middleware.

`--issuer-url` + OAuth → "build private apps against your own bridge."

- **Docs**: deploy as personal AI API, authenticate with OAuth, build a private app,
  expose recipes safely from a VPS.
- **Reference app**: minimal PWA — auth, list recipes, run recipe, show approvals.

**Priority: MEDIUM-HIGH.** Opens a new platform story; needs security-polished docs.

---

# Phase 2 — Build the missing recipe lifecycle

## Goal

Move recipes from static YAML files to living automations.

## Current gap

```text
write YAML → run → inspect manually
```

Desired:

```text
describe → generate → validate → dry-run → install → observe → refine → trust-graduate
```

## 1. Conversational Recipe Builder

User says: *"When I get a support email from a VIP customer, summarize it, find
related Linear issues, draft a response, and ask before sending."*

Patchwork responds with: generated recipe, plain-English explanation, required
connectors, risk summary, dry-run preview, install button.

- Recipe-builder command/tool that converts NL → YAML.
- Validate against schema, surface missing connectors/env, save only after explicit
  approval.

**Priority: VERY HIGH.** Non-developer onboarding unlock.

## 2. Recipe Dry-Run UX

First-class user interface, not just CLI/debug.

Show: trigger, input variables, rendered prompts, planned tool calls, approval
points, expected outputs, mocked vs real side-effect risk.

**Priority: HIGH.** Trust requires preview.

## 3. Recipe Run Timeline (causal observability)

```text
Webhook received
  → recipe A started
    → step 1 completed
    → step 2 requested approval → approved from phone
    → recipe B triggered
      → step 1 failed
```

Connect `RecipeRunLog`, `ActivityLog`, approval decisions, chained recipe metadata.
Run-detail timeline. Parent/child run links. Tool-call ↔ recipe-step links.

**Priority: VERY HIGH.** Chained recipes are untrustworthy without this.

## 4. Recipe Trust Graduation

```text
Draft → Manual Run → Ask Every Time → Ask on Novel Cases → Mostly Trusted → Fully Trusted Within Scope
```

- Trust state per recipe.
- Approval/rejection history per recipe.
- Policy suggestions based on history.
- Explicit user opt-in before reducing approval friction.

**Priority: MEDIUM-HIGH.** Connects automation quality to trust.

## 5. Recipe Variants

Duplicate as variant → A/B dry-run → compare outputs → promote → archive old.

**Priority: MEDIUM.** Useful after lifecycle basics exist.

---

# Phase 3 — Turn logs into memory, replay, personalization

## Goal

Make Patchwork's logs compound in value over time.

## 1. Trace Backup and Sync

Local JSONL is durable enough for a session, not for years. Export, import,
encrypted backup, optional Git-backed sync, optional S3-compatible target,
conflict-safe JSONL merge.

**Priority: HIGH.** If traces are a moat, they need durability.

## 2. Decision Replay Debugger

> "What would have happened if this new policy had been active last Tuesday?"

Replay past approvals/recipes against captured inputs. No side effects by default.
Diff old vs new. Explicit warnings for unmocked tools.

**Priority: MEDIUM-HIGH.** Differentiated safety feature.

## 3. Passive Risk Personalization

**Start simple. Do not begin with fine-tuning.** Transparent heuristics:

- "You approved similar actions 27 times."
- "You rejected this tool in this context before."
- "This recipe has never sent email before."
- "First use of this connector."

Later: local models for approval classification.

**Priority: MEDIUM.** Powerful but should follow durability + observability.

## 4. Activity-Based Automation Suggestions

Use existing co-occurrence data:

- "You often call X after Y. Create a recipe?"
- "These tools commonly appear together."
- "This installed tool is unused."
- "This repeated manual workflow could be automated."

**Priority: MEDIUM.** Growth loop.

---

# Phase 4 — Expand beyond developer automation

## Targets

### 1. Regulated professionals (medicine, law, journalism, security, finance, gov)

Message: *"AI automation where your data, credentials, and policy stay under your control."*

Needs: compliance docs, local/Ollama path, credential storage explanation, audit log
explanation, no-SaaS deployment guide.

### 2. Power users / life-automation (quantified self, Home Assistant, Stream Deck, iOS Shortcuts, PKM)

Message: *"Connect your real life to your personal AI runtime."*

Needs: webhook recipes, mobile-friendly approvals, simple templates, no-YAML authoring.

### 3. Indie hackers (private tools, single-user apps, AI workflows over own data)

Message: *"Your own OAuth-protected AI backend."*

Needs: reference app, hosted/VPS guide, API docs, recipe execution API examples.

---

# Phase 5 — Marketplace and ecosystem

## Goal

Turn recipes and plugins into distributable capability bundles.

## Current substrate (already exists, partial)

Plugin manifests, npm-distributed plugins, marketplace commands, recipe registry,
dashboard marketplace code, install flows.

## Work

### 1. Clarify marketplace types

- **Plugins** — add tools/capabilities.
- **Recipes** — add workflows/automations.
- **Policies** — add delegation settings.
- **Bundles** — plugin + recipes + policy template + docs.

### 2. Capability bundle format

```text
gmail-vip-support/
  plugin requirement
  recipes/
  policy-template
  connector requirements
  README
  screenshots
```

### 3. Trust metadata

Required tools, required connectors, risk level, approval behavior, network access,
file access, maintainer, version.

**Priority: MEDIUM.** Ecosystem story matters but only after authoring +
observability are credible.

---

# Recommended roadmap

## 0–2 weeks: positioning + proof

- Rewrite top-level messaging — personal AI runtime, delegation policy, local-first,
  webhook/device triggers, hot-reloadable tools.
- Publish 3 demos: Live Toolsmithing; iPhone Shortcut → webhook recipe → approval;
  safe multi-file refactor with transaction rollback.
- Fix docs mismatch: connector counts, marketplace status, lazy/deferred tools,
  recipe observability claims.

## 2–6 weeks: recipe lifecycle MVP

- Conversational recipe builder (NL → YAML, validate, dry-run, save/install).
- Run timeline (recipe run, steps, tool calls, approvals, parent/child links).
- Webhook UX (copy URL, test payload, last payload, examples).

## 6–10 weeks: trust + memory

- Trace export/import + encrypted backup option.
- Approval insight layer (similar prior approvals, repeated safe actions, novel
  risk warnings).
- Recipe trust states (draft / ask every time / semi-trusted / trusted within scope).

## 10–16 weeks: platform expansion

- Reference OAuth app (PWA).
- Capability bundle format.
- Marketplace polish (risk metadata, connector requirements, install preview).

---

# Highest-leverage first moves

If only five things ship:

1. **Rename the story** — from "AI that works while you sleep" → "your personal
   AI runtime."
2. **Live Toolsmithing demo** — visually obvious, technically differentiated.
3. **Conversational recipe authoring** — non-developer onboarding.
4. **Causal run timelines** — make chained recipes trustworthy.
5. **Approval policy as delegation policy** — turn safety mechanism into core
   product primitive.

---

# Final summary

Patchwork OS already has the hard primitives: tools, plugins, recipes, approval
gates, traces, OAuth, webhooks, model abstraction, local-first execution.

The plan is **not "add more connectors."** The better plan:

- Clarify the thesis.
- Surface hidden primitives.
- Build the recipe lifecycle.
- Make logs durable and useful.
- Package policies, plugins, recipes as a personal AI runtime ecosystem.

The biggest product gap is **legibility**, not engineering depth.
