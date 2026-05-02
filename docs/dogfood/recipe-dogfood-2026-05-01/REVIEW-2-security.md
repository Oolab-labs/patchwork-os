# REVIEW-2 — Security review of PLAN-A-security.md

Read-only review. No source/plan files modified. Cite-keys against alpha.35 tree (HEAD `8f90817`). Companion to `PLAN-A-security.md`. Findings are gaps in the **plan**, not in the code (the code gaps are already enumerated in `G-security.md` / `F-tools.md` / `H-http-routes.md`).

Severity scale: CRITICAL / HIGH / MED / LOW / INFO.

---

## Executive summary

PLAN-A is structurally sound. The five-PR sequencing closes the named bugs. But the plan has **three CRITICAL gaps** that would let an attacker bypass the intended mitigation entirely, **two HIGH gaps** that leave residual exploits, and **a handful of MED issues** around durability and testing scope.

The plan also under-specifies several validation rules (e.g. `vars` schema, allowlist regex, body-cap for lint) — every under-specified rule is a future ratchet bug.

Top-line: **PR-1 + PR-2 + PR-3 each need amendment before they're safe to ship.** PR-4 (Option B) and PR-5 are fine.

---

## CRITICAL findings

### C-1 — Third template-substitution site is uncovered: chained-runner `resolveStepTemplates` → `executeTool`
**Bypass scenario.** The plan (PLAN-A §1, PR-1 "Approach", and §1 PR-1 file list line `yamlRunner.ts:642 — re-validate render(step.path, ctx)`) addresses two render points: yamlRunner template substitution and `vars` HTTP entry. It does NOT address the chained-runner path (`src/recipes/chainedRunner.ts:158-210`), which is its own template engine.

`resolveStepTemplates` (chainedRunner.ts:166-210) iterates over keys NOT in `STEP_META_KEYS` and runs each user-supplied string through `compileTemplate`. `path` is **not** in `STEP_META_KEYS` (chainedRunner.ts:170-186 — set is `{id, tool, agent, recipe, chain, awaits, when, output, risk, optional, vars, transform, retry, retryDelay, parallel}`). So a chained tool step `tool: file.write, path: "{{user_var}}"` has `path` resolved by `compileTemplate.evaluate(context)` (chainedRunner.ts:194-205), then dispatched to `executeTool(step.tool, resolved)` (chainedRunner.ts:456) where `resolved` has the substituted string.

The plan relies on the file.ts tool layer's jail to catch these (PLAN-A §1 PR-1 "Apply at the tool layer (`file.ts`) AND at the dep-injection defaults"). That works — **provided the file.ts jail is the floor**. But the plan also says the yamlRunner re-validation at line 642 is "defense in depth" — the chained path has no equivalent re-validation. So if a future regression weakens the file.ts check (e.g. an `agent` step dispatches `deps.writeFile` directly, which the plan itself notes as a future risk), the chained path has zero defense.

**Evidence.**
- `src/recipes/chainedRunner.ts:170-186` — STEP_META_KEYS excludes `path`
- `src/recipes/chainedRunner.ts:194-205` — template substitution into `resolved[key]`
- `src/recipes/chainedRunner.ts:456` — `executeTool(step.tool, resolved)`
- `src/recipes/yamlRunner.ts:1252-1262` — chained `executeTool` flows back through `executeStep` with `ctx={}` (no second render — confirming the rendered value reaches file.ts as-is)
- PLAN-A line 35 mentions `yamlRunner.ts:642` only

**Recommended amendment.** PR-1 must additionally jail the path at one of: (a) the chained dispatch site `chainedRunner.ts:456` before `executeTool` is called for `step.tool === "file.read|write|append"`; or (b) the chained `buildChainedDeps.executeTool` wrapper in `yamlRunner.ts:1252`. Option (b) is one line and matches the file.ts injection point. The plan should explicitly enumerate **three** template-substitution sites: yamlRunner.ts:452 (agent prompt), yamlRunner.ts:642 (file path render), chainedRunner.ts:194-205 (chained tool params).

