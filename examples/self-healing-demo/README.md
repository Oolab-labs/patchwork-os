# Self-healing demo

A minimal reproduction of the `onDiagnosticsError` → `runClaudeTask` loop. Save a broken TypeScript file, watch Claude notice the diagnostic, call LSP tools, and propose a fix — with no user prompt.

This is the "save a broken file → Claude fixes it" demo. The primitives (automation hooks, `runClaudeTask`, `getDiagnostics`) all already ship in `claude-ide-bridge`. This directory just wires them together against a sample repo.

## What's in here

| File | Purpose |
|---|---|
| `automation-policy.json` | `onDiagnosticsError` hook → calls `runClaudeTask` with an LSP-grounded prompt |
| `src/broken.ts` | Deliberately broken — type error + unused import. Reproducibly red on `tsc --noEmit`. |
| `src/fixed.ts` | Reference of what the fixed file looks like. Diff against `broken.ts` after Claude runs. |
| `package.json` | Minimal deps (`typescript` only) + `npm run check` |
| `tsconfig.json` | Strict TS so diagnostics fire |

## Prereqs

1. `claude-ide-bridge` ≥ 2.42.1 installed globally (`npm i -g claude-ide-bridge`).
2. `claude` CLI on PATH (the bridge spawns it as a subprocess).
3. The bridge's VS Code companion extension installed in the IDE you open this folder with — LSP needs an extension to drive diagnostics.

See `docs/self-healing-quickstart.md` in the repo root for the 5-minute full setup.

## Run it

From this directory:

```bash
npm install
claude-ide-bridge \
  --workspace "$PWD" \
  --full \
  --automation \
  --automation-policy ./automation-policy.json \
  --claude-driver subprocess
```

Then open `src/broken.ts` in your IDE. The TypeScript language server will surface the error; the bridge's `onDiagnosticsError` hook fires; `runClaudeTask` spawns a Claude subprocess with the diagnostic contents already embedded; Claude is instructed to call `getDiagnostics` + `getHover` + propose a patch and return its reasoning.

Watch the output in `getActivityLog` or the sidebar panel.

## What to expect

- First trigger fires within ~1s of saving the file with a new error.
- Subsequent saves on the same file are cooldown-suppressed (default 20s).
- Claude's response is returned via the `runClaudeTask` result — it does **not** auto-edit the file (that's a separate design decision; propose-then-apply is the current default for safety).
- To close the loop into an auto-fix PR, chain `onTestRun` (pass) → `githubCreatePR`. Not included here to keep the demo minimal.

## Why this matters

Most "Claude CLI" integrations require a prompt. This demo shows the opposite: the editor's state drives Claude. You didn't ask for help; help arrived.

## Gotchas

- The hook only fires on *new* errors. Files that are already red when the bridge starts won't trigger — save them once to re-emit.
- `maxTasksPerHour: 10` is intentionally conservative. Bump it in `automation-policy.json` if you're stress-testing.
- The `minSeverity: "error"` filter ignores warnings. Change to `"warning"` to see more traffic.
