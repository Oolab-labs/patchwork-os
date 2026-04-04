## Bridge Tool Overrides (claude-ide-bridge)

> **These rules are active when the `claude-ide-bridge` MCP server is connected** (green in `/mcp`).  
> If the bridge is not running, fall back to standard shell equivalents.

### MANDATORY: Bridge MCP tools replace shell commands

Do NOT run the shell command. Call the MCP tool instead.

#### Testing

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `npm test`, `npx vitest`, `npx jest`, `yarn test` | `runTests` |

#### Diagnostics & linting

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `tsc --noEmit`, `npm run typecheck` | `getDiagnostics` |
| `eslint .`, `biome check`, `npm run lint` | `getDiagnostics` |
| Assuming edits are error-free after saving | `getDiagnostics` after every file edit |

#### Git

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `git status` | `getGitStatus` |
| `git diff` | `getGitDiff` |
| `git log` | `getGitLog` |
| `git add <file>` | `gitAdd` |
| `git commit -m "..."` | `gitCommit` |
| `git push` | `gitPush` |
| `gh pr create` | `githubCreatePR` |

#### Code search & navigation

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `grep -r`, `rg` | `searchWorkspace` |
| `cat <file>` to read content | `getBufferContent` |
| Jump to where a symbol is defined | `goToDefinition` |
| Find all uses of a symbol | `findReferences` |
| Understand call chains | `getCallHierarchy` |
| Find a class or function by name | `searchWorkspaceSymbols`, `getDocumentSymbols` |

#### Debugging

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `node --inspect`, `node --inspect-brk` | `setDebugBreakpoints` → `startDebugging` |
| Adding `console.log` to inspect values | `evaluateInDebugger` inside a debug session |

#### File tree

| ❌ Do NOT use | ✅ Call instead |
|---|---|
| `ls -R`, `find . -name "*.ts"` | `getFileTree`, `findFiles` |

### Session start

Call `getToolCapabilities` once at the start of each session to confirm which bridge tools are available and whether the VS Code extension is connected.
