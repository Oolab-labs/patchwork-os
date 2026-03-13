# Claude IDE Bridge — Use Cases & Workflows

Real-world workflows that showcase what the bridge makes possible. Each workflow uses actual tool calls with example inputs and outputs.

---

## What Makes This Different

| Capability | Claude IDE Bridge | Cursor | GitHub Copilot | Cody | Aider |
|------------|:-:|:-:|:-:|:-:|:-:|
| Bidirectional IDE control (read + write) | 120+ tools | Chat only | Chat only | Chat only | CLI only |
| Git + GitHub full loop (commit → PR → CI) | 15 tools | No | No | No | Partial |
| Programmatic debugging (breakpoints, eval) | 5 tools | No | No | No | No |
| Terminal orchestration (create, run, wait) | 7 tools | No | No | No | No |
| Real-time diagnostics streaming | Live push | No | No | No | No |
| Workspace snapshots (checkpoint/rollback) | 6 tools | No | No | No | No |
| LSP with CLI fallback (works without extension) | 12 tools | Extension only | Extension only | Extension only | No LSP |
| Remote control from any device | Yes | No | No | No | No |
| Multi-language auto-detection (5 runners, 6 linters) | Yes | Partial | No | No | Partial |
| AI comment directives (`// AI: FIX:`) | Yes | No | No | No | No |
| Editor decorations (highlights, annotations) | Yes | No | No | No | No |
| Jupyter notebook execution | 3 tools | No | No | No | No |

---

## Workflow 1: Zero-to-PR in One Session

**Persona**: Solo Full-Stack Developer
**Shows**: Complete code → test → commit → PR → CI monitoring without touching the IDE

### Step 1: Understand the project
**Tool**: `getProjectInfo`
```json
→ {}
← {
    "name": "my-api",
    "type": "node",
    "packageManager": "npm",
    "languages": ["typescript"],
    "frameworks": ["express", "vitest"],
    "hasGit": true
  }
```

### Step 2: Check current diagnostics
**Tool**: `getDiagnostics`
```json
→ {}
← {
    "source": "extension",
    "diagnostics": [
      { "file": "src/routes/auth.ts", "line": 42, "severity": "error",
        "message": "Property 'expiresIn' is missing in type 'TokenOptions'" }
    ]
  }
```

### Step 3: Jump to the type definition
**Tool**: `goToDefinition` → `{ "file": "src/routes/auth.ts", "line": 42, "column": 28 }`
```json
← { "found": true, "definitions": [
    { "file": "src/types.ts", "line": 15, "symbol": "TokenOptions" }
  ]}
```

### Step 4: See who else uses this type
**Tool**: `findReferences` → `{ "file": "src/types.ts", "line": 15, "column": 14 }`
```json
← { "found": true, "references": [
    { "file": "src/routes/auth.ts", "line": 42, "column": 28 },
    { "file": "src/routes/refresh.ts", "line": 18, "column": 12 },
    { "file": "src/middleware/jwt.ts", "line": 7, "column": 22 }
  ]}
```

### Step 5: Fix the type and edit the code
**Tool**: `editText`
```json
→ { "filePath": "src/types.ts",
    "edits": [{ "startLine": 17, "startColumn": 1, "endLine": 17, "endColumn": 1,
                "text": "  expiresIn?: number;\n" }],
    "save": true }
← { "success": true, "appliedEdits": 1 }
```

### Step 6: Run the tests
**Tool**: `runTests` → `{ "filter": "auth" }`
```json
← {
    "summary": { "total": 8, "passed": 8, "failed": 0, "durationMs": 1240 },
    "runners": ["vitest"],
    "results": [
      { "name": "should issue JWT with default expiry", "status": "passed", "file": "src/__tests__/auth.test.ts" },
      { "name": "should refresh expired token", "status": "passed", "file": "src/__tests__/auth.test.ts" }
    ]
  }
```

### Step 7: Commit
**Tool**: `gitAdd` → `{ "files": ["src/types.ts"] }`
**Tool**: `gitCommit` → `{ "message": "fix: add optional expiresIn to TokenOptions" }`
```json
← { "hash": "a1b2c3d", "message": "fix: add optional expiresIn to TokenOptions" }
```

