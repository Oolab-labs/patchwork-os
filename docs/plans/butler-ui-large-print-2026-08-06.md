# Butler UI — the large-print build (2026-08-06)

Design: direction **Eight**, the accessibility-led page. Black on white, nothing under
18px, buttons over 60px, and **no meaning ever carried by colour alone**.

Chosen over the prettier directions for one reason: it is the only one that serves poor
eyesight, colour-blindness and a screen reader **without an accessibility mode bolted on
afterwards**. Retrofitting that later is materially more expensive than starting there,
and a personal assistant holding someone's household facts is exactly the product where
the excluded users are the ones who most need it.

The house style is not abandoned — it becomes the *comfortable* theme, layered on top of
an accessible base. See §6.

---

## 1. What exists, and what does not

| Piece | State |
|---|---|
| Fact store, resolver, trust tiers | **Built** — `src/butler/` (#1271) |
| `butlerRemember` / `butlerRecall` / `butlerForget` | **Built** — MCP only (#1271) |
| Ambient memory card | **Built** — `src/butler/memoryCard.ts` (#1272) |
| Approval queue, durable, risk-tiered TTL | **Built** — ADR-0018, #1245/#1246 |
| Decision record | **Built** — `worker_gate_decisions.jsonl` |
| Errands worker + recipe | **Built** — templates (#1273) |
| **HTTP surface for Butler** | **Built** — `src/butlerRoutes.ts` (Phase A) |
| **Dashboard page** | **NONE.** Zero references to Butler in `dashboard/src/`. |
| **Standing-permission record** | **Built** — `src/butler/standingPermission.ts` + `permissionStore.ts` (Phase B) |

So the build is: an HTTP surface, a page, and one new store.

---

## 2. Phase A — bridge HTTP surface (~3 days) — **BUILT**

New `src/butlerRoutes.ts`, Bearer-gated, mirroring `inboxRoutes.ts` in shape.

```
GET    /butler/facts?minTrust=            → { facts: [...], count }
POST   /butler/facts                      → record (channel: user_chat)
PATCH  /butler/facts/:seq                 → correct in place (writes a NEW row, never mutates)
POST   /butler/facts/:seq/confirm         → promote a guess to user-stated
DELETE /butler/facts/:seq                 → tombstone
GET    /butler/quarantine                 → facts below the originate floor
POST   /butler/quarantine/:seq/promote    → requires an explicit human act
```

Non-obvious requirements:

- **`PATCH` must not mutate.** The store is append-only by design; a correction is a new
  row that supersedes. The route name is a lie the implementation must not tell.
- **`DELETE` needs a real erasure story.** A tombstone stops the belief resolving but the
  original row stays on disk, which is the right audit behaviour and the wrong GDPR
  Art. 17 behaviour. Decide explicitly: tombstone + scheduled compaction, or hard
  rewrite. Do not leave it implied.
- **Quarantine promotion is never automatic.** It is the one path that raises trust, so it
  takes a human act and records `user_confirmed`.
- Dashboard proxy: **no new file needed.** The catch-all
  `dashboard/src/app/api/bridge/[...path]/route.ts` already forwards `req.nextUrl.search`
  verbatim and exports all five methods. The recipe-doctor trap was NOT the catch-all — it
  was the *more specific* dynamic `recipes/[...name]` proxy shadowing it and dropping the
  query. Nothing shadows `/butler/*`, so `minTrust` survives. Re-check this the moment
  anything adds a `butler/[...]` segment.

**Tests:** route-level for each verb, plus one asserting `PATCH` leaves the original row
intact and resolution returns the new value.

### The erasure decision (settled — do not re-litigate without a reason)

**Tombstone and erasure are separate operations, and erasure is never the default.**

`DELETE /butler/facts/:seq` writes a tombstone: the belief stops resolving, the words stay
on disk. `DELETE /butler/facts/:seq?erase=true` calls `ButlerFactStore.erase`, which is the
only method in that class that rewrites the log — it blanks subject / predicate / object in
place and sets `erased: true` + `erasedAt`.

Three things this settles:

- **Not scheduled compaction.** A deletion that happens later is a deletion the user cannot
  see happen, and "we'll get to it" is the weakest possible answer to an Art. 17 request.
  The rewrite is synchronous, atomic (temp file + rename), and under the same lock as an
  append so a sibling process's row cannot be swallowed between read and replace.
- **The row itself survives as a husk.** Erasure owes the subject the destruction of their
  personal data; it does not owe them the destruction of the audit fact that an erasure
  occurred. Deleting the line outright would make "a belief was here and was erased" and
  "nothing was ever recorded" indistinguishable — the same distinction the decision record
  protects by never backfilling `actor`.
- **Two verbs because they are two requests.** "Stop believing this" and "destroy this" are
  different asks, and a caller who meant the first must not silently get the second. That
  is why erasure needs an explicit flag rather than being what DELETE quietly does.

`resolveFacts` drops erased rows *before* computing the fact key — otherwise every erased
husk collides on the single key `"\0"` and the newest one resolves as an empty-string
belief for whatever it used to be about.

---

## 3. Phase B — the standing-permission record (~4 days) — **BUILT**

The only genuinely new domain object. Every mockup has a "stop asking about small things"
button and nothing behind it.

```ts
interface StandingPermission {
  id: string;
  grantedAt: number;
  grantedBy: string | null;      // never defaulted to the implicit owner (ADR-0020)
  scope: { domains: string[] };  // e.g. ["tasks"] — matches WorkerManifest.owns syntax
  ceiling?: { magnitudeBand?: string; perDay?: number };
  expiresAt?: number;            // absent = until revoked
  revokedAt?: number;            // never deleted; a revoked grant stays auditable
}
```

Rules that are not negotiable:

- **It only ever narrows.** A permission may lower the bar for a class it names and must
  never widen anything else.

  > **Correction, made while building it.** This plan said the permission "composes as
  > another `min()` alongside `autonomyCeiling` and `contextCeiling`". It cannot. Those
  > are ceilings that LOWER autonomy, and a standing permission by definition lets through
  > something that would otherwise have stopped — so wiring it there would either do
  > nothing or would raise earned trust. Raising earned trust is the one thing it must
  > never do: an action a human waved through in advance would become evidence the WORKER
  > is reliable, which is trust-by-neglect with extra steps (the leak `foldOutcome` was
  > fixed for).
  >
  > **What was built instead:** a permission is a PRE-RECORDED HUMAN APPROVAL and composes
  > one layer later, in `resolveGateOutcome` — the single mapping from a gate decision to
  > an action, shared by enforcement and preview. `decideWorkerAction` is byte-identical
  > whether or not a permission exists. Only a `queue` outcome is convertible; `flow` and
  > `refuse` pass through, which makes "no grant unlocks a forbidden action" structural
  > rather than a rule someone has to remember.
- **Revocation is immediate and total**, and the record is kept, not deleted.
- **Every use is reported.** The page must show "done without asking, because you allowed
  it" — a permission whose exercises are invisible is indistinguishable from a bug.
- **Never covers `irreversible`.** The UI copy already says "anything you can undo"; the
  record must enforce what the copy promises.

Store: `~/.patchwork/butler/permissions.jsonl`, same append-only pattern, via
`patchworkPath()`. Exercises go to a SEPARATE `permission_exercises.jsonl` — different
lifetime, wildly different volume, and interleaving them would make every "what am I
currently allowing?" read scan months of routine traffic.

HTTP surface (Phase A's pattern): `GET/POST /butler/permissions`,
`DELETE /butler/permissions/:id` (revokes, never deletes), and
`GET /butler/permissions/exercises` — so Phase C is purely presentational. `grantedBy` is
never taken from the request body: the bridge authenticates one shared token, so a
caller-supplied name is an unverified claim (ADR-0020) and it stays `null`.

**Tests:** a grant cannot widen a class it does not name; revocation takes effect on the
next decision; an irreversible action is refused even under the broadest grant; and — the
one that matters most — `previewActions` and `decideWorkerAction` bucket every candidate
identically under four different grant sets. Component tests passing separately is how an
inverted safety property shipped here before.

---

## 4. Phase C — the page (~5 days)

`dashboard/src/app/butler/page.tsx`. Single column, no side panel. Sections in DOM order:

1. **The ask** — one question, two full-width buttons, plain-language consequences.
2. **What Butler knows** — one fact per row, each with its source stated *in words* and
   its own Change / Confirm / Remove controls, always visible.
3. **Seen, not acted on** — quarantine, plainly labelled, promotion requires a tap.
4. **What Butler did** — including refusals, with Undo where an inverse exists.
5. **Standing permissions** — what's allowed, and a Take it back control.

No hover-only affordances anywhere. No tooltips carrying required information.

---

## 5. Acceptance criteria — these are the deliverable

Not aspirations; the page is not done until each is verified.

| # | Criterion | How verified |
|---|---|---|
| A1 | Body text ≥18px; primary content ≥21px | computed style assertion |
| A2 | Text contrast ≥7:1 (AAA), non-text ≥3:1 | automated contrast check in CI |
| A3 | No information conveyed by colour alone (WCAG 1.4.1) | every state has a text label; reviewed |
| A4 | Interactive targets ≥44×44 CSS px (2.5.5) | computed style assertion |
| A5 | Fully keyboard operable, visible focus ≥3:1 (2.4.11) | keyboard walkthrough test |
| A6 | Every button names its action ("Yes, add it to my list") | reviewed; no bare "Yes"/"OK" |
| A7 | State changes announced via a polite live region | screen-reader pass |
| A8 | Reflows at 320px with no horizontal scroll (1.4.10) | viewport test |
| A9 | Usable at 200% zoom (1.4.4) and with text-spacing overrides (1.4.12) | manual |
| A10 | Honours `prefers-reduced-motion` and `prefers-contrast` | media-query test |
| A11 | Every destructive action is undoable, and the undo does not time out | interaction test |

A11 is not a WCAG rule. It is here because cognitive accessibility is the axis this
product fails most easily, and a disappearing undo is how it would fail.

---

## 6. How this coexists with the house style

Large print is the **base**, not a mode. The comfortable theme is a layer over it:

- Accessible primitives (size, target, contrast, labelling) live in the component.
- `data-density="comfortable"` tightens spacing and re-points colour tokens; it may
  never remove a text label or shrink a target below A4.
- The existing dark/light tokens still apply. The high-contrast pair is a third stop, not
  a fork.

This ordering is the whole point: a mode that can be switched off is a mode that gets
skipped in the next feature.

---

## 7. Out of scope

Chat/conversation, inbound Telegram, semantic recall, learning from connector content,
promotion of connector facts by anything but a human act, multi-user, per-member auth.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| The page looks unlike the rest of the dashboard | Deliberate — but audit the seam where a user crosses into it |
| The permission record becomes a general policy engine | Keep it to: scope, ceiling, expiry, revocation. Anything more belongs in the gate |
| GDPR erasure vs append-only audit | Decide in Phase A, not at the end |
| AAA contrast is genuinely hard with the brand orange | The high-contrast stop uses `#a33c17`, not the brand `#c5532a`. Verify before committing |

---

## 9. Sequence and size

Roughly **12 working days**: Phase A (3) → Phase B (4) → Phase C (5).

Phase A is independently useful — it makes the fact store reachable by anything other
than an MCP client. Phase B is independently useful — the gate can honour standing
permissions with no UI at all. Phase C without A and B is a mockup.
