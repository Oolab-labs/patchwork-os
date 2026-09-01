# In-flight work ledger

Lightweight coordination doc for when more than one Claude Code session is
working in this repo at the same time (parallel chats, Cowork worktrees,
scheduled routines). Not enforced by tooling — a convention, not a gate.

## Why this exists

On 2026-06-30/07-01, two sessions independently built the exact same fix
(`github.search_issues` registration + `state`/`stateReason` plumbing for
the outcome-ingester) without knowing about each other. One session's
commit landed on the *other* session's active branch
(`fix/shim-workspace-aware-lock-discovery`), which had to be rescued by
branching the commit off and leaving that branch untouched rather than
force-moving it back — avoidable with five minutes of a shared ledger.

## Convention

Before starting non-trivial work (a new branch, a fix touching shared
subsystems like the worker-trust gate, the recipe runner, or the bridge
init/shim path), add a line here.

### Retire your own entry before merging

Move your line to **Recently closed** with its PR number **in the PR itself**,
as its last commit. Not afterwards.

"Remove the line once the PR merges" is what this file used to say, and it
cannot work: nothing removes the line during the merge, so `audit-in-flight`
fails on `main` the moment the PR lands and stays failing until some later PR
sweeps it — and that PR leaves its own entry behind in turn. Observed on
2026-08-24, when #1507 merged and immediately turned `main` red; CI runs this
gate at `.github/workflows/ci.yml:188`. Three hand sweeps had already been
needed before that, which is the same failure showing up as decay rather than
as a red build.

The cost is that an entry leaves Active slightly before the work lands. That is
a few minutes of a stale-clear ledger, against `main` being red after every
single merge — and a red gate nobody can act on is how a real warning gets
ignored.

An empty Active section is therefore normal and is not a sign the ledger is
being neglected.

Format: `- <date> `<branch-or-PR>` — <one-line scope> — <session/chat identity if known>`

The branch or PR **must be in backticks** — `scripts/audit-in-flight.mjs` only
checks entries that name one that way, so an unquoted entry is silently not
verified (which is how this line came to be written).

## Active

_Empty is a legitimate state. See "Retire your own entry before merging" above._


## Recently closed (informal log, prune periodically)

