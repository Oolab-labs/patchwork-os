# Developer Context Platform — Strategy Discussion
*2026-03-26*

---

## Repo Traffic Analysis

**14-day snapshot (Oolab-labs/claude-ide-bridge)**

| Metric | Count |
|--------|-------|
| Total clones | 3,947 |
| Unique cloners | 526 |
| Total views | 799 |
| Unique visitors | 305 |
| Stars | 18 |

**Top referring sites:** github.com (193), direct/126 (99), Reddit (40)

### What 18 stars with 526 cloners tells us

A clone-to-star ratio of ~1:30 (vs typical 1:5–1:10) signals:
- People are finding and using the project, but not in a "discovery mode" context where starring is habitual
- Discovery is push-based (shared links) not pull-based (GitHub search/trending)
- Reddit referrals land people who clone from a link, not from browsing
- The gap is retention and activation, not awareness

---

## Setup Blockers & Optimization

### Top Onboarding Friction Points

1. **Config file confusion** — Claude Code has three scopes (`~/.claude.json`, `.mcp.json`, `.claude/settings.local.json`). Users put bridge config in the wrong file and get silent failures. When VS Code/Windsurf launches Claude Code, it injects `--mcp-config` overriding `.mcp.json` — only `~/.claude.json` works in that flow. Not documented prominently.

2. **Two-step install that feels like three** — Install CLI → install extension → configure port. Every extra step loses ~30% of prospects.

3. **PATH issues on Windows/WSL** — "No available IDEs detected" is the #1 reported error for Claude Code + VS Code combos.

4. **No `/mcp` status awareness** — Many users don't know `/mcp` shows connection state inside a session. They debug blindly and churn.

5. **No output size guards documented** — Block Engineering's production threshold is 400KB with truncation notice. Silent context overflow causes mysterious failures users blame on the tool.

### Activation / Retention Patterns

- **Time to first tool call** is the only metric that matters early. Every minute between `npm install` and first successful response loses users.
- **Tool consolidation** — Block found users abandoned workflows requiring 4+ chained tool calls. Single high-level tools that complete an intent in one call drive stickiness.
- **`init` one-command setup** is table stakes in 2026. The right bar: `npx <tool>` → working.

### Growth Tactics That Work for Dev Tools

- README demo GIF (15s showing `init` → working tool call) — highest-ROI documentation change
- Submit to `awesome-mcp-servers` and `awesome-claude` — steady baseline discovery
- "Building in public" posts about non-obvious technical decisions get more engagement than feature announcements
- r/ClaudeAI, r/vscode — active audiences who star things they bookmark
- Respond to issues within 24–48h — unanswered issues signal abandonment

---

## IDE-Centered Approach to Building

### Why It's the Right Bet Now

- **The IDE is where intent lives** — open files, cursor position, diagnostics, recent changes. An AI that reads that state doesn't need re-briefing.
- **LSP as a free knowledge graph** — type information, references, call hierarchies, diagnostics. Building on LSP inherits years of tooling investment for free.
- **The IDE is already the trust boundary** — developers granted VS Code access to filesystem, terminal, git. Extending that trust to an AI agent is a smaller leap than a new cloud service.

### The Ceiling

- **Single developer, single machine assumption** — CI/CD, code review, deployment, monitoring happen outside the IDE. Strong for "write and iterate," weak for "ship and operate."
- **VS Code dominance isn't permanent** — Cursor, Zed, Windsurf, JetBrains are fragmenting the editor landscape partly because of AI.
- **The IDE is a UI, not a runtime** — agentic long-running tasks don't map cleanly onto a UI-centric model.

### The Right Frame

The IDE-centered approach is really a **context-centered approach** in disguise. The IDE is the richest source of developer context right now — but the real question is: *what is the authoritative source of context for a given task?*

- "Fix this bug" → IDE wins
- "Why did this deploy fail at 3am" → logs, traces, alerts win
- "What should we build next" → product analytics, user feedback win

---

## Developer Context Platform

### The Problem

When a developer fixes a bug, the full picture is scattered across:

| Source | Contains |
|--------|----------|
| IDE | Open files, diagnostics, git diff, terminal |
| Version control | Commit history, blame, PR discussion |
| Issue tracker | Bug report, reproduction steps, linked tickets |
| CI/CD | Which test failed, logs, which commit broke it |
| Observability | Error rates, traces, production stack trace |
| Communication | Slack thread where someone flagged this issue |
| Documentation | ADR explaining why the code is structured this way |

A developer context-switches across all of these mentally. An AI today sees one slice. A platform means the AI has structured, queryable access to all of them simultaneously.

