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

// ─────────────────────────────────────────────────────────────── types

interface ButlerFact {
  seq: number;
  subject: string;
  predicate: string;
  object: string;
  recordedAt: number;
  trust: number;
  provenance: {
    channel: string;
    source?: string;
    validated: boolean;
  };
}

interface StandingPermission {
  id: string;
  grantedAt: number;
  grantedBy: string | null;
  scope: { domains: string[] };
  ceiling?: { magnitudeBand?: string; perDay?: number };
  expiresAt?: number;
  revokedAt?: number;
  note?: string;
  active: boolean;
}

interface PermissionExercise {
  permissionId: string;
  at: number;
  toolName: string;
  classKey: string;
  workerId?: string;
  recipeName?: string;
}

interface Pending {
  callId: string;
  toolName: string;
  tier: "low" | "medium" | "high";
  requestedAt: number;
  summary?: string;
}

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

// ─────────────────────────────────────────────────────────────── page

export default function ButlerPage() {
  const [facts, setFacts] = useState<ButlerFact[]>([]);
  const [quarantine, setQuarantine] = useState<ButlerFact[]>([]);
  const [permissions, setPermissions] = useState<StandingPermission[]>([]);
  const [exercises, setExercises] = useState<PermissionExercise[]>([]);
  const [asks, setAsks] = useState<Pending[]>([]);
  const [announcement, setAnnounce] = useState("");
  const [undos, setUndos] = useState<UndoOffer[]>([]);
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
      const [f, q, p, e, a] = await Promise.all([
        getJson("/api/bridge/butler/facts"),
        getJson("/api/bridge/butler/quarantine"),
        getJson("/api/bridge/butler/permissions"),
        getJson("/api/bridge/butler/permissions/exercises"),
        getJson("/api/bridge/approvals"),
      ]);
      setFacts(Array.isArray(f?.facts) ? f.facts : []);
      setQuarantine(Array.isArray(q?.facts) ? q.facts : []);
      setPermissions(Array.isArray(p?.permissions) ? p.permissions : []);
      setExercises(Array.isArray(e?.exercises) ? e.exercises : []);
      // GET /approvals returns a BARE ARRAY (src/approvalHttp.ts) — there is
      // no `pending` wrapper. Reading `.pending` off an array is undefined, so
      // this section rendered "Nothing right now." no matter how many
      // approvals were queued. The canonical /approvals page casts the body to
      // an array directly; this now agrees with the server and with it.
      setAsks(Array.isArray(a) ? a : []);
      setLoadError(null);
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
        await del(`/api/bridge/butler/facts/${f.seq}`);
        announce(`Removed: ${factInWords(f)}`);
        // The undo puts the fact back as something YOU said, which is what it
        // was. It stays available until used.
        offerUndo(`Removed "${factInWords(f)}"`, async () => {
          await post("/api/bridge/butler/facts", {
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
          });
          announce(`Put back: ${factInWords(f)}`);
        });
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
        offerUndo(`Took back "${permissionInWords(p)}"`, async () => {
          await post("/api/bridge/butler/permissions", {
            domains: p.scope.domains,
            ...(p.note && { note: p.note }),
            ...(p.ceiling?.perDay && { perDay: p.ceiling.perDay }),
          });
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

  return (
    <main className="butler">
      {/* One polite live region for the whole page. Assertive would interrupt
          whatever the reader is in the middle of, which is the wrong trade for
          a confirmation. */}
      <div className="butlerAnnounce" role="status" aria-live="polite">
        {announcement}
      </div>

      <h1>Butler</h1>

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

      {/* 1 ── The ask ────────────────────────────────────────────────── */}
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
            {ready ? "Nothing right now." : "Looking…"}
          </p>
        )}
      </section>

      {/* 2 ── What Butler knows ──────────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-knows">
        <h2 id="butler-knows">What I know about you</h2>
        {facts.length === 0 ? (
          <p className="butlerEmpty">
            {ready ? "Nothing yet." : "Looking…"}
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

      {/* 3 ── Seen, not acted on ─────────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-seen">
        <h2 id="butler-seen">Things I noticed but have not used</h2>
        <p className="butlerMeta">
          I only guessed at these. I will not act on any of them unless you tell
          me they are right.
        </p>
        {quarantine.length === 0 ? (
          <p className="butlerEmpty">{ready ? "Nothing here." : "Looking…"}</p>
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

      {/* 4 ── What Butler did ────────────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-did">
        <h2 id="butler-did">What I did without asking</h2>
        {did.length === 0 ? (
          <p className="butlerEmpty">
            {ready ? "Nothing — I have asked you about everything." : "Looking…"}
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {did.map((e) => (
              <li key={`${e.permissionId}-${e.at}`} className="butlerRow">
                <p className="butlerRowText">
                  {e.toolName}
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

      {/* 5 ── Standing permissions ───────────────────────────────────── */}
      <section className="butlerSection" aria-labelledby="butler-allowed">
        <h2 id="butler-allowed">What you have allowed</h2>
        {permissions.length === 0 ? (
          <p className="butlerEmpty">
            {ready
              ? "Nothing. I ask you about everything."
              : "Looking…"}
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
        <p className="butlerMeta">
          I will never do something you cannot undo without asking you first,
          whatever you have allowed here.
        </p>
      </section>

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
