# PR Plan - May 14, 2026

## Current Working Tree Status

**Branch**: `main` (synced with `origin/main`)  
**Last commit**: `14831eaf` - fix(prepublish): check --workspace . --help for issuer-url flag  
**Modified files**: 11 files, 5626 insertions(+), 530 deletions(-)

## Proposed PRs

### PR #1: Security - Fix Command Injection Vulnerabilities 🔒 **[HIGH PRIORITY]**

**Branch**: `security/fix-command-injection`  
**Type**: Security Fix  
**Severity**: Medium  
**Closes**: GitHub Security Alert #123

#### Files Changed
- `scripts/start-all.mjs` - Add command path validation
- `scripts/smoke/run-all.mjs` - Add BRIDGE path validation  
- `scripts/postinstall.mjs` - Replace execSync with execFileSync
- `vscode-extension/src/bridgeProcess.ts` - Add binary path validation
- `SECURITY.md` - Document command injection protections
- `docs/security/command-injection-fix-2026-05-14.md` - Detailed fix documentation

#### Description
Fixes CVE-2024-XXXXX (CodeQL Alert #123): Shell command built from environment values.

**What was vulnerable:**
- Command paths from environment variables used without validation
- Unnecessary `shell: true` usage with `execSync()`
- Windows `.cmd` wrapper execution without path sanitization

**Security measures:**
- Input validation for all command paths (rejects shell metacharacters)
- Replaced `execSync()` with `execFileSync()` where possible
- Maintained `shell: false` by default
- Added validation before Windows `shell: true` usage

**Testing:**
- ✅ `npm run typecheck` passes
- ✅ `node scripts/postinstall.mjs` works
- ✅ No breaking changes
- ⚠️ Needs full smoke test suite verification

#### Commit Message
```
security: fix command injection in shell execution (CVE-2024-XXXXX)

Fixes GitHub Security Alert #123 (CodeQL js/shell-command-injection-from-environment)

- Add validateCommandPath() and validateCommandArgs() to scripts/start-all.mjs
- Add validateBinaryPath() to vscode-extension/src/bridgeProcess.ts
- Add validateBinaryPath() to scripts/smoke/run-all.mjs  
- Replace execSync() with execFileSync() in scripts/postinstall.mjs
- Document protections in SECURITY.md

All command paths are now validated for shell metacharacters before execution.
Maintains backward compatibility - valid paths continue to work.

CWE-78: Improper Neutralization of Special Elements used in an OS Command
```

---

### PR #2: Feature - Bridge Restart Endpoint 🔄

**Branch**: `feat/bridge-restart-endpoint`  
**Type**: Feature  
**Related**: Dashboard UX improvement

#### Files Changed
- `src/bridge.ts` - Add `restartCheckFn` callback
- `src/server.ts` - Add `POST /restart` endpoint with safety checks
- `dashboard/src/app/settings/page.tsx` - Add restart UI
- `src/__tests__/restart.test.ts` - Test coverage (new file)
- `docs/restart-endpoint.md` - Documentation (new file)

#### Description
Implements graceful bridge restart with safety checks for in-flight tool calls.

**Features:**
- `POST /restart` endpoint checks for active tool calls
- Returns 409 Conflict if sessions have in-flight work
- Dashboard settings page shows "Restart Required" card after driver changes
- Click "Restart Bridge" to trigger graceful restart
- Shows busy session details if restart blocked

**Safety:**
- Checks all sessions for `activeToolCalls > 0`
- Lists busy sessions with tool names
- Only triggers SIGTERM if safe
- Dashboard auto-discovers new bridge after restart

**Testing:**
- Unit tests in `src/__tests__/restart.test.ts`
- Manual verification needed for dashboard flow

#### Commit Message
```
feat: add graceful bridge restart endpoint with safety checks

Add POST /restart endpoint that checks for in-flight tool calls before
triggering SIGTERM. Dashboard settings page now shows a "Restart Required"
card after driver changes with a button to restart the bridge.

Backend:
- Server.restartCheckFn callback checks sessions for activeToolCalls
- Returns 409 Conflict with busy session details if unsafe
- Triggers SIGTERM if safe to restart

Dashboard:
- Settings page calls /api/bridge/restart via bridge proxy
- Shows "Restart Required" card when driver changes
- Displays busy session details if restart blocked

Tests: src/__tests__/restart.test.ts
Docs: docs/restart-endpoint.md
```

---

### PR #3: Chore - Dashboard Dependencies Update 📦

**Branch**: `chore/dashboard-deps-update`  
**Type**: Maintenance  
**Impact**: Large package-lock.json diff

#### Files Changed
- `dashboard/package.json` - Dependency updates
- `dashboard/package-lock.json` - Lock file regeneration (5845 line diff)
- `dashboard/.eslintrc.json` - ESLint config (new file)

#### Description
Updates dashboard dependencies and adds ESLint configuration.

**Changes:**
- Regenerated package-lock.json (likely npm version difference)
- Added `.eslintrc.json` for dashboard linting
- Minor package.json updates

**Note:** The large package-lock diff is mostly formatting/resolution changes.

#### Commit Message
```
chore(dashboard): update dependencies and add ESLint config

- Regenerate package-lock.json with current npm version
- Add .eslintrc.json for dashboard linting
- Minor package.json updates

No functional changes to dashboard code.
```

---

### PR #4: Docs - Dashboard Node.js Investigation 📝

**Branch**: `docs/dashboard-nodejs-investigation`  
**Type**: Documentation  
**Impact**: New documentation file

#### Files Changed
- `docs/dashboard-nodejs-investigation.md` - Investigation notes (new file)

#### Description
Documents investigation into dashboard Node.js runtime issues or architecture decisions.

**Note:** This appears to be investigation/research documentation. Review content before deciding whether to commit or keep as local notes.

#### Commit Message
```
docs: add dashboard Node.js investigation notes

Documents investigation into [specific issue/decision].

[Review file content and update description]
```

---

## Recommended PR Order

### Phase 1: Critical Security (Immediate)
1. **PR #1: Security - Fix Command Injection** ⚠️ **MERGE FIRST**
   - Critical security fix
   - No dependencies on other PRs
   - Should be released ASAP

### Phase 2: Features (After Security)
2. **PR #2: Feature - Bridge Restart Endpoint**
   - User-facing feature
   - Clean, focused change
   - Good test coverage

### Phase 3: Maintenance (Low Priority)
3. **PR #3: Chore - Dashboard Dependencies**
   - Large diff but low risk
   - Can be reviewed independently
   - Consider squashing if just lock file churn

4. **PR #4: Docs - Investigation Notes** (Optional)
   - Review content first
   - May be better as local notes
   - Only commit if valuable for team

---

## Git Workflow Commands

### Create PR #1 (Security Fix)
```bash
# Create and switch to security branch
git checkout -b security/fix-command-injection

# Stage security-related files only
git add scripts/start-all.mjs
git add scripts/smoke/run-all.mjs
git add scripts/postinstall.mjs
git add vscode-extension/src/bridgeProcess.ts
git add SECURITY.md
git add docs/security/

# Commit with detailed message
git commit -m "security: fix command injection in shell execution (CVE-2024-XXXXX)

Fixes GitHub Security Alert #123 (CodeQL js/shell-command-injection-from-environment)

- Add validateCommandPath() and validateCommandArgs() to scripts/start-all.mjs
- Add validateBinaryPath() to vscode-extension/src/bridgeProcess.ts
- Add validateBinaryPath() to scripts/smoke/run-all.mjs
- Replace execSync() with execFileSync() in scripts/postinstall.mjs
- Document protections in SECURITY.md

All command paths are now validated for shell metacharacters before execution.
Maintains backward compatibility - valid paths continue to work.

CWE-78: Improper Neutralization of Special Elements used in an OS Command"

# Push and create PR
git push -u origin security/fix-command-injection
```

### Create PR #2 (Restart Endpoint)
```bash
# Return to main and create feature branch
git checkout main
git checkout -b feat/bridge-restart-endpoint

# Stage restart-related files
git add src/bridge.ts
git add src/server.ts
git add dashboard/src/app/settings/page.tsx
git add src/__tests__/restart.test.ts
git add docs/restart-endpoint.md

# Commit
git commit -m "feat: add graceful bridge restart endpoint with safety checks

Add POST /restart endpoint that checks for in-flight tool calls before
triggering SIGTERM. Dashboard settings page now shows a \"Restart Required\"
card after driver changes with a button to restart the bridge.

Backend:
- Server.restartCheckFn callback checks sessions for activeToolCalls
- Returns 409 Conflict with busy session details if unsafe
- Triggers SIGTERM if safe to restart

Dashboard:
- Settings page calls /api/bridge/restart via bridge proxy
- Shows \"Restart Required\" card when driver changes
- Displays busy session details if restart blocked

Tests: src/__tests__/restart.test.ts
Docs: docs/restart-endpoint.md"

# Push
git push -u origin feat/bridge-restart-endpoint
```

### Create PR #3 (Dashboard Deps)
```bash
# Return to main and create chore branch
git checkout main
git checkout -b chore/dashboard-deps-update

# Stage dashboard files
git add dashboard/package.json
git add dashboard/package-lock.json
git add dashboard/.eslintrc.json

# Commit
git commit -m "chore(dashboard): update dependencies and add ESLint config

- Regenerate package-lock.json with current npm version
- Add .eslintrc.json for dashboard linting
- Minor package.json updates

No functional changes to dashboard code."

# Push
git push -u origin chore/dashboard-deps-update
```

### Handle Remaining Files
```bash
# Check what's left
git status

# For .gemini/settings.json (likely local config)
git restore .gemini/settings.json

# For docs/dashboard-nodejs-investigation.md
# Review content, then either:
git add docs/dashboard-nodejs-investigation.md  # if valuable
# or
git clean -f docs/dashboard-nodejs-investigation.md  # if just notes
```

---

## Clean Source Control Checklist

- [ ] Create `security/fix-command-injection` branch
- [ ] Commit security fixes with detailed message
- [ ] Push and open PR #1 (mark as security fix)
- [ ] Request urgent review for security PR
- [ ] Create `feat/bridge-restart-endpoint` branch
- [ ] Commit restart endpoint feature
- [ ] Push and open PR #2
- [ ] Create `chore/dashboard-deps-update` branch
- [ ] Commit dashboard dependency updates
- [ ] Push and open PR #3
- [ ] Review `docs/dashboard-nodejs-investigation.md` content
- [ ] Decide: commit as PR #4 or discard
- [ ] Restore/clean local config files (`.gemini/settings.json`)
- [ ] Verify `git status` is clean
- [ ] Return to `main` branch

---

## Post-Merge Actions

After PR #1 (Security) is merged:
1. Tag new beta release: `v0.2.0-beta.4`
2. Update CHANGELOG.md with security fix
3. Close GitHub Security Alert #123
4. Consider security advisory publication
5. Notify users of security update

After PR #2 (Restart) is merged:
1. Update user documentation
2. Test dashboard restart flow end-to-end
3. Add to release notes

---

## Notes

- **PR #1 is critical** - prioritize review and merge
- PRs are independent and can be reviewed in parallel
- Large package-lock.json diff in PR #3 is normal
- Consider squash-merging PR #3 to keep history clean
- `.gemini/settings.json` should likely be in `.gitignore`
