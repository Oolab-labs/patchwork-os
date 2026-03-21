## Installation

Copy this template to your Claude Desktop scheduled-tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/dependency-audit
cp /path/to/claude-ide-bridge/templates/scheduled-tasks/dependency-audit/SKILL.md \
   ~/.claude/scheduled-tasks/dependency-audit/SKILL.md
```

Then restart Claude Desktop to detect the new scheduled task. Configure the schedule in Claude Desktop settings under "Scheduled Tasks".

> The bridge must be running when this task fires. Start it with `claude-ide-bridge --watch` or `npm run start-all`.

> **Emergency stop**: Set `CLAUDE_CODE_DISABLE_CRON=1` in your environment to immediately halt all scheduled cron jobs mid-session. Useful if a task runs amok or you need to suppress scheduled runs temporarily.

---
---
name: dependency-audit
description: Scan dependencies for security vulnerabilities and outdated packages. Run weekly via Claude Desktop scheduled tasks.
---

# Dependency Security Audit

Scan all project dependencies for known security vulnerabilities.

## Steps

1. Call `getProjectInfo` to detect the project type and package manager
2. Call `getSecurityAdvisories` to check for known CVEs in dependencies
3. Call `auditDependencies` to run the package manager's native audit (npm audit, cargo audit, pip-audit, etc.)
4. Call `getDependencyTree` to understand the full dependency graph for any flagged packages

## Report Format

```
# Dependency Audit — <date>

## Package Manager: <npm|cargo|pip|go>

## Vulnerabilities Found: <N total>

### Critical (N)
<package@version — CVE-XXXX-XXXXX — description>
  Fix: upgrade to <version> | No fix available

### High (N)
<package@version — CVE-XXXX-XXXXX — description>
  Fix: upgrade to <version> | No fix available

### Moderate (N)
<package@version — description>

## Outdated Packages
<package — current → latest>  (only packages ≥1 major version OR ≥3 minor versions behind)
Direct: listed in package.json. Transitive: pulled in by direct dependencies.

## Recommended Actions
1. <specific upgrade command or action>
2. <specific upgrade command or action>

## Overall: SECURE | REVIEW NEEDED | ACTION REQUIRED
```

## Grading Criteria

- **SECURE** — 0 vulnerabilities + ≤2 patch-level outdated packages
- **REVIEW NEEDED** — 1-2 moderate advisories OR ≥3 outdated packages
- **ACTION REQUIRED** — any critical/high vulnerability

## Guidelines

- Focus on actionable findings — skip informational-only advisories
- Report only packages ≥1 major version OR ≥3 minor versions behind as "outdated"
- Direct dependencies: listed in package.json. Transitive: pulled in by direct dependencies. Flag transitive dependencies separately.
- For each vulnerability, include the fix command if one exists (e.g., `npm install package@version`)
- If no vulnerabilities found, report "All clear — 0 vulnerabilities across N dependencies"
