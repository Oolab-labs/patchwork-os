/**
 * Where per-member password hashes live — ADR-0020 Phase A.
 *
 * `~/.patchwork/credentials.json`, mode 0600, keyed by member id. A separate
 * file from `members.json`, and that separation is the decision worth
 * recording, because two other homes were considered and are worse.
 *
 * ## Not on the `Member` object
 *
 * `Member` is what `actorSnapshot` copies from into decision records. A hash
 * hanging off it is one careless spread away from an audit log. That is why
 * `LocalPasswordProvider` takes `credentialFor` injected rather than reading a
 * field — this module supplies that function and nothing else.
 *
 * ## Not in `members.json`
 *
 * The roster is a describable, reviewable document: the sort of file somebody
 * eventually pastes into an issue or commits to share a configuration. The
 * moment it carries hashes, that is a credential leak by ordinary helpfulness.
 * Separate files let the roster stay boring.
 *
 * A member deactivated rather than deleted (the roster's rule) leaves an
 * orphaned credential here. That is correct and deliberate: the history stays,
 * the login does not.
 *
 * ## NOT in the connector token store
 *
 * `PATCHWORK_TOKEN_DIR` already has 0600 handling and a keychain backend, and
 * it is the wrong home twice over. Conceptually it holds credentials the
 * bridge uses to call OUT; these are credentials people use to call IN.
 * Practically, that path reaches `deleteSecretJsonSync` → an unconditional
 * `unlink`, which is why `audit-connector-test-isolation` exists at all: in
 * #1345 a disconnect test deleted a real credential off a developer's machine.
 * Putting member logins behind that same unlink means a stray `clearTokens()`
 * in a test can delete them.
 *
 * ## Fail CLOSED — the opposite of the roster
 *
 * A missing roster yields one implicit owner, so a single-user machine keeps
 * working: "who may act on your own machine" defaults to the status quo. A
 * missing credential file yields NOTHING, so nobody authenticates: "who are
 * you" defaults to nobody. Those defaults are deliberately opposite, and the
 * asymmetry is the same one ADR-0016 draws — a decision about whether an
 * action happens defaults to no.
 *
 * Concretely: no file, unreadable file, malformed JSON, or an entry that is
 * not a well-formed scrypt record all produce "no credential for this member",
 * and `LocalPasswordProvider` then returns UNATTRIBUTED. None of them throw,
 * because a thrown lookup is something a caller might catch and treat as a
 * pass.
 */

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { patchworkHome } from "../patchworkHome.js";
import { isCredentialRecord } from "./credentials.js";

export const CREDENTIALS_BASENAME = "credentials.json";

/** `~/.patchwork/credentials.json`, honouring `PATCHWORK_HOME`. */
export function defaultCredentialsPath(): string {
  const home = process.env.PATCHWORK_HOME?.trim();
  return join(
    home && home !== "" ? home : patchworkHome(),
    CREDENTIALS_BASENAME,
  );
}

export interface CredentialStore {
  /** The function `LocalPasswordProvider` wants. */
  credentialFor(memberId: string): string | undefined;
  /** Ids with a usable credential — for `patchwork members` to report. */
  ids(): string[];
  /** Entries that were present but unusable, so nobody is told "no such user"
   *  when the truth is "your record is corrupt". */
  malformed: string[];
  /** True when the file exists but is readable by group or others. */
  overlyPermissive: boolean;
}

const EMPTY: CredentialStore = {
  credentialFor: () => undefined,
  ids: () => [],
  malformed: [],
  overlyPermissive: false,
};

/**
 * Load the credential file.
 *
 * Read ONCE at startup, like the roster, and deliberately not re-read per
 * request: a file re-read on every authentication is a file whose permissions
 * and contents can change under a running process, and the resulting behaviour
 * is untestable. Rotation takes a restart, same as the roster.
 */
export function loadCredentials(
  path = defaultCredentialsPath(),
): CredentialStore {
  if (!existsSync(path)) return EMPTY;

  let overlyPermissive = false;
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      overlyPermissive = true;
      // Tighten rather than merely complain. A world-readable password file is
      // a live problem, and an operator who is told about it at startup has
      // already been running that way for however long.
      try {
        chmodSync(path, 0o600);
      } catch {
        /* reported via overlyPermissive; nothing else to do */
      }
    }
  } catch {
    /* stat failed — fall through; the read below decides */
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Unreadable or malformed ⇒ no credentials ⇒ nobody authenticates.
    return { ...EMPTY, overlyPermissive };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...EMPTY, overlyPermissive };
  }

  const usable = new Map<string, string>();
  const malformed: string[] = [];
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isCredentialRecord(value)) usable.set(id, value);
    else malformed.push(id);
  }

  return {
    credentialFor: (memberId) => usable.get(memberId),
    ids: () => [...usable.keys()],
    malformed,
    overlyPermissive,
  };
}
