# Concepts

The mental model, one section per idea, in the order the ideas build on each other. Each section ends with where the authoritative detail lives. Nothing here is a substitute for those documents; it is the map you read before them.

## The bridge

The bridge is the single long-running process. It is an MCP server: Claude Code connects to it over a WebSocket, Claude Desktop through a stdio shim (`patchwork shim`), and remote clients over Streamable HTTP with a bearer token. It also hosts the recipe scheduler, the approval queue, the connectors and the HTTP API the dashboard talks to. One bridge serves one workspace; you can run several on one machine, and `patchwork doctor` and the kill switch address all of them.

A running bridge is discoverable through its lock file at `~/.claude/ide/<port>.lock`, which holds the port, the workspace path and the auth token. Everything in the CLI that needs a live bridge finds it that way.

Read more: [documents/architecture.md](../../documents/architecture.md) · [documents/data-reference.md](../../documents/data-reference.md) · [docs/protocol-spec.md](../protocol-spec.md).

## Tools: slim and full

A tool is one MCP-callable action: read a file, run the tests, open a pull request, post a message. Tools come in two modes. **Slim** registers only the editor-exclusive set (LSP navigation, diagnostics, debugger, editor state), which needs the extension. **Full**, the default, adds git, terminal, file operations, HTTP and GitHub. `patchwork tools list` prints the set without starting a bridge; `patchwork tools search <q>` filters it.

Plugins add tools without forking the bridge, and under the governed profile a recipe may only load plugins listed in `config.plugins.allow`.

Read more: [documents/platform-docs.md](../../documents/platform-docs.md) (tool reference and modes) · [documents/plugin-authoring.md](../../documents/plugin-authoring.md).

## Recipes

A recipe is a YAML file in `~/.patchwork/recipes/` with a `trigger` and `steps`. Triggers are `manual`, `cron`, `webhook`, `recipe` (called by another recipe), `file_watch`, `git_hook`, `on_file_save` and `on_test_run`. Steps call a tool (`file.write`, `github.create_issue`, `http.post` …) or run an `agent` step that hands a prompt to a model. Step outputs flow into later steps through `{{ }}` templates.

Two engines run them. **Flat** recipes (manual, cron, webhook) run their steps top to bottom. **Chained** recipes (`trigger.type: chained`) and the event-triggered kinds run through a second engine that needs an `id` on every step — a missing `id` means the recipe never registers, which `patchwork recipe lint` and `recipe doctor` both report.

A recipe declares its run inputs under `trigger.inputs` (or its alias `trigger.vars`): each has a `name`, and optionally `description`, `required`, `default` and `type`. An input with no type, or `type: string`, is a short token — letters, digits, underscores, spaces and `- . : + @ ,` only, at most 1024 characters — and so is any value supplied for a name the recipe does not declare. To hand a run real prose (pasted notes, a draft, a transcript) declare it `type: text`: any Unicode text including quotes, slashes and line breaks, at most `maxLength` characters (default 16384, never above 65536), with no NUL or other control characters besides newlines and tabs. In exchange a text input may only be rendered into a **content field** — an agent step's `prompt`, the `content` of `file.write`/`file.append`, or the body of a message (`http.post` `body`, Slack `text`/`blocks`, an email's `text`/`html`, …). Referencing it anywhere else — a path, URL, ref, channel, recipient or id — fails the step with `text_input_in_identifier`, and `recipe lint` (and so saving the recipe) reports it first. Under `governed` a text input is wrapped as untrusted content in a prompt, like connector output, labelled `input:<name>`. Its value is never written to a ledger: the run log, approval queue and activity log record `[text: N chars, sha256:…]` instead.

```yaml
trigger:
  type: manual
  inputs:
    - name: materials
      type: text
      maxLength: 20000
steps:
  - agent:
      prompt: "Turn these notes into a one-page pack:\n\n{{materials}}"
      into: pack
  - tool: file.write
    path: ~/.patchwork/inbox/pack.md   # a text input may NOT appear here
    content: "{{pack}}"
```

