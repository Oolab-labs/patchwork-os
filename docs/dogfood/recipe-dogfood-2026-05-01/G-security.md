# Recipe Runner Security Audit — 2026-05-01 (G2)

**Bridge under test:** alpha.35 (PID 68045) on port 3101
**Scope:** `src/recipes/`, `src/recipesHttp.ts`, `src/recipeRoutes.ts`, `src/recipeOrchestration.ts`, `src/streamableHttp.ts`, `src/commands/recipeInstall.ts`, `src/commands/recipe.ts`
**Method:** code review + live exploit YAMLs in `/tmp/dogfood-G2/` + HTTP probing of running bridge

---

## Severity Ratings

| Sev | # | Items |
|---|---|---|
| CRITICAL | 3 | F-01 (file.* path traversal), F-02 (template-driven traversal), F-03 (no permissions enforcement at runtime) |
| HIGH | 4 | F-04 (chained recipe `recipe:` accepts arbitrary paths), F-05 (`/recipes/install` accepts arbitrary `https://`), F-06 (concurrent runs collide on output), F-07 (hasWriteSteps blind to chained sub-recipe writes) |
| MED | 3 | F-08 (request body unbounded), F-09 (`maxConcurrency` unbounded), F-10 (CLI `recipe run` accepts arbitrary path with no warning) |
| LOW | 2 | F-11 (templates serialize unscaped output), F-12 (recipe install secondary `master` retry on any failure) |
| INFO | 1 | F-13 (streamableHttp tools registration parity intact post-#71) |

---

## CRITICAL

### F-01 — `file.read`, `file.write`, `file.append` accept any absolute path; no jail, no symlink check, no null-byte filter

**File:** `src/recipes/tools/file.ts:12-99`
**Category:** Path Traversal / Sandbox Escape

`expandHome` in `src/recipes/tools/file.ts:12` only expands `~/` and returns. Then `file.write` (line 91-99) passes the result straight to `deps.writeFile`, which in `src/recipes/yamlRunner.ts:978-984` does `mkdirSync(path.dirname(abs), {recursive:true}); writeFileSync(abs, content);` with NO containment.

Compare against the IDE-tools jail in `src/tools/utils.ts:104-200` (`resolveFilePath`): null-byte rejection, workspace-relative resolution, symlink walk on every ancestor, hardlink nlink check, `path.realpathSync` revalidation, deny-by-default on EACCES. The recipe runner has none of these.

**Attack scenario:** Any user-installed recipe or any local YAML passed to `patchwork recipe run /path/to/foo.yaml` can write `~/.ssh/authorized_keys`, `~/.zshrc`, `~/Library/LaunchAgents/x.plist`, `/tmp/anything`, or read `/etc/passwd`.

**Live exploit (passed):**
```
patchwork recipe run /tmp/dogfood-G2/exploit-traversal.yaml
✓ exploit-traversal — 1 step(s)
  → /tmp/dogfood-G2/escaped-via-traversal-PWNED.txt
```
File written outside `~/.patchwork/`, no warning.

**Symlink test (passed):** `exploit-symlink.yaml` writes through `/tmp/dogfood-G2/symlink-target → /tmp/dogfood-G2/dummy-real` and lands in the real target. No symlink reject.

**Recommendation:**
- Introduce `resolveRecipePath(p, {jailRoot, write})` reusing `cachedRealpathSync`-style ancestor walk from `src/tools/utils.ts:130-177`.
- Default jail roots: `~/.patchwork/`, `os.tmpdir()/patchwork-*`, plus the workspace passed to the bridge (`process.cwd()` or `--workspace`).
- Reject null bytes in path string.
- Reject `path.isAbsolute(p)` if `p` is outside jail roots after `path.resolve`.
- Reject `lstatSync(p).nlink > 1` on writes (hardlink escape, same as `resolveFilePath` opts.write).
- Apply to all three of `file.read`, `file.write`, `file.append` and to the default `readFile/writeFile/appendFile` in `yamlRunner.ts:976-994`.

---

### F-02 — Template-resolved `{{var}}` substitution into `path:` lets a recipe consumer write anywhere

**File:** `src/recipes/tools/file.ts:91-99` and `src/recipes/yamlRunner.ts:641-643`
**Category:** Path Traversal via Template Substitution

After F-01, the path is rendered through `render(step.path, ctx)` (yamlRunner.ts:642) where `ctx` includes `vars` supplied by the caller (`--var` on CLI, `vars` field in HTTP body). The rendered string is passed un-validated to `expandHome` then to `writeFile`.

**Live exploit (passed):**
```
patchwork recipe run /tmp/dogfood-G2/exploit-template-traversal.yaml \
  --var "target=../../../../tmp/dogfood-G2/templated-traversal-PWNED.txt"
✓ exploit-template-traversal — 1 step(s)
  → ~/.patchwork/inbox/../../../../tmp/dogfood-G2/templated-traversal-PWNED.txt
```
Despite the recipe locking `path: ~/.patchwork/inbox/{{target}}`, a `--var` consumer escapes via `..` segments. **The dotted prefix is preserved literally and only resolved by the OS when `mkdirSync(recursive:true)` walks it.**

**Attack scenario:** A user installs a benign-looking recipe with `path: ~/.patchwork/inbox/{{filename}}.md` and triggers it via dashboard "Run" with `vars: {filename: "../../../etc/passwd-overwrite"}`. The HTTP endpoint accepts the vars (`recipeRoutes.ts:131-138` does no key/value validation) and writes anywhere.

**Recommendation:**
- After template render, re-validate the resolved path against the same jail introduced in F-01.
- Reject any rendered path containing `..`, `\0`, or that doesn't `path.normalize` to a child of one of the allowed roots.
- Strip and warn (not error) if the rendered path was substantially different from the literal — defense in depth.
- In `recipeRoutes.ts:131-138`, validate each var value is a non-control-char string ≤ 1 KB before forwarding to `runRecipeFn`.

---

### F-03 — `*.permissions.json` sidecar is a write-once suggestion file; runtime never reads it

**File:** `src/recipes/installer.ts:91-98`, consumer absent
**Category:** Broken Access Control / Permissions Model

`runRecipeInstall` writes `<entry>.permissions.json` from `compiledRecipe.suggestedPermissions`. This file is intended to be merged into `~/.claude/settings.json` for Claude Code's permission system. Audit-wide grep for `permissions.json` shows ZERO runtime read paths in the recipe runner — only listInstalledRecipes uses it for a `hasPermissions` boolean badge, and `deleteRecipeContent` removes it as a sidecar.

`greet.json.permissions.json` is `{permissions:{allow:[],ask:[],deny:[]}}` — the `deny` array is never consulted by any code in the runtime path.

**Attack scenario:** Operator audits `~/.patchwork/recipes/dangerous-recipe.permissions.json` and sees `deny: ["Bash(*)"]`. Runs the recipe believing the deny list will block `tool: file.write` to `/etc/passwd`. It does not — `executeTool` in `toolRegistry.ts:109-121` only checks the global `kill-switch.writes` flag.

**Recommendation:**
- Either:
  - (a) Remove the sidecar entirely + delete the install-time write — it creates a false sense of safety.
  - (b) Implement an enforcement layer in `executeTool` (`src/recipes/toolRegistry.ts:109`): load `<recipe>.permissions.json` once per run, build matchers, check `tool.id` against deny → block, ask → require approval-queue token, allow → proceed. Default-deny on `ask` when there's no human approver.
- Document publicly which mode applies. The current undocumented behavior is "the file is decorative."

---

## HIGH

### F-04 — Chained recipes' `recipe:` field accepts arbitrary absolute paths and `..` traversal

**File:** `src/recipes/yamlRunner.ts:1284-1303`
**Category:** Sandbox Escape / Recipe Injection

`loadNestedRecipe` accepts `pathLike` names if they include `/`, `\`, or `.yaml`. `path.resolve` against parent dir is done but no jail. So a recipe in `~/.patchwork/recipes/` can `recipe: /tmp/x.yaml` or `recipe: ../../../etc/something.yaml` and run it.

**Live exploit (passed):** `outer-chained.yaml` referenced `recipe: /tmp/dogfood-G2/inner-write.yaml`; chained runner loaded and executed it; inner recipe wrote outside `~/.patchwork/`.

**Recommendation:** Constrain `loadNestedRecipe` to:
- `~/.patchwork/recipes/<basename>` (already supported), OR
- A path under `path.dirname(parentSourcePath)` (already supported, but should be the ONLY non-named branch), OR
- A bundled-templates path under the install dir.
Reject any name that resolves outside these three roots.

---

### F-05 — `/recipes/install` accepts arbitrary `https://` URLs with no host allowlist

**File:** `src/recipeRoutes.ts:619-635`
**Category:** SSRF / Supply-chain Bypass

```js
} else if (source.startsWith("https://")) {
  fetchUrl = source;
  ...
}
```
No domain check. The bridge runs as the user, so `fetch(fetchUrl)` reaches anywhere DNS resolves — including `https://[::1]:port/`, `https://internal-ec2-metadata.fake/`, or attacker-controlled hosts. The fetched YAML goes through `installRecipeFromFile` and lands in `~/.patchwork/recipes/`.

The CLI path (`commands/recipeInstall.ts`) is constrained to `github.com` — only the HTTP route is loose.

**Attack scenario:** Any cross-site request from an attacker-controlled origin that triggers a CSRF on the bridge could install a malicious recipe (note: bearer-auth blocks unauthenticated CSRF, so this is actually downgraded if the attacker doesn't have the token; remains real if the token leaks).

**Recommendation:**
- Match the CLI behavior: only accept `https://github.com/...` or `https://raw.githubusercontent.com/...` URLs.
- Reject DNS-resolved hosts that hit private/loopback ranges (reuse the SSRF defense from `sendHttpRequest` in `src/tools/sendHttpRequest.ts`).
- Add a max content-length check (currently the response body is unbounded — second-order DoS).

---

### F-06 — Concurrent runs of the same recipe collide on output file with no lock

**File:** `src/recipes/yamlRunner.ts:978-984` (writeFile default), no lock
**Category:** Race Condition / Data Integrity

Two concurrent `POST /recipes/daily-status/run` returned distinct `taskId`s within the same millisecond (run-A, run-B). Both targeted `~/.patchwork/inbox/daily-status-2026-05-01.md`. Last-writer-wins. No advisory lock, no temp-then-rename, no run-id suffix.

**Live test:** `runs?recipe=daily-status&limit=10` shows seq 3266 + 3268 both `done` with same target. (Both succeeded; first write was overwritten — outputs are similar, masking the issue.)

**Attack scenario:** A scheduled recipe writing financial data to `~/.patchwork/inbox/report.md` is fired manually while the cron job runs. Manual partial output overwrites cron's complete output, or vice versa.

**Recommendation:**
- In `yamlRunner.ts` writeFile default, use `tmpFile + renameSync` for atomicity, OR
- Introduce a per-recipe-name advisory lock using `src/fileLock.ts` so concurrent runs serialize, OR
- Append run-id to default output paths (preserves both runs).
- At minimum, reject a second concurrent run of the same recipe and return 409 — `runRecipeFn` should track inflight by name.

---

### F-07 — `hasWriteSteps` blind to chained sub-recipe writes

**File:** `src/commands/recipe.ts:803-822` (early return on `step.type !== "tool"`)
**Category:** Misclassification / UI Trust Erosion

`enrichStepFromRegistry` returns the step unchanged when `step.type === "recipe"`. `summarizePlanSteps` then sees no `isWrite=true` and reports `hasWriteSteps: false`. The dashboard `/runs/:seq/page.tsx:417` shows "has writes" pill conditionally on this flag.

The dashboard does NOT use `hasWriteSteps` as an actual approval gate (it's display-only) — but the field is part of the public dry-plan schema and any third-party tool reading it for safety decisions will be misled.

**Recommendation:**
- For `step.type === "recipe"`, recursively load the nested recipe via `loadNestedRecipe` and aggregate `hasWriteSteps` up.
- Cap recursion at `recipe.maxDepth` (default 3) to avoid pathological cycles during planning.
- Surface in lint output: `Step "X" calls recipe "Y" which performs writes — caller flagged.`

---

## MED

### F-08 — `POST /recipes/:name/run` body has no size cap

**File:** `src/recipeRoutes.ts:122-160`
**Category:** DoS

```js
req.on("data", (c: Buffer) => chunks.push(c));
req.on("end", () => { const body = Buffer.concat(chunks).toString("utf-8"); ... });
```
No `req.socket.bytesRead` check, no max-body. A 10 MB POST is buffered fully before parse. Same pattern in `/recipes/run`, `/recipes` (POST), `/recipes/:name` (PUT/PATCH), `/recipes/lint`.

**Recommendation:** Add a 1 MB cap on accumulated `chunks` length and `req.destroy()` past the limit. Apply uniformly in a `readJsonBody(req, max)` helper used by every route here.

---

### F-09 — Recipe `maxConcurrency` field has no upper bound

**File:** `src/recipes/yamlRunner.ts:1371`, `src/recipes/replayRun.ts:111`
**Category:** Resource Exhaustion / DoS

`chainedRecipe.maxConcurrency ?? 4` — but a recipe author can supply `maxConcurrency: 10000`. `dependencyGraph.ts:211` (`while (executing.length < options.maxConcurrency && queue.length > 0) executing.push(...)`) will spawn up to that many concurrent step executions, including LLM calls.

`validation.ts` does not constrain the field.

**Recommendation:** Clamp to `Math.min(maxConcurrency ?? 4, 16)` in `chainedRunner.generateExecutionPlan`. Add a `validation.ts` lint warning if the recipe declares >16. Document the cap.

---

### F-10 — CLI `recipe run <path>` accepts arbitrary YAML with no warning

**File:** `src/commands/recipe.ts:1080-1102`
**Category:** Defense-in-Depth

`resolveRecipePath` accepts any file at `resolve(recipeRef)` if it exists and is a file. So `patchwork recipe run /tmp/x.yaml` works. Combined with F-01/F-02, this is the easiest path to exploit. Mitigated by being CLI-only (assumed-trusted invocation), but worth a flag — at minimum, print `WARN: running recipe outside ~/.patchwork/recipes/` so operators see the unusual case.

**Recommendation:** Print a one-line warning when `recipePath` is outside `~/.patchwork/recipes/` and the bundled templates dir.

---

## LOW

### F-11 — Templates serialize objects via `JSON.stringify`; no shell-meta escaping

**File:** `src/recipes/templateEngine.ts:228-231`
**Category:** Defense-in-Depth

Result strings are inlined verbatim into rendered `path:`, `content:`, `prompt:` fields. No shell-spawning recipe tool consumes templated input directly via shell — `defaultClaudeCodeFn` (`yamlRunner.ts:1074`) and `spawnSync` git calls (`yamlRunner.ts:884, 935`) all use args-array form. So this is not currently exploitable, but if any future recipe tool spawns a shell with templated input, this becomes a CRITICAL command injection.

**Recommendation:** Document the contract: "rendered templates may contain arbitrary user input — never pass to a shell, child_process with `shell:true`, or eval." Add a lint rule that flags any new tool importing `child_process` and using `params` directly.

---

### F-12 — `stageGitHubSource` falls back to `master` on any failure

**File:** `src/commands/recipeInstall.ts:464-484`
**Category:** Logic Smell

If `main` fetch throws for any reason (rate limit, transient 502, network), the code retries with `master` — even when the user explicitly pinned a different ref via `gh:owner/repo@v1.2`. Read the code: the fallback only fires when `ref === "main"`, so an explicit ref isn't overridden. Confirmed safe. Lower than first thought, retain as INFO. (Actually safe — keeping as documentation.)

---

## INFO

### F-13 — Streamable-HTTP `registerAllTools` parity intact

**File:** `src/streamableHttp.ts:795-832` vs `src/bridge.ts:394-421`
**Category:** Configuration

Round-1 Agent A reported `streamableHttp.ts:679` truncated the call. Current alpha.35 source shows both call sites pass the full 18-arg list (transport, config, openedFiles, probes, extensionClient, activityLog, terminalPrefix, fileLock, sessions, orchestrator, sessionId, pluginTools, automationHooks, getDisconnectInfo, onContextCacheUpdated, getExtensionDisconnectCount, commitIssueLinkLog, recipeRunLog, decisionTraceLog). PR #71 fix verified intact. `ctxSaveTrace`, `ctxQueryTraces`, recipe-aware tools register identically for WebSocket and HTTP transports.

---

## Auth Posture (Verified Live)

All recipe HTTP routes properly enforced bearer-auth — verified live:

| Route | no auth | wrong token | empty Bearer | valid token |
|---|---|---|---|---|
| `GET /recipes` | 401 | 401 | 401 | 200 |
| `POST /recipes/foo/run` | 401 | — | — | — |
| `DELETE /recipes/foo` | 401 | — | — | — |
| `PUT /recipes/foo` | 401 | — | — | — |
| `POST /recipes/lint` | 401 | — | — | — |
| `POST /runs/1/replay` | 401 | — | — | — |
| `GET /runs` | 401 | — | — | — |

Bearer-auth gate at `src/server.ts:504-543` runs BEFORE `tryHandleRecipeRoute` (line 864). Token comparison uses `timingSafeTokenCompare`. RFC 6750 `WWW-Authenticate` realm correct. `?token=` query param removed (per inline comment line 513-515). Solid.

---

## Remediation Checklist (file:line ordered)

| Pri | File:line | Fix |
|---|---|---|
| P0 | `src/recipes/tools/file.ts:50-145` | Replace `expandHome(p)` with `resolveRecipePath(p, {jailRoots:[~/.patchwork, tmpdir, workspace], write})`. Reject null bytes, symlinks escaping jail, hardlinks (nlink>1) on writes. |
| P0 | `src/recipes/yamlRunner.ts:976-994` | Apply same jail in default `readFile`/`writeFile`/`appendFile`. Don't bypass the tool-level check at the dep injection layer. |
| P0 | `src/recipes/yamlRunner.ts:642` | After `render(step.path, ctx)`, re-validate the rendered path against the jail. |
| P0 | `src/recipeRoutes.ts:131-138`, `:172-181` | Validate `vars` keys/values: keys match `/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`, values are control-char-free strings ≤ 1 KB. |
| P0 | `src/recipes/installer.ts:91-98` + `src/recipes/toolRegistry.ts:109` | Either delete the `*.permissions.json` sidecar OR enforce it at `executeTool`: load deny/ask, match `tool.id`, default-deny on `ask` without an approver. |
| P1 | `src/recipes/yamlRunner.ts:1284-1303` | `loadNestedRecipe` must reject paths outside `~/.patchwork/recipes/` and the parent recipe's directory. |
| P1 | `src/recipeRoutes.ts:619-635` | Allowlist `https://github.com` and `https://raw.githubusercontent.com` only. Add SSRF guard via `dns.resolve` pre-fetch. Cap response body size. |
| P1 | `src/recipes/yamlRunner.ts:978-984` | Atomic write via `writeFileSync(tmp); renameSync(tmp, target)`, OR per-recipe advisory lock via `src/fileLock.ts`. |
| P1 | `src/commands/recipe.ts:803-822` | When `step.type === "recipe"`, recurse into nested recipe (capped at `maxDepth`) to bubble up `isWrite`. |
| P2 | `src/recipeRoutes.ts:122-160` and similar | Add `readJsonBody(req, maxBytes=1_048_576)` helper; replace all 6 `Buffer.concat(chunks)` accumulators. |
| P2 | `src/recipes/chainedRunner.ts:772`, `src/recipes/replayRun.ts:111` | Clamp `maxConcurrency` to `Math.min(value ?? 4, 16)`. Add a lint warning in `validation.ts` for >16. |
| P2 | `src/commands/recipe.ts:1080-1102` | Print warning when running a recipe outside `~/.patchwork/recipes/`. |
| P3 | (docs) | Document template contract: rendered values may contain arbitrary input; never pass to `shell:true` or `eval`. |

---

## Live Exploit Cleanup

The following files were created during testing and removed before completing this report:
- `/tmp/dogfood-G2/escaped-via-traversal-PWNED.txt` — removed
- `/tmp/dogfood-G2/templated-traversal-PWNED.txt` — removed
- `/tmp/dogfood-G2/fake-authorized_keys-PWNED` — removed
- `/tmp/dogfood-G2/chained-bypass-PWNED.txt` — removed
- `/tmp/dogfood-G2/symlink-target` (symlink) and `/tmp/dogfood-G2/dummy-real/` — removed

The exploit YAML proofs remain in `/tmp/dogfood-G2/` for re-verification:
`exploit-traversal.yaml`, `exploit-symlink.yaml`, `exploit-template-traversal.yaml`, `exploit-ssh-overwrite.yaml`, `inner-write.yaml`, `outer-chained.yaml`.