- 2026-09-01 `docs/butler-product-reset` — Butler design freeze (#1567). Butler's substrate
  is built (fact store with provenance tiers, quarantine, standing permissions with exercise
  history, deterministic outcome grading); its screen is five equal-weight sections rendering
  `subject — predicate: object`, and Simple mode redirects `/` to `/butler`, so it is a
  non-technical user's front door rather than a settings page. New IA: Home → Memory →
  Permissions → Activity, one job each. Records two distinctions a redesign would blur —
  forget is reversible and erasure is not (erasure blanks the content and keeps a
  content-free husk), and connector-derived facts are capped below the belief-origination
  threshold. Replaces the frozen five-heading test with outcome assertions while keeping its
  actual intent (DOM order is reading order). Follow-on branches will touch
  `dashboard/src/app/butler/` — coordinate before starting one.

- 2026-08-31 `feat/evidence-relationship-coverage` — Stage 1 of `patchwork evidence` becoming
  a coverage instrument. The flat "does this row carry a correlationId?" reading is WRONG on
  live data three ways: 6 approval requests (MCP client sessions) and 7 privacy-shadow rows
  (orchestrator dispatches) legitimately have no run, and `runs.jsonl` is an event log whose
  974 rows are 505 runs. Unit becomes a relationship with an expectation attached —
  connected / legacy / not-applicable / unresolved / defect — with integrity = connected /
  (connected + defect + unresolved), so history and rows that never owed a link stay out of
  the denominator. Approvals traverse in two hops (decision --callId--> request
  --correlationId--> run); the archive is read alongside the live run log. Found 7 genuinely
  unresolved receipts on its first run. Stage 2 (`--check`) deliberately deferred. — #1566

- 2026-08-31 `fix/recipe-cannot-disable-worker-gate` — `requireApproval: false` (#995) was
  DELIBERATELY preserved when worker autonomy arrived (#1027 lists "respects
  requireApproval:false" as intended). Compatibility was kept, but the flag had been defined
  against a gate that meant one thing and now sat in front of two — workspace tier policy AND
  worker governance — and since the worker gate is injected AS `requireApprovalFn` with
  `recordGateDecision` inside it, an opted-out recipe governed nothing AND recorded nothing.
  An intentional narrowing of the flag's meaning, not the discovery of an accident. Invariant
  now explicit: a recipe may opt out of the workspace TIER policy, never of WORKER governance.
  Tier half applied by the caller (worker gate built with no tier fn — the seam already
  returned true when absent); governance half by both runners via `gateAutomatedRuns`. Closed
  on the chained path too, which receives the flat deps whole and had the same hole with no
  signal. Parsed through `RecipeOrchestrator.loadRecipe` so the gate-build reading cannot
  drift from the execution reading; an unloadable recipe fails the run there. INVERTS one
  previously-pinned assertion that carried no rationale — flagged in the PR rather than
  landed quietly. — #1565

- 2026-08-31 `feat/evidence-field-roundtrip` — the evidence ledgers are copied field-by-field
  by hand (deliberately — a spread would let unvetted caller content reach disk), so a field
  can be declared, stamped by its producer, and dropped by a copy site nobody updated, with
  nothing failing. Four known instances beforehand, in BOTH directions: `workspaceId` (0 of
  272 rows), #1517's pair on the receipts READ path, `correlationId` on approvals (dropped
  twice in one change), and `ruleId`, whose copy site's own comment already named the first
  two. Sentinels typed `Required<T>` so a new field is a COMPILE error until represented;
  driven through the real writers AND readers; exclusions carry a reason each and are
  asserted to be real fields so the set cannot grow by accident. Found a fifth on its first
  run — `recipeName` reaches disk and dies in `list()`, so no reader had ever received the
  field the worker gate sets to distinguish its approvals. Mutation-checked both ways. — #1564

- 2026-08-31 `feat/gate-rule-id` — the Decision Record said WHY in prose and had no stable
  key for WHICH RULE decided, so a receipt, an operator filter or any grouping had to key on
  a sentence. `reason` and `ruleId` split into two fields with two jobs; nine terminal
  branches, nine ids, REQUIRED on the decision so a new branch is a compile error until it
  names its rule. `rv` 1 → 2, cumulative: 1 promises `correlationId`, 2 promises `ruleId`,
  and the bump strands no reader because `correlationOf` does not skip unknown versions.
  `ruleOf` keeps the middle state honest — a pre-rule row is `unversioned`, never "no rule
  applied". Names a rule the ENGINE applied, never a customer policy id (ADR-0019 reserves
  curated packs for the control plane). `record()` dropped it on the way to disk, the THIRD
  field that literal has had to be told about after `correlationId` and `workspaceId`, and
  its own comment already documents the trap. — #1563

- 2026-08-31 `codex/worker-reliability-fixes` — five reliability fixes for the maintenance
  workers, each one an existing subsystem answering a narrower question than the one an
  operator has. The approval seam collapsed four queue outcomes into a boolean, so an
  expiry nobody saw was reported as a rejection a human made — 49 approved / 7 rejected /
  27 expired / 23 cancelled in the durable log, and two of four halts that week ran to the
  300 000 ms TTL exactly. `workers validate` checked every way a manifest can fail to BIND
  and never asked whether the recipe on the other end runs: 8 manifests, "no problems
  found", one bound recipe failing `recipe doctor` with 8 errors and — found only once it
  looked — FIVE of eight workers bound to DISABLED recipes, four of which have no run in
  the log's whole 20-day span. The agent halt sentence kept the name of the pattern that
  matched and dropped the marker that says what happened, so an unreachable model endpoint
  and an ADR-0021 boundary refusal (remedy included in its own text) rendered identically.
  And `privacy_shadow.jsonl` carried no run id while `boundary_receipts.jsonl`, written 26
  lines away from the same dispatch, did — so "where do my live and candidate policies
  disagree, on this run?" was a join that could not be expressed. — #1562
- 2026-08-31 `feat/approval-log-correlation-id` — ADR-0025's named next stamp. The approval
  ledger carried no run reference on any of 215 live rows, so no run in the whole history
  could answer "who approved this, under what rule". The field that WAS there (`runSeq`) was
  supplied zero times in 105 request rows and carried an explicit instruction never to
  populate it — `seq` collides across the bridges that share the file — so it is retired
  rather than filled. Absence stays a STATE here and not a writer defect, unlike the gate
  ledger: two of the four paths into the queue are client-session tool calls with no run, so
  encoding absence as a defect would assert a run that never existed. Three of the four
  wiring hops drop a field silently — the dispatch helper destructures and rebuilds, the
  restore path enumerates, and `list()` projects — and the last two were caught by the tests
  rather than by reading the diff. — #1561
- 2026-08-31 `docs/evidence-spine-adr` — the Evidence Spine existed ONLY as a CLAUDE.md
  section, which records in its own text that both its load-bearing claims went stale or
  were wrong within two days. A third was found false the same week: "zero attribution rows
  exist anywhere" had cleared days earlier and was still being quoted as a live blocker while
  work was scoped around it. Splits the stable half (ADR-0025 — absence is never backfilled,
  design the sentinel then stamp, `taskId` never `seq`, no readers ahead of evidence) from
  the perishable half (the counts, which stay in CLAUDE.md behind an instruction to re-run
  the verb). Names `approval_log` at 0 of 215 as the next stamp and why it is binding rather
  than merely next. Docs only. — #1560

- 2026-08-31 `feat/gate-subpath-export` — `previewActions` exists so a screen showing
  "may do now / needs approval / not permitted" is computed by the code that ENFORCES it;
  that guarantee stopped at the package boundary. `exports` listed `.` and `./plugin` only,
  and `.` is also `bin` — importing the package root RUNS THE CLI rather than yielding a
  module — so an out-of-package consumer could not reach the gate and its only remaining
  option was re-deriving the three buckets from ledger rows by hand. A second implementation
  of the boundary arrived at by the export map being narrower than the guarantee, not by
  anyone choosing one. Adds a curated `./gate` barrel; publishes nothing new (`files` already
  carried `dist` wholesale). Tests assert the map entry AND reference identity — a barrel that
  adapts is the drift it exists to prevent, and a wrapper with correct behaviour today passes
  every behavioural test. — #1559

- 2026-08-31 `fix/orchestrator-drops-local-accepts` — #1554 dropped
  `resolveDestination`'s `localDestinationAccepts` on both its call sites, so the same policy
  gave two answers: the recipe path says LOCAL_ONLY ("a local destination accepts it, set
  `driver: local`") where the orchestrator said DENY ("no approval can unlock it"). Safe
  direction, which is why it would have survived review — nothing leaks and the refusal still
  fires. Wrong in the SENTENCE: it tells an operator their situation is unfixable while a
  registered local destination would take the data. Found by driving the DEPLOYED build after
  install, not by reading the diff. — PR pending

- 2026-08-28 `feat/weekly-sweep-deltas` — five read-only verbs each answer "what is true
  now"; none answers "what moved", and read fresh a denominator that has not shifted in three
  weeks looks identical to a gate that flipped yesterday. `patchwork sweep` composes them and
  diffs against the previous snapshot. Only TWO readings are gates — the evidence ratios fall
  by construction and an undeclared agent step is ADR-0021's documented default, so failing on
  either would make the command permanently red. A first run is a BASELINE, never "no changes".
  The snapshot holds counts only, reduced at the collection boundary: two inputs return operator
  data, and a health check is the last place anyone looks for accumulated secrets. — #1552
- 2026-08-30 `feat/orchestrator-boundary-default` — ADR-0021 left orchestrator dispatch
  ungoverned and named its own precondition: a path-level default "recorded honestly as a
  default rather than as a declaration", with the choice between that and a per-task label to
  be made from measured volume. The volume decided it — 10 orchestrator dispatches against 288
  recipe agent steps over 11 days, so an optional per-task label is a field nobody fills.
  `labelSource` gains a third value (`default`) and reaches the RECEIPT, not just the shadow
  row; the enforcing ledger previously could not tell an operator's label from the runtime's
  fallback. `boundaryScope.test.ts` is inverted rather than deleted. — PR pending
- 2026-08-30 `docs/adr-0024-field-level-labels` — closed ADR-0021's oldest open deferral with a
  `no`. Field-level labels (and with them `ALLOW_REDACTED` and purpose) were the stated
  prerequisite for two capabilities and had never been decided, so each attempt re-derived the
  same investigation. Declined on the ledger, not on taste: `ALLOW_REDACTED` has been returned
  0 times in 254 recorded decisions, and the 58-of-77 undeclared population that motivated
  DERIVING labels is now 0 of 74 — a figure CLAUDE.md was still quoting while work was scoped
  against it. The workable design is recorded rather than discarded, with a measurable trigger
  to reopen. — PR pending
- 2026-08-31 `fix/real-identifiers-in-shipped-artifacts` — a real Slack channel id shipped
  three times in one example and a real workspace channel name sat in a shipped template.
  `templates/` is packed into npm wholesale, so both were published AND copied onto every
  installer's machine as working configuration. Replaced with placeholders and gated by shape
  in CI. The private-identifier gate could not have caught them (denylist never enters the
  repo, so it cannot run in CI, and it only sees a staged diff). Digit requirement in the
  Slack pattern is load-bearing — without it the gate fires on COMPLETED / CONSEQUENCE /
  CONVERSION, which occur legitimately nine times. — PR pending
- 2026-08-30 `fix/approvable-is-a-dead-knob` — `approvable: true` can be set on a remote
  destination and never fire. Rule 1 tests `LOCAL_ONLY` before `approvable`, so with a
  permissive local destination (the recommended shape) the operator who asked to be asked is
  REFUSED instead — `LOCAL_ONLY` declines rather than rerouting. Reported by `privacy
  destinations`, deliberately NOT fixed by reordering, which would make live traffic newly
  approvable. Also corrects a claim repeated three times from handoff notes without checking:
  `REQUIRE_APPROVAL` is NOT unreachable. — PR pending

- 2026-08-28 `fix/pr-outcomes-swallows-the-real-error` — `gh repo view` ran with stderr
  ignored, so an expired credential, a missing gh and a missing remote all reported the same
  guess about the repository. A stale `GITHUB_TOKEN` produced `HTTP 401` and the operator was
  told to pass `--repo`, which would not have helped. The sibling query path in the same
  command already piped stderr; detection now matches it. — merged as #1547

- 2026-08-27 `feat/authority-delta-classifier` — a repository gate must judge a manifest edit
  with the SAME primitives that govern the worker at runtime, or the two notions of authority
  drift silently and permissively. One inversion is the point: `parseForbidRules` fails OPEN
  at runtime (correct there — a banned action degrades to merely gated, and a human still
  approves it), but a gate cannot report "I could not read your deny-list" as "looks fine".
  Deleting a manifest is a WIDENING — the gate is a floor over the tier fn. — merged as #1545

- 2026-08-27 `feat/pr-outcome-ledger-phase-1` — the one roadmap item that is wall-clock
  bound: outcome history accrues only with time and a day not recorded cannot be recovered.
  Raw observations, no derived score, `authorIsWorker` omitted rather than defaulted when no
  roster exists. Leads with how many PRs have more than one observation, so a one-shot
  backfill cannot read as accumulated history. — merged as #1544

- 2026-08-27 `feat/privacy-destinations-disclosure` — the operator's choice already existed
  and was invisible: clearing a remote destination for `personal` is one line of config, and
  nothing said which destinations leave the machine. Adds no policy primitive; a
  recipe-scoped allow-list would put recipe identity into the decision point and smuggle in
  `purpose` early. The disclosure names no retention or training claim, because such a claim
  rots without a code change. — merged as #1543

- 2026-08-26 `feat/local-driver-has-no-tool-surface` — the worker-sandbox guard refused every
  non-subprocess driver, collapsing "cannot enforce a deny list" with "would run
  un-sandboxed". `local` is the first and not the second: `localFn` is `(prompt, model)` and
  the tool-bearing `cliOpts` reaches only `claudeCliFn`. It was the only driver that could
  receive `personal` data, so a worker recipe could be honestly labelled or could run, never
  both. Pinned by an arity guard test. — merged as #1541
- 2026-08-26 `fix/recipe-run-exits-0-on-a-failed-run` — the local-run branch ended in an
  unconditional `process.exit(0)`, in the same block that computes `summary.ok` and records
  `status: "error"`, so `patchwork recipe run X && echo ok` printed `ok` after a failure and
  silently greened every cron caller. Same family as the `doctor --expect-running` gap.
  — merged as #1540
- 2026-08-26 `fix/recipe-new-emits-unparseable-yaml` — the non-interactive scaffold
  substituted the description raw, and the CLI's own default is `Recipe: <name>`, so every
  recipe scaffolded without `--desc` was invalid YAML while `recipe new` printed
  "✓ Created". `yamlScalar` already existed and the interactive path already used it; only
  the template path did not. `runNew` now parses what it writes. — merged as #1539

- 2026-08-26 `fix/expiry-never-reached-the-durable-log` — ADR-0018's live TTL timer tore its
  entry down inline and never persisted, so an approval that expired on a running bridge left
  `approval_log.jsonl` holding a bare `request` — indistinguishable from still-pending, and
  self-healing only on restart. Fixing it exposed a second question: with two queues over one
  log dir, both timers fire, so expiry is now written by the OWNER only. — merged as #1537
- 2026-08-26 `fix/set-password-muted-stdout-permanently` — readline's `output` IS
  `process.stdout`, so muting the echo overwrote `process.stdout.write` and unmuting read
  that no-op back, rebinding the mute forever. The `Confirm:` prompt was invisible and the
  operator confirmed blind; the only visible line came from stderr. This is why the roster
  still had a member with no credential. — merged as #1538

- 2026-08-26 `feat/privacy-undeclared` — ADR-0021 is fail-soft, so an agent step with no
  `data_policy` is classified `internal` and passes; correct as a default, and it makes an
  undeclared step invisible in a way a declared one is not. Measured: 132 of 214 shadow
  observations are `assumed`, and 58 of 77 agent steps across 82 installed recipes declare
  none — against 0 of 22 in shipped templates, so the biggest under-classified population
  is on a channel that ALREADY EXISTS with 22 worked examples. `recipe lint` warns per
  recipe and `privacy suggest` covers undeclared DRIVERS; nothing was fleet-wide. Reports
  the TOOL OUTPUTS feeding each step, which is the point rather than a nicety: a step is
  classified by what it HANDLES including whatever its tools return, so a prompt
  mentioning nothing sensitive can still be handed a mailbox by the step above it.
  SUGGESTS NO CLASSIFICATION, deliberately — a declared-but-wrong label is worse than an
  assumed one because it stops looking like a gap. Corrects a figure published earlier the
  same day: doc-19's 20-of-87 came from a regex sweep that over-counted; the YAML parse
  gives 19 of 77. (#1536)

- 2026-08-26 `feat/evidence-join-coverage` — the Evidence Spine section tells the next
  session to re-measure join coverage before scoping a cross-ledger reader, and records
  that its own figures went stale within two days; doing so took a bespoke throwaway
  script every time, which is how a check that must be re-run stops being re-run.
  `patchwork evidence` reports the denominators: gate decisions 1 of 273, boundary
  receipts 14 of 170, the other three 0, and ZERO runs reachable in both joined ledgers.
  That zero is the finding — item 7 is NOT unblocked by the sentinel shipping, because the
  sentinel settled HOW to stamp and almost nothing is stamped; the two populations barely
  overlap by construction (gate rows come from worker recipes under the autonomy flag,
  receipts from agent steps with a registered destination), so the join is sparse rather
  than young. Denominators, NOT the reader. ABSENT is reported distinctly from 0 rows
  (permission_exercises is absent because no grant has ever happened — correct, not a
  gap). COUNTS ONLY, never a row or an id, since a correlationId IS a taskId — so unlike
  `runstore compare` its output is safe to quote. Always exits 0: zero joinable rows is a
  true state, not a failure. Note for whoever mutation-tests next: the first attempt at
  the leak mutation was a NO-OP that passed and proved nothing. (#1535)

- 2026-08-26 `fix/doctor-two-handlers` — two top-level `argv[2] === "doctor"` blocks; the
  deployment-freshness one won every time (stable over five runs, zero health-check
  lines), so `commands/doctor.ts`'s four config checks never produced output and
  `runDoctor`'s one production caller was unreachable. Its tests passed because they call
  it directly with a mocked dependency — logic proven, wiring never exercised — so the new
  test SPAWNS the built CLI. Worse than dead code: `--help` was answered by the LOSING
  block, so the documented behaviour of `patchwork doctor` described checks that did not
  run and omitted `--expect-running`, the flag the repo relies on after every kickstart.
  Config checks moved to `doctor health` as a SUBCOMMAND, not folded in: `doctor`'s exit
  code is load-bearing (`patchwork doctor && echo deployed` is a real shape), so a failing
  config check must not newly fail it. Recorded honestly in the test file: removing the
  routing guard restores the collision and every test still passes — what is pinned is the
  OUTCOME, not the guard, because once each block answers its own `--help` the collision
  is unobservable from outside. (#1534)

- 2026-08-26 `fix/session-secret-file-permissions` — `$PATCHWORK_HOME/.env` holds
  `DASHBOARD_SESSION_SECRET`, so forging one mints a cookie naming any member: the whole
  ADR-0020 scheme. `credentialStore` tightens its own file on read for exactly that
  reason; nothing did for `.env`, found at mode 644 on the reference machine. The trap
  that hid it: `patchworkInit` DOES pass `{ mode: 0o600 }`, but `writeFileSync` applies
  `mode` only when CREATING a file — on an existing one Node ignores it silently, so a
  file that ever became loose stayed loose however many times init ran, with the line that
  appears to set the mode sitting there reading as correct. Fixed at both ends (init
  chmods after writing; the reader tightens AND reports, because silently repairing leaves
  the operator unaware and the message has to say to rotate — tightening does not
  un-disclose what was already readable). Reported via an optional `onWarn` rather than a
  changed return shape: a second exported reader for one path is how two readers come to
  disagree. Skipped on win32 in both places, since NTFS reports 0o666 regardless and a
  warning that always fires is how a real one gets ignored. Still returns the secret when
  loose — refusing would turn a permissions problem into an attribution outage. (#1533)

- 2026-08-26 `feat/template-completion-contracts` — #1528's `contract_failed` category
  could never fire: 82 installed recipes, 10 with a step-level `expect`, ZERO with a
  run-level one. Adds contracts to the three templates that end in an agent step whose
  output IS the artifact (`daily-status`, `morning-brief-slack`, `release-notes`), which is
  the failure this family actually has — every step ok, run `done`, and the final step
  writes a heading with nothing under it. Asserts ONLY the artifact: the upstream fetch
  steps may legitimately come back empty, and turning a quiet day into a halt is a contract
  that cries wolf. NOT added to the other five candidates — four have no agent step and one
  produces no single named artifact, so the postcondition would have to be arbitrary.
  Verified both directions: `release-notes` passes and fails when the asserted key is
  changed to one nothing produces; `daily-status`'s contract FIRES on the real template
  because its agent step fails under `recipe test`. Recorded rather than glossed: two of
  the three already failed `recipe test` on main (failed agent fetch; four missing
  connector fixture libraries), and that missing `~/.patchwork/fixtures` directory is the
  same precondition making a worker eval harness premature. (#1532)

- 2026-08-26 `feat/workers-list-validate` — four ways a worker manifest is installed and
  governs NOTHING, all silent: it does not parse (`loadWorkersFromDir` is fail-soft and
  logs only when given a logger, which the resolution path does not pass), its `recipe:`
  is not installed, two manifests claim one recipe (resolution refuses to guess, so BOTH
  lose — there is no winner), or a `forbids` entry does not parse (a dropped deny-rule
  fails OPEN, degrading a banned action to merely gated). All four end at
  `resolveWorkerIdForRecipe` returning undefined and the run falling back to the tier fn —
  and since the worker gate is a FLOOR over that fn, losing it governs the recipe LESS.
  `detectWorkerManifestDrift` existed but printed only in the bridge STARTUP log; now an
  operator can ask. Read-only, exits 1 when unhealthy (including `list` — an ignored
  manifest is a gap, not a note), and leads with the denominator so an empty directory says
  "nothing to check" rather than "no problems". NO `install` verb: a package format must
  answer the third-copy problem that `manifestDrift` exists because of. The reference
  install was healthy on all four checks, so the validator was built against deliberately
  broken fixtures — one that has only seen healthy input is not known to be able to fail.
  (#1531)

- 2026-08-26 `feat/step-expect-required` — both runners evaluate `step.expect` only on a
  step that RAN, so an expectation on a `when:`-guarded step could never fail. Opt-in
  `expect.required` (default false, so nothing existing changes) makes a `when:`-skip of a
  required step an `expect_failed` error the halt count can see. Written for BOTH runners
  in one change — a mutation disabling only the chained half fails the suite — and scoped
  to the `when:` guard ONLY, leaving the guard-tested unregistered-tool skip untouched.
  The schema diff is large because adding one property forced a regeneration, which
  revealed the committed schemas were 184 lines BEHIND their generator; the published copy
  being LOOSER than the runtime validator is the dangerous direction, since an editor
  loads it through the SchemaStore pragma and tells the author their recipe is fine.
  `audit-generated-schemas.mjs` now gates it: compares in memory and never writes (a gate
  that fixes what it checks lands the fix unreviewed), names files not schema bodies, and
  exits NON-ZERO as NOT VERIFIED when `dist/` is missing. Recorded and not changed: an
  unresolvable `when:` ref is a template ERROR on chained and merely falsy on flat. (#1530)

- 2026-08-26 `feat/halts-see-completion-contracts` — a run that violated its run-level
  `recipe.expect` finished `done`, and `summariseHalts` only emits a run-level entry for
  `status === "error"`, so the operator-facing halt count could not distinguish "nothing
  halted" from "the job finished without delivering what it promised". Adds
  `contract_failed`, counted ONE per run rather than one per assertion (three failures are
  one contract broken three ways; counting three inflates the number against the
  "incomplete jobs" reading it exists for) and NOT guarded on the step count, unlike
  `run_level` — a postcondition violation is a different fact from a step error, not the
  same one restated. Would have shipped INERT: measured 1455 run rows with 0
  `assertionFailures`, because no shipped template declared a run-level `expect`, so
  `morning-brief` now promises its `brief` output. Also closed a pre-existing drift the
  work surfaced: `judge_revisions_exhausted` was in the bridge union and absent from the
  dashboard's entirely, which no compiler could catch — a `Record` over a SHORTER union is
  well-typed — so the two unions are now compared as text by a test. (#1528)
- 2026-08-26 `feat/chained-run-level-expect` — `recipe lint` accepted a run-level `expect:`
  on a chained recipe with ZERO warnings and the runner dropped it; `dispatchRecipe` casts
  a `YamlRecipe` straight across, so the block was on the object at runtime and
  `ChainedRecipe` simply had no field for it. Reproduced against a real run first: two
  impossible assertions, `status: done`, `assertionFailures: None`. `outputs` deliberately
  means STEP IDS here and `into:` keys / resolved paths on the flat runner — a flat-style
  entry fails loudly instead of passing, and lint now warns on a path-shaped entry
  (never on a flat recipe, where a path is correct). A THIRD implementation turned up on
  the way in: `recipe test` evaluated the chained contract itself with `outputs: []` and
  `summary.total`, so every `outputs` assertion failed there regardless of the recipe and
  skipped steps were counted — on the very surface an author uses to check their contract.
  Collapsed to the runner's result. NOT fixed and called out rather than left to be
  rediscovered: `recipe run --local` passes no `runLog`/`runLogDir`, so a chained CLI run
  writes no runner row at all. (#1529)

- 2026-08-26 `feat/durable-approver-attribution` — ADR-0020 Phase A resolved the approver
  and then put the name somewhere it could be thrown away. `approvalHttp` verifies the
  member's own signed session AFTER `queue.approve()` has landed the decision (deliberate:
  identity must never block or alter an approval), and handed the name to the
  `approval_decision` audit hook — whose only production sink is `activityLog`, which
  ROTATES and halves itself when it grows. The one record of who approved a gated action
  was the one record allowed to discard its oldest rows, while `approval_log.jsonl` had no
  actor field at all. Adds a third append-only event kind, on both the approve and the
  reject path, because attributing only the yes makes the log a record of who permits
  things and never of who stopped them. A third EVENT and not a field on `decision`: the
  decision row is written before the approver exists, so resolving first would invert the
  ordering and rewriting the row afterwards is the mutable store the log rules out. No
  sentinel needed — existing rows are untouched, and `loadUnresolvedRequests` already
  ignores unknown kinds, which is now commented as load-bearing rather than incidental.
  The consumer already exists one repo over and filters strictly on `kind`; that was
  VERIFIED (identical measures over a synthetic log with and without the new rows) rather
  than assumed, and it could have failed — an earlier version of that function counted
  rows. Also corrects the stale comment the whole finding came through: the `gate` branch's
  actor omission was justified by "an in-memory Map with a 5-minute TTL", which ADR-0018
  made false; the conclusion survives its premise. (#1527)

- 2026-08-25 `docs/evidence-spine-after-1522` — the "next join" note added that morning
  described `boundary_receipts.jsonl` as the unbuilt next step and told a future session how
  to build it; #1522 then built it, so the note became an instruction to redo finished work.
  Replaced with how it was actually done (the dep-builder ordering problem generalises) and
  with the MEASURED status of the remaining three, so the next session scopes from numbers
  rather than from a survey: `permission_exercises.jsonl` has no grants at all and must not
  get a join yet; `outcome-log.jsonl`'s hazard is meaning, not plumbing (a bare
  `correlationId` would be ambiguous between the run that FILED an action and the run that
  JUDGED it); `worker_trust/` is derived state, not events. Also records that an
  unregistered tool id skips silently BY DESIGN, guard-tested, and that `recipe doctor`
  already reports it per step — two builds were spent rediscovering that. (#1525)
- 2026-08-25 `docs/adr0020-unattributed-session` — closes the last question ADR-0020 left
  open: what an unattributed (`v1`) dashboard session may do once authorisation is enforced.
  Decision: exactly what it does today, minus the actions that structurally require a named
  subject — approving a gated action. Additive, so no existing install starts failing on
  upgrade, and the only new refusal is on a path that could never have been honestly
  attributed. Records that the reference deployment now HAS a `members.json` with one real
  member and the bridge logs "a verified dashboard session will name the approver" in place
  of the implicit-owner warning. (#1526)

- 2026-08-25 `feat/run-id-in-templates` — a published artifact could not cite the run that
  produced it. The flat runner injected `date`/`time`/`YYYY`… into the template context but
  never the run's own identity, and `{{taskId}}` failed template-ref lint outright, so an
  audit pack or reconciliation workbook had no way to name its own run — the ledger knew
  the `taskId`, the document could not reach it. Same join the gate ledger and boundary
  receipts now carry, and the same rule: `taskId`, never `seq`. `runTaskId` was declared
  ~140 lines BELOW the context, so it is lifted rather than recomputed — two expressions
  that look identical drift on the first edit to either. Injected AFTER the env/seed
  spreads, unlike `date`, so a recipe variable cannot shadow it: an absent id is
  recoverable, a confidently wrong one is not. Verified end to end — the artifact's id and
  the run-log row's `taskId` are identical strings. (#1524)

- 2026-08-25 `feat/butler-shadow-rows` — `butler shadow` closes by telling the operator to
  "check a sample against the real errands they describe" before promoting, and gave them
  no way to do it: the summary was all `--json` printed, and `readShadowRows` had exactly
  ONE caller in the tree — `promoteShadowOutcomes`, the irreversible step. The only code
  that read the individual rows was the one that acts on them, which matters because
  promotion is one-way (trust replay absorbs a folded row into a checkpoint that deleting
  the row does not undo). Adds `shadow --rows [N]`, evidence-bearing rows first, with the
  operator-data warning `runstore compare` and `privacy receipts` carry. The wiring test
  is the load-bearing one: mutating the flag lookup makes `--rows` fall silently back to
  the summary while all six formatter tests still pass. (#1523)
- 2026-08-25 `feat/boundary-receipt-correlation` — the second ledger joins. A boundary
  receipt now carries `correlationId` (the run's `taskId`, never `seq`) behind an `rv`
  record level, the protocol #1519 settled for the gate ledger. `recipeName` said WHICH
  recipe to fix; an hourly recipe still produced receipts no reader could tell apart.
  The reason this was not a one-liner: one write site, four dep-builders, and
  `buildChainedDeps` is called from three places BEFORE `runChainedRecipe` computes its
  run id — so the chained path had nothing to pass. Closed with a cell created by
  `buildChainedDeps` and filled by the runner, rather than filling the field on the flat
  path only, which would have repeated the `stepId` this same ledger once declared, never
  supplied, and removed rather than wired. Also fixes the READER, which enumerated fields
  explicitly and would have dropped both new ones — #1517's defect, caught before shipping
  rather than after. Sentinel: a receipt is never written outside a run, so absence of
  `correlationId` at `rv >= 1` is a writer defect, not a state. (#1522)

- 2026-08-25 `feat/completion-contracts-trust` — bind the completion contract that already
  runs. `evaluateExpect` has evaluated `recipe.expect` on every non-testMode flat run since
  it shipped and persisted `assertionFailures`; the trust fold read `step.status` only, so a
  run that violated its declared postcondition still folded each ok step as earned trust —
  failing a completion contract cost a worker nothing. The run-level signal now reaches
  `foldOutcome`, which WITHHOLDS every step of a violating run (neither credit nor penalty,
  the same shape as the agent-step and unkeyable-action rules). Passed as a parameter to
  `foldOutcome` rather than checked in `ingestRun`, so the live dial and the cold-start
  backtest cannot drift. Also corrects the schema description, which called the feature
  "assertions for mocked recipe tests" — the docs and the code disagreed about what it was,
  which is the likeliest reason zero shipped templates use it. Measured before landing: 0 of
  1404 runs in the live log carry `assertionFailures`, so nothing is re-labelled
  retroactively. (#1520)
- 2026-08-25 `docs/evidence-spine-current-state` — the Evidence Spine section's two
  load-bearing claims were both wrong within two days of being written, and they mis-scoped
  a session before being caught. `GraduationEvent` IS persisted (`toJSONL` writes
  `rec: "event"`, `saveTrustCheckpoint` calls it); the real fact is narrower — the only
  checkpoint on disk holds zero event rows because nothing has ever graduated, which is a
  dial that has not moved, not a hole to plumb. And `worker_gate_decisions.jsonl` now DOES
  carry a correlation id, as of #1519 deployed the same day. Also records why the next join
  (boundary receipts) is a design step rather than a one-liner: `buildChainedDeps` is called
  before `runChainedRecipe` computes `runTaskId`, so the chained path has no run id at
  deps-build time, and filling the field on the flat path only would repeat the `stepId`
  mistake this ledger already made once. (#1521)

- 2026-08-25 `feat/correlation-sentinel` — the correlation-id sentinel (the irreversible
  decision doc 13 §4.1 reserved for the owner), settled by adversarial review first. A gate
  decision now carries `rv` (writer-stamped record level) and `correlationId` (the run's
  `taskId`, never `seq`, which collides 255-of-272). Absence of `rv` is the sentinel and is
  never backfilled — a reader must not default it, since `parsed.rv ?? 0` is a backfill
  performed invisibly on every load. Consolidates THREE identical declarations of the approval
  input into one shared type with a REQUIRED `runTaskId`, so a new approval call site is a
  compile error until it names its run. Found en route: `record()` was silently dropping
  `workspaceId`, which is why 0 of 272 live rows carry a workspace tag despite the orchestrator
  stamping every one.

- 2026-08-25 `fix/dashboard-renders-forbid-as-gate` — the dashboard typed a gate decision's
  `action` as `"allow" | "gate"` and rendered `isAllow ? "ALLOW" : "GATE"`, so ADR-0017's
  terminal `forbid` displayed as a GATE with the explain line "vs required higher" — telling
  the operator to seek more approval for the one thing no approval unlocks. Extracts the
  labels to `lib/gateAction.ts` sharing ControlBoundary's wording (distinct in WORDS, not only
  colour), widens the type, adds the missing `td-gate-verb-forbid` style on the shared
  `--err-text` token. Unknown actions fall back to the forbid presentation. FIRST of the
  sentinel preconditions — must land before `consumeRawJsonl` accepts `forbid`.
- 2026-08-25 `fix/forbid-rows-dropped-on-read` — `record()` validated all three actions while
  `consumeRawJsonl` accepted only `allow` and `gate`, so a `forbid` row was written correctly
  and dropped by every subsequent read — surviving in the writing process's memory ring and
  vanishing at the next restart. ADR-0017's terminal state was invisible in `gate explain`,
  `GET /gate/decisions` and the dashboard. One shared `isGateAction`, since two independently
  hardcoded lists is the mechanism of the bug, not a duplication smell. SECOND sentinel
  precondition; requires the dashboard widening to land first.
- 2026-08-25 `fix/rotation-destroys-half-the-trust-ledger` — `rotateDisk` HALVED the file
  (`slice(-floor(length/2))` in a `while`), so crossing the 1 MB cap by one row discarded ~50%
  of the autonomy gate's trust evidence and audit trail, oldest-first, silently. Measured: it
  left 525,829 bytes of a 1 MB budget. Replaced with trim-to-target (90% low-water mark) and a
  dropped-row COUNT — rotation deletes oldest-first, i.e. exactly the rows lacking any newer
  field, so a coverage measure over this file converges to 1.0 BY DELETION and reads
  identically to a real improvement. Byte length not UTF-16 length, since the trigger is
  `st.size`. THIRD sentinel precondition.

- 2026-08-25 `docs/transport-elicit-has-a-caller` — `transport.ts`'s note asserted `elicit()`
  had NO in-repo caller and must not be cleaned up. #1218 wrote that; #1223 added the caller
  (`recipes/elicitMissingVars.ts`) eight days later and closed #1217 with it, and the note was
  never updated. A roadmap survey on 2026-08-23 then read the stale note, concluded the path
  was dead and #1217 was work pointed at nothing, and ranked it on that basis — while #1217
  had been CLOSED three weeks earlier. Corrects the note and gates its factual half.
- 2026-08-25 `fix/gate-explain-false-era-claim` — `gate explain` told the operator every
  actor-less row "pre-dates actor attribution". An actor is stamped only on `allow`
  (`recipeOrchestration.ts` says why at length: on `gate` the approving human is not known at
  decision time, on `forbid` nobody acted), so those absences are CURRENT POLICY, not history.
  Measured on the live ledger: 272 rows, 47 `gate`, all 47 given the false era claim. The
  two-absences collapse the Decision Record's own doctrine exists to prevent, already shipped,
  in the surface an operator actually reads. Composes the explanation with `action`; no stored
  data changes.

- 2026-08-25 `fix/plugin-tools-outside-sandbox-universe` — the agent-step sandbox built its
  universe from two static module constants, so no plugin-registered tool could ever be
  enumerated, classified or denied. Measured under one worker and one empty store:
  `decideWorkerAction` returned `gate` for both a plugin tool and `slackPostMessage`, and only
  the latter reached `--disallowed-tools`. Threads the live registry in through a thunk (not a
  snapshot — `--plugin-watch` would otherwise reopen it) and narrows the other-domain
  exemption, which alone is inert because an unknown name infers `tier=medium, domain=other`.
- 2026-08-25 `test/proxy-session-forwarding-guard` — the dashboard proxy's session-forwarding
  block is the only path by which a bridge can attribute an approval to a named member
  (ADR-0020 Phase A). Measured: deleting it outright left the dashboard suite at 126 files /
  1299 tests, ALL GREEN — a total, silent loss of approval attribution passed every check we
  had, because unattributed is a legitimate state and looks like normal operation. Adds a
  test asserting the scoping in BOTH directions; a happy-path-only test would pass equally
  well if the scope were widened to every request, which is a credential leak rather than an
  attribution loss. Both mutations verified to fail.
- 2026-08-25 `fix/warn-when-production-auth-bypassed` — the middleware's loud `DANGEROUS:`
  warning for `DASHBOARD_ALLOW_UNAUTHENTICATED=1` lived in the branch reached only when a
  password IS configured. The other branch (no password at all, so strictly less secure)
  returned `next()` in production silently, because the bypass flag turns its 503 off. Whether
  an operator was warned depended on whether a password happened to be set, and the worse
  configuration was the quiet one. Warns, does not refuse — the flag is an explicit choice and
  refusing would break a deployment working as intended. Both directions mutation-tested,
  including that development stays quiet.

- 2026-08-24 `fix/attribution-secret-reachability` — #1509: ADR-0020 attribution was shipped
  and unreachable on nearly every launch path — `src/index.ts` builds its dotenv candidates
  from `import.meta.url`, so it read `<install-dir>/.env` (destroyed by
  `npm run install:global`) and never `$PATCHWORK_HOME/.env`. Measured: all three live
  bridges lacked the variable while the secret sat correctly on disk. Adds a single-key
  Node-side reader injected into `dashboardSession` — not a second dotenv load, because
  agent subprocesses inherit `process.env` wholesale. — main session

- 2026-08-24 `feat/butler-shadow-reason-breakdown` — #1508: `butler shadow` reported one
  `unknown` count covering two opposite situations — `open-recent` (looked; errand still in
  flight, so wait) and `not-observed` (could not look, so go fix the path). The rows always
  carried `reason`; only the summary discarded it. Adds a per-reason breakdown and splits
  the unknown line. — main session

- 2026-08-24 `fix/guard-self-confirmation-invariant` — #1507: "a worker cannot self-confirm
  its own filings" is true, but CLAUDE.md attributed it to the wrong mechanism
  (`outcomes confirm|reject` being CLI-only). `outcomes.classify_issues` is a recipe tool
  that also writes dispositions. What actually holds the property is that no recipe-facing
  `github.*` tool can mutate issue state — a load-bearing absence with no test on it, until
  this added one. — main session

- 2026-08-24 `chore/example-recipe-neutral-name` — #1506: gave one example recipe and its
  two references a neutral identifier, per the repository-privacy convention. The recipe's
  own contents were already neutral; only the filename was not. — main session

- 2026-08-23 `docs/undocumented-subcommands` — #1505: nine subcommands dispatched and
  appeared in no doc, and `audit-docs-wired` had been printing them as informational and
  exiting 0. Documents all nine, fixes the dead `--help-flags` pointer, and (after #1503
  landed) documents `privacy receipts` and corrects `recipe record`, which was wrong in
  both its argument and its semantics. — main session

- 2026-08-23 `feat/privacy-receipts-reader` — #1503: `boundary_receipts.jsonl` was
  write-only in this repo — `recent()`/`summary()` had no production caller, so the only
  reader of our own ADR-0021 enforcement evidence lived in the non-MIT control plane, the
  ADR-0019:88-92 failure arrived at by default. Adds `patchwork privacy receipts`,
  `GET /privacy/receipts` and a dashboard page. Reads the FILE, not the class, which trims
  to 500 rows and would serve that as a total. — main session

- 2026-08-23 `fix/digest-prompt-safety` — #1504: `ctxSaveTrace` text was spliced into
  `buildInstructions()` unsanitised, so a saved trace could forge an instruction heading
  in the block every later session reads as authority. The Butler card renders into the
  SAME prompt a few lines away and had `sanitizeForPrompt` since it shipped — one
  prompt-rendering path hardened, its neighbour not. Helper LIFTED to
  `src/promptSafety.ts` rather than copied. — main session

- 2026-08-21 `fix/roster-unreadable-is-not-an-owner` — #1501: `loadRoster` answered five
  situations with one implicit OWNER, four of which mean "a membership decision exists and
  we could not read it" — so corrupting `members.json` was a way to become the owner.
  Inert today (zero production call sites consult the roster to permit anything), which is
  the argument for fixing it before the first consumer arms it. — main session

- 2026-08-21 `docs/adr-0023-sync-model` — #1500: ADR-0023. The multitenant fork's
  `COPY src/` had drifted 145 files since its last sync (2026-06-08) and every governance
  feature built here since was absent from it, so a fix landed here reached zero hosted
  tenants. Decided: the tenant image installs a pinned `patchwork-os` from npm. — main session

- 2026-08-21 `docs/prune-two-false-claims` — #1499: two CLAUDE.md claims were false and both
  mis-scoped work — the "verbatim vendored copy" of `src/`, and the session cookie payload
  being "literally `v1.${expiresAt}`" (dead since ADR-0020 Phase A). Called out rather than
  deleted. — main session

- 2026-08-20 `fix/cron-claim-legacy-json` — #1463: both cron guards lived inside the
  `if (yamlPath)` branch, so the legacy-JSON dispatch site had neither. Hoists the claim
  above the fork; the in-flight guard cannot follow (`enqueue` gives no completion
  signal, so a name added there would never clear). — main session

- 2026-08-20 `fix/token-efficiency-env-isolation` — #1483: `findActiveLockFile` short-circuits
  on `PATCHWORK_BRIDGE_PORT` before the discovery path the tests mock, so three tests failed
  on any machine with the documented variable set while CI stayed green. — main session

- 2026-08-20 `fix/doctor-expect-running` — #1481: `doctor`'s denominator is locks that
  EXIST, not bridges that SHOULD exist, so it exits 0 when a bridge is missing — including
  when nothing is running at all. Adds `--expect-running [N]`. — main session

- 2026-08-20 `docs/classify-by-what-a-step-handles` — #1473: an author classifies what the
  prompt shows, but a tool-enabled step's prompt is instructions to FETCH, so it
  under-classifies. ADR-0021 paragraph + worked example, plus a `recipe lint` WARNING (never
  an error) on the population most likely affected. — main session

- 2026-08-20 `fix/butler-promote-denominator` — #1477: the promote report counted ledger
  ROWS in its headline and distinct ACTIONS in the breakdown, with nothing saying the unit
  changed, so its arithmetic did not close on the screen a person reads before a one-way
  write. — main session

- 2026-08-20 `fix/butler-errand-project-id` — #1464: butler-errand template passed `project_id`
  where `todoist.create_task` declares `projectId`, so every errand filed to the default
  inbox. One-line template fix + a scoped regression test. — main session

- 2026-08-19 `fix/evidence-workspace-seed` — the evidence workspace tag (#1455) records WHICH PROCESS
  wrote the row, not which workspace. `evidenceWorkspaceId()` in `yamlRunner` calls
  `resolveWorkspaceRoot()` with no seed, so it walks up from `process.cwd()`. Measured: two bridges
  serving the SAME workspace, one with cwd `~` (no `.git` ancestor → every row untagged) and one with
  cwd in the repo (tagged) — 22 of 40 shadow rows tagged, 0 of 4 boundary receipts. Two sibling call
  sites already seed correctly (`recipeOrchestration.ts:1607`, `claudeOrchestrator.ts:532`); this is
  the third and it is the one writing privacy evidence. Seeds from `stepDeps.workdir`, which
  `bridge.ts` already fills from `config.workspace`. Existing untagged rows are NOT backfilled.
  Touches `src/recipes/yamlRunner.ts` — collides with any privacy, evidence or recipe-runner work.
  — this session — merged as #1475

- 2026-08-19 `fix/boundary-receipt-attribution` — #1469 attributed the SHADOW ledger to its recipe
  and left the ENFORCING one anonymous: `recordBoundaryDecisionFn` sits 26 lines below
  `recordPrivacyShadowFn` in the same object literal and never passed `recipeName`, though
  `BoundaryReceipt` has declared the field throughout. So the ledger ADR-0021 calls the audit
  record — the only one that can say why a step actually failed — could report that a `personal`
  dispatch was refused without naming which of 80 recipes to fix. Measured first: nine receipts
  from four live probe runs, three of them LOCAL_ONLY refusals, none attributed. Also makes the
  LOCAL_ONLY refusal name its remedy; the remedy goes BEFORE the reason because
  `stepObservation`'s 120-char silent-fail cap was amputating it mid-word. Touches
  `src/recipes/yamlRunner.ts` and `src/recipes/agentExecutor.ts` — collides with any privacy,
  agent-executor or recipe-runner work. — this session — merged as #1474

- 2026-08-19 `fix/1469-shadow-attribution` — #1469. The shadow report said "23 of 29 rows carry a
  DEFAULTED classification" and gave no way to find WHICH of 80 recipes to go and label. `ShadowRow`
  already declared `recipeName` and nothing supplied it — declared-but-supplied-nowhere, on a
  surface the wiring guard does not cover, while the boundary RECEIPT log declares and populates
  the same field. Populates it from `StepDeps` (already there for the circuit breaker), adds a
  worst-first per-recipe breakdown, and counts the unattributable remainder rather than dropping
  it. REMOVES the sibling `stepId`, which nothing can supply at that seam. Touches
  `src/privacy/shadowLog.ts` and `src/recipes/yamlRunner.ts` — collides with any privacy or
  agent-executor work. — this session — merged as #1472

- 2026-08-19 `fix/1467-misplaced-data-policy` — #1467. A `data_policy` declared as a SIBLING of
  `agent:` instead of inside it is read by nothing, and `recipe lint` passed it: the run succeeded
  and the boundary row came out `assumed`, indistinguishable from a step that declared nothing.
  Reproduced end to end before fixing. Now a lint ERROR naming the remedy, following the
  `compoundSteps.ts` precedent (lint and runtime verdicts must not drift). Exempts the two correct
  placements — inside `agent:`, and on a `fan_out` step (#1466). Touches
  `src/recipes/validation.ts` plus a new `src/recipes/dataPolicyPlacement.ts` — collides with any
  recipe-validation or privacy work. Was stacked on #1468 and has been rebased onto main now that
  it merged; the ORDER mattered — landing this lint rule first would have made a `fan_out` step
  with `data_policy` pass lint while the runtime still ignored it, which is the exact silent
  failure the rule exists to prevent. — this session — merged as #1471


- 2026-08-19 `fix/1466-fanout-data-policy` — #1466. `fan_out` is how a recipe processes a BATCH,
  and it was the one step that could not declare a classification: the iteration allowlist refuses
  `do.agent.data_policy`, and there was nowhere else to put it. So in `private-document-digest` the
  step handling RAW documents N times dispatched at the default `internal` while the step seeing
  only redacted extracts could be labelled — the wrong way round. Accepts `data_policy` on the
  fan_out STEP and applies it to every iteration; the iteration allowlist stays an allowlist
  (refusing it there is correct — same reasoning as `sandbox: true`), and the error now says where
  the label belongs. Touches `src/recipes/tools/fanOut.ts` and `runNestedAgent` in
  `src/recipes/yamlRunner.ts` — collides with any fan_out, agent-executor or privacy work.
  — this session — merged as #1468

- 2026-08-19 `feat/butler-promotion` — the last unbuilt step of Butler phase 2. `outcomeShadowLog.ts`
  says `OutcomeStore.upsert` is "deliberately NOT implemented here"; this implements it, in a
  SEPARATE module, so the grader's and ingester's "cannot reach OutcomeStore" guards stay intact
  rather than being deleted to make room. Flag-gated OFF (`PATCHWORK_FLAG_BUTLER_PROMOTE`) because
  promotion is one-way and the ledger currently holds ONE confirmed row. Operator-only, never a
  recipe tool (asserted). Adds `patchwork butler promote [--dry-run]`. Touches
  `src/butler/outcomeShadowLog.ts` (one shared parse rule), `src/index.ts` dispatch and the
  grader's importer allowlist — collides with any Butler or outcome-store work. — this session — merged as #1465

- 2026-08-19 `fix/1458-cron-claim` — #1458. Every running bridge fires every cron recipe: the
  double-fire guard is an in-memory `Set` and the recipe store is global, so N bridges = N fires
  (observed live twice today, same instant, two pids). Adds `src/recipes/cronClaim.ts` — an
  `O_EXCL` claim keyed `(recipeName, slotEpochMs)` where the slot is the instant node-cron's
  matcher matched, threaded into `fire()` rather than re-read from the clock. Claim is a
  TOMBSTONE, taken LAST (after the disabled re-check, so a locally-disabled bridge cannot burn a
  peer's tick), and fails OPEN with `PATCHWORK_CRON_CLAIM_REQUIRED=1` to invert. CRON YAML ONLY —
  `@every`, legacy-JSON cron and the event-trigger paths are excluded and get their own issues.
  Touches `src/recipes/scheduler.ts` — collides with any scheduler, recipe-trigger or
  cron work. — this session — merged as #1461

- 2026-08-19 `chore/pin-node-cron-exactly` — `package.json` declared `^4.2.1`, the lockfile
  resolved 4.2.1, and the globally installed bridges were running **4.6.0**: `npm install -g`
  does not honour a lockfile, so a caret let the deployment take a minor CI never ran. 4.6.0
  changed when a task fires (a `missedExecutionTolerance` of 1000 ms — a late heartbeat now runs
  its slot where 4.2.1 skipped it). Pins exactly, regenerates `LICENSE-THIRD-PARTY.md`, and adds
  a guard. Prerequisite for #1458, whose slot key depends on tick semantics — tests written
  against 4.2.1 would describe code production does not load. Touches `package.json`,
  `package-lock.json`, `LICENSE-THIRD-PARTY.md` — collides with any dependency work. — this session — merged as #1460

- 2026-08-19 `fix/todoist-v1-field-shape` — the Todoist connector talks to `api/v1` and its
  `TodoistTask` / `TodoistProject` interfaces still carry REST v2 field names, so eight declared
  fields are `undefined` on the wire. Measured live: an errand the operator really did complete
  graded `unknown`/`open-recent` instead of `confirmed`, because `observeTask` reads
  `is_completed` where v1 sends `checked`; and `Date.parse(created_at)` is NaN (v1 sends
  `added_at`), so the `Date.now()` fallback resets every errand's age on every run and the
  14-day `stale-unactioned` horizon is unreachable. Touches `src/connectors/todoist.ts`,
  `src/recipes/tools/todoist.ts` outputSchemas, and the connector/butler test fixtures —
  collides with any Todoist, Butler-observation or connector-shape work. — this session — merged as #1459

- 2026-08-17 `fix/business-content-gate-reads-code` — `audit-business-content` read tracked MARKDOWN only, so the ADR-0019 licensing boundary was unenforced everywhere a string actually ships: UI components, CLI output, YAML, JSON. Its own header already conceded it cannot see code. Widens to tracked source/config text and excludes the gate + its allowlist BY EXACT PATH (they must contain the vocabulary; 20 of 20 pre-existing non-markdown hits were those two files). Measured: no new findings, allowlist unchanged at 8 entries. Touches `scripts/audit-business-content.mjs` only. — merged as #1440

- 2026-08-17 `fix/fixture-gate-ratchets-stale-entries` — `audit-test-fixtures` printed its stale allowlist entries as `[non-blocking]` and exited 0, so nothing ever forced the prune and 20 accumulated (swept in #1438). Its two sibling ratchets, `audit-lsp-tools` and `audit-shape-safety`, already FAIL on their own stale entries, which is why neither has any. Makes stale entries blocking, counted and worded separately from new violations because the remedy is the opposite one (delete the line vs add it). Touches `scripts/audit-test-fixtures.mjs` only. — merged as #1439

- 2026-08-17 `chore/prune-stale-fixture-allowlist` — the 20 stale entries `audit-test-fixtures` already reports as safe to remove (1 hardcodedTmpPaths, 7 envMutationWithoutRestore, 12 spyOnWithoutRestore). Investigated before pruning, because "stale" has two causes and only one is benign: the test was fixed, or the DETECTOR went blind and can no longer see a violation it once saw — the partial-surface defect this repo keeps hitting. All 20 files still exist and each carries the remediation its entry covered. Allowlist JSON only; no source change. — merged as #1438

- 2026-08-16 `fix/dashboard-ignores-patchwork-home` — `audit-patchwork-home` scans `src/**` only, so it never saw two lines in the dashboard's connector-requests route that match its OWN regex: `path.join(os.homedir(), ".patchwork", ...)`. PATCHWORK_HOME is ignored there, so with an override set the bridge and dashboard read different directories. Fixes the route and widens the gate. — merged as #1437.
- 2026-08-16 `fix/fixture-gate-scans-the-dashboard` — `audit-test-fixtures` walked `src/` only, so the dashboard's 126 test files were never checked; it also matched `.test.ts` but never `.test.tsx`. Measured on removing the boundary: 14 violations, one of them introduced the same day by #1430. Touches `scripts/audit-test-fixtures.mjs`, its allowlist, and one dashboard test. — merged as #1436.
- 2026-08-16 `fix/cli-gate-reads-ui-strings` — `audit-cli-commands` read tracked MARKDOWN only, so it could not have caught #1434 (a clipboard string in TSX advertising a verb that did not exist). Extends it to UI sources; the first working version found a SECOND live instance on the tasks page. Touches `scripts/audit-cli-commands.mjs` and one dashboard component. — merged as #1435.
- 2026-08-16 `fix/patchwork-approve-command` — the dashboard copies `patchwork approve <callId>` to the clipboard and the subcommand does not exist (`Unknown command: 'approve'`). Adds approve/reject as a thin shim over the existing `/approve/:callId` + `/reject/:callId` routes, plus `--review`. Also corrects a false comment in `src/bridge.ts` about where `patchwork init` writes DASHBOARD_SESSION_SECRET. Touches `src/index.ts` dispatch and one dashboard string. — merged as #1434.
- 2026-08-16 `docs/correct-stale-trust-evidence-claims` — three measured claims in CLAUDE.md had gone stale and all three overstate a problem, which is the direction that wastes a session: retention (18.2h -> re-measured 88h), `worker_trust/` checkpoints ("never written" -> a checkpoint exists) and join-key coverage ("1 of 63" -> 11 of 17 non-reversible). Docs only. — merged as #1433.
- 2026-08-16 `fix/gates-that-cannot-catch-their-own-failures` — two checks that could not catch what they exist to catch. audit-in-flight's branch pattern was wrong in BOTH directions (invented branches from backticked file paths, missed real branch names past the second slash); the dashboard had no typecheck script, so nothing local ran tsc --noEmit and a broken main passed four green local checks. Touches `scripts/audit-in-flight.mjs`, `dashboard/package.json` and the CI workflow. — merged as #1432.
- 2026-08-16 `feat/adr0020-attribute-the-approver` — the other half of #1430: a verified dashboard session now names the human on an approve/reject, closing the ADR-0017 note that the approving human "cannot be known until the approval path carries an identity". Moves the session cookie FORMAT into `src/identity/dashboardSession.ts` (one implementation, two processes) and adds a bridge-side verifying resolver. Touches `src/approvalHttp.ts`, `src/server.ts`, `src/bridge.ts` startup and `dashboard/src/lib/session.ts` — collides with any approval-path, identity or dashboard-session work. — merged as #1431.
- 2026-08-16 `feat/adr0020-login-resolves-a-member` — the wiring that makes ADR-0020 Phase A do something. #1424 (seam), #1425 (v2 cookie) and #1428 (credential storage) were all merged and all inert: nothing called `resolveActor`, so the login route authenticated a SECRET, minted v1, and no record could name a person. Touches the dashboard LOGIN ROUTE and `next.config.js` module resolution — collides with any dashboard auth or build-config work. — merged as #1430.
- 2026-08-16 `feat/adr0020-credential-storage` — the storage ADR-0020 Phase A was blocked on. `~/.patchwork/credentials.json`, 0600, keyed by member id, supplying the `credentialFor` that `LocalPasswordProvider` already takes injected. NOT on `Member` (what `actorSnapshot` copies into decision records — one careless spread from an audit log), NOT in `members.json` (a reviewable document people paste into issues), and NOT in the connector token store (its `deleteSecretJsonSync` unlink is why `audit-connector-test-isolation` exists after #1345 — a stray `clearTokens()` would delete member logins). Fails CLOSED, the opposite of the roster: absent/corrupt/unreadable ⇒ nobody authenticates. Adds `patchwork members list|set-password`, which prompts on a TTY and REFUSES a pipe. Three mutations each turn tests red. — merged as #1428.
- 2026-08-16 `fix/butler-backfill-slanders-old-errands` — the first real ingest would have been the worst one. `stateObserved` separates "nobody looked" from "we looked"; it does NOT separate "nobody was ASKED" from "somebody declined to act", and every errand filed before the observation channel existed is the former. We genuinely do look, so the guard passes, and a 60-day-old open errand grades `junk` on day one — an unearned negative from a loop the operator never knew they were in. The staleness clock now starts at `max(createdAt, watchedSince)`: an errand first seen today has been watched zero days. `watchedSince` is derived from the shadow ledger's own earliest `gradedAt` for that ref — no new file, no second source of truth that can disagree with the ledger a reviewer reads. Three mutations each turn tests red. — merged as #1427.
- 2026-08-16 `feat/butler-errand-ref-discovery` — closes the last gap between "the ingester works" and "the shadow ledger fills". `butler observe` took refs by hand, which is fine for a demonstration and useless for a cron; it now discovers them from the run log (`--file` still accepts them explicitly). Keys come from `deriveActionKey`, the SAME function the trust fold uses — re-deriving by a different rule would produce refs the fold cannot resolve, and a graded row under an unresolvable key measures nothing while still inflating the counts somebody reads. URL-shaped keys are reported as unusable rather than dropped (a valid ref, no task id inside it). Coverage is printed WITH its denominator because 3-found looks identical to broken. Touches `src/index.ts` + two new files under `src/butler/`. — merged as #1426.
- 2026-08-16 `feat/adr0020-v2-session-cookie` — ADR-0020 Phase A's remaining half. The dashboard session payload was literally `v1.${expiresAt}` — no field except expiry — so every approver was indistinguishable and no record could name one. Adds `v2.<memberId>.<expiresAt>.<HMAC>`. v1 stays VALID but subject-less, and `memberId` is ABSENT from the result (not undefined-valued) — a v1 cookie must never read as an attributed v2, or the absence of a subject becomes a CLAIM of one. No behaviour change: the login route authenticates a SECRET not a person, so it keeps minting v1; v2 appears only once a real member authenticates. Version is inside the signed payload, so a v1 cookie cannot be re-spelled as v2. Probed: defaulting a v1 subject to `local-owner` turns 2 tests red. Touches `dashboard/src/lib/session.ts`; all 10 consumers destructure `.valid` only and are unchanged. — merged as #1425.
- 2026-08-16 `feat/adr0020-phase-a-auth-seam` — ADR-0020 Phase A, the half with NO blast radius: `src/identity/authSeam.ts` (resolver interface, `UNATTRIBUTED`, provider chain) and `src/identity/credentials.ts` (`crypto.scrypt`, no new dependency). Pure addition — nothing existing imports either yet, so behaviour is byte-identical. The load-bearing rule: an unauthenticated caller resolves to `UNATTRIBUTED`, NEVER the implicit owner. The roster fails SOFT and hands out an implicit owner by design, which is right for "who may act on your own machine" and catastrophic for "who did this" — a defaulted actor is indistinguishable from a recorded one. Probed: defaulting to the owner turns 2 tests red; making a malformed credential verify turns 1 red. DELIBERATELY NOT INCLUDED: the dashboard v2 session cookie, which touches 10 consumers and is its own PR. — merged as #1424.
- 2026-08-16 `feat/butler-todoist-observation` — the observation channel Butler phase 2 was blocked on. #1419 shipped an ingester with nothing to feed it, so the shadow ledger stayed empty and nothing could be measured. Adds `TodoistConnector.observeTask` (additive — `getTask` throws on every failure, which collapses "deleted", "token expired" and "network down" into one fact) and `src/butler/todoistObservation.ts`, plus a `patchwork butler observe` verb. ONLY HTTP 404 means deleted; 401/403/429/5xx/network yield NO observation at all, so the grader answers `not-observed` and the fold withholds. Both wrong directions are harms and are not symmetric — reading a failure as deleted manufactures a negative now, reading it as "observed but open" manufactures the same negative 14 days later via the staleness horizon. Neither is reachable; both mutations turn 7 tests red. — merged as #1423.
- 2026-08-16 `fix/isolation-gate-strip-order` — #1401's comment-strip ordering defect surviving in a SECOND gate. #1412 fixed `audit-patchwork-home.mjs`; `audit-connector-test-isolation.mjs` had the same block-before-line ordering and nobody looked for a second instance. An unpaired `/*` in a line comment opens a pseudo-block that deletes every line to the next real terminator, so the `clearTokens()` call the gate exists to find disappears before a match is attempted. Measured across all 76 tracked connector tests: ZERO currently differ between the orderings, so nothing is hidden today — fixed anyway, because in the sibling this same ordering blinded 38 files and 3662 lines. Also found while probing and NOT a defect: the `clearTokens()` empty-parens regex is correct (every connector exports `clearTokens(): void`), and my first two probes of this gate were wrong, not the gate. — merged as #1421.
- 2026-08-16 `fix/companion-pins-cannot-fail` — `audit-companion-pins` could not fail on a stale pin, which is its only purpose. Two interacting defects: `versionDistance` kept scanning after a differing segment so a later segment reversed the verdict (`1.0.1` vs `1.7.0` printed as `pinned > latest — likely prerelease`), and `significantlyBehind` was `distance > 5` where distance counted differing segments — bounded by 3 for semver, so unreachable. With the comparison fixed, 5 of 6 companions are behind and three are a major version or more back. The weekly job will now go RED until pins are bumped; that is the gate doing its job for the first time. — merged as #1422.
- 2026-08-16 `fix/1403-nested-install-dirs` — #1403. `iterateInstallDirs` walked DIRECT children of the recipes dir, so a manifest-less GitHub install at `owner/repo/` was invisible to every lookup. `setRecipeEnabled` does not error on an unresolved name — it falls through to the legacy `cfg.recipes.disabled` array — so disabling a nested install from the dashboard wrote a name nothing reads, never wrote the `.disabled` marker that governs it, and returned ok:true. Descends ONE level, and only when the parent has no entrypoint of its own (otherwise a recipe's own vendored subdirs become phantom installs). Entrypoint resolution extracted so both levels resolve identically. Touches `src/recipesHttp.ts`, which feeds listing, webhooks and triggers — blast radius is real, which is why the issue asked for its own change and its own review. — merged as #1420.
- 2026-08-16 `feat/butler-outcome-ingester` — Butler phase 2. The errand outcome grader was merged but UNWIRED: nothing called it, so no shadow row had ever been written and the measurement the shadow phase exists to produce did not exist. Adds `src/butler/outcomeIngester.ts` plus a `patchwork butler <ingest|shadow>` CLI. Investigation first turned up a defect that had to be fixed before wiring anything: the grader's `stale -> junk` branch fired on `createdAt` alone, so it could not distinguish "we looked and nobody acted" from "nobody ever looked" — an ingester fed run-log data (creation times, never completions) would mark every errand past the horizon junk. Trust-by-neglect with its sign flipped, and worse, because a worker cannot appeal a verdict nobody looked at. Now needs an explicit `stateObserved`. Shadow-only and structurally so: the module imports no workers/ code and is not in the recipe tool barrel, both asserted. NOT DONE: the Bearer-HTTP route and an automated observation channel — see the PR, an LLM gathering observations would poison the ledger the same way the LLM judge did. — merged as #1419.
- 2026-08-15 `fix/1386-bridge-leaks-process-handlers` — #1386. `Bridge.start()` registers five process-level listeners (SIGINT/SIGTERM/SIGHUP/unhandledRejection/uncaughtException) and they were only ever removed when ANOTHER bridge started in the same process; `stop()` removed none. So a stopped bridge's handlers stay live, closing over its sessions, its logger and a `shutdown` that calls `process.exit`. After a test stops its bridge, any later uncaught exception anywhere in that worker runs the DEAD bridge's handler and exits the process — the worker dies mid-suite with no verdict, which is #1386's signature exactly (Test green, Coverage red, passes on re-run). Measured in one worker: before start 1/1/0, after start 2/2/1, after stop 2/2/1 unchanged. Fix detaches only this bridge's own handler set, and clears the module-global only while it still points at that set, so an older bridge stopping cannot disarm a newer one. Touches `src/bridge.ts`. — merged as #1417. #1386 stays OPEN: this is a plausible cause established by measurement, not proof it is the only one, and the flake is on Windows CI while the mechanism is platform-independent.
- 2026-08-15 `fix/in-flight-gate-fails-open-on-network` — this gate reported a clean ledger whenever the GitHub API was unreachable. `prState` caught every `gh pr list` failure and returned null, which is ALSO how "this branch has no PR yet" is spelled — a state deliberately treated as fine — so a network blip made every stale entry green. Caught by running it twice seconds apart on one tree and getting FAIL then OK. Under a stub where the credential probe succeeds and the PR query fails, the pre-fix script printed "OK - every Active entry is genuinely in flight" with a MERGED entry sitting in Active; it now retries 3x and exits 2. Adds `--ledger <path>` so the test drives a fixture rather than whatever happens to be in Active today. — merged as #1416
- 2026-08-15 `fix/license-gate-skips-optional-deps` — `audit-third-party-licenses` reported a copyleft-free production tree while 14 LGPL-3.0-or-later binaries shipped in the deployed dashboard. Two holes that compounded: `optional:true` was skipped alongside `dev` (131 packages outside the gate entirely, though an optional dep is INSTALLED by default), and the copyleft test ran against the whole SPDX expression anchored at its start, so `Apache-2.0 AND LGPL-3.0-or-later` escaped — which is what four of the fourteen declare, so fixing either hole alone still missed them. Fix parses the expression (OR = a choice, clean if any alternative is copyleft-free; AND = cumulative) and adds an allowlist requiring a written reason per entry, seeded with the sharp/libvips binaries. Accepted entries are PRINTED on every green run and the OK line names the count — an accepted obligation nobody can see is one nobody re-examines. — merged as #1415
- 2026-08-15 `fix/skill-parity-never-ran-in-ci` — `audit-skill-parity`'s tool-existence half ("does the tool this skill tells the model to call actually exist?") has never run in CI. It reads `dist/tools`; `dist/` is gitignored and the job runs `npm ci` with no build, so `knownToolNames()` returned null every time, the check skipped itself and the script exited 0 — the green tick was reporting the skip. Reproduced locally by moving `dist/` aside. Fix is both halves: the job now builds first, AND the script refuses to skip when `CI` is set, so moving the step to another job goes red instead of quiet again. Touches `.github/workflows/ci.yml` and `scripts/audit-skill-parity.mjs`. — merged as #1414
- 2026-08-15 `fix/cves-gate-fails-open` — `audit-production-cves` failed OPEN on every registry outage. npm emits well-formed JSON when it cannot reach the registry, so `JSON.parse` succeeded, `vulnerabilities ?? {}` yielded `{}`, and the gate printed `OK — no high or critical production advisories`, exit 0 — byte-identical to a clean run, for the whole repo. Now asserts the response IS an audit report (`auditReportVersion` + `metadata.vulnerabilities`, neither present in the error envelope) and exits 2 — not 1, because "we could not audit" must never print as "we audited and found nothing". Retries 3x with backoff first (read-only idempotent query, no side effects) so a one-second hiccup is not a new flake source. Touches `scripts/audit-production-cves.mjs` only. — merged as #1413
- 2026-08-15 `fix/patchwork-home-strip-order` — MY OWN REGRESSION from #1401, found by mutation-probing the gate. #1401 replaced a line-by-line scan with a whole-file one (correct) but stripped BLOCK comments BEFORE line comments (catastrophic): a `/*` inside a LINE comment opens a pseudo-block that runs to the next real terminator anywhere in the file. One ordinary route comment at src/server.ts:926 (`// -- /schemas/* -- ...`) swallowed 2098 of that file's 3593 lines, 58%, before a single match was attempted; repo-wide 38 files and 3662 lines of live code deleted. A canonical violation planted at line 1504 passed with "0 on the ratchet" — so the change that fixed a blind gate made it BLINDER THAN THE VERSION IT REPLACED, which would at least have caught a single-line offender anywhere. I reported "ratchet 3 -> 0 under a gate that can now actually see"; that claim was false. Fix is a one-line reorder (line comments first, then block comments) plus a regression test pinning BOTH directions — the multi-line form #1401 fixed AND the pseudo-block hole it introduced. Verified three ways: clean tree still passes (no false positives), the previously-invisible violation now fails, the multi-line form still fails. Mutation-probed: restoring the bad order turns the test red. — merged as #1412
- 2026-08-15 `feat/private-identifier-gate` — the mechanical half of CLAUDE.md's Repository Privacy section, which until now was enforced entirely by remembering ("read the diff, the commit text and the branch name yourself"). Nothing checked: `audit-business-content` reads TRACKED MARKDOWN only and never sees code, tests, fixtures, commit messages or branch names, and its own header says it cannot recognise a real third-party name used as a neutral-looking identifier. New `scripts/audit-private-identifiers.mjs` runs from husky pre-commit (staged diff + branch name) and commit-msg (the message) and BLOCKS on a match. THE DENYLIST NEVER ENTERS THE REPO — those strings are exactly what must not be published, so it lives at ~/.patchwork/private-identifiers.txt, outside where `git add -f` can reach; the gate HARD-FAILS if `.private-denylist` ever becomes tracked, since a committed denylist publishes every secret at once in a clearly-labelled file. Never prints the matched string, only the entry number — echoing it would put the secret into scrollback and CI logs, the same disclosure one layer over. Does NOT run in CI (CI has no denylist and must not); with no denylist it says it verified NOTHING and exits 0 rather than blocking a contributor, and never passes silently. Verified END-TO-END with a real `git commit`: violating message rejected with HEAD unchanged, clean message committed. CAUGHT: my own test harness used execFileSync, which returns stdout ONLY on a zero exit, so every stderr warning was discarded and two assertions ran against an empty string — the script was right and the harness was lying. Four mutations probed red-then-green, one of which initially did not apply and proved nothing until the replace was assert-guarded. — merged as #1411
- 2026-08-15 `fix/1266-callback-404-and-port-mismatch` — #1266 operator-facing half. (1) An unrecognised connector on a callback path now 404s NAMING THE SLUG instead of falling through to the bearer gate and answering 401 — a vendor's OAuth redirect never carries a Patchwork bearer, so that 401 was guaranteed, and a typo'd redirect_uri presented as an authentication failure sends the operator to check credentials that are fine. (2) `warnIfCallbackPortMismatch` says so once when the bound port disagrees with the port every redirect_uri names. DETECT, NOT SUBSTITUTE: emitting the real bound port would be WORSE, because a redirect_uri must be pre-registered with the provider, so a value derived from an OS-assigned port is guaranteed rejected — accurate about our process and unusable. Fires only on the fallback; with PATCHWORK_DASHBOARD_URL/BRIDGE_URL set, a differing bridge port is the documented dashboard-fronted topology. (3) Corrects the PATCHWORK_DASHBOARD_URL row in CLAUDE.md (AGENTS.md carries the same wrong row but is GITIGNORED at .gitignore:149 and untracked, so it exists only on the machine that wrote it — same shape as the .claude/rules note in CLAUDE.md, and the reason the investigation report called this a two-file defect when the repo has one) — it claimed "used by CLI open actions" (no CLI action reads it) when it is first in the redirect_uri precedence chain for 14 OAuth flows. Touches connectorRoutes.ts + bridge.ts bind path. PROBE CORRECTED A COMMENT: my control claimed it stopped the 404 branch swallowing every callback; widening the condition changes nothing because the branch sits last and is unreachable for known slugs. The real risk is a refactor HOISTING it — probed, and the control does fail on that. — merged as #1409
- 2026-08-15 `refactor/dashboard-callback-dynamic-route` — collapses 26 dashboard directories into 2 dynamic routes: 13 `connections/<slug>/callback/page.tsx` (four lines each, differing in two string literals) and 13 `api/connections/<slug>/callback/route.ts`. The API copies had ALREADY DRIFTED from each other (differing comments and quote style) — the concrete version of the risk duplication carries. Follows the pattern `api/connections/[connector]/{auth,connect,test}` already established, and gives `oauthConnectorIds()` its first PRODUCTION call site (it had zero anywhere). Checked before writing: Next is `output: 'standalone'`, not `export`, so no generateStaticParams is needed — under static export the missing params would have failed the build. Unknown slug now 404s with the slug named, at both layers, BEFORE the session gate — a routing fact reported as 401 is what sends an operator to debug credentials after a typo'd redirect_uri. CAUGHT: my grep for tests referencing the removed routes used a broken --include flag and returned a false negative; 3 test files did import them. Two of those hand-listed their routes — oauth-callbacks named 10 while the registry has 13, so github/linear/sentry were never exercised, the same drift that file was written to catch. Both now derive from the registry. Dashboard 1194 -> 1275 tests. — merged as #1408
- 2026-08-15 `fix/1266-guards-and-dead-branches` — #1266 dispatch half, the parts that need no decision. Deletes 4 dead OAuth callback branches (linear, asana, google-calendar, google-drive) that were registered in BOTH dispatchers; verified unreachable first — the public dispatcher runs at server.ts:922 vs the auth-gated one at :1765, with byte-identical conditions. Points the dedup guard at `oauthConnectorIds()` instead of the hand-written `["sentry","discord","gitlab"]`, which listed precisely the three duplicates ALREADY removed — a guard enumerating its own past successes, green while four live ones sat there. Broadens the frozen-redirect-URI guard from an identifier-exact `/^const\s+REDIRECT_URI/` (a spelling that appears nowhere in src/connectors/ any more) to the INITIALIZER, recursive, with a scanned>=10 anchor and a control proving the predicate can fail. Touches connectorRoutes.ts — collides with any connector-routing work. Probed against the pre-change file: the derived guard catches all 4, the hand-listed one caught 0. — merged as #1407
- 2026-08-15 `fix/in-flight-gate-skips-itself-in-ci` — the in-flight gate has never checked anything in CI. Probe was `gh api user`; Actions' GITHUB_TOKEN is a repo-scoped INSTALLATION token that gets 403 on /user, so `canQuery` failed for both candidate envs and every run printed SKIPPED. Confirmed from a real CI log (run 31873349778) before changing a line. Two fixes: probe `repos/{owner}/{repo}` (what `prState` actually needs — a repo read), and make a skip in CI a FAILURE (skipping is right on a laptop with no gh, wrong in the one place the credential is guaranteed). THIS ENTRY IS ALSO THE TEST: the gate short-circuits on an empty Active section, so the first CI run on this branch never reached the auth path and proved nothing. With an entry present, CI either prints "1 branch(es) ... checked" (fix works) or FAILS loudly (probe still wrong) — both are informative, neither is a silent skip. PROVEN in CI run 31874900908: "1 branch(es) named in the Active section checked" — the installation token authenticates through the repos/{owner}/{repo} probe and the gate reached prState for the first time. — merged as #1406
- 2026-08-15 `feat/butler-outcome-grader-shadow` — Butler errand outcome grader, SHADOW-ONLY. Pure deterministic grader (`did the operator keep it?`): completed -> confirmed, deleted -> junk, open+stale -> junk, open+recent -> WITHHELD. Writes to `butler_outcome_shadow.jsonl`, a SEPARATE file the trust fold does not read and must not be taught to — promotion means writing through `OutcomeStore.upsert` against a measured before/after on the real log, exactly as #1319 required, and is deliberately NOT built here. No LLM judge: a prior one flipped verdicts between runs on identical inputs, which makes the ledger unreplayable. The load-bearing rule is that no absence produces `confirmed` — four defects in this subsystem (#1064, #1318/#1319, #1320, #1322) were all the same mistake — so there is no default-to-good branch at all, and an exhaustive test enumerates the observable shapes rather than spot-checking. Stale -> junk is asymmetric ON PURPOSE: `unknown` is right while the operator might still act and wrong once not-acting IS the answer. Two guard tests pin the shadow property to the code (nothing outside the module names the file; the grader cannot reach `upsert`). Touches nothing existing — two new files under src/butler/ plus tests. NOT WIRED: no cron ingester, no CLI verb, no dial impact. — merged as #1404
- 2026-08-15 `fix/1360-cli-enable-disable` — #1360 write half. `recipe enable`/`disable` now delegate to the shared `setRecipeEnabled` the bridge and dashboard already use, so the CLI can act on the recipes `recipe list` prints. THE IDENTIFIER WAS THE REAL BUG: `recipe list` (read half) prints each recipe's DECLARED `name:`, while the verbs resolved by INSTALL-DIRECTORY name — a recipe in `legacy/` declaring `name: test` was listed as `test` and only actionable as `legacy`. Both spellings are accepted now. Delegation alone REGRESSED three things the suite caught, all restored: (1) HIGH-2 path-traversal rejection, dropped with the old lookup, and a traversal-shaped name would have fallen through to the legacy config array and been WRITTEN there; (2) the not-found error — `disable typoo` would have silently added `typoo` to `cfg.recipes.disabled`, a write that looks like it worked and governs nothing; (3) nested `owner/repo` installs (audit 2026-06-08 cli-1), which `setRecipeEnabled` CANNOT reach because `iterateInstallDirs` walks direct children only — so the CLI keeps its own directory-resolved marker write for those and the gap is filed separately. `setRecipeEnabled` gains `changed` + `mechanism` so the CLI reports WHICH mechanism was written, and no longer rewrites `config.json` on a no-op (that file was clobbered days ago in #1380). Touches recipeInstall.ts + recipesHttp.ts — collides with any recipe-listing work. Mutation-probed: restoring the install-dir-only lookup turns 5 of 6 new tests red. — merged as #1402
- 2026-08-15 `fix/1265-inbox-coupling` — #1265, the last three files on the PATCHWORK_HOME ratchet (3 -> 0). Batch 4's note said the fix needed `~` expansion routed through the same helper; that is NOT implementable and the note was wrong. There is exactly ONE `~` expansion site and it expands every `~/`, so routing it through patchworkHome() turns `~/Documents` into `<override>/Documents`. What landed instead: the literal `~/.patchwork/` PREFIX rewrites to patchworkHome() and nothing else, plus patchworkHome() as a jail ROOT — measured first, the override dir was not writable through the jail at all, so converting the readers alone would have produced an inbox nothing could write to. The legacy root stays allowed for hard-coded absolute paths. Also corrected: batch 4 said writer and reader would land in different trees; they did not — both resolved under $HOME, so they AGREED and the split was inbox-vs-everything-else. Scope check before building: all 24 shipped recipes targeting the inbox use the tilde form and none hard-codes an absolute inbox path, so the rewrite strands none. TOUCHES THE RECIPE PATH JAIL — collides with any other resolveRecipePath work. CAUGHT MID-BUILD, twice: (1) my own new test 'the override directory is WRITABLE through the jail' passed against the UNFIXED code, because testEnvSetup sets CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1 and the override lives under tmpdir — every call now passes allowTmp:false so the assertions discriminate; (2) my first cut had the prefix ignore `opts.homeDir`, which broke 13 tests across 5 files for zero production benefit — no production caller passes homeDir, so `patchworkRootFor` now honours it and the hermetic test seam survives intact. Both halves mutation-probed. — merged as #1401
- 2026-08-15 `docs/1397-narrow-boundary-invariant` — #1397. Narrows ADR-0021's invariant from "no model-bound context" to "no **recipe agent-step** context", and adds a Scope section saying plainly that orchestrator dispatch is ungoverned. Chose option 2 (narrow the claim) over option 1 (bring the orchestrator in scope): the boundary answers *may this data go to that destination*, and an orchestrator task has no declared `data_policy` and no natural place to put one, so wiring the existing decision in would give every task the default classification — a check that always says `internal` and writes an affirmative receipt about a label nobody supplied, which is the failure the recipe path had before the destination registry existed. Docs + one guard test; no runtime code touched. GUARD PROBED THREE WAYS AND THE FIRST VERSION FAILED: the control ("recipe path still has a boundary") passed against a codebase with the boundary torn out, because `String.includes("recordBoundaryDecisionFn")` matches inside `recordBoundaryDecisionFn_REMOVED` — the same shape as the earlier guard whose regex matched `_removed_<name>:`. Now a `\b`-anchored whole-identifier match, and the control fails as it should. — merged as #1400
- 2026-08-15 `fix/1398-boundary-destination-truth` — #1398, both halves. (1) Local-ness now comes from the resolved ENDPOINT, not membership in `LOCAL_DRIVERS`: the driver name says which client code runs, never where the bytes land, and `LOCAL_ENDPOINT_ALLOW_REMOTE` exists precisely because off-box is supported. `LOCAL_ENDPOINT_ALLOW_REMOTE` is deliberately NOT consulted — it is permission to send, not evidence of locality, and reading it the other way would re-open the hole on exactly the deployments actually sending data off-machine. Applied to the EXPLICIT driver mapping too, not just inference: a `drivers: ["local"]` entry is a static claim, the endpoint is what happens, and letting the mapping win would launder an off-box send into a receipt saying the data never left. New fail-closed branch for "local driver off-box + only local destinations registered" — there is no registered destination describing where that goes, so it synthesises one cleared for nothing rather than handing back the restricted-cleared local profile. (2) `resolveEffectiveDriver` resolves the driver ONCE, before the boundary, and dispatch branches on the same value; the auto-detect tail that used to sit at the bottom of the dispatch chain now lives there. An unrecognised driver is passed through rather than thrown on, so the boundary still evaluates it (→ strictest remote) and still writes a receipt, exactly as before. Touches `src/privacy/destinationRegistry.ts` and `src/recipes/agentExecutor.ts` — the boundary decision point, so it collides with any other ADR-0021 work. CAUGHT MID-BUILD: my first cut resolved the endpoint eagerly, adding a `config.json` read to every agent step and to dispatches that pass an explicit destination and never need it — now a lazy getter, resolved only for the local family. Also caught one of my own tests making a false claim: the anthropic case did not discriminate (both the fixed and pre-fix paths landed on the same destination via the strictest-remote fallback), so the registry gained a second remote entry to separate them. Both halves mutation-probed red-then-green. — merged as #1399
- 2026-08-14 `fix/1360-recipe-list-bridge-view` — #1360 read path only. `recipe list` called the wrong one of TWO exported functions named `listInstalledRecipes`: the one in `commands/recipeInstall.ts` enumerates install DIRECTORIES (`if (!statSync(itemPath).isDirectory()) continue;`), while the one in `recipesHttp.ts` runs two passes — flat recipe files, then install dirs — and is what `GET /recipes`, the dashboard and the orchestrator use. The directory-only view was not merely smaller: it also printed any directory containing a `.yaml` as an installed recipe, so it was part omission and part phantom. New `src/commands/recipeList.ts` prefers a live bridge and ALWAYS states which view answered, because the old failure was silent — a short list was indistinguishable from a short installation. DELIBERATELY NOT INCLUDED: `recipe enable` / `disable`, which resolve only via the marker mechanism and throw for every top-level recipe while the bridge's `setRecipeEnabled` handles both. That changes which mechanism is WRITTEN and wants its own review, so #1360 stays open after this. _Nothing in flight._ Swept 2026-08-08: all 10 distinct entries here were MERGED (#1249, #1255, #1256, #1257, #1258, #1259, #1278, #1279, #1280, #1281), several listed twice by union-merge. The oldest had been closed for four days while CLAUDE.md told every session to read this file first — so the ledger built to stop two sessions colliding was itself handing them stale state. This is the third sweep (#1247 was the second, on 2026-08-03, and it decayed within five days). `scripts/audit-in-flight.mjs` now fails CI when an entry here names a merged PR or a branch that no longer exists, because three manual sweeps is enough evidence that the convention does not hold on its own — merged as #1383
- 2026-08-14 `docs/repo-privacy-rules` — adds a Repository Privacy section to CLAUDE.md: what may never enter a public artefact (the local ledgers, real third-party names, operational statistics attributed to a named party), where a disclosure-is-the-harm finding goes instead of a public issue, and the fact that `audit-business-content` reads tracked markdown only, so a green gate is not a clean scan. These rules existed only in transient session context — grepping CLAUDE.md and every rules file for them returned nothing. Written INLINE rather than as `.claude/rules/repo-privacy.md` because that directory is gitignored (`.gitignore:62`): every rule file CLAUDE.md `@import`s today is untracked and exists only on the machine that wrote it, so a fresh clone gets none of them. Docs-only, no code paths touched. Swept 2026-08-08: all 10 distinct entries here were MERGED (#1249, #1255, #1256, #1257, #1258, #1259, #1278, #1279, #1280, #1281), several listed twice by union-merge. The oldest had been closed for four days while CLAUDE.md told every session to read this file first — so the ledger built to stop two sessions colliding was itself handing them stale state. This is the third sweep (#1247 was the second, on 2026-08-03, and it decayed within five days). `scripts/audit-in-flight.mjs` now fails CI when an entry here names a merged PR or a branch that no longer exists, because three manual sweeps is enough evidence that the convention does not hold on its own — merged as #1382
- 2026-08-14 `fix/1311-batch3-tracker-writes` — #1311 batch 3: the per-tool review of declared WRITES that batch 1 deferred and batch 2 began. 17 tracker / knowledge-base / support tools taken off the classification ratchet (34 → 17). Two distinct moves, kept apart on purpose: 15 LOOSENED (irreversible → compensable) only where the inverse is an ordinary supported operation of the product — delete/close the issue, restore the page version, reopen the ticket; 2 DEBUCKETED only (`intercom.replyToConversation`, `zendesk.addComment` stay irreversible — they deliver text to a customer and a sent message has no inverse). New domains `docs-write` and `support`; `support` is brand-exposed, `docs-write` deliberately is not. Touches `src/workers/actionClass.ts` — the autonomy gate — so it collides with any other trust-gate work. Deliberately left on the ratchet: `obsidian.write_note` (looks like a sibling of the Notion/Confluence page writes but overwrites with no version history and no WriteEffectLedger) and `outcomes.classify_issues` (writes the outcome-log the trust ramp READS — classifying it is a governance question about a worker writing its own evidence, not a reversibility one). Remaining 17 are CRM and infrastructure writes. Swept 2026-08-08: all 10 distinct entries here were MERGED (#1249, #1255, #1256, #1257, #1258, #1259, #1278, #1279, #1280, #1281), several listed twice by union-merge. The oldest had been closed for four days while CLAUDE.md told every session to read this file first — so the ledger built to stop two sessions colliding was itself handing them stale state. This is the third sweep (#1247 was the second, on 2026-08-03, and it decayed within five days). `scripts/audit-in-flight.mjs` now fails CI when an entry here names a merged PR or a branch that no longer exists, because three manual sweeps is enough evidence that the convention does not hold on its own — merged as #1381

- 2026-08-11 `feat/trust-reads-archive` — Item (1) of the retention scope, plus the measurement that should have caught it. FINDING: `runs.jsonl` is capped by BYTES while the durability window is defined in TIME, and nothing reconciled the two — retention measured **18.2h against a 24h window**, so a non-reversible success was DELETED BEFORE IT COULD SETTLE. Compensable/irreversible trust was therefore unearnable in principle, not merely slow, which is why `worker_trust/` has never existed (`folded > 0` never holds). Cause of the squeeze: one non-worker recipe wrote 1243 of 1275 rows in 18.2h; worker rows were 3 of 1275, then 0 of 729 forty minutes later — every worker run on this machine was evicted mid-session by unrelated traffic. Fix: trust replay now reads `runs.jsonl.1` (the archive #1334 created) as well as the live file, deduped by taskId across both (a crash between archive-write and trim can leave a run in each). ~11 days of retention at current volume vs 24h needed. PLUS `evidenceRetention()` — the honest half: the read-side version of this exact bug was already fixed once (see the ring `memoryCap` note in runWorkerShadow.ts) and survived one layer down in disk retention because nothing measured whether the invariant held. `workers shadow` now says so out loud when span < window, because a starved ledger otherwise looks identical to a quiet worker. Deliberately NOT (3) a filtered worker-run ledger — that is the durable design (immune to noise; worker rows are ~0.2% of volume) but spans 8 write paths where a miss is a silent evidence gap, and it should land against a measurement rather than my estimate. Two vacuous tests caught mid-build: a dedup test asserted on the confirm queue, which dedups by actionKey itself, so it passed whether or not readRuns deduped at all (moved to the dial's observation count); and the `audit-patchwork-home` gate caught a hardcoded homedir join. — merged as #1338

- 2026-08-11 `fix/runlog-dedup-by-taskid` — The run log was DESTROYING runs. `seq` is a per-INSTANCE counter (`private seq = 0`, seeded from the file at construction, `++` per append) but `runs.jsonl` is shared by eight construction sites, several of which write — so two live instances hand the same seq to unrelated runs. In the live log 142 of 145 seqs were shared, colliding runs a median 20 min and up to 5.6h apart, and 463 real runs collapsed to 146 visible. The run log is also the trust ledger, so ~2/3 of the autonomy gate's evidence was discarded on every read. Two distinct losses fixed: (1) load-time dedup keyed on seq; (2) `syncFromDisk` gated on `parsed.seq > this.seq`, so a CONCURRENT writer's runs were invisible to a live bridge for as long as it stayed up — discarded as they ARRIVED, not just on re-read. Now keyed on `taskId`, verified safe against the real log (no taskId disagreed with itself on createdAt; none spanned two recipes; 393/460 had the expected running→terminal multi-row shape). Ring now matches the file exactly (407 = 407). CAUGHT MID-BUILD: removing the `seq >` gate also removed accidental protection for `updateRunSteps`, which mutates in-memory ONLY — a sync would have wiped a live run's streaming steps. Guard added (a disk row supersedes a held row only when the held one is not live, or the disk row is terminal), pinned from both directions. Also fixed `syncFromDisk` reaching past the class's injectable clock to `Date.now()`, which made the 250ms throttle untestable. Does NOT fix: seq-as-identity (`getBySeq` backs `/runs/[seq]` + replay — item B, needs a URL-contract decision) or rotation (item C — which FIRED during this session and destroyed the first successful governed errand). — merged as #1333

- 2026-08-11 `fix/runlog-rotation-archives` — Item C. `rotateDisk` trimmed the oldest rows of `runs.jsonl` and DELETED them; in-memory state was unaffected and nothing warned, so the loss was invisible at runtime. This file is the autonomy gate's TRUST LEDGER, not just a display log. Not theoretical: rotation fired mid-session on 2026-08-11 and destroyed the first successful governed errand — the exact run the confirm loop was being verified against — between one read of the file and the next. The durable mitigation (`worker_trust/` checkpoints, #1307) has never written a file, so nothing stood behind it. Trimmed rows now append to `runs.jsonl.1` with a warning naming the row count. Bounded: the archive itself trims at 8 MB (~8 rotations) and says so explicitly when it does, because an unbounded archive on a laptop is its own failure. HONEST LIMIT, stated in the code and the PR: this makes the loss RECOVERABLE, it does not make it invisible to the dial — the trust replay reads only the live file, so preventing evidence loss is the checkpoint's job (item D, still unscoped: `folded > 0` requires runs settled past 24h and there are none, so the condition is not obviously a bug). Does not touch item B (seq-as-identity for `/runs/[seq]` + replay). — merged as #1334

- 2026-08-10 `docs/readme-onboarding-accuracy` — README-review phase 3 of 3 (the README itself). Rewrites the top half against the nine-part structure while preserving the headline, three-part decision model, feature map, comparison link and telemetry section. Every corrected claim was re-verified against the code, not the review notes: `approvalGate` defaults to "off" (src/server.ts) and worker autonomy is flag-gated, so both are now stated as OPT-IN with a defaults table — the previous text presented them as baseline behaviour, which is the one inaccuracy that could actually get someone hurt. Morning Brief rewritten from the real recipe (gmail/calendar/github/linear/git + claude-code): no drafted replies, no overnight-agent inspection, no clipboard, no Ollama-via-`--local` (`--local` skips bridge dispatch). `panic` blocks write-tier tools, not "all automation". Adds the zero-connector `daily-status` first-success step, the npm-install-vs-repo split for the dashboard, and a local-first section that says plainly which traffic DOES leave the machine (model + connector calls). Two claims I wrote and then had to correct before shipping: the Linear step is NOT optional (no `when:` guard, so a missing connector halts the run) and `patchwork start` warns rather than starting a dashboard that isn't in the npm package. Depends on #1324/#1325/#1326 being PUBLISHED, not just merged — the install section describes fixes that are on main but not on npm. — merged as #1328

- 2026-08-10 `chore/node-engines-match-ci` — README-review phase 3 of 3. `engines.node` said `>=20.0.0`, every workflow pins Node 22, and the README said "Node 22+" — so the package advertised support for a Node version no job has ever tested, and the repo contradicted itself. Raised the floor to match what CI actually proves rather than lowering the README to match an untested claim; the README needed no change. Ships as a drift GUARD, not a one-off bump: `enginesMatchCi.test.ts` scrapes every `node-version:` in `.github/workflows/` and fails if the declared floor sits below the oldest Node in the matrix, so re-introducing the gap requires adding that version to CI first. Verified red-then-green (`expected 20 to be greater than or equal to 22`) and the scrape asserts it found at least one version, so an empty result cannot pass vacuously. Semver-relevant: narrows the supported range, so it wants a release note. — merged as #1326

- 2026-08-10 `fix/init-dispatch-binary-name` — README-review phase 2 of 3. `init` meant two different commands depending on which of the three bins you typed, and the check keyed off `process.env._` — a shell convenience variable npx does not set to the resolved bin. So `npx patchwork-os@beta init` fell through to `basename(argv[1])` = `index` (from `dist/index.js`) and landed in the LEGACY IDE-bridge installer, while the README, the docs and the tool's own `--help` all described the other command. Verified empirically against the published 1.1.0-beta.4 before writing a line. Fix: extract `resolveInitTarget` (src/initDispatch.ts) — `init` is the Patchwork setup for every name EXCEPT `claude-ide-bridge`, unrecognised names included, because defaulting an unknown invocation to legacy is precisely what broke published onboarding. Blast radius was real and is the part to scrutinise: 5 existing init.test.ts tests went red because they spawned dist with no bin name and relied on that same default. They exercise the legacy installer (as the file header says), so they now NAME the bin rather than inheriting an accident. Also fixes `--help` advertising `init [--workspace <dir>]`, a legacy-only flag, for a command that takes `--with-connectors`. This is what makes README item 3 (`patchwork init --with-connectors`) true rather than requiring a README workaround. 8 tests: 4 pure + 4 e2e spawning the built dist, because the bug was never a wrong rule — it was a correct-looking condition reading the wrong variable, which a pure test cannot catch. — merged as #1325

- 2026-08-10 `fix/npm-artifact-approval-hook` — README-review phase 1 of 3 (onboarding is broken on the published artifact). `patchwork-os init` writes the absolute path of `scripts/patchwork-approval-hook.sh` into the user's real `~/.claude/settings.json` as a PreToolUse command, but `files[]` never shipped that script — so an npm-installed user gets a global Claude Code config pointing at a file that does not exist, on every tool call, in every session. Verified against the published 1.1.0-beta.4 tarball, not inferred. Second half: init printed "open http://localhost:3200" unconditionally, though `dashboard/` is a Next.js app needing its own install+build and is likewise absent from the tarball — adding it to `files[]` would NOT fix that (a 10x bigger tarball and a still-dead port), so the next-steps text now branches on dashboard presence and tells npm users where to get it. New `npmArtifact.test.ts` asserts over `npm pack --dry-run` — the whole suite was green while the artifact was broken because nothing here had ever looked at the tarball. Follow-ups, separate PRs: `patchwork init` vs `patchwork-os init` dispatch (npx lands in the LEGACY installer — `invokedBinaryName()` reads `process.env._`, which npx does not set to the bin), and the `engines.node >=20` claim that no CI job tests. — merged as #1324

- 2026-08-10 `fix/unkeyable-is-not-approval` — The LAST form of the fallthrough #1318/#1319 closed twice: a non-reversible success that cannot be IDENTIFIED skipped the withhold branch (guarded on a key being present) and fell through to good:true. "We cannot refer to this action" silently became "a human approved it" — and it landed on the riskiest actions, not the safest (`http.post` is `http:irreversible:medium`, brand-exposed). Two halves, deliberately together: (a) `deriveActionKey` dips ONE level through a JSON `body` string, the single real envelope shape in the run log that hides a perfectly good id (12 http.post steps) — this parses a payload we already received and reads the SAME id fields, unlike synthesising a Todoist permalink which fabricates from a convention we do not control; `body` only and one level only, because each speculative extra field is another way to key an action to something that is not its identity, which attaches a human's confirmation to the WRONG action. (b) unkeyable + non-reversible + store configured ⇒ WITHHOLD. Scoped twice: not when no store is wired (a deployment state, not a property of the action — withholding there would silently zero every non-reversible action for callers who never opted in) and not on the `strictOutcomeJoin:false` opt-out (which exists to reproduce historical labelling byte-for-byte). Result: 13/13 real non-reversible successes are now confirmable by an operator, 0 left silently credited. REQUIRED updating 11 tests, which is the part to scrutinise — the policy they were written to protect is what changed, so `seedEarned`-style fixtures now carry identifiable+confirmed filings because earning genuinely requires that now; one test asserting "no captured URL falls through to good:true (back-compat)" is REVERSED outright and says so. My first measurement (12 steps) was true but unrepresentative — the fixtures exposed the general rule, that any tool returning no identifier could never earn at all, which is why option (b) alone was not shipped. — merged as #1322

- 2026-08-10 `fix/agent-steps-not-evidence` — Agent (reasoning) steps stop counting as trust evidence, in EITHER direction. `decideWorkerAction` already carved `agent` out as "not a gated action-class", but `foldOutcome` never mirrored it, so the gate and the fold disagreed about what an agent step IS — drift, not design, running one way: 50 successful agent steps in the real run log folded as good:true, unconfirmed positives no human ever saw. Withheld on failure too (9 in the log): a failed agent step says something about a model call, not about whether this worker can be trusted with a side effect. Net over real data: 59 steps leave the evidence pool, 1358 legitimate ones remain, so the dial is corrected, not starved. Was LATENT rather than exploitable — `agent` classifies `other:irreversible:medium` and nothing owns the `other` catch-all (verified across shipped templates AND the live ~/.patchwork/workers, 8 manifests), so the gate floored it to L0 — but ARMED: adding `other` to any `owns` would have converted the pile into real trust instantly. Ships with a guard test asserting no template declares `other`, plus an anchor asserting `agent` still classifies INTO `other` so the guard cannot pass vacuously. Root cause of the drift addressed too: both sites hardcoded the literal "agent" independently, now a shared `AGENT_STEP_TOOL`. 8 tests, all three halves mutation-probed (remove carve-out -> 4 red; make it match everything -> anchor red; add `other` to a template -> guard red). — merged as #1320

- 2026-08-10 `feat/strict-outcome-join` — Flip `strictOutcomeJoin` to the default (follow-up to #1318) + the UI/route work that flip REQUIRES. Blast radius measured over the real run log before flipping, at three clocks: 0 steps change at now, **1 step** at now+2d and now+30d (`todoist.create_task`, good -> withheld, recipe butler-errand). The zero at day 0 is a TIMING ARTIFACT, not safety — the one keyable action was still inside its 24h durability window, so both rules withheld it for the same reason; reporting "0, safe to flip" off a single measurement would have been a wrong conclusion from a correct number. Small for a reason worth knowing: of 63 non-reversible successes, 50 are `agent` steps capturing no output and 12 are `http.post` with the id buried in a JSON string body, so only 1 is keyable. Fixing the key made the mechanism correct; it did not make it REACH much — step-output capture is the real unlock and is deliberately NOT smuggled in here. Load-bearing discovery mid-build: the pending-confirmation queue was ALSO URL-only, so flipping alone would have withheld the Todoist action and then never offered it for confirmation — permanently unearnable through any path. A gate that withholds an action it cannot let you approve is worse than no gate, so `PendingConfirmation` is now keyed by `actionKey` with an optional `ref`, and `POST /outcomes` + both dashboard pages + the `outcomes pending` CLI accept/emit the ref shape. Route rejects both key shapes together rather than guessing. A route test caught my own error-reporting defect (a URL-shaped tool name reported as "missing key", sending an operator to the wrong file) — fixed in the source, not the test. 8 new tests; default flip mutation-probed. — merged as #1319

- 2026-08-10 `feat/outcome-action-ref` — Generalise the outcome join key so a worker can earn trust from actions that are not GitHub issues. Investigation found the premise understated: across all 751 runs / 1226 tool-steps in `runs.jsonl`, **zero** carry `output.url`, so the disposition lookup has never fired in production for any tool (`github.create_issue` never ran in the retained window at all). Worse, `foldOutcome`'s withhold branch was guarded on `url &&`, so a non-reversible success with no URL fell through to `good:true` — full earned trust for work no human ever confirmed, the same trust-by-neglect class #1064 closed for issues. New `src/workers/actionRef.ts` keys on tool-name + external id (`todoist.create_task` returns a usable `id`; the Todoist API exposes no permalink, so synthesising a URL in the connector was rejected — it hardcodes a scheme we don't control and fixes one connector). **No migration**: rows key on `ref` when present else legacy `issueUrl`, namespaces provably disjoint (`canonicalActionRef` throws on a URL-shaped key); rewriting the sole evidence file the gate rests on, in place with no rollback, to gain uniformity is a bad trade — a missed lookup costs a WITHHOLD (safe), a botched migration costs the ledger. Unkeyable rows now reported, not silently dropped; `upsert` refuses a keyless record. **Deliberately inert**: `strictOutcomeJoin` defaults false (byte-identical to today) because flipping it de-rates every worker that earned trust from a non-URL action — correct, but a live change to the dial, so it ships measured (`foldJoinDelta`) and flips in a follow-up PR. 15 tests, all three halves mutation-probed red-then-green; fixture taken verbatim from the real run log, not invented (the dead Todoist connector hid behind 26 green mocks that all carried a `url` the live API never returns). — merged as #1318

- 2026-08-03 `feat/forbid-policy-predicate` (#1231, merged) — The `forbid` evaluation ADR-0017 specified, as a pure module (`src/workers/forbidPolicy.ts`), deliberately NOT wired yet. Forbidden means no earned trust AND no human approval unlocks it — must hold at L4/ceiling-4 and against an operator clicking Approve — which is why it can't live in `reachableLevels()` (an empty reachable set says 'cannot climb the ramp', a statement about autonomy, not about the action). Pattern language mirrors `ownsAction` (domain | exact classKey | prefix) so operators learn one syntax. KEY ASYMMETRY vs the roster: roster fails SOFT, a deny list must not — silently dropping a malformed forbid rule fails OPEN (the banned action becomes merely gated and a human can approve it), so `parseForbidRules` returns `invalid` positions and `describeForbidRules` shouts NOT in force. What to DO about invalid rules is left to the caller on purpose: refusing to start is right for a hosted workspace and hostile on a laptop. Empty rules forbid nothing, so it's entirely opt-in. 15 tests. — merged
- 2026-08-03 `docs/adr-decision-record-actor-and-forbid` (#1227, merged) — ADR-0017: decided to do the queued gate-record changes as ONE wire-format migration rather than two. Verified first that no persisted record names a human (`GateDecisionRecord` has `workerId` only; `DecisionTrace` has `sessionId`; "approver" in `approvalQueue.ts` appears only in token-handling comments), and that `GateAction` has no third terminal state. Both changes hit the same cross-process JSONL read by `gate explain` / `workers shadow` / `workers backtest` / `GET /gate/decisions` / dashboard, so they share one `gatePolicyVersion` bump (`worker-ramp-v0` → `v1`), no backfill, and an unknown-value formatter fallback that must ship before the first v1 record is written. Also records that `forbid` is a policy predicate evaluated before the trust maths, NOT an empty `reachableLevels()`. Docs only — no code change in this PR; implementation follows (identity first, then forbid). — merged
- 2026-07-10 `fix/mcp-session-init-handshake` (#1152, merged) — Root-caused a live "MCP error -32600: Not initialized" that survived multiple bridge restarts + a stale global npm reinstall (0.2.0-beta.7 vs repo's 1.1.0-beta.2, since fixed via `npm run install:global`). Real bug: `Bridge`'s WS `connection` handler keyed brand-new sessions by a server-generated `randomUUID()`, never by the client-supplied `X-Claude-Code-Session-Id` — so the grace-period resume lookup (`this.sessions.get(clientSessionId)`) could never match on reconnect, silently creating a fresh un-initialized session every time (bridge restart, sleep/wake, shim respawn). Since `scripts/mcp-stdio-shim.cjs` treats reconnects as transparent (never replays `initialize`), the client's original handshake was lost for good. Fixed by keying `sessionId = clientSessionId ?? randomUUID()`. Two adjacent bugs fixed alongside (found chasing the same symptom): `attach()` always reset `initialized=false` even on the grace-period resume path (contradicting its own "no re-initialization" contract) — now takes a `preserveInitialized` flag; `SUPPORTED_VERSIONS` only listed the newest MCP protocol version, silently upgrading clients that requested the original `2024-11-05` revision to a version they didn't ask for. All three test-first, full regression sweep green (117 tests), typecheck clean. — merged
- 2026-07-10 `fix/run-in-terminal-flakiness` (#1150, merged) — Fixed the top 2 of 6 ranked root causes found investigating `runInTerminal` flakiness. (1, fixed) `handleExecuteInTerminal` (vscode-extension/src/handlers/terminal.ts) returned `{success:false}` when shell integration hadn't attached yet (fresh terminal/SSH remote/headless), but the bridge (src/tools/terminal.ts) only fell back to subprocess execution on a literal `null` — so the documented fallback never engaged, surfacing as "fails once, works on retry." Fixed by tagging that specific case with `shellIntegrationUnavailable:true` and having the bridge check for it explicitly (every other success:false reason still surfaces as a real error, unaffected). (2, fixed) A fixed 500ms grace period after `onDidEndTerminalShellExecution` fires could silently truncate real buffered output arriving in bursts spanning >500ms, with no truncated flag set. Replaced with an idle-reset drain (keeps waiting while chunks keep arriving within 500ms of each other, capped at 3s total). Both fixed test-first (reproduced failing, verified against reverted code). Remaining, NOT yet fixed: (3) independent bridge/extension timeout clocks with a fixed 5s cushion WS backpressure can eat into; (4) `activeTerminal`-based reuse with no idle-check; (5) reconnect/circuit-breaker race using shared mutable state instead of a generation counter; (6) Windows-vs-POSIX backslash-validation mismatch between bridge and extension. Worked in an isolated worktree (`../worktrees/fix-run-in-terminal`). — merged
- 2026-07-04 `fix/dashboard-build-middleware-matcher` (#1130) — Found during a final pre-release sweep: `npm run build` (dashboard) has been failing since #990 with "Unknown identifier SESSION_GATE_MATCHER at config.matcher[1]" — undetected because CI never runs a production build, only dev/vitest. Next.js statically parses `config` in middleware.ts, so `config.matcher` entries must be literal syntax, not identifier references. Inlined the literal; `SESSION_GATE_MATCHER` (used by middleware.test.ts) now derives from `config.matcher[1]` at runtime instead. Confirmed real by stashing the fix and reproducing the build failure. — merged
- 2026-07-07 `feat/telegram-connector` (#1140) — New Telegram connector (bot-token PAT from @BotFather): src/connectors/telegram.ts + src/recipes/tools/telegram.ts (send_message/get_chat/get_updates), wired through all the standard call sites (connectorRoutes.ts, gmail.ts loaders map, connectorRegistry.ts, connectorPreflight.ts, tools/index.ts) plus dashboard (connections/recipes/marketplace catalogs, the legacy connect/test/delete allowlist pin test). Connector count 46→47 in documents/platform-docs.md. Full backend (8969 tests) + dashboard (1128 tests) suites green, typecheck/tests-core/biome/audit gates all clean. — merged
- 2026-07-07 `test/shadowscan-replayrun-coverage` (#1138) — Resultmaxxing Track D1 continued: shadowScan.ts (39%→95% lines, covering runShadowScanCli's path resolution/size-limit/exit-code behavior) and replayRun.ts (54%→96% lines, covering replayMockedRun's entrypoint — taskId tagging, unmocked-step reporting, error handling, the env-allowlist enforcement). Both files previously had partial test coverage on their pure helper functions only, leaving the actual entrypoints untested. — merged
- 2026-07-07 `feat/dashboard-friendly-mode` (#1139) — Non-technical-user UX pass across the dashboard (presentation-layer only, no theme redesign, no bridge changes): Overview panel names (attention/tail/fleet/next/workers → plain English), raw halt-reason translation on the attention panel, humanized subtitles + trigger-filter chips + recipe display names + enabled-first sort + sparkline empty-state on Recipes, plain subtitles + OAuth-scope-chip translation on Connections, plain subtitle + "Open config file" action on Settings, plain subtitle on Marketplace, Analytics onboarding banner for zero-data state, header connection indicator ("Connected · this Mac", full address on hover), and a new Simple/Advanced sidebar toggle (localStorage-persisted, defaults new/first-run browsers to Simple via a returning-user heuristic, existing installs stay Advanced). Full dashboard test suite green (1139 tests) + typecheck + lint + production build all verified. — merged
- 2026-08-03 `feat/gate-decision-actor` (#1232, merged) — Actor attribution on GateDecisionRecord (ADR-0017). Stored as a SNAPSHOT (id + kind + displayName-as-it-was), not a roster reference: resolving at read time would silently rewrite history when someone is renamed or changes role. CORRECTS ADR-0017 with a dated implementation note — the ADR said one migration/one version bump for actor+forbid, but the two halves version differently: an optional new FIELD is genuinely additive (old readers ignore the key), while a new ENUM VALUE breaks exhaustive switches. Bumping gatePolicyVersion for the actor would also be a false signal, since its documented meaning is the thresholds that produced the row and no threshold changed. So actor ships at worker-ramp-v0; the v1 bump lands with `forbid`, which earns it (enum widening AND a real policy change). Formatter says 'not recorded' rather than omitting the line, so absence reads as absence rather than as not-applicable. 22 gate-format tests. — merged
- 2026-08-03 `feat/forbid-terminal-state` (#1233, merged) — Completes ADR-0017. Widens `WorkerGateAction`/`GateAction` to include `forbid`, opens the writer-side validator, adds the FORBIDDEN formatter branch, wires `isForbidden` into `decideWorkerAction`, bumps GATE_POLICY_VERSION v0→v1 (the change that earns it per the ADR's implementation note). Forbid is evaluated FIRST — before the agent carve-out, before reversibility, before any trust maths — because any branch preceding it is a path around it; a broad rule can therefore stall every worker on its agent step, which is a loud self-explaining failure vs. the silent alternative of permitting a banned action. Two of my test assumptions were wrong, not the code: gitPush classifies as `vcs-push` not `vcs-remote`, and WorkerLevelStore has no setState (there's an existing storeWithL4 helper). The #1229 forward-compat tests correctly failed once `forbid` became real and were repointed at a still-unknown value. Old-record v0 fixtures deliberately left at v0 so the formatter tests exercise a mixed log. 249 tests green across gate/workers/orchestration; full backend 9147 pass. — merged
- 2026-08-03 `feat/boundary-http-route` (#1243) — GET /workers/boundary?recipe=<name>, the HTTP route GAP-2 (control boundary) needed to reach the dashboard: a thin wrapper over `boundaryForRecipe` (#1241) following the `GET /gate/decisions` pattern exactly — `boundaryForRecipeFn` deps field, wired through `server.ts` → `recipeOrchestration.ts` with a static import (not the lazy `import()` the async `workerShadowFn`/`simulateFn` siblings use, since `boundaryForRecipe` is synchronous and the deps type can't await). 400s when `recipe` is missing; returns `{boundary: null}` when no worker owns the recipe (the honest "nothing to show" distinct from an empty boundary) or when the fn isn't wired. 3 new route tests, full backend build/typecheck/biome/lsp-audit clean. — merged
- 2026-08-03 `feat/dashboard-boundary-panel` (#1244) — Dashboard wiring, the last GAP-2 step: a `workers/boundary` static proxy segment (`dashboard/src/app/api/bridge/workers/boundary/route.ts`), needed for the same reason `recipes/doctor` needed one — without it the request falls through to the dynamic `workers/[id]` proxy, which would treat "boundary" as a worker id and drop the `?recipe=` query. `BoundaryPanel.tsx` mirrors `DoctorPanel.tsx`'s click-to-run + autoRun pattern and renders the presentational `ControlBoundary` component (already shipped, unused until now) with the resolved boundary; a `null` boundary (no worker owns the recipe) renders as a quiet note, not an error, since that's the honest answer. Mounted as a third diagnostics-fold panel on the recipe detail page, alongside Doctor and What-If Preview. Dashboard typecheck/lint/build + full recipes test suite (48 tests) all clean. This closes out GAP-2 (control boundary) — repo-side work on the finance-demo capability is done; what remains is demo material that stays out of this repo. — merged
- 2026-08-03 `feat/durable-approval-log` (#1245, merged) — First slice of ADR-0018 ("persist the request, not the await"). `src/approvalPersistence.ts`: an append-only JSONL event log (`request` / `decision` events) rather than a mutable current-state store — the ADR calls out that a mutable queue would need a compaction/tombstone story a plain event source doesn't. `ApprovalQueue` gains an optional `persistDir` (omitted ⇒ unchanged in-memory-only behaviour, so every existing test and call site is untouched): `request()` appends a request event, every resolution path appends a decision event, and construction replays the log to restore any request that never got a matching decision as `pending, owned:false` — a request already past its expiry while the process was down resolves as `expired` immediately rather than re-entering the live queue; a still-live one gets a fresh timer for its remaining time. `clear()` (bridge shutdown) deliberately does NOT write a decision, so a shutdown-interrupted entry survives to be restored next launch — a restart is not a decision, per the ADR. New `owned` field threaded through `PendingApproval`/`list()`/`peek()`; NOT yet surfaced in the dashboard/CLI (the ADR calls that "the bulk of the work, UI not storage" — deliberately deferred to a follow-up so this PR stays reviewable). Params are truncated before hitting disk (a durable log outlives the process and gets grepped/backed-up, unlike the in-memory queue). 18 new tests (9 persistence, 9 queue-restore); full backend suite green except the two pre-existing local-only noise sources (untracked QUMO ta/ files, tokenEfficiency reading the live lock) — neither touched by this change. — merged
- 2026-08-03 `feat/unowned-approval-visible` (#1246, merged) — ADR-0018 point 4 ("`unowned` is visible, not silent"), the UI half the storage slice (#1245) deliberately deferred. Surfaces `owned:false` on the dashboard approvals card in the three places an operator could be misled: a "No waiting caller" badge, a body line saying approving records but does not run the action, and — the one that actually matters — the high-tier approve confirm, whose normal "this cannot be undone" wording is exactly BACKWARDS for a restored entry (nothing runs, so nothing needs undoing; the real risk is believing it ran). Success toast likewise says "recorded only". Gated on `p.owned === false`, never on falsiness: `undefined` is a pre-durability payload shape where every listed entry had a live caller, and treating that as unowned would put a false warning on every ordinary approval. No bridge change needed — `GET /approvals` already returns `queue.list()`, which carries `owned` since #1245. 6 new tests (badge shown/hidden across owned/unowned/absent, both confirm wordings); full dashboard suite 1193 green, typecheck/lint/build clean. — merged

- 2026-08-03 `feat/load-workspace-roster` (#1230, merged) — Wires the identity model (#1228) into bridge startup: `server.roster = loadRoster()` plus a startup log line. Prerequisite for ADR-0017's actor field — nothing loaded the roster, so there was no actor to write. New `describeRoster()` surfaces REJECTED entries by position; without it a typo silently removes a member (they never appear, nothing errors), the worst failure mode for a file that decides who may approve things. Uses the identity module's own `defaultRosterPath()` rather than bridge.ts's `patchworkDir`, because the former honours PATCHWORK_HOME and the latter doesn't — noting in passing that PATCHWORK_HOME is honoured in ~8 places and hardcoded in ~70, a pre-existing inconsistency NOT addressed here. Nothing consults the roster for authorisation yet; no behaviour change. 45 identity tests + 127 bridge tests green. — merged
- 2026-08-03 `fix/gate-decision-unknown-action` (#1229, merged) — ADR-0017 pre-work, and it turned up a real latent hole rather than the cosmetic one the ADR anticipated. TWO sites assume the gate action has exactly two values. (1) `formatGateDecision` was `action === "allow" ? ALLOWED : GATED` — never threw, which is why it looked safe; an unrecognised action was silently reported to an operator as "GATED (asked for approval)", i.e. awaiting a decision, when for `forbid` no approval can ever unlock it. (2) Worse, `recipeOrchestration.ts:223` routes `allow` → flow and EVERYTHING ELSE → queue for human approval, so a `forbid` decision would be offered to a human as approvable and a human approving it would let it through. Both fixed test-first (2 failing tests reproduced (1) before the fix). New `gateOutcomeFor()` in workerGate.ts maps action → flow|queue|refuse with refuse as the DEFAULT, so an action this build doesn't understand is neither performed nor offered to a human. Latent today — only "gate" reaches the non-allow path — which is why it was cheap now. 219 tests green across workers/gate/orchestration. — merged
- 2026-08-03 `feat/workspace-identity-model` (#1228, merged) — First slice of workspace identity, the prerequisite ADR-0017 named: the bridge authenticates one bearer token, so no persisted record can name a person and segregation of duties is unenforceable rather than merely unimplemented. Adds `src/identity/` as three leaves with no transport dependency — `roles.ts` (6 roles, 9 coarse capabilities, members hold a SET of roles so admin never silently means approver), `members.ts` (member record + `canApproveAction`, which checks self-approval BEFORE capability so an owner approving their own work is refused), `roster.ts` (members.json, fail-SOFT to a single implicit owner — deliberately opposite to ADR-0016's fail-closed, because this decides who you are on your own machine, not whether an action happens). No wiring into request handling and no actor on any record yet: behaviour is unchanged. 41 tests. — merged
- 2026-07-06 `docs/security-register` (#1132, merged) — Resultmaxxing Track A1: consolidated every open finding across audit-2026-06-03/08/09/19 + bridge-changelog-audit-2026-06-25 into docs/security/register.md. 93 deduped findings, verified against live code rather than trusted from each doc's self-report: 71 FIXED, 15 STILL-OPEN, 2 WONTFIX, 5 UNVERIFIABLE. All 4 flagged "known-open candidates" (mcpClient init race, parallel:{each} no-op, negative retry, cron field validation) + the beta.12 npm leak turned out already fixed — including a chainedRunner negative-retry item that looked open on first grep but proved a false alarm once the existing test was run directly (withRetry() clamps maxRetries one call deeper than the assignment site). First of a 4-track sequential plan (A: security, B: docs-at-code, C: perf, D: test cliffs) — running one track/PR at a time. — merged
- 2026-07-06 `fix/outcomes-classify-issues-risk-tier` (#1133, merged) — Resultmaxxing Track A2 delta sweep found `outcomes.classify_issues` (recipe-callable tool) mutates the worker trust ledger from unverified caller-supplied JSON; fixed test-first (riskDefault medium→high). Everything else checked (gate-decision-log write path, new HTTP routes, dashboard proxy auth, copilot propose-vs-execute boundary) came back clean. — merged
- 2026-07-06 `docs/seam-jsdoc` (#1135, merged) — Resultmaxxing Track B2: real JSDoc (contract + error behavior) added to the 7 most-imported internal seams (src/tools/utils.ts 145 importers, src/recipes/toolRegistry.ts 67, src/extensionClient.ts 66, src/connectors/baseConnector.ts 37, src/fp/interpreterContext.ts, src/runLog.ts, src/workers/workerGate.ts). Fixed an incidental malformed duplicate JSDoc opener found in extensionClient.ts. — merged
- 2026-07-06 `docs/subsystem-readmes` (#1134, merged) — Resultmaxxing Track B1: 8 subsystem READMEs (src/workers/, src/recipes/, src/connectors/, src/fp/, src/tools/, dashboard/src/, vscode-extension/src/, services/push-relay/), each ≤80 lines. Side finding: independently reconfirmed the register's two UNVERIFIABLE TA-desk items (H8, H9) are both FIXED. — merged
- 2026-07-06 `docs/audit-docs-drift` (#1136, merged) — Resultmaxxing Track B3: advisory docs-drift guard script (tool-count/coverage-threshold claims vs. ground truth) + fixed a real stale claim (CLAUDE.md said 75/70/75 coverage, actual is 71/62/70 after an intentional vitest 4 re-baseline). — merged
- 2026-07-07 `test/haltpushdispatch-approvalinsights-coverage` (#1137, merged) — Resultmaxxing Track D1: real behavioral tests for the two 0%-coverage test cliffs, haltPushDispatch.ts (0%→100% lines) and approvalInsights.ts (0%→100% lines/functions, 93% branches). — merged

- 2026-07-04 `fix/copilot-audit-findings` (#1118) — 5-agent parallel audit of the Overview page + copilot subsystem (correctness/security/a11y/perf/CSS-consistency). Security + CSS came back clean. Fixed: a real race where the 5s recipes poll could clobber a copilot toggle's optimistic state (time-based grace window + regression test), `.td-pill-critical` missing prefers-reduced-motion gating, copilot send button missing aria-label, bot replies not live-announced, unbounded `copilotMessages` growth, auto-scroll fighting manual scroll position. — merged
- 2026-07-04 mockup-mining campaign, 6 PRs (#1123, #1125, #1126, #1124, #1127, #1128, #1129) — 4 parallel audit agents mined the "Patchwork UI Variations" mockup artifact for further Overview-pane improvements (~37 ideas total across attention/approvals, fleet/next, workers, vitals/inbox). Built the ones that were both cheap and backed by real data the panes already fetch; explicitly dropped ideas that would've fabricated data (7-dot worker activity sparkline — no per-day timestamps exist) or relitigated settled design decisions (fleet's per-run sparkline vs. the #1109 packed fill-bar, 3:next's paused-recipe digest vs. the crowding-bug fix that collapsed it to a count). #1123: restored a richer "Unified morning" section (user rejected a first, too-minimal attempt). #1129: gate-activity in 4:workers became a collapsible per-worker accordion per explicit follow-up request, also fixed a latent `.td-sp` CSS bug from #1123. Each PR cut from main independently — repeated rebase/conflict-resolution churn as they landed sequentially (interleaved test/JSX conflicts, duplicate-import artifacts), fully documented in the session transcript. — merged
- 2026-07-04 `feat/copilot-improvements-round2` (#1117) — Decision Record attribution (POST /traces/decision, source:copilot), ambiguous-recipe-match disambiguation (was silently guessing on ties), Undo on pause/enable action cards (fixed a real stale-`recipes`-array bug found while building it), read-only Q&A ("approvals pending"/"kill switch status"). Verified live: real pause→confirm→Undo cycle + Decision Record traces checked directly in `decision_traces.jsonl`. — merged
- 2026-07-04 `fix/copilot-pane-ui-polish` (#1116) — UI polish pass on the Tier-1 copilot pane (#1114); found 5 real CSS/JSX class-name mismatches that left the input row, action-buttons row, "done" state, recipe-name emphasis, and empty-state hint completely unstyled. Fixed + added entrance animation, thinking indicator, auto-scroll, accent "run" pill. — merged
- 2026-07-04 `feat/copilot-tier1-lever-actions` (#1114) — Built the Overview deck's `7:copilot` pane from the terminal-deck mockup (found in the artifact HTML, not previously discovered — `.hd-chat`/`.hd-msg`/`.hd-act` markup). Tier 1 only: deterministic (no-LLM) intent parser for pause/enable/run-a-recipe-by-name + explain-a-recent-halt; `POST /copilot/message` only ever proposes `{reply, action?}`, never executes; the action card's Confirm button reuses the exact same gated hooks the rest of the deck already uses (`useToggleRecipeEnabled` — newly extracted from `recipes/page.tsx` so both call sites share one confirm-gated implementation — and the pre-existing `useRunRecipe`), never a raw endpoint bypass. Recipe/worker AI-creation (mockup tiers 2/3) explicitly deferred — needs a generation endpoint + lint/preflight + much more safety review. Verified live end-to-end against the real running bridge (required a global reinstall + launchd-managed restart, done with user confirmation). — merged
- 2026-07-04 `feat/deck-phase4-halt-age-mute-footer` (#1113) — Terminal deck v2 Phase 4 (the item #1103 explicitly deferred): halt-age escalation (1h/6h tiers, inside the pane's existing 24h data window), mute-24h fingerprinting fix (a new/different halt now bypasses an active mute instead of being hidden for the rest of the window), footer keyboard-shortcut hint, and a stale "Terminal+Copilot" doc-comment cleanup (no Copilot pane/component ever existed to clean up beyond that one comment). 6 new tests. — merged
- 2026-07-04 `feat/dashboard-fold-today-into-overview` (#1112) — User request: fold the standalone `/today` page into Overview instead of keeping it a separate destination, restyled to the deck's terminal/pane aesthetic rather than pasted in with its old card styling. "Clear the decisions" → worker-verdict confirm queue (previously absent from Overview entirely) folded into `0:attention` with inline Confirm/Reject; "Glance at the team" → one-line promote/demote rollup added to `4:workers`' header (per-row markers already existed); "Read the brief" → `6:inbox`'s existing NEW/read distinction judged sufficient, no new UI. Removed `/today` (page/hook/tests) + its sidebar entry; "Today" nav section renamed "Home". — merged
- 2026-07-04 `fix/deck-motion-a11y-inbox-next-polish` (#1111) — Committed + shipped leftover uncommitted polish found on disk at session start (brand-mark SVG parity fix, tabular-nums CSS, cron-queue header label) — see the superseded entry below for what this covered. — merged
- 2026-07-04 `feat/deck-motion-a11y-inbox-next-polish` (#1110, superseded by #1111 above for a small leftover piece) — Continued mining visual refinements against the mockup after #1108/#1109 merged. Reconciles 3 pieces of work from a prior chat session (stashed, now applied cleanly, no conflicts): (1) live-run pulse on the fleet `▶` glyph (data-backed via `runList[0]?.status === "running"`), fade-in on the fleet bar / worker dial when their computed value changes between polls (`.td-tail-enter` reused via key-based remount), `title` tooltips on the previously `aria-hidden` glyphs (`▶/⏸`, `▰/▱`, `⚑`, `▼`); (2) `6:inbox` header gets a `· N unread` count, read (non-new) rows get a muted "read" label matching the mockup's NEW/read vocabulary; (3) `3:next` header gets a `· cron queue` subtitle, and `1:tail`/`3:next`/`5:vitals` pane bodies get `font-variant-numeric: tabular-nums` (mockup's `num` class convention — `2:fleet`/`4:workers` don't need it, their numbers sit in monospace `.hd-ascii`-style blocks already fixed-width). Also confirmed (no code change needed): `4:workers` already scales correctly to multiple agents — `workers.slice(0,6).map(...)` renders one row per worker with the gate-activity feed shared once below, not per-row. CSS/JSX-only. — merged

- 2026-07-04 `fix/deck-fleet-workers-visual-fidelity` (#1109) — User, after viewing the live rate-budget/session-tag features: "the workers and fleet pane still don't look the same in terms of animated icons." Compared pixel-for-pixel against the mockup screenshot rather than markup alone; found two real gaps. `2:fleet`: mockup uses one continuous proportional fill bar (packed solid blocks, width = success %) — we rendered 6 separate spaced-out per-run history dots, a different metric shown a different way. Rebuilt as an 8-char packed fill bar sized to the existing `pct` (success rate) value; disabled recipes now render a flat dashed line + "off" (mockup's nightly-review row) instead of the play glyph + bar. `4:workers`: mockup puts the ceiling label BEFORE the dial ("L3 ▰▰▰▱"), we had dial-then-label — reversed order to match; also reversible-only workers now show "—" instead of "L0" with a fully-empty dial (mockup's inbox-summ. row), since the ceiling is meaningless for reversible-only work. CSS-only + one JSX reorder, no data-source change. — merged

- 2026-07-04 `feat/deck-session-tags-and-rate-budget` (#1107) — Closes the two items #1106 explicitly deferred (session-ID tagging, rate-budget bar) after two Explore agents investigated feasibility. Session-ID: confirmed live via curl against the running bridge that `sessionId` genuinely flows end-to-end already — dashboard-only render fix, no backend change. Rate-budget: added `McpTransport.getToolRateLimitState()` (side-effect-free refill snapshot) + a `toolRateLimit` field on `Bridge.statusFn`, aggregated as the most-constrained session. Dashboard: new `BridgeStatus` field + `.td-bar2` fill bar in `5:vitals`. Bridge-side change — needs a bridge restart to take effect. — merged
- 2026-07-04 `fix/deck-layout-wording-parity` (#1106) — Terminal deck visual-parity, round 3: statusline wording, attention header item-count+duration, fleet N/M-on count, tail breadcrumb, vitals approvals-pending row. Explicitly deferred session-ID tagging and rate-budget bar (no backend data at the time) — see the entries above. — merged
- 2026-07-04 `fix/deck-visual-parity` (#1105) — Terminal deck visual-parity pass against the mockup's actual "H-D · Terminal" markup+CSS. First commit: island card, segmented statusline, pane titlebar background. Second commit (icon/animation parity): `4:workers` diamond trust dial (`▰▰▰▱` + `⚑L{n}` flag + `▼` demoted), `0:attention` `└` tree-branch sub-line, `1:tail` `● live`/`● reconnecting` badge. — merged

- 2026-07-04 `fix/deck-pane-row-height-consistency` (#1102) — Terminal deck v2, grid-geometry reconciliation pass: `.td-pane-body` gets a max-height + scroll cap (260px) so a content-heavy pane never stretches its grid row taller than a light neighbor. CSS-only, no logic change. — merged
- 2026-07-04 `feat/deck-staleness-and-cancel` (#1103) — Terminal deck v2 Phase 3: surface the already-existing staleness/cancel infra IN the deck itself. Statusline clock flips to "data as of HH:MM:SS — reconnecting…" (amber) when any deck fetcher is stale (reusing `staleFetchRegistry`/`useBridgeFetch`'s `stale` field from #1097). Live runs on `0:attention` and the tail row get a Stop control (reusing `useCancelRun`/`CancelRunDialog` from #1099). Phase 4 (halt-age escalation, footer hint, polish) and a separate visual-parity pass against the mockup follow. — merged
- 2026-07-04 `feat/deck-workers-gate-activity` (#1101) — Terminal deck v2 Phase 2: `4:workers` pane gets a "gate activity" feed below the trust lines — last ~6 `GET /gate/decisions` entries, terminal-style rows, expandable to a plain-English `gate explain`-style rendering. First-ever dashboard surface for the Decision Record. — merged
- 2026-07-03 `feat/dashboard-terminal-deck-phase1` (#1095) — Terminal+Copilot deck plan PR 6/10: full rewrite of `app/page.tsx` replacing the PR #1085 Command Deck bento with the "Home D · Terminal (dark)" statusline + 7-pane mono grid. — merged
- 2026-07-04 `feat/run-cancel-ui` (#1099) — dashboard gap remediation item 4: `POST /runs/:seq/cancel` had zero dashboard consumers. Stop control + confirm dialog wired into GlobalLiveRunsStrip, LiveRunsStrip, /runs list rows, /runs/[seq] header. — merged
- 2026-07-03 `feat/connector-token-expiry` (#1098) — dashboard gap remediation item 2: connector `getStatus()`/`/connections` gets optional `tokenExpiresAt`/`lastSuccessAt`; connections card renders expiry pill + last-call line. Bridge-side — needs snapshotting to `../patchwork-multitenant/src/`. — merged
- 2026-07-03 `fix/dashboard-staleness-indicator` (#1097) — dashboard gap remediation item 1 (bug-shaped, Bug Fix Protocol: failing test first): `useBridgeFetch` kept last-good data forever with no freshness marker. Added `lastSuccessAt` tracking + `stale: boolean` + one global Shell strip aggregating across all opted-in fetchers via a small registry, not per-page banners. No poll-interval changes, no new endpoints. — merged
- 2026-07-03 `docs/gap-assessment-verify-orphans` (#1096) — dashboard gap remediation item 0 (verify-first): confirmed all 4 "possible orphan" endpoints flagged in docs/dashboard-gap-assessment-2026-07-03.md are real, missed by the original scan (proxy-route/shared-hook consumers). No UI work. — merged
- 2026-07-03 `feat/dashboard-killswitch-confirm` (#1093) — Terminal+Copilot deck plan PR 4/10 (last of the prep sequence): shared confirm dialog for engaging/releasing the kill-switch, wired into `KillSwitchBanner.tsx` and `settings/page.tsx`'s `ToggleRow` — neither had a client-side confirm before. — merged
- 2026-07-03 `feat/decision-record-http-source` (#1094) — Terminal+Copilot deck plan PR 5/10: Decision Record HTTP route (`POST /traces/decision`, Bearer-gated) + optional `source` field on `DecisionTrace`/`RecordDecisionInput`, backward-compatible with existing `decision_traces.jsonl`. Ships standalone value; no dashboard wiring yet. — merged
- 2026-07-03 `feat/dashboard-shared-hotkey-hook` (#1092) — Terminal+Copilot deck plan PR 3/10: consolidate the 6x-duplicated tag/isContentEditable keyboard-shortcut guard pattern into a shared `usePaneShortcuts`/`useGlobalHotkey` hook in `dashboard/src/hooks/`. Pure refactor, no behavior change. — merged
- 2026-07-03 `feat/dashboard-recipe-run-health-extract` (#1091) — Terminal+Copilot deck plan PR 1/10: extract `allRunsMap`/`successPct`/`avgDuration` out of `app/recipes/page.tsx` into `dashboard/src/lib/recipeRunHealth.ts` as pure functions, golden-master tested, reconciled with the duplicate implementation in `recipes/[...name]/page.tsx`. No UI change. — merged
- 2026-07-03 `feat/dashboard-today-page` (#1090) — dashboard redesign Deliverable 2 (new "Today" page, `app/today/page.tsx`, ADDITIVE): single 840px column, hero (overnight run/halt count + 3-segment progress), §1 read-the-brief, §2 clear-the-decisions (blast badges + worker verdicts + reversible-batch), §3 glance-at-the-team. Added to sidebar above Overview. Spec: docs/plans/dashboard-redesign-2026-07-03.md Deliverable 2. — merged
- 2026-07-03 `docs/terminal-copilot-deck-plan` — 6-agent parallel research + synthesis pass (Workflow tool, user-requested "team of agents rigorously plan") producing docs/plans/dashboard-terminal-copilot-plan-2026-07-03.md: refined implementation plan for the "Terminal + Copilot" dashboard landing page redesign. Key findings: 5/7 panes are pure reuse of existing app/page.tsx state; workers+inbox panes need net-new fetch wiring; cron-countdown pane can reuse dashboard/src/lib/humanSchedule.ts (no new parser needed); copilot's "chat proposes, buttons dispose" safety only holds if action cards bind to gated handlers (handleToggleEnabled/handleRunClick/useRecipeInstall().handleInstall) not raw endpoints — kill-switch has NO existing confirm-gate to inherit and needs a prerequisite PR; Decision Record attribution needs a new HTTP route + schema field. 10-PR sequencing + 7 open questions for the user. Planning only — no implementation started. — build session
- 2026-07-03 `feat/dashboard-traces-waterfall` — dashboard redesign page 7/7 (Traces → "Waterfall", mockup T-A): investigated `app/traces/page.tsx` — the tree-view waterfall (per-lane `SpanBar` timing bars, `TYPE_THEME` color legend matching the mockup's blue/amber/green/purple/red, flat view behind a toggle, header stats + live-poll pill) was already built in an earlier session and reviewed clean against spec. No code changes — no PR needed. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 7. All 7 core pages now done (1/#1080, 2/#1081, 3/#1083, 4/#1084, 5/#1085, 6/#1086, 7/no-op). — build session
- 2026-07-03 `feat/dashboard-marketplace-storefront` (#1086) — dashboard redesign page 6/7 (Marketplace → "Storefront", mockup M-A): `app/marketplace/page.tsx` — featured split hero (recipe of the week + "Before you install" facts: risk pill, approval behavior, connectors, network/file I/O, install count) above horizontal-scroll themed shelves (Start here, GitHub automation, etc); tiles (risk pill + ↓count + Install/Review); search replaces shelves with the flat filtered grid. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 6. — merged
- 2026-07-03 `feat/dashboard-home-commanddeck` (#1085) — dashboard redesign page 5/7 (Home → "Command Deck", mockup H-C): `app/page.tsx` — dense 12-col bento above the fold; row 1: needs-attention (span 7) + live-now (span 5); row 2 (3× span 4): 24h run heatmap, vitals KV, top-recipes leaderboard. Removes the quilt-hero/kanban/first-run-checklist landing treatment (checklist kept only for genuinely-new/empty workspaces). Spec: docs/plans/dashboard-redesign-2026-07-03.md item 5. — merged
- 2026-07-03 `feat/dashboard-inbox-mailclient` (#1083) — dashboard redesign page 3/7 (Inbox → "Mail client", mockup I-B): investigated `app/inbox/page.tsx` — the two-pane mail-client layout was already built in an earlier session (`.inbox-twopane`/list/reader panes, folder chips, provenance strip, 65ch markdown, Replay/Trace/Archive/Delete toolbar, mobile back app-bar). Only change: removed a dead unused `RecipeIcon` component. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 3. — merged
- 2026-07-03 `feat/dashboard-workers-roster` (#1084) — dashboard redesign page 4/7 (Workers → "Roster", mockup W-A): `app/workers/page.tsx` — card grid `minmax(320px,1fr)`; 64px SVG trust dial (arc=earned, tick=ceiling, "L{n}"/dashed "new") replacing the 5-stop `RosterBar` strip; 4-seg progress strip; leash sentence; promote strip w/ "Raise limit"; DotStrip footer; reversible-only note; three stat tiles; queue above grid; expert mode reveals classKeys/HBarList/ramp-vs-gate via DetailsFold. Builds on merged W1/W2 (#1078/#1079). Spec: docs/plans/dashboard-redesign-2026-07-03.md item 4. — merged
- 2026-07-03 `feat/dashboard-recipe-dossier` (#1081) — dashboard redesign page 2/7 (Recipe detail → "Dossier", mockup D-A): `app/recipes/[...name]/` — sticky 280px identity rail (name/status/desc, Run now/Enable/Edit YAML, facts list, relation links, quiet danger zone at bottom) + content stack (doctor-first card, YAML "what it does", run history) via new `RailContext`. Killed the Overview/Edit/Plan tab bar in `layout.tsx`. Spec: docs/plans/dashboard-redesign-2026-07-03.md item 2. — merged

- 2026-08-06 `docs/butler-large-print-plan` — build scope for the Butler UI in the large-print (accessibility-led) direction: bridge HTTP surface for facts, the standing-permission record (the object every mockup leans on and nothing implements), then the page. Accessibility criteria are the deliverable, not aspirations. ~12 days, three independently-useful phases. — in progress

- 2026-08-05 `feat/butler-errands-worker` — Butler walking-skeleton Phase 3: `tasks`/`tasks-read` action-class domains (todoist/asana writes were classifying as `other:irreversible` — gated correctly but told an operator nothing), plus the butler-errands worker manifest + butler-errand recipe. Ceiling 1 so every write stays human-approved: the approval IS the demo. Inbound chat deferred — Telegram webhooks need a public HTTPS endpoint a local bridge lacks. — in progress

- 2026-08-05 `feat/butler-fact-store` — Butler walking-skeleton Phase 1: `src/butler/` append-only bitemporal fact store (never rotates, unlike decisionTraceLog), pure deterministic resolver (never a model call), trust=min(provenance,content) with connector text capped at 0.3, + butlerRemember/butlerRecall/butlerForget MCP tools. Storage only — nothing injects facts into a prompt yet. — in progress

- 2026-08-05 `docs/butler-walking-skeleton-plan` — scope doc for "Mr. Butler" (partner deck): one thin vertical slice through all five gaps (fact store → Telegram loop → one gated action → live on it a week) rather than finishing any one gap. Records the three deck claims that must change (undo, "preconfigured", maker-checker) and what is deliberately deferred (memory poisoning sidestepped via hand-seeded facts, not solved). — in progress

- 2026-08-05 `fix/action-class-magnitude-bands` (#1262) — action-class keys gain an instance-derived magnitude band for value-bearing domains (`payments:irreversible:high:band<=50`); adds a `payments` domain + riskTier overrides so money movement rates high blast rather than the generic namespaced-write "medium"; `GATE_POLICY_VERSION` → `worker-ramp-v2` with pre-v2 state left unreachable (NOT migrated — migration launders the trust the band separates). Guard rail placed before the capability: no payments tool is registered yet. — in progress

- 2026-07-03 `feat/dashboard-humane-w2-roster` (#1079) — humane-redesign W2: workers roster rows + per-worker drawer (compact row: avatar, status chip, 5-stop `RosterBar` + 🔒 limit; JourneyStepper/timeline/per-task/ramp-vs-gate relocated into the drawer) — merged
- 2026-07-03 `feat/dashboard-humane-w1-workers` (#1078) — dashboard humane-redesign slice W1 (workers Bands 1+2) + a small bridge change. BRIDGE: thread the filing `title` (already echoed by `github.create_issue`) through `PendingConfirmation` in `computePendingConfirmations` + `formatPendingConfirmations` (`src/workers/runWorkerShadow.ts`) so the review queue can show "Login test failing on main" not a bare URL — must be snapshotted into `../patchwork-multitenant/src/`. DASHBOARD (`app/workers/page.tsx`): Band 1 team header ("Your AI team — N workers" + a one-sentence triage "N need your review · M ready for a promotion" / "All good", plus the rubber-stamp check collapsed to a single amber sentence only-when-triggered, telemetry → details); Band 2 review queue humanized (title + worker + relative time, lifted `/outcomes/pending` fetch shared with the triage count); verdict history collapsed to a "Past verdicts (N · X real, Y not)" disclosure; replaced the local `expert` useState with the shared `useExpertMode`/`ExpertToggle`. WorkerCard roster + per-worker drawer is W2. Spec §4, §7. — build session

- 2026-07-03 `feat/dashboard-humane-r1-recipe-header` (#1077) — humane-redesign R1 recipe detail Bands 1+2: `StatusMedallion` status header (pure `lib/recipeStatus.ts` deriver) + plain schedule (`humanizeSchedule`) + Run now/**Pause**/`ExpertToggle`; conditional **Needs you** band (`haltPhrasing` + one grouped fix button); **Danger zone** fold ("Delete this recipe"); folded Doctor + What-If under details ("Check for problems" / "Preview what it would do"). Review-polish included. — merged
- 2026-07-02 `feat/dashboard-humane-s1-primitives` (#1076) — humane-redesign S1 shared primitives: `StatusMedallion`, `DotStrip`+`workedSentence`, `DetailsFold`/`ExpertToggle`/`useExpertMode` (localStorage-persisted, same-tab-synced), `lib/humanSchedule.ts`, `lib/haltPhrasing.ts`; 33 unit tests — merged
- 2026-07-02 `feat/workers-page-confirm-ux` (#1075) — dashboard `/workers` "speak-human" pass + trust-journey (stepper + "How it got here" history timeline + attention-first fleet sort); plain per-task record replacing the L0–L4 dial; page-level "Show details" toggle; confirm-loop polish — merged

- 2026-07-02 `feat/pending-outcomes-visibility` (#1074) — roadmap plan slice #4 (make the confirm queue visible): `computePendingConfirmations` join (runs × dispositions) in runWorkerShadow → `patchwork outcomes pending [--json]` + `GET /outcomes/pending` (new `pendingConfirmationsFn` dep) + an "Awaiting confirmation" one-click confirm/reject panel on dashboard `/workers` — merged

- 2026-07-02 `feat/outcomes-http-confirm-panel` (#1073) — roadmap plan slice #3 (outcomes over HTTP + confirm panel): bridge `GET/POST /outcomes` (Bearer-gated, `outcomeStoreFn` dep) + a one-click Confirm/Reject "Filed outcomes" card on dashboard `/workers`. NEVER a recipe step / MCP tool (self-confirm prohibition). Load-bearing fix: a single shared `resolveOutcomeLogDir()` so the outcome-log WRITE (CLI/ingester/POST) and the trust-replay READ (runWorkerShadow) agree on one file even under PATCHWORK_HOME — merged

- 2026-07-02 `fix/foldoutcome-junk-reorder` (#1072) — roadmap plan slice #2 (evidence-integrity bug, test-first): reorder `foldOutcome` (src/workers/shadowObserver.ts) so a human-REJECTED (junk) filing demotes the worker IMMEDIATELY (`good:false`) instead of being withheld until its 24h durability window elapses; junk-only short-circuit, confirmed/unknown still wait out the window (never widens); backtest inherits via the shared foldOutcome — merged
- 2026-07-02 `fix/runlog-vitest-testmode-guard` (#1071) — roadmap plan slice #1 (run-log hygiene): VITEST-aware `testMode` default in `runYamlRecipe` so a bare test run never appends synthetic rows to the operator's live `~/.patchwork/runs.jsonl` (also the de-facto trust store, rotates at 1MB). Guard test `runLogIsolation.test.ts` (temp HOME+USERPROFILE) + explicit `testMode:false` on the 4 persistence-asserting test files. Flat runner only. — merged
- 2026-07-02 `fix/dogfood-filing-var-defaults-and-decision-gate` (#1070) — unblock worker filing: (1) RecipeOrchestrator.fire merges trigger.vars/inputs defaults on every fire path (on_test_run runs no longer drop `repo`); (2) `when` guard evaluates the last token so an agent decision's prose ending in true/false gates correctly (yamlRunner + chainedRunner parity); extracts applyTriggerInputDefaults → src/recipes/triggerVars.ts — merged
- 2026-07-02 `feat/backtest-outcome-parity` (#1068) — thread OutcomeStore into backtestWorker via a shared foldOutcome helper so `patchwork workers backtest` labels outcomes exactly like `workers shadow` (junk→bad, unknown→withheld); refactors ingestRun onto the same helper — merged
- 2026-07-02 `fix/dependency-upkeep-ceiling-cap` (#1067) — cap dependency-upkeep-worker's autonomyCeiling 3→1 (neutralise the PR-path trust-by-neglect leak: vcs-remote had no outcome grader) pending a PR-outcome grader — merged
- 2026-07-02 `feat/outcomes-confirm-cli` (#1066) — `patchwork outcomes confirm|reject|list` verb (operator confirm-label loop) + outcome-ingester label-comment fix — merged
- 2026-07-02 `fix/test-guardian-ceiling-cap` (#1065) — cap test-guardian-worker's autonomyCeiling below the compensable auto-allow threshold pending real-world trust-signal validation — merged
- 2026-07-02 `fix/shadow-observer-unknown-not-durable` (#1064) — trust-by-neglect fix: unknown disposition withheld (not good:true) in WorkerShadowObserver.ingestRun — merged

- 2026-07-01 `feat/gate-decision-diff` (#1062) — Tier 2 legibility layer: `patchwork gate explain --diff` — merged
- 2026-07-01 `feat/gate-explain-cli` (#1061) — `patchwork gate explain <workerId> <classKey>` — read-only formatter over WorkerGateDecisionLog + `GET /gate/decisions` — merged
- 2026-07-01 `fix/outcome-ingester-search-issues` (#1053) — github.search_issues + state plumbing — merged
- 2026-07-01 `fix/bridge-mcp-init-stray-shim` (#1054) — pin --workspace on global MCP shim init — merged
- 2026-07-01 `fix/outcome-ingester-deterministic-classify` (#1055) — remove LLM judge from outcome classification — merged
- 2026-07-01 `fix/status-cli-workspace-aware-lock` (#1056) — patchwork status workspace-aware lock discovery — merged
- 2026-07-01 `fix/gmail-hard-halt-and-lock-discovery-tier1` (#1058) — gmail fetch/parse soft-fail + 4th tokenEfficiency lock-discovery instance — merged
- 2026-07-01 `fix/dashboard-trust-dial-not-owned` (#1059) — surface not-owned action classes in the dashboard trust dial — merged
- 2026-06-30/07-01 `dogfood/outcome-ingester-search-issues` — duplicate of #1053, discovered and deleted after confirming byte-identical content — the incident that prompted this doc
