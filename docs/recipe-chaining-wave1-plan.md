# Recipe Chaining MVP + Curated Provider Wave 1 — Agent Plan

**Goal:** Enable recipes to chain outputs as inputs, creating composable automation. Ship Wave 1 providers prioritized by leverage, demand, and MCP quality.

**Wave 1 providers:** Notion/Confluence, Jira, PagerDuty, Drive, Docs, Zendesk  
**Prioritization:** Recipe leverage → Customer demand → MCP availability/quality → Auth/maintenance complexity  
**MCP presence is important, but not the first filter.**

Produced by multi-agent review of codebase state (v2.30.1 · 2026-04-22).

---

## Context

### What exists today

- **Recipe system** (`src/recipe/`) — YAML-defined workflows with `trigger`, `steps`, `on_error`. Steps support `agent: true` (LLM-driven) or `tool: <name>` (direct tool call).
- **Provider drivers** (`src/drivers/`) — `subprocess | api | openai | grok | gemini` abstraction. Multi-model parity achieved.
- **Connectors** — Sentry (read-only), Linear (read+write), Google Calendar (read), Slack (read+write). Each implements `Connector` interface with MCP tool exposure.
- **Approval gate** — `src/approvalHttp.ts` + dashboard. Any destructive step can require approval.
- **Mobile oversight** — push notifications to phone with tap-to-approve (shipping in parallel track).

### What's missing for recipe chaining

1. **Output→input plumbing** — Steps declare outputs; subsequent steps reference them via template syntax (`{{steps.N.output.field}}`).
2. **Recipe-to-recipe calls** — A step type `recipe: <name>` that invokes another recipe with args, respecting the same approval/risk model.
3. **Conditional branching** — `when: "{{steps.N.output.count}} > 0"` predicates on step results.
4. **Error boundaries** — Per-step `on_error: continue | abort | fallback_step` (currently global only).

### Provider landscape (Wave 1)