### C-2 — `resolveFilePath` (the existing helper at `src/tools/utils.ts:104-200`) is NOT a drop-in for the recipe runner — plan correctly notes it but the resulting new helper inherits the **wrong default jail set** for the dep-injection layer
**Bypass scenario.** PLAN-A §1 PR-1 "Approach" says "Build `resolveRecipePath(p, opts)` that wraps the existing `cachedRealpathSync` ancestor-walk pattern from `src/tools/utils.ts:130-177` but accepts a list of jail roots." Default roots in plan: `homedir()/.patchwork`, `os.tmpdir()`, `opts.workspace`. Then PLAN-A says: "Apply at the tool layer (`file.ts`) AND at the dep-injection defaults in `yamlRunner.ts:976-994`."

`resolveFilePath` checks ONLY workspace containment (`src/tools/utils.ts:118-128`). The plan acknowledges this and proposes a NEW helper. Good. **But the default jail set is dangerously inclusive.**

`os.tmpdir()` on macOS is `/var/folders/.../T/` — single-user. On Linux `/tmp` is **shared across all users**. PLAN-A line 254 acknowledges this is a regression concern but defaults to "always include `/tmp`."

In a dogfood / dev environment this is benign. On a Pro-relay-hosted bridge or any multi-tenant deployment, **`/tmp` as a default jail root means recipe A can write to a path recipe B reads from**, defeating tenant isolation. The plan's "default plan: always" is not safe for the project's stated remote-deployment direction (CLAUDE.md "Remote Deployment" section + memory note `project_phase2_shipped.md` mentioning Pro relay hosting).

**Evidence.**
- `src/tools/utils.ts:118-128` — single-workspace check
- PLAN-A line 254 — open question 3 acknowledges /tmp risk, defaults to always-on
- PLAN-A line 36 — applies new jail to recipeRoutes — but jail roots set globally
- `CLAUDE.md` "Remote Deployment" — VPS / shared deployment is a stated direction

**Recommended amendment.** Default jail roots = `~/.patchwork/` + workspace ONLY. `/tmp` opt-in via `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1` env var, or NODE_ENV-gated. Rewrite PLAN-A line 254 to default-deny `/tmp`. Migrate `synthetic-readonly.yaml` (which writes to `/tmp/dogfood-F2/`) to write under `~/.patchwork/test-sandbox/` so tests don't depend on the looser jail.

### C-3 — `vars` HTTP validation rule is undefined; "no control chars, ≤ 1 KB" does NOT block path traversal in values
**Bypass scenario.** PLAN-A line 36 + line 50 propose: "Validate `vars` keys (`/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/`) and values (no control chars, ≤ 1 KB)." That's the entire spec. **A control-char check does not block `..` or `/`.**

A vars value of `../../../etc/passwd-overwrite` passes the rule (no control chars, length 32 bytes). It then flows into `runRecipeFn` → seeds chained env (`chainedRunner.ts:417`) → `compileTemplate` substitution into `path: ~/.patchwork/inbox/{{filename}}.md`. The literal post-substitution path is `~/.patchwork/inbox/../../../etc/passwd-overwrite.md`. This is exactly the F-02 exploit, post-mitigation.

PLAN-A says (line 42): "values that contain `..` or `\0` are rejected before they ever reach the renderer." But the actual specification on line 36 only says "no control chars, ≤ 1 KB" — `..` is not a control char. The intent is correct in line 42 prose, but the formal rule on line 36 is wrong, and line 36 is what tests will be written against.

The plan's "defence in depth" framing here is misleading. The only actual defence is the post-render jail (which is correct). The HTTP `vars` validation as written is a no-op against this attack class, but a reviewer reading line 36 may believe it's an additional layer.

**Evidence.**
- PLAN-A line 36 — formal rule
- PLAN-A line 42 — informal prose disagrees with formal rule
- `G-security.md` F-02 — live exploit using `--var "target=../../../../tmp/..."`
- `src/recipeRoutes.ts:128-138` — current absent validation

