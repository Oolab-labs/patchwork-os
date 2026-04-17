# Contributing to claude-ide-bridge

## Quick Setup

Prerequisites: Node.js ≥20, npm, VS Code (for extension work)

```bash
git clone https://github.com/Oolab-labs/claude-ide-bridge
cd claude-ide-bridge
npm install
npm run build
```

For extension development:
```bash
cd vscode-extension
npm install
npm run build
```

## Running Locally

```bash
# Bridge (from root)
npm run dev                    # tsx watch mode
node dist/index.js --full      # production-like

# Tests
npm test                       # vitest run (all bridge tests)
npm run test:watch             # vitest watch
npm run test:coverage          # coverage report

# Lint + typecheck
npm run lint                   # biome check
npm run lint:fix               # biome check --write
npm run typecheck              # tsc --noEmit
```

## Before Submitting a PR

Run this checklist locally (CI will catch failures, but fix them before pushing):

1. **Biome** on all changed files:
   ```bash
   npx biome check --write src/path/to/changed.ts
   ```
   Watch for: `?.replace()` auto-conversion on prompt variables — restore `!.replace()` if biome changes it.

2. **Description length gate**:
   ```bash
   node scripts/audit-lsp-tools.mjs
   ```
   All tool descriptions must be ≤200 chars.

3. **Schema snapshot** (if you added/changed outputSchema):
   ```bash
   npm run schema:check
   # if adding a new tool with outputSchema:
   npm run schema:update
   ```

4. **Tests pass**:
   ```bash
   npm test
   ```

5. **Typecheck**:
   ```bash
   npm run typecheck
   ```

## Adding a New Tool

1. Create `src/tools/myTool.ts` — use the factory pattern:
   ```typescript
   export function createMyTool(workspace: string, deps: MyDeps) {
     return {
       schema: { name: "myTool", description: "...", inputSchema: { ... }, outputSchema: { ... } },
       handler: async (params) => { ... }
     };
   }
   ```
2. All descriptions ≤200 chars (CI enforces via `audit-lsp-tools.mjs`)
3. Add `outputSchema` — required for all new tools
4. Register in `src/tools/index.ts`
5. Add to `SLIM_TOOL_NAMES` Set if it should be available in slim mode
6. Write unit tests in `src/tools/__tests__/myTool.test.ts`
7. Run the pre-PR checklist above

See `documents/styleguide.md` for full conventions.

## Adding an Extension Handler

Extension handlers live in `vscode-extension/src/handlers/`.

1. Create the handler function in an appropriate file (or a new file)
2. Register it in `vscode-extension/src/handlers/index.ts`
3. Write tests in `vscode-extension/src/__tests__/handlers/`
4. **Critical**: before choosing `tryRequest` vs `validatedRequest` vs direct `requestOrNull`, read ALL return statements in the handler — success AND error paths. Test mocks lie; the handler file is ground truth. Never use `proxy<T>()` for new methods.

## Bug Fix Protocol

1. Write a failing test that reproduces the bug first
2. Fix the bug
3. Confirm the test passes
4. Only then submit the PR

This is enforced by project convention — do not submit bug fixes without a covering test.

## Commit Messages

Conventional Commits format:
```
feat(tools): add getSymbolHistory tool
fix(automation): prevent cascade on onDiagnosticsError
chore(release): bump to v2.30.0
docs: rewrite headless quickstart
```

- Subject ≤72 chars
- Imperative mood: "add", "fix", "remove" — not "added"
- No AI attribution in commit messages
- Body only when the why is non-obvious

## Architecture Overview

Key points for contributors:
- Bridge (`src/`) and VS Code extension (`vscode-extension/`) are separate packages with separate `package.json` files
- Tools communicate with the extension over WebSocket; the extension client lives in `src/extensionClient.ts`
- Tool factory pattern: `createXxxTool(deps)` returns `{ schema, handler }` — register in `src/tools/index.ts`
- MCP transport layer in `src/transport.ts` handles all wire protocol, rate limiting, and session management

## CI Pipeline

Three jobs run on every push:
- **ci** — lint + typecheck + build + test (Node 20 + 22 matrix) + schema audit + description length gate
- **smoke** — integration smoke suite (`needs: ci`)
- **publish-docker** — builds and pushes to ghcr.io on `v*` tags

Publish workflows (manual or tag-triggered):
- **publish-npm** — `workflow_dispatch` with bump type triggers version bump + npm publish
- **publish-extension** — `workflow_dispatch` or `v*` tag push triggers VS Code Marketplace + Open VSX release

## Project Structure

```
src/
  tools/              # MCP tool implementations (factory pattern)
  transport.ts        # MCP protocol layer, rate limiting, session management
  bridge.ts           # Main orchestrator
  extensionClient.ts  # VS Code extension proxy
  automation.ts       # Automation hooks engine
  oauth.ts            # OAuth 2.0 endpoints
vscode-extension/
  src/
    handlers/         # Extension message handlers
    extension.ts      # Extension entry point
documents/            # Feature reference docs (platform-docs, styleguide, roadmap)
docs/                 # Operational docs (deployment, ADRs, troubleshooting)
  adr/                # Architecture Decision Records — read before touching core systems
scripts/              # Build, audit, and smoke test scripts
deploy/               # VPS provisioning and service install scripts
templates/            # Automation policy presets and scheduled task templates
```

## Coverage Requirements

Tests must maintain:
- 75% line coverage
- 70% branch coverage
- 75% function coverage

CI fails below these thresholds. New tools and handlers require tests before the PR can merge.

## Getting Help

- Issues: https://github.com/Oolab-labs/claude-ide-bridge/issues
- Check `docs/troubleshooting.md` for common problems
- `getBridgeStatus` MCP tool reports bridge health, probe results, and extension connection state in a running session
