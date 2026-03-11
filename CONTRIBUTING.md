# Contributing to Claude IDE Bridge

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/Oolab-labs/claude-ide-bridge.git
cd claude-ide-bridge

# Install dependencies and build
npm install
npm run build

# Run tests
npm test

# Extension
cd vscode-extension
npm install
npm run build
npm test
```

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting. Run before committing:

```bash
npx biome check .
```

## Adding a New Tool

Tools follow the factory pattern. Create a file in `src/tools/`:

```typescript
export function createMyTool(deps: ToolDeps) {
  return {
    schema: {
      name: "myTool",
      description: "What the tool does",
      inputSchema: { /* JSON Schema */ },
      // Set extensionRequired: true if it needs the VS Code extension
    },
    handler: async (args: Record<string, unknown>) => {
      // Implementation
      return { content: [{ type: "text", text: "result" }] };
    },
  };
}
```

Register it in `src/tools/index.ts`.

If the tool requires the VS Code extension, add a handler in `vscode-extension/src/handlers/`.

## Testing

- Bridge tests: `src/__tests__/` (vitest)
- Extension tests: `vscode-extension/src/__tests__/` (vitest)
- New tools need unit tests in `src/tools/__tests__/`
- New handlers need tests in `vscode-extension/src/__tests__/handlers/`

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Ensure tests pass (`npm test`)
4. Ensure linting passes (`npx biome check .`)
5. Submit a PR with a clear description of the change

## Reporting Issues

Use [GitHub Issues](https://github.com/Oolab-labs/claude-ide-bridge/issues). Include:
- Bridge version and Node.js version
- Editor name and version
- Steps to reproduce
- Expected vs actual behavior
