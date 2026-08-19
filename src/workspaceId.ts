/**
 * A short, stable identifier for the workspace an evidence record belongs to.
 *
 * ## Why evidence needs this and scoping does not
 *
 * Isolation, policy and blast radius are workspace-scoped already: one bridge,
 * one workspace, one policy. Evidence is different, and deliberately so — it
 * must OUTLIVE the workspace it describes. Deleting a workspace must not delete
 * the record of what was done in it; that is the property an auditor is paying
 * for. So evidence is not scoped by workspace, it is TAGGED with one.
 *
 * Concretely, today: no run row, gate decision, boundary receipt or trust
 * checkpoint carries a workspace, so a decision cannot be attributed to the
 * context it was made in. That is invisible while there is exactly one
 * workspace and is the first thing to break when there are two — at which point
 * two workspaces sharing a recipe name also share one trust ledger.
 *
 * ## Why a hash rather than the path
 *
 * Two reasons, both concrete.
 *
 * **Bytes.** `runs.jsonl` is capped at 1 MB and that cap is already what starves
 * the trust ledger (#1337) — a full path is 40-60 bytes on a ~758-byte row,
 * roughly 7%. Twelve hex characters is not.
 *
 * **Disclosure.** An evidence record is the artefact most likely to leave the
 * machine — exported, attached to a compliance question, pasted into a ticket.
 * A filesystem path names directories, and often a person: `/Users/<name>/...`.
 * The id identifies the workspace to anyone holding the mapping and discloses
 * nothing to anyone who is not.
 *
 * ## What it is not
 *
 * Not a secret, and not an authentication token — it is derived from a path
 * anyone with the machine already knows, so it resists disclosure, not
 * guessing.
 *
 * **Deliberately NOT a cryptographic hash, and please do not "fix" that.** The
 * fingerprint below is FNV-1a: fast, stable, and obviously an identifier rather
 * than a security primitive. An earlier revision used `createHash("sha256")`,
 * which bought nothing — the value is not a secret and brute-forcing it means
 * guessing a path, which a cryptographic digest does not prevent either — and
 * cost something real: CodeQL correctly identifies a filesystem string reaching
 * a password-hashing sink as `js/insufficient-password-hash`, because the sink
 * is the sink regardless of intent. Restructuring beats suppressing; a
 * suppression comment would rot and the next reader would not know why it was
 * there. Not stable across a workspace being MOVED: the path is the
 * identity, so relocating a workspace starts a new id. That is the honest
 * behaviour — a moved directory genuinely may not be the same operating
 * context — and the alternative (a stored id file) invents an identity that can
 * be copied, which is worse for an audit record.
 */
import path from "node:path";

/** Hex characters kept. 48 bits — ample against accidental collision between
 *  the handful of workspaces one installation ever sees, and short enough to
 *  add to a byte-capped log without argument. */
const ID_LENGTH = 12;

/**
 * Derive the id for a workspace path.
 *
 * Normalised first so that `/a/b`, `/a/b/` and `/a/./b` are one workspace
 * rather than three — otherwise a trailing slash in a config file silently
 * splits an audit trail in half.
 *
 * Returns `undefined` for absent or empty input. A caller must be able to tell
 * "no workspace was recorded" from "the workspace is «»", and the record
 * omitting the field is how that is expressed.
 */
export function workspaceIdFor(workspacePath: string | undefined): string {
  if (!workspacePath || !workspacePath.trim()) return "";
  const normalised = path.resolve(workspacePath.trim());
  // FNV-1a, 64-bit, over UTF-8 bytes. BigInt rather than `>>>` arithmetic
  // because 32 bits collides at a few tens of thousands of inputs by the
  // birthday bound, and an id that can silently merge two workspaces' evidence
  // is worse than no id at all.
  let hash = 0xcbf29ce484222325n;
  const bytes = Buffer.from(normalised, "utf8");
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0").slice(0, ID_LENGTH);
}

/**
 * The id for this process's workspace, or `undefined` when it has none.
 *
 * `undefined` is deliberately not a sentinel string. An evidence row that omits
 * the field says nothing; a row carrying `"unknown"` asserts that somebody
 * looked and could not tell. Those differ, and the second is a claim this
 * module has no grounds to make.
 */
export function currentWorkspaceId(
  workspacePath: string | undefined,
): string | undefined {
  const id = workspaceIdFor(workspacePath);
  return id === "" ? undefined : id;
}
