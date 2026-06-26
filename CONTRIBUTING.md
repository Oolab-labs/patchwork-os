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

## AI-agent contributions

Autonomous AI-agent PRs are welcome — they've produced genuinely useful work
(e.g. the #850 cross-layer parity ratchets). To keep the cost/benefit positive
for everyone, agent-authored PRs have a few extra rules:

1. **Link an issue.** Every agent PR must reference an open issue or a
   maintainer comment that scoped the work. No speculative drive-by changes.
2. **No production code without prior maintainer sign-off.** Default-allowed:
   tests, docs, and parity/invariant ratchets under `src/__tests__/`. Anything
   touching `src/`, `dashboard/src/`, recipes, or config needs a maintainer to
   green-light the scope on the issue *first*.
3. **Disclose the agent.** Note in the PR body that it's agent-authored
   (most already do).
4. **One logical change per PR.** Same small-PR rule as everyone else.

Maintainers review every agent diff in full — there is no auto-merge or
fast-track based on a clean track record, regardless of how reliable a given
account has been.

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
| Starter recipes | `templates/recipes/*.yaml`, `examples/recipes/` | Yes |
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
