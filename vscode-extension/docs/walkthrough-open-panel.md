## The Analytics Panel

The Analytics panel surfaces what the bridge is doing in real time. Open it from the Claude icon in the activity bar (left sidebar) or with the **Claude IDE Bridge: Open Panel** command.

### What it shows

- **Connection health** — bridge status, extension protocol version, current session ID
- **Tool calls** — the last N MCP tool invocations Claude has made, with timing and outcome
- **Active tasks** — any in-flight Claude subprocess tasks queued via `runClaudeTask`
- **Recent decisions** — approvals, recipe runs, and ctx-trace saves from the last 12 hours

### When to look at it

- After a slow turn — was Claude bottlenecked on a tool call or waiting on an extension response?
- During a recipe run — every step's tool calls are visible
- Before reporting an issue — the connection-health row tells maintainers what to investigate first

### Keyboard shortcut

The panel doesn't bind a shortcut by default. Add one via **Keyboard Shortcuts** → search for `Open Panel`.
