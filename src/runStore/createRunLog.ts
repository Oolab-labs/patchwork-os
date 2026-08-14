/**
 * The one place a run log is constructed — ADR-0022 wiring.
 *
 * Every `new RecipeRunLog(...)` call site moves here so the migration mirror
 * is a single decision rather than eight independent ones. Eight sites each
 * deciding whether to mirror is how a writer gets missed, and a missed writer
 * leaves the mirror permanently short of rows — producing divergence reports
 * that are true, meaningless, and quickly ignored.
 *
 * ## Default OFF
 *
 * With `PATCHWORK_FLAG_RUNSTORE_MIRROR` unset this returns a plain
 * `RecipeRunLog` with no mirror attached, so behaviour is byte-identical to
 * before this file existed. That is the whole point of shipping the wiring
 * separately from the decision to use it.
 *
 * ## Failure posture
 *
 * If the mirror cannot even be opened — no SQLite, unwritable directory,
 * corrupt database — this logs and returns the unmirrored run log. The
 * authoritative store must not become unavailable because an OBSERVER could
 * not start. Same rule that governs the mirror once it is running.
 */

import path from "node:path";
import type { Logger } from "../logger.js";
import { RecipeRunLog, type RunLogOptions } from "../runLog.js";
import { SqliteRunRepository } from "./sqliteRunRepository.js";

/** Env flag enabling the ADR-0022 shadow mirror. Off unless explicitly on. */
export const RUNSTORE_MIRROR_FLAG = "PATCHWORK_FLAG_RUNSTORE_MIRROR";

/** Truthy values accepted for the flag. Anything else — including "false",
 *  "0" and typos — leaves the mirror off, because the safe reading of an
 *  ambiguous flag on a trust ledger is "do the thing we already trust". */
export function mirrorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[RUNSTORE_MIRROR_FLAG];
  return v === "1" || v === "true" || v === "yes";
}

export interface CreateRunLogOptions extends RunLogOptions {
  /** Test seam — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a run log, attaching the shadow mirror when the flag is on.
 *
 * The mirror lives in a `runstore-mirror/` subdirectory rather than beside
 * `runs.jsonl`, so nothing that globs the patchwork directory for ledgers
 * picks up a binary file it cannot parse.
 */
export function createRecipeRunLog(opts: CreateRunLogOptions): RecipeRunLog {
  const { env = process.env, ...runLogOpts } = opts;
  if (!mirrorEnabled(env)) return new RecipeRunLog(runLogOpts);

  const logger: Logger | undefined = opts.logger;
  let mirror: SqliteRunRepository;
  try {
    mirror = new SqliteRunRepository({
      dir: path.join(opts.dir, "runstore-mirror"),
      logger,
    });
  } catch (err) {
    logger?.warn?.(
      `[runstore] shadow mirror disabled — could not open: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return new RecipeRunLog(runLogOpts);
  }

  return new RecipeRunLog({
    ...runLogOpts,
    mirror: (run) => mirror.mirrorRow(run),
    onMirrorFailure: (message) =>
      logger?.warn?.(`[runstore] shadow mirror write failed: ${message}`),
    // The factory opened this handle, so the factory supplies the way to
    // release it. `RecipeRunLog.close()` is the caller's single lever.
    onClose: () => mirror.close(),
  });
}
