# Plugin Authoring Guide

Claude IDE Bridge supports third-party plugins that register additional MCP tools without forking the bridge. Plugins run in-process alongside the built-in tools.

---

## Quick Start

```bash
# Scaffold a new plugin (JavaScript)
claude-ide-bridge gen-plugin-stub ./my-plugin \
  --name "my-org/my-plugin" \
  --prefix "myPlugin"

# Or scaffold the TypeScript variant — adds tsconfig.json + build/dev scripts
claude-ide-bridge gen-plugin-stub ./my-plugin \
  --name "my-org/my-plugin" \
  --prefix "myPlugin" \
  --ts

# Run the bridge with your plugin loaded
claude-ide-bridge --plugin ./my-plugin --full
```

The JS stub creates: `claude-ide-bridge-plugin.json`, `index.mjs`, `package.json`, `README.md`, `.gitignore`.

The TS stub adds: `src/index.ts`, `tsconfig.json`, plus `build` / `dev` / `clean` npm scripts. The compiled artifact lands at `index.mjs` (same path the manifest points at), so hot-reload semantics don't change. Run `npm run dev` in one terminal, `claude-ide-bridge --plugin . --plugin-watch` in another — `tsc --watch` rebuilds, the bridge reloads, your tool is callable on the next turn.

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
| `permissions` | string[]? | Capability tokens. Each must appear in `KNOWN_PLUGIN_CAPABILITIES` ([src/pluginLoader.ts](../src/pluginLoader.ts)); manifests with unknown tokens are rejected at load time. The allowlist starts empty and grows deliberately as bridge enforcement for each capability lands. Until then, omit the field. |

---

## Entrypoint

Your entrypoint module must export a `register` function — either named or default export. It receives a `PluginContext` and must RETURN a `PluginRegistration` object (`{ tools: [...] }`) — this is the only supported shape; there is no imperative alternative.

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
  return {
    tools: [
      {
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
      },
    ],
  };
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

1. Add `"claude-ide-bridge-plugin"` to your `package.json` `keywords` — this makes it discoverable via `npm search keywords:claude-ide-bridge-plugin`.
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

### Discovery

Plugins are discovered via npm's keyword index. Authors add `"claude-ide-bridge-plugin"` to their package's `keywords` field; users find them with:

```bash
npm search keywords:claude-ide-bridge-plugin
```

> **Note:** The earlier `claude-ide-bridge marketplace list/search/install` subcommand was removed (issue #279). For non-plugin community content (recipe bundles), use `patchwork recipe install github:<org>/<repo>`.

## Bundled companion plugin (`claude-ide-bridge-plugin/`)

The repo ships a reference plugin at `claude-ide-bridge-plugin/` that demonstrates the Claude Code **agent / skill / hook** surfaces in addition to MCP tools. These are separate from the MCP-tool surface this doc focuses on — they target the Claude Code session itself, not the bridge's tool registry — but a plugin can register any combination of the four.

### Agents (`claude-ide-bridge-plugin/agents/*.md`)

Markdown files Claude Code surfaces as named sub-agents in the user's session. The bundled plugin ships four, each tuned for a specific IDE-workflow lane:

| File | Surface |
|---|---|
| `ide-architect.md` | High-level codebase exploration: call hierarchies, type relationships, dependency graphs. |
| `ide-code-reviewer.md` | Code review with inline diagnostics, blast-radius reasoning, refactor-safety analysis. |
| `ide-debugger.md` | Breakpoint setup, expression evaluation, debug-state inspection. |
| `ide-test-runner.md` | Test discovery, failure triage, coverage analysis. |

An agent file is a plain markdown prompt; Claude Code reads it lazily when the user invokes the agent by name.

### Skills (`claude-ide-bridge-plugin/skills/*/`)

Per-directory skills that bundle a `SKILL.md` + supporting assets. Claude Code makes these available to any session that loads the plugin. The bundled plugin ships twelve:

| Skill | What it does |
|---|---|
| `ide-api-deprecation-tracker` | Surface `@deprecated` usages across the workspace. |
| `ide-coverage` | Render an HTML coverage heatmap from lcov / JSON coverage data. |
| `ide-dead-code-hunter` | Find unused exports, unreferenced functions. |
| `ide-debug` | Guided XDebugger / debugpy session setup. |
| `ide-deps` | Build a force-directed dependency graph for a symbol. |
| `ide-diagnostics-board` | Workspace-wide diagnostics dashboard (HTML). |
| `ide-explore` | LSP-driven codebase tour for unfamiliar repos. |
| `ide-monitor` | Long-running diagnostics watcher, surfaces regressions. |
| `ide-quality` | Lint / format / fix-all-issues sweep on changed files. |
| `ide-refactor` | Safe-refactor protocol: analyze → preview → execute. |
| `ide-review` | Composite PR review (diff + diagnostics + churn + risk). |
| `ide-type-mismatch-fix` | Targeted fix for TS / type-error categories. |

### Hooks (`claude-ide-bridge-plugin/hooks/hooks.json`)

JSON map of Claude Code hook events → shell commands. The bundled plugin wires `PreToolUse` / `PostToolUse` to the bridge's automation hooks so that tool calls Claude Code makes from the agent surface flow through the same approval queue as recipe tool calls, and `decisionTraceLog` captures every Claude-side call alongside recipe-side calls.

### Authoring your own

The four surfaces are independent — a plugin that only wants to ship MCP tools (the focus of the rest of this doc) does **not** need to ship agents, skills, or hooks. Conversely, a plugin can ship one or more of these without registering any MCP tool. The `claude-ide-bridge-plugin/` directory in the repo is the canonical example combining all four.
