# Recipe tool audit — silent-failure patterns

**Scope:** `src/recipes/tools/*`, `src/recipes/yamlRunner.ts`, `src/recipes/agentExecutor.ts`, and the connector adapters they invoke.
**Trigger:** the `defaultGitStaleBranches` regression — `git branch --since=<date>` is not a real flag, so the tool silently returned `(git branches unavailable)` for every invocation while the recipe agent dutifully summarised "data unavailable". Audit looks for the same class of bug elsewhere.
**Method:** read every registered recipe tool + every default `RunnerDeps` impl. Cross-checked against the connectors they delegate to. No tests run, no code changed.

---

## Findings

### 1. `defaultGitLogSince` — silent placeholder swallows every failure
- **File:** `src/recipes/yamlRunner.ts:834-851`
- **Pattern:** silent placeholder return (category 2)
- **Reproduction:** invoke `git.log_since` from a non-git directory, or with a malformed `since` value, or when git itself is missing on PATH:
  ```ts
  // From inside /tmp:
  defaultGitLogSince("24h", "/tmp")
  // → "(git log unavailable)"
  ```
  Identical output for: not a git repo, exit-code 128, git binary missing, malformed `--since` arg. Caller cannot distinguish.
- **Severity:** **HIGH** — used by shipped recipe `daily-status.yaml` (`templates/recipes/daily-status.yaml:7`) and `morning-brief*.yaml`. The downstream agent prompt embeds `{{commits}}` directly and has no way to detect the placeholder.
- **Suggested fix:** stop returning a string placeholder — surface `result.stderr` and exit code via a `JSON.stringify({ok:false, error:...})` payload so the runner's `parsed.ok===false` branch (yamlRunner.ts:531-538) can mark the step as `error`.

### 2. `defaultGitStaleBranches` — same placeholder pattern (but now CORRECT impl)
- **File:** `src/recipes/yamlRunner.ts:855-908`
- **Pattern:** silent placeholder return (category 2). The original bug (invalid flag) is fixed, but the placeholder pattern remains.
- **Reproduction:** same as #1 — non-git dir, missing binary, etc. all collapse to `"(git branches unavailable)"`.
- **Severity:** **MEDIUM** — used by `templates/recipes/stale-branches.yaml`. Same agent-can't-tell problem as #1, just less common path now that the underlying CLI is correct.
- **Suggested fix:** ditto — return `{ok:false, error:result.stderr}` JSON so yamlRunner marks the step error rather than passing the placeholder through to the downstream prompt.

### 3. `defaultGetDiagnostics` — hardcoded empty-string stub
- **File:** `src/recipes/yamlRunner.ts:936` (the entire impl is `() => ""`).
- **Pattern:** missing implementation (category 3) / stub default (category 4).
- **Reproduction:** any recipe step `tool: diagnostics.get` with no override:
  ```yaml
  - tool: diagnostics.get
    uri: file:///some/path.ts
    into: diags
  ```
  → `ctx.diags === ""` regardless of what the file looks like.
- **Severity:** **MEDIUM** — `diagnostics.get` is publicly registered (`src/recipes/tools/diagnostics.ts:13-41`), advertised in the schema (`outputSchema: { type: "string", description: "errors, warnings count or detailed list" }`) and the description claims `(requires bridge connection; returns stub if unavailable)` — but no production caller wires a real `getDiagnostics` impl. The result is the tool *always* returns empty regardless of bridge connectivity.
- **Suggested fix:** either delete the registration outright (no shipped recipe uses it), or wire `bridgeClient.getDiagnostics({uri})` through `RunnerDeps.getDiagnostics` from the bridge entrypoint that constructs `RunnerDeps`. Until then, returning `""` indistinguishably from "no errors" is the same class of bug as #1/#2.

### 4. `sinceToGmailQuery` — silently coerces non-{Nh,Nd} input to "1d"
- **File:** `src/recipes/tools/gmail.ts:214-222`
- **Pattern:** invalid CLI flag handling (category 1) / hardcoded default leak (category 5).
- **Reproduction:** `gmail.fetch_unread`'s schema (`CommonSchemas.since` in `toolRegistry.ts:381-384`) advertises `'2026-01-01'` as a valid form, but:
  ```ts
  sinceToGmailQuery("2026-01-01")  // includes("d") → false; includes("h") → false → "1d"
  sinceToGmailQuery("48h")         // → "48h" (correct)
  sinceToGmailQuery("2d")          // → "2d"  (correct)
  sinceToGmailQuery("3w")          // → "1d"  (silently!)
  sinceToGmailQuery("60m")         // → "1d"  (silently!)
  sinceToGmailQuery("today")       // includes("d") → true → "toayd" → Gmail rejects, returns 0 results
  ```
  Worst case: ISO date silently becomes "last 24h"; minutes/weeks silently become "last 24h"; `"today"` produces a malformed `newer_than:toayd` query that Gmail returns no rows for. None of these surface as errors — count just comes back as 0.
