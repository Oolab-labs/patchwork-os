# Automation Hooks

## What automation hooks do

Automation hooks let Claude act autonomously on IDE and git events without user input. When a Claude Code lifecycle event fires — a file is saved, a test run completes, a branch is checked out — the bridge evaluates your policy file, and if the matching hook is enabled and its cooldown has elapsed, the bridge spawns a Claude Code subprocess with the configured prompt. The subprocess has full access to bridge tools (`--full` mode), runs to completion, and exits. No user interaction is required at any step.

---

## Prerequisites

- `--automation` — enables hook evaluation in the bridge
- `--full` — most hooks invoke tools like `runTests`, `gitCommit`, `getDiagnostics` that are only available in full mode
- `--claude-driver subprocess` — required to spawn Claude Code subprocesses; without this, hooks are evaluated but never dispatched
- `--automation-policy <path>` — path to your policy JSON file; if omitted, the bridge looks for `automation-policy.json` in the workspace root

**Claude Code version minimums for CC-wired hooks:**

| Hook | Minimum CC version |
|---|---|
| `onPostCompact`, `onInstructionsLoaded` | 2.1.76 |
| `onFileChanged`, `onCwdChanged` | 2.1.83 |
| `onTaskCreated` | 2.1.84 |
| `onPermissionDenied` | 2.1.89 |

All other hooks (`onFileSave`, `onTestRun`, `onGitCommit`, etc.) are fired directly by bridge tool calls and have no CC version requirement.

---

## Enabling automation

Full command:

```bash
claude-ide-bridge \
  --watch \
  --full \
  --automation \
  --automation-policy /path/to/automation-policy.json \
  --claude-driver subprocess
```

The policy file lives wherever you point `--automation-policy`. A common location is the workspace root:

```
/workspace/
  automation-policy.json
  src/
  ...
```

**Minimal working example** — trigger on every `.ts` file save:

```json
{
  "onFileSave": {
    "enabled": true,
    "patterns": ["**/*.ts"],
    "cooldownMs": 10000,
    "prompt": "{{file}} was saved. Run getDiagnostics and report any errors."
  }
}
```

**Verifying hook wiring:**

