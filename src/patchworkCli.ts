import type { ModelAdapter } from "./adapters/index.js";
import { createAdapter } from "./adapters/index.js";
import type { PatchworkConfig } from "./patchworkConfig.js";
import { loadConfig, validateModelChoice } from "./patchworkConfig.js";

/**
 * resolveModel — parses `--model <name>` from argv and merges with the
 * on-disk PatchworkConfig. CLI wins over file. Returns the resolved config
 * + constructed adapter, or null if the user didn't pass --model and has
 * no config file (meaning: run bridge in default Claude-CLI mode).
 */
export function resolveModel(
  argv: string[],
  deps: { loadConfig?: typeof loadConfig } = {},
): { config: PatchworkConfig; adapter: ModelAdapter } | null {
  const cliModel = findFlag(argv, "--model");
  const configPath = findFlag(argv, "--patchwork-config");

  const load = deps.loadConfig ?? loadConfig;
  let config: PatchworkConfig;
  try {
    config = configPath ? load(configPath) : load();
  } catch (err) {
    throw new Error(
      `Could not load Patchwork config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (cliModel) {
    if (!validateModelChoice(cliModel)) {
      throw new Error(
        `--model must be one of: claude, openai, gemini, grok, local (got: ${cliModel})`,
      );
    }
    config = { ...config, model: cliModel };
  }

  // No --model flag AND no saved config → caller should skip adapter init.
  if (!cliModel && !configPath) {
    return null;
  }

  return { config, adapter: createAdapter(config) };
}

function findFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}
