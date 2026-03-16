# Plugin Authoring Guide

Claude IDE Bridge supports third-party plugins that register additional MCP tools without forking the bridge. Plugins run in-process alongside the built-in tools.

---

## Quick Start

```bash
# Scaffold a new plugin in one command
npx claude-ide-bridge gen-plugin-stub ./my-plugin \
  --name "my-org/my-plugin" \
  --prefix "myPlugin"

# Run the bridge with your plugin loaded
claude-ide-bridge --plugin ./my-plugin
```

The stub creates three files: `claude-ide-bridge-plugin.json`, `index.mjs`, and `package.json`.

---

## File Layout

```
my-plugin/
├── claude-ide-bridge-plugin.json   ← required manifest
├── index.mjs                       ← entrypoint (or whatever you set in manifest)
└── package.json                    ← optional, needed for npm publishing
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
| `minBridgeVersion` | string? | Minimum bridge version (semver). Bridge logs a warning if it's older, but still loads the plugin. |
| `permissions` | string[]? | Informational only in v1. Documented intent (e.g. `["network", "filesystem"]`). |

---

## Entrypoint

Your entrypoint module must export a `register` function — either as a named export or the default export. It receives a `PluginContext` and returns (or resolves to) a `PluginRegistration`.

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
              text: JSON.stringify({ id: args.id, summary: data.fields.summary, status: data.fields.status.name }),
            }],
          };
        },
        timeoutMs: 10_000,
      },
    ],
  };
}
```

### TypeScript

If you want full type safety, install the bridge as a peer dev dependency and import from `claude-ide-bridge/plugin`:

```ts
// src/index.ts
import type { PluginContext, PluginRegistration } from "claude-ide-bridge/plugin";

export function register(ctx: PluginContext): PluginRegistration {
  return { tools: [...] };
}
```

---

## PluginContext reference

```ts
interface PluginContext {
  workspace: string;           // absolute path to the active workspace
  workspaceFolders: string[];  // all workspace folders (multi-root)
  config: {
    workspace: string;
    workspaceFolders: string[];
    commandTimeout: number;    // ms — default tool execution timeout
    maxResultSize: number;     // KB — max response size
  };
  logger: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
  };
}
```

The `config` object is a **safe subset** of the bridge config. It intentionally never includes the auth token, automation policy path, or other security-sensitive fields.

---

## Tool schema reference

```ts
interface PluginToolSchema {
  name: string;                 // must start with toolNamePrefix, /^[a-zA-Z0-9_]+$/
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  extensionRequired?: boolean;  // hide tool when VS Code extension is disconnected
  annotations?: {
    readOnlyHint?: boolean;     // tool doesn't modify state
    destructiveHint?: boolean;  // tool may delete or overwrite data
    idempotentHint?: boolean;   // repeating the call is safe
    openWorldHint?: boolean;    // tool accesses external services
  };
}
```

The bridge validates that every tool name starts with `toolNamePrefix` and matches `/^[a-zA-Z0-9_]+$/`. A plugin is rejected entirely if any tool fails these checks.

---

## Loading plugins

### CLI flag
```bash
claude-ide-bridge --plugin /absolute/path/to/my-plugin
claude-ide-bridge --plugin ./relative/path/to/my-plugin
claude-ide-bridge --plugin my-npm-package-name      # resolved via require.resolve
```

Multiple `--plugin` flags are accepted and load in order.

### Config file (`~/.config/claude-ide-bridge/config.json` or `--config`)
```json
{
  "plugins": [
    "/path/to/plugin-a",
    "/path/to/plugin-b",
    "some-npm-package"
  ]
}
```

### npm packages
If you publish your plugin to npm, users install it globally and reference it by package name:
```bash
npm install -g my-org-bridge-plugin
claude-ide-bridge --plugin my-org-bridge-plugin
```

---

## Rules and limits

- **Max 100 tools per plugin.** Plugins registering more are rejected.
- **All tool names must start with `toolNamePrefix`.** Enforced at load time.
- **Tool names must match `/^[a-zA-Z0-9_]+$/`.** No hyphens, spaces, or special characters.
- **No two plugins may register the same tool name.** The second plugin to register a colliding name is rejected; the first loads fine.
- **Same path deduplication.** Listing the same resolved path twice loads it once with a warning.
- **Errors are isolated.** A plugin that throws during import or in `register()` is skipped; other plugins still load.
- **`minBridgeVersion` is advisory.** A mismatch logs a warning but doesn't block loading.

---

## Security model

- Plugins run **in-process** with the same Node.js privileges as the bridge. Do not load untrusted plugins.
- The bridge **never passes** `authToken`, `claudeBinary`, or `automationPolicyPath` to plugin code.
- Plugin handlers receive an `AbortSignal` — honour it to avoid resource leaks on cancellation.
- Sensitive config (API keys, tokens) should be read from environment variables, not hard-coded.

---

## Distributing your plugin

1. Add `"claude-ide-bridge-plugin"` to your `package.json` keywords so it's discoverable.
2. Set `"peerDependencies": { "claude-ide-bridge": ">=2.1.24" }`.
3. Make sure your entrypoint is an **ES module** (`.mjs` or `"type": "module"` in package.json) — the bridge uses dynamic `import()` to load plugins.
4. Ship the `claude-ide-bridge-plugin.json` manifest at the package root.
5. Users load it by package name: `claude-ide-bridge --plugin your-package-name`.