**Recommended amendment.** Spec a concrete rule on line 36, replacing "no control chars, ≤ 1 KB" with: values are strings, ≤ 1 KB, **MUST NOT contain any of:** null byte, ASCII control chars (0x00-0x1F, 0x7F), the substring `..` (defends against most traversals — false positives like `file..txt` are extremely rare in vars values), unencoded path separators (`/`, `\\`) when the recipe uses `{{var}}` inside `path:` fields. Since validating context-aware (which fields the var is substituted into) is hard at HTTP entry, the safer default is: **vars values must match `/^[\\w\\-. :+@,]+$/u`** (alphanum + a small set of punctuation, no slashes, no `..`, no `~`). Document escape hatch: callers needing exotic vars can encode + decode in the recipe. Or commit to a rule like "vars are opaque strings; the path jail is the only defence" and remove the false-confidence wording at line 42.

---

## HIGH findings

### H-1 — `loadNestedRecipe` jail does not address loop / cycle detection within the jail
**Bypass scenario.** PLAN-A §1 PR-2 "For F-04, the cleanest fix is to compute the candidate `path.resolve` first, then assert it `startsWith` one of three allowed bases." This closes path-escape but does NOT close the recursion DoS:

A malicious recipe at `~/.patchwork/recipes/loop.yaml` with `recipe: loop` self-recurses. PLAN-A delegates cycle detection to PR-3's `enrichStepFromRegistry` recursion (line 120: "Cycle detection already exists at `chainedRunner.ts:993-1009`; reuse the topological order so we never re-enter") — but that's the **dry-run plan generator**, not the runtime executor. At runtime, `runChainedRecipe` recurses via `loadNestedRecipe` → `runChainedRecipe` (chainedRunner.ts:420) capped only by `options.maxDepth` (default 3, configurable up to whatever). A recipe declaring `maxDepth: 100` chained with self-reference fans out 100 nested `runChainedRecipe` calls before bottoming out. Combined with F-09's not-yet-clamped `maxConcurrency`, the multiplicative effect is significant.

PR-3 plans to clamp `maxConcurrency` to 16 — but does NOT clamp `maxDepth`. Plan claims maxDepth defaults to 3 (yamlRunner.ts:1372). True for the parent recipe, but a maliciously installed recipe overrides it.

**Evidence.**
- `src/recipes/yamlRunner.ts:1372` — `chainedRecipe.maxDepth ?? 3` (recipe-author overridable)
- `src/recipes/chainedRunner.ts:420` — recursion: `runChainedRecipe(nestedRecipe.recipe, childOptions, deps, childRegistry, depth + 1)`
- `src/recipes/chainedRunner.ts:367` — `recipeMaxDepth: options.maxDepth` flows into nested context
- PLAN-A line 120 — claims existing cycle detection covers it
- PLAN-A line 129-130 — clamp test only for `maxConcurrency`, not `maxDepth`

**Recommended amendment.** PR-3 must also clamp `chainedRecipe.maxDepth` at intake: `Math.min(maxDepth ?? 3, 5)`. Add a runtime cycle check in `runChainedRecipe` that tracks a Set of `(recipePath, recipeName)` already on the stack and rejects re-entry — the dry-run cycle detection at `chainedRunner.ts:993-1009` does NOT run during real execution.

### H-2 — Atomic-rename plan has no temp-file cleanup → leaks `.tmp.<pid>.<ts>` files
**Bypass scenario.** PLAN-A §1 PR-3 line 118: `tmp = ${target}.tmp.${pid}.${Date.now()}.${randomUUID().slice(0,8)}` then `renameSync`. This is correct for the happy path. Two failure modes leak temp files:

1. **Process killed between `writeFileSync(tmp)` and `renameSync(tmp, target)`** — temp file persists in the target directory (e.g. `~/.patchwork/inbox/`). No sweeper proposed.
2. **Two concurrent runs both rename to the same final path.** POSIX `rename(2)` is atomic but only one rename "wins" — the loser's tmp file is overwritten by the winner's tmp during its own rename, but if both renames complete out of order, the question is more subtle. In practice both renames succeed (`rename(A, target)` then `rename(B, target)` — last-writer-wins on `target`). No tmp file leaks from this path. **But** if the loser's process crashes after `writeFileSync(tmp)` and before `rename`, its tmp leaks (case 1). Concurrent runs amplify case 1's probability.

PLAN-A line 263 promises a fixture cleanup task in PR-5 ("Audit `~/.patchwork/recipes/*.permissions.json`") but says nothing about tmp-file sweep.