- **Severity:** **HIGH** — `gmail.fetch_unread` ships in `morning-brief*.yaml` and `inbox-triage.yaml`. Schema mismatch + silent coercion = the inbox briefs may report 0 emails when many exist.
- **Suggested fix:** parse with `^(\d+)([hd])$/i`; for non-matching input throw `Error(\`Unsupported since format: ${since}\`)` so the runner's outer try/catch (yamlRunner.ts:540-543) propagates the failure into a step error.

### 5. `listIssues`/`listPRs` (GitHub connector) — swallow ALL errors into `[]`
- **File:** `src/connectors/github.ts:143-156` and `:177-192`
- **Pattern:** silent placeholder (category 2).
- **Reproduction:** any MCP failure (rate limit, expired token, network, `list_issues` tool removed, GraphQL schema change) collapses to `[]` indistinguishably from "user has no open issues":
  ```ts
  // Token expired:
  await listIssues({ assignee: "@me" })  // → []
  // Repo doesn't exist:
  await listIssues({ repo: "ghost/nonexistent" })  // → []
  ```
- **Severity:** **HIGH** — `github.list_issues`/`github.list_prs` recipe tools (`src/recipes/tools/github.ts:13-52,58-97`) wrap these directly. The recipe step receives `{count:0,issues:[]}` with NO error field on either failure mode. Any morning-brief / triage recipe that tries to count issues silently reports zero.
- **Suggested fix:** distinguish "not connected" (return `[]` is OK — but log a warning) from runtime errors. For runtime errors, throw. The recipe-tool wrapper already catches exceptions (it wraps in JSON), so throwing here actually surfaces the error.

### 6. `linear.listIssues` (connector) — same swallow-to-`[]` pattern
- **File:** `src/connectors/linear.ts:148-179`
- **Pattern:** silent placeholder (category 2). Same shape as #5 but with one wrinkle — it re-throws when the message contains `"not connected"` (line 175-176), so disconnect IS surfaced. Other errors (rate-limit, schema drift, MCP transport error) silently → `[]`.
- **Reproduction:**
  ```ts
  // Connected, but Linear MCP rate-limits us:
  await listIssues({ assigneeMe: true })  // → [] (rate-limit response swallowed)
  ```
- **Severity:** **MEDIUM** — `linear.list_issues` recipe tool (`src/recipes/tools/linear.ts:51-92`) sets `error: "Linear not connected"` only on `loadTokens()===false`. The connector's catch-all eats every other failure mode silently.
- **Suggested fix:** rethrow non-disconnect errors; let the recipe tool's `try/catch` (linear.ts:84-90) translate them into the `error` field.

### 7. `gmailSearch` / `gmailFetchThread` / `gmailGetMessage` — collapse all transport errors to a single string
- **File:** `src/recipes/tools/gmail.ts:9-80`, `:100-141`, `:143-212`
- **Pattern:** silent placeholder with low-fidelity error string (category 2).
- **Reproduction:**
  ```ts
  // Network blip mid-fetch
  await gmailSearch("is:unread", 10, deps)  // catches → returns {count:0, messages:[], error:"Gmail fetch failed"}
  ```
  Any fetch throw becomes `"Gmail fetch failed"` (line 78). Any non-OK HTTP becomes `"Gmail API error"` (line 42, 129, 169). Caller sees no status code, no body, no method, no URL.
- **Severity:** **MEDIUM** — error IS surfaced as a string in the JSON, so the runner's `parsed.ok===false` check doesn't fire (the JSON has `count:0` not `ok:false`). Recipe step shows status `ok` despite Gmail being down. See yamlRunner.ts:531-538 — only `{ok:false}` triggers `stepError`.
- **Suggested fix:** include `ok:false` in the error-result envelope so the runner sees the failure, OR change yamlRunner's heuristic to also treat non-empty `error` field as a step failure.

### 8. `meetingNotes.createLinearIssues` — `listLabels()` failure → silently drops all labels
- **File:** `src/recipes/tools/meetingNotes.ts:517-528`
- **Pattern:** silent fallback (category 2, narrow scope).
- **Reproduction:** if Linear's `list_labels` API fails, the catch sets `allowedLabels = undefined`, every issue is created label-less. The output JSON contains no warning. The route via `meetingNotes` is the *only* labelling path, so a transient list_labels failure removes all routing labels with no signal.
- **Severity:** **MEDIUM** — production-shipped (meeting-notes recipes use it). Silent label loss is harder to spot than silent issue-create failure.
- **Suggested fix:** push a warning into `out.warning` (alongside `teamFallbackNote` at line 600), e.g. `"Could not list Linear labels — created issues without routing labels"`.

### 9. `meetingNotes.createLinearIssues` — `updateIssue` (assignment) failure swallowed
- **File:** `src/recipes/tools/meetingNotes.ts:582-585`
- **Pattern:** silent error swallow (category 2).
- **Reproduction:** if `updateIssue({assignee})` throws (assignee not found, name not unique, permission), the issue is created unassigned and no warning surfaces.
- **Severity:** **LOW–MEDIUM** — explicitly commented "non-fatal — issue is already created". The argument for the silence is sound; the argument against is that the user has no way to find the unassigned issues afterwards. Add an `unassignedFailures: [...]` array to the response so the agent step can mention them.
- **Suggested fix:** collect `{task, attemptedAssignee, error}` into the existing `errors` array (or a separate `assignmentFailures` field) and surface in the final JSON.

