/**
 * A stable reference to a single action a worker performed, used as the join
 * key between a run's step and the operator's outcome disposition for it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The outcome join was originally keyed on `step.output.url` — a GitHub issue
 * URL. That works for exactly one tool shape and silently no-ops for every
 * other, because the fold's withhold branch is guarded on the URL being
 * present (`shadowObserver.ts`). A write tool that returns no URL therefore
 * skipped the human-confirmation check entirely and folded as earned trust.
 * `todoist.create_task` is the concrete case: it returns 26 fields, none of
 * them a URL, and the Todoist API exposes no permalink field at all.
 *
 * The rejected alternative was to synthesise a URL inside the connector. That
 * hardcodes a web-app URL scheme we do not control, breaks silently when it
 * changes, and fixes one connector. Instead we key on what every write tool
 * already has and cannot lose: its own name, plus the id of the thing it just
 * created.
 *
 * TWO KEY SHAPES, ON PURPOSE, WITH NO MIGRATION
 * ---------------------------------------------
 * Existing `outcome-log.jsonl` rows are keyed by `issueUrl` and every one of
 * them is a real GitHub URL. Those rows are NOT rewritten. A URL is already a
 * perfectly good stable identifier for the thing it names, the lookup is a map
 * get either way, and rewriting the sole evidence file the autonomy gate rests
 * on — in place, with no rollback — to gain nothing but uniformity is a bad
 * trade. The asymmetry decides it: a missed lookup costs a WITHHOLD (the safe
 * default), a botched migration costs the ledger.
 *
 * The two shapes cannot collide, and that is asserted rather than assumed:
 * `canonicalActionRef` REFUSES to build a key that looks like a URL, so a
 * `tool:id` key can never shadow or be shadowed by a legacy `issueUrl` key.
 */

/** A tool-scoped reference to one performed action. */
export interface ActionRef {
  /** The tool that performed the action, e.g. `"todoist.create_task"`. */
  tool: string;
  /** The external id the tool returned for the thing it created. */
  id: string;
}

/**
 * Thrown when a caller tries to build a key that would be ambiguous against
 * the legacy URL-shaped keys. Loud on purpose — see the header note. A deny
 * of this kind fails the write rather than coercing it, because a coerced key
 * would silently land in the ledger under a name nothing looks up.
 */
export class AmbiguousActionRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousActionRefError";
  }
}

/** Keys of this shape belong to the legacy URL-keyed rows. */
const URL_LIKE = /^https?:\/\//i;

/**
 * The canonical string key for an `ActionRef`: `"<tool>:<id>"`.
 *
 * Throws `AmbiguousActionRefError` when either half is empty/blank, or when
 * the resulting key would be URL-shaped (which would put it in the same
 * namespace as the legacy `issueUrl` keys). Both are programmer errors at a
 * write site, not user input to be tolerated.
 */
export function canonicalActionRef(ref: ActionRef): string {
  const tool = ref.tool?.trim();
  const id = ref.id?.trim();
  if (!tool || !id) {
    throw new AmbiguousActionRefError(
      `An action ref needs both a tool and an id (got tool=${JSON.stringify(ref.tool)}, id=${JSON.stringify(ref.id)}).`,
    );
  }
  const key = `${tool}:${id}`;
  if (URL_LIKE.test(key)) {
    throw new AmbiguousActionRefError(
      `Action ref "${key}" is URL-shaped, which collides with the legacy issueUrl key namespace. A tool name must not begin with http(s).`,
    );
  }
  return key;
}

/**
 * The id fields write tools actually return, in preference order.
 *
 * Ordered most-specific first so a payload carrying several does not depend on
 * object key order. `url` is LAST and deliberately included: for a tool that
 * does return a URL (github.create_issue), the URL remains the key, which is
 * what keeps the 95 existing `issueUrl` rows joining without a migration.
 */
const ID_FIELDS = [
  "url",
  "html_url",
  "id",
  "issueNumber",
  "number",
  "key",
  "gid",
  "ts",
] as const;

/**
 * Derive the outcome-join key for a completed step, or null when the step's
 * output carries nothing usable as an identifier.
 *
 * Returning null is meaningful and must stay distinguishable from returning a
 * key that finds no disposition: null means "this action cannot be referred
 * to", whereas a key with no disposition means "nobody has ruled on it yet".
 * The two justify different fold outcomes.
 *
 * NOTE: a `url`/`html_url` field yields the URL itself as the key — NOT a
 * `tool:url` composite — precisely so legacy rows keep joining.
 */
export function deriveActionKey(
  tool: string | undefined,
  output: unknown,
): string | null {
  if (!tool) return null;
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const rec = output as Record<string, unknown>;
  const direct = scanForId(tool, rec);
  if (direct) return direct;
  // ONE level down, through a JSON `body` string.
  //
  // An HTTP tool returns the transport envelope — `{status, ok, body}` — with
  // the created resource's id inside `body` as an unparsed JSON string. That is
  // the single real shape in the run log that carries a perfectly good
  // identifier the top-level scan cannot see (12 steps, all `http.post`).
  //
  // Deliberately narrow. This parses a payload we already received and reads
  // the SAME id fields as above — it does not invent a value, guess a remote
  // URL scheme, or reach into a service-specific shape. That distinction is
  // why synthesising a Todoist permalink was rejected but this is not: one
  // fabricates an identifier from a convention we do not control, the other
  // reads one the service actually sent us.
  //
  // `body` only, and one level only. Speculatively adding `data`/`result`/
  // `payload` would be guesswork with no evidence behind it, and each extra
  // guess is another way to key an action to something that is not its
  // identity — which silently attaches a human's confirmation to the wrong
  // action. If another envelope shape shows up in a real run log, add it then,
  // with that log as the justification.
  const body = rec.body;
  if (typeof body !== "string" || !body.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // not JSON — genuinely unidentifiable
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return scanForId(tool, parsed as Record<string, unknown>);
}

/** The id scan itself, shared by the top level and the one-level `body` dip. */
function scanForId(tool: string, rec: Record<string, unknown>): string | null {
  for (const field of ID_FIELDS) {
    if (!Object.hasOwn(rec, field)) continue;
    const raw = rec[field];
    // Numeric ids are as legitimate as string ones (GitHub issue numbers,
    // Slack/Asana numeric ids). Booleans and objects are not identifiers.
    const value =
      typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(raw)
          : "";
    if (!value) continue;
    // A URL field IS the key (legacy compatibility, see the note above).
    if (URL_LIKE.test(value)) return value;
    try {
      return canonicalActionRef({ tool, id: value });
    } catch {
      // A tool name that would make a URL-shaped key: skip this field rather
      // than throwing on a read path. Read paths must never crash the fold.
      return null;
    }
  }
  return null;
}
