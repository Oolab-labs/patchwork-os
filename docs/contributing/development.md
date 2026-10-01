# Development — build, test and typecheck the way CI does

Everything below is taken from `.github/workflows/ci.yml` and the `scripts`
block of `package.json`. When the two disagree with this page, they win; fix
the page.

## The main job, in order

CI runs the bridge job on a matrix of `ubuntu-latest` × `windows-latest` and
Node 22 × 24. **All four cells are blocking**
([ADR-0012](../adr/0012-windows-ci-blocking.md) graduated Windows from
advisory to required; Node 24 is there because the durable evidence store uses
`node:sqlite`, an experimental API). The steps, in the order CI runs them:

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm run typecheck:tests:core
```

```bash
npm run lint
```

```bash
node scripts/audit-test-fixtures.mjs
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run test:coverage
```

Then a set of dependent jobs: the tool-schema breaking-change gate, the
registry/docs audit job that runs most of [the gates](gates.md), a
fresh-install smoke test of the packed tarball, live-bridge smoke tests on both
operating systems, the dashboard, the extension, the push relay, and a Docker
smoke test.

## Each command, and what it actually does

### `npm run build`

Wipes `dist/`, runs `tsc`, then the postinstall script. Several gates read
`dist/` rather than `src/` (the tool registry audit, the skill-parity audit,
the schema snapshot), so build before running them locally.

### `npm test` goes through the bridge

`npm test` is `node scripts/test-via-bridge.mjs`, not `vitest run`. The
wrapper looks for a live Patchwork bridge lock for this workspace under
`~/.claude/ide/`. If one is running, it sends the run through the bridge's
`runTests` MCP tool over Streamable HTTP: the bridge executes vitest itself and
fires the `onTestRun` automation hook, so a failure reaches the same
automation triggers a Claude-session-initiated run would. If no bridge is
running (CI, a fresh clone), it falls straight back to `vitest run` with
identical behaviour.

Two consequences. First, when you want vitest and nothing else — a filter, a
reporter flag, a debugger — use the raw entry:

```bash
npm run test:raw -- src/recipes/__tests__/flatCompoundSteps.test.ts
```

Second, a bridge started with `approvalGate: "all"` will queue the `runTests`
call for approval, which looks like `npm test` hanging. That is the gate
working, not a broken test runner.

### `npm run typecheck` and `npm run typecheck:tests:core`

`npm run typecheck` is `tsc --noEmit` against `tsconfig.json`, which **does not
include test files**. Vitest does not typecheck either: it transpiles tests and
runs them, so a test with a type error can pass.

`npm run typecheck:tests:core` is the CI ratchet that closes that gap. It
typechecks `src/**/*` including tests under `tsconfig.tests.core.json`, which
inherits the strict options (`noUnusedLocals` among them) and carries an
explicit `exclude` list of test files that do not yet typecheck. The list only
shrinks: fix a file, remove it from the list. A test that is green under vitest
and red under this ratchet is a red CI cell, so run it before pushing.

`npm run typecheck:tests` (no `:core`) typechecks every test file under a
looser config and is not a CI step.

### `npm run lint` and biome

`npm run lint` is `biome check .`. Run the fixer on the files you changed
**before staging** rather than letting the pre-commit hook fail on them:

```bash
npx biome check --write src/path/to/changed.ts
```

The generated JSON schemas under `schemas/` and `dashboard/public/schema/`
need the same treatment after `npm run schema:generate`; the generator emits
JSON that biome reformats, and the schema gate compares parsed content so the
reformatted file is the correct committed state.

### Coverage

`npm run test:coverage` enforces line, branch and function thresholds. The
numbers live in the `thresholds` block of `vitest.config.ts` together with a
comment on why they were re-baselined; read them there rather than from any
document, because `scripts/audit-docs-drift.mjs` fails a doc whose copy of
them drifts. CI gives the coverage step a tighter time budget than the plain
test step, and that is the step that gets killed first on Windows — see
[testing.md](testing.md) for the heavy-tailed suites.

## The other workspaces

Each has its own lockfile and its own `npm ci`. CI runs them from inside the
directory:

Dashboard (`dashboard/`):

```bash
cd dashboard && npm ci && npm run typecheck && npm run lint && npm run tokens:check && npm run lint:inline-fontsize && npm test
```

Extension (`vscode-extension/`, blocking on Windows too):

```bash
cd vscode-extension && npm ci && npm run typecheck && npm test && npm run build
```

Push relay (`services/push-relay/`):

```bash
cd services/push-relay && npm ci && npx tsc --noEmit && npm test
```

The extension's `npm run build` is an esbuild bundle; `npm run package`
produces the `.vsix`. Bump `vscode-extension/package.json` before packaging —
the rule and the reason are in [releasing.md](releasing.md).

## Pre-commit hooks

`.husky/pre-commit` runs two things, in this order:

1. `node scripts/audit-private-identifiers.mjs` — scans the **staged diff and
   the branch name** against an operator denylist that never enters the
   repository. Runs first so that a privacy failure is the message you see,
   and so that formatting content that must not be committed is not wasted
   work. See [privacy-rules.md](privacy-rules.md) for where the denylist
   lives and what the gate cannot do.
2. `npx lint-staged` — `biome check` over staged `.ts`, `.js`, `.mjs`, `.cjs`
   and `.json` files under `src/`, `vscode-extension/src/`, `scripts/` and
   `deploy/`.

`.husky/commit-msg` runs the private-identifier gate again over the **commit
message**, because a message cannot be quietly edited after a push and a
merged PR body is mirrored into notification email the moment it lands.

`git commit --no-verify` bypasses all of it. The hooks are a seatbelt, not a
wall: they protect only a machine that has them installed (`npm ci` runs
`husky` via the `prepare` script) and configured a denylist. If a hook blocks
you, read what it printed and fix the content; do not bypass it to get a
commit through.

## A local approximation of CI

Before opening a PR, from the repository root:

```bash
npm run typecheck && npm run typecheck:tests:core && npm run lint && npm run build && npm run test:raw
```

then the gates you can run without network access — [gates.md](gates.md) lists
which those are. The in-flight ledger gate and the production-CVE gate call
GitHub and npm respectively and will not run offline.
