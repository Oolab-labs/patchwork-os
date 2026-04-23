# Recipe Chaining MVP — Implementation Summary
 
 **Status:** Wave 1 chaining shipped; alpha.22–25 authoring-DX + provider primitives landed  
 **Date:** 2026-04-22  
 **Last updated:** 2026-04-23  
 **Files Created:** 9 new modules, 2 config updates, 1 new HTTP surface

 ## Progress update

 - The chaining runtime is now wired through the command layer: chained recipes lint, dry-plan, and run through the same authoring path as other recipes.
 - Bundled chained examples now exist in `examples/recipes/chained-followup-demo.yaml` and `examples/recipes/chained-followup-child.yaml`.
 - Dry-run execution plans now surface chained metadata end-to-end, including `dependencies`, `condition`, `optional`, `risk`, `parallelGroups`, and `maxDepth`.
 - Recipe authoring foundations have moved beyond the original MVP scope: `recipe new`, `lint`, `test`, `record`, `fmt`, `run --dry-run`, `run --step`, `watch`, and `preflight [--watch]` all exist in the command layer.
 - The bridge HTTP layer now serves generated schemas unauthenticated at `GET /schemas/*` — YAML-LSP editors can point a `$schema` URL at a running bridge in dev and get live autocomplete against the registered tool set.
 - The dry-run plan JSON has a stable versioned contract (`schemaVersion: 1`) with named fields for `risk`, `isWrite`, `isConnector`, `parallelGroups`, and `dependencies` — safe for dashboard and external consumers to parse.
 - Broader recipe-focused verification is green: `src/commands/__tests__/recipe.test.ts`, `src/recipes/__tests__/schemaGenerator.test.ts`, `src/recipes/__tests__/yamlRunner.test.ts`, `src/recipes/__tests__/chainedRunner.test.ts`, `src/__tests__/recipe-cli.integration.test.ts`, and `src/__tests__/server-schemas.test.ts` passed together on 2026-04-23.

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

### 1. Safe Template Engine 

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

### 2. Parallel Execution with Dependencies 

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

### 3. Nested Recipes (Recipe-as-Step) 

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

### 4. Dry-Run Mode 

```bash
patchwork-os run-recipe my-recipe.yaml --dry-run
```

**Outputs:**
- Execution plan with parallel groups
- Template resolution preview
- Connector call preview (no actual API calls)
- Validation errors without side effects

### 5. Conditional Execution 

```yaml
steps:
  - id: alert
    tool: pagerduty.createIncident
    params: { ... }
    when: "{{steps.check.data.critical_count}} > 0"
    # Step skipped if condition is falsy
```

### 6. BaseConnector Pattern 

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

| Surface | Current coverage | Evidence |
|---------|------------------|----------|
| Template engine | ✅ Direct unit coverage | `src/recipes/__tests__/templateEngine.test.ts` |
| Dependency graph | ✅ Direct unit coverage | `src/recipes/__tests__/dependencyGraph.test.ts` |
| Output registry | ✅ Direct unit coverage | `src/recipes/__tests__/outputRegistry.test.ts` |
| Nested recipe step | ✅ Direct unit coverage | `src/recipes/__tests__/nestedRecipeStep.test.ts` |
| Chained runner | ✅ Direct unit + dry-plan coverage | `src/recipes/__tests__/chainedRunner.test.ts`, `src/commands/__tests__/recipe.test.ts` |
| Schema + lint | ✅ Command/schema coverage | `src/recipes/__tests__/schemaGenerator.test.ts`, `src/commands/__tests__/recipe.test.ts` |
| YAML runtime + fixtures | ✅ Runtime/test-record coverage | `src/recipes/__tests__/yamlRunner.test.ts`, `src/commands/__tests__/recipe.test.ts` |
| Recipe CLI run/watch/preflight | ✅ CLI integration coverage | `src/__tests__/recipe-cli.integration.test.ts`, `src/commands/__tests__/recipe.test.ts` |
| Schema HTTP endpoints | ✅ Server integration coverage | `src/__tests__/server-schemas.test.ts` |
| DryRunPlan JSON contract | ✅ Schema + command coverage | `src/recipes/__tests__/schemaGenerator.test.ts`, `src/commands/__tests__/recipe.test.ts` |

Focused broader verification on 2026-04-23 (alpha.22):

- `npx vitest run src/commands/__tests__/recipe.test.ts src/recipes/__tests__/schemaGenerator.test.ts src/recipes/__tests__/yamlRunner.test.ts src/recipes/__tests__/chainedRunner.test.ts src/__tests__/server-schemas.test.ts src/__tests__/server.test.ts`
- Result: `6` files passed, `141` tests passed

---

## Alpha.22 Authoring DX Primitives (2026-04-23)

Three new surfaces shipped on top of the Wave 1 foundation.

### 1. Schema HTTP Serving (`GET /schemas/*`)

The bridge now serves generated schemas over unauthenticated HTTP. No auth required — schemas are registry-derived metadata with no secrets.

```
GET /schemas/recipe.v1.json          → top-level recipe schema
GET /schemas/dry-run-plan.v1.json    → dry-run plan contract (schemaVersion: 1)
GET /schemas/tools/<namespace>.json  → per-namespace tool param schemas
GET /schemas/                        → index JSON listing all URLs
```

**YAML-LSP integration (dev workflow):**
```yaml
# yaml-language-server: $schema=http://localhost:3000/schemas/recipe.v1.json
name: my-recipe
steps:
  - tool: jira.searchIssues   # ← autocomplete + hover docs from registry
```

Tool registry is imported lazily on first `/schemas/*` request — zero startup cost when running slim-mode or without the recipe command loaded.

### 2. Stable `DryRunPlan` JSON Contract

