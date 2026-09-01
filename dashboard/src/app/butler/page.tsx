"use client";

/**
 * Butler — the large-print page.
 *
 * Direction Eight: accessibility-led. Black on white, nothing under 18px, no
 * meaning carried by colour alone, and large print as the BASE with the house
 * style layered over it as a density option (see `butler.css`).
 *
 * Chosen over the prettier directions for one reason: it is the only one that
 * serves poor eyesight, colour-blindness and a screen reader without an
 * accessibility mode bolted on afterwards. A personal assistant holding
 * somebody's household facts is exactly the product where the excluded users
 * are the ones who most need it.
 *
 * ## Rules this file keeps, which are easy to break by accident
 *
 * - **Single column, DOM order = reading order.** No side panel at any width.
 * - **No hover-only affordances.** Every control is in the document and
 *   visible. A control that appears on hover does not exist for a touch user,
 *   a keyboard user, or anyone who cannot hold a pointer still.
 * - **No information in colour alone** (1.4.1). Every state — where a fact
 *   came from, whether a permission is live — is stated in words.
 * - **Every button names its action.** "Yes, add it to my list", never "Yes".
 *   A screen-reader user tabbing through a list of "OK" buttons has no idea
 *   which one they are on.
 * - **Every destructive action is undoable, and the undo does not time out.**
 *   Not a WCAG rule. It is here because cognitive accessibility is the axis
 *   this product fails most easily, and a disappearing undo is how it would
 *   fail. The undo control stays until it is used or the page is reloaded.
 * - **State changes are announced** through one polite live region.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api";
import "./butler.css";
// The endpoint shapes live in `homeState.ts` and are imported, not restated.
// Two declarations of the same payload is how a page and its model come to
// disagree about what the server sends — silently, and in the direction
// nobody tests.
import {
  type ButlerFact,
  type ButlerHomeState,
  type ButlerSources,
  type PendingApproval as Pending,
  type PermissionExercise,
  type SourceState,
  type StandingPermission,
  mapButlerHome,
} from "./homeState";

// ─────────────────────────────────────────────────────────────── types

/** An undo the user can still take. Kept until used — never expires. */
interface UndoOffer {
  id: string;
  /** What was done, in the words shown back to the user. */
  did: string;
  /** Put it back. */
  undo: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────── plain words

/**
 * Where a claim came from, in words rather than a tier number.
 *
 * The trust model is `min(provenance, content)` on a 0..1 scale, which is the
 * right thing to compute and the wrong thing to show someone. "You told me
 * this" and "I guessed this from an email" are the distinction that matters,
 * and it has to survive being read aloud.
 */
function sourceInWords(f: ButlerFact): string {
  const channel = f.provenance.channel;
  if (channel === "user_confirmed") return "You confirmed this.";
  if (channel === "user_chat") return "You told me this.";
  if (channel === "recipe_agent")
    return "One of your recipes suggested this. I have not acted on it.";
  if (channel === "connector")
    return `I read this${f.provenance.source ? ` in your ${f.provenance.source}` : ""}. I have not acted on it.`;
  if (channel === "import") return "This came from a backup you restored.";
  return "I do not know where this came from.";
}

/** A fact as a sentence. `subject`/`predicate` are machine keys; a person
 *  should not have to parse `household.spouse` / `diet.avoid`. */
function factInWords(f: ButlerFact): string {
  const subject = f.subject === "user" ? "You" : humanise(f.subject);
  return `${subject} — ${humanise(f.predicate)}: ${f.object || "(nothing)"}`;
}

function humanise(key: string): string {
  return key.replace(/[._]/g, " ");
}

function whenInWords(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** A permission as a sentence, including its limits and whether it is live. */
function permissionInWords(p: StandingPermission): string {
  const what = p.scope.domains.join(", ");
  const limits: string[] = [];
  if (p.ceiling?.perDay) limits.push(`at most ${p.ceiling.perDay} a day`);
  if (p.ceiling?.magnitudeBand)
    limits.push(`nothing above ${p.ceiling.magnitudeBand.replace("band", "")}`);
  if (p.expiresAt) limits.push(`until ${whenInWords(p.expiresAt)}`);
  return `Go ahead with ${what} without asking${
    limits.length ? `, ${limits.join(", ")}` : ""
  }.`;
}

/**
 * GET a bridge route and fail loudly on a non-2xx.
 *
 * The dashboard proxy returns a JSON body on failure (502
 * `{"error":"Bridge unreachable"}`), so `.then(r => r.json())` resolves
 * happily and the caller cannot tell a dead bridge from an empty one.
 */
async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(path));
  if (!res.ok) {
    // The bridge answers 501 for a permission store it cannot read, with an
    // explicit comment that it must not read as "you have granted nothing".
    // Preserve that distinction instead of flattening it to an empty list.
    throw new Error(
      res.status === 501
        ? "I cannot check that on this bridge."
        : `Could not reach the bridge (${res.status}).`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Tool ids in the reader's words.
 *
 * Small and explicit, NOT derived. A rule that split `vendor.verb_object` and
 * reassembled it would read most ids acceptably and some as nonsense, and the
 * nonsense would appear on the page that reports what Butler did to somebody's
 * accounts. Every entry below was checked against a registered tool id; an
 * unknown id falls back to ITSELF rather than to a guess, because a raw
 * identifier is honest and an invented sentence is not.
 *
 * There are hundreds of tools and this covers the few a standing permission
 * realistically exercises. It is meant to stay short.
 */
const TOOL_IN_WORDS: Record<string, string> = {
  "todoist.create_task": "Added a task in Todoist",
  "asana.create_task": "Added a task in Asana",
  "asana.complete_task": "Completed a task in Asana",
  "asana.add_task_comment": "Commented on a task in Asana",
  "github.create_issue": "Opened an issue on GitHub",
  "discord.send_message": "Sent a message on Discord",
  "gmail.send": "Sent an email",
  "airtable.create_record": "Added a record in Airtable",
};

function toolInWords(id: string): string {
  return TOOL_IN_WORDS[id] ?? id;
}

/** The five surfaces Home reads. Named so a total blackout is countable. */
const SOURCE_COUNT = 5;

/**
 * Which part of Butler a failed source belongs to, in the reader's words.
 *
 * Named rather than left implicit: "I could not check" beside nothing tells a
 * reader that something is missing but not WHAT, so they cannot judge which of
 * the sentences above them to trust.
 */
const SOURCE_IN_WORDS: Record<string, string> = {
  facts: "What I know about you",
  quarantine: "Things I noticed",
  permissions: "What you have allowed",
  exercises: "What I have done",
  approvals: "Anything waiting for your decision",
};

// ─────────────────────────────────────────────────────────────── page

export default function ButlerPage() {
  const [facts, setFacts] = useState<ButlerFact[]>([]);
  const [quarantine, setQuarantine] = useState<ButlerFact[]>([]);
  const [permissions, setPermissions] = useState<StandingPermission[]>([]);
  const [exercises, setExercises] = useState<PermissionExercise[]>([]);
  const [asks, setAsks] = useState<Pending[]>([]);
  const [announcement, setAnnounce] = useState("");
  const [undos, setUndos] = useState<UndoOffer[]>([]);
  const [home, setHome] = useState<ButlerHomeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const announce = useCallback((msg: string) => setAnnounce(msg), []);

  const offerUndo = useCallback((did: string, undo: () => Promise<void>) => {
    setUndos((prev) => [
      // Newest first, and never dropped on a timer — see the header comment.
      { id: `${Date.now()}-${Math.random()}`, did, undo },
      ...prev,
    ]);
  }, []);

  const load = useCallback(async () => {
    try {
      // `r.json()` alone was not enough to keep the promise in the comment
      // below. The dashboard proxy answers a dead bridge with a 502 whose
      // BODY is valid JSON (`{"error":"Bridge unreachable"}`), so the parse
      // succeeded, the shape guards fell through to `[]`, and the page said
      // "Nothing yet." — confidently, about a bridge it never reached. Only a
      // network-level rejection ever reached the catch. Check the status.
      // Per source, NOT `Promise.all`. All-or-nothing discarded four healthy
      // sources whenever one failed, collapsing five independent
      // availabilities into a single boolean — safe, but it threw away
      // everything Butler could still honestly say. `mapButlerHome` keeps each
      // one's outcome separate; a failure can never arrive here as an empty
      // list.
      const [f, q, p, e, a] = await Promise.allSettled([
        getJson("/api/bridge/butler/facts"),
        getJson("/api/bridge/butler/quarantine"),
        getJson("/api/bridge/butler/permissions"),
        getJson("/api/bridge/butler/permissions/exercises"),
        getJson("/api/bridge/approvals"),
      ]);
      const listFrom = <T,>(
        r: PromiseSettledResult<Record<string, unknown>>,
        key: string,
      ): SourceState<T[]> => {
        if (r.status === "rejected") {
          const m =
            r.reason instanceof Error ? r.reason.message : String(r.reason);
          return {
            state: "unavailable",
            reason: /^[A-Z].*[.?]$/.test(m)
              ? m
              : "I could not reach the bridge for this.",
          };
        }
        const body = r.value;
        // A bare array is the /approvals shape; everything else wraps.
        const raw = key === "" ? body : (body as Record<string, unknown>)[key];
        if (!Array.isArray(raw)) {
          // A 200 whose shape drifted is NOT an empty result. Falling through
          // to `[]` here would defeat the whole invariant one layer before the
          // view-model gets to protect it — and it is the same failure the 502
          // taught this file, wearing a success code: the response parsed, so
          // nothing threw, and the page would say "nothing pending" about a
          // payload it did not understand.
          return {
            state: "unavailable",
            reason:
              "I asked, but I could not make sense of the answer, so I cannot say.",
          };
        }
        return { state: "read", value: raw as T[] };
      };

      const sources: ButlerSources = {
        facts: listFrom(f, "facts"),
        quarantine: listFrom(q, "facts"),
        permissions: listFrom(p, "permissions"),
        exercises: listFrom(e, "exercises"),
        approvals: listFrom(a, ""),
      };
      const state = mapButlerHome(sources);
      setHome(state);
      // A TOTAL blackout is a page-level alert; a partial one is a note beside
      // the sources it affects. Both were previously the same thing, because
      // one failure took the whole page down. Keeping the alert for the total
      // case preserves the guarantee that a dead bridge never renders as
      // "Butler knows nothing about you" — the reader is interrupted only when
      // there is genuinely nothing else on the page to read.
      setLoadError(
        state.unavailable.length === SOURCE_COUNT
          ? (state.unavailable[0]?.reason ??
              "I could not reach the bridge, so I cannot show you anything right now.")
          : null,
      );

      setFacts(sources.facts.state === "read" ? sources.facts.value : []);
      setQuarantine(
        sources.quarantine.state === "read" ? sources.quarantine.value : [],
      );
      setPermissions(
        sources.permissions.state === "read" ? sources.permissions.value : [],
      );
      setExercises(
        sources.exercises.state === "read" ? sources.exercises.value : [],
      );
      // GET /approvals returns a BARE ARRAY (src/approvalHttp.ts) — there is
      // no `pending` wrapper. Reading `.pending` off an array is undefined, so
      // this section rendered "Nothing right now." no matter how many
      // approvals were queued. The canonical /approvals page casts the body to
      // an array directly; this now agrees with the server and with it.
      setAsks(sources.approvals.state === "read" ? sources.approvals.value : []);
    } catch (err) {
      // Say so. A page that silently renders "Butler knows nothing about you"
      // when the truth is "I could not reach the bridge" is worse than an
      // error: the reader believes it.
      // A raw ECONNREFUSED is not a sentence anyone should read. Messages
      // this page raises itself (getJson) already are; anything else gets the
      // plain form.
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(
        /^[A-Z].*[.?]$/.test(msg)
          ? msg
          : "I could not reach the bridge, so I cannot show you anything right now.",
      );
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(apiPath(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await load();
      return res;
    },
    [load],
  );

  const del = useCallback(
    async (path: string) => {
      const res = await fetch(apiPath(path), { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
      await load();
      return res;
    },
    [load],
  );

  // ── the ask ───────────────────────────────────────────────────────────
  const ask = asks[0];

  const answerAsk = useCallback(
    async (p: Pending, decision: "approve" | "reject") => {
      try {
        // Two bugs here, and the second is why the first was invisible.
        //
        // The bridge routes `/approve/<id>` and `/reject/<id>` — there is no
        // `/approvals/` prefix on the decision route (the `/approvals/<id>`
        // pattern is a single-segment detail route). So every answer 404'd.
        //
        // And `post()` was not used, so the 404 resolved and Butler said
        // "Yes. I will go ahead." for an action that never happened. A
        // governance product telling someone it approved something it did not
        // is the worst failure on this page.
        await post(`/api/bridge/${decision}/${p.callId}`);
        announce(
          decision === "approve"
            ? "Yes. I will go ahead."
            : "No. I have left it alone.",
        );
      } catch {
        announce("I could not send your answer. Nothing has changed.");
      }
    },
    [announce, load],
  );

  // ── facts ─────────────────────────────────────────────────────────────
  const removeFact = useCallback(
    async (f: ButlerFact) => {
      try {
        // Was a bare fetch: a failed DELETE still announced "Removed" and
        // still offered an undo for a deletion that never happened.
        // DELETE returns the tombstone; its seq is what identifies the
        // retraction to undo.
        const res = await del(`/api/bridge/butler/facts/${f.seq}`);
        const body = (await res.json()) as { tombstone?: { seq?: number } };
        const tombSeq = body?.tombstone?.seq;
        announce(`Removed: ${factInWords(f)}`);
        // Put it back AS IT WAS. This used to re-POST a plain fact, and the
        // create route stamps channel "user_chat" unconditionally — so undoing
        // the removal of something Butler had merely READ somewhere returned it
        // as something you had said, above the threshold at which it starts
        // being used. The undo was a trust escalator. The restore route copies
        // the original row's provenance instead.
        if (tombSeq !== undefined) {
          offerUndo(`Removed "${factInWords(f)}"`, async () => {
            await post(`/api/bridge/butler/facts/${tombSeq}/restore`);
            announce(`Put back: ${factInWords(f)}`);
          });
        }
        await load();
      } catch {
        announce("I could not remove that. Nothing has changed.");
      }
    },
    [announce, load, offerUndo, post],
  );

  const confirmFact = useCallback(
    async (f: ButlerFact) => {
      try {
        await post(`/api/bridge/butler/facts/${f.seq}/confirm`);
        announce(`Confirmed: ${factInWords(f)}`);
      } catch {
        announce("I could not confirm that. Nothing has changed.");
      }
    },
    [announce, post],
  );

  const promoteFact = useCallback(
    async (f: ButlerFact) => {
      try {
        await post(`/api/bridge/butler/quarantine/${f.seq}/promote`);
        announce(`I will remember: ${factInWords(f)}`);
      } catch {
        announce("I could not save that. Nothing has changed.");
      }
    },
    [announce, post],
  );

  const revokePermission = useCallback(
    async (p: StandingPermission) => {
      try {
        await del(`/api/bridge/butler/permissions/${p.id}`);
        announce("Taken back. I will ask you about those again.");
        // Restore the SAME grant. This used to call the grant route with three
        // fields, which minted a new id and grantedAt and silently dropped
        // `expiresAt` and the magnitude band — turning a capped, expiring
        // permission into an uncapped permanent one, and orphaning every
        // "done without asking" record attached to the old id.
        offerUndo(`Took back "${permissionInWords(p)}"`, async () => {
          await post(`/api/bridge/butler/permissions/${p.id}/restore`);
          announce("Allowed again.");
        });
        await load();
      } catch {
        announce("I could not take that back. Nothing has changed.");
      }
    },
    [announce, load, offerUndo, post],
  );

  const did = useMemo(
    () => exercises.slice().sort((a, b) => b.at - a.at),
    [exercises],
  );

  // A section earns its heading when it has something to show, when it could
  // not be checked, or while the answer is still unknown. Otherwise the
  // headline has already said it.
  const unread = (k: "facts" | "quarantine" | "permissions" | "exercises") =>
    home !== null && home.unavailable.some((u) => u.source === k);
  const showAsk =
    !ready || ask !== undefined || home?.attention.state === "unavailable";
  const showDone = !ready || did.length > 0 || unread("exercises");
  const showNoticed = !ready || quarantine.length > 0 || unread("quarantine");
  const memoryCompact = ready && facts.length === 0 && !unread("facts");
  const permissionsCompact =
    ready && permissions.length === 0 && !unread("permissions");

  return (
    <main className="butler">
      {/* One polite live region for the whole page. Assertive would interrupt
          whatever the reader is in the middle of, which is the wrong trade for
          a confirmation. */}
      <div className="butlerAnnounce" role="status" aria-live="polite">
        {announcement}
      </div>

      <h1>Butler</h1>

      {/* Status first, because it is the one thing a reader came for. The
          three arms are not a ladder: "nothing is waiting for you" and "I could
          not find out whether anything is waiting for you" differ by exactly
          the thing the page is used to decide. */}
      {/* Deliberately NOT a live region. `role="status"` carries implicit
          polite semantics, so this headline would have become a SECOND
          announcer beside `butlerAnnounce` — approving something would be read
          out twice, once as the confirmation and once as the changed headline.
          The page keeps exactly one announcer, on purpose. */}
      <p className="butlerStatus">
        {!home
          ? "Looking…"
          : home.status.kind === "needs-you"
            ? home.status.count === 1
              ? "One thing is waiting for your decision."
              : `${home.status.count} things are waiting for your decision.`
            : home.status.kind === "caught-up"
              ? "Nothing is waiting for your decision."
              : "I could not find out whether anything is waiting for you."}
      </p>

      {/* The reason is shown, not just the reassurance. The bridge answers 501
          when it cannot read the permission store, with an explicit comment
          that this must not read as "you have granted nothing" — a fixed
          "could not reach the bridge" sentence throws that distinction away
          at the last step, after the server took care to make it. */}
      {loadError && (
        <p className="butlerRowText" role="alert">
          {loadError} This is not the same as knowing nothing about you.
        </p>
      )}

      {/* What could not be checked, carried WHOLE and named source by source.
          Placed before anything it might undermine: a reader who has already
          read three sections should not discover afterwards that a fourth was
          never consulted. Absent entirely when everything was read, so a
          healthy page carries no apology. */}
      {home && home.unavailable.length > 0 && !loadError && (
        <section className="butlerSection" aria-labelledby="butler-unchecked">
          <h2 id="butler-unchecked">What I could not check</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {home.unavailable.map((u) => (
              <li key={u.source} className="butlerRow">
                <p className="butlerRowText">
                  {SOURCE_IN_WORDS[u.source]}: {u.reason}
                </p>
                <p className="butlerMeta">
                  This is not the same as there being nothing.
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Sections a calm page does not render at all.

          The reset document's second complaint: with nothing pending, Butler
          was five different renderings of "nothing here", and an empty section
          cost a reader as much attention as an urgent one. A heading that only
          ever says "Nothing right now." is not reassurance, it is a thing to
          read before you can conclude there was nothing to read. The headline
          above already answers it.

          They come back the moment there is something to show — or something
          that could not be checked, which is not the same as calm. */}
      {/* 1 ── The ask ────────────────────────────────────────────────── */}
      {showAsk && (
        <section className="butlerSection" aria-labelledby="butler-ask">
          <h2 id="butler-ask">Something I need to ask you</h2>
          {ask ? (
            <div className="butlerRow">
              <p className="butlerRowText">{ask.summary ?? ask.toolName}</p>
              {/* "and not ask again about this one" was a promise nothing kept:
                  there is no suppression store, so rejecting removes the queue
                  entry and the next run asks again. Saying what actually
                  happens is worth more than a reassurance that turns out to be
                  false the first time the recipe runs on a schedule. */}
              <p className="butlerMeta">
                If you say yes, I will do this now. If you say no, I will leave it
                alone this time.
              </p>
              <div className="butlerActions">
                <button
                  type="button"
                  className="butlerButton butlerButtonPrimary butlerButtonFull"
                  onClick={() => void answerAsk(ask, "approve")}
                >
                  Yes, go ahead
                </button>
                <button
                  type="button"
                  className="butlerButton butlerButtonFull"
                  onClick={() => void answerAsk(ask, "reject")}
                >
                  No, leave it alone
                </button>
              </div>
            </div>
          ) : (
            <p className="butlerEmpty">
              {!ready
                ? "Looking…"
                : home?.attention.state === "unavailable"
                  ? "I could not check this, so I cannot say."
                  : "Nothing right now."}
            </p>
          )}
        </section>
      )}

      {/* 2 ── What Butler has done ────────────────────────────────────────── */}
      {showDone && (
        <section className="butlerSection" aria-labelledby="butler-did">
          <h2 id="butler-did">
            Things I did because you&rsquo;d already said I could
          </h2>
          <p className="butlerMeta">
            This only covers permissions you gave me in advance.
          </p>
          {/* The only evidence Butler has that it DID anything. A completed
              errand, a refusal, an approval acted on — none of those are
              recorded anywhere this page can read, so none of them are claimed
              here. See docs/butler-product-reset.md. */}
          {did.length === 0 ? (
            <p className="butlerEmpty">
              {!ready
                ? "Looking…"
                : home?.permissions.actionsWithoutAsking.state === "unavailable"
                  ? "I could not check this, so I cannot say what I have done."
                  : "No actions are recorded here yet."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {did.map((e) => (
                <li key={`${e.permissionId}-${e.at}`} className="butlerRow">
                  <p className="butlerRowText">
                    {toolInWords(e.toolName)}
                    {e.recipeName ? ` (${e.recipeName})` : ""}
                  </p>
                  {/* The receipt the standing permission owes the reader. */}
                  <p className="butlerMeta">
                    I did this without asking, because you allowed it.{" "}
                    {whenInWords(e.at)}.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Memory and Permissions are the two reference areas. Side by side when
          there is room, sequential in the DOM and stacked when there is not —
          the reading order never changes. */}
      <div className="butlerReference">
      {/* 3 ── What Butler knows ──────────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-knows">
        <h2 id="butler-knows">What I know about you</h2>
        {/* The count is the summary; the list is the detail. Stated in words
            because "6" alone does not say which population it counts, and the
            two populations differ by whether Butler may act on them. */}
        {home?.memory.established.state === "read" && !memoryCompact && (
          <p className="butlerMeta">
            {home.memory.established.value === 0
              ? "Nothing I act on yet."
              : `${home.memory.established.value} ${
                  home.memory.established.value === 1 ? "thing" : "things"
                } I use.`}
            {home.memory.awaitingConfirmation.state === "read" &&
            home.memory.awaitingConfirmation.value > 0
              ? ` ${home.memory.awaitingConfirmation.value} waiting for you to confirm.`
              : ""}
          </p>
        )}
        {facts.length === 0 ? (
          <p className="butlerEmpty">
            {!ready
              ? "Looking…"
              : home?.memory.established.state === "unavailable"
                ? "I could not check this, so I cannot say what I know."
                : memoryCompact
                  ? "Nothing yet. Tell me something and I will remember it."
                  : "Nothing yet."}
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {facts.map((f) => (
              <li key={f.seq} className="butlerRow">
                <p className="butlerRowText">{factInWords(f)}</p>
                {/* Source in WORDS, always visible — never a coloured dot and
                    never behind a tooltip. */}
                <p className="butlerMeta">
                  {sourceInWords(f)} Recorded {whenInWords(f.recordedAt)}.
                </p>
                <div className="butlerActions">
                  {!f.provenance.validated && (
                    <button
                      type="button"
                      className="butlerButton"
                      onClick={() => void confirmFact(f)}
                    >
                      Yes, that&rsquo;s right
                    </button>
                  )}
                  <button
                    type="button"
                    className="butlerButton"
                    onClick={() => void removeFact(f)}
                  >
                    Forget this about me
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4 ── Standing permissions ───────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-allowed">
        <h2 id="butler-allowed">What you have allowed</h2>
        {permissions.length === 0 ? (
          <p className="butlerEmpty">
            {!ready
              ? "Looking…"
              : home?.permissions.active.state === "unavailable"
                ? "I could not check what you have allowed, so I cannot say."
                : permissionsCompact
                  ? "Nothing yet — I ask you about everything."
                  : "Nothing. I ask you about everything."}
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {permissions.map((p) => (
              <li key={p.id} className="butlerRow">
                <p className="butlerRowText">{permissionInWords(p)}</p>
                {/* Live-or-not in words. A struck-through row or a grey tint
                    would carry this in styling alone. */}
                <p className="butlerMeta">
                  {p.active
                    ? `In force since ${whenInWords(p.grantedAt)}.`
                    : `You took this back on ${whenInWords(p.revokedAt ?? p.grantedAt)}. I am keeping the record.`}
                </p>
                {p.active && (
                  <div className="butlerActions">
                    <button
                      type="button"
                      className="butlerButton"
                      onClick={() => void revokePermission(p)}
                    >
                      Take this back
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* A promise about what Butler will NEVER do, not a description of the
            list above it — so it is separated rather than reading as the last
            line of an empty state. */}
        <p className="butlerPromise">
          I will never do something you cannot undo without asking you first,
          whatever you have allowed here.
        </p>
      </section>

      {/* 5 ── Seen, not acted on ─────────────────────────────────────── */}
      {showNoticed && (
        <section
          className="butlerSection butlerSpan"
          aria-labelledby="butler-seen"
        >
          <h2 id="butler-seen">Things I noticed but have not used</h2>
          <p className="butlerMeta">
            I only guessed at these. I will not act on any of them unless you tell
            me they are right.
          </p>
          {quarantine.length === 0 ? (
            <p className="butlerEmpty">
              {!ready
                ? "Looking…"
                : home?.memory.awaitingConfirmation.state === "unavailable"
                  ? "I could not check this, so I cannot say."
                  : "Nothing here."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {quarantine.map((f) => (
                <li key={f.seq} className="butlerRow">
                  <p className="butlerRowText">{factInWords(f)}</p>
                  <p className="butlerMeta">{sourceInWords(f)}</p>
                  <div className="butlerActions">
                    <button
                      type="button"
                      className="butlerButton butlerButtonPrimary"
                      onClick={() => void promoteFact(f)}
                    >
                      Yes, remember this about me
                    </button>
                    <button
                      type="button"
                      className="butlerButton"
                      onClick={() => void removeFact(f)}
                    >
                      No, forget you saw it
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      </div>

      {/* Undo ─────────────────────────────────────────────────────────
          Last in DOM order because it is a consequence of the sections above,
          and it stays until it is used. No countdown, no fade. */}
      {undos.length > 0 && (
        <section className="butlerSection" aria-labelledby="butler-undo">
          <h2 id="butler-undo">Changed your mind?</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {undos.map((u) => (
              <li key={u.id} className="butlerRow">
                <p className="butlerRowText">{u.did}</p>
                <div className="butlerActions">
                  <button
                    type="button"
                    className="butlerButton"
                    onClick={() => {
                      void u.undo().then(() =>
                        setUndos((prev) => prev.filter((x) => x.id !== u.id)),
                      );
                    }}
                  >
                    Undo that
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