### Step 8: Push and create PR
**Tool**: `gitPush` → `{ "remote": "origin", "branch": "fix/token-options" }`
**Tool**: `githubCreatePR`
```json
→ { "title": "Fix missing expiresIn in TokenOptions",
    "body": "Adds optional `expiresIn` field. Fixes type error in auth routes.",
    "base": "main" }
← { "number": 47, "url": "https://github.com/org/my-api/pull/47" }
```

### Step 9: Monitor CI
**Tool**: `githubListRuns` → `{ "branch": "fix/token-options", "limit": 1 }`
```json
← { "runs": [{ "id": 12345, "status": "completed", "conclusion": "success", "name": "CI" }] }
```

> **What's unique**: No other AI coding tool can go from diagnosis → fix → test → commit → PR → CI check in a single uninterrupted session. Cursor and Copilot require you to manually commit, push, and check CI.

---

## Workflow 2: Debug a Failing Test Without Touching the IDE

**Persona**: Solo Developer
**Shows**: Full programmatic debug cycle — set breakpoints, evaluate expressions, fix, verify

### Step 1: Run tests, find the failure
**Tool**: `runTests` → `{}`
```json
← {
    "summary": { "total": 42, "passed": 40, "failed": 2 },
    "failures": [
      { "name": "should calculate discount for premium users",
        "file": "src/pricing.test.ts", "line": 67,
        "message": "Expected 0.15, received 0.10" }
    ]
  }
```

### Step 2: Set a breakpoint at the failing assertion
**Tool**: `setDebugBreakpoints`
```json
→ { "file": "src/pricing.ts", "breakpoints": [{ "line": 23, "condition": "user.tier === 'premium'" }] }
← { "success": true, "verified": [{ "line": 23 }] }
```

### Step 3: Start debugging
**Tool**: `startDebugging` → `{ "configName": "Vitest Current File" }`
```json
← { "success": true, "sessionId": "debug-1" }
```

### Step 4: Inspect variables at the breakpoint
**Tool**: `evaluateInDebugger` → `{ "expression": "{ tier: user.tier, discount: discountRate, thresholds }" }`
```json
← { "result": "{ tier: 'premium', discount: 0.10, thresholds: { basic: 0.05, premium: 0.10 } }",
    "type": "object" }
```

### Step 5: Found it — the threshold is wrong. Stop debugging and fix.
**Tool**: `stopDebugging`
**Tool**: `editText`
```json
→ { "filePath": "src/pricing.ts",
    "edits": [{ "startLine": 8, "startColumn": 15, "endLine": 8, "endColumn": 19,
                "text": "0.15" }],
    "save": true }
```

### Step 6: Verify the fix
**Tool**: `runTests` → `{ "filter": "discount" }`
```json
← { "summary": { "total": 5, "passed": 5, "failed": 0 } }
```

> **What's unique**: No other AI tool can programmatically set conditional breakpoints, evaluate expressions, and inspect runtime state. Cursor and Copilot offer chat-based debugging suggestions, but can't actually control the debugger.

---

## Workflow 3: Codebase Exploration for a New Team Member

**Persona**: Multi-Language Developer joining a new project
**Shows**: Deep code intelligence to understand unfamiliar code without reading every file

### Step 1: Get the lay of the land
**Tool**: `getFileTree` → `{ "depth": 2 }`
```json
← { "tree": "src/\n  routes/\n  middleware/\n  models/\n  services/\n  utils/\ntest/\npackage.json\ntsconfig.json" }
```

### Step 2: Search for the entry point
**Tool**: `searchWorkspace` → `{ "query": "app.listen", "fileGlob": "*.ts" }`
```json
← { "matches": [{ "file": "src/index.ts", "line": 45, "text": "app.listen(PORT, () => {" }] }
```

