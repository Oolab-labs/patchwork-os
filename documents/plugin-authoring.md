# Plugin Authoring Guide

Claude IDE Bridge supports third-party plugins that register additional MCP tools without forking the bridge. Plugins run in-process alongside the built-in tools.

---

## Quick Start

```bash
# Scaffold a new plugin
claude-ide-bridge gen-plugin-stub ./my-plugin \
  --name "my-org/my-plugin" \
  --prefix "myPlugin"

# Run the bridge with your plugin loaded
claude-ide-bridge --plugin ./my-plugin --full
```

The stub creates three files: `claude-ide-bridge-plugin.json`, `index.mjs`, and `package.json`.

---

## File Layout

```
my-plugin/
├── claude-ide-bridge-plugin.json   ← required manifest
├── index.mjs                       ← entrypoint (or whatever you set in manifest)
└── package.json                    ← needed for npm publishing
```

---

## Manifest (`claude-ide-bridge-plugin.json`)

All fields unless marked optional are required.

```json
{
  "schemaVersion": 1,
  "name": "my-org/my-plugin",
  "version": "1.0.0",
  "description": "Fetch internal Jira tickets",
  "entrypoint": "./index.mjs",
  "toolNamePrefix": "myOrg",
  "minBridgeVersion": "2.1.24"
}
```

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `1` | Must be `1`. Future versions will be additive. |
| `name` | string | Identifier shown in bridge logs (e.g. `"my-org/my-plugin"`). |
| `version` | string? | Your plugin's semver version. Shown in logs. |
| `description` | string? | One-line description. Shown at bridge startup. |
| `entrypoint` | string | Relative path to the JS module that exports `register`. |
| `toolNamePrefix` | string | **All tool names must start with this prefix.** 2–20 chars, must match `/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/`. Prevents collisions with built-in tools and other plugins. |
| `minBridgeVersion` | string? | Minimum bridge version (semver). Bridge logs a warning if older, but still loads. |
| `permissions` | string[]? | Informational only in v1 (e.g. `["network", "filesystem"]`). |

---

## Entrypoint

Your entrypoint module must export a `register` function — either named or default export. It receives a `PluginContext`.

### Option A: Return a `PluginRegistration` object

```js
// index.mjs
export function register(ctx) {
  ctx.logger.info("my-plugin loaded", { workspace: ctx.workspace });

  return {
    tools: [
      {
        schema: {
          name: "myOrgFetchTicket",
          description: "Fetch a Jira ticket by ID and return its summary and status",
          inputSchema: {
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "Jira ticket ID, e.g. PROJ-123" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        handler: async (args, signal) => {
          const res = await fetch(`https://jira.example.com/rest/api/2/issue/${args.id}`, {
            signal,
            headers: { Authorization: `Bearer ${process.env.JIRA_TOKEN}` },
          });
          if (!res.ok) {
            return { content: [{ type: "text", text: `Error: ${res.status}` }] };
          }
          const data = await res.json();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                id: args.id,
                summary: data.fields.summary,
                status: data.fields.status.name,
              }),
            }],
          };
        },
        timeoutMs: 10_000,
      },
    ],
  };
}
```

### Option B: Use `ctx.registerTool()` imperatively

```js
export function register(ctx) {
  ctx.registerTool({
    schema: {
      name: "myOrg_doSomething",
      description: "Does something useful",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input text" },
        },
        required: ["input"],
      },
    },
    handler: async (args) => {
      return { content: [{ type: "text", text: `Result: ${args.input}` }] };
    },
  });
}
```

Both styles are supported. Mixing them in the same `register` call is also fine — return value tools and `ctx.registerTool()` calls are merged.

### TypeScript

Install the bridge as a peer dev dependency and import types:

```ts
import type { PluginContext, PluginRegistration } from "claude-ide-bridge/plugin";

export function register(ctx: PluginContext): PluginRegistration {
  return { tools: [...] };
}
```

---

## PluginContext Reference

```ts
interface PluginContext {
  /** Absolute path to the active workspace root. */
  workspace: string;

  /** All open workspace folders (multi-root). */
  workspaceFolders: string[];

  /** Safe subset of bridge config — never includes auth token or sensitive fields. */
  config: Record<string, unknown>;

  /** Structured logger — output routed through bridge log stream. */
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
  };

  /** Register a tool imperatively (alternative to returning PluginRegistration). */
  registerTool(tool: { schema: PluginToolSchema; handler: ToolHandler }): void;
}
```

The `config` object is a safe subset of the bridge config. It intentionally never includes the auth token, automation policy path, or other security-sensitive fields.

---

## Tool Schema Reference

```ts
interface PluginToolSchema {
  /** Must start with toolNamePrefix and match /^[a-zA-Z0-9_]+$/ */
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Set true if tool requires VS Code extension to be connected. */
  extensionRequired?: boolean;
  /** Structured output schema — same pattern as built-in tools. */
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;     // tool doesn't modify state
    destructiveHint?: boolean;  // tool may delete or overwrite data
    idempotentHint?: boolean;   // repeating the call is safe
    openWorldHint?: boolean;    // tool accesses external services
  };
}