| Provider | MCP Servers | Auth | Maintenance | Recipe Leverage | Customer Demand |
|----------|-------------|------|-------------|-----------------|-----------------|
| **Jira** | Official Atlassian MCP, 2+ community | OAuth 2.0, API token | Medium — stable APIs | **High** — issue triage, sprint planning, release notes | **High** — standard in eng teams |
| **Notion** | 3+ community servers, varying quality | OAuth 2.0, internal token | Medium — API changes 1-2x/yr | **High** — wiki docs, specs, meeting notes → Linear/Jira | **High** — product/eng bridge |
| **Confluence** | Limited community, often paired with Jira | Same as Jira (Atlassian) | Low if Jira done | Medium — legacy docs, ADRs | Medium — enterprise holdover |
| **PagerDuty** | Official PagerDuty MCP | OAuth 2.0 | Low — mature, stable | **High** — oncall handoff, incident→Linear, auto-remediation | **High** — ops-critical |
| **Google Drive** | Official Google Drive MCP | OAuth 2.0 (Google verification req'd) | Low — Google standard | Medium — file search, doc sync | Medium — docs more relevant |
| **Google Docs** | Via Drive MCP or dedicated | OAuth 2.0 | Low — same as Drive | Medium — meeting notes extraction, specs | Medium — Notion replacing |
| **Zendesk** | Official Zendesk MCP, 1 community | OAuth 2.0, API token | Medium — API v2 stable | Medium — support ticket → engineering issue | Medium — support teams |

**Prioritization conclusion:** Jira → Notion → PagerDuty are the top 3. Drive/Docs follow (Google verification already in flight). Confluence bundles with Jira work. Zendesk deferred to Wave 1.5 (demand present but lower leverage).

---

## Agent 1 — Recipe Chaining Engine

**Owner:** Core platform / backend

### What to build

#### 1. Output registry (`src/recipe/outputRegistry.ts`)

In-memory registry per recipe run (no persistence needed for MVP):

```typescript
type StepOutput = {
  stepId: string;
  status: 'success' | 'error' | 'skipped';
  data: unknown;
  metadata: {
    startedAt: Date;
    completedAt: Date;
    model?: string;        // if agent step
    tokenUsage?: number;   // if agent step
  };
};

class OutputRegistry {
  set(stepId: string, output: StepOutput): void;
  get(stepId: string): StepOutput | undefined;
  resolveTemplate(template: string): string;  // {{steps.fetch.data.issues}}
}
```

Template resolution rules:
- `{{steps.<id>.data}}` — full output object (serialized)
- `{{steps.<id>.data.<path>}}` — lodash-style path get
- `{{steps.<id>.metadata.tokenUsage}}` — introspection
- Missing paths resolve to `""` (empty string) with warning log

#### 2. Recipe runner refactor (`src/recipe/runner.ts`)

Current: linear step execution. New: dependency graph.

```typescript
type StepDependency = {
  stepId: string;
  awaits: string[];  // step IDs that must complete first
};

function buildDependencyGraph(steps: RecipeStep[]): StepDependency[];
async function executeParallel(dependencies: StepDependency[]): Promise<void>;
```

Execution semantics:
- Steps with no `awaits` run immediately (parallel up to `maxConcurrency`, default 4)
- Steps with `awaits` block until all deps complete
- `when` condition evaluated at scheduling time; if false, step marked `skipped`

#### 3. Recipe-as-step (`src/recipe/nestedRecipeStep.ts`)

New step type:

```yaml
steps:
  - id: triage
    recipe: sentry-to-linear
    vars:
      SENTRY_ISSUE_ID: "{{steps.parse_webhook.data.issueId}}"
      LINEAR_TEAM_KEY: "ENG"
    output: triage_result   # becomes {{steps.triage.data}}
    risk: medium
```

Implementation:
- Loads target recipe YAML at runtime
- Creates child `OutputRegistry` (isolated from parent)
- Maps `vars` via template resolution against parent registry
- Child runs with same approval gate / risk policy
- On completion, parent's `triage_result` = child recipe's final output
- **Deep limit: configurable via `BridgeConfig.recipeMaxDepth` (default 3, min 1, max 5)**
- **If child has higher risk than parent, escalates to child's risk tier**

#### 4. Conditional syntax (`when`)

```yaml
steps:
  - id: summarize
    when: "{{steps.fetch.data.issues.length}} > 0"
    agent: true
    prompt: "Summarize: {{steps.fetch.data.issues}}"
```

Expression engine (`src/recipes/templateEngine.ts` — **IMPLEMENTED**):
- Pure AST-based evaluator — **no `vm2`, no `eval`, no Function constructor**
- Access to `steps.<id>.data`, `steps.<id>.status`, `env.<key>`
- Template pre-compilation: `compileTemplate()` parses `{{}}` once, evaluates many
- Path resolution: `{{steps.X.data.field.subfield}}` — lodash-style path walking
- Missing paths resolve to `""` (empty string) with warning log
- Syntax error → compile-time error with clear message

### Testing

- Unit: template resolution with nested objects, arrays, edge cases (null, undefined)
- Unit: dependency graph construction (cycle detection → throw)
- **Unit: template injection attempts (confirm no code execution possible)**
- Integration: 5-step recipe with 2 parallel branches joining
- E2E: `recipe-a` calls `recipe-b`, verify output propagation
- **E2E: `--dry-run` produces valid execution plan without side effects**

---

## Agent 0 — Infrastructure (ships before Agents 1-5)

**Owner:** Platform team

### BaseConnector extraction (`src/connectors/baseConnector.ts` — **IMPLEMENTED**)

Before building 6 new connectors, extract shared patterns:

```typescript
export abstract class BaseConnector {
  abstract readonly providerName: string;
  abstract authenticate(): Promise<AuthContext>;
  abstract healthCheck(): Promise<{ ok: boolean; error?: ConnectorError }>;
  abstract normalizeError(error: unknown): ConnectorError;
  abstract getStatus(): ConnectorStatus;

  // Shared: token refresh, rate limit backoff, retry logic
  protected async apiCall<T>(fn: (token: string) => Promise<T>): Promise<...>;
}
```

**Benefits:** Prevents auth drift, unifies error handling, enables health monitoring.

### Dry-run mode (`--dry-run` flag)

`patchwork-os run-recipe --dry-run`:
- Parses and validates all templates at load time
- Checks step dependencies for cycles
- Validates all step refs exist
- Reports which connectors would be called (no actual API calls)
- Outputs execution plan as JSON for inspection

**Purpose:** Debug chained recipes before they touch live Jira/PD.

---

## Agent 2 — Jira Connector

**Owner:** Connectors team

### Why first

Highest recipe leverage + customer demand. Jira tickets are the bridge between:
- Sentry errors → Jira bugs
- Linear issues → Jira (enterprise migration)
- PagerDuty incidents → Jira war room tickets
- GitHub PRs → Jira linked issues

### Scope

**Read tools:**
- `jira.fetchIssue(issueId: string)` — full issue, comments, status
- `jira.searchIssues(jql: string, max: number)` — JQL query
- `jira.listProjects()` — project picker
- `jira.getBoards(projectKey: string)` — for sprint planning

**Write tools (approval-gated):**
- `jira.createIssue(params)` — project, summary, description, type, priority, labels
- `jira.updateStatus(issueId, transitionId)` — e.g., "In Progress" → "Done"
- `jira.addComment(issueId, body)`

**Recipe steps:**
- `jira.list_issues` — search with JQL
- `jira.create_issue` — create from template

### Auth

- **Cloud:** OAuth 2.0 (Atlassian Connect) — `secrets.set jira.oauthToken`
- **Server/Data Center:** API token + email — `secrets.set jira.apiToken`, `secrets.set jira.email`
- Auto-detect cloud vs server by `instanceUrl` pattern

### MCP evaluation

| Server | Quality | Notes |
|--------|---------|-------|
| `atlassian-labs/mcp-server-jira` (official) | Good | Active, documented, JQL support |
| `tdg5/richierocks-jira` | Medium | Community, feature gaps |

**Decision:** Build direct connector using Atlassian REST API v3. Reference the official MCP for schema design, but don't proxy through it — we need approval gate integration and unified error handling.

### Testing

- Mock server with `nock` for read tools
- Live test against `sandbox.atlassian.net` project for write tools (token in `~/.patchwork/test-secrets.json`, gitignored)

---

## Agent 3 — Notion Connector

**Owner:** Connectors team

### Why second

Notion is the wiki/docs layer that feeds into engineering systems. Key recipes:
- "PRD → Linear issues" — parse Notion doc, create Linear tickets
- "Meeting notes → action items → Jira" — extract TODOs, create tickets
- "Spec → implementation checklist" — notion outline → Linear sub-issues

### Scope

**Read tools:**
- `notion.fetchPage(pageId: string)` — blocks, properties
- `notion.search(query: string)` — text search across workspace
- `notion.queryDatabase(databaseId: string, filter?: object)` — structured tables

**Write tools:**
- `notion.createPage(parent, properties, blocks)` — append to database or page
- `notion.updatePage(pageId, properties)` — status, assignee, etc.
- `notion.appendBlocks(pageId, blocks[])` — meeting notes, comments

**Recipe steps:**
- `notion.search_pages`
- `notion.fetch_database`
- `notion.create_page`

### Auth

- Notion integration token (internal) — `secrets.set notion.token`
- OAuth 2.0 (public) — deferred until hosted OAuth broker ships

### MCP evaluation

| Server | Quality | Notes |
|--------|---------|-------|
| `sueka/mcp-notion-server` | Good | Complete, pagination correct |
| `domwitte/mcp-notion` | Medium | Simpler, some gaps |

**Decision:** Build direct. Notion API is RESTful and well-documented. Need rich block parsing for recipe leverage (extracting TODOs, headings).

### Testing

- Notion "integration" test workspace with known page structure
- Test database with typed properties (select, multi-select, date, person)

---

## Agent 4 — PagerDuty Connector

**Owner:** Connectors team

### Why third

Ops-critical. Enables:
- "Incident fired → create Linear ticket → page oncall if P1"
- "Oncall handoff summary" — who's oncall now, recent incidents
- "Auto-remediation approval" — recipe proposes action, oncall approves via phone

### Scope

**Read tools:**
- `pagerduty.fetchIncident(id: string)` — details, status, assignee
- `pagerduty.listIncidents(params)` — filter by status, service, urgency
- `pagerduty.getOncall(scheduleId: string)` — who's oncall now
- `pagerduty.listServices()` — service picker

**Write tools:**
- `pagerduty.createIncident(serviceId, title, body, urgency)` — P1/P2 creation
- `pagerduty.updateStatus(incidentId, status)` — acknowledge, resolve
- `pagerduty.pageUser(userId, message)` — manual page override

**Recipe steps:**
- `pagerduty.list_incidents`
- `pagerduty.get_oncall`
- `pagerduty.create_incident`

### Auth

- API key (read-only or full) — `secrets.set pagerduty.apiKey`
- OAuth 2.0 for user-scoped actions — deferred

### MCP evaluation

| Server | Quality | Notes |
|--------|---------|-------|
| `PagerDuty/mcp-server-pagerduty` (official) | Excellent | Official, complete |

**Decision:** Build direct, but reference official MCP heavily. PagerDuty's API is smaller surface area; official server proves the schema.

### Testing

- PagerDuty sandbox account (free tier)
- Test incident creation with `urgency: low` only

---

## Agent 5 — Drive + Docs Connector

**Owner:** Connectors team

### Why fourth/fifth

Google verification is already in flight for Gmail. Drive/Docs reuse the same OAuth app, minimal incremental work.

### Scope

**Drive tools:**
- `drive.searchFiles(query: string, mimeTypes?: string[])` — find docs by name/content
- `drive.getFile(fileId: string)` — metadata, download URL
- `drive.exportDocument(fileId, mimeType: 'text/plain' | 'text/html' | 'application/pdf')`

**Docs tools:**
- `docs.getDocument(docId: string)` — structured content (paragraphs, tables)
- `docs.extractText(docId: string)` — plain text for LLM consumption

**Recipe steps:**
- `drive.find_documents`
- `docs.read_document`

### Auth

Reuse existing Gmail OAuth flow. Add `https://www.googleapis.com/auth/drive.readonly` scope.

### MCP evaluation

| Server | Quality | Notes |
|--------|---------|-------|
| `modelcontextprotocol/servers/google-drive` | Good | Official, maintained |

**Decision:** Build direct. Drive API is standard REST; we need export functionality for text extraction.

### Testing

- Same test Google account as Gmail connector
- Test documents with tables, headings, comments

---

## Agent 6 — Integration, Recipe Templates, and Chained Examples

**Owner:** QA / product

### Chained recipe templates

Ship 3 end-to-end chained recipes to validate the engine:

**1. `incident-war-room.yaml`** (PagerDuty + Linear + Slack)
```yaml
# On PagerDuty incident trigger:
# 1. Fetch incident details
# 2. Create Linear ticket with incident context
# 3. Post to #incidents channel with both links
# 4. If P1, page additional oncall via PagerDuty
```

**2. `spec-to-tickets.yaml`** (Notion + Linear)
```yaml
# Given Notion PRD URL:
# 1. Fetch PRD content
# 2. Agent extracts implementation tasks
# 3. Create Linear tickets for each task
# 4. Update Notion page with "Tracked in Linear" links
```

**3. `sprint-review-prep.yaml`** (Jira + Linear + Notion)
```yaml
# Weekly cron:
# 1. Fetch Jira done tickets from current sprint
# 2. Fetch Linear done issues
# 3. Agent synthesize summary
# 4. Append to Notion "Sprint Reviews" database
```

### E2E test

`src/__tests__/recipeChaining.e2e.test.ts`:
1. Register mock connectors (Jira, Notion, PagerDuty stubs)
2. Run `spec-to-tickets` with fixture Notion page
3. Assert: 3 Linear tickets created with correct titles
4. Assert: Notion page updated with Linear links
5. Verify all 4 steps completed, outputs chained correctly

### Dashboard updates

- `/recipes` page: show "Chained" badge on recipes that call other recipes
- Recipe run detail: visual graph of step dependencies
- Output inspector: click step → see resolved template values

---

## Dependency Order

```
Agent 0 (BaseConnector + dry-run mode)
    │
    ▼
Agent 1 (Chaining Engine)
    │
    ├──► Agent 2 (Jira) ──┐
    │                      │
    ├──► Agent 3 (Notion) ──┼──► Agent 6 (Integration + Recipes)
    │                      │
    ├──► Agent 4 (PagerDuty)
    │
    └──► Agent 5 (Drive/Docs) ──► (shares OAuth with existing Gmail)
```

- **Week 0 (Days 1-2):** Agent 0 — `BaseConnector` extraction, dry-run mode
- **Week 1:** Agent 1 (chaining engine) + Agent 2 (Jira) in parallel
- **Week 2:** Agent 3 (Notion) + Agent 4 (PagerDuty) in parallel
- **Week 3:** Agent 5 (Drive/Docs) + integration recipes
- **Week 4:** E2E tests, dashboard polish, docs

---

## Success Criteria

- [ ] Template resolution works for `{{steps.X.data.field.subfield}}` paths
- [ ] 5-step recipe with 2 parallel branches completes in <10s (local, no LLM)
- [ ] `recipe-a` calling `recipe-b` propagates outputs correctly
- [ ] Jira connector: can create issue, update status, add comment (gated)
- [ ] Notion connector: can extract TODOs from page, create pages in database
- [ ] PagerDuty connector: can list oncall, create incident, resolve
- [ ] Drive/Docs connector: can export Google Doc as text for LLM consumption
- [ ] 3 chained recipe templates run end-to-end
- [ ] All 3437+ existing tests still green

---

## Out of Scope for MVP

- **Confluence separate from Jira** — bundles with Jira connector (same Atlassian auth)
- **Zendesk** — Wave 1.5 (lower recipe leverage)
- **Bidirectional sync** — one-shot recipes only, no listeners/polling
- **Recipe marketplace / registry** — local YAML only
- **Hosted recipe sync** — Pro tier feature, deferred

---

## Appendix: MCP Availability Deep Dive

| Provider | MCP Server | Last Commit | Issues Open | Quality Verdict |
|----------|------------|-------------|-------------|-----------------|
| Jira | atlassian-labs/mcp-server-jira | 2 weeks ago | 12 | ✅ Good — official, maintained |
| Notion | sueka/mcp-notion-server | 3 weeks ago | 8 | ✅ Good — feature-complete |
| PagerDuty | PagerDuty/mcp-server-pagerduty | 1 week ago | 3 | ✅ Excellent — official, active |
| Drive | modelcontextprotocol/servers/google-drive | 1 month ago | 15 | ✅ Good — official, stable |
| Zendesk | Zendesk/mcp-server-zendesk | 2 months ago | 7 | ⚠️ Fair — official but slower |

**Conclusion:** MCP availability is sufficient for all Wave 1 providers, but per prioritization criteria, we sequence by recipe leverage and demand first.

---

## Agent Review Fixes — Implementation Status

### Must Fix Before Implementation ✅ DONE
1. **~~Replace `vm2`~~** ✅ DONE — Implemented pure AST template engine in `src/recipes/templateEngine.ts`
2. **~~Add dry-run mode~~** ✅ SPECIFIED — Added to plan, implement during Agent 0
3. **~~Extract `BaseConnector`~~** ✅ DONE — Implemented in `src/connectors/baseConnector.ts`
4. **Define `outputSchema` for steps** for type-safe templates (correctness) — PENDING

### Files Created in This Review
| File | Lines | Purpose |
|------|-------|---------|
| `src/connectors/baseConnector.ts` | 233 | Shared auth, retry, error normalization |
| `src/recipes/templateEngine.ts` | 250 | Safe template evaluation (no vm2) |

### Updated Timeline
| Week | Deliverables |
|------|--------------|
| **Week 0** (Days 1-2) | Agent 0: `BaseConnector` ✅, dry-run mode, template engine tests |
| Week 1 | Agent 1 (chaining engine) + Agent 2 (Jira) |
| Week 2 | Agent 3 (Notion) + Agent 4 (PagerDuty) |
| Week 3 | Agent 5 (Drive/Docs) + integration recipes |
| Week 4 | E2E tests, dashboard polish, docs |