### Step 3: Understand the function hierarchy
**Tool**: `getDocumentSymbols` → `{ "file": "src/services/payment.ts" }`
```json
← { "symbols": [
    { "name": "PaymentService", "kind": "class", "line": 5, "children": [
      { "name": "processPayment", "kind": "method", "line": 12 },
      { "name": "refund", "kind": "method", "line": 45 },
      { "name": "validateCard", "kind": "method", "line": 78 }
    ]}
  ]}
```

### Step 4: Who calls processPayment?
**Tool**: `getCallHierarchy` → `{ "file": "src/services/payment.ts", "line": 12, "column": 5, "direction": "incoming" }`
```json
← { "symbol": "processPayment", "incoming": [
    { "name": "handleCheckout", "file": "src/routes/checkout.ts", "line": 34 },
    { "name": "retryPayment", "file": "src/jobs/retry.ts", "line": 18 }
  ]}
```

### Step 5: Get type information
**Tool**: `getHover` → `{ "file": "src/services/payment.ts", "line": 12, "column": 5 }`
```json
← { "contents": "```typescript\n(method) PaymentService.processPayment(amount: number, currency: Currency, card: CardToken): Promise<PaymentResult>\n```\nProcess a payment and return the transaction result." }
```

### Step 6: Find the type hierarchy
**Tool**: `getTypeHierarchy` → `{ "file": "src/services/payment.ts", "line": 5, "column": 14, "direction": "subtypes" }`
```json
← { "symbol": "PaymentService", "subtypes": [
    { "name": "StripePaymentService", "file": "src/services/stripe.ts", "line": 3 },
    { "name": "MockPaymentService", "file": "test/mocks/payment.ts", "line": 1 }
  ]}
```

> **What's unique**: This is the depth of code intelligence you'd get from a senior developer walking you through the codebase — call hierarchy, type hierarchy, cross-file references — but automated and available on demand. No other AI tool exposes LSP this deeply.

---

## Workflow 4: PR Review from Your Phone

**Persona**: Team Lead / Remote Developer
**Shows**: Full code review workflow from any device via remote control

### Step 1: See what's pending
**Tool**: `githubListPRs` → `{ "state": "open", "limit": 5 }`
```json
← { "pullRequests": [
    { "number": 47, "title": "Add rate limiting to API", "author": "dev-1", "additions": 120, "deletions": 15 },
    { "number": 46, "title": "Fix user session timeout", "author": "dev-2", "additions": 30, "deletions": 8 }
  ]}
```

### Step 2: Review the diff
**Tool**: `githubGetPRDiff` → `{ "number": 47 }`
```json
← { "diff": "diff --git a/src/middleware/rateLimit.ts b/src/middleware/rateLimit.ts\nnew file\n+import { RateLimiter } from '../utils/rateLimiter';\n+\n+export function rateLimitMiddleware(limit: number) {\n..." }
```

### Step 3: Check if it passes tests
**Tool**: `githubListRuns` → `{ "branch": "feature/rate-limiting", "limit": 1 }`
```json
← { "runs": [{ "status": "completed", "conclusion": "failure", "name": "CI" }] }
```

### Step 4: Get the CI failure logs
**Tool**: `githubGetRunLogs` → `{ "runId": 12345 }`
```json
← { "logs": "FAIL src/__tests__/rateLimit.test.ts\n  ● should reset counter after window expires\n    Expected: 0\n    Received: 1\n    at Object.<anonymous> (src/__tests__/rateLimit.test.ts:42:22)" }
```

### Step 5: Post a review with the finding
**Tool**: `githubPostPRReview`
```json
→ { "number": 47, "event": "REQUEST_CHANGES",
    "body": "CI is failing — the rate limiter counter isn't resetting after the time window expires. See test at line 42. The `setTimeout` in `resetCounter()` might need `clearInterval` instead." }
← { "id": 789, "state": "CHANGES_REQUESTED" }
```

> **What's unique**: From your phone, you can view PRs, check CI results, read failure logs, and post structured reviews — all through Claude. No IDE needed, no laptop needed. No other AI tool supports this remote workflow.

---

## Workflow 5: Safe Refactoring with Rollback

**Persona**: Solo Developer
**Shows**: Snapshot safety net for risky multi-file changes

