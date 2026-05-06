import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  type PatchworkConfig,
  saveConfig,
} from "../patchworkConfig.js";
import { registerPreToolUseHook } from "../preToolUseHook.js";

interface InitOptions {
  force: boolean;
  skipOllama: boolean;
  withConnectors: boolean;
}

function parseArgs(argv: string[]): InitOptions | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  return {
    force: argv.includes("--force"),
    skipOllama: argv.includes("--no-ollama"),
    withConnectors: argv.includes("--with-connectors"),
  };
}

// Recipes that run with no external service credentials (local file/git only).
// Anything not in this set requires a connector (gmail, github, linear, slack,
// sentry, calendar, …) and is skipped on first init unless --with-connectors.
const LOCAL_ONLY_RECIPES: ReadonlySet<string> = new Set([
  "ambient-journal.yaml",
  "daily-status.yaml",
  "lint-on-save.yaml",
  "stale-branches.yaml",
  "watch-failing-tests.yaml",
]);

// Dev/dogfood fixtures that aren't user-facing and shouldn't be seeded by
// either init mode. Skipped silently regardless of --with-connectors.
const DEV_FIXTURE_RECIPES: ReadonlySet<string> = new Set([
  "ctx-loop-test.yaml",
]);

function printHelp(): void {
  process.stdout.write(`patchwork-os init — Set up ~/.patchwork on this machine

Usage: patchwork-os init [options]

Options:
  --force             Overwrite existing config (default: merge, preserve)
  --no-ollama         Skip Ollama detection
  --with-connectors   Also copy connector-dependent recipes (gmail, github, …)
  --help, -h          Show this help

What it does:
  1. Create ~/.patchwork/{config.json,recipes,inbox,journal}
  2. Copy local-only recipe templates to ~/.patchwork/recipes/
     (add --with-connectors to also copy gmail/github/etc. recipes)
  3. Detect Ollama at localhost:11434 → set provider to ollama-local
  4. Register the Patchwork PreToolUse hook in ~/.claude/settings.json
     so Claude Code routes tool calls through your delegation policy
  5. Print next steps
`);
}

function findTemplatesDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/commands/patchworkInit.js → ../../templates/recipes
  // src/commands/patchworkInit.ts (ts-node) → ../../templates/recipes
  const candidates = [
    resolve(here, "..", "..", "templates", "recipes"),
    resolve(here, "..", "..", "..", "templates", "recipes"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

async function detectOllama(timeoutMs = 500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

interface InitResult {
  configPath: string;
  recipesDir: string;
  recipesCopied: number;
  recipesSkipped: number;
  ollamaDetected: boolean;
  configAction: "created" | "merged" | "overwritten";
  /**
   * State of the Claude Code PreToolUse hook after init ran.
   * - "added": registered fresh
   * - "already-wired": prior `patchwork-init` already left it in place
   * - "error": registration failed (e.g. unwritable settings file) — printed
   *   as a warning but does not fail init
   */
  preToolUseHook: "added" | "already-wired" | "error";
}

export async function runPatchworkInit(
  argv: string[],
  opts: { cwd?: string; home?: string; quiet?: boolean } = {},
): Promise<InitResult> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    printHelp();
    process.exit(0);
  }

  const home = opts.home ?? homedir();
  const patchworkDir = join(home, ".patchwork");
  const recipesDir = join(patchworkDir, "recipes");
  const inboxDir = join(patchworkDir, "inbox");
  const journalDir = join(patchworkDir, "journal");
  const configPath = join(patchworkDir, "config.json");

  const log = opts.quiet ? () => {} : (s: string) => process.stdout.write(s);

  log("patchwork-os init\n\n");

  for (const dir of [patchworkDir, recipesDir, inboxDir, journalDir]) {
    mkdirSync(dir, { recursive: true });
  }
  log(`  ✓ ~/.patchwork scaffolded\n`);

  const templatesDir = findTemplatesDir();
  let recipesCopied = 0;
  let recipesSkipped = 0;
  let recipesGated = 0;
  if (templatesDir) {
    for (const name of readdirSync(templatesDir)) {
      if (!name.endsWith(".yaml")) continue;
      if (DEV_FIXTURE_RECIPES.has(name)) continue;
      if (!parsed.withConnectors && !LOCAL_ONLY_RECIPES.has(name)) {
        recipesGated++;
        continue;
      }
      const dest = join(recipesDir, name);
      if (existsSync(dest) && !parsed.force) {
        recipesSkipped++;
        continue;
      }
      copyFileSync(join(templatesDir, name), dest);
      recipesCopied++;
    }
    const gatedNote = recipesGated
      ? ` (${recipesGated} connector-recipes skipped — re-run with --with-connectors)`
      : "";
    log(
      `  ✓ recipes: ${recipesCopied} copied, ${recipesSkipped} preserved${gatedNote}\n`,
    );
  } else {
    log(`  ! recipe templates not found (expected templates/recipes/)\n`);
  }

  let ollamaDetected = false;
  if (!parsed.skipOllama) {
    ollamaDetected = await detectOllama();
    log(
      ollamaDetected
        ? `  ✓ Ollama detected at localhost:11434\n`
        : `  · Ollama not detected (skipping local model)\n`,
    );
  }

  let configAction: InitResult["configAction"];
  let existing: PatchworkConfig | null = null;
  if (existsSync(configPath) && !parsed.force) {
    try {
      existing = loadConfig(configPath);
    } catch {
      existing = null;
    }
  }

  if (existing) {
    const merged: PatchworkConfig = {
      ...existing,
      model: ollamaDetected && !existing.model ? "local" : existing.model,
      recipesDir: existing.recipesDir ?? recipesDir,
    };
    if (ollamaDetected && !existing.localEndpoint) {
      merged.localEndpoint = "http://localhost:11434";
    }
    saveConfig(merged, configPath);
    configAction = "merged";
  } else {
    const fresh: PatchworkConfig = {
      model: ollamaDetected ? "local" : "claude",
      recipesDir,
      dashboard: {
        port: 3200,
        requireApproval: ["high"],
        pushNotifications: false,
      },
    };
    if (ollamaDetected) fresh.localEndpoint = "http://localhost:11434";
    saveConfig(fresh, configPath);
    configAction =
      existsSync(configPath) && parsed.force ? "overwritten" : "created";
  }
  log(`  ✓ config ${configAction}: ${configPath}\n`);

  // Register the Patchwork PreToolUse hook in Claude Code's settings.json
  // so CC actually routes tool calls through the bridge's approval queue.
  // Without this, `--approval-gate` is silently inert and the entire
  // personalSignals catalog has no input data — exactly the foot-gun
  // PR #150 added a startup warning for. Now `patchwork-init` fixes it
  // at the source rather than just warning about it later.
  const ccSettingsDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  mkdirSync(ccSettingsDir, { recursive: true });
  const ccSettingsPath = join(ccSettingsDir, "settings.json");
  const hookResult = registerPreToolUseHook(ccSettingsPath);
  let preToolUseHook: InitResult["preToolUseHook"];
  if (hookResult.action === "added") {
    log(`  ✓ Claude Code PreToolUse hook registered: ${ccSettingsPath}\n`);
    preToolUseHook = "added";
  } else if (hookResult.action === "already-wired") {
    log(`  ✓ Claude Code PreToolUse hook already registered\n`);
    preToolUseHook = "already-wired";
  } else {
    log(
      `  ! Could not register Claude Code PreToolUse hook: ${hookResult.error ?? "unknown"}\n` +
        `    Delegation policy will not see traffic until you add the hook manually.\n`,
    );
    preToolUseHook = "error";
  }

  // CC reads hooks at session start, so the registration we just did
  // (or confirmed) only takes effect for *future* sessions. Without
  // this prompt, users follow the docs, run init, and the delegation policy
  // still appears inert — the trap that wasted hours of investigation
  // during dogfood verification on 2026-05-03.
  const restartLine =
    preToolUseHook === "added"
      ? `\n  ⚠  Restart Claude Code so the new PreToolUse hook takes effect.\n     (CC reads hooks at session start — existing sessions won't see the change.)\n`
      : "";

  log(`${restartLine}\nNext:
  1. patchwork start                           # launch bridge + Claude + dashboard (one command)
  2. patchwork-os recipe run daily-status      # zero-config: yesterday's commits + today's hints
  3. patchwork-os                              # terminal dashboard (TUI, alternative to web)
  4. patchwork-os recipe list                  # browse installed recipes
  5. patchwork-os init --with-connectors       # add gmail/github/linear/etc. recipes\n`);

  return {
    configPath,
    recipesDir,
    recipesCopied,
    recipesSkipped,
    ollamaDetected,
    configAction,
    preToolUseHook,
  };
}