### 10. Connector handler patterns vs `tryRequest` — drift

This isn't a tool-level bug, but worth flagging for the codebase rule in CLAUDE.md (`extensionClient` shape validation): the same antipattern from the bridge side is repeated in connectors. `github.listIssues`, `linear.listIssues`, `gmail.fetchDocContent`, `googleDrive.fetchDocName` all `catch { return ""; }` / `catch { return []; }`. CLAUDE.md guidance for bridge code is to use `tryRequest` / `validatedRequest` / inline unwrap to *distinguish* error paths. Connectors have no equivalent helper and the bare `catch { return [] }` pattern leaks the same class of bug.

- **File:** the policy lives in `CLAUDE.md` "extensionClient shape validation" section; the connector files have no equivalent rule.
- **Severity:** **LOW** (process/codebase-rules, not a single bug).
- **Suggested fix:** add a `connectorRequest<T>(fn, label)` helper in `src/connectors/baseConnector.ts` that catches, classifies (auth / network / 4xx / 5xx), and returns a tagged union — then replace the bare catches in github/linear/gmail incrementally.

### 11. `executeTool` (recipe registry) — unknown-tool throws but `executeStep` returns `null`
- **File:** `src/recipes/yamlRunner.ts:725-771` (executeStep) and `src/recipes/toolRegistry.ts:113-115` (executeTool).
- **Pattern:** missing implementation handled inconsistently (category 3).
- **Reproduction:** YAML step `tool: nonexistent.thing` → `hasTool()` returns false → executeStep:769-770 returns `null` → step status `"skipped"` → no error. Comment says `// Unknown tool — skip, don't throw (forward compat)` but this is also indistinguishable from a typo.
- **Severity:** **LOW** — typos in tool names produce silent skips. The "forward compat" justification holds for plugin tools but not for misspelled built-ins.
- **Suggested fix:** when `toolId` matches a known prefix (`file.`, `git.`, `gmail.`, etc.) but the suffix is unknown, throw rather than skip. Plugins can use unknown prefixes legitimately.

### 12. `slack.post_message` — disconnected returns `ok:false` (correct), but other errors stringify to message only
- **File:** `src/recipes/tools/slack.ts:57-91`
- **Pattern:** lossy error reporting (category 2).
- **Reproduction:** `not_in_channel`, `channel_not_found`, rate-limit (`429`) all become `JSON.stringify({ok:false, error: <message>})`. No status code, no Slack response_metadata. Less bad than the gmail tools because at least `ok:false` triggers the runner's failure detection (yamlRunner.ts:531-538). Logged here for completeness — it is NOT a silent failure, just a lossy one.
- **Severity:** **LOW**.
- **Suggested fix:** include the original Slack error code in the JSON body.

---

## Patterns I saw repeatedly

1. **`catch { return [] }` / `catch { return "" }` in connectors** — github/linear/gmail/googleDrive all do this. Recipes built on top can never tell "no data" from "transport broke". This is the root cause of #1, #2, #3, #4, #5, #6, #7.
2. **String placeholder vs `{ok:false}` JSON inconsistency** — yamlRunner only treats a step as failed when result is parseable JSON with `ok:false`. Tools that return `(unavailable)` placeholder strings or `{count:0,messages:[],error:"…"}` payloads (no `ok` key) succeed-with-empty as far as the runner is concerned. See yamlRunner.ts:531-538.
3. **Schema descriptions promise more than impls deliver** — `CommonSchemas.since` lists `'2026-01-01'` but `sinceToGmailQuery` doesn't handle it; `diagnostics.get` description says "requires bridge connection" but the default impl is hard-wired to `""`.

## TL;DR — top 5 most-actionable

1. **`sinceToGmailQuery` (gmail.ts:214)** — silently coerces unsupported `since` formats (ISO dates, weeks, minutes, free text) to `"1d"`. Production morning-brief recipes pass these. **Highest impact: silently underreports inbox volume.**
2. **`defaultGitLogSince` (yamlRunner.ts:834)** — `(git log unavailable)` placeholder swallows every git failure. Used by every shipped daily-brief recipe. Same class as the original `defaultGitStaleBranches` bug.
3. **`defaultGetDiagnostics` (yamlRunner.ts:936)** — hardcoded `() => ""`. The `diagnostics.get` tool is registered but its production default is a stub. Either wire it through the bridge or unregister.
4. **`github.listIssues` / `github.listPRs` (github.ts:143, 177)** — bare `catch { return [] }` masks token expiry, rate limits, and MCP outages as "no issues". Surface these as throws so the recipe-tool wrapper can encode them into the `error` field.
5. **`linear.listIssues` (linear.ts:148)** — same pattern as #4. Already partially right (it rethrows "not connected") — extend the rethrow whitelist to all non-empty-result errors.

(Honourable mention: yamlRunner's success/failure detection should also treat any `{error: "…"}` payload — not just `{ok:false}` — as a step failure. That single change would make most of the gmail/linear lossy-error patterns visible without per-tool fixes.)
