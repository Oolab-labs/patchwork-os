# Mr. Butler — walking skeleton (2026-08-05)

Source: SecuStar "Patchwork" deck (`~/Downloads/PatchWork.pptx`, 16 slides). Butler is the
preconfigured personal assistant that ships with the platform; partners build the
professional workers. Feasibility assessed 2026-08-05 — verdict **build, as a reference
worker bundle, not a new subsystem**.

**Shape of this plan: one thin vertical slice through all five gaps, not one gap finished.**
The question worth answering first is not "can we build these" (assessment: yes, mostly
assembly) but "does Butler make the governance story legible to a buyer". No amount of
memory-layer completeness answers that.

Build cadence: one branch + PR per phase off `main`, `docs/in-flight.md` entry before
starting each, test-first per the Bug Fix Protocol, all gates re-run before the PR
(`npm run typecheck`, `tsc -p tsconfig.tests.core.json`, `vitest`, `audit-lsp-tools`,
`audit-test-fixtures`, `audit-schema-changes`, `biome check`). **Merge on green.**

---

## 0. Prerequisites — landed

| | |
|---|---|
| ✅ #1267 | Action-class keys carry a magnitude band for value-bearing domains; `payments` domain added; `GATE_POLICY_VERSION` → `worker-ramp-v2`. Merged 2026-08-05. |
| ⏳ #1268 | Compensation identifiers (notion/telegram) + 3 unreachable inverses registered (`resend.cancel_email`, `todoist.reopen_task`, `todoist.delete_task`). Open, CI running. |

Both were defects found *during* the assessment, not gap closures. No Butler gap is closed.

---

## The slice, in one sentence

> **Butler remembers one thing about you, proposes one real action, and you approve it on
> your phone.**

Message Butler on Telegram → it knows a handful of standing facts → it proposes an action
with a real external effect → the action gates → you approve → the Decision Record shows
what happened, on what evidence, and whether it can be undone.

---

## Minimum per gap

