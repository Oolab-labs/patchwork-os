/**
 * Install provenance — where an installed recipe came from.
 *
 * Two install paths, two locations, one record shape:
 *
 * - **Install directories** (`patchwork recipe install`): `.install.json`
 *   inside the install directory.
 * - **Top-level recipe files** (`POST /recipes/install`, which writes
 *   `<recipesDir>/<name>.json`): a sidecar at
 *   `<recipesDir>/.install/<file basename>.json`. Never inside the recipe
 *   file. The dot-dir is skipped by every recipe scan (it has no recipe
 *   extension, and its contents never match `recipe.json` or `*.yaml`).
 *
 * The recipe listing reads either back as `installedFrom`, so a reader can
 * tell "this exact source is installed" apart from "some other recipe happens
 * to share the name".
 *
 * Rules, each deliberate:
 *
 * - **Absence means unknown, never a guess.** An install made before this
 *   existed has no record, and the listing reports no `installedFrom` for it.
 *   Nothing is backfilled or inferred from a name.
 * - **Install dirs: written in the staging directory, after every recipe file
 *   is copied and before the final rename.** A half-finished install never
 *   carries one, and a reinstall replaces it with the rest of the directory.
 * - **Top-level files: bound to the installed bytes by sha256.** A top-level
 *   file can be deleted, archived, overwritten or edited by routes that know
 *   nothing about installs, and a later file can take the same name. The
 *   delete and archive routes clean the sidecar up, and the hash makes every
 *   other path safe too: a record whose hash no longer matches the file is
 *   ignored, so it can never attach to different content.
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

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../writeFileAtomic.js";

export const INSTALL_PROVENANCE_FILE = ".install.json";
export const INSTALL_PROVENANCE_RV = 1;
export const MAX_INSTALL_SOURCE_LENGTH = 512;
/** Dot-dir holding sidecars for top-level recipe files. */
export const INSTALL_SIDECAR_DIR = ".install";

export interface InstallProvenance {
  rv: 1;
  /** The install source string exactly as given. */
  source: string;
  /** The branch, tag or commit actually fetched, when known. */
  resolvedRef?: string;
  /** Epoch ms of the install. */
  installedAt: number;
}

/** Top-level sidecar: the same record, bound to the installed file's bytes. */
export interface TopLevelInstallProvenance extends InstallProvenance {
  /** Hex sha256 of the recipe file as installed. */
  sha256: string;
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

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

function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
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

/** Atomically write `record` into an install directory. Throws on I/O failure. */
export function writeInstallProvenance(
  dir: string,
  record: InstallProvenance,
): void {
  writeFileAtomicSync(
    path.join(dir, INSTALL_PROVENANCE_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** Parse + validate the common fields. Null on anything unexpected. */
function parseRecord(raw: string): Record<string, unknown> | null {
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
  return obj;
}

function toProvenance(obj: Record<string, unknown>): InstallProvenance {
  return {
    rv: INSTALL_PROVENANCE_RV,
    source: obj.source as string,
    ...(isRecordableString(obj.resolvedRef)
      ? { resolvedRef: obj.resolvedRef }
      : {}),
    installedAt: obj.installedAt as number,
  };
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
  const obj = parseRecord(raw);
  return obj ? toProvenance(obj) : null;
}

// ── Top-level recipe files ───────────────────────────────────────────────────

/** `<dir>/.install/<basename>.json` for the recipe file at `filePath`. */
export function topLevelProvenancePath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    INSTALL_SIDECAR_DIR,
    `${path.basename(filePath)}.json`,
  );
}

/**
 * Atomically write the sidecar for a top-level recipe file whose installed
 * content is `content`. Returns false (writing nothing) when the source is not
 * recordable. Throws on I/O failure.
 */
export function writeTopLevelProvenance(
  filePath: string,
  content: string,
  source: unknown,
  opts: { resolvedRef?: string; now?: number } = {},
): boolean {
  const base = buildInstallProvenance(source, opts);
  if (!base) return false;
  const record: TopLevelInstallProvenance = {
    ...base,
    sha256: sha256Of(content),
  };
  const target = topLevelProvenancePath(filePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomicSync(target, `${JSON.stringify(record, null, 2)}\n`);
  return true;
}

/**
 * Read the sidecar for a top-level recipe file whose CURRENT content is
 * `content`. Null when the sidecar is absent, malformed, or was written for
 * different bytes. Never throws.
 */
export function readTopLevelProvenance(
  filePath: string,
  content: string,
): InstallProvenance | null {
  let raw: string;
  try {
    raw = readFileSync(topLevelProvenancePath(filePath), "utf-8");
  } catch {
    return null;
  }
  const obj = parseRecord(raw);
  if (!obj) return null;
  if (typeof obj.sha256 !== "string" || !SHA256_RE.test(obj.sha256)) {
    return null;
  }
  if (obj.sha256 !== sha256Of(content)) return null;
  return toProvenance(obj);
}

/** Remove the sidecar for `filePath`, if any. Best-effort, never throws. */
export function removeTopLevelProvenance(filePath: string): void {
  try {
    rmSync(topLevelProvenancePath(filePath), { force: true });
  } catch {
    // best-effort — a leftover record cannot attach to other bytes (sha256)
  }
}

/**
 * Move the sidecar for `from` so it sits beside `to` (e.g. into `.archive/`).
 * Best-effort, never throws; a record that cannot be moved is removed so it
 * does not stay in the live recipes directory.
 */
export function moveTopLevelProvenance(from: string, to: string): void {
  const src = topLevelProvenancePath(from);
  if (!existsSync(src)) return;
  const dest = topLevelProvenancePath(to);
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(src, dest);
  } catch {
    removeTopLevelProvenance(from);
  }
}
