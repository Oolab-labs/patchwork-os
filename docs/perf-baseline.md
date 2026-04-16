# Performance Baseline — v2.42.0

Snapshot of round-trip latency for representative tool calls. Re-run with
`node scripts/benchmark.mjs <port> --iterations N [--json]` against a running
bridge. Results are point-in-time and loopback-only.

## Methodology

- Bridge: `claude-ide-bridge@2.42.0` (post FP-layer migration + post-proxy
  elimination + post shape-mismatch CI gate + new launchQuickTask + CLI)
- Transport: WebSocket on 127.0.0.1, no TLS, no proxy
- Iterations: 500 per tool
- Host: macOS (Darwin 25.3.0 arm64, Apple M4 Max), Node v24.4.1
- Extension: not connected (probe-path tools exercised; extension-gated tools
  short-circuit and return `extension_required` faster than wire-RTT)
- Captured: 2026-04-16 via `scripts/benchmark.mjs 55000 --iterations 500 --json`

## Results (ms)

| Tool                    | p50 | p95 | p99 | max | min |
|-------------------------|-----|-----|-----|-----|-----|
| tools/list              | 0   | 1   | 1   | 1   | 0   |
| getFileTree             | 0   | 1   | 1   | 1   | 0   |
| getWorkspaceFiles       | 0   | 1   | 1   | 1   | 0   |
| searchWorkspace ×20     | 0   | 1   | 1   | 1   | 0   |
| searchWorkspace ×200    | 0   | 1   | 1   | 1   | 0   |
| getDiagnostics          | 0   | 1   | 1   | 1   | 0   |
| getBufferContent        | 0   | 1   | 1   | 1   | 0   |
| getBufferContent (range)| 0   | 1   | 1   | 1   | 0   |

## Interpretation

- **Sub-millisecond p99 across every probed tool.** Loopback + a tight event
  loop puts RTT floor below the 1ms resolution the benchmark uses.
- **No regression from the FP migration.** Red-Book `AutomationProgram`
  interpreter landed in v2.39.0; proxy elimination landed in v2.38.0; the
  launchQuickTask + shared preset module landed in v2.42.0. None of it
  introduces extra work on the hot path — tool dispatch still goes through
  the same `McpTransport.handleRpc → tools.get(name).handler(args)` path.
- **Caveat:** These numbers do not reflect LSP latency, subprocess spawn,
  disk I/O, or real-network transport. Tools that proxy to the VS Code
  extension (findReferences, goToDefinition, renameSymbol, etc.) are bound
  by the extension's LSP round-trip, not bridge RTT. See
  `getPerformanceReport` for live p50/p95/p99 on tools with real workload.

## Next baseline

Re-run at the next minor version bump (v2.43.x) or after any change to
`transport.ts`, `server.ts`, or dispatch hot-path code. Numbers should not
regress above **p99 ≤ 2ms** on M-series hardware for the probed tools.
Flag any regression in the commit message.

## CI gate (not enabled)

The benchmark supports `--threshold <ms>` to fail when any tool's p99
exceeds the bound. Not wired into CI — loopback timing is too noisy on
GitHub Actions to be useful as a gate. Use locally for pre-release checks.