**Evidence.**
- PLAN-A line 118 — temp filename pattern
- PLAN-A §1 PR-3 "Test fixtures + assertions" line 125 — assertion is "no caller observes a partial-content file" — does NOT assert temp-file cleanup
- POSIX `rename(2)` — atomic on same FS but provides no cleanup guarantee on crash

**Recommended amendment.** PR-3 must include a startup-time sweeper at bridge boot: scan `~/.patchwork/inbox/`, `~/.patchwork/journal/`, `~/.patchwork/runs/` for files matching `*.tmp.<pid>.*` where `<pid>` is no longer alive, delete them. Alternative: place tmp files under `~/.patchwork/.tmp/` (one shared dir, one cleanup target). Add a test assertion: kill process mid-write, restart, assert temp dir is empty.

Plus the cross-FS edge case: `~/.patchwork/inbox/` may not be on the same FS as `os.tmpdir()`. The plan's tmp filename keeps the temp file in the **target** directory (`${target}.tmp...`) — so same-FS guaranteed. Confirmed in PLAN-A line 133. **OK as written**, but flag this in the PR description so a future refactor moving tmps to `os.tmpdir()` doesn't silently introduce EXDEV.

### H-3 — `FileLock` is in-process only — does NOT serialize across the bridge subprocess + concurrent CLI invocations
**Bypass scenario.** PLAN-A DP-3 (line 236-240) offers `fileLock` as the strong-guarantee alternative to atomic rename. `src/fileLock.ts:13-21` is `class FileLock { private locks = new Map<string, Promise<void>>() }` — a Node-process-local Map. Three independent processes can all "acquire" a lock and proceed concurrently:

1. Bridge process running scheduled `daily-status` at 09:00:00.
2. User runs `patchwork recipe run daily-status` from the CLI at 09:00:01 (separate Node process).
3. Bridge subprocess driver also fires same recipe via `runClaudeTask`.

All three see an empty Map and proceed. Last-writer-wins remains.

PLAN-A line 240 says "fileLock is a five-line addition if the maintainer wants the stronger guarantee — wrap `writeFile` default in `await fileLock.acquire(target)`." This is misleading — fileLock provides NO cross-process guarantee.

**Evidence.**
- `src/fileLock.ts:14` — `private locks = new Map<...>` (in-memory)
- PLAN-A line 240 — claims fileLock closes the race "fully"

**Recommended amendment.** Strike the fileLock recommendation from DP-3 OR replace with an OS-level advisory lock (`flock` on a sentinel file via `proper-lockfile` npm pkg, or `O_EXCL` create-and-keep-open pattern). Atomic rename is the correct primary defence; "stronger guarantee" requires actual cross-process locking.

---

## MEDIUM findings

### M-1 — 256 KB body cap is fine for recipes but risks legitimate `vars` payloads on `/recipes/lint`
**Weakness.** PLAN-A line 73 + line 82 propose 256 KB cap on all six recipe routes. For `/recipes/:name/run`, vars payloads are typically tiny (sub-KB). For `/recipes/lint`, the body IS a recipe YAML — which could legitimately be 50-100 KB for a recipe that inlines a long agent prompt or a JSON-document `vars` defaults. 256 KB still leaves headroom but a deliberate `description: <huge>` recipe could approach. PLAN-A line 252-253 (open question 2) acknowledges this without resolving.

The greater concern: **a per-route or per-shape cap is missing.** The 256 KB applies uniformly — `POST /recipes/install` (which fetches a remote URL and reads `{source}` body) only needs ~1 KB; `/recipes/:name/run` only needs ~10 KB. The plan misses an opportunity to set tighter caps per-route. Tight caps double as a fingerprint-resistance mechanism (forces an attacker to constrain their payload).

**Evidence.**
- PLAN-A line 73 — flat 256 KB
- PLAN-A line 252 — unresolved open question

**Recommended amendment.** Per-route caps:
- `POST /recipes/install` — 4 KB (just `{source}`)
- `POST /recipes/:name/run`, `POST /recipes/run` — 32 KB (vars + a little headroom)
- `POST /recipes`, `PUT /recipes/:name`, `PATCH /recipes/:name` — 256 KB (recipe content)
- `POST /recipes/lint` — 256 KB (recipe content)
Plus a global cap at `POST /mcp` (currently un-capped; the JSON-RPC route is a separate concern, but if PR-2 adds the helper it should be reused there too).

