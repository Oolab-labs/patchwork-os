# Shadow Run Harness

## Overview

The shadow-run harness replays historical bridge run records through a candidate tool classifier and reports which runs would have been reclassified. Its purpose is to surface regressions — or newly-flagged destructive calls — before a safety-flag PR ships, without running those tools again for real. The classifier runs in-process; all I/O is injected, making the harness fully unit-testable without `vi.mock()` hoisting.

## Quickstart

```bash
# Scan last 7 days of runs (default)
patchwork shadow-scan

# Scan last 30 days, JSON output
patchwork shadow-scan --since 30d --json

# Scan against a specific runs file, since an ISO date
patchwork shadow-scan --runs-file /path/to/runs.jsonl --since 2024-01-01T00:00:00Z

# Cap at 500 runs
patchwork shadow-scan --limit 500
```

## CLI flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--since` | `<duration\|ISO>` | `7d` | Filter to runs at or after this point. Accepts relative (`24h`, `7d`) or ISO 8601. |
| `--limit` | `<n>` | none | Max runs to process after the `--since` filter. |
| `--runs-file` | `<path>` | `~/.claude/ide/runs.jsonl` | Override the runs source. Workspace-scoped; validated via `resolveFilePath`. |
| `--json` | flag | false | Emit JSON (`ShadowScanResult`) instead of human-readable text. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No runs reclassified — safe to merge. |
| `1` | One or more runs reclassified — review required. Use in CI to gate PRs. |

## Architecture

### Core (`src/testing/shadowRun.ts`)

- **`runShadowScan(opts: ShadowScanOptions): Promise<ShadowScanResult>`** — pure function; no top-level I/O. All data access via injected `loadPastRuns`.
- **`ShadowScanOptions.classifier`** — swap in any `(run: RunRecord) => ClassificationResult` fn; `destructiveToolClassifier` is the default.
- **`destructiveToolClassifier`** — reference impl; flags `deleteFile`, `runInTerminal`, `searchAndReplace` as `"review"` tier.
- **`loadPastRuns` contract** — must respect `RecipeRunLog` rotation thresholds: 1 MB max bytes, 10 000 max lines. The harness applies no additional cap — that responsibility belongs to the loader.

### CLI wrapper (`src/commands/shadowScan.ts`)

- **`runShadowScanCli(options)`** — wires `buildLoadPastRuns` (enforces 1 MB file-size guard before read) → `runShadowScan` → stdout.
- **`parseSinceDuration(str)`** — exported; parses `"24h"` / `"7d"` relative forms or falls back to `new Date(str)` (ISO 8601).
- **`parseRunsFile(content)`** — exported; JSONL parser; skips malformed lines with stderr warning (does not throw).
- Default runs path (`~/.claude/ide/runs.jsonl`) is outside any workspace — intentionally **not** validated through `resolveFilePath`. An explicit `--runs-file` is workspace-scoped and is validated.

### Key types

```ts
interface RunRecord {
  id: string;
  recipeName: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  timestamp: string; // ISO 8601
}

interface ClassificationResult {
  runId: string;
  recipeName: string;
  toolName: string;
  previousTier: "safe" | "review" | "block";
  newTier: "safe" | "review" | "block";
  reclassified: boolean;
  reason?: string;
}

interface ShadowScanResult {
  scanned: number;
  reclassified: number;
  classifications: ClassificationResult[];
  summary: string; // human-readable one-liner
}
```

## Reviewer gate

Every PR that touches env-allowlist, destructive-tier definitions, or `agent.tools.allow-deny` config must paste the SUMMARY block from `patchwork shadow-scan --since 30d` into the PR description. The `.github/workflows/reviewer-gate.yml` workflow enforces this via a path-filter auto-comment on matching PRs.

## Extending with custom classifiers

```ts
import {
  runShadowScan,
  type RunRecord,
  type ClassificationResult,
} from './src/testing/shadowRun.js';

const myClassifier = (run: RunRecord): ClassificationResult => {
  const isRisky = run.args['target'] === '/etc';
  return {
    runId: run.id,
    recipeName: run.recipeName,
    toolName: run.toolName,
    previousTier: 'safe',
    newTier: isRisky ? 'block' : 'safe',
    reclassified: isRisky,
    reason: isRisky ? 'targets /etc' : undefined,
  };
};

const result = await runShadowScan({ loadPastRuns: myLoader, classifier: myClassifier });
console.log(result.summary);
```

## Honest limits

- **Classification only** — no env-allowlist scan until subprocess env is captured in `RunStepResult`. Current runs lack env context.
- **Bridge-mediated calls only** — `~/.claude/ide/runs.jsonl` records tool calls that passed through the bridge; direct subprocess / shell invocations are not captured.
- **1 MB file guard** — runs files larger than 1 MB are skipped entirely (stderr warning emitted). Rotate logs before scanning long-lived installations.
