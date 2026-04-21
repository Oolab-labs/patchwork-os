# Multi-Provider Driver Plan

**Goal:** Let a contributor add Gemini, OpenAI, or Grok support in a weekend without reading the full codebase.

---

## 1. Current Interface Shape

`src/claudeDriver.ts` defines three things a driver must implement:

```ts
// Line 118-129
export interface IClaudeDriver {
  readonly name: string;
  run(input: ClaudeTaskInput): Promise<ClaudeTaskOutput>;
  spawnForSession?(sessionId: string): Promise<void>;  // optional
  killForSession?(sessionId: string): void;            // optional
  runOutcome?(input: ClaudeTaskInput): Promise<ClaudeTaskOutcome>; // optional, wraps run()
}
```

`ClaudeTaskInput` (line 6-27) carries:
- `prompt`, `workspace`, `timeoutMs`, `signal`, `onChunk?`
- `contextFiles?`, `model?`, `effort?`, `fallbackModel?`, `maxBudgetUsd?`
- `startupTimeoutMs?`, `systemPrompt?`, `useAnt?`

`ClaudeTaskOutput` (line 33-45) is a flat struct: `text`, `exitCode`, `durationMs`, `stderrTail?`, `wasAborted?`, `startupTimedOut?`, `startupMs?`.

`ClaudeTaskOutcome` (line 51-71) is the preferred discriminated union (`done | error | aborted`). `toClaudeTaskOutcome()` converts from the flat struct.

The factory function (line 599-610):
```ts
createDriver(mode: "subprocess" | "api" | "none", binary, antBinary, log) → IClaudeDriver | null
```

Wired at `src/config.ts:27`: `claudeDriver: "subprocess" | "api" | "none"`.

---

## 2. What's Claude-Specific vs Provider-Neutral

### Claude-specific (in SubprocessDriver, lines 149-483)

| Concern | Detail |
|---|---|
| Binary path | `binary` / `antBinary` constructor args; `--model`, `--effort`, `--fallback-model`, `--max-budget-usd`, `--system-prompt` CLI flags |
| Auth isolation | strips `CLAUDECODE`, `CLAUDE_CODE_*`, `MCP_*` env vars (lines 262-273) |
| Hook suppression | writes temp settings JSON with `hooks: {}` to `--settings` (lines 163-215) |
| Stream parsing | `--output-format stream-json --verbose --include-partial-messages`; `StreamJsonEvent` type (line 133-147); JSONL line buffer; `result` event as canonical output |
| Session flags | `--strict-mcp-config`, `--no-session-persistence`, `--dangerously-skip-permissions` |
| `useAnt` | switches binary to `antBinary` (line 218) |

### Provider-neutral (already in interface)

- `prompt`, `workspace` (cwd), `timeoutMs`, `signal` (AbortSignal)
- `onChunk(chunk)` streaming callback
- `contextFiles` (informational list)
- `model`, `systemPrompt`
- Output: `text`, `durationMs`, `wasAborted`, `startupMs`

### Leaky fields (Claude-specific concepts surfacing in shared types)

- `ClaudeTaskInput.useAnt` — Claude/Ant binary toggle; meaningless to other providers
- `ClaudeTaskInput.effort` — Claude Code concept (`low/medium/high/max`); maps loosely to thinking budget
- `ClaudeTaskInput.fallbackModel` — Anthropic overload routing; provider-specific
- `ClaudeTaskInput.maxBudgetUsd` — Anthropic-specific spend cap
- `ClaudeTaskOutput.exitCode` — subprocess exit; API drivers don't have this

---

## 3. Proposed `ProviderDriver` Interface

```ts
// src/drivers/types.ts

export interface ProviderTaskInput {
  prompt: string;
  workspace: string;         // working directory / context hint
  timeoutMs: number;
  signal: AbortSignal;
  onChunk?: (chunk: string) => void;
  contextFiles?: string[];   // passed as context hints; driver decides how to use
  model?: string;            // provider-specific model ID
  systemPrompt?: string;
  /** Provider-specific overrides — driver may ignore unknown keys */
  providerOptions?: Record<string, unknown>;
}

export interface ProviderTaskResult {
  text: string;
  durationMs: number;
  startupMs?: number;
  wasAborted?: boolean;
  errorMessage?: string;     // set on provider error (replaces exitCode)
  providerMeta?: Record<string, unknown>; // tokens used, model resolved, etc.
}

export type ProviderTaskOutcome =
  | { outcome: "done";    text: string; durationMs: number; startupMs?: number; providerMeta?: Record<string, unknown> }
  | { outcome: "error";   errorMessage: string; durationMs: number }
  | { outcome: "aborted"; cancelKind: "startup_timeout" | "timeout" | "user"; durationMs: number };

export interface ProviderDriver {
  readonly name: string;
  /** Primary entry point. Must resolve; never reject (swallow errors into outcome). */
  run(input: ProviderTaskInput): Promise<ProviderTaskResult>;
  /** Optional: named prompt dispatch (e.g. Gemini function-call routing). */
  runOutcome?(input: ProviderTaskInput): Promise<ProviderTaskOutcome>;
  /** Optional: long-lived session lifecycle (server-mode drivers). */
  spawnForSession?(sessionId: string): Promise<void>;
  killForSession?(sessionId: string): void;
  /** Called once on bridge shutdown. Clean up connections, temp files. */
  destroy?(): Promise<void>;
}
```