### What Makes It a Platform vs. a Tool

| Tool | Platform |
|------|----------|
| "Read this file" | "Here's what changed in this file across the last 3 PRs and why" |
| "Run this test" | "This test has been flaky 2 weeks, here are the 4 commits that touched it" |
| "Fix this error" | "This error appeared in prod 3 hours after this deploy, here's the diff" |

The platform knows **provenance** — where something came from, when it changed, who decided it, and what else it's connected to.

### Why MCP Is the Right Primitive

MCP is a standardized interface for plugging context sources into an AI agent. Each server is a context node:

- `claude-ide-bridge` → IDE context
- GitHub MCP → PR and issue context
- Datadog MCP → observability context
- Linear MCP → project context
- Confluence MCP → documentation context

The platform emerges when these nodes are **composed** — when the agent can cross-reference a failing test in the IDE with the CI log with the Slack thread that flagged the regression.

---

## Platform Architecture

```
┌─────────────────────────────────────────────────────┐
│                   AI Clients                         │
│         Claude Code · Cursor · Copilot               │
└──────────────────────┬──────────────────────────────┘
                       │ MCP (single endpoint)
┌──────────────────────▼──────────────────────────────┐
│            Context Platform Layer                    │
│   Aggregation · Enrichment · Persistence · Routing  │
└──────┬──────────┬───────────┬──────────┬────────────┘
       │          │           │          │
  ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌──▼──────┐
  │  IDE   │ │  Code  │ │Runtime │ │  Org    │
  │Context │ │Context │ │Context │ │Context  │
  └────────┘ └────────┘ └────────┘ └─────────┘
```

### What the Platform Does

**1. Context Aggregation**
One MCP endpoint federating N upstream servers.
```
getTaskContext(issue: "LIN-492") →
  {
    issue: { title, description, comments },
    relatedCode: { files, recent_commits, blame },
    incidents: { last_3_sentry_errors_in_affected_files },
    owner: { team, oncall, slack_channel },
    history: { similar_bug_fixed_6mo_ago, pr_link, decision_note }
  }
```

**2. Context Enrichment**
- Links a Sentry error to the commit that introduced it
- Connects a Linear ticket to the files it touches
- Tags context with freshness ("this ADR is 14 months old, the code it describes has changed")
- Scores relevance — surfaces the 2% that matters for this task

**3. Context Persistence (the moat)**
Accumulates decision traces that survive session boundaries:
- "This file was refactored to fix a race condition — see PR #847"
- "Service B's schema change is the upstream cause of this recurring error"
- "Team agreed in Slack not to use this pattern — see thread"

Individual MCP servers are commodities. Accumulated, structured, team-specific decision history is defensible.

**4. Intelligent Routing**
Pre-fetches relevant sources based on task type — so the agent doesn't burn tokens querying irrelevant tools.

---

## Build Phases

### Phase 1 — Federation Layer
**Goal:** Single MCP endpoint, multiple upstream servers

- Build on claude-ide-bridge's existing orchestrator architecture
- Add upstream MCP server connectors (GitHub, Linear, Sentry as first three)
- Implement `getTaskContext(ref)` — unified tool cross-referencing ticket/issue/error across all sources
- Ship as new mode: `--platform`

### Phase 2 — Enrichment Engine
**Goal:** Context that's connected, not just collected

- Commit-to-issue linker: match Sentry errors to the commit that introduced them
- File-to-ticket mapper: given a file path, find all open issues touching it
- Freshness scoring: flag stale ADRs, outdated docs, deprecated APIs
- Deduplication: normalize overlapping events from multiple tools

### Phase 3 — Persistence Layer (the moat)
**Goal:** Context that accumulates across sessions

- Decision trace store: every resolved task writes a structured trace
- Cross-session retrieval: new sessions query trace store before querying upstream tools
- Team-scoped: traces owned by workspace/org, not individual developer
- Storage: SQLite locally → hosted when multi-user

### Phase 4 — Hosted Platform
**Goal:** Multi-team, zero-install, cloud-native

- Hosted context platform endpoint per team
- OAuth-based upstream connections
- Team trace sharing
- Access control by team membership
- Analytics: which context sources are most useful, where agents get stuck

**Business model:** free tier (local, single developer) → paid tier (hosted, team traces, analytics)

---

## Competitive Landscape

### Who's Doing Adjacent Things

**MetaMCP / ContextForge / MCP Gateway Registry**
*Closest in architecture, furthest in ambition*
MCP proxies — one endpoint, N upstream servers. Phase 1 only. No enrichment, no persistence, no relevance ranking. Everything flows through but nothing accumulates.