type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: Array<{ type: string; text: string }> }>;
```

The bridge validates that every tool name starts with `toolNamePrefix` and matches `/^[a-zA-Z0-9_]+$/`. A plugin is rejected entirely if any tool fails these checks.

---

## Complete Example: `myOrg_listTodos`

A plugin that greps for TODO comments across workspace files.

```js
// index.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function register(ctx) {
  ctx.registerTool({
    schema: {
      name: "myOrg_listTodos",
      description: "Find all TODO/FIXME comments in the workspace",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex to match (default: TODO|FIXME)",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results (default: 50)",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    handler: async (args) => {
      const pattern = (args.pattern ?? "TODO|FIXME");
      const max = args.maxResults ?? 50;

      let output;
      try {
        const result = await execFileAsync(
          "grep",
          ["-rn", "--include=*.ts", "--include=*.js", "-E", pattern, ctx.workspace],
          { maxBuffer: 1024 * 1024 },
        );
        output = result.stdout;
      } catch (err) {
        // grep exits 1 when no matches — not a real error
        output = err.stdout ?? "";
      }

      const lines = output.trim().split("\n").filter(Boolean).slice(0, max);

      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No TODOs found." }] };
      }

      const text = lines.join("\n");
      return { content: [{ type: "text", text }] };
    },
  });
}
```

---

## Loading Plugins

### CLI flag

```bash
# Local path (absolute or relative)
claude-ide-bridge --plugin /absolute/path/to/my-plugin --full
claude-ide-bridge --plugin ./relative/path/to/my-plugin --full

# Installed npm package (resolved via require.resolve)
claude-ide-bridge --plugin my-npm-package-name --full

# Multiple plugins
claude-ide-bridge --plugin ./plugin-a --plugin ./plugin-b --full

# Hot reload (watches plugin directory for changes)
claude-ide-bridge --plugin ./my-plugin --plugin-watch --full
```

### Config file

```json
{
  "plugins": [
    "/path/to/plugin-a",
    "/path/to/plugin-b",
    "some-npm-package"
  ]
}
```

---

## Lifecycle

1. Bridge starts up and runs CLI probes (ctags, typescript-language-server, etc.)
2. Plugins are loaded in order — after probes, before sessions are accepted
3. Each plugin's `register()` function is called; tools are registered atomically
4. Sessions begin accepting connections with all tools (built-in + plugin) available

### Hot reload (`--plugin-watch`)

When `--plugin-watch` is active, the bridge watches plugin directories for file changes. On change:

- 300ms debounce prevents rapid re-loads during saves
- Tools are re-registered atomically — sessions see the new tool list immediately
- ESM module cache is busted via `?t=<timestamp>` on dynamic `import()`
- An in-flight reload blocks subsequent reload until complete (`reloadInFlight` set)

### Errors are isolated

A plugin that throws during import or in `register()` is skipped with a logged error. Other plugins still load. The bridge continues normally.

---

## Rules and Limits

- **All tool names must start with `toolNamePrefix`.** Enforced at load time; plugin rejected if any tool violates this.
- **Tool names must match `/^[a-zA-Z0-9_]+$/`.** No hyphens, spaces, or special characters.
- **Max 100 tools per plugin.** Plugins registering more are rejected.
- **No two plugins may register the same tool name.** The second plugin to register a colliding name is rejected; the first loads fine.
- **Same path deduplication.** Listing the same resolved path twice loads it once with a warning.
- **`minBridgeVersion` is advisory.** A mismatch logs a warning but doesn't block loading.

---

## Important: No Symlinks / No Auto-sync

Files in a `claude-ide-bridge-plugin/` directory are **standalone copies**, not symlinks. After modifying plugin source, you must manually copy updated files — they will **not** auto-update.

If you scaffold a plugin stub and then modify the source template, re-run `gen-plugin-stub` or copy files manually.

---

## Security Model

- Plugins run **in-process** with the same Node.js privileges as the bridge. Do not load untrusted plugins.
- The bridge **never passes** `authToken`, `claudeBinary`, `automationPolicyPath`, or other sensitive fields to plugin code via `ctx.config`.
- Plugin handlers receive an `AbortSignal` — honour it to avoid resource leaks on cancellation.
- Sensitive config (API keys, tokens) should be read from environment variables, not hard-coded in the plugin.

---

## Distributing Your Plugin

### npm publishing

1. Add `"claude-ide-bridge-plugin"` to your `package.json` `keywords` — this makes it discoverable via `marketplace search`.
2. Set `"peerDependencies": { "claude-ide-bridge": ">=2.1.24" }`.
3. Make sure your entrypoint is an **ES module** (`.mjs` or `"type": "module"` in `package.json`) — the bridge uses dynamic `import()` to load plugins.
4. Ship the `claude-ide-bridge-plugin.json` manifest at the package root.

### Example `package.json`

```json
{
  "name": "my-org-bridge-plugin",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["claude-ide-bridge-plugin"],
  "main": "./index.mjs",
  "peerDependencies": {
    "claude-ide-bridge": ">=2.1.24"
  }
}
```

### Installing a published plugin

```bash
npm install -g my-org-bridge-plugin
claude-ide-bridge --plugin my-org-bridge-plugin --full
```

### Marketplace discovery

```bash
# Search the bridge marketplace for plugins
claude-ide-bridge marketplace search <query>

# List all available companions/plugins
claude-ide-bridge marketplace list
```

The marketplace fetches a registry from GitHub with a bundled fallback for offline use.