To run a workflow over a document — notes, a receipt PDF, a photo — upload it to the workspace and declare the input `type: file`. Uploads live in `~/.patchwork/uploads/` and are managed over the bridge's HTTP API (same bearer token as every other route): `POST /uploads` with the raw bytes as the body and the file name, percent-encoded, in an `X-Upload-Filename` header; `GET /uploads` lists `name`, `size`, `sha256`, `contentType` and `uploadedAt`; `GET /uploads/<name>` downloads (always as an attachment, never rendered); `DELETE /uploads/<name>` removes one. Accepted types are `.txt`, `.md`, `.csv`, `.json`, `.pdf`, `.png`, `.jpg`/`.jpeg` and `.webp`, checked by extension **and** content (a `.pdf` that is not a PDF is refused, as is anything HTML, SVG or executable); a file may be at most 10 MB and a workspace holds at most 200 MB. A stored name is plain — letters, digits, spaces and `. _ -`; a name carrying a path separator, `..`, a leading dot or a control character is refused, other characters become `_`, and a name already in use gets a `-1`, `-2`… suffix rather than overwriting. A run supplies the upload's **name** as the input's value; it must name an existing upload, and at render it becomes the file's absolute path. A file input may be rendered only into an agent `prompt` or the `content` of `file.write`/`file.append` — never a path, URL, id or message body — or the step fails with `file_input_in_identifier` (and lint reports it first). A Claude CLI agent step in a run handed a file input may **read** the uploads directory (it is added to the agent's directories, with every write tool denied for it); runs without a file input get nothing extra. Under `governed` the path is wrapped as untrusted content labelled `upload:<name>`, telling the model the file's content is data, not instructions. The bytes are never copied into a ledger, and the path is recorded there as `[upload: <name>, sha256:…]`.

```yaml
trigger:
  type: manual
  inputs:
    - name: receipt
      type: file
steps:
  - agent:
      prompt: "Read the receipt at {{receipt}} and list the line items."
      into: items
```

A step may carry an `expect` block: a completion contract checked against the step's output after it runs (a JSON Schema, a regex, a set of expected `outputs`). A failed contract halts the step by default; `required: true` makes a step skipped by its `when:` guard count as a failure too. `patchwork halts` shows these alongside ordinary errors.

Two deliberate behaviours surprise people. A tool id that nothing is registered under **skips** the step silently under `compat` (forward compatibility for a plugin that is not loaded) and **halts** the run under `governed`; `recipe doctor` names the unresolved tool either way. And `recipe test` is offline: an unmocked tool or an unstubbed agent step is refused, never run live.

Read more: [documents/triggers.md](../../documents/triggers.md) · [docs/recipe-template-gotchas.md](../recipe-template-gotchas.md) · `patchwork recipe schema` for the full schema.

## The approval gate and risk tiers

Every tool is classified into a risk tier — `low`, `medium` or `high` — from what it does: writes, network and execution are high. The gate setting `approvalGate` is `off`, `high` (queue high-tier calls) or `all` (queue everything that is not already allowed or denied by a rule). A queued call waits in the dashboard, or on your phone, with the exact arguments attached. Timeouts are per tier (5 minutes, 1 hour, 4 hours by default) and a timeout always resolves to *expired*, never to approved.

The gate aligns with Claude Code's own `allow` / `ask` / `deny` rules rather than replacing them: a `deny` rule wins, an `allow` rule wins, then the permission mode, then the gate. Under `governed` the gate floor is `high`, automated triggers are gated exactly like manual runs, and a non-reversible write queues whatever its tier.

Approvals are durable (the request is persisted, not the await), and when a named member approves from the dashboard the decision is attributed to them in `approval_log.jsonl`.

Read more: [ADR-0006](../adr/0006-approval-gate-design.md) · [ADR-0018](../adr/0018-durable-approvals.md) · [documents/delegation-policy.md](../../documents/delegation-policy.md) · the approval-gate section of [platform-docs](../../documents/platform-docs.md#patchwork-approval-gate).

## Workers and the autonomy gate

A worker is a named identity bound to a recipe by a manifest in `~/.patchwork/workers/*.worker.yaml`. Trust is earned **per worker × action class**, where an action class is `domain:reversibility:blastTier` (for example `issue:compensable:high`). Competence at filing issues says nothing about pushing code, and the maths never lets it.

Every action a worker attempts resolves to one of three terminal states. **Allow**: reversible actions always flow; compensable ones flow once the worker has earned enough trust; irreversible ones need the top level. **Gate**: queue it for a human. **Forbid**: a manifest rule bans the action class, and no earned trust and no approval unlocks it — it is evaluated before everything else. The effective level is the minimum of what the worker earned, the manifest's `autonomyCeiling`, and any context signal, so a ceiling can only lower autonomy.

Trust comes from confirmed outcomes, not from runs finishing. A filing that cannot be identified, or that nobody confirmed, is withheld rather than credited; `patchwork outcomes confirm` is the operator's positive act, and no recipe tool can perform it. The autonomy gate is on under `governed`; under `compat` it needs `PATCHWORK_FLAG_WORKER_AUTONOMY=1`. Either way runs need a model driver. `patchwork gate explain` renders why a specific decision went the way it did; `patchwork workers validate` finds a manifest that is present but governs nothing.

Read more: [docs/worker-autonomy-policy-gate.md](../worker-autonomy-policy-gate.md) · [ADR-0017](../adr/0017-decision-record-actor-and-forbid.md) · [runbook](../runbooks/worker-autonomy-dogfood.md).

## Governed and compat profiles

`config.json` has one key, `profile`, with two values. **`compat`** (the value when the key is absent) is byte-identical to how Patchwork behaved before profiles existed: every control is opt-in and most fail open. **`governed`** resolves every existing control to a conservative setting at once: approval gate floor `high`, automated triggers gated, worker authority and the policy matrix enforced, agents contained (read-only tools, no shell, network or file writes, the workspace's own Claude settings and all hooks ignored except its deny rules, allowlisted environment), covering both recipe agent steps and every task the bridge dispatches itself: automation hooks, `runClaudeTask`, and recipe generation and repair, recipe plugins allowlisted, kill switch failing closed when unreadable, unknown write tools queued, unregistered tools halting the run, connector output wrapped as untrusted content in prompts, and a recipe's own `requireApproval: false` ignored.

It adds no new mechanism — it is one setting feeding primitives that all still exist individually. `patchwork init` writes `governed` for a new install only; `patchwork profile governed` opts an existing one in and needs a bridge restart. `patchwork policy explain <recipe>` walks every gate in runtime order using the same decision functions the runner uses, so the explanation cannot describe a posture the runtime is not applying. `patchwork doctor` ends with `STATUS: GOVERNED` or `NOT GOVERNED` and the reasons.

Read more: [ADR-0026](../adr/0026-governed-profile.md) · the profile table in the [README](../../README.md#status-beta).

## The information boundary

The autonomy gate answers what a worker may *do*; the information boundary answers what a model destination may be *told*. Each `agent` step declares a `data_policy` classification — `public`, `internal`, `personal`, `confidential` or `restricted` (absent means `internal`). Each destination in `config.privacy.destinations` is `local` or `remote` and lists the classifications it accepts. Before dispatch, a pure function of (classification, destination policy) returns one of `ALLOW`, `ALLOW_REDACTED`, `LOCAL_ONLY`, `REQUIRE_APPROVAL` or `DENY`; no model is in the loop. `ALLOW_REDACTED` currently refuses, because redaction after the prompt is rendered would be detection rather than a boundary.

The boundary is inert until a destination is registered, and once registered it fails closed. Every decision is a receipt in `boundary_receipts.jsonl` that records the classification, destination and decision and **never the prompt**. `privacy.shadow` is a separate key: it observes what a candidate policy would have done to live traffic without enforcing it, so trying a policy cannot switch it on. `patchwork privacy destinations` shows where prompts may go and which destinations leave the machine; `privacy receipts` shows what the live policy decided; `privacy shadow` shows what the candidate would have.

Read more: [ADR-0021](../adr/0021-information-boundary.md) · [ADR-0024](../adr/0024-field-level-data-labels.md) (why field-level labels were declined, and the trigger to reopen) · [documents/data-sovereignty.md](../../documents/data-sovereignty.md).

## The evidence ledgers

Everything consequential is appended to JSONL files under `~/.patchwork`. They are plain, open-format and readable without us:

| Ledger | Records |
|---|---|
| `runs.jsonl` (and `runs.jsonl.1`) | Every recipe run: trigger, steps, status, halt reason. Byte-capped and rotated. |
| `run_steps.jsonl` | Per-step results, including captured output for replay. |
| `approval_log.jsonl` | Every approval request, every decision, and who made it. |
| `worker_gate_decisions.jsonl` | Every allow / gate / forbid decision the autonomy gate made, and why. |
| `boundary_receipts.jsonl` | Every information-boundary decision (metadata only, never the prompt). |
| `privacy_shadow.jsonl` | What a candidate privacy policy would have done. |
| `outcome-log.jsonl` | Whether a worker's filed action turned out real or junk. |
| `worker_trust/` | Per-recipe checkpoints of the derived trust dial. |
| `decision_traces.jsonl` | Decisions recorded by `ctxSaveTrace` for later sessions. |
| `pr_outcomes.jsonl` | Raw pull-request observations, collected so trust can be derived from evidence later. |

Two properties hold across them. First, rows should become joinable: a run's `taskId` is stamped as `correlationId` behind a per-ledger schema-version field (`rv`), and `patchwork evidence` reports how many rows in each ledger carry one. Absence is meaningful and is never backfilled — "nobody recorded this" stays distinguishable from "unknown". Second, the actively written ledgers are **tamper-evident**: each row carries a hash of the previous one, rotation and chain-start are explicit marker rows, and a sidecar records the file's expected length. `patchwork evidence verify` walks all of that and exits 1 on any break.

These files hold real task titles and third-party record ids. Quote measurements from them freely; never paste rows into a public issue or fixture.

Read more: [ADR-0025](../adr/0025-evidence-spine.md) · [ADR-0027](../adr/0027-tamper-evident-ledgers.md) · [ADR-0022](../adr/0022-durable-evidence-store.md).

## The kill switch

`patchwork kill-switch engage` (or its alias `patchwork panic`) blocks every write-tier tool call across **every running bridge** at once: recipe tools, bridge MCP writes, subprocess spawns and the orchestrator all read the same state at their dispatch chokepoint. Reads keep working and in-flight reasoning is not killed; it is a write block, not a shutdown. State lives in `~/.patchwork/config/flags.json` and converges across bridges within about 100 ms; the dashboard shows it live. `release` resumes writes; `status` prints the state per bridge.

Under `governed`, a kill-switch state that cannot be read counts as engaged. Under `compat` it fails open. Setting `PATCHWORK_FLAG_KILL_SWITCH_WRITES` in the environment freezes the state at startup so nothing at runtime can flip it.

Read more: [ADR-0013](../adr/0013-kill-switch.md).

## Identity

A workspace roster lives in `~/.patchwork/members.json`. A member holds a *set* of roles from `owner`, `admin`, `operator`, `approver`, `auditor` and `worker`, and is deactivated rather than deleted so that past decisions keep their subject. A missing or unreadable roster resolves to one implicit owner, which is exactly how the system behaved before rosters existed.

Dashboard sessions come in two forms. A **v1** session is minted by the shared `DASHBOARD_PASSWORD` and is *unattributed*: it can do everything a single operator could before, except approve a gated action, because that structurally needs a named subject. A **v2** session is minted by a member's own credential (`patchwork members set-password <id>`) and names them, so their approvals are recorded against them in `approval_log.jsonl`. Absence of a subject always means "nobody recorded this"; it is never defaulted to the owner.

Roles do not yet grant or refuse anything at runtime. They exist so that a decision record has a real person to name, and so that enforcement, when it lands, has a roster to consult. Federated identity (SSO) is deliberately out of scope for this repository.

Read more: [ADR-0020](../adr/0020-per-member-authentication.md) · [ADR-0019](../adr/0019-open-core-boundary.md) (what stays here and what does not).