**Faros AI**
*Best data model, wrong delivery mechanism*
"Engineering Graph" unifying GitHub, Jira, PagerDuty, CI/CD. Closest thing to a developer context graph. Problem: it's a BI/analytics dashboard, not agent-consumable, not real-time, no MCP interface. Right data, wrong surface.

**PlayerZero** ($15M, Foundation Capital)
*Right problem, narrow scope*
Connects production errors to the code that caused them. Narrow: incident-to-code linkage only. No IDE context, no org context, no persistence layer.

**Augment Code** ($227M)
*Deep code context, nothing else*
200K+ token window, semantic indexing of entire codebase. Wins on code context depth. Stops at code — no incident, ticket, team knowledge, or decision traces.

**Graphite** ($52M, Anthropic-backed)
*Code review context only*
"Diamond" AI engine understands PR context deeply. Scoped to PR workflow, doesn't escape to broader dev workflow.

**Port** ($100M Series C, $800M valuation)
*Internal developer platform, not context*
Service catalog, self-service workflows. Has org context (who owns what) but solving developer autonomy, not AI agent context.

**Sourcegraph Cody**
*Code context only, model-agnostic*
Best-in-class for semantic code search across multi-repo codebases. Explicitly code-only.

### The Map

```
                    HIGH CONTEXT DEPTH
                           │
           Augment Code    │    [The Gap]
           (code only)     │    (cross-tool +
                           │     persistent)
                           │
SINGLE ────────────────────┼──────────────────── CROSS-TOOL
TOOL                       │                     CONTEXT
                           │
           Graphite        │    Faros AI
           (PR scope)      │    (analytics,
                           │     not agent)
                           │
                    LOW CONTEXT DEPTH
```

The top-right quadrant — deep, cross-tool, persistent, agent-consumable context — is empty.

### The Real Risk
Not competition — timing. Anthropic, Microsoft, or Google could ship a first-party "universal context layer" and commoditize the federation layer. The hedge is the persistence layer: first-party tools won't accumulate your team's specific decision history. That's too opinionated, too specific, too much of a liability for a model provider to own.

**Window: 12–18 months** before federation gets solved by defaults. Persistence and enrichment need to be far enough along by then.

---

## Recommendation

### Don't Build the Platform Yet — Build the On-Ramp

The platform vision is correct but it's a 2-3 year build. The trap: building infrastructure before knowing what context people actually need.

**The data needed to build the platform correctly is locked inside the sessions of the 500 people who've cloned the bridge. Get it first.**

### Step 1 — Nail the Setup (4-6 weeks)
- Make `init` bulletproof — one command, works, no ambiguity
- Add post-init verification confirming tools are visible in Claude Code
- Write clear "Why your tools aren't showing up" troubleshooting doc
- Add config file callout box prominently in README

### Step 2 — Get a Distribution Moment (2-4 weeks)
- Ship 15-second README GIF showing `init` → working tool call
- Submit to `awesome-mcp-servers` and `awesome-claude`
- Write one "building in public" post on a non-obvious technical decision
- Engage authentically in r/ClaudeAI

**Target: 200 stars.** That's the threshold where organic discovery starts compounding.

### Step 3 — Instrument Context Usage (ongoing)
- Opt-in telemetry: which tools are called most, which fail, which are called together
- Session feedback: "was the context you had enough?"
- Watch GitHub issues for "I wish I could also see X" patterns

This data tells you which Phase 1 federation targets matter.

### Step 4 — Ship One Platform Primitive (3 months out)
Best candidate: **GitHub + IDE**
`getTaskContext(issue_url)` returning the issue, related files, recent commits, and open PRs. No new infrastructure — cross-referencing two sources already reachable.

### The Decision Tree

```
Do you have product-market fit signal?
  └─ No (18 stars, unknown retention) → Fix setup, grow base, instrument
  └─ Yes (200+ stars, active community, daily usage) → Build platform
```

### The One Metric That Changes Everything

**Weekly active sessions per user.**

If people run `claude` with the bridge daily, the context gap is real — they'll want the platform. If people install, use once, and stop — the problem isn't context depth, it's something else.

### Roadmap Summary

| Now | 3 months | 6-12 months |
|-----|----------|-------------|
| Fix `init` + onboarding | 200+ stars, active community | Platform Phase 1 if signal is there |
| README GIF + distribution | Instrumentation live | One cross-tool integration (GitHub + IDE) |
| Respond to every issue | Weekly active session data | Persistence layer design |

The platform is the right destination. The route there goes through nailing the fundamentals first.
