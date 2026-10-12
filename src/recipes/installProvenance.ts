/**
 * Install provenance — where an install-dir recipe came from.
 *
 * `patchwork recipe install <source>` writes `.install.json` into the install
 * directory, recording the source string exactly as the operator gave it. The
 * recipe listing reads it back as `installedFrom`, so a reader can tell "this
 * exact source is installed" apart from "some other recipe happens to share
 * the name".
 *
 * Rules, each deliberate:
 *
 * - **Absence means unknown, never a guess.** An install made before this file
 *   existed has none, and the listing reports no `installedFrom` for it. It is
 *   not backfilled and not inferred from the directory name.
 * - **Written in the staging directory, after every recipe file is copied and
 *   before the final rename.** A half-finished install therefore never carries
 *   one, and a reinstall replaces it along with the rest of the directory.
 * - **Malformed ⇒ ignored.** A reader returns null rather than throwing; one
 *   bad file must not hide the recipe from the listing.
 * - **No credentials.** The source is user-supplied and treated as public. A
 *   value that is not a short, single-line string, or that carries URL
 *   userinfo (`scheme://user:secret@host`), is not recorded at all.
 *
 * Lives under `src/recipes/` rather than in `commands/recipeInstall.ts`
 * because `recipesHttp.ts` reads it and `recipeInstall.ts` already imports
 * `recipesHttp.ts`; putting it in either would create an import cycle.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../writeFileAtomic.js";

export const INSTALL_PROVENANCE_FILE = ".install.json";
export const INSTALL_PROVENANCE_RV = 1;
export const MAX_INSTALL_SOURCE_LENGTH = 512;

export interface InstallProvenance {
  rv: 1;
  /** The install source string exactly as given. */
  source: string;
  /** The branch, tag or commit actually fetched, when known. */
  resolvedRef?: string;
  /** Epoch ms of the install. */
  installedAt: number;
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/** True when `value` is safe to persist as a provenance string. */
function isRecordableString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_INSTALL_SOURCE_LENGTH &&
    !CONTROL_CHARS_RE.test(value) &&
    !URL_USERINFO_RE.test(value)
  );
}

/**
 * Build a provenance record, or null when the source is not recordable (in
 * which case no file is written — never a placeholder).
 */
export function buildInstallProvenance(
  source: unknown,
  opts: { resolvedRef?: string; now?: number } = {},
): InstallProvenance | null {
  if (!isRecordableString(source)) return null;
  return {
    rv: INSTALL_PROVENANCE_RV,
    source,
    ...(isRecordableString(opts.resolvedRef)
      ? { resolvedRef: opts.resolvedRef }
      : {}),
    installedAt: opts.now ?? Date.now(),
  };
}

/** Atomically write `record` into `dir`. Throws on I/O failure. */
export function writeInstallProvenance(
  dir: string,
  record: InstallProvenance,
): void {
  writeFileAtomicSync(
    path.join(dir, INSTALL_PROVENANCE_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * Read the provenance record from an install directory. Returns null when the
 * file is absent, unreadable, unparseable, from another schema version, or
 * carries a source that would not have been recorded. Never throws.
 */
export function readInstallProvenance(dir: string): InstallProvenance | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, INSTALL_PROVENANCE_FILE), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.rv !== INSTALL_PROVENANCE_RV) return null;
  if (!isRecordableString(obj.source)) return null;
  if (typeof obj.installedAt !== "number" || !Number.isFinite(obj.installedAt))
    return null;
  return {
    rv: INSTALL_PROVENANCE_RV,
    source: obj.source,
    ...(isRecordableString(obj.resolvedRef)
      ? { resolvedRef: obj.resolvedRef }
      : {}),
    installedAt: obj.installedAt,
  };
}
