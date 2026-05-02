# Live Toolsmithing

> Write tools while the AI is using them.

Most agent runtimes lock you into the tools they ship. Patchwork doesn't.
When Claude needs a capability that doesn't exist yet — *query my SQLite
library catalog*, *post to my Stream Deck*, *parse this proprietary log
format* — you can write a plugin in the same session, save it, and the
running bridge picks it up without restart.

This document is the narrative tour. For the manifest schema and full
plugin authoring reference, see [plugin-authoring.md](plugin-authoring.md).

---

## The loop

```
1. Claude needs a tool that doesn't exist
2. Claude writes the plugin               (a few minutes)
3. The bridge hot-reloads it              (--plugin-watch)
4. The same session uses the new tool     (no restart, no reconnect)
```

Three concrete capabilities make this loop work:

- **Plugin manifests are JSON, not code-first config.** A new plugin is
  three files on disk: a `claude-ide-bridge-plugin.json` manifest, an
  `index.mjs` entrypoint exporting `register(ctx)`, and a `package.json`.
  See [plugin-authoring.md](plugin-authoring.md) for the canonical
  schema.
- **Tools register at runtime, not compile time.** `register(ctx)` is
  called when the bridge loads the plugin and gets a context object with
  `workspace`, `workspaceFolders`, `config`, and `logger`. Each tool is
  a `{ name, description, inputSchema, handler }` object pushed onto
  `ctx.registerTool(...)`. No type generation, no rebuild.
- **The bridge watches plugin paths.** Pass `--plugin-watch` at startup
  and any change under a registered plugin directory triggers an atomic
  re-register: tools defined by the old version are unregistered, the
  new version's tools take their place, in-flight calls drain naturally.

If you've ever wanted to teach an AI a new trick mid-conversation — not
mid-week — this is the loop.

---

## End-to-end example: query a SQLite library catalog

Suppose you keep a personal book/article catalog in
`~/library.sqlite3` with tables like `books(id, title, author, read)`.
You want Claude to answer questions like *"what unread Stoic philosophy
do I have?"* without you ever leaving chat.

A canonical worked example lives in
[examples/plugins/sqlite-library/](../examples/plugins/sqlite-library/)
in this repo. The walkthrough below mirrors that example.

### Step 1 — start the bridge with hot reload

```bash
patchwork start-all --plugin examples/plugins/sqlite-library --plugin-watch
```

Or for an existing session, restart with the same flags. The bridge
prints:

```
[plugins] loaded sqlite-library (1 tool: lib.query)
[plugins] watching examples/plugins/sqlite-library for changes
```

### Step 2 — Claude asks for the tool

In any IDE chat:

> *"I want to ask questions about my SQLite library at ~/library.sqlite3.
> Please write a Patchwork plugin that exposes a `lib.query` tool taking
> a SQL string and returning rows."*

Claude uses Read/Write/Bash to scaffold the plugin against the manifest
schema in [plugin-authoring.md](plugin-authoring.md). The plugin in
[examples/plugins/sqlite-library/](../examples/plugins/sqlite-library/)
is what a competent first pass looks like.

### Step 3 — save and watch the bridge reload

The moment Claude's `Write` finishes, the bridge logs:

```
[plugins] sqlite-library changed — re-registering 1 tool
[plugins] re-register complete (1 tool: lib.query)
```

No restart. No reconnect. Tools list refresh is automatic on the next
Claude tool-list query, which most clients do every turn.

### Step 4 — use the tool same session

> *"Now: what unread Stoic philosophy do I have?"*

Claude calls `lib.query` with
`SELECT title, author FROM books WHERE read = 0 AND tags LIKE '%stoic%'`,
gets back rows, summarizes them.

Total elapsed time, first ask to first answer: ~5 minutes the first
time, ~30 seconds for any subsequent variant tool.

---

## Why this is unusual

Most MCP servers ship a fixed tool catalog. To extend them you fork the
server, recompile, restart, reconnect. Patchwork inverts this:

| Concern | Typical MCP server | Patchwork |
|---|---|---|
| Add a tool | Fork + recompile + restart | Drop a directory in, hot-reload |
| Tool definition | TypeScript class compiled at build | JSON manifest + ESM entrypoint at runtime |
| Distribution | Build artifact per server | npm package with `claude-ide-bridge-plugin` keyword |
| Discovery | Read the source | `claude-ide-bridge gen-plugin-stub` scaffolds a working starter |
| AI involvement | None — you write the plugin | Claude writes it for you, in-session |

The key claim is the *loop*, not any one step. Plugin systems exist
elsewhere; the *write while running* loop is what makes Patchwork's
plugin model worth the name "Live Toolsmithing."

---

## Constraints worth knowing before you scaffold

- **Tool names must start with the manifest's `toolNamePrefix`** (2–20
  chars, `^[a-zA-Z][a-zA-Z0-9_]{1,19}$`). This prevents two plugins from
  shadowing core tools or each other.
- **No symlinks inside the plugin directory.** The bridge copies plugin
  files standalone, not via symlink. After modifying a plugin source
  template, re-run `gen-plugin-stub` or copy files manually.
- **Plugin files are JS/MJS at runtime.** TypeScript plugins must be
  pre-compiled before the bridge can load them — there's no embedded
  TS compiler.
- **`register(ctx)` runs once per load.** Side effects in the
  registration body fire on every hot reload. Keep them idempotent or
  guard with `ctx.config` flags.
- **Errors during registration unregister the plugin atomically.** A
  syntax error in the new version doesn't leave the old version's tools
  half-replaced — the bridge keeps the previous good registration until
  the next valid load.

---

## Distribute it

Once the tool stops being personal-only, publish to npm. The
[plugin-authoring.md](plugin-authoring.md#distribution) guide covers
the full distribution flow. Short version:

1. Add `claude-ide-bridge-plugin` to `package.json` keywords.
2. `npm publish`.
3. Other users install with
   `claude-ide-bridge --plugin <package-name>` — npm package paths and
   local directory paths share the same `--plugin` flag.

---

## Scaffold a starter

```bash
claude-ide-bridge gen-plugin-stub ./my-plugin --name "wesh/library" --prefix "lib"
```

Drops a working manifest, `index.mjs` skeleton, and `package.json`
into `./my-plugin`. Edit, save, watch the bridge reload.

For deeper details — manifest schema, context API, lifecycle hooks,
distribution conventions — see [plugin-authoring.md](plugin-authoring.md).
