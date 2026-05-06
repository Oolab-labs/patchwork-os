import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice } from "./adapters/index.js";

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

export function loadConfig(path = defaultConfigPath()): PatchworkConfig {
  if (!existsSync(path)) return { ...DEFAULTS };
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<PatchworkConfig>;
  return { ...DEFAULTS, ...parsed };
}

export function saveConfig(
  config: PatchworkConfig,
  path = defaultConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateModelChoice(value: string): value is ModelChoice {
  return ["claude", "openai", "gemini", "grok", "local"].includes(value);
}
