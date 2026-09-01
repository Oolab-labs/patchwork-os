# Butler product reset — current state and new information architecture

> **Status:** design freeze. No code changes accompany this document, and that
> is deliberate: an evidence observation window is open on this machine, and
> Butler's worker and outcome machinery is one of the things producing the
> observations. Nothing here touches it.

## The one-line diagnosis

> **A functioning governed personal-assistant substrate with a management page
> attached to it — not yet a convincing personal-assistant product.**

Butler is further along underneath than the screen makes it look. The next
phase is product integration and UI architecture, not more memory algorithms or
worker machinery.

## Current state, verified rather than remembered

Every row below was checked against the tree on 2026-09-01. This section exists
so the redesign is scoped against what Butler *does*, not what a plan once said
it would.

### Built and real

| Capability | Where |
|---|---|
| Append-only fact store with provenance and trust tiers | `src/butler/factStore.ts` |
| Deterministic belief resolution | `src/butler/resolve.ts` |
| Quarantine for low-trust observations | `src/butler/*`, `GET /butler/quarantine` |
| Read / add / correct / confirm facts | `GET`·`POST /butler/facts`, `PATCH /butler/facts/:seq`, `POST /butler/facts/:seq/confirm` |
| Forget (tombstone) and restore | `DELETE /butler/facts/:seq`, `POST /butler/facts/:seq/restore` |
| Permanent erasure | `DELETE /butler/facts/:seq?erase=true` |
| Standing permissions, with exercise history | `src/butler/standingPermission.ts`, `permissionStore.ts`, `GET`·`POST`·`DELETE /butler/permissions`, `GET /butler/permissions/exercises` |
| Ambient memory card for AI sessions | `src/butler/memoryCard.ts` |
| Errand outcome observation and deterministic grading | `errandOutcomeGrader.ts`, `todoistObservation.ts`, `outcomeIngester.ts` |
| Promotion into trust evidence | `promoteShadowOutcomes.ts` — **gated off by default** (`PATCHWORK_FLAG_BUTLER_PROMOTE`) |

### Not built

Conversational Butler as a product surface. Multi-turn chat. Automatic learning
from email or calendar (**deliberately** not built). First-run onboarding.
Mature multi-user Butler isolation as a Butler concern.

### Two details the redesign must not blur

**Forget is reversible; erasure is not.** `forget` writes a tombstone and leaves
the original content intact, which is exactly what makes `restore` able to put
the belief back *as it was*. Erasure (`?erase=true`) irreversibly destroys the
stored personal content — `subject`, `predicate` and `object` are blanked —
while retaining a content-free husk carrying `erased` and `erasedAt`, so the
record that an erasure occurred survives the content it destroyed.

The distinction is a UI requirement, not a footnote:

```text
Forget this            Erase permanently
→ reversible           → personal content destroyed
→ Undo available       → no Undo
                       → the confirmation must say so BEFORE it happens
```

A Memory screen with one destructive button would offer an undo it cannot always
honour.

**Connector-derived information is capped below the threshold at which Butler
may originate a belief.** That ceiling is structural, not UI copy. Any summary
counting "things Butler knows" must not silently merge the two populations.

## The problem the current screen has

The accessibility constraints were the right call and their guarantees are real
and tested: large print, one column, large targets, no hover-only controls,
strong contrast, nothing carried by colour alone.

The **visual interpretation** of those constraints is what needs to change.

1. **No centre of gravity.** Five sections carry equal visual weight, so an empty
   one consumes almost as much space as an urgent one.
2. **Absence dominates.** With nothing pending, the page is several different
   renderings of "nothing here". "Nothing needs you" should feel peaceful, not
   like five reports to inspect.
3. **The data model is on screen.** `factInWords()` renders
   `subject — predicate: object` (`page.tsx:118`). Technically humanised; still a
   database row.
4. **Trust controls, no sense of Butler.** You can audit what it remembers and
   what authority it holds, but not ask what it can do for you.
5. **It is the front door.** Simple mode redirects `/` to `/butler`
   (`butlerLanding.test.ts:40`), so this is a non-technical user's first screen,
   not a settings page. That raises the standard it must meet.

