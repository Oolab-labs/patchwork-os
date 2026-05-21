---
description: "Diagnose a failing CI run and propose a fix"
argument-hint: "[run-id-or-pr-number]"
allowed-tools: ["Read", "Grep", "Glob", "Bash", "Agent"]
---

# Fix Failing CI

Diagnose the failing CI run **$1** (a workflow run id, or a PR number whose
checks are red — if omitted, use the most recent failing run on the current
branch).

## Step 1: Locate the Failing Run

If `$1` is a PR number, call `githubViewPR` to find its check runs. Otherwise
call `githubListRuns` and pick the most recent `failure` on the current branch.
Report the run id and which job(s) failed.

## Step 2: Pull the Logs

Call `githubGetRunLogs` for the failing run. Identify the failing step and the
first real error — not downstream noise. Common failure shapes in this repo:

- **typecheck** — `tsc -p tsconfig.tests.core.json` is stricter than vitest
  (`noUnusedLocals`); import-path errors slip past local vitest runs.
- **biome** — run `getDiagnostics` to reproduce; never `npx biome` blindly.
- **vitest** — coverage gates are 75% lines / 70% branches / 75% functions.
- **property tests** — may pass locally and fail in CI on a different seed;
  pin the failing seed from the CI output.
- **Windows CI** — `stat.mode` asserts fail on NTFS; platform-guard them.

## Step 3: Reproduce Locally

Reproduce the failure with the equivalent bridge tool — `runTests`,
`getDiagnostics` (replaces tsc/eslint/biome) — NOT raw shell. Confirm you see
the same error before proposing anything.

## Step 4: Propose the Fix

If the failure is a genuine bug, follow the Bug Fix Protocol: write a failing
test first, then fix. If it is a flake (seed-dependent property test, etc.),
pin the seed or tighten the generator. Present the diff to the user for
approval before committing.

## Step 5: Report to User

Show: the failing job, the root-cause error, whether it reproduced locally, and
the proposed fix (or the failing test, if a fix needs approval first).
