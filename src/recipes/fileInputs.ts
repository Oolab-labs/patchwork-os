/**
 * `type: file` recipe inputs — a run is handed the NAME of a workspace upload
 * (`src/uploadStore.ts`, `POST /uploads`) and works over the file.
 *
 * Modelled on `type: text` inputs (`textInputs.ts`) and reusing their machinery
 * wherever the rule is the same:
 *
 *   - **Validated by declared type.** The value is a strict upload name that
 *     names an existing regular file in the uploads directory — never a path.
 *     Checked at the run routes (`validateRecipeVars`) and again when the run
 *     starts (`resolveFileInputs`), which fails closed: a missing upload stops
 *     the run before any step.
 *   - **Rendered as the absolute path, in content positions only** — an agent
 *     prompt, or the `content` of `file.write` / `file.append`. Narrower than
 *     text: NOT a message body, because a local path means nothing to a
 *     recipient and tells them about this machine. Anywhere else both runners
 *     fail the step with `file_input_in_identifier` before rendering, and
 *     `recipe lint` reports it (so saving is refused).
 *   - **Data, not instructions.** In a prompt under governed, the path is
 *     wrapped in the untrusted envelope labelled `upload:<name>`, whose note
 *     says the file's content is data.
 *   - **Read-only access for the agent.** A run that resolved at least one file
 *     input hands its Claude CLI agent steps the uploads directory as an extra
 *     directory (`--add-dir`), plus deny rules on every write tool for it —
 *     so even a step that widened itself with a write tool cannot change an
 *     upload. Runs without a file input get nothing.
 *   - **Ledgers.** The bytes are never read into the run (only hashed). The
 *     path is held by the value-redaction layer for the life of the run, so a
 *     ledger records `[upload: <name>, sha256:…]` instead.
 */

import path from "node:path";
import { registerTextInputValue } from "../governance/secretValues.js";
import { resolveUploadPath, uploadNameError } from "../uploadStore.js";
import {
  findInputsOutsideContent,
  type TextInputPlacement,
} from "./textInputs.js";
import { declaredTriggerInputs } from "./triggerVars.js";

/** Error code for a file input referenced outside a content field. */
export const FILE_INPUT_IN_IDENTIFIER = "file_input_in_identifier";
/** Error code for a file input whose upload does not exist at run start. */
export const FILE_INPUT_NOT_FOUND = "file_input_not_found";

/** The declared file inputs of a recipe, by name. */
export function fileInputNamesOf(recipe: unknown): Set<string> {
  const out = new Set<string>();
  for (const input of declaredTriggerInputs(recipe)) {
    if (input.type === "file") out.add(input.name);
  }
  return out;
}

/** Why `value` is not acceptable for a file input, or null when it is. */
export function fileInputValueError(value: unknown): string | null {
  const r = resolveUploadPath(value);
  return r.ok ? null : r.error;
}

/** Lint form: is a declared default at least a well-formed upload name? */
export function fileInputDefaultError(value: unknown): string | null {
  return uploadNameError(value);
}

// ---------------------------------------------------------------------------
// Content positions
// ---------------------------------------------------------------------------

/**
 * Per tool, the params a file input's PATH may be rendered into. A file body
 * only — a step may record which upload it worked from. An agent's `prompt` is
 * content for every input type and is handled by the shared scanner.
 */
const FILE_CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "file.write": ["content"],
  "file.append": ["content"],
};

export function isFileContentField(
  tool: string | undefined,
  field: string,
): boolean {
  if (tool === undefined || !Object.hasOwn(FILE_CONTENT_FIELDS, tool)) {
    return false;
  }
  return FILE_CONTENT_FIELDS[tool]?.includes(field) === true;
}

export function findFileInputsInIdentifiers(
  step: unknown,
  names: ReadonlySet<string>,
): TextInputPlacement[] {
  return findInputsOutsideContent(step, names, isFileContentField);
}