### M-2 — Install allowlist regex bypass: `gh:` shorthand parser does NOT validate `owner` / `repo` against `isSafeBasename`
**Weakness.** PLAN-A §1 PR-2 says CLI is github-only; HTTP route gets the new allowlist. Question (3) in the user's prompt asks if "github-only" check is naive. Audit:

- `src/recipeRoutes.ts:613-625` — HTTP route prefix check is `source.startsWith("github:patchworkos/recipes/")` (very strict for the github-prefix arm) OR `source.startsWith("https://")` (very loose for the URL arm). The plan tightens the URL arm. **Acceptable.**
- `src/commands/recipeInstall.ts:146-180` — CLI `parseGithubShorthand` does NOT validate `owner` / `repo` against `isSafeBasename` (the helper exists at line 57 but isn't applied to owner/repo). It interpolates raw user strings into `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${ref}` (line 264). A `gh:foo@bar:bad/repo` would yield a URL with embedded `@` — Node's `https.get` would parse `foo@bar:bad` as userinfo and attempt to connect to host `bad` with credentials `foo`/`bar:`. **This is a CLI-side SSRF that the HTTP-only allowlist does NOT cover.**

The plan does NOT address this CLI-side bypass. PLAN-A "DP-2" (line 226-233) discusses HTTP route allowlist only.

**Evidence.**
- `src/commands/recipeInstall.ts:146-180` — no validation of owner/repo
- `src/commands/recipeInstall.ts:264` — `https://api.github.com/repos/${owner}/${repo}/...`
- `src/commands/recipeInstall.ts:213-249` — `httpsGet` follows redirects unconditionally to ANY host (`res.headers.location`)

**Recommended amendment.** Add to PR-2: validate `owner` and `repo` in `parseGithubShorthand` and the URL parser via `isSafeBasename` (or a stricter github-name regex `/^[a-zA-Z0-9](?:[a-zA-Z0-9-._]{0,38})$/`). Reject anything else. Separately, `httpsGet` should constrain redirect hosts to github.com / raw.githubusercontent.com / objects.githubusercontent.com — currently it follows any redirect. This is a CLI-side issue but it's the same threat class as F-05 (SSRF via install) and belongs in the same PR.

### M-3 — `enrichStepFromRegistry` recursion has no `(recipePath, lineageSet)` cycle guard, only relies on `maxDepth` clamp
**Weakness.** PLAN-A §1 PR-3 line 120: "Cycle detection already exists at `chainedRunner.ts:993-1009`; reuse the topological order so we never re-enter." Topological cycle detection works on `awaits` graphs WITHIN a single recipe. It does NOT handle the cross-recipe cycle: recipe A calls recipe B; recipe B calls recipe A. The dry-run planner just walks deeper until `maxDepth` is hit (after PR-3 clamps to 3-5).

The plan's PR-3 line 128 promises a `cycle-protection.test.ts` — "recipe A calls B, B calls A; assert: dry-run completes (does not infinite loop) and reports the cycle." Good. But the implementation hint (re-use line 993-1009) won't satisfy the test as-described, because the topological detector doesn't see across recipe boundaries.

**Evidence.**
- `src/recipes/chainedRunner.ts:993-1009` — topological sort within single recipe
- PLAN-A line 120 — claim of reuse is wrong shape

**Recommended amendment.** Implementation: thread a `Set<string>` of visited absolute recipe paths through `enrichStepFromRegistry` recursion; on entry, check if `recipePath` is already in the set; if so, mark as cycle and stop recursing. Same pattern at runtime in `runChainedRecipe` (per H-1).

### M-4 — Tests assert "throws contains 'escapes jail'" — message-coupling fragility
**Weakness.** PLAN-A line 46-49 specifies tests like "assert: tool throws, error message contains `escapes jail`." This couples tests to error message strings. Future i18n / message rewording breaks the gate. Better: use error codes (the existing `resolveFilePath` already sets `err.code = "workspace_escape"`, src/tools/utils.ts:126).

**Evidence.**
- `src/tools/utils.ts:126` — existing pattern
- PLAN-A line 46-49 — string-match assertions

**Recommended amendment.** Define `err.code = "recipe_path_jail_escape"` (or similar) on the new helper; assert in tests against the code, not the message.

### M-5 — F-04 jail does not include bundled-templates path in plan; PLAN-A flags as open question (line 255) but doesn't decide
**Weakness.** PLAN-A line 255 (open question 4) leaves the bundled-templates dir as TBD. Until decided, PR-2 ships with three roots (parent dir / `~/.patchwork/recipes` / "bundled templates dir") — but the plan is unclear what "bundled templates dir" actually resolves to. If it's `path.dirname(require.resolve('claude-ide-bridge/templates/recipes'))` or similar, the test fixtures need to verify it, otherwise `recipe: ../../templates/recipes/foo.yaml` from a recipe in the repo root could either succeed or fail unpredictably depending on how the bundle was installed (npm global vs npx vs local).

**Evidence.**
- PLAN-A line 71 — third allowed base is "bundled templates dir" (under-specified)
- PLAN-A line 255 — open question

**Recommended amendment.** Resolve open question 4 before PR-2 review. Concrete path: capture the bundled templates dir at bridge boot (`path.resolve(__dirname, '../templates/recipes')` or via require.resolve) and hard-code as the third jail root. Test fixture verifies a templates-dir-relative `recipe:` reference works; one outside fails.

---

## LOW findings

### L-1 — Plan's `maxConcurrency` clamp at 16 does not address orchestrator-level oversubscription
**Weakness.** Question 7 in the user prompt: parallel branches × nested-recipe parallelism multiply. PR-3 clamps **per-recipe** `maxConcurrency` at 16. But two simultaneous recipes (one from cron, one from the dashboard) each running at 16 = 32 concurrent step executions, each a Claude subprocess. PLAN-A does not address bridge-wide orchestrator concurrency.

**Evidence.**
- PLAN-A line 112 — per-recipe clamp
- `src/recipes/chainedRunner.ts:211` (per audit citation in G-security.md F-09) — busy loop scoped to one recipe

**Recommended amendment.** Out of scope for PLAN-A — note in PR-3 description that orchestrator-wide cap is a follow-up. Reference round-2 memory note `project_recipe_orchestrator.md` (RecipeOrchestrator extraction landed in Phase 1) — this is the natural home for a global semaphore.

### L-2 — Permissions sidecar Option B leaves orphan files on existing installs; plan promises a deprecation warning but no implementation detail
**Weakness.** PLAN-A line 156: "leave one migration release where the bridge logs a deprecation warning when it sees a stale sidecar." Concrete plan: where in the boot sequence? Once per bridge boot, or on every recipe load? Suppress in CI / test mode? Wrong choice = noisy logs in user-facing CLI.

**Evidence.**
- PLAN-A line 156 — under-specified

**Recommended amendment.** Once per bridge boot, log to `console.warn` once for the **count** of stale sidecars (`Found N stale .permissions.json sidecars under ~/.patchwork/recipes/. These are no longer enforced. See: https://patchwork.dev/migration/permissions-sidecar`). Do not log per-recipe. Skip in `NODE_ENV=test`.

### L-3 — The connector tools (notion / confluence / zendesk / intercom / hubspot / datadog / stripe — 38 tools, F-tools.md F2) are CORRECTLY out of scope for PLAN-A but the runtime impact is unclear
**Note.** Question 8 in user prompt asks if these belong here. Answer: **No, correctly deferred to PLAN-B**. They are not part of the path-traversal / SSRF / DoS class that PLAN-A addresses. They are a "consistent silent-fail floor" issue (PLAN-B per PLAN-MASTER ordering — though PLAN-B doesn't yet exist in the dogfood folder per PLAN-A line 11). So this is a **plan-coordination** concern: when PLAN-B lands, ensure its scope explicitly covers the 7 connector files.

**Evidence.**
- `F-tools.md` F2 — 7 files, 38 tools, no try/catch
- PLAN-A line 11 — PLAN-B does not yet exist

**Recommended amendment.** No change to PLAN-A. When PLAN-B is drafted, ensure its bug list explicitly cites `F-tools.md` F2 and covers all 7 files.

### L-4 — Template-injection (G-LOW per `G-security.md` F-11) is correctly LOW today but plan doesn't future-proof
**Note.** Question 8 asks about template-injection rating. Per G-security.md line 225: "no shell-spawning recipe tool consumes templated input directly via shell" — confirmed by audit (`grep`'d `child_process` + `shell:true` across `src/recipes/`). So LOW is correct.

PLAN-A's PR-5 cleanup tasks (line 261-269) don't include the lint rule G-security.md F-11 recommended ("flag any new tool importing `child_process` and using `params` directly"). This is the future-proofing piece — without it, the rating could silently flip to CRITICAL if a future tool author adds a shell-execing tool.

**Evidence.**
- `G-security.md` F-11 line 227 — recommended lint rule

**Recommended amendment.** Add to PR-5 cleanup: a one-line entry pointing at PLAN-C (validation.ts) for the lint rule. Or move to PLAN-C explicitly.

### L-5 — `PATCH /recipes/:name` `require is not defined` ESM bug correctly assigned away from PLAN-A
**Note.** Question 8 asks if this assignment is right. The bug (per `H-http-routes.md` finding 1, CRITICAL on the H file) breaks the dashboard's enable/disable toggle. **It IS security-adjacent** — operators cannot quickly disable a malicious recipe via the dashboard, must SSH in and delete the file or set the disabled marker.

But the fix is mechanical (`require` → top-level `import` or `await import()`), and the failure mode is operational (user-facing brokenness, not exploitable) — so the placement in PLAN-C is defensible **if** PLAN-C ships in the same release as PLAN-A. If they ship in different releases, and PLAN-A introduces enforcement (Option A path) BEFORE PLAN-C fixes the toggle, the user is in a worse spot than today.

PLAN-A's recommendation is Option B (delete sidecar), so this risk is moot for the current sequencing.

**Evidence.**
- `H-http-routes.md` finding 1
- PLAN-A's recommendation of Option B for F-03

**Recommended amendment.** No change — but note in PLAN-MASTER that "if PLAN-A picks Option A, PLAN-C `require` fix becomes a release blocker."

---

## INFO findings

### I-1 — Plan's "SSRF guard from sendHttpRequest" reuse needs a concrete API contract
**Note.** PLAN-A line 80 says "Add the SSRF guard from `src/tools/sendHttpRequest.ts` (DNS pre-resolution + private/loopback range check) — wraps the `fetch(fetchUrl)` call." The current implementation in `sendHttpRequest.ts` is private to that tool. Either it needs to be extracted to a shared helper (with its own tests) or duplicated in `recipeRoutes.ts` (with the same tests). Plan doesn't specify which.

**Recommended amendment.** Extract `validateSafeUrl(urlString)` from sendHttpRequest into `src/tools/utils.ts` or a new `src/ssrfGuard.ts`. Both call sites use the shared helper. Prevents drift.

### I-2 — Plan does not call out the `httpsGet` redirect-chase as part of the SSRF surface
**Note.** `src/commands/recipeInstall.ts:223-232` follows redirects to any URL the server returns (line 231: `httpsGet(res.headers.location).then(resolve).catch(reject)`). Even after a github-only allowlist on the initial URL, an attacker-controlled github.com path that returns a 302 to `http://attacker.com/payload` would be followed by the CLI installer. Same applies to the new HTTP allowlist.

**Recommended amendment.** PR-2 should re-check redirect targets against the same allowlist. Concretely: in `httpsGet`, before the recursive call on line 231, validate `res.headers.location` against the allowlist OR pass a `validator` callback. Add a test: 302 to internal IP → reject.

### I-3 — Plan's `vars: { ok_key: "value" }` example for HTTP validation does not test typed values (numbers, booleans, nested objects)
**Note.** PLAN-A line 50 test: `vars: {ok_key: "value"} → forwards`. But what if a caller posts `vars: {ok_key: 42}` or `vars: {ok_key: ["a","b"]}`? The current code (`recipeRoutes.ts:128-138`) coerces non-object varsRaw to `undefined`, but doesn't reject non-string values inside vars. The H-http-routes.md finding 3 already flags this. PLAN-A's vars validation should make the type rule explicit: **vars must be `Record<string, string>`; non-string values → 400.**

**Recommended amendment.** Update PLAN-A line 36 with type rule: keys are strings matching the regex; values MUST be strings (no numbers, no booleans, no arrays, no nested objects).

---

## Remediation checklist — PRs that need amendment before shipping

| PR | Required amendments | Severity drivers |
|---|---|---|
| **PR-1** | Add chained-runner template substitution as 3rd jail point (C-1). Tighten default jail roots (drop `/tmp` default) (C-2). Replace "no control chars, ≤ 1 KB" vars rule with concrete deny-list including `..`, `/`, `\\`, `~` (C-3). Add error-code-based assertions, not message strings (M-4). Type-strict `vars` values to string-only (I-3). | C-1, C-2, C-3, M-4, I-3 |
| **PR-2** | Validate `owner` / `repo` in `parseGithubShorthand` and URL parser via `isSafeBasename` (M-2). Constrain `httpsGet` redirect chases to allowlist (I-2). Resolve bundled-templates path open question (M-5). Per-route body caps instead of flat 256 KB (M-1). Extract SSRF guard to shared helper (I-1). | M-1, M-2, M-5, I-1, I-2 |
| **PR-3** | Add `maxDepth` clamp alongside `maxConcurrency` clamp (H-1). Add runtime cycle detection for nested recipes (H-1, M-3). Add temp-file sweeper for atomic-write leaks (H-2). Strike `fileLock` from DP-3 OR replace with cross-process lock (H-3). | H-1, H-2, H-3, M-3 |
| **PR-4** | Specify deprecation-warning emission point + format for Option B (L-2). | L-2 |
| **PR-5** | Add lint-rule task referring to PLAN-C for child_process/shell-spawn detection (L-4). | L-4 |

**Cross-cutting:** the plan would benefit from a single appendix listing every render/template substitution point in the codebase (yamlRunner.ts:452, :642, :809; chainedRunner.ts:194-205, :226, :302) so future reviewers can verify defence coverage at a glance. C-1 is the symptom; the cause is that no document enumerates the substitution surface.

---

## Positive findings — plan does these correctly

- **Sequencing.** PR-1 → PR-3 (yamlRunner.ts:976-994 touchpoint) is correctly identified as serial; PR-2 / PR-3 correctly parallel. (PLAN-A line 191-202)
- **DP-1 Option B recommendation.** Consistent with audit: only 2 readers, both boolean-existence checks (`src/recipesHttp.ts:582,707`). Deletion is safe. (PLAN-A line 153-160 + audit-confirmed at `recipesHttp.ts:582,689,707`)
- **Atomic rename pattern.** Same-FS guarantee held via tmp-in-target-dir (PLAN-A line 133); EXDEV concern correctly noted as not-applicable.
- **Bearer-auth verification.** `G-security.md` line 252-265 confirms all routes properly auth'd; PLAN-A correctly does not duplicate this work and assumes it as a precondition.
- **Existing `resolveFilePath` correctly identified as workspace-scoped, not drop-in.** (PLAN-A line 42, accurately reading `src/tools/utils.ts:118-128`.)
- **Cycle detection at planning layer reused.** Reasonable starting point even though M-3 / H-1 note it needs cross-recipe extension.
- **Round-1 cross-cut #1 absorbed into PR-3.** (PLAN-A line 13, line 110.) Sound dependency management.
- **Fixture promotion.** PR-5 moves exploit YAMLs into the repo — closes the "future audit re-discovers same exploit" loop. Good operational hygiene.

---

## Files relevant to this review

- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/PLAN-A-security.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/G-security.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/F-tools.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/docs/dogfood/recipe-dogfood-2026-05-01/H-http-routes.md`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/tools/utils.ts` (lines 100-200)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipes/tools/file.ts`
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipes/yamlRunner.ts` (lines 600-650, 970-1000, 1275-1340, 1370)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipes/chainedRunner.ts` (lines 130-220, 350-470, 990-1040)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipeRoutes.ts` (lines 100-220, 555-685)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/commands/recipeInstall.ts` (lines 50-180, 213-310, 440-485)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/recipesHttp.ts` (lines 575-595, 700-715)
- `/Users/wesh/Documents/Anthropic Workspace/Patchwork OS/src/fileLock.ts`
