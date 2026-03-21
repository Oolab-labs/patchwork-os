## Installation

Copy this template to your Claude Desktop scheduled-tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/dependency-audit
cp /path/to/claude-ide-bridge/templates/scheduled-tasks/dependency-audit/SKILL.md \
   ~/.claude/scheduled-tasks/dependency-audit/SKILL.md
```

Then restart Claude Desktop to detect the new scheduled task. Configure the schedule in Claude Desktop settings under "Scheduled Tasks".

> The bridge must be running when this task fires. Start it with `claude-ide-bridge --watch` or `npm run start-all`.

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
<package — current → latest>  (only if significantly behind)

## Recommended Actions
1. <specific upgrade command or action>
2. <specific upgrade command or action>

## Overall: SECURE | REVIEW NEEDED | ACTION REQUIRED
```

## Guidelines

- Focus on actionable findings — skip informational-only advisories
- For each vulnerability, include the fix command if one exists (e.g., `npm install package@version`)
- If no vulnerabilities found, report "All clear — 0 vulnerabilities across N dependencies"
- Flag transitive dependencies separately from direct dependencies