### Step 1: Checkpoint before the refactor
**Tool**: `createSnapshot` → `{ "name": "before-auth-refactor" }`
```json
← { "name": "before-auth-refactor", "index": 0 }
```

### Step 2: Rename across the codebase
**Tool**: `renameSymbol` → `{ "file": "src/auth.ts", "line": 5, "column": 14, "newName": "AuthenticationService" }`
```json
← { "success": true, "changes": 12, "files": ["src/auth.ts", "src/routes/login.ts", "src/middleware/jwt.ts", "test/auth.test.ts"] }
```

### Step 3: Clean up imports
**Tool**: `organizeImports` → `{ "file": "src/routes/login.ts" }`
**Tool**: `organizeImports` → `{ "file": "src/middleware/jwt.ts" }`

### Step 4: Format everything
**Tool**: `formatDocument` → `{ "file": "src/auth.ts" }`

### Step 5: Run tests to verify
**Tool**: `runTests` → `{}`
```json
← { "summary": { "total": 42, "passed": 39, "failed": 3 } }
```

### Step 6: Tests failed — see what broke
**Tool**: `diffSnapshot` → `{ "name": "before-auth-refactor" }`
```json
← { "diff": "diff --git a/src/middleware/jwt.ts...\n-import { AuthService } from '../auth';\n+import { AuthenticationService } from '../auth';\n..." }
```

### Step 7: Rollback to the checkpoint
**Tool**: `restoreSnapshot` → `{ "name": "before-auth-refactor" }`
```json
← { "success": true, "message": "Restored snapshot before-auth-refactor" }
```

> **What's unique**: Workspace snapshots give you `git stash` superpowers — named checkpoints, diffing against current state, and instant rollback. No other AI tool provides this safety net for refactoring.

---

## Workflow 6: Terminal-Driven Development

**Persona**: Remote Developer
**Shows**: Full terminal lifecycle — create, run commands, wait for output, read results

### Step 1: Create a dedicated terminal
**Tool**: `createTerminal` → `{ "name": "dev-server", "cwd": "/app", "show": false }`
```json
← { "success": true, "name": "dev-server" }
```

### Step 2: Start the dev server
**Tool**: `sendTerminalCommand` → `{ "text": "npm run dev", "name": "dev-server" }`

### Step 3: Wait for it to be ready
**Tool**: `waitForTerminalOutput` → `{ "pattern": "listening on port", "name": "dev-server", "timeoutMs": 15000 }`
```json
← { "matched": true, "line": "Server listening on port 3000", "elapsedMs": 2340 }
```

### Step 4: Run a curl test against it
**Tool**: `runInTerminal` → `{ "command": "curl -s http://localhost:3000/health" }`
```json
← { "exitCode": 0, "output": "{\"status\":\"ok\",\"uptime\":4}" }
```

### Step 5: Check the server logs
**Tool**: `getTerminalOutput` → `{ "name": "dev-server", "lines": 20 }`
```json
← { "output": "GET /health 200 2ms\n..." }
```

> **What's unique**: You can orchestrate multiple terminals, wait for specific output patterns, and capture results — all programmatically. This is how you run integration tests, manage dev servers, and monitor processes without a terminal window open.

---

## Workflow 7: AI Comment Triage

**Persona**: Team Lead
**Shows**: AI comments as a lightweight, in-code issue tracking system

### Step 1: Scan for AI directives across the codebase
**Tool**: `getAIComments` → `{}`
```json
← { "source": "extension", "comments": [
    { "file": "src/auth.ts", "line": 23, "comment": "FIX: JWT secret is hardcoded",
      "severity": "fix", "fullLine": "// AI: FIX: JWT secret is hardcoded" },
    { "file": "src/db.ts", "line": 5, "comment": "TODO: Add connection pooling",
      "severity": "todo", "fullLine": "// AI: TODO: Add connection pooling" },
    { "file": "src/routes/users.ts", "line": 89, "comment": "WARN: No input validation on email",
      "severity": "warn", "fullLine": "// AI: WARN: No input validation on email" }
  ], "count": 3 }
```

