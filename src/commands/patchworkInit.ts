import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  type PatchworkConfig,
  saveConfig,
} from "../patchworkConfig.js";

interface InitOptions {
  force: boolean;
  skipOllama: boolean;
}

function parseArgs(argv: string[]): InitOptions | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  return {
    force: argv.includes("--force"),
    skipOllama: argv.includes("--no-ollama"),
  };
}

function printHelp(): void {
  process.stdout.write(`patchwork-os init — Set up ~/.patchwork on this machine

Usage: patchwork-os init [options]

Options:
  --force      Overwrite existing config (default: merge, preserve)
  --no-ollama  Skip Ollama detection
  --help, -h   Show this help

What it does:
  1. Create ~/.patchwork/{config.json,recipes,inbox,journal}
  2. Copy 5 local-only recipe templates to ~/.patchwork/recipes/
  3. Detect Ollama at localhost:11434 → set provider to ollama-local
  4. Print next steps
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
  if (templatesDir) {
    for (const name of readdirSync(templatesDir)) {
      if (!name.endsWith(".yaml")) continue;
      const dest = join(recipesDir, name);
      if (existsSync(dest) && !parsed.force) {
        recipesSkipped++;
        continue;
      }
      copyFileSync(join(templatesDir, name), dest);
      recipesCopied++;
    }
    log(`  ✓ recipes: ${recipesCopied} copied, ${recipesSkipped} preserved\n`);
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
        port: 3000,
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

  log(`\nNext:
  1. patchwork-os recipe run ambient-journal   # try a local recipe
  2. patchwork-os                              # launch terminal dashboard
  3. Connect Gmail (coming in W2) — see docs/adr/0008-connector-scope-decision.md\n`);

  return {
    configPath,
    recipesDir,
    recipesCopied,
    recipesSkipped,
    ollamaDetected,
    configAction,
  };
}