`providerOptions` is the escape hatch: Claude callers pass `{ effort, fallbackModel, maxBudgetUsd, useAnt }` through it without polluting the shared type. Each driver picks out what it understands.

---

## 4. Changes to `src/claudeDriver.ts`

1. **Extract `StreamJsonEvent` + JSONL parsing** into `src/drivers/claude/streamParser.ts`. Keeps the core parsing logic testable in isolation.
2. **Extract settings file management** (lines 163-215) into `src/drivers/claude/subprocessSettings.ts`.
3. **Extract env stripping** (lines 262-273) into `src/drivers/claude/envSanitizer.ts`.
4. **Rename `IClaudeDriver`** → `ProviderDriver` in `src/drivers/types.ts`. Keep `IClaudeDriver` as a re-export alias for one release cycle to avoid breaking tests.
5. **`SubprocessDriver`** moves to `src/drivers/claude/subprocess.ts`, implements `ProviderDriver`. `ClaudeTaskInput`-specific fields (`useAnt`, `effort`, `fallbackModel`, `maxBudgetUsd`) read from `input.providerOptions`.
6. **`ApiDriver`** moves to `src/drivers/claude/api.ts`.
7. **`createDriver`** moves to `src/drivers/index.ts` and accepts the expanded `DriverMode` type (see §5).
8. **`toClaudeTaskOutcome`** renamed `toProviderTaskOutcome`, stays in `src/drivers/types.ts`.

Backward-compat: `src/claudeDriver.ts` becomes a thin re-export barrel pointing at the new locations. Remove after two minor versions.

---

## 5. Config Changes

**Current** (`src/config.ts:27`):
```ts
claudeDriver: "subprocess" | "api" | "none";
```

**Proposed:**
```ts
driver: "claude" | "claude-api" | "gemini" | "openai" | "grok" | "custom" | "none";
/** Path to custom driver module (used when driver === "custom") */
customDriverPath?: string;
```

CLI flag rename: `--claude-driver` → `--driver`. Keep `--claude-driver` as deprecated alias for one major version (emit warning on startup).

`createDriver` in `src/drivers/index.ts`:
```ts
export async function createDriver(
  mode: DriverMode,
  opts: DriverFactoryOpts,
  log: Logger,
): Promise<ProviderDriver | null>
```

`DriverFactoryOpts` carries binary paths, API keys, and `providerOptions` defaults from config. Custom driver loaded via dynamic `import(customDriverPath)`.

---

## 6. Folder Structure

```
src/drivers/
  types.ts                   — ProviderDriver, ProviderTaskInput, ProviderTaskResult, ProviderTaskOutcome
  index.ts                   — createDriver() factory, DriverMode union
  claude/
    subprocess.ts            — SubprocessDriver (current main impl)
    api.ts                   — ApiDriver (current stub)
    streamParser.ts          — StreamJsonEvent + JSONL parsing extracted from subprocess.ts
    subprocessSettings.ts    — settings JSON write + deny list
    envSanitizer.ts          — env var stripping logic
  gemini/
    index.ts                 — GeminiSubprocessDriver
  openai/
    index.ts                 — OpenAIApiDriver
  grok/
    index.ts                 — GrokApiDriver
```

---

## 7. Driver Sketches

### Gemini (2-3 days)

Gemini CLI (`@google/gemini-cli`, MIT license) is architecturally parallel to Claude Code: subprocess, JSONL streaming, similar hook system.

```ts
// src/drivers/gemini/index.ts
export class GeminiSubprocessDriver implements ProviderDriver {
  readonly name = "gemini";

  constructor(
    private readonly binary: string, // "gemini" on PATH
    private readonly log: Logger,
  ) {}

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    const args = [
      "--prompt", input.prompt,
      "--output-format", "json",  // confirm flag name from gemini-cli docs
      "--no-interactive",
    ];
    if (input.model) args.push("--model", input.model);
    if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);

    // Env: strip GOOGLE_CLOUD_*, strip MCP_*
    // Spawn similar to SubprocessDriver — detached, stdin: ignore
    // Parse: Gemini CLI emits similar JSONL; adapt streamParser for Gemini event shape
    // Return: ProviderTaskResult with text + durationMs
  }
}
```

Key unknowns to resolve before coding: Gemini CLI JSONL event schema (is there a `result` event?), auth mechanism (GOOGLE_API_KEY vs gcloud ADC), model flag name. Budget: 0.5 days research + 1.5 days impl + 0.5 days tests.

### OpenAI (3-5 days)

No agentic CLI runtime. Pure API via `openai` npm package. No tool-use scaffolding — single-turn completion.