| Gap | Minimum that proves the point | Deferred |
|---|---|---|
| **Persona/memory** | ~10 hand-seeded facts, append-only JSONL, deterministic resolver | embeddings, extraction, chat-driven writes, persona voice |
| **Chat surface** | Telegram only (BotFather token, zero vendor review) | copilot-pane LLM fallthrough, multi-turn, `patchwork butler` CLI |
| **Onboarding** | Telegram + Todoist, both paste-a-key | all OAuth, the dashboard wizard, BYO credentials, broker |
| **Undo** | one action whose inverse exists (shipped in #1268) | the `compensate` hook, per-connector coverage, reverse-order replay |
| **Governance** | existing gate + approval queue + Decision Record, unchanged | mandates, cooling-off, novelty step-up, per-member auth |

### Explicitly out of scope

Persona voice · semantic recall · **memory extraction from connector content** · OAuth of any
kind · Gmail · Calendar · payments · dashboard wizard · delegation · multi-turn conversation
· physical actions.

> **The poisoning gap is sidestepped, not solved.** Facts are hand-seeded in this slice, so
> nothing Butler *reads* can become something Butler *believes*. That is deliberate: memory
> poisoning is OWASP ASI06, temporally decoupled (planted now, fires weeks later, invisible
> in testing), and it is the gap I would least want rushed under demo pressure. The trust-tier
> design (user 1.0 / agent 0.6 / connector 0.3) exists and is documented — it is simply not
> built here, because this slice gives it nothing to do.

---

## Phases

### Phase 1 — Fact store (~3 days)

New `src/butler/`, honouring `PATCHWORK_HOME` **via `patchworkPath()`** (see #1265 — do not
add another hardcoded `homedir()` join).

- `factStore.ts` — append-only JSONL at `<patchworkHome>/butler/facts.jsonl`. Bitemporal
  (`recordedAt` / `validFrom` / `validUntil`), provenance-stamped, `ownerId` on every row.
  Never row-rotated (the `decisionTraceLog.ts` silent-drop behaviour is correct for an ops
  log and catastrophic for "I'm allergic to shellfish").
- `resolve.ts` — **pure function, never a model call.** Group by `(subject, predicate)`,
  `max(seq)` wins among equal-highest trust, tombstones remove. Unit-tested against the
  FactConsolidation shape (contradictory serials) — this is the single design decision the
  benchmarks are loudest about.
- MCP tools `butlerRemember` / `butlerRecall` / `butlerForget`, `outputSchema` mandatory.

**Deliverable:** facts survive a bridge restart and resolve deterministically.
**Not included:** retrieval into any prompt. Phase 1 is storage only.

Two rules that carry forward:
- `ownerId` is **never** defaulted to the implicit owner — an unauthenticated principal
  writes `null`. Same rule as decision records; ADR-0020 is unbuilt and faking an actor is
  worse than an absent one.
- Provenance tiers are hard-coded, not recipe-configurable, even though nothing writes at
  tier 0.6 or 0.3 yet. The seam should exist before anything needs it.

### Phase 2 — Telegram loop (~3 days)

- Inbound: Butler receives a Telegram message. `telegram.get_updates` exists; needs a
  poll/webhook loop and a recipe trigger.
- Outbound: `telegram.send_message` — already registered, and post-#1268 it returns the
  numeric `chat_id` a later delete needs.
- Memory card injected at `src/bridge.ts:993`, alongside `recentTracesDigest` — same 2 KB
  cap, same 80-char truncation. **Reuse that discipline verbatim; do not invent a second one.**

**Deliverable:** message Butler, get a reply that demonstrably uses a stored fact.

### Phase 3 — One gated action, end to end (~2 days)

Pick **one** task, tedious enough to be worth automating, with a real external effect and a
registered inverse. Candidate: create a Todoist task from a Telegram request
(`todoist.create_task`, inverse `todoist.delete_task`, both live post-#1268).

- Runs under a worker manifest with an `autonomyCeiling` that forces the gate.
- Approval arrives on the phone path (approvalToken → push relay → PWA).
- The Decision Record shows worker, action class, reversibility, and the evidence.

**Deliverable:** the governance moment, visible, on a phone.

### Phase 4 — Live on it for a week

**Not optional. This is the deliverable.** Everything above is scaffolding for this.

---

## What this answers

1. Does the governance moment read as **valuable or as friction**? If a single approval feels
   like friction at this scale, the enterprise pitch has a problem worth learning now rather
   than after the partner programme is sold.
2. Do hand-seeded facts feel like a butler or a chatbot? That calibrates how much of the real
   memory layer is actually needed.
3. Does the approval loop survive contact with a phone?

---

## Risks

| Risk | Mitigation |
|---|---|
| A slice this thin underwhelms | Choose the Phase-3 task carefully — genuinely tedious, not a toy |
| Scope creep mid-build | The out-list above is the discipline; revisit it at each PR |
| A week of self-use is not buyer evidence | It is a smoke test for the concept, not validation. Do not present it as validation. |
| Telegram is per-user credential custody | Accepted for the slice — it is the only chat surface with zero vendor review |

---

## The alternative, fairly stated

If the product thesis is already believed and the goal is a *shippable* Butler, invert the
order: #1266 (frozen redirect URI + callback chain) → BYO credentials → full wizard → memory
properly. Slower to first demo, less rework later. Reasonable if this is committed rather
than exploratory.

**Read of the deck:** it is pre-commitment — partner tiers and commission splits sketched,
product not built. That is exactly when a walking skeleton earns its cost.

---

## Deck claims that must change regardless of build order

Independent of this plan, three statements in the deck are not true of the system today:

1. **"How can its actions be undone"** — rollback covers `file.write`/`file.append` only, and
   the four flagship examples (send email, book slot, place order, post message) are not
   implemented as writes at all. Defensible replacement: *recorded before it happens,
   classified by whether it can be reversed, gated on that classification; irreversible
   actions are named as irreversible before they run.* State the residue honestly — the
   recipient already saw it, the guest already got the cancellation mail — it is a
   differentiator, not a weakness.
2. **"Preconfigured on delivery"** — true for exactly zero OAuth connectors. No UI writes
   client credentials; `connectorRegistry.ts:241` says connectors sit inert until the user
   registers a vendor OAuth app.
3. **Maker-checker as the governance story** — vacuous for a workspace of one. Sell the
   bounded envelope: *authorize in advance, then see, delay and reverse.*

---

## Open, not scoped here

- **Delegation attribution** — nested recipes credit the parent worker for a specialist's
  work (`recipeOrchestration.ts:1451` binds the gate once per top-level run). The
  *enforcement* half would **widen** autonomy and must not be done casually; the
  *attribution* half is safe and is the part genuinely broken.
- **#1265** — `PATCHWORK_HOME` honoured by 7 sites, ignored by 82. Mechanical, best in
  reviewable batches, and worth an audit gate so the drift cannot return.
- **#1266** — frozen `REDIRECT_URI` + hardcoded callback chain. Prerequisite for any wizard.
