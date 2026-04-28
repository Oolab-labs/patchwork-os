/**
 * Feature Flags — runtime gating for new surfaces and kill switches.
 *
 * Supports:
 *   - File-based flags (~/.patchwork/config/flags.json)
 *   - Environment variable overrides
 *   - Kill switch for write-tier operations
 *   - Per-feature opt-in with default-off safety
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
