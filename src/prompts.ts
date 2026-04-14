// MCP Prompts — reusable IDE workflow templates surfaced as slash commands
// in Claude Code chat: /mcp__bridge__<name>

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the bridge-tools rules template so the orient prompt always stays in sync.
const _promptsDir = path.dirname(fileURLToPath(import.meta.url));
let _bridgeToolsTemplate: string;
try {
  _bridgeToolsTemplate = readFileSync(
    path.resolve(_promptsDir, "..", "templates", "bridge-tools.md"),
    "utf-8",
  ).trim();
} catch {
  _bridgeToolsTemplate =
    "See `.claude/rules/bridge-tools.md` for bridge tool override rules (run `claude-ide-bridge init` to generate it).";
}

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

// ── Prompt definitions ────────────────────────────────────────────────────────

export const PROMPTS: McpPrompt[] = [
  {
    name: "review-changes",
    description:
      "Review uncommitted changes to a specific file: diff, diagnostics, churn risk, and architectural context.",
    arguments: [
      {
        name: "file",
        description:
          "Path to the changed file to review (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "review-file",
    description:
      "Code review: correctness, style, performance, security, and coverage gaps.",
    arguments: [
      {
        name: "file",
        description:
          "Path to the file to review (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "explain-diagnostics",
    description:
      "Explain diagnostics (errors/warnings) for a file and suggest fixes.",
    arguments: [
      {
        name: "file",
        description:
          "Path to the file with diagnostics (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "generate-tests",
    description:
      "Generate missing unit tests for a file using the project's test conventions.",
    arguments: [
      {
        name: "file",
        description:
          "Path to the file to generate tests for (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "debug-context",
    description:
      "Snapshot IDE state (open editors, diagnostics, recent terminal output) as debugging context.",
    arguments: [],
  },
  {
    name: "git-review",
    description:
      "Review uncommitted changes (staged + unstaged) against a base branch before commit or PR.",
    arguments: [
      {
        name: "base",
        description: "Base branch or ref to diff against (default: main).",
        required: false,
      },
    ],
  },
  {
    name: "cowork",
    description:
      "Load IDE context (open files, diagnostics, git status, project info, handoff note) and propose a Cowork action plan. Run before any computer-use task.",
    arguments: [
      {
        name: "task",
        description:
          "Optional task description to focus context gathering (e.g. 'fix all TypeScript errors').",
        required: false,
      },
    ],
  },
  {
    name: "gen-claude-md",
    description:
      "Generate bridge workflow rules and quick-reference table, then write them into CLAUDE.md.",
    arguments: [],
  },
  {
    name: "set-effort",
    description:
      "Prepend a model-effort instruction to the next task. low=quick, medium=normal, high=complex refactors/deep analysis.",
    arguments: [
      {
        name: "level",
        description: "Effort level: low | medium | high (default: medium).",
        required: false,
      },
    ],
  },

  // ── Dispatch prompts (phone-friendly, terse triggers) ───────────────────────
  {
    name: "project-status",
    description:
      "Quick health check: git status, diagnostics, and test results. Terse output for Dispatch/mobile.",
    arguments: [],
  },
  {
    name: "quick-tests",
    description:
      "Run tests and return a concise pass/fail summary with failure details.",
    arguments: [
      {
        name: "filter",
        description:
          "Optional test filter pattern (e.g. file name or test name substring).",
        required: false,
      },
    ],
  },
  {
    name: "quick-review",
    description:
      "Git diff summary plus diagnostics for changed files. Concise output.",
    arguments: [],
  },
  {
    name: "build-check",
    description:
      "Check if the project builds successfully. Returns pass/fail with error summary.",
    arguments: [],
  },
  {
    name: "recent-activity",
    description: "Last N git log entries plus uncommitted changes summary.",
    arguments: [
      {
        name: "count",
        description: "Number of recent commits to show (default: 10).",
        required: false,
      },
    ],
  },

  // ── Agent Teams & Scheduled Tasks prompts ───────────────────────────────────
  {
    name: "team-status",
    description:
      "Active agent sessions and recent tool activity. For team leads coordinating parallel agents.",
    arguments: [],
  },
  {
    name: "health-check",
    description:
      "Full health check: tests, diagnostics, security advisories, git status, dependency audit. For scheduled nightly/hourly runs.",
    arguments: [],
  },

  // ── Setup prompts ─────────────────────────────────────────────────────────
  {
    name: "orient-project",
    description:
      "Set up a project for Claude IDE Bridge: detects project type, generates/updates CLAUDE.md, scaffolds docs, and verifies connectivity. Idempotent.",
    arguments: [
      {
        name: "style",
        description:
          "Scaffolding depth: 'minimal' (CLAUDE.md only), 'standard' (+ documents/, docs/adr/, .claude/rules/), 'full' (+ commands, agents, use-cases). Default: standard.",
        required: false,
      },
    ],
  },

  // ── LSP composition prompts (Round: LSP Leverage) ─────────────────────────
  // These wrap the bridge's existing LSP primitives + composites (getChangeImpact,
  // explainSymbol, refactorAnalyze, etc.) into one-call developer workflows.
  {
    name: "find-callers",
    description:
      "Find every caller of a symbol with file:line locations. Wraps searchWorkspaceSymbols + getCallHierarchy(incoming) + findReferences.",
    arguments: [
      {
        name: "symbol",
        description: "Symbol name to look up (function, class, variable).",
        required: true,
      },
    ],
  },
  {
    name: "blast-radius",
    description:
      "Blast radius at a position: diagnostics + reference counts + risk badge. Wraps getChangeImpact.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
      {
        name: "line",
        description: "Line number (1-based).",
        required: true,
      },
      {
        name: "column",
        description: "Column number (1-based).",
        required: true,
      },
    ],
  },
  {
    name: "why-error",
    description:
      "Explain a diagnostic in plain English with surrounding type context. Wraps getDiagnostics + explainSymbol.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
      {
        name: "line",
        description: "Line number to focus on (default: first error).",
        required: false,
      },
    ],
  },
  {
    name: "unused-in",
    description:
      "List unused exports, parameters, and imports in a file. Wraps detectUnusedCode + findReferences.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "trace-to",
    description:
      "Trace call chain to a target symbol with type signatures at each hop. Wraps getCallHierarchy(outgoing) + getImportedSignatures.",
    arguments: [
      {
        name: "symbol",
        description: "Target symbol name to trace toward.",
        required: true,
      },
    ],
  },
  {
    name: "imports-of",
    description:
      "List files importing a symbol with reference counts. Wraps findReferences + getImportTree.",
    arguments: [
      {
        name: "symbol",
        description: "Symbol name to look up imports for.",
        required: true,
      },
    ],
  },
  {
    name: "circular-deps",
    description:
      "Detect circular import dependencies. Wraps getImportTree with cycle detection.",
    arguments: [],
  },
  {
    name: "refactor-preview",
    description:
      "Preview exact edits a rename would make plus blast-radius risk. Wraps refactorAnalyze + refactorPreview.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
      {
        name: "line",
        description: "Line number (1-based).",
        required: true,
      },
      {
        name: "column",
        description: "Column number (1-based).",
        required: true,
      },
      {
        name: "newName",
        description: "Proposed new name for the symbol.",
        required: true,
      },
    ],
  },
  {
    name: "module-exports",
    description:
      "List exported symbols with type signatures as Markdown. Wraps getDocumentSymbols + getHover.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "type-of",
    description:
      "Type signature at a position (no docs). Wraps getHoverAtCursor + getTypeSignature.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
      {
        name: "line",
        description: "Line number (1-based).",
        required: true,
      },
      {
        name: "column",
        description: "Column number (1-based).",
        required: true,
      },
    ],
  },
  {
    name: "deprecations",
    description:
      "Find @deprecated APIs and count callers. Wraps searchWorkspace + findReferences.",
    arguments: [],
  },
  {
    name: "coverage-gap",
    description:
      "Identify untested functions by correlating coverage with document symbols. Wraps getCodeCoverage + getDocumentSymbols.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
    ],
  },
  {
    name: "explore-type",
    description:
      "Explore a type: declaration, definition, and all implementations. Wraps getHover + goToDeclaration + goToTypeDefinition + findImplementations.",
    arguments: [
      {
        name: "file",
        description: "File path (workspace-relative or absolute).",
        required: true,
      },
      {
        name: "line",
        description: "Line number (1-based).",
        required: true,
      },
      {
        name: "column",
        description: "Column number (1-based).",
        required: true,
      },
    ],
  },
  {
    name: "ide-coverage",
    description:
      "Generate an HTML coverage heatmap and open in browser. Requires --full mode (getCodeCoverage + openInBrowser).",
    arguments: [],
  },
  {
    name: "ide-deps",
    description:
      "D3 force-directed dependency graph for an entry point, opened in browser. Requires --full mode.",
    arguments: [
      {
        name: "file",
        description: "Entry point file path.",
        required: true,
      },
      {
        name: "line",
        description: "Line number (1-based).",
        required: true,
      },
      {
        name: "column",
        description: "Column number (1-based).",
        required: true,
      },
    ],
  },
  {
    name: "ide-diagnostics-board",
    description:
      "Workspace diagnostics grouped by severity/file, rendered as a sortable HTML table in the browser.",
    arguments: [],
  },
];

// ── Orient-project prompt text builder ────────────────────────────────────────

const ORIENT_PHASE_1 = `## Phase 1 — Discover the project

1. Call \`getProjectInfo\` to detect:
   - Language/runtime (TypeScript, Python, Rust, Go, etc.)
   - Package manager (npm, pnpm, yarn, pip, cargo, go)
   - Frameworks and key dependencies
   - Build, test, lint, and dev scripts
   - Monorepo structure (if any)

2. Call \`getFileTree\` with depth 2 to see the directory layout

3. Call \`getGitStatus\` to check if this is a git repo and its current state

4. Call \`findFiles\` with these patterns to check what already exists:
   - \`CLAUDE.md\`
   - \`documents/*.md\`
   - \`docs/adr/*.md\`
   - \`.claude/rules/*.md\`
   - \`.claude/settings.local.json\`
   - \`README.md\`

Store all results mentally — you will use them in every subsequent phase.`;

function buildOrientPhase2(style: OrientStyle): string {
  const lines = [
    "## Phase 2 — Generate or update CLAUDE.md",
    "",
    "Based on the project info from Phase 1, create or update the project's CLAUDE.md.",
  ];

  if (style !== "minimal") {
    lines.push(
      "The CLAUDE.md follows a proven pattern: it is the **entry point** that directs Claude",
      "to `documents/` for reference documentation and `docs/adr/` for design decisions.",
    );
  }

  lines.push(
    "",
    "### If CLAUDE.md does NOT exist:",
    "",
    "Create it with `createFile` at the workspace root. The content should have TWO sections:",
    "",
    "**Section A — Project-specific context** (generate from `getProjectInfo` results):",
    "",
    "```markdown",
    "# <Project Name> — Project Instructions",
    "",
  );

  if (style !== "minimal") {
    lines.push(
      "## Documentation",
      "",
      "Read and comply with all documents in `/documents/`. Consult the relevant doc before making changes:",
      "",
      "- **[documents/architecture.md](documents/architecture.md)** — System architecture and data flows",
      "- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions and patterns",
      "- **[documents/roadmap.md](documents/roadmap.md)** — Development direction and version history",
      "- **[docs/adr/](docs/adr/)** — Architecture Decision Records",
      "",
    );
  }

  lines.push(
    "## Tech Stack",
    "- Language: <detected language>",
    "- Framework: <detected framework(s)>",
    "- Package manager: <detected>",
    "- Test runner: <detected>",
    "",
    "## Key Commands",
    "| Task | Command |",
    "|------|---------|",
    "| Build | `<detected build command>` |",
    "| Test | `<detected test command>` |",
    "| Lint | `<detected lint command>` |",
    "| Dev | `<detected dev command>` |",
    "",
    "## Project Structure",
    "<Top-level directory listing with one-line descriptions based on getFileTree results>",
    "",
    "## Conventions",
    "<Infer 3-5 conventions from config files detected by getProjectInfo:",
    '- If tsconfig.json: "TypeScript strict mode" (check if strict: true)',
    '- If biome.json/eslint: "Linting with <tool>"',
    '- If prettier/.prettierrc: "Formatting with Prettier"',
    '- If vitest/jest: "Testing with <framework>"',
    '- If .github/workflows: "CI via GitHub Actions">',
    "```",
    "",
    "**Section B — Bridge workflow section:**",
    "",
    "Append the standard Claude IDE Bridge section. Include ALL of the following:",
    "- `## Claude IDE Bridge` header",
    '- "The bridge is connected via MCP. Call `getToolCapabilities` at the start of each session..."',
    "- Bug fix methodology (test-first: write failing test, fix, confirm)",
    "- Documentation & memory rules (update CLAUDE.md after arch changes, save decisions to memory, prune stale instructions)",
    "- Modular rules note (reference `.claude/rules/` directory)",
    "- Workflow rules (getDiagnostics after edits, runTests, bridge git tools, debugging, navigation)",
    "- Quick reference table (14 tasks mapped to tools)",
    "- Dispatch prompts table (phone message → prompt → tools)",
    "- Agent Teams & Scheduled Tasks table",
    "",
    "### If CLAUDE.md ALREADY exists:",
    "",
    "1. Read it with `getBufferContent`",
    "2. Check if it already has a `## Claude IDE Bridge` section",
    "3. If the bridge section is missing: append Section B (bridge section only) using `editText` — do NOT duplicate or overwrite existing project context",
    '4. If the bridge section already exists: report "Bridge section already present — no changes needed"',
  );

  if (style !== "minimal") {
    lines.push(
      "5. Check if the existing CLAUDE.md has a `## Documentation` section referencing `documents/`. If missing, suggest adding it but do NOT modify existing content without asking",
    );
  }

  return lines.join("\n");
}

const ORIENT_PHASE_3_DOCS = `## Phase 3 — Scaffold documents/ directory

Create documentation stubs that do not already exist. These give Claude and developers
a structure to fill in over time. Populate what you can from \`getProjectInfo\` and
\`getFileTree\` results; leave \`<placeholders>\` for the rest.

### documents/architecture.md

\`\`\`markdown
# Architecture

## Overview
<Describe the system architecture, key components, and how they interact>

## Data Flow
<Request lifecycle, state ownership, key flows>

## Key Design Decisions
See [docs/adr/](../docs/adr/) for Architecture Decision Records.
\`\`\`

### documents/styleguide.md

\`\`\`markdown
# Style Guide

## Code Conventions
<Naming, formatting, file organization rules for this project>

## Patterns
<Common patterns used across the codebase>

## Anti-patterns
<What to avoid and why>
\`\`\`

### documents/roadmap.md

\`\`\`markdown
# Roadmap

## Current Version
<version> — <date>

## Recent Changes
<What shipped recently>

## Planned
<What's next>
\`\`\`

Use \`createFile\` for each file. If \`documents/\` does not exist, \`createFile\` will create intermediate directories.
Only create files that do NOT already exist (check Phase 1 results).`;

const ORIENT_PHASE_3_DOCS_FULL_EXTRA = `
### documents/use-cases.md (full style only)

\`\`\`markdown
# Use Cases

## Workflows
<Key user workflows and how they map to code paths>

## Integration Points
<External systems, APIs, and how they connect>
\`\`\``;

const ORIENT_PHASE_3B_ADR = `## Phase 3b — Scaffold docs/adr/ directory

Create the ADR directory with a README template if it does not already exist.

### docs/adr/README.md

\`\`\`markdown
# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for non-obvious design decisions.

## Format

Each ADR follows this template:

- **Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Context:** The problem or situation
- **Decision:** The choice made
- **Consequences:** Positive and negative outcomes

## Index

| ADR | Title | Status |
|-----|-------|--------|
| (none yet) | | |

## When to write an ADR

Write an ADR when:
- A design decision is non-obvious and someone might question it later
- You chose between multiple valid approaches
- A constraint or trade-off shaped the design
- You are deprecating or replacing an existing pattern
\`\`\`

Do NOT create numbered ADR files — those are written by developers as decisions arise. The README gives them the template and format.`;

const ORIENT_PHASE_3C_RULES = `## Phase 3c — Scaffold .claude/rules/

Create rule files that do NOT already exist (check Phase 1 results).

### For ALL project types, create:

**.claude/rules/bridge-tools.md** (skip if already exists — written by \`claude-ide-bridge init\`):
\`\`\`markdown
${_bridgeToolsTemplate}
\`\`\`

Also add \`@import .claude/rules/bridge-tools.md\` to the top of the \`## Claude IDE Bridge\` section in CLAUDE.md if not already present.

**.claude/rules/testing.md:**
\`\`\`markdown
# Testing Rules

- Write tests BEFORE fixing bugs (test-first methodology)
- Use \`runTests\` bridge tool instead of shell commands
- After creating tests, call \`getDiagnostics\` to verify no type errors in test files
- Follow existing test file naming: \`<name>.test.<ext>\` (or \`<name>_test.<ext>\` for Go)
- Test edge cases: empty inputs, null/undefined, boundary values, error conditions
- Call \`getCodeCoverage\` (if available) to identify untested paths before writing tests
\`\`\`

**.claude/rules/security.md:**
\`\`\`markdown
# Security Rules

- Never commit secrets, API keys, tokens, or credentials
- Validate all user inputs at trust boundaries
- Use parameterized queries for database operations — never string concatenation
- Check \`getSecurityAdvisories\` and \`auditDependencies\` before releases
- Review authentication and authorization on every endpoint change
- Sanitize data before rendering in templates (XSS prevention)
\`\`\`

**.claude/rules/workflow.md:**
\`\`\`markdown
# Workflow Rules

- After editing ANY file, call \`getDiagnostics\` to catch regressions
- Use bridge git tools (\`getGitStatus\`, \`gitAdd\`, \`gitCommit\`) for auditable operations
- Call \`getProjectInfo\` at the start of each session for context
- Use \`goToDefinition\` and \`findReferences\` instead of grep for code navigation
- Check \`getOpenEditors\` for context on what the user is working on
- Run \`formatDocument\` before committing if a formatter is configured
\`\`\`

### Language-specific rules (based on getProjectInfo detection):

**If TypeScript/JavaScript detected, also create .claude/rules/typescript.md:**
\`\`\`markdown
# TypeScript Rules

- Enable and respect \`strict\` mode in tsconfig.json
- Prefer \`interface\` over \`type\` for object shapes (unless union/intersection needed)
- Use \`as const\` for literal types and readonly arrays
- Never use \`any\` — use \`unknown\` with type guards instead
- Prefer \`??\` (nullish coalescing) over \`||\` for default values
- Handle Promise rejections — no unhandled promise warnings
\`\`\`

**If Python detected, also create .claude/rules/python.md:**
\`\`\`markdown
# Python Rules

- Use type hints on all function signatures
- Follow PEP 8 style conventions
- Prefer \`pathlib.Path\` over \`os.path\` for file operations
- Use context managers (\`with\` statements) for resource management
- Handle exceptions specifically — avoid bare \`except:\`
- Use \`dataclasses\` or \`pydantic\` for data structures
\`\`\`

**If Rust detected, also create .claude/rules/rust.md:**
\`\`\`markdown
# Rust Rules

- Follow the ownership model — minimize \`.clone()\` calls
- Use \`Result<T, E>\` for fallible operations, not panics
- Prefer \`&str\` over \`String\` in function parameters
- Use \`cargo clippy\` diagnostics (check via \`getDiagnostics\`)
- Implement \`Display\` and \`Error\` traits for custom error types
- Use \`#[must_use]\` on functions whose return values should not be ignored
\`\`\`

**If Go detected, also create .claude/rules/go.md:**
\`\`\`markdown
# Go Rules

- Follow effective Go conventions and Go proverbs
- Handle errors explicitly — never use \`_\` to discard errors
- Use \`context.Context\` as the first parameter for functions that do I/O
- Prefer table-driven tests
- Run \`go vet\` and \`golangci-lint\` via diagnostics tools
- Use meaningful variable names — avoid single-letter names outside loops
\`\`\`

Use \`createFile\` for each rule file. Only create files that do NOT already exist.`;

const ORIENT_PHASE_3D_FULL = `## Phase 3d — Additional scaffolding (full style only)

### Create .claude/commands/orient.md:

\`\`\`markdown
Re-run project orientation: discover project type, update CLAUDE.md, and verify bridge connectivity.

Call the \`orient-project\` MCP prompt to re-orient this project. This is safe to run multiple times — it will only create files that don't already exist and will not overwrite existing content.
\`\`\`

This lets users re-run orientation via \`/project:orient\` in Claude Code.

### Create .claude/agents/project-builder.md:

\`\`\`markdown
---
name: project-builder
description: Build, test, and lint the project. Use when you need to verify changes compile and pass tests.
disallowedTools: Edit, Write
model: sonnet
---

You are a build verification agent. Your job is to verify the project builds, tests pass, and linting is clean.

1. Call \`getProjectInfo\` to detect build/test/lint commands
2. Call \`runTests\` to run the test suite
3. Call \`getDiagnostics\` to check for compilation errors
4. If there is a build script, call \`runCommand\` with it
5. Report results in a structured format:
   - BUILD: PASS/FAIL
   - TESTS: N passed, M failed
   - LINT: N errors, M warnings
\`\`\`

For non-TypeScript/JavaScript projects, adapt the agent instructions to use the appropriate build/test tools (cargo build, go build, pytest, etc.).`;

const ORIENT_PHASE_4 = `## Phase 4 — Verify bridge connectivity

1. Call \`getToolCapabilities\` to confirm:
   - Which CLI tools are available (git, rg, fd)
   - Whether the VS Code extension is connected
   - Which linters and formatters are detected
   - Which test runners are available

2. If the extension is NOT connected:
   - Note this in the summary but do NOT treat it as a failure
   - Explain which tools will be limited (LSP features: goToDefinition, findReferences, getHover, debugging)

3. If the extension IS connected:
   - Call \`getDiagnostics\` with no file argument to verify it returns results
   - Confirm full tool access

Report any issues found.`;

function buildOrientPhase5(style: OrientStyle): string {
  const lines = [
    "## Phase 5 — Summary report",
    "",
    "Produce a structured summary of everything that was done:",
    "",
    "```",
    "# Orient Project — Summary",
    "",
    "## Project",
    "- Name: <name>",
    "- Type: <language/framework>",
    "",
    "## Files",
    "- [ ] CLAUDE.md — <created | updated | already up to date>",
  ];

  if (style !== "minimal") {
    lines.push(
      "- [ ] documents/architecture.md — <created | already existed>",
      "- [ ] documents/styleguide.md — <created | already existed>",
      "- [ ] documents/roadmap.md — <created | already existed>",
      "- [ ] docs/adr/README.md — <created | already existed>",
      "- [ ] .claude/rules/bridge-tools.md — <created | already existed>",
      "- [ ] .claude/rules/testing.md — <created | already existed>",
      "- [ ] .claude/rules/security.md — <created | already existed>",
      "- [ ] .claude/rules/workflow.md — <created | already existed>",
      "- [ ] .claude/rules/<language>.md — <created | already existed | N/A>",
    );
  }

  lines.push(
    "",
    "## Bridge status",
    "- Extension: <connected | not connected>",
    "- CLI tools: <list available>",
    "- Test runner: <detected runner>",
    "",
    "## Next steps",
    "1. Review CLAUDE.md and fill in project-specific sections",
  );

  if (style !== "minimal") {
    lines.push(
      "2. Fill in documents/architecture.md with your system design",
      "3. Fill in documents/styleguide.md with your code conventions",
      "4. Review .claude/rules/ and adjust to match your team's preferences",
      "5. Run `/health-check` to verify tests and diagnostics",
      "6. Write your first ADR when you make a non-obvious design decision",
    );
  } else {
    lines.push(
      "2. Run `/health-check` to verify tests and diagnostics",
      "3. Consider re-running with style=standard for full documentation scaffolding",
    );
  }

  lines.push(
    "```",
    "",
    'Keep the summary concise. If everything was already set up, just say "Project already oriented — no changes needed" with a brief status confirmation.',
  );

  return lines.join("\n");
}

type OrientStyle = "minimal" | "standard" | "full";

function buildOrientPromptText(style: OrientStyle): string {
  const sections = [
    "Set up this project to work with the Claude IDE Bridge.",
    "This process is idempotent — safe to run multiple times. It will only create files that do not already exist and will not overwrite existing content.",
    "",
    ORIENT_PHASE_1,
    "",
    buildOrientPhase2(style),
  ];

  if (style !== "minimal") {
    sections.push("", ORIENT_PHASE_3_DOCS);
    if (style === "full") {
      sections.push(ORIENT_PHASE_3_DOCS_FULL_EXTRA);
    }
    sections.push("", ORIENT_PHASE_3B_ADR);
    sections.push("", ORIENT_PHASE_3C_RULES);
    if (style === "full") {
      sections.push("", ORIENT_PHASE_3D_FULL);
    }
  }

  sections.push("", ORIENT_PHASE_4);
  sections.push("", buildOrientPhase5(style));

  return sections.join("\n");
}

// ── Prompt template strings ───────────────────────────────────────────────────

const TEMPLATES: Record<
  string,
  (args: Record<string, string>) => GetPromptResult
> = {
  "review-changes": ({ file }) => ({
    description: `Review uncommitted changes to ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Review uncommitted changes to \`${file}\`.`,
            "",
            "1. getGitDiff for the file — what changed",
            "2. getDiagnostics for the file — current errors/warnings",
            "3. getGitHotspots — is this a high-churn file?",
            "",
            "Format findings as one line each: [Category] file:line — issue — recommendation",
            "Categories: Correctness | Style | Perf | Security | Tests | Design",
            "End with a one-line commit message suggestion. No prose between findings.",
          ].join("\n"),
        },
      },
    ],
  }),

  "review-file": ({ file }) => ({
    description: `Code review of ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Code review: \`${file}\`.`,
            "",
            "getDiagnostics + getBufferContent first.",
            "",
            "Format each finding as one line: [Category] file:line — issue — fix",
            "Categories: Correctness | Style | Perf | Security | Tests",
            "Max 20 findings. No prose between findings.",
          ].join("\n"),
        },
      },
    ],
  }),

  "explain-diagnostics": ({ file }) => ({
    description: `Explain diagnostics for ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getDiagnostics for \`${file}\`.`,
            "",
            "Each error: 1-line cause + corrected code block. Apply fix with editText. No prose.",
          ].join("\n"),
        },
      },
    ],
  }),

  "generate-tests": ({ file }) => ({
    description: `Generate tests for ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `Generate unit tests for \`${file}\`.`,
            "",
            "1. getBufferContent — read file",
            "2. findFiles — check existing test conventions",
            "3. getCodeCoverage (if available) — find uncovered paths",
            "4. Write tests: happy paths, edge cases, error conditions, boundary values.",
            "Match project testing framework + style exactly.",
          ].join("\n"),
        },
      },
    ],
  }),

  "debug-context": (_args) => ({
    description: "Current IDE debug context",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "IDE debug snapshot:",
            "",
            "1. getOpenEditors — open files",
            "2. getDiagnostics — errors/warnings per open file",
            "3. getTerminalOutput — active terminal output",
            "4. getGitStatus — uncommitted changes",
            "",
            "Root causes of problems: 1 line each.",
          ].join("\n"),
        },
      },
    ],
  }),

  cowork: ({ task = "" }) => {
    const taskLine = task ? `\nFocus: **${task}**\n` : "";
    return {
      description: task
        ? `Cowork context — ${task}`
        : "Cowork context — full IDE snapshot",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "**Context check:** If bridge tools (getHandoffNote, getOpenEditors, etc.) are not in your available tools list, you are inside a Cowork session where MCP is unavailable. Exit Cowork, run this prompt in regular Claude Code or Desktop chat to collect context and set a handoff note, then return to Cowork.",
              "",
              "## Step 1 of 2 — Gather IDE context (you are here)",
              "",
              "⚠️  **Important:** Cowork (computer-use) sessions do NOT have access to MCP bridge tools.",
              "This prompt must be run in a regular Claude Code or Claude Desktop chat BEFORE opening Cowork.",
              taskLine,
              "Collect full IDE context:",
              "",
              "1. Call `getHandoffNote` — check for prior session context or an in-progress task",
              "2. Call `getOpenEditors` — list open files and any unsaved changes",
              "3. Call `getDiagnostics` — surface errors and warnings across the workspace",
              "4. Call `getGitStatus` — show staged, unstaged, and untracked changes",
              "5. Call `getProjectInfo` — detect project type, key scripts, and dependencies",
              "",
              "After collecting context:",
              "- Summarise the current workspace state in 3–5 bullet points",
              "- Propose a concrete, step-by-step Cowork action plan",
              "- Call out anything that needs clarification before starting",
              "",
              "## Step 2 of 2 — Hand off to Cowork",
              "",
              "Once the plan is clear, call `setHandoffNote` with a concise summary so the Cowork session",
              "can pick up where you left off. Then open Cowork (Cmd+2 on Mac) and type:",
              "",
              "  /mcp__bridge__cowork",
              "",
              "The Cowork session will read the handoff note and execute the plan using computer-use.",
              "",
              "---",
              "After the tool calls above, end your response with a ready-to-use `setHandoffNote` call",
              "that summarises the task, relevant file paths, and the action plan in 3–5 bullets.",
            ].join("\n"),
          },
        },
      ],
    };
  },

  "set-effort": ({ level = "medium" }) => {
    const validLevels = ["low", "medium", "high"] as const;
    type EffortLevel = (typeof validLevels)[number];
    const eff: EffortLevel = (validLevels as readonly string[]).includes(level)
      ? (level as EffortLevel)
      : "medium";
    const guidance: Record<EffortLevel, string> = {
      low: "Respond concisely. Prefer quick, direct answers without extensive analysis or exhaustive edge-case coverage.",
      medium:
        "Balance thoroughness with speed. Cover the main cases and explain your reasoning briefly.",
      high: "Apply maximum effort. Think step by step, explore edge cases, and produce the most complete and correct result possible.",
    };
    return {
      description: `Effort level set to: ${eff}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text" as const,
            text: `[Effort instruction for this task]\n${guidance[eff]}\n\nPlease acknowledge this effort level and apply it to all subsequent work in this conversation.`,
          },
        },
      ],
    };
  },

  "gen-claude-md": (_args) => ({
    description: "Generate bridge workflow section for CLAUDE.md",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Add the Claude IDE Bridge workflow section to this project's `CLAUDE.md`.",
            "",
            "Steps:",
            "1. Check if `CLAUDE.md` already exists in the workspace root using `findFiles`",
            "2. If it exists, read it with `getBufferContent` to check for an existing `## Claude IDE Bridge` section",
            "3. If the section already exists, report that no changes are needed",
            "4. Otherwise, append the following content to `CLAUDE.md` (or create it if absent):",
            "",
            "---",
            "## Claude IDE Bridge",
            "",
            "The bridge is connected via MCP. Call `getToolCapabilities` at the start of each session to confirm which tools are available and note any that require the VS Code extension.",
            "",
            "### Workflow rules",
            "",
            "- **After editing any file** — call `getDiagnostics` to catch errors introduced by the change",
            "- **Running tests** — use `runTests` instead of shell commands; output streams in real time",
            "- **Git operations** — use bridge git tools (`gitStatus`, `gitAdd`, `gitCommit`, `gitPush`) for structured, auditable operations",
            "- **Debugging** — use `setDebugBreakpoints` → `startDebugging` → `evaluateInDebugger` for interactive debugging",
            "- **Navigating code** — prefer `goToDefinition`, `findReferences`, and `getCallHierarchy` over grep",
            "",
            "### Quick reference",
            "",
            "| Task | Tool |",
            "|---|---|",
            "| Check errors / warnings | `getDiagnostics` |",
            "| Run tests | `runTests` |",
            "| Git status / diff | `gitStatus`, `gitDiff` |",
            "| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` |",
            "| Open a pull request | `githubCreatePR` |",
            "| Navigate to definition | `goToDefinition` |",
            "| Find all references | `findReferences` |",
            "| Call hierarchy | `getCallHierarchy` |",
            "| File tree / symbols | `getFileTree`, `getDocumentSymbols` |",
            "| Run a shell command | `runInTerminal`, `getTerminalOutput` |",
            "| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` |",
            "| Lint / format | `fixAllLintErrors`, `formatDocument` |",
            "| Security audit | `getSecurityAdvisories`, `auditDependencies` |",
            "| Unused code | `detectUnusedCode` |",
            "---",
          ].join("\n"),
        },
      },
    ],
  }),

  "git-review": ({ base = "main" }) => ({
    description: `Review changes vs ${base}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getGitDiff (vs \`${base}\`) + getGitStatus + getDiagnostics (changed files).`,
            "",
            "Bugs/logic problems introduced.",
            "Style/consistency issues.",
            "Missing tests for new code.",
            "Suggested commit msg (conventional-commits).",
          ].join("\n"),
        },
      },
    ],
  }),

  // ── Dispatch prompts (phone-friendly, terse triggers) ───────────────────────

  "project-status": (_args) => ({
    description: "Project health check",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "getGitStatus + getDiagnostics + runTests. Report:",
            "```",
            "Branch: <name> (<clean|N uncommitted>)",
            "Diag: <N errors, M warnings | clear>",
            "Tests: <N passed, M failed | passing>",
            "```",
            "Broken → 1-line cause each. ≤20 lines total.",
          ].join("\n"),
        },
      },
    ],
  }),

  "quick-tests": ({ filter = "" }) => {
    const filterLine = filter ? `\nFilter: \`${filter}\`\n` : "";
    return {
      description: filter ? `Run tests: ${filter}` : "Run all tests",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Run the project's tests and return a concise summary for mobile reading.",
              filterLine,
              filter
                ? `1. Call \`runTests\` with filter \`${filter}\``
                : "1. Call `runTests` with no filter (full suite)",
              "2. Report pass/fail counts and total duration",
              "3. For failures (up to 5): show test name + one-line reason",
              "4. If all pass, just say: 'All N tests passing (Xs)'",
              "",
              "Keep the response under 15 lines. No stack traces — just test name and failure reason.",
            ].join("\n"),
          },
        },
      ],
    };
  },

  "quick-review": (_args) => ({
    description: "Review uncommitted changes",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "getGitStatus + getGitDiff + getDiagnostics (changed files, ≤10).",
            "",
            "1 line per changed file: what changed.",
            "New errors/warnings introduced.",
            "1-line verdict: safe to commit?",
            "≤25 lines. Skip unchanged files.",
          ].join("\n"),
        },
      },
    ],
  }),

  "build-check": (_args) => ({
    description: "Build/compile check",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "getProjectInfo + getDiagnostics + runCommand (build script).",
            "",
            "BUILD PASSING or BUILD FAILING.",
            "Failing → file:line:msg, ≤10 errors.",
            "Passing → '0 errors'. ≤15 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "recent-activity": ({ count = "10" }) => ({
    description: `Recent activity (last ${count} commits)`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getGitLog (limit ${count}) + getGitStatus.`,
            "",
            "Each commit: `<hash> <rel-time> <subject>` — 1 line.",
            "Uncommitted → append 'WIP' section.",
            "No author/full date.",
          ].join("\n"),
        },
      },
    ],
  }),

  // ── Agent Teams & Scheduled Tasks prompts ───────────────────────────────────

  "team-status": (_args) => ({
    description: "Agent team overview",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "getGitStatus + getDiagnostics + getOpenEditors + listClaudeTasks + getActivityLog (last 10).",
            "",
            "```",
            "## Workspace",
            "Branch: <name> (<clean|N uncommitted>)",
            "Diag: <N errors, M warnings>",
            "Open: <files>",
            "",
            "## Tasks",
            "<taskId> <status> <prompt[:60]>",
            "",
            "## Activity",
            "<time> <tool> <session> <result>",
            "```",
            "Skip unavailable sections. Flag conflicts (same file, multiple sessions).",
          ].join("\n"),
        },
      },
    ],
  }),

  "orient-project": ({ style = "standard" }) => {
    const validStyles = ["minimal", "standard", "full"] as const;
    const s: OrientStyle = (validStyles as readonly string[]).includes(style)
      ? (style as OrientStyle)
      : "standard";
    return {
      description: "Orient project for Claude IDE Bridge",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildOrientPromptText(s),
          },
        },
      ],
    };
  },

  "health-check": (_args) => ({
    description: "Comprehensive project health check",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Project health check. Terse output — counts + failures only, no prose.",
            "",
            "1. getGitStatus — branch, uncommitted, ahead/behind",
            "2. getDiagnostics — errors + warnings grouped by file",
            "3. runTests — pass/fail/skip counts + failures",
            "4. getSecurityAdvisories — CVEs in deps",
            "5. auditDependencies (if available) — pkg audit",
            "",
            "Format as a structured health report:",
            "```",
            "# Project Health Report",
            "",
            "## Git",
            "Branch: <name>",
            "Status: <clean | N uncommitted changes>",
            "Remote: <up to date | N ahead, M behind>",
            "",
            "## Diagnostics",
            "Errors: N | Warnings: M",
            "<file:line — message>  (list all errors, up to 20)",
            "",
            "## Tests",
            "Result: <N passed, M failed, K skipped> (Xs)",
            "<failing test name — reason>  (list all failures)",
            "",
            "## Security",
            "Advisories: <N critical, M high, K moderate | None found>",
            "<package — severity — advisory title>  (list all)",
            "",
            "## Overall: HEALTHY | DEGRADED | FAILING",
            "```",
            "",
            "Use HEALTHY if: 0 errors, all tests pass, no critical/high advisories.",
            "Use DEGRADED if: warnings only, or moderate advisories.",
            "Use FAILING if: any errors, test failures, or critical/high advisories.",
            "",
            "If `getSecurityAdvisories` or `auditDependencies` are unavailable, note 'Security: not checked (tools unavailable)'.",
          ].join("\n"),
        },
      },
    ],
  }),

  // ── LSP composition prompts ──────────────────────────────────────────────

  "find-callers": ({ symbol }) => ({
    description: `Find callers of ${symbol}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `searchWorkspaceSymbols("${symbol}") → getCallHierarchy(incoming) → findReferences (cross-verify dynamic dispatch).`,
            "",
            "```",
            `Symbol: ${symbol} @ <file:line>`,
            "Callers (N):",
            "  <file:line> <fn>",
            "```",
            "≤25 lines. Not found → stop.",
          ].join("\n"),
        },
      },
    ],
  }),

  "blast-radius": ({ file, line, column }) => ({
    description: `Blast radius at ${file}:${line}:${column}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getChangeImpact(${file}:${line}:${column}) → blastRadius, referenceCount, affectedFiles, diagnostics.`,
            "",
            "```",
            `${file}:${line}:${column}`,
            "Risk: <LOW|MEDIUM|HIGH>",
            "Refs: N (M files)",
            "Diag: X errors, Y warnings",
            "Top affected: <file> (<refs> refs)",
            "```",
            "MEDIUM/HIGH → top 5 files. ≤20 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "why-error": ({ file, line }) => {
    const lineHint = line ? ` (focus on line ${line})` : "";
    return {
      description: `Explain error in ${file}${lineHint}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `getDiagnostics(${file}) → ${line ? `nearest err to line ${line}` : "first error"} → explainSymbol + getHover at position.`,
              "",
              "What err says. Why wrong (use type info). Fix → corrected code.",
              "≤30 lines. No jargon without def.",
            ].join("\n"),
          },
        },
      ],
    };
  },

  "unused-in": ({ file }) => ({
    description: `Unused code in ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `detectUnusedCode(${file}) → findReferences per candidate (verify 0 ext uses) → cross-check imports.`,
            "",
            "```",
            `## Unused in ${file}`,
            "### Dead (0 refs) — safe delete",
            "- <kind> <name> (<line>)",
            "### Local-only — consider private",
            "- <kind> <name> (<line>)",
            "### Unused imports — safe remove",
            "- <import> (<line>)",
            "```",
            "Nothing unused → stop. ≤30 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "trace-to": ({ symbol }) => ({
    description: `Trace call chain to ${symbol}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `searchWorkspaceSymbols("${symbol}") → getCallHierarchy(incoming, ≤5 levels) → getHover per hop → getImportedSignatures on entry file.`,
            "",
            "```",
            "Entry: <fn>(<args>): <ret> @ <file:line>",
            "  ↓",
            "<intermediate>(<args>): <ret> @ <file:line>",
            "  ↓",
            `${symbol}(<args>): <ret> @ <file:line>`,
            "```",
            "≤35 lines. Multiple entry points → 2 shortest chains.",
          ].join("\n"),
        },
      },
    ],
  }),

  "imports-of": ({ symbol }) => ({
    description: `Files importing ${symbol}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `searchWorkspaceSymbols("${symbol}") → findReferences (filter to import statements) → count inline refs per file.`,
            "",
            "```",
            `${symbol} imported by N files:`,
            "  <file> — <refs> uses",
            "```",
            "Sort by refs desc. ≤25 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "circular-deps": (_args) => ({
    description: "Detect circular import dependencies",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "getProjectInfo → getImportTree(entry points, depth≥5) → cycles array. No entry points → getFileTree, pick top 3.",
            "",
            "```",
            "Cycle 1: <a>→<b>→<c>→<a>",
            "```",
            "No cycles → 'No circular deps found'. ≤20 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "refactor-preview": ({ file, line, column, newName }) => ({
    description: `Preview rename to ${newName} at ${file}:${line}:${column}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `refactorAnalyze(${file}:${line}:${column}) → risk/referenceCount/callerCount. refactorPreview(newName:'${newName}') → edit list. Preview only — do NOT apply.`,
            "",
            "```",
            `Rename: <old>→${newName}`,
            "Risk: <LOW|MEDIUM|HIGH> | Refs: N | Callers: M",
            "Edits: K total, J files",
            "  <file>: <count>",
            "```",
            "HIGH → recommend tests first. ≤25 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "module-exports": ({ file }) => ({
    description: `Module exports of ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getDocumentSymbols(${file}) → filter top-level exports → getHover per export for type sig.`,
            "",
            "```markdown",
            `## Exports of \`${file}\``,
            "### Functions",
            "- `fn(args): ReturnType` — JSDoc desc",
            "### Classes / Types / Constants",
            "- `Name: Type`",
            "```",
            "Skip private/internal. Public API only.",
          ].join("\n"),
        },
      },
    ],
  }),

  "type-of": ({ file, line, column }) => ({
    description: `Type at ${file}:${line}:${column}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getTypeSignature(${file}:${line}:${column}). Fallback: getHoverAtCursor → extract first code block.`,
            "",
            "Output: single fenced code block, nothing else.",
            "No info → 'No type info at this position.'",
          ].join("\n"),
        },
      },
    ],
  }),

  deprecations: (_args) => ({
    description: "Find deprecated APIs and their callers",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "searchWorkspace('@deprecated', **/*.{ts,tsx,js,jsx,py,go,rs}) → findReferences per symbol (caller count) → getHover (migration hint).",
            "",
            "```markdown",
            "## Deprecated APIs (N total, M in use)",
            "### High callers (urgent)",
            "- `sym` (K callers) @ <file:line> — Migration: <msg>",
            "### Low callers (easy cleanup)",
            "- `sym` (1 caller)",
            "### Unused (safe delete)",
            "- `sym` (0 callers)",
            "```",
            "Sort by callers desc. ≤50 lines.",
          ].join("\n"),
        },
      },
    ],
  }),

  "coverage-gap": ({ file }) => ({
    description: `Coverage gaps in ${file}`,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getCodeCoverage(${file}) → getDocumentSymbols(${file}) → covered/total per fn. Sort asc (least-tested first).`,
            "",
            "```",
            `## Coverage gaps: ${file}`,
            "Untested (0%): - fn (L1-L2)",
            "Partial (<50%): - fn (L1-L2) N/M lines",
            "Covered (≥50%): <count> fns",
            "```",
            "No coverage → 'Run tests with coverage first'. ≤30 lines.",
          ].join("\n"),
        },
      },
    ],
  }),
  "explore-type": ({ file, line, column }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `getHover(${file}:${line}:${column}) → goToDeclaration → goToTypeDefinition → findImplementations → getHover per impl (≤5).`,
            "",
            `**Symbol:** <name> — <type sig>`,
            `**Declaration:** <file>:<line>`,
            `**Type defined:** <file>:<line>`,
            `**Impls (N):** 1. <file>:<line> — <sig>`,
            `No results → note clearly (e.g. "No declaration found").`,
          ].join("\n"),
        },
      },
    ],
  }),

  "ide-coverage": (_args) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Generate an HTML code-coverage heatmap and open it in the browser.",
            "",
            "⚠️  This prompt requires --full mode. First call `getToolCapabilities` — if `getCodeCoverage` or `openInBrowser` are absent, stop and respond: 'This prompt requires --full mode. Restart the bridge with --full.'",
            "",
            "Steps:",
            "1. Call `getCodeCoverage` with no arguments to fetch the full coverage report.",
            "2. Parse the returned file entries. For each file compute a coverage percentage (coveredLines / totalLines).",
            "3. Build a self-contained HTML page:",
            "   - Title: 'Code Coverage Heatmap'",
            "   - A sortable table with columns: File, Lines, Covered, Uncovered, Coverage %",
            "   - Color rows: green (≥80%), yellow (50–79%), red (<50%)",
            "   - A summary bar at the top showing overall coverage %",
            "4. Write the HTML to a temp file (e.g. /tmp/coverage-heatmap.html).",
            "5. Call `openInBrowser` with that file path.",
          ].join("\n"),
        },
      },
    ],
  }),

  "ide-deps": (args) => {
    const { file, line, column } = args;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Build a D3 force-directed dependency graph for the symbol at ${file}:${line}:${column} and open it in the browser.`,
              "",
              "⚠️  This prompt requires --full mode for openInBrowser. First call `getToolCapabilities` — if `openInBrowser` is absent, stop and respond: 'This prompt requires --full mode. Restart the bridge with --full.'",
              "",
              "Steps:",
              `1. Call \`getCallHierarchy\` at ${file}:${line}:${column} with direction="outgoing" to collect direct callees.`,
              '2. For each callee (up to depth 2, max 30 nodes total), call `getCallHierarchy` with direction="outgoing" again.',
              "3. Build a JSON graph: { nodes: [{id, label, file}], links: [{source, target}] }",
              "4. Generate a self-contained HTML page with D3 v7 (use CDN) that renders a force-directed graph:",
              "   - Nodes are labeled with the symbol name",
              "   - Edges point from caller → callee",
              "   - Hovering a node shows file:line in a tooltip",
              "   - Include zoom/pan via d3.zoom()",
              "5. Write the HTML to /tmp/dep-graph.html",
              "6. Call `openInBrowser` with that path.",
            ].join("\n"),
          },
        },
      ],
    };
  },

  "ide-diagnostics-board": (_args) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Collect workspace-wide diagnostics and render a sortable HTML board in the browser.",
            "",
            "Steps:",
            "1. Call `getDiagnostics` with no file argument to get all workspace diagnostics.",
            "2. Group diagnostics by severity (error, warning, info, hint) and then by file.",
            "3. Build a self-contained HTML page:",
            "   - Title: 'Diagnostics Board'",
            "   - Severity summary pills at the top (e.g. '12 errors · 5 warnings')",
            "   - A sortable table with columns: Severity, File, Line, Message",
            "   - Color-code rows: red=error, orange=warning, blue=info/hint",
            "   - Add a text filter input that filters rows by file or message",
            "4. Write HTML to /tmp/diagnostics-board.html",
            "5. Call `openInBrowser` with that path.",
          ].join("\n"),
        },
      },
    ],
  }),
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a filled prompt template.
 * Returns null if the name is unknown or a required argument is missing.
 */
export function getPrompt(
  name: string,
  args: Record<string, string>,
): GetPromptResult | null {
  const def = PROMPTS.find((p) => p.name === name);
  if (!def) return null;

  // Validate required arguments
  for (const arg of def.arguments ?? []) {
    if (arg.required && !args[arg.name]) return null;
  }

  const template = TEMPLATES[name];
  if (!template) return null;

  return template(args);
}
