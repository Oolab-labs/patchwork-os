## Claude IDE Bridge

The bridge is connected via MCP. Call `getToolCapabilities` at the start of each session to confirm which tools are available and note any that require the VS Code extension.

### Workflow rules

- **After editing any file** — call `getDiagnostics` to catch errors introduced by the change
- **Running tests** — use `runTests` instead of shell commands; output streams in real time
- **Git operations** — use bridge git tools (`gitStatus`, `gitAdd`, `gitCommit`, `gitPush`) for structured, auditable operations
- **Debugging** — use `setDebugBreakpoints` → `startDebugging` → `evaluateInDebugger` for interactive debugging
- **Navigating code** — prefer `goToDefinition`, `findReferences`, and `getCallHierarchy` over grep

### Quick reference

| Task | Tool |
|---|---|
| Check errors / warnings | `getDiagnostics` |
| Run tests | `runTests` |
| Git status / diff | `gitStatus`, `gitDiff` |
| Stage, commit, push | `gitAdd`, `gitCommit`, `gitPush` |
| Open a pull request | `githubCreatePR` |
| Navigate to definition | `goToDefinition` |
| Find all references | `findReferences` |
| Call hierarchy | `getCallHierarchy` |
| File tree / symbols | `getFileTree`, `getDocumentSymbols` |
| Run a shell command | `runInTerminal`, `getTerminalOutput` |
| Interactive debug | `setDebugBreakpoints`, `startDebugging`, `evaluateInDebugger` |
| Lint / format | `fixAllLintErrors`, `formatDocument` |
| Security audit | `getSecurityAdvisories`, `auditDependencies` |
| Unused code | `detectUnusedCode` |
