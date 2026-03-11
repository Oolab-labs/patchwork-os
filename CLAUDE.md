# Claude IDE Bridge — Project Instructions

## Documentation

Read and comply with all documents in `/documents/`. Consult the relevant doc before making changes:

- **[documents/platform-docs.md](documents/platform-docs.md)** — Complete feature reference (100+ tools). Consult before adding or modifying features.
- **[documents/ICPs.md](documents/ICPs.md)** — Developer personas. Consider impact on all personas when making changes.
- **[documents/styleguide.md](documents/styleguide.md)** — Code conventions, UI patterns, output formats. Follow all patterns for new tools, handlers, and responses.
- **[documents/roadmap.md](documents/roadmap.md)** — Development direction. Check before starting exploratory work.
- **[documents/data-reference.md](documents/data-reference.md)** — Data flows, state management, protocol details. Consult before modifying connection, auth, or state logic.

## Bug Fix Protocol

When a bug is reported, do NOT start by trying to fix it. Instead:
1. Write a test that reproduces the bug (the test should fail)
2. Have subagents try to fix the bug and prove it with a passing test
3. Only then consider the bug fixed

## Build & Test

```bash
# Bridge
npm run build          # TypeScript compilation
npm test               # vitest

# Extension
cd vscode-extension
npm run build          # esbuild bundle
npm run package        # create .vsix

# Always rebuild bridge + extension + VSIX before testing changes
```

Run `npx biome check .` before committing.

## Architecture Rules

- **Tools**: factory pattern `createXxxTool(deps)` returning `{ schema, handler }`. Register in `src/tools/index.ts`.
- **Extension handlers**: standalone async functions in the `handlers` map. Register in `vscode-extension/src/handlers/index.ts`.
- **WebSocket safety**: all `ws.send()` calls must use `safeSend()` or readyState check + try-catch.
- **Extension dependency**: tools requiring the extension must set `extensionRequired: true` in their schema.
- **Tool names**: must match `/^[a-zA-Z0-9_]+$/`.
- **Error handling**: tool execution errors return `isError: true` in content (NOT JSON-RPC errors). JSON-RPC errors are for protocol issues only.

## Testing Requirements

- New tools need unit tests in `src/tools/__tests__/`
- New extension handlers need tests in `vscode-extension/src/__tests__/handlers/`
- Use vitest for both bridge and extension tests
- Test circuit breaker and reconnect behavior for connection-related changes