Dry-run output now has a versioned schema (`schemaVersion: 1`) making it safe for the dashboard and external tooling to parse:

```typescript
interface DryRunPlan {
  schemaVersion: 1;
  steps: Array<{
    id: string;
    tool: string;
    risk: "low" | "medium" | "high";
    isWrite: boolean;
    isConnector: boolean;     // ← new: true for Jira/Gmail/Slack/etc.
    resolvedParams: Record<string, unknown>;
    condition?: string;
    awaits?: string[];
  }>;
  parallelGroups: string[][];
  dependencies: Record<string, string[]>;
  maxDepth: number;
}
```

The `isConnector` field comes from `ToolMetadata.isConnector` — set to `true` on all connector-backed registrations in `src/recipes/tools/`. This is the canonical place to distinguish network-bound steps from pure-compute steps.

### 3. `patchwork recipe preflight [--watch]`

Validates a recipe against the live registry without executing it. Cheaper than `recipe lint` (no schema load) — pure registry membership and template-ref check.

```bash
# One-shot (CI)
patchwork recipe preflight my-recipe.yaml
patchwork recipe preflight my-recipe.yaml --json   # structured PreflightResult

# Watch mode (editor workflow)
patchwork recipe preflight my-recipe.yaml --watch
# → reprints issues on every save, SIGINT to stop
```

**Library export** — `runPreflightWatch(options)` in `src/commands/recipe.ts` is exported for VS Code recipe extensions to import directly without spawning the CLI.

**Issue codes emitted:**

| Code | Meaning |
|------|---------|
| `UNRESOLVED_TOOL` | Tool name not found in registry |
| `MISSING_REQUIRED_PARAM` | Required parameter absent in step `params` |
| `INVALID_TEMPLATE_REF` | `{{steps.X.field}}` references unknown upstream step id |
| `CYCLE_DETECTED` | `awaits` graph has a cycle |

---

## Alpha.23 Authoring DX + Provider (2026-04-23)

Four surfaces shipped on top of alpha.22.

### 1. Notion Connector (Wave 2 Provider #1)

`src/connectors/notion.ts` — extends `BaseConnector`. Five tools registered in `src/recipes/tools/notion.ts`:

| Tool | Risk | Write |
|------|------|-------|
| `notion.queryDatabase` | low | no |
| `notion.getPage` | low | no |
| `notion.search` | low | no |
| `notion.createPage` | medium | yes |
| `notion.appendBlock` | medium | yes |

Auth: `NOTION_TOKEN` env var or stored token (`secret_...` prefix). Token-paste modal on the dashboard connections page (no OAuth redirect — internal integrations use API tokens). HTTP routes wired under `/connections/notion/*`.

### 2. `expect` Block Runtime Assertions

`evaluateExpect(result, expect)` — pure function, exported. Four assertion types: `stepsRun` (exact), `errorMessage` (exact or null), `outputs` (membership, order-independent), `context` (substring, flexible for agent output).

`RunResult.assertionFailures?` is populated only on failure and persisted to the JSONL run log. `runTest` reads this directly — the duplicate `assertRecipeExpectations` function was removed.

### 3. `patchwork recipe test --watch`

`runTestWatch(options)` mirrors `runPreflightWatch` — composes `runWatch` + `runTest`. Exported for library consumers. CLI: `patchwork recipe test <file.yaml> --watch`.

### 4. `into` Chaining Validation

Three new static checks added to `validateTemplateReferences`:

| Check | Level | Example message |
|-------|-------|-----------------|
| Builtin shadow | error | `into: date` shadows a built-in context key |
| Duplicate key | warning | `into: content` overwrites value already written by step 1 |
| Chained agent `into` bug | fix | Agent `into` keys in chained recipes no longer cause false-positive lint errors |

### Dashboard (alpha.23)

- `/runs/[seq]` — red-bordered assertion failures panel above step list; "N assertions failed" badge in header.
- `/runs` list — `err`-colored status badge + compact `N assert` pill for runs with failures; expanded row shows bullet list.

## Remaining Work

### Highest-value product gaps
- **Editor-distribution story** — `$schema` header + local bridge resolve in dev; SchemaStore publication needed for offline / non-bridge editors. See [docs/recipe-schemastore-pr.md](./recipe-schemastore-pr.md) for the drafted PR.
- **Registry consolidation** — `isConnector` + `isWrite` on `ToolMetadata`; hover-quality descriptions and input/output JSON schemas per tool step still manually maintained.
- **Scaffolding polish** — `patchwork recipe new` exists but lacks connector-aware interactive prompting.

### Connector and recipe follow-through
- **Wave 2 providers** — Confluence is the natural next connector (Atlassian auth, same pattern as Jira).
- Expand fixture-backed coverage for connector-backed recipe flows so `recipe test` stays useful as provider count grows.
- Add curated chained recipes exercising nested recipes, conditions, optional steps, and approval-gated writes.

### Confidence + ergonomics
- `patchwork recipe fmt --watch` — watch-mode trilogy is incomplete; `fmt` is the last subcommand without `--watch`.
- SchemaStore PR submission (blocked on public URL gate — bridge must be deployed to a public HTTPS endpoint first).

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

1. **Confluence connector** (Wave 2 provider #2) — Atlassian auth same pattern as Jira; tools: `getPage`, `search`, `createPage`, `appendToPage`.
2. **`patchwork recipe fmt --watch`** — completes the watch-mode trilogy; 20-line lift, same `runWatch` composition pattern.
3. **Publish schemas to SchemaStore** — see [docs/recipe-schemastore-pr.md](./recipe-schemastore-pr.md) for the drafted PR body. Blocked on public HTTPS URL.
4. **`onRecipeSave` automation hook** — first-class preflight in the bridge policy DSL so authors get in-editor feedback without the CLI `--watch` process.
