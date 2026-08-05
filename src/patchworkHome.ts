/**
 * The one place `~/.patchwork` is resolved.
 *
 * `PATCHWORK_HOME` is documented (CLAUDE.md, `docs/privacy-policy.md`) as
 * overriding the workspace root, but only 12 of 71 call sites honoured it —
 * the other 59 built the path from a bare `homedir()`. A user who set the
 * variable therefore got a SPLIT installation: connector tokens, approvals
 * and feature flags moved; config, recipes and inbox did not.
 *
 * Two consequences, one visible and one not:
 *   - Production: settings written to the override were silently ignored and
 *     defaults used instead.
 *   - Tests: `testEnvSetup` sets `PATCHWORK_HOME` to a temp dir expecting
 *     isolation, but config resolution read the DEVELOPER'S REAL
 *     `~/.patchwork/config.json`. Test behaviour therefore depended on
 *     whoever's machine it ran on — and an agent step with no pinned
 *     `driver` reached a live local model, because that real config said
 *     `model: "local"` and auto-detect obliged.
 *
 * No silent fallback to the legacy path. It is tempting — it would keep an
 * existing override user working untouched — but it would also re-import the
 * developer's real config into every test run, which is the half of the bug
 * that is hardest to see. Instead the override wins and
 * `warnIfLegacyConfigStranded` says so out loud, once, naming both paths.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Legacy (pre-override) root. Exported so callers can name it in messages. */
export function legacyPatchworkHome(): string {
  return join(homedir(), ".patchwork");
}

/**
 * The workspace root: `PATCHWORK_HOME` when set and non-empty, else
 * `~/.patchwork`. Read per call, never cached — tests and the CLI both
 * change the variable at runtime, and a cached value would make the first
 * caller's environment win for the process lifetime.
 */
export function patchworkHome(): string {
  const override = process.env.PATCHWORK_HOME;
  return override && override.trim() ? override : legacyPatchworkHome();
}

/** `patchworkHome()` joined with `segments`. */
export function patchworkPath(...segments: string[]): string {
  return join(patchworkHome(), ...segments);
}

let warned = false;

/**
 * Warn once when an override is active AND the file exists only in the legacy
 * location — i.e. the user is about to run on defaults while a real config
 * sits somewhere this process will no longer read.
 *
 * Naming both paths is the point: "your config was ignored" is only
 * actionable if it says which file and where it should go.
 */
export function warnIfLegacyConfigStranded(
  relativePath: string,
  log: (msg: string) => void = console.warn,
): void {
  if (warned) return;
  const override = process.env.PATCHWORK_HOME;
  if (!override || !override.trim()) return;
  const overridden = join(patchworkHome(), relativePath);
  const legacy = join(legacyPatchworkHome(), relativePath);
  if (existsSync(overridden) || !existsSync(legacy)) return;
  warned = true;
  log(
    `[patchwork] PATCHWORK_HOME is set to "${override}", so ${overridden} is used — ` +
      `but no file exists there and one does at ${legacy}. That file is NOT being read. ` +
      "Move it to the override directory, or unset PATCHWORK_HOME.",
  );
}

/** Test seam — resets the once-only warning. */
export function _resetLegacyWarning(): void {
  warned = false;
}
