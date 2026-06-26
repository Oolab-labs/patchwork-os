# Tool Schema Changelog

Append-only log of **breaking** tool schema changes. Required before updating the baseline snapshot when CI flags a breaking change.

Format:
```
## vX.Y.Z — YYYY-MM-DD
- `toolName`: what changed and why, plus migration path for callers
```

---

## v2.26.x baseline — 2026-04-14

Initial snapshot generated from v2.26.9 (137 tools, full mode).

Notable schema history before this baseline:
- `contextBundle`: `activeFileContent` field fixed (was never populated before v2.25.18)
- `getGitStatus`: `available: true` added to success path outputSchema (v2.25.34)
- `getBufferContent`: `source` enum fixed to `["extension","disk"]` (v2.25.34)
- `clipboard` tools: 1MB cap enforced (v2.25.x)
- All tool descriptions compressed to ≤200 chars (v2.25.29–33)

---

> ⚠️ **Baseline drift (known):** the committed `tool-schemas-snapshot.json` holds 137 tool
> entries, but the live registry now exposes 177 (`node scripts/audit-lsp-tools.mjs` Stats line).
> The snapshot has not been regenerated since the 2026-04-14 baseline, which weakens the CI
> schema-diff gate for the ~40 tools added since. Regenerate with
> `node scripts/audit-schema-changes.mjs --update` (requires a full `npm install && npm run build`)
> and append the corresponding entries here.

<!-- Add new entries above this line -->
