# Plugin Examples

Live Toolsmithing starters and worked examples for Patchwork OS plugins.

| Directory | What it shows | Build step? |
|-----------|--------------|-------------|
| [`hello-world/`](hello-world/) | Minimal JS starter — one tool, no deps | No |
| [`hello-world-ts/`](hello-world-ts/) | Same plugin with TypeScript + types | Yes (`npm run build`) |
| [`sqlite-library/`](sqlite-library/) | Worked example — query a local SQLite DB | No |

## Quick start

```bash
# JS starter — edit and save to hot-reload
claude-ide-bridge --full \
  --plugin ./examples/plugins/hello-world \
  --plugin-watch

# TypeScript starter — run tsc --watch alongside the bridge
claude-ide-bridge --full \
  --plugin ./examples/plugins/hello-world-ts \
  --plugin-watch
```

## Learn more

- [Live Toolsmithing narrative](../../documents/live-toolsmithing.md) — the full loop explained
- [Plugin authoring reference](../../documents/plugin-authoring.md) — manifest schema, context API, distribution
