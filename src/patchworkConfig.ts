import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice } from "./adapters/index.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./connectors/tokenStorage.js";
import { writeFileAtomicSync } from "./writeFileAtomic.js";

/**
 * Single source of truth for AI driver modes. Both the runtime `Driver`
 * type and `config.schema.json` derive from this list — the test in
 * src/__tests__/configSchemaAlignment.test.ts asserts they stay aligned.
 */
export const DRIVERS = [
  "subprocess",
  "api",
  "openai",
  "grok",
  "gemini",
  "gemini-api",
  "local",
  "none",
] as const;

export type Driver = (typeof DRIVERS)[number];

export interface PatchworkConfig {
  model: ModelChoice;
  defaultModel?: string;
  apiKeys?: {
    anthropic?: string;
    openai?: string;
    google?: string;
    xai?: string;
  };
  localEndpoint?: string;
  localModel?: string;
  localEmbeddingsEndpoint?: string;
  localEmbeddingsModel?: string;
  dashboard?: {
    port: number;
    requireApproval: Array<"low" | "medium" | "high">;
    pushNotifications: boolean;
    webhookUrl?: string;
  };
  recipesDir?: string;
  /** Approval gate level — mirrors CLI --approval-gate. Persisted so dashboard changes survive restart. */
  approvalGate?: "off" | "high" | "all";
  /**
   * Opt-in toggle for personalSignals heuristic 10 (time-of-day anomaly).
   * Mirrors CLI --enable-time-of-day-anomaly. Persisted so dashboard
   * changes survive restart. Default false — h10 is off until the user
   * explicitly enables it.
   */
  enableTimeOfDayAnomaly?: boolean;
  /** Absolute path to a managed settings file (admin-controlled, highest rule precedence). */
  managedSettingsPath?: string;
  recipes?: {
    disabled?: string[];
    /** IANA timezone name for cron schedules, e.g. "America/New_York". Defaults to "UTC". */
    timezone?: string;
  };
  /** AI driver mode — persisted so dashboard changes survive restart. */
  driver?: Driver;
  /** Notification channel config */
  notifications?: {
    slackChannel?: string;
  };
  /**
   * Path to the `claude` CLI binary. Used by recipe `agent:` steps
   * (`defaultClaudeCodeFn`) when the runtime can't rely on PATH-based
   * lookup — e.g. a launchd-managed bridge whose env diverges from the
   * developer's interactive shell, or a `npm link`-ed install where
   * the global `claude` symlink resolves into a sandboxed dir.
   *
   * Override priority (highest first):
   *   1. `PATCHWORK_CLAUDE_BINARY` env var
   *   2. this `claudeBinary` config field
   *   3. plain `"claude"` (PATH lookup)
   *
   * Default: omitted → spawn falls back to PATH lookup, matching
   * pre-existing behavior.
   */
  claudeBinary?: string;
  /**
   * Mobile-oversight push relay (FCM/APNS gateway URL the bridge POSTs to)
   * and its bearer token. Persisted so dashboard changes survive restart.
   */
  pushServiceUrl?: string;
  pushServiceToken?: string;
  /**
   * Origin embedded in the service-worker's approveUrl/rejectUrl. The SW
   * POSTs the one-shot approvalToken here, so a wrong/insecure value
   * exfiltrates approvals — HTTPS is enforced at the /settings boundary.
   */
  pushServiceBaseUrl?: string;
  /**
   * Public-ntfy.sh push channel. Topic acts as a bearer; server defaults
   * to https://ntfy.sh and can be overridden for self-hosted instances.
   */
  ntfyTopic?: string;
  ntfyServer?: string;
}

const DEFAULTS: PatchworkConfig = {
  model: "claude",
  dashboard: {
    port: 3200,
    requireApproval: ["high"],
    pushNotifications: false,
  },
  recipesDir: join(homedir(), ".patchwork", "recipes"),
  // Default driver so `patchwork-os recipe run X` and dashboard task launches
  // work immediately after `patchwork init`. Without this the bridge defaults
  // to "none" and recipe execution returns "Recipe execution unavailable —
  // requires --driver subprocess", silently breaking the init "Next:" flow.
  driver: "subprocess",
};

export function defaultConfigPath(): string {
  return join(homedir(), ".patchwork", "config.json");
}

type ApiKeyProvider = keyof NonNullable<PatchworkConfig["apiKeys"]>;
const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
];

function secretKeyFor(provider: ApiKeyProvider): string {
  return `apiKey.${provider}`;
}

interface StoredApiKey {
  key: string;
}

/**
 * Persist a single API key to the secure store. Empty string deletes.
 * Used by /settings POST so new keys never touch ~/.patchwork/config.json.
 */
export function saveApiKeyToSecureStore(
  provider: ApiKeyProvider,
  key: string,
): void {
  if (!key) {
    deleteSecretJsonSync(secretKeyFor(provider));
  } else {
    storeSecretJsonSync(secretKeyFor(provider), { key } satisfies StoredApiKey);
  }
  // Secure-store change invalidates any cached loadConfig result that merged
  // the old key values.
  clearConfigCache();
}

