# Contributing to Patchwork OS

Thanks for helping build a proactive, multi-model AI teammate. See
`CLAUDE.md` for architectural rules inherited from the Claude IDE Bridge, and
[CONTRIBUTING.bridge.md](./CONTRIBUTING.bridge.md) for the underlying bridge
dev guide.

## Ground rules

1. **Extend, don't fork the bridge.** If a bug is in the bridge layer, fix it there.
2. **Tests mandatory.** New tools/adapters need vitest coverage. CI gates at
   75% lines / 70% branches / 75% functions.
3. **No secrets in commits.** Check `git diff` before staging.
4. **Small PRs** — one adapter, one dashboard page, or one recipe schema change per PR.

## Dev setup

```bash
npm install
npm run build
npm test
```

## Where to contribute

| Area | Files | Good first issue? |
|---|---|---|
| Model adapters | `src/adapters/*.ts` | Yes — OpenAI, local/Ollama |
| Starter recipes | `recipes/*.yaml` | Yes |
| MCP servers (non-code) | `packages/mcp-*/` | Yes — obsidian, csv, email |
| Dashboard components | `dashboard/src/components/` | Phase-1+ |
| Security hardening | `src/transport.ts`, risk tiers | Advanced |

## Adapter contract

All providers implement `src/adapters/base.ts:ModelAdapter`. Each adapter must:

- Pass the shared contract test suite (planned)
- Translate MCP `ToolDef` ↔ provider-native function-calling shape
- Surface streaming via `AsyncIterable<StreamChunk>`
- Never log API keys or raw prompts at info level

## Commit style

Conventional Commits: `feat(adapters): add OpenAI stream()`.

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