export function fileInputInIdentifierMessage(
  p: TextInputPlacement,
  stepLabel: string,
): string {
  return (
    `${FILE_INPUT_IN_IDENTIFIER}: file input "${p.input}" is referenced in ` +
    `"${p.field}" of ${stepLabel}. A file input is the path of an upload and ` +
    "may only be rendered into an agent prompt or the content of " +
    "file.write/file.append — never into a path, URL, message, ref, channel, " +
    "recipient or id."
  );
}

// ---------------------------------------------------------------------------
// Run start
// ---------------------------------------------------------------------------

export interface ResolvedUpload {
  /** The input name. */
  input: string;
  /** The upload's stored name. */
  name: string;
  /** Absolute path the input renders as. */
  path: string;
  sha256: string;
}

/**
 * Replace each supplied file input's upload name with the upload's absolute
 * path. An input with no value is left alone (and grants nothing). Fails on the
 * first value that is not an existing upload.
 */
export function resolveFileInputs(
  recipe: unknown,
  values: Record<string, unknown> | undefined,
):
  | {
      ok: true;
      values: Record<string, unknown>;
      uploads: ResolvedUpload[];
    }
  | { ok: false; error: string } {
  const names = fileInputNamesOf(recipe);
  const out: Record<string, unknown> = { ...(values ?? {}) };
  const uploads: ResolvedUpload[] = [];
  if (names.size === 0 || !values) return { ok: true, values: out, uploads };
  for (const input of names) {
    if (!Object.hasOwn(values, input)) continue;
    const raw = values[input];
    if (raw === undefined || raw === null || raw === "") continue;
    const r = resolveUploadPath(raw);
    if (!r.ok) {
      return {
        ok: false,
        error: `${FILE_INPUT_NOT_FOUND}: file input "${input}" ${r.error}`,
      };
    }
    out[input] = r.path;
    uploads.push({ input, name: r.name, path: r.path, sha256: r.sha256 });
  }
  return { ok: true, values: out, uploads };
}

/** What a ledger records in place of an upload's path. */
export function uploadLedgerMarker(u: ResolvedUpload): string {
  return `[upload: ${u.name}, sha256:${u.sha256.slice(0, 12)}…]`;
}

/**
 * Hold each resolved path with the value-redaction layer for the run (same
 * transient, refcounted registry `type: text` values use); returns release.
 */
export function holdFileInputValues(
  uploads: readonly ResolvedUpload[],
): () => void {
  const releases = uploads.map((u) =>
    registerTextInputValue(u.path, uploadLedgerMarker(u)),
  );
  return () => {
    for (const r of releases) r();
  };
}

// ---------------------------------------------------------------------------
// Agent read access
// ---------------------------------------------------------------------------

/** The Claude Code built-ins that can change a file. */
const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

/**
 * The extra directories a CLI agent may read, and the deny rules that keep it
 * from writing to them. Claude Code writes an absolute path in a permission
 * rule as `//abs/path`; a deny always beats an allow, so this holds even for a
 * step that lifted a write tool with its own `tools:`.
 */
export function uploadReadGrant(dirs: readonly string[]): {
  dirs: string[];
  denyRules: string[];
} {
  const unique = [...new Set(dirs.filter((d) => d.length > 0))];
  const denyRules: string[] = [];
  for (const d of unique) {
    const posix = d.split(path.sep).join("/").replace(/\/+$/, "");
    const rooted = posix.startsWith("/") ? `/${posix}` : `//${posix}`;
    for (const t of WRITE_TOOLS) denyRules.push(`${t}(${rooted}/**)`);
  }
  return { dirs: unique, denyRules };
}

/** The read-only dirs a run's agent steps get: the uploads dir, or nothing. */
export function agentReadDirsFor(uploads: readonly ResolvedUpload[]): string[] {
  const first = uploads[0];
  return first ? [path.dirname(first.path)] : [];
}
