# Recipe Chaining MVP — Implementation Summary

**Status:** Core infrastructure implemented (Agent 0 + Agent 1 foundation)  
**Date:** 2026-04-22  
**Files Created:** 7 new modules, 1 config update

---

## Files Created

### Core Recipe Chaining Engine

| File | Purpose | Lines |
|------|---------|-------|
| `src/recipes/templateEngine.ts` | Safe template evaluation (`{{steps.X.data}}`) without vm2 | 250 |
| `src/recipes/outputRegistry.ts` | Per-run step output storage for template resolution | 65 |
| `src/recipes/dependencyGraph.ts` | Parallel execution with dependency resolution, cycle detection | 224 |
| `src/recipes/nestedRecipeStep.ts` | Recipe-as-step handler with depth limiting | 175 |
| `src/recipes/chainedRunner.ts` | Main runner with dry-run, parallel execution, nested recipes | 390 |

### Connector Infrastructure

| File | Purpose | Lines |
|------|---------|-------|
| `src/connectors/baseConnector.ts` | Abstract base with auth, retry, rate limiting, error normalization | 173 |
| `src/connectors/jira.ts` | Jira connector (read+write, cloud/server, approval-gated) | 461 |

### Configuration

| File | Change | Purpose |
|------|--------|---------|
| `src/config.ts` | +3 fields | `recipeMaxConcurrency`, `recipeMaxDepth`, `recipeDryRun` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Recipe Execution Flow                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Load YAML Recipe                                         │
│        ↓                                                     │
│  2. Build Dependency Graph                                   │
│     - Detect cycles                                          │
│     - Calculate topological order                            │
│     - Group parallelizable steps                              │
│        ↓                                                     │
│  3. Execute with Concurrency Limit (default 4)                │
│     ┌─────────┐ ┌─────────┐ ┌─────────┐                     │
│     │ Step A  │ │ Step B  │ │ Step C  │  ← Parallel (no deps)│
│     └────┬────┘ └────┬────┘ └────┬────┘                     │
│          └───────────┴───────────┘                          │
│                    ↓                                         │
│              ┌─────────┐                                     │
│              │ Step D  │  ← Depends on A, B, C              │
│              └────┬────┘                                    │
│                   ↓                                          │
│  4. Template Resolution per Step                            │
│     - `{{steps.X.data.field}}` → resolved value              │
│     - `{{env.VAR}}` → environment variable                   │
│        ↓                                                     │
│  5. Store Output in Registry                                │
│     - Success/error status                                   │
│     - Structured data for downstream steps                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Features Implemented

### 1. Safe Template Engine ✅

**Problem:** Original plan suggested `vm2` (deprecated, security risk)  
**Solution:** Pure AST-based evaluator

```typescript
// Compile once, evaluate many
const template = compileTemplate("{{steps.fetch.data.issues}}");
const result = template.evaluate({ steps, env });
// result.value = resolved string
// No eval, no Function constructor, no VM
```

**Security properties:**
- No code execution possible
- Path traversal only (lodash-style: `a.b.c` or `a[0].b`)
- Missing paths resolve to empty string
- 100ms timeout on evaluation

### 2. Parallel Execution with Dependencies ✅

```yaml
steps:
  - id: fetch_jira
    tool: jira.searchIssues
    params: { jql: "status = Open" }

  - id: fetch_notion
    tool: notion.queryDatabase
    params: { databaseId: "xxx" }
    # No awaits → runs in parallel with fetch_jira

  - id: aggregate
    tool: dashboard.render
    params:
      jira: "{{steps.fetch_jira.data.issues}}"
      notion: "{{steps.fetch_notion.data.pages}}"
    awaits: [fetch_jira, fetch_notion]  # ← Waits for both
```

### 3. Nested Recipes (Recipe-as-Step) ✅

```yaml
steps:
  - id: triage
    recipe: sentry-to-linear
    vars:
      SENTRY_ISSUE_ID: "{{steps.parse.data.id}}"
      LINEAR_TEAM_KEY: "ENG"
    output: triage_result
    risk: medium
```

