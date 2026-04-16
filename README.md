# Patchwork OS

**One agent. Any model. Works while you're away.**

Patchwork OS is an open-source, proactive personal AI operating system built on
top of the [Claude IDE Bridge](./README.bridge.md). It stitches tools, models,
workflows, and automation hooks into a "set it and forget it" AI teammate —
for coding **and** everyday tasks.

> Status: **Phase 0 — Foundation** (alpha, not yet published)

## Why

Existing AI assistants answer questions. Patchwork OS *does things* while
you're at your kid's soccer game or asleep:

- **Multi-model from day one** — Claude, OpenAI, Gemini, Grok, local LLMs (Ollama)
- **Drag-and-drop recipes** — YAML automation anyone can write
- **Oversight dashboard** — approve/reject high-risk actions from phone
- **Proven core** — 2,725+ tests, real-time IDE context, 170 built-in tools
- **100% MIT**

## Quick start (alpha)

```bash
npm install && npm run build
node dist/index.js --model claude --full
```

Config lives at `~/.patchwork/config.json`. See [`config.schema.json`](./config.schema.json).

## Roadmap

| Phase | Name | Status |
|---|---|---|
| 0 | Foundation — rename, config, ModelAdapter | **in progress** |
| 1 | Multi-model + Dashboard MVP | planned |
| 2 | Recipe System + non-code workflows | planned |
| 3 | Security + headless / mobile | planned |
| 4 | Community + ecosystem | planned |
| 5 | Optional hosted tier | year 2 |

Full plan: `../Patchwork_OS_Plan_and_Roadmap.docx`.

## Architecture

Patchwork OS **extends** the Claude IDE Bridge, it does not replace it. The
bridge's MCP server, automation hooks, orchestrator, plugin system, and tool
library are the substrate. Patchwork adds:

1. `src/adapters/` — `ModelAdapter` interface + per-provider implementations
2. `src/recipes/` — YAML recipe parser → existing automation DSL *(planned)*
3. `dashboard/` — Next.js oversight UI *(planned)*

For the underlying bridge docs see [README.bridge.md](./README.bridge.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT © Oolab Labs.
