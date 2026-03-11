# Claude IDE Bridge — Ideal Customer Profiles (Developer Personas)

Dossiers for each type of developer who uses Claude IDE Bridge. Validate and refine based on actual usage patterns.

---

## Persona 1: Solo Full-Stack Developer

**Background**: Individual developer using Claude Code as their primary AI coding assistant. Works on web applications (TypeScript/React frontend, Node.js/Python backend). Uses VS Code or Windsurf daily.

**Workflow**: Opens project → starts bridge → connects Claude Code → uses AI for feature development, debugging, refactoring. Stays in one workspace for extended sessions (hours).

**Key Features Used**:
- File operations (openFile, searchWorkspace, findFiles)
- Diagnostics & LSP (getDiagnostics, goToDefinition, findReferences, getHover)
- Git operations (status, diff, log, commit)
- Editor state (getCurrentSelection, getOpenEditors, saveDocument)
- Text editing (editText, replaceBlock)

**Pain Points Addressed**:
- Context-switching between CLI and editor
- Manual copy-paste of error messages and code context
- Losing track of what files are open/dirty

**Configuration Preferences**:
- Default settings work well
- May add custom commands to allowlist
- Wants auto-detect for linters and test runners

**Success Metrics**: Reduced context switches, faster debugging cycles, fewer manual file operations

---

## Persona 2: Remote/Mobile Developer

**Background**: Developer who controls Claude Code sessions from their phone, tablet, or a different machine via claude.ai or the Claude mobile app. Uses the remote control feature for long-running tasks.

**Workflow**: Starts bridge + remote control on server/desktop → connects from mobile → issues high-level instructions → monitors progress via terminal output and diagnostics.

**Key Features Used**:
- Remote control auto-restart wrapper
- Terminal operations (runInTerminal, getTerminalOutput, waitForTerminalOutput)
- Activity log (track session progress)
- Workspace snapshots (checkpoint before risky changes)
- start-all.sh orchestrator (manages full stack)

**Pain Points Addressed**:
- Connection drops on mobile networks
- Needing terminal access from any device
- Monitoring long-running AI tasks

**Configuration Preferences**:
- Uses `--notify <topic>` for ntfy push notifications
- Relies on auto-restart for connection stability
- May use Docker deployment

**Success Metrics**: Uptime despite connection drops, successful remote task completion, low notification noise

---

## Persona 3: Multi-Language Developer

**Background**: Works across multiple languages (TypeScript, Python, Rust, Go) on different projects or within a polyglot monorepo. Needs language-appropriate tooling without manual configuration.

**Workflow**: Switches between projects frequently. Expects bridge to auto-detect and configure appropriate linters, formatters, and test runners for each project.

**Key Features Used**:
- Auto-detected linters (tsc, eslint, pyright, ruff, cargo check, go vet, biome)
- Auto-detected test runners (vitest, jest, pytest, cargo test, go test)
- Auto-detected formatters (prettier, black, gofmt, rustfmt)
- getToolCapabilities (verify what's available)
- getProjectInfo (project type detection)

**Pain Points Addressed**:
- Manual linter/formatter configuration per project
- Different CLI tools needed for each language
- Inconsistent diagnostic formats across languages

**Configuration Preferences**:
- Relies heavily on auto-detection (`probeAll()`)
- May override with `--linter` for specific needs
- Uses multi-root workspace support for monorepos

**Success Metrics**: Zero-config language support, consistent diagnostic quality across languages

---

## Persona 4: Team Lead / Code Reviewer

**Background**: Reviews pull requests, manages issues, monitors CI/CD. Uses Claude Code to assist with code review and issue triage. Needs GitHub integration.

**Workflow**: Opens PR → asks Claude to analyze changes → reviews diff → posts review comments. Also: triages issues, monitors workflow runs.

**Key Features Used**:
- GitHub PR tools (listPRs, viewPR, getPRDiff, createPR, postPRReview)
- GitHub Issues (listIssues, getIssue, createIssue, commentIssue)
- GitHub Actions (listRuns, getRunLogs)
- Git diff and log tools
- LSP features for understanding changed code (findReferences, getCallHierarchy)

**Pain Points Addressed**:
- Jumping between GitHub UI, editor, and terminal
- Understanding impact of changes across codebase
- Writing thorough review comments efficiently

**Configuration Preferences**:
- Needs `gh` CLI installed and authenticated
- May work across multiple repositories
- Read-heavy usage (fewer write operations)

**Success Metrics**: Faster PR review cycles, more thorough reviews, fewer context switches

---

## Persona 5: Tool Developer (Contributor)

**Background**: Extends Claude IDE Bridge with new tools or extension handlers. May be contributing to the project or building a private fork.

**Workflow**: Reads existing tool implementations → creates new tool following factory pattern → registers in index → adds extension handler if needed → writes tests → packages extension.

**Key Features Used** (as a developer OF the bridge, not a user):
- Tool factory pattern understanding
- Handler registration pattern
- Extension protocol (request/response + notifications)
- Test infrastructure (vitest)
- Build pipeline (tsc + esbuild + VSIX packaging)

**Pain Points Addressed**:
- Understanding the architecture to contribute safely
- Knowing which patterns to follow
- Testing tools that require extension interaction

**Configuration Preferences**:
- Uses `--verbose` for debug logging
- Uses `--jsonl` for structured event analysis
- May run bridge in dev mode (`npm run dev`)

**Success Metrics**: New tools that integrate cleanly, no regressions, consistent patterns

---

## Cross-Cutting Needs

All personas benefit from:
- **Connection reliability**: auto-reconnect, grace periods, circuit breakers
- **Low latency**: fast tool responses, efficient WebSocket communication
- **Clear error messages**: tool errors that Claude can understand and act on
- **Discoverability**: `getToolCapabilities` reveals what's available
