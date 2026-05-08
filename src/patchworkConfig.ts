import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice } from "./adapters/index.js";
import {
  deleteSecretJsonSync,
  getSecretJsonSync,
  storeSecretJsonSync,
} from "./connectors/tokenStorage.js";

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
  };
  /** AI driver mode — persisted so dashboard changes survive restart. */
  driver?: "subprocess" | "api" | "openai" | "grok" | "gemini" | "none";
  /** Notification channel config */
  notifications?: {
    slackChannel?: string;
  };
}

const DEFAULTS: PatchworkConfig = {
  model: "claude",
  dashboard: {
    port: 3200,
    requireApproval: ["high"],
    pushNotifications: false,
  },
  recipesDir: join(homedir(), ".patchwork", "recipes"),
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
    return;
  }
  storeSecretJsonSync(secretKeyFor(provider), { key } satisfies StoredApiKey);
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

export function loadConfig(path = defaultConfigPath()): PatchworkConfig {
  if (!existsSync(path)) {
    const fromStore = loadApiKeysFromSecureStore();
    return Object.keys(fromStore).length > 0
      ? { ...DEFAULTS, apiKeys: fromStore }
      : { ...DEFAULTS };
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
        writeFileSync(path, JSON.stringify(stripped, null, 2), { mode: 0o600 });
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
  return { ...DEFAULTS, ...parsed, ...(apiKeys ? { apiKeys } : {}) };
}

export function saveConfig(
  config: PatchworkConfig,
  path = defaultConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  // Strip apiKeys before persisting — they belong in the secure store, never
  // on disk. Defense in depth: even if a caller mutates cfg.apiKeys directly,
  // we won't round-trip it back to plaintext JSON.
  const stripped: PatchworkConfig = { ...config };
  delete stripped.apiKeys;
  writeFileSync(path, JSON.stringify(stripped, null, 2), { mode: 0o600 });
}

export function validateModelChoice(value: string): value is ModelChoice {
  return ["claude", "openai", "gemini", "grok", "local"].includes(value);
}