Accessibility does not require equal visual weight. Strong hierarchy *helps*
cognitive accessibility, and colour may reinforce safe / attention / stopped
provided the words remain.

## The new information architecture

> **Butler tells me what needs me, what it handled, what it knows, and what
> freedom I have given it.**

Memory and permissions stay important, but become trust controls *behind* the
assistant rather than the whole experience. Four views, each with one job:

- **Home (Today)** — status, what needs you, what happened recently.
- **Memory** — what Butler knows, with provenance, age, confirm, correct, forget
  and erase.
- **Permissions** — what Butler may do without asking, what used each permission,
  and immediate revocation.
- **Activity** — the readable history of what Butler proposed, did, refused,
  asked about, and did under standing permission.

Hierarchy inherited from the existing internal diagnosis of the same failure
elsewhere: **status → needs you → what happened → how it works → details.** A
vertical card stack becomes a report rather than an answer.

### No fake composer

An "Ask Butler anything…" box is **out of scope** until there is a real
interaction contract behind it — request → proposed task → worker → gate →
approval where required → result and receipt. This codebase has spent
considerable effort removing surfaces that imply capability they do not have;
adding one here would be a regression of principle, not a shortcut.

## Retiring the section-order test — what is actually being replaced

`dashboard/src/app/butler/__tests__/butler-page.test.tsx:362-366` asserts these
five headings in this order:

> Something I need to ask you → What I know about you → Things I noticed but have
> not used → What I did without asking → What you have allowed

**This is not an accessibility test that someone wants deleted.** Its own comment
says *"DOM order IS reading order"* — the intent is that a screen-reader user
meets an urgent decision before passive information. The five literal headings
are how that intent was frozen, not the intent itself.

So the intent survives and the wording goes. Replace with outcome-oriented
assertions:

- urgent decisions appear before passive information **in DOM order**;
- an all-clear state does not render five empty sections;
- provenance remains visible when reviewing a memory;
- a destructive change is reversible, **except erasure, which says so first**;
- unavailable never renders as empty.

### Invariants that must not be lost

Keyboard operation · visible focus · large targets · readable type · no
hover-only controls · screen-reader announcements · state communicated in words
as well as visually · unavailable ≠ empty · undo semantics.

## Sequence

1. **`docs/butler-product-reset`** — this document.
2. **`feat/butler-view-model`** — a UI-facing Butler model (`attentionItems`,
   `recentActivity`, `memorySummary`, `permissionSummary`, `availability`).
   `page.tsx` currently fetches five endpoints itself and interprets them in the
   component. The model must **preserve provenance and uncertainty**, never infer
   policy — the same rule that governs the control plane's runtime reader.
3. **`feat/butler-home`** — the new front page from real data only. Move, do not
   delete, memory and permission controls. The section-order test is replaced
   here.
4. **`feat/butler-memory` + persistent undo** — natural-language facts, source
   and age, confirm/correct/forget/erase, and undo that survives a reload. The
   store already has provenance-preserving restore, so this is safe to build.
5. **`feat/butler-onboarding`** — what Butler can do, what it remembers and why,
   what "ask me first" versus "allowed without asking" means; then one connector
   and one real governed errand.
6. **`Ask Butler`** — only once the interaction contract above exists.

Stop before semantic memory, automatic connector learning, or persona theatrics.

### Ordering constraint against the open observation window

The distinction that matters here is between **changing runtime code** and
**causing live runtime activity**. Only the first is a code-review question; the
second is what the window is measuring.

- **Steps 1–4** are docs and `dashboard/` work and do not alter runtime
  behaviour.
- **Step 5** may also be implemented without changing the runtime, but it ends in
  "one connector and one real governed errand" — so its live acceptance must
  either run in an isolated test environment or wait. Accepting it against the
  live install would manufacture exactly the governed-run and approval evidence
  this project has said not to manufacture.
- **Step 6** changes the runtime interaction contract and waits entirely.

The window closes on its own events: a governed worker run, a restart, and a
natural `runs.jsonl` rotation.

## The bar

A new user opens Butler and, within about five seconds, can answer:

> Is everything okay? Does Butler need me? What did it do? What does it know?
> What have I allowed?

Butler already contains most of those answers. The redesign's job is to make the
important one appear first.
