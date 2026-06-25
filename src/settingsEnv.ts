import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "./writeFileAtomic.js";

/**
 * Persist `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true` into Claude Code's
 * `~/.claude/settings.json` `env` block during `patchwork init`.
 *
 * Why this exists
 * ---------------
 * Running `claude --ide` makes Claude Code try to auto-connect to an IDE.
 * Part of that flow is a "valid check" that detects whether the current
 * terminal is running *inside* a recognized IDE's integrated terminal
 * (parent-process / terminal detection). The Patchwork bridge is a
 * standalone process that writes its own `~/.claude/ide/<port>.lock`, so a
 * `claude --ide` launched from a plain terminal trips that check even though
 * the bridge connection is perfectly valid. `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true`
 * skips it.
 *
 * The lock-file SHAPE is not the problem — there's no field a third-party
 * bridge can set to satisfy the check, because it's an in-IDE-terminal
 * detection, not a lock-file-content check. So the cleanest way to make the
 * raw README env-var workaround unnecessary is to persist the variable where
 * Patchwork already manages Claude Code config: the `env` block of
 * `~/.claude/settings.json`. Claude Code applies that block to every session,
 * so a subsequent plain `claude --ide` sees the variable set.
 *
 * This deliberately does NOT touch the user's shell dotfiles (~/.zshrc etc.).
 * Idempotent: re-running `patchwork init` does not duplicate or churn the
 * entry, and it never overwrites a value the user set themselves.
 */

export const SKIP_IDE_VALID_CHECK_KEY = "CLAUDE_CODE_IDE_SKIP_VALID_CHECK";

export interface SetEnvResult {
  action: "added" | "already-present" | "preserved-user-value" | "error";
  path: string;
  /** The value currently in settings.json after the operation (for "preserved-user-value"). */
  existingValue?: string;
  error?: string;
}

/**
 * Ensure `CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true` is present in the `env` block
 * of the given Claude Code settings.json.
 *
 * - Missing file or missing `env` block → create them and add the key ("added").
 * - Key already === "true" → no write ("already-present").
 * - Key present with a DIFFERENT value → leave it untouched and report
 *   ("preserved-user-value"). We never clobber an explicit user choice.
 * - Read/parse/write failure → ("error") with the message; the caller treats
 *   this as a non-fatal warning, matching every other init settings.json step.
 */
export function registerSkipIdeValidCheckEnv(
  ccSettingsPath: string,
): SetEnvResult {
  try {
    let ccSettings: Record<string, unknown> = {};
    if (existsSync(ccSettingsPath)) {
      ccSettings = JSON.parse(readFileSync(ccSettingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }

    // `env` must be a plain object. If the user (or a corrupt write) left a
    // non-object there, don't blow it away — bail out as an error so init
    // surfaces a warning instead of silently dropping their config.
    const rawEnv = ccSettings.env;
    if (
      rawEnv !== undefined &&
      (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv))
    ) {
      return {
        action: "error",
        path: ccSettingsPath,
        error: `settings.json "env" is not an object`,
      };
    }

    const env = (rawEnv ?? {}) as Record<string, unknown>;
    const current = env[SKIP_IDE_VALID_CHECK_KEY];

    if (typeof current === "string" && current !== "true") {
      // User pinned a different value (e.g. "false") — respect it.
      return {
        action: "preserved-user-value",
        path: ccSettingsPath,
        existingValue: current,
      };
    }
    if (current === "true") {
      return { action: "already-present", path: ccSettingsPath };
    }

    env[SKIP_IDE_VALID_CHECK_KEY] = "true";
    ccSettings.env = env;
    // Atomic — settings.json holds the user's full Claude Code config;
    // a crash mid-write must not corrupt it.
    writeFileAtomicSync(
      ccSettingsPath,
      `${JSON.stringify(ccSettings, null, 2)}\n`,
    );
    return { action: "added", path: ccSettingsPath };
  } catch (err) {
    return {
      action: "error",
      path: ccSettingsPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