function loadApiKeysFromSecureStore(): NonNullable<PatchworkConfig["apiKeys"]> {
  const out: NonNullable<PatchworkConfig["apiKeys"]> = {};
  for (const provider of API_KEY_PROVIDERS) {
    const stored = getSecretJsonSync<StoredApiKey>(secretKeyFor(provider));
    if (stored?.key) out[provider] = stored.key;
  }
  return out;
}

/**
 * Boolean presence check per provider — returns whether a key is in the
 * secure store, never the key itself. Used by /status so the dashboard can
 * render "key set" badges and gate the picker without ever seeing a raw key.
 */
export function getApiKeysPresent(): Record<ApiKeyProvider, boolean> {
  const out: Record<ApiKeyProvider, boolean> = {
    anthropic: false,
    openai: false,
    google: false,
    xai: false,
  };
  for (const provider of API_KEY_PROVIDERS) {
    const stored = getSecretJsonSync<StoredApiKey>(secretKeyFor(provider));
    out[provider] = Boolean(stored?.key);
  }
  return out;
}

// TTL-based cache for loadConfig results. loadConfig reads config.json + up to
// 4 provider .enc files (DPAPI spawn on Windows = 500–1500 ms each). A 30 s TTL
// cuts the per-webhook 9+ kernel-call burst to ~1 per 30 s at steady state.
const _configCache = new Map<
  string,
  { result: PatchworkConfig; expires: number }
>();
const _CONFIG_TTL_MS = 30_000;

/** Clear the loadConfig cache. Exposed for tests and after saveConfig. */
export function clearConfigCache(): void {
  _configCache.clear();
}

export function loadConfig(path = defaultConfigPath()): PatchworkConfig {
  const now = Date.now();
  const cached = _configCache.get(path);
  if (cached && now < cached.expires) return cached.result;
  if (!existsSync(path)) {
    const fromStore = loadApiKeysFromSecureStore();
    const result: PatchworkConfig =
      Object.keys(fromStore).length > 0
        ? { ...DEFAULTS, apiKeys: fromStore }
        : { ...DEFAULTS };
    _configCache.set(path, { result, expires: now + _CONFIG_TTL_MS });
    return result;
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<PatchworkConfig>;

  // One-time migration: lift plaintext apiKeys from disk into the secure
  // store, then rewrite the config file without them. Subsequent loads see
  // an empty `apiKeys` on disk and read from the secure store instead.
  let migrated = false;
  if (parsed.apiKeys) {
    for (const provider of API_KEY_PROVIDERS) {
      const v = parsed.apiKeys[provider];
      if (typeof v === "string" && v) {
        try {
          storeSecretJsonSync(secretKeyFor(provider), {
            key: v,
          } satisfies StoredApiKey);
          migrated = true;
        } catch {
          // Secure store unavailable — leave plaintext in place rather than
          // delete a working credential. User can re-enter via dashboard.
        }
      }
    }
    if (migrated) {
      const stripped = { ...parsed };
      delete (stripped as Partial<PatchworkConfig>).apiKeys;
      try {
        writeFileAtomicSync(path, JSON.stringify(stripped, null, 2), {
          mode: 0o600,
        });
      } catch {
        // Read-only filesystem or permissions error — non-fatal; secure
        // store now holds a copy, plaintext stays on disk until next save.
      }
    }
  }

  // Merge: secure store is the source of truth; any non-migrated plaintext
  // (in case the migration write above failed) remains as a fallback.
  const fromStore = loadApiKeysFromSecureStore();
  const apiKeys =
    Object.keys(fromStore).length > 0 || parsed.apiKeys
      ? { ...parsed.apiKeys, ...fromStore }
      : undefined;
  const result: PatchworkConfig = {
    ...DEFAULTS,
    ...parsed,
    ...(apiKeys ? { apiKeys } : {}),
  };
  // Don't cache migrated configs — the file has just been rewritten; next load
  // should see the stripped version. This path is once-per-key, not hot.
  if (!migrated)
    _configCache.set(path, { result, expires: now + _CONFIG_TTL_MS });
  return result;
}

export function saveConfig(
  config: PatchworkConfig,
  path = defaultConfigPath(),
): void {
  _configCache.delete(path); // invalidate before write so next load sees new content
  mkdirSync(dirname(path), { recursive: true });
  // Strip apiKeys before persisting — they belong in the secure store, never
  // on disk. Defense in depth: even if a caller mutates cfg.apiKeys directly,
  // we won't round-trip it back to plaintext JSON.
  const stripped: PatchworkConfig = { ...config };
  delete stripped.apiKeys;
  writeFileAtomicSync(path, JSON.stringify(stripped, null, 2), {
    mode: 0o600,
  });
}

export function validateModelChoice(value: string): value is ModelChoice {
  return ["claude", "openai", "gemini", "grok", "local"].includes(value);
}
