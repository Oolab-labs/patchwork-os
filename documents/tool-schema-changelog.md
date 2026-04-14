# Tool Schema Changelog

Append-only log of **breaking** tool schema changes. Required before updating the baseline snapshot when CI flags a breaking change.

Format:
```
## vX.Y.Z — YYYY-MM-DD
- `toolName`: what changed and why, plus migration path for callers
```

---

## v2.26.x baseline — 2026-04-14

Initial snapshot generated from v2.26.9 (133 tools, full mode).

Notable schema history before this baseline:
- `contextBundle`: `activeFileContent` field fixed (was never populated before v2.25.18)
- `getGitStatus`: `available: true` added to success path outputSchema (v2.25.34)
- `getBufferContent`: `source` enum fixed to `["extension","disk"]` (v2.25.34)
- `clipboard` tools: 1MB cap enforced (v2.25.x)
- All tool descriptions compressed to ≤200 chars (v2.25.29–33)

---

<!-- Add new entries above this line -->