### Step 2: Highlight them in the editor
**Tool**: `setEditorDecorations`
```json
→ { "id": "ai-comments", "file": "src/auth.ts",
    "decorations": [{ "startLine": 23, "endLine": 23, "message": "FIX: JWT secret is hardcoded", "style": "error" }] }
```

### Step 3: Create a GitHub issue for the critical one
**Tool**: `githubCreateIssue`
```json
→ { "title": "Security: JWT secret is hardcoded in auth.ts",
    "body": "Found via AI comment directive at `src/auth.ts:23`.\n\n```\n// AI: FIX: JWT secret is hardcoded\n```\n\nShould use environment variable.",
    "labels": ["bug", "security"] }
← { "number": 48, "url": "https://github.com/org/my-api/issues/48" }
```

> **What's unique**: `// AI:` comments are a convention that the bridge understands natively. Drop a `// AI: FIX:` comment anywhere in your code and Claude can find it, prioritize it, and convert it to a tracked issue. No other tool has this.

---

## Workflow 8: Multi-Linter Code Quality Sweep

**Persona**: Multi-Language Developer working on a polyglot monorepo
**Shows**: Automated quality enforcement across languages in one pass

### Step 1: Check what tools are available
**Tool**: `getToolCapabilities` → `{}`
```json
← { "linters": ["tsc", "biome", "ruff"], "testRunners": ["vitest", "pytest"],
    "formatters": ["prettier", "black", "biome"] }
```

### Step 2: Get all diagnostics
**Tool**: `getDiagnostics` → `{}`
```json
← { "diagnostics": [
    { "file": "src/api/handler.ts", "line": 12, "severity": "error", "message": "Type 'string' is not assignable to 'number'", "source": "tsc" },
    { "file": "src/api/handler.ts", "line": 45, "severity": "warning", "message": "Unexpected any. Specify a different type.", "source": "biome" },
    { "file": "scripts/analyze.py", "line": 8, "severity": "warning", "message": "Local variable 'result' is assigned to but never used", "source": "ruff" }
  ]}
```

### Step 3: Auto-fix what's fixable
**Tool**: `fixAllLintErrors` → `{ "file": "src/api/handler.ts" }`
```json
← { "success": true, "fixedCount": 1 }
```

### Step 4: Organize imports and format
**Tool**: `organizeImports` → `{ "file": "src/api/handler.ts" }`
**Tool**: `formatDocument` → `{ "file": "src/api/handler.ts" }`
**Tool**: `formatDocument` → `{ "file": "scripts/analyze.py" }`

### Step 5: Verify everything passes
**Tool**: `runTests` → `{}`
```json
← { "runners": ["vitest", "pytest"],
    "summary": { "total": 67, "passed": 67, "failed": 0 },
    "results": [...] }
```

### Step 6: Commit the cleanup
**Tool**: `gitAdd` → `{ "files": ["src/api/handler.ts", "scripts/analyze.py"] }`
**Tool**: `gitCommit` → `{ "message": "chore: fix lint errors and format code" }`

> **What's unique**: The bridge auto-detects linters and test runners per language — TypeScript gets `tsc` + `biome`, Python gets `ruff` + `pytest`, all in one session. No configuration needed. No other tool provides unified multi-language quality tooling.

---

## Quick Reference: Tool Count by Category

| Category | Count | Extension Required |
|----------|------:|:-:|
| File Operations | 7 | No |
| Git | 15 | No |
| GitHub | 11 | No (requires `gh`) |
| LSP / Code Intelligence | 12 | Yes (with fallbacks) |
| Editor State | 7 | Yes |
| Text Editing | 5 | Yes |
| Terminal | 7 | Yes |
| Diagnostics & Testing | 3 | Mixed |
| Code Quality | 3 | Yes |
| Debug | 5 | Yes |
| Decorations | 2 | Yes |
| Workspace Management | 4 | No |
| Snapshots & Plans | 10 | No |
| HTTP | 2 | No |
| VS Code Integration | 8 | Yes |
| Notebooks | 3 | Yes |
| **Total** | **~120** | |
