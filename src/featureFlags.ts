/**
 * Feature Flags — runtime gating for new surfaces and kill switches.
 *
 * Supports:
 *   - File-based flags (~/.patchwork/config/flags.json)
 *   - Environment variable overrides
 *   - Kill switch for write-tier operations
 *   - Per-feature opt-in with default-off safety
 */

import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

/** Flag definition */
export interface FeatureFlag {
  /** Flag identifier (kebab-case) */
  id: string;
  /** Human-readable description */
  description: string;
  /** Default state if not explicitly set */
  defaultValue: boolean;
  /** Category for grouping in dashboard */
  category: "safety" | "ui" | "connector" | "experimental";
  /** Whether this flag requires explicit opt-in (not auto-enabled) */
  requiresOptIn: boolean;
  /** For kill switches: when true, blocks writes */
  isKillSwitch?: boolean;
}

/** Flag registry — all known flags */
const FLAG_REGISTRY: Map<string, FeatureFlag> = new Map();

/** Runtime flag values (after env/file resolution) */
const FLAG_VALUES: Map<string, boolean> = new Map();

/** Flag storage path */
function getFlagsPath(): string {
  return join(
    process.env.PATCHWORK_HOME ?? join(os.homedir(), ".patchwork"),
    "config",
    "flags.json",
  );
}

/**
 * Register a feature flag. Should be called at module init.
 * Duplicate IDs throw — ensures no accidental double-registration.
 */
export function registerFlag(flag: FeatureFlag): void {
  if (FLAG_REGISTRY.has(flag.id)) {
    throw new Error(`Feature flag "${flag.id}" is already registered`);
  }
  FLAG_REGISTRY.set(flag.id, flag);
  // Initialize with default value
  FLAG_VALUES.set(flag.id, flag.defaultValue);
}

/**
 * Snapshot of env-derived kill-switch values, populated by `lockKillSwitchEnv()`
 * at bridge startup. Once locked, kill-switch flags ignore live `process.env`
 * mutations — defends against a plugin / recipe step trying to disable an
 * active emergency stop by writing `process.env.PATCHWORK_FLAG_*`.
 */
const FROZEN_KILL_SWITCH_ENV: Map<string, boolean | undefined> = new Map();
let envLocked = false;

/**
 * Snapshot the current `process.env` values for every registered kill-switch
 * flag. Called once by `Bridge.start()` after `loadFlags()` so subsequent
 * env mutations are ignored for kill-switch reads. Idempotent — second call
 * is a no-op (would otherwise let an attacker re-snapshot a tampered env).
 *
 * Non-kill-switch flags remain dynamic so test infrastructure that mutates
 * env per case continues to work.
 */
export function lockKillSwitchEnv(): void {
  if (envLocked) return;
  for (const [id, flag] of FLAG_REGISTRY.entries()) {
    if (!flag.isKillSwitch) continue;
    const envKey = `PATCHWORK_FLAG_${id.replace(/[.-]/g, "_").toUpperCase()}`;
    const envVal = process.env[envKey];
    FROZEN_KILL_SWITCH_ENV.set(
      id,
      envVal === undefined
        ? undefined
        : envVal === "1" || envVal.toLowerCase() === "true",
    );
  }
  envLocked = true;
}

/**
 * TEST ONLY — resets the env lock so tests can exercise both locked and
 * unlocked paths without process restart. Do not call from production code.
 */
export function _resetEnvLockForTesting(): void {
  envLocked = false;
  FROZEN_KILL_SWITCH_ENV.clear();
}

/**
 * Check if a feature flag is enabled.
 * Resolution order (highest to lowest priority):
 *   1. Environment variable (PATCHWORK_FLAG_<ID>) — frozen at `lockKillSwitchEnv()`
 *      time for kill-switch flags so post-lock mutations are ignored
 *   2. User config file (~/.patchwork/config/flags.json)
 *   3. Default value from registration
 */