**Features:**
- Depth limiting (default 3, max 5, configurable)
- Variable passing via template resolution
- Isolated OutputRegistry per nested recipe
- Risk escalation (child risk > parent → use child's)

### 4. Dry-Run Mode ✅

```bash
patchwork-os run-recipe my-recipe.yaml --dry-run
```

**Outputs:**
- Execution plan with parallel groups
- Template resolution preview
- Connector call preview (no actual API calls)
- Validation errors without side effects

### 5. Conditional Execution ✅

```yaml
steps:
  - id: alert
    tool: pagerduty.createIncident
    params: { ... }
    when: "{{steps.check.data.critical_count}} > 0"
    # Step skipped if condition is falsy
```

### 6. BaseConnector Pattern ✅

All new connectors extend `BaseConnector`:

```typescript
export abstract class BaseConnector {
  abstract authenticate(): Promise<AuthContext>;
  abstract healthCheck(): Promise<{ ok: boolean }>;
  abstract normalizeError(error: unknown): ConnectorError;

  // Shared implementation
  protected async apiCall<T>(fn, options): Promise<T> {
    // - Token refresh on expiry
    // - Rate limit backoff with jitter
    // - Retry with exponential backoff
    // - Error normalization
  }
}
```

**Benefits:**
- Consistent auth handling across all connectors
- Unified error types for recipe error handling
- Health check endpoint for dashboard
- Rate limit tracking

---

## Jira Connector (Agent 2 Foundation)

**Features:**
- Cloud (OAuth) and Server/Data Center (API token) support
- Read: fetchIssue, searchIssues (JQL), listProjects
- Write: createIssue, updateStatus, addComment (approval-gated)
- Atlassian Document Format (ADF) for cloud, plain text for server
- Environment variable override for CI/headless

**Tools exposed:**
```typescript
jira.fetchIssue(issueId: string): Promise<JiraIssue>
jira.searchIssues(jql: string, maxResults?: number): Promise<JiraSearchResult>
jira.listProjects(): Promise<JiraProject[]>
jira.createIssue(params: CreateIssueParams): Promise<JiraIssue>  // Gated
jira.updateStatus(issueId: string, transitionId: string): Promise<void>  // Gated
jira.addComment(issueId: string, body: string): Promise<void>  // Gated
```

**Auth:**
```bash
# Interactive
patchwork-os connect jira

# CI/Headless
export JIRA_API_TOKEN="xxx"
export JIRA_INSTANCE_URL="https://myteam.atlassian.net"
export JIRA_EMAIL="me@example.com"  # For server/data center
```

---

## Configuration

```typescript
// src/config.ts
interface Config {
  // ... existing fields

  /** Max concurrent steps executing in parallel. Default 4. */
  recipeMaxConcurrency: number;

  /** Max nesting depth for nested recipes. Default 3, max 5. */
  recipeMaxDepth: number;

  /** Dry-run mode (validate only, don't execute). Default false. */
  recipeDryRun: boolean;
}
```

---

## Testing Status

| Component | Unit Tests | Integration | E2E |
|-----------|------------|-------------|-----|
| Template Engine | ⏳ Pending | ⏳ Pending | N/A |
| Dependency Graph | ⏳ Pending | ⏳ Pending | N/A |
| Output Registry | ⏳ Pending | N/A | N/A |
| Nested Recipe Step | ⏳ Pending | ⏳ Pending | ⏳ Pending |
| Chained Runner | ⏳ Pending | ⏳ Pending | ⏳ Pending |
| Jira Connector | ⏳ Pending | ⏳ Pending | ⏳ Pending |

---

## Remaining Work (Weeks 1-4)

### Week 1
- [ ] Unit tests for template engine (edge cases, injection attempts)
- [ ] Unit tests for dependency graph (cycles, parallel execution)
- [ ] Integration test: 5-step recipe with 2 parallel branches
- [ ] Integration test: nested recipe depth limit
- [ ] E2E test: `recipe-a` calls `recipe-b`, verify output propagation
- [ ] Jira connector live tests (sandbox.atlassian.net)

### Week 2
- [ ] Notion connector (Agent 3)
- [ ] PagerDuty connector (Agent 4)
- [ ] Integration: Jira + Notion recipe template

### Week 3
- [ ] Drive/Docs connector (Agent 5)
- [ ] Chained recipe templates:
  - `incident-war-room.yaml` (PagerDuty + Linear + Slack)
  - `spec-to-tickets.yaml` (Notion + Linear)
  - `sprint-review-prep.yaml` (Jira + Linear + Notion)

### Week 4
- [ ] E2E tests for all chained recipes
- [ ] Dashboard updates (visual dependency graph)
- [ ] Documentation
- [ ] Performance profiling

---

## API Examples

### Running a Chained Recipe

```typescript
import { runChainedRecipe } from "./src/recipes/chainedRunner.js";

const recipe = {
  name: "incident-triage",
  steps: [
    {
      id: "fetch_pagerduty",
      tool: "pagerduty.fetchIncident",
      params: { incidentId: "{{env.INCIDENT_ID}}" },
    },
    {
      id: "create_jira",
      tool: "jira.createIssue",
      params: {
        projectKey: "INCIDENTS",
        summary: "{{steps.fetch_pagerduty.data.title}}",
        description: "PagerDuty: {{steps.fetch_pagerduty.data.url}}",
      },
      awaits: ["fetch_pagerduty"],
      risk: "high",  // Triggers approval gate
    },
  ],
};

const result = await runChainedRecipe(
  recipe,
  {
    env: { INCIDENT_ID: "PD123" },
    maxConcurrency: 4,
    maxDepth: 3,
    dryRun: false,
  },
  {
    executeTool: async (tool, params) => { /* ... */ },
    executeAgent: async (prompt, model) => { /* ... */ },
    loadNestedRecipe: async (name) => { /* ... */ },
  }
);
```

### Dry-Run Mode

```typescript
import { generateExecutionPlan } from "./src/recipes/chainedRunner.js";

const plan = generateExecutionPlan(recipe);
// {
//   steps: [...],
//   parallelGroups: [["fetch_pagerduty"], ["create_jira"]],
//   maxDepth: 3
// }
```

---

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Template injection | Pure AST evaluator, no code execution |
| Infinite recursion | Hard depth limit (3 default, 5 max) |
| Secret exposure | Templates resolve to values, not logged |
| API key leakage | Environment/file only, never in recipes |
| Race conditions | Isolated OutputRegistry per run |

---

## Lines of Code Summary

| Category | Files | Lines |
|----------|-------|-------|
| Recipe Chaining Engine | 5 | 1,094 |
| Connector Infrastructure | 2 | 634 |
| Config Updates | 1 | 3 fields |
| **Total New Code** | **8** | **~1,700** |

---

## Next Actions

1. **Write unit tests** for template engine and dependency graph
2. **Set up Jira sandbox** for live connector testing
3. **Implement Notion connector** (follows same BaseConnector pattern)
4. **Create chained recipe templates** for end-to-end validation