```ts
// src/drivers/openai/index.ts
export class OpenAIApiDriver implements ProviderDriver {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string, // OPENAI_API_KEY
    private readonly log: Logger,
  ) {}

  async run(input: ProviderTaskInput): Promise<ProviderTaskResult> {
    // Dynamic import: const { OpenAI } = await import("openai");
    // Stream via client.chat.completions.create({ stream: true, ... })
    // onChunk: emit text deltas from choices[0].delta.content
    // model default: "gpt-4o"
    // contextFiles: prepend as system message or user message preamble
    // AbortSignal: pass as signal to fetch options (OpenAI SDK supports this)
  }
}
```

Budget: 1 day for streaming + onChunk wiring, 1 day for abort/timeout handling, 1 day for tests, 0.5 day for contextFiles strategy, 0.5 day for model/token meta in `providerMeta`.

Limitation: no agentic loop — `runClaudeTask` tasks that expect multi-turn tool use will produce single-turn answers. Document this clearly.

### Grok (1 week)

xAI API is OpenAI-compatible (`https://api.x.ai/v1`). Can reuse `OpenAIApiDriver` with a custom base URL.

```ts
// src/drivers/grok/index.ts
export class GrokApiDriver extends OpenAIApiDriver {
  readonly name = "grok";

  constructor(apiKey: string, log: Logger) {
    super(apiKey, log, { baseURL: "https://api.x.ai/v1", defaultModel: "grok-2-latest" });
  }
}
```

Main cost: validation week (xAI's API compatibility surface vs OpenAI SDK assumptions), streaming parity testing, and rate limit handling differences. 1 week includes buffer for API quirks.

---

## 8. Contributor Guide Stub

**To add a new driver:**

1. Create `src/drivers/<provider>/index.ts`.
2. Export a class that implements `ProviderDriver` from `src/drivers/types.ts`.
3. Implement `run(input: ProviderTaskInput): Promise<ProviderTaskResult>`:
   - Never throw — catch errors and return `{ text: "", durationMs, errorMessage }`.
   - Call `input.onChunk(delta)` for each streaming token.
   - Respect `input.signal` (AbortSignal) — abort inflight requests when it fires.
   - Respect `input.timeoutMs` — race against `AbortSignal.timeout(input.timeoutMs)` or equivalent.
   - Cap output at 50KB (`OUTPUT_CAP = 50 * 1024`).
4. Register in `src/drivers/index.ts` `createDriver()` switch.
5. Add `"<provider>"` to the `DriverMode` union in `src/drivers/types.ts`.
6. Add CLI flag value to `--driver` enum in `src/config.ts`.
7. Write unit tests in `src/drivers/__tests__/<provider>.test.ts`:
   - Mock network/subprocess. Test: `run()` resolves, `onChunk` called, abort respected, timeout fires, error path returns `errorMessage`.
   - Use `TestDriver` stub in `src/__tests__/helpers/testDriver.ts` as reference for mock shape.
8. Provide one integration smoke test (can be skipped in CI via `DRIVER_SMOKE=1` env gate).

**Checklist before PR:**
- [ ] `ProviderDriver` interface fully implemented
- [ ] `run()` never throws
- [ ] `AbortSignal` respected
- [ ] Output capped at 50KB
- [ ] Unit tests cover happy path + abort + error
- [ ] Driver registered in `createDriver()` factory
- [ ] Auth env var documented in `docs/remote-access.md`

---

## 9. Risk Assessment

### Existing Claude users

- `--claude-driver subprocess` still works (deprecated alias). No behavior change.
- `ClaudeTaskInput` shape preserved as internal type used by `SubprocessDriver`. `providerOptions` addition is backward-compatible (optional field).
- Tests in `src/__tests__/claudeDriver.test.ts` (250+ tests) continue to pass — `SubprocessDriver` not renamed, just moved.

### Automation hooks

Hooks call `orchestrator.enqueue()` → `IClaudeDriver.run()`. Interface rename (`IClaudeDriver` → `ProviderDriver`) is internal. Automation layer calls `createDriver()` and holds a `ProviderDriver` reference — no change to call sites if re-export alias is kept.

### Test mocks

`src/__tests__/claudeOrchestrator.test.ts` and automation tests use a mock implementing `IClaudeDriver`. Re-export alias keeps these passing. Flag test mocks in CLAUDE.md as needing migration after alias removal.

### Breaking change window

- Minor release: add `ProviderDriver` interface + new folder structure, keep `IClaudeDriver` alias.
- Next minor: migrate all internal call sites to `ProviderDriver`.
- Next major: remove `IClaudeDriver` alias and `--claude-driver` flag.

### Biggest actual risk

`ClaudeTask` in `src/claudeOrchestrator.ts` (lines 23-64) has Claude-specific fields (`model`, `effort`, `fallbackModel`, `maxBudgetUsd`, `useAnt`). These map 1:1 to `ClaudeTaskInput`. Moving them to `providerOptions` requires updating `runClaudeTask` tool, `getClaudeTaskStatus` output schema, and the orchestrator's `enqueue()` mapping. Estimate: 0.5 day, low risk if done atomically.