export function isEnabled(flagId: string): boolean {
  // Check cache first
  if (FLAG_VALUES.has(flagId)) {
    const flag = FLAG_REGISTRY.get(flagId);
    // Kill-switch flags read from the frozen snapshot once locked. This
    // closes the gap where a plugin / recipe step could `process.env[...] = "0"`
    // to disable an active emergency stop.
    if (envLocked && flag?.isKillSwitch) {
      const frozen = FROZEN_KILL_SWITCH_ENV.get(flagId);
      if (frozen !== undefined) return frozen;
      return FLAG_VALUES.get(flagId)!;
    }
    // Dynamic env read for non-kill-switch flags (test-friendly).
    const envKey = `PATCHWORK_FLAG_${flagId.replace(/[.-]/g, "_").toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      return envVal === "1" || envVal.toLowerCase() === "true";
    }
    return FLAG_VALUES.get(flagId)!;
  }

  // Unknown flag — default to false (safe)
  return false;
}

/**
 * Returns true when the given kill-switch flag is **env-locked** — i.e. its
 * value was frozen at startup from a `PATCHWORK_FLAG_<ID>` environment
 * variable and any subsequent `setFlag()` call will be silently overridden
 * by `isEnabled()`.
 *
 * Used by the `/kill-switch` endpoint (issue #422) to surface a 409
 * Conflict instead of returning 200 OK for a setFlag that won't stick,
 * and by the dashboard to render the toggle as disabled (with a tooltip
 * naming which direction was sysadmin-locked) when this returns true.
 *
 * Returns false for non-kill-switch flags (they read env dynamically and
 * are never "locked"), for unknown flags, and when `lockKillSwitchEnv()`
 * has not yet been called.
 */
export function isEnvLockedFor(flagId: string): boolean {
  if (!envLocked) return false;
  const flag = FLAG_REGISTRY.get(flagId);
  if (!flag?.isKillSwitch) return false;
  return FROZEN_KILL_SWITCH_ENV.get(flagId) !== undefined;
}

/**
 * Returns the frozen env-locked value for a kill-switch flag (`true` /
 * `false`), or `null` if not env-locked.
 *
 * Used by the dashboard tooltip so the disabled-state can read "env-locked
 * to **on**" vs "env-locked to **off**" — both directions are policy-locked,
 * but the user should know which.
 */
export function getEnvLockedValue(flagId: string): boolean | null {
  if (!isEnvLockedFor(flagId)) return null;
  const frozen = FROZEN_KILL_SWITCH_ENV.get(flagId);
  return frozen === undefined ? null : frozen;
}

/**
 * Set a flag value (persists to config file if persist=true).
 */
export function setFlag(flagId: string, value: boolean, persist = false): void {
  if (!FLAG_REGISTRY.has(flagId)) {
    throw new Error(`Unknown feature flag: "${flagId}"`);
  }

  FLAG_VALUES.set(flagId, value);

  if (persist) {
    persistFlags();
  }
}

/**
 * Get all registered flags with their current values.
 */
export function listFlags(): Array<FeatureFlag & { currentValue: boolean }> {
  return Array.from(FLAG_REGISTRY.values()).map((flag) => ({
    ...flag,
    currentValue: isEnabled(flag.id),
  }));
}

/**
 * Load flags from config file.
 */
export function loadFlags(): void {
  const path = getFlagsPath();
  if (!existsSync(path)) {
    return;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, boolean>;

    for (const [key, value] of Object.entries(parsed)) {
      if (FLAG_REGISTRY.has(key)) {
        FLAG_VALUES.set(key, value);
      }
    }
  } catch {
    // Invalid file — ignore, use defaults
  }
}

/**
 * Persist current flag values to config file.
 */
function persistFlags(): void {
  const path = getFlagsPath();
  const dir = join(path, "..");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const toSave: Record<string, boolean> = {};
  for (const [id, value] of FLAG_VALUES.entries()) {
    const flag = FLAG_REGISTRY.get(id);
    // Only save if different from default
    if (flag && value !== flag.defaultValue) {
      toSave[id] = value;
    }
  }

  writeFileSync(path, JSON.stringify(toSave, null, 2));
}

// ============================================================================
// Built-in Flags
// ============================================================================

/** Kill switch for ALL write-tier operations */
export const KILL_SWITCH_WRITES = "kill-switch.writes";

/** Enable recipe lint with schema validation (A1) */
export const FLAG_SCHEMA_LINT = "ui.schema-lint";

// Register built-in flags
registerFlag({
  id: KILL_SWITCH_WRITES,
  description:
    "EMERGENCY: Block all write-tier recipe operations (file.write, file.append, slack.post_message, etc.)",
  defaultValue: false,
  category: "safety",
  requiresOptIn: false,
  isKillSwitch: true,
});

registerFlag({
  id: FLAG_SCHEMA_LINT,
  description: "Recipe linting with JSON Schema validation",
  defaultValue: false,
  category: "ui",
  requiresOptIn: true,
});

// Load persisted flags on module init
loadFlags();

/**
 * Watch the flags.json file for cross-process changes. When another
 * process (typically the `patchwork kill-switch` CLI in its fallback
 * fs-write path, or a sibling bridge in a multi-bridge deployment)
 * writes to flags.json, this watcher reloads the in-memory FLAG_VALUES
 * so the running bridge picks up the new state without a restart.
 *
 * v2-S1 + v2-B2 from #422. Closes the "no bridge reachable → CLI
 * silent fallback → recipes keep writing" gap that motivated the
 * redesign — even when the CLI's HTTP path fails and it falls back
 * to writing the file directly, the running bridge still sees the
 * change.
 *
 * **Env-lock interaction:** if `lockKillSwitchEnv()` already froze a
 * kill-switch value from `PATCHWORK_FLAG_*`, the file-watch flow
 * still updates FLAG_VALUES, but `isEnabled` continues reading from
 * the frozen snapshot for that flag (existing behavior at L117-121).
 * The env-lock is the source of truth — file changes can't override
 * a sysadmin-mandated kill-switch state. This is the correct policy.
 *
 * Modeled on `src/pluginWatcher.ts`: directory-watch + filename
 * filter + 100ms debounce so coalesced events (rename+create+change
 * on most filesystems) don't trigger N reloads. Returns a close
 * handle. Tolerates the file or directory not yet existing.
 */
export function watchFlags(): () => void {
  const flagsPath = getFlagsPath();
  const flagsDir = join(flagsPath, "..");
  const flagsFile = "flags.json";

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let stopped = false;

  const reload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (stopped) return;
      try {
        loadFlags();
      } catch {
        // loadFlags has its own try/catch for parse errors;
        // this catch is belt-and-suspenders for fs errors.
      }
    }, 100);
  };

  try {
    // Watch the directory rather than the file directly — flags.json
    // may not exist yet when watch is established, and editors / atomic
    // writes (rename-into-place) lose direct file watches.
    watcher = watch(flagsDir, { recursive: false }, (_event, filename) => {
      if (stopped) return;
      // filename may be null on some platforms; reload on null to be safe.
      if (!filename || filename === flagsFile) {
        reload();
      }
    });
  } catch {
    // Directory doesn't exist yet — the user hasn't engaged any flags.
    // No-op; first `persistFlags()` creates the dir and from then on
    // the watcher won't fire. This is acceptable for an emergency-stop
    // flag because the file will exist as soon as anyone toggles via
    // /kill-switch (which calls setFlag(..., persist=true)).
  }

  return (): void => {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
  };
}

// ============================================================================
// Kill Switch Helpers
// ============================================================================

/**
 * Check if write operations are globally disabled.
 */
export function isWriteKillSwitchActive(): boolean {
  return isEnabled(KILL_SWITCH_WRITES);
}

/**
 * Assert write is allowed — throws if kill switch is active.
 */
export function assertWriteAllowed(operation: string): void {
  if (isWriteKillSwitchActive()) {
    throw new Error(
      `Write operation blocked by kill switch: ${operation}. ` +
        `Unset PATCHWORK_FLAG_KILL_SWITCH_WRITES or set kill-switch.writes=false to restore.`,
    );
  }
}