Call `getBridgeStatus` and inspect the `ccHookWiring` field. If `unwiredEnabledHooks` is non-empty, those hooks are enabled in policy but not wired in `~/.claude/settings.json`. Run `claude-ide-bridge init` to auto-wire them, or see [Claude Code hook wiring](#claude-code-hook-wiring) below.

---

## Hook Reference

| Hook | Fires when | CC version | Placeholders | Default enabled |
|---|---|---|---|---|
| `onDiagnosticsError` | New error/warning diagnostics appear for a file | any | `{{file}}`, `{{diagnostics}}` | — |
| `onDiagnosticsCleared` | Diagnostics drop from non-zero to zero for a file | any | `{{file}}` | — |
| `onFileSave` | A file matching `patterns` is saved | any | `{{file}}` | — |
| `onFileChanged` | A file matching `patterns` is changed in the buffer | ≥ 2.1.83 | `{{file}}` | — |
| `onCwdChanged` | Claude Code's working directory changes | ≥ 2.1.83 | `{{cwd}}` | — |
| `onPostCompact` | Claude Code compacts conversation context | ≥ 2.1.76 | _(none)_ | — |
| `onInstructionsLoaded` | Interactive session starts (InstructionsLoaded hook) | ≥ 2.1.76 | _(none)_ | — |
| `onTestRun` | `runTests` completes | any | `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}` | — |
| `onTestPassAfterFailure` | A runner transitions failing → passing | any | `{{runner}}`, `{{passed}}`, `{{total}}` | — |
| `onGitCommit` | `gitCommit` succeeds | any | `{{hash}}`, `{{branch}}`, `{{message}}`, `{{files}}`, `{{count}}` | — |
| `onGitPush` | `gitPush` succeeds | any | `{{remote}}`, `{{branch}}`, `{{hash}}` | — |
| `onGitPull` | `gitPull` succeeds | any | `{{remote}}`, `{{branch}}` | — |
| `onBranchCheckout` | `gitCheckout` succeeds | any | `{{branch}}`, `{{previousBranch}}`, `{{created}}` | — |
| `onPullRequest` | `githubCreatePR` succeeds | any | `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}` | — |
| `onTaskCreated` | Claude Code creates a subagent task (TaskCreated hook) | ≥ 2.1.84 | `{{taskId}}`, `{{prompt}}` | — |
| `onTaskSuccess` | A bridge orchestrator task completes with status `done` | any | `{{taskId}}`, `{{output}}` | — |
| `onPermissionDenied` | A tool call is blocked (PermissionDenied hook) | ≥ 2.1.89 | `{{tool}}`, `{{reason}}` | — |
| `onDebugSessionEnd` | A VS Code debug session terminates | any | `{{sessionName}}`, `{{sessionType}}` | — |
| `onDebugSessionStart` | A VS Code debug session starts | any | `{{sessionName}}`, `{{sessionType}}`, `{{breakpointCount}}`, `{{activeFile}}` | — |
| `onPreCompact` | Claude Code is about to compact the conversation context | ≥ 2.1.76 | _(none)_ | — |

All hooks default to disabled (`"enabled": false` if omitted). You must set `"enabled": true` explicitly.

---

### onDiagnosticsError

**Trigger:** New error or warning diagnostics appear for a file (non-zero → new diagnostic transition). Controlled by `minSeverity` and optionally `diagnosticTypes`.

**Placeholders:** `{{file}}`, `{{diagnostics}}` (formatted list of up to 20 diagnostics)

**Use case:** Explain or fix type errors as they appear.

```json
"onDiagnosticsError": {
  "enabled": true,
  "minSeverity": "error",
  "diagnosticTypes": ["ts"],
  "cooldownMs": 15000,
  "prompt": "Type error in {{file}}:\n{{diagnostics}}\nExplain root cause and suggest fix. ≤10 lines."
}
```

---

### onDiagnosticsCleared

**Trigger:** All errors and warnings clear for a file (non-zero → zero transition).

**Placeholders:** `{{file}}`

**Use case:** Run tests after an error is resolved to confirm no regressions.

```json
"onDiagnosticsCleared": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Errors cleared in {{file}}. runTests → confirm fix is correct."
}
```

---

### onFileSave

**Trigger:** A file matching one or more `patterns` (minimatch globs) is saved. Use `condition` to add a secondary glob filter (prefix `!` to negate).

**Placeholders:** `{{file}}`

**Use case:** Run lint or type-check on every source file save.

```json
"onFileSave": {
  "enabled": true,
  "patterns": ["src/**/*.ts", "!**/*.test.ts"],
  "cooldownMs": 8000,
  "prompt": "{{file}} saved. fixAllLintErrors then getDiagnostics. Report error count."
}
```

---

### onFileChanged

**Trigger:** A file matching `patterns` is changed in the buffer (any edit, not just saves). Requires CC ≥ 2.1.83. Higher noise than `onFileSave` — use a longer `cooldownMs`.

**Placeholders:** `{{file}}`

**Use case:** Track frequent buffer changes in real time (use sparingly).

```json
"onFileChanged": {
  "enabled": true,
  "patterns": ["src/critical-module.ts"],
  "cooldownMs": 30000,
  "prompt": "{{file}} changed. getDiagnostics → errors only. ≤5 lines."
}
```

---

### onCwdChanged

**Trigger:** Claude Code's working directory changes (CC CwdChanged hook). Requires CC ≥ 2.1.83.

**Placeholders:** `{{cwd}}`

**Use case:** Re-orient to a new workspace when Claude switches directories.

```json
"onCwdChanged": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Working directory changed to {{cwd}}. getProjectInfo → project name and version."
}
```

---

### onPostCompact

**Trigger:** Claude Code compacts its conversation context (CC PostCompact hook). Requires CC ≥ 2.1.76. No placeholders — fires unconditionally on compaction.

**Use case:** Re-inject IDE context after context is truncated.

```json
"onPostCompact": {
  "enabled": true,
  "cooldownMs": 5000,
  "prompt": "Compacted. getGitStatus + getDiagnostics workspace-wide. Branch, error count, warning count ≤5 lines."
}
```

---

### onInstructionsLoaded

**Trigger:** A new interactive Claude Code session starts (CC InstructionsLoaded hook). Requires CC ≥ 2.1.76. No placeholders. A `cooldownMs` (default 60000 ms) prevents cascade when automation subprocesses each fire their own session-start hook.

**Use case:** Inject bridge status and project context at the start of every session.

```json
"onInstructionsLoaded": {
  "enabled": true,
  "cooldownMs": 60000,
  "promptName": "project-status"
}
```

---

### onTestRun

**Trigger:** `runTests` completes. When `onFailureOnly` is `true` (default), fires only when `failed > 0`. Set `onFailureOnly: false` to fire on every run. `minDuration` (ms) can filter out fast runs.

**Placeholders:** `{{runner}}`, `{{failed}}`, `{{passed}}`, `{{total}}`, `{{failures}}` (JSON array of `{name, file, message}`)

**Use case:** Investigate and fix failing tests automatically.

```json
"onTestRun": {
  "enabled": true,
  "onFailureOnly": true,
  "cooldownMs": 10000,
  "prompt": "{{failed}}/{{total}} tests failed.\n{{failures}}\ngetDiagnostics on failing files. Root cause + minimal fix. Don't change test expectations unless contract changed."
}
```

---

### onTestPassAfterFailure

**Trigger:** A test runner transitions from a failing state to passing. Per-runner state tracking prevents cross-runner false triggers (vitest passing after jest fails does NOT trigger).

**Placeholders:** `{{runner}}`, `{{passed}}`, `{{total}}`

**Use case:** Notify or summarize when a previously-broken test suite is fixed.

```json
"onTestPassAfterFailure": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "{{runner}} tests now passing ({{passed}}/{{total}}). getGitStatus → summarize what changed."
}
```

---

### onGitCommit

**Trigger:** `gitCommit` succeeds.

**Placeholders:** `{{hash}}`, `{{branch}}`, `{{message}}`, `{{files}}` (newline-separated list), `{{count}}` (number of files)

**Use case:** Run workspace-wide diagnostics after every commit.

```json
"onGitCommit": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Commit {{hash}} on {{branch}}: {{message}}\nFiles: {{files}}\ngetDiagnostics workspace-wide. Errors → report. ≤8 lines."
}
```

---

### onGitPush

**Trigger:** `gitPush` succeeds.

**Placeholders:** `{{remote}}`, `{{branch}}`, `{{hash}}`

**Use case:** Trigger CI status check or summarize what was pushed.

```json
"onGitPush": {
  "enabled": true,
  "cooldownMs": 15000,
  "prompt": "Pushed {{branch}} to {{remote}} at {{hash}}. getGitLog (last 3 commits) → summarize."
}
```

---

### onGitPull

**Trigger:** `gitPull` succeeds.

**Placeholders:** `{{remote}}`, `{{branch}}`

**Use case:** Run tests after pulling to catch merge regressions.

```json
"onGitPull": {
  "enabled": true,
  "cooldownMs": 15000,
  "prompt": "Pulled {{branch}} from {{remote}}. getDiagnostics + runTests → errors and failures. ≤8 lines."
}
```

---

### onBranchCheckout

**Trigger:** `gitCheckout` succeeds (branch switch or creation). Only fires for checkouts issued via the bridge `gitCheckout` tool, not external `git checkout` commands.

**Placeholders:** `{{branch}}`, `{{previousBranch}}`, `{{created}}` (`"true"` or `"false"`)

**Use case:** Snapshot the new branch's state immediately after switching.

```json
"onBranchCheckout": {
  "enabled": true,
  "cooldownMs": 15000,
  "prompt": "Switched to {{branch}} from {{previousBranch}}. getDiagnostics + getGitStatus → errors, modified files. ≤6 lines."
}
```

---

### onPullRequest

**Trigger:** `githubCreatePR` succeeds.

**Placeholders:** `{{url}}`, `{{number}}`, `{{title}}`, `{{branch}}`

**Use case:** Post a summary or trigger review automation after a PR is opened.

```json
"onPullRequest": {
  "enabled": true,
  "cooldownMs": 30000,
  "prompt": "PR #{{number}} opened: {{title}}\nURL: {{url}}\ngetGitDiff (base...{{branch}}) → summarize changes in ≤10 lines."
}
```

---

### onTaskCreated

**Trigger:** Claude Code fires the TaskCreated hook when it creates a subagent task. Requires CC ≥ 2.1.84 and wiring in `~/.claude/settings.json`.

**Placeholders:** `{{taskId}}`, `{{prompt}}`

**Use case:** Log or react to Claude spinning up a new subagent.

```json
"onTaskCreated": {
  "enabled": true,
  "cooldownMs": 5000,
  "prompt": "Task {{taskId}} created. Prompt excerpt: {{prompt}}. getHandoffNote → verify context."
}
```

---

### onTaskSuccess

**Trigger:** A bridge-orchestrated Claude Code task (started via `runClaudeTask`) completes with status `done`.

**Placeholders:** `{{taskId}}`, `{{output}}`

**Use case:** Chain automation tasks — run a follow-up action when a previous task finishes.

```json
"onTaskSuccess": {
  "enabled": true,
  "cooldownMs": 5000,
  "prompt": "Task {{taskId}} finished. Output: {{output}}\ngetGitStatus → any uncommitted changes?"
}
```

---

### onPermissionDenied

**Trigger:** Claude Code fires the PermissionDenied hook when a tool call is blocked. Requires CC ≥ 2.1.89 and wiring in `~/.claude/settings.json`.

**Placeholders:** `{{tool}}`, `{{reason}}`

**Use case:** Log blocked tool calls for audit or alert on unexpected denials.

```json
"onPermissionDenied": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Tool {{tool}} was blocked: {{reason}}. Is this expected? getBridgeStatus → confirm allowlist."
}
```

---

### onDebugSessionEnd

**Trigger:** A VS Code debug session terminates (`hasActiveSession` transitions `true` → `false`).

**Placeholders:** `{{sessionName}}`, `{{sessionType}}`

**Use case:** Automatically run tests after a debug session to verify the fix.

```json
"onDebugSessionEnd": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Debug session '{{sessionName}}' ({{sessionType}}) ended. runTests → pass/fail. ≤6 lines."
}
```

---

### onDebugSessionStart

**Trigger:** A VS Code debug session starts (`hasActiveSession` transitions `false` → `true`).

**Placeholders:** `{{sessionName}}`, `{{sessionType}}`, `{{breakpointCount}}`, `{{activeFile}}`

**Use case:** Brief Claude on debugging context before you start stepping through code.

```json
"onDebugSessionStart": {
  "enabled": true,
  "cooldownMs": 10000,
  "prompt": "Debug session '{{sessionName}}' ({{sessionType}}) started. {{breakpointCount}} breakpoints set; active file: {{activeFile}}. Summarise what could cause failures here."
}
```

---

### onPreCompact

**Trigger:** Claude Code is about to compact the conversation context window (fires before `onPostCompact`). Requires the `PreCompact` CC hook wired in `settings.json` (auto-wired by `init`).

**Placeholders:** _(none)_

**Use case:** Snapshot critical state before context is trimmed — write a handoff note, flush pending decisions, or summarise the current task so the post-compact session can pick up cleanly.

```json
"onPreCompact": {
  "enabled": true,
  "cooldownMs": 60000,
  "prompt": "Context compaction is about to happen. Call setHandoffNote with a concise summary of: (1) what we are building, (2) last 3 decisions made, (3) next action needed."
}
```

**CC hook wiring** — add to `~/.claude/settings.json` (auto-added by `claude-ide-bridge init`):

```json
"PreCompact": [
  { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PreCompact" }] }
]
```

---

## Shared policy fields

These fields are valid on every hook object.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Whether the hook fires. Must be `true` explicitly. |
| `prompt` | string | — | Inline prompt template with `{{placeholder}}` tokens. Mutually exclusive with `promptName`. |
| `promptName` | string | — | Name of a built-in MCP prompt. Mutually exclusive with `prompt`. |
| `promptArgs` | object | — | Static args passed to the named prompt. Values may contain `{{placeholder}}` tokens. |
| `cooldownMs` | number | varies | Minimum milliseconds between triggers for the same hook/file. Enforced minimum: 5000. |
| `condition` | string | — | Secondary minimatch glob filter on the event value (file path, branch name, etc.). Prefix with `!` to negate. |
| `when` | object | — | Runtime condition: `minDiagnosticCount`, `diagnosticsMinSeverity`, `testRunnerLastStatus`. All specified fields must pass. |
| `effort` | string | `defaultEffort` | Per-hook effort level (`low` / `medium` / `high` / `max`). |
| `model` | string | `defaultModel` | Per-hook model override. |
| `retryCount` | number | `0` | Times to re-enqueue on task `error` status. Does not retry on cancel or timeout. |
| `retryDelayMs` | number | `30000` | Milliseconds between retries. Enforced minimum: 5000. |
| `onFailureOnly` | boolean | `true` | `onTestRun` only. When `true`, only fires when `failed > 0`. |

---

## Global policy fields

Top-level fields that apply across all hooks.

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultModel` | string | `"claude-haiku-4-5-20251001"` | Default model for all automation subprocesses. |
| `defaultEffort` | string | `"low"` | Default effort level. |
| `maxTasksPerHour` | number | `20` | Hard cap on tasks spawned in a rolling 60-minute window. Set to `0` to disable. |
| `automationSystemPrompt` | string | brief "be concise" prompt | Custom system prompt passed via `--system-prompt` to every subprocess. Replaces the default Claude Code system prompt. Max 4096 chars. |

---

## Effort levels

| Level | Token budget | When to use |
|---|---|---|
| `low` | Minimal | Diagnostics checks, status summaries, simple one-tool tasks |
| `medium` | Moderate | Analysis tasks spanning multiple files or tools |
| `high` | Extended | Refactoring, complex investigation, multi-step fixes |
| `max` | Maximum | Unconstrained; reserve for rare high-stakes tasks |

---

## Rate limiting

The bridge enforces a rolling 60-minute window on automation task dispatch. When the count reaches `maxTasksPerHour` (default 20), the next task is dropped and logged — it does not queue. The hook's cooldown timer still advances, so the hook can fire again once the window rolls forward.

**Minimum cooldown:** 5000 ms per hook (enforced regardless of what you set).

**Tuning guidelines:**

- **Interactive development:** `maxTasksPerHour: 20`, per-hook `cooldownMs` around 8–15 seconds. High-frequency hooks like `onFileSave` should have longer cooldowns (10–30 seconds).
- **CI / batch processing:** Lower `maxTasksPerHour` (5–10) or disable noisy hooks entirely. Use `onGitCommit` or `onTestRun` rather than file-level hooks.
- **If tasks are being dropped:** Check `getBridgeStatus` for task count metrics, increase cooldowns on high-frequency hooks first, then raise `maxTasksPerHour` if needed.

---

## Named prompts (promptName)

Instead of an inline `prompt`, you can reference a built-in MCP prompt by name:

```json
"onPostCompact": {
  "enabled": true,
  "cooldownMs": 5000,
  "promptName": "project-status"
}
```

Pass arguments with `promptArgs`. Values may include `{{placeholder}}` tokens that are substituted before the prompt is resolved:

```json
"onFileSave": {
  "enabled": true,
  "patterns": ["src/**/*.ts"],
  "cooldownMs": 10000,
  "promptName": "review-changes",
  "promptArgs": { "file": "{{file}}" }
}
```

**When to use named prompts vs inline:**

- Named prompts are built-in and versioned with the bridge. They receive updates automatically when the bridge is upgraded.
- Inline prompts are fully custom. Use them for project-specific logic that the bridge doesn't know about.
- For standard tasks (project-status, quick-review, build-check), prefer named prompts. For domain-specific automation, use inline.

---

## Claude Code hook wiring

Five hooks rely on CC's hook system and require entries in `~/.claude/settings.json`. The bridge cannot receive these events otherwise:

| Hook | CC event | `notify` command |
|---|---|---|
| `onPostCompact` | `PostCompact` | `claude-ide-bridge notify PostCompact` |
| `onInstructionsLoaded` | `InstructionsLoaded` | `claude-ide-bridge notify InstructionsLoaded` |
| `onTaskCreated` | `TaskCreated` | `claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT` |
| `onPermissionDenied` | `PermissionDenied` | `claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON` |
| `onCwdChanged` | `CwdChanged` | `claude-ide-bridge notify CwdChanged --cwd $CWD` |

**Auto-wiring:** `claude-ide-bridge init` adds these entries idempotently.

**Manual wiring** — add to `~/.claude/settings.json` under `hooks`. CC requires `matcher` + `hooks` arrays:

```json
{
  "hooks": {
    "PostCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PostCompact" }] }
    ],
    "InstructionsLoaded": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify InstructionsLoaded" }] }
    ],
    "TaskCreated": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT" }] }
    ],
    "PermissionDenied": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON" }] }
    ],
    "CwdChanged": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "claude-ide-bridge notify CwdChanged --cwd $CWD" }] }
    ]
  }
}
```

The `notify` subcommand reads the bridge lock file to find the running port and auth token, then POSTs to the `/notify` HTTP endpoint. The bridge must be running when CC fires the hook.

**Checking wiring status:** `getBridgeStatus` → `ccHookWiring.unwiredEnabledHooks`. An empty array means all enabled CC-wired hooks are correctly configured.

---

## Full example policy

A complete `automation-policy.json` covering five common hooks:

```json
{
  "defaultModel": "claude-haiku-4-5-20251001",
  "defaultEffort": "low",
  "maxTasksPerHour": 20,
  "automationSystemPrompt": "Automation assistant. ≤5 lines. No preamble. Call tools → report results only.",

  "onFileSave": {
    "enabled": true,
    "patterns": ["src/**/*.ts", "src/**/*.tsx"],
    "condition": "!**/*.test.ts",
    "cooldownMs": 10000,
    "prompt": "{{file}} saved. fixAllLintErrors then getDiagnostics. Report error count and any remaining warnings."
  },

  "onGitCommit": {
    "enabled": true,
    "cooldownMs": 15000,
    "prompt": "Commit {{hash}} on {{branch}}: {{message}}\nChanged files:\n{{files}}\ngetDiagnostics workspace-wide. Errors block shipping — list them. ≤8 lines."
  },

  "onTestRun": {
    "enabled": true,
    "onFailureOnly": true,
    "cooldownMs": 10000,
    "prompt": "{{failed}}/{{total}} tests failed in {{runner}}.\nFailures:\n{{failures}}\ngetDiagnostics on the failing test files. Identify root cause. Suggest minimal fix without changing test expectations unless the contract changed."
  },

  "onDiagnosticsError": {
    "enabled": true,
    "minSeverity": "error",
    "diagnosticTypes": ["ts", "eslint"],
    "cooldownMs": 15000,
    "prompt": "Error in {{file}}:\n{{diagnostics}}\ngetCallHierarchy (incoming) on the affected symbol. Explain root cause. ≤10 lines."
  },

  "onDebugSessionEnd": {
    "enabled": true,
    "cooldownMs": 10000,
    "prompt": "Debug session '{{sessionName}}' ended. runTests → confirm the fix works and no regressions. ≤6 lines."
  }
}
```

---

## Troubleshooting

**Hook not firing:**
- Verify `"enabled": true` is set on the hook.
- Check CC version meets the minimum for CC-wired hooks (see Prerequisites).
- Confirm `--automation` flag is passed to the bridge.
- Call `getBridgeStatus` → `ccHookWiring.unwiredEnabledHooks`. Any entry here means the hook's CC event is not wired in `~/.claude/settings.json`. Run `claude-ide-bridge init` to fix.
- For `onFileSave` / `onFileChanged`, verify the saved file path matches your `patterns` globs.

**Subprocess immediately exits or produces no output:**
- Start the bridge with `--verbose` to see subprocess stdout/stderr in the bridge log.
- Verify `CLAUDE_CONFIG_DIR` is set correctly if you use a non-default config path.
- Confirm `claude` is on PATH (or set `--claude-binary <path>`).
- Subprocess errors surface in `getClaudeTaskStatus` — check `stderrTail`.

**Rate limit exhausted (tasks being dropped):**
- Increase `cooldownMs` on high-frequency hooks (`onFileSave`, `onFileChanged`) first.
- Raise `maxTasksPerHour` if legitimate tasks are being dropped.
- Disable or increase cooldowns on diagnostic hooks if LSP is emitting rapid bursts.

**Loop guard — hook re-triggering from its own subprocess:**
The bridge tracks active automation task IDs per hook. If a hook's subprocess triggers the same hook again (e.g., `onPostCompact` fires, subprocess runs, compacts context again), the bridge will not enqueue a new task while one is already active for that hook. This prevents unbounded recursion. The `activePostCompactTaskId` and `activeInstructionsLoadedTaskId` guards apply to those two hooks specifically; other hooks use the cooldown as the primary loop-prevention mechanism.
