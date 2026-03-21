## Installation

Copy this template to your Claude Desktop scheduled-tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/health-check
cp /path/to/claude-ide-bridge/templates/scheduled-tasks/health-check/SKILL.md \
   ~/.claude/scheduled-tasks/health-check/SKILL.md
```

Then restart Claude Desktop to detect the new scheduled task. Configure the schedule in Claude Desktop settings under "Scheduled Tasks".

> The bridge must be running when this task fires. Start it with `claude-ide-bridge --watch` or `npm run start-all`.

---
---
name: health-check
description: Comprehensive project health — tests, diagnostics, security, and git status. Run hourly or daily via Claude Desktop scheduled tasks.
---

# Project Health Check

Run a comprehensive health check covering all aspects of project quality.

## Steps

1. Call `getGitStatus` — branch, uncommitted changes, ahead/behind remote
2. Call `getDiagnostics` — all errors and warnings, grouped by file
3. Call `runTests` — full test suite with pass/fail/skip counts
4. Call `getSecurityAdvisories` — known vulnerabilities in dependencies
5. Call `auditDependencies` if available — package manager security audit

## Report Format

```
# Health Check — <date> <time>

## Git
Branch: <name>
Status: <clean | N uncommitted>
Remote: <up to date | N ahead, M behind>

## Diagnostics
Errors: N | Warnings: M
<file:line — message>  (list all errors, up to 20)

## Tests
Result: <N passed, M failed, K skipped> (Xs)
<failing test — reason>  (list all failures)

## Security
Advisories: <N critical, M high, K moderate | None>
<package — severity — title>  (list all)

## Overall: HEALTHY | DEGRADED | FAILING
<1-2 sentence summary>
```

## Grading Criteria

- **HEALTHY**: 0 errors, all tests pass, no critical/high advisories
- **DEGRADED**: warnings only, or moderate-severity advisories
- **FAILING**: any errors, test failures, or critical/high advisories

## Guidelines

- If `getSecurityAdvisories` or `auditDependencies` are unavailable, note "Security: not checked (tools unavailable)"
- For security advisories, report only HIGH and CRITICAL severity. Moderate/low can be logged but don't affect the grade.
- This runs unattended — no interactive prompts, no questions
- Keep the report structured and scannable
- Avoid emojis in automated reports for clarity.
