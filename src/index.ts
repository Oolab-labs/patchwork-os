#!/usr/bin/env node

// Enable V8 compile cache for faster cold-start on repeated restarts (Node 22.8+).
import nodeModule from "node:module";

if (typeof nodeModule.enableCompileCache === "function") {
  nodeModule.enableCompileCache();
}

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getAnalyticsPref, setAnalyticsPref } from "./analyticsPrefs.js";
import { Bridge } from "./bridge.js";
import {
  isBridgeToolsFileValid,
  repairBridgeToolsRulesIfStale,
} from "./bridgeToolsRules.js";
import { findEditor, parseConfig } from "./config.js";
import { PACKAGE_VERSION, semverGt } from "./version.js";

const __dirnameTop = path.dirname(fileURLToPath(import.meta.url));

const OPEN_VSX_PUBLISHER = "oolab-labs";
const OPEN_VSX_NAME = "claude-ide-bridge-extension";

// CLAUDE.md versioned-block patching moved to ./claudeMdPatch.ts so tests
// can import the helpers without triggering the top-level CLI side effects
// at the bottom of this file. Re-exported here for back-compat.
export {
  BRIDGE_BLOCK_END,
  BRIDGE_BLOCK_RE,
  bridgeBlockStartMarker,
  extractClaudeMdBlockVersion,
  patchClaudeMdImport,
} from "./claudeMdPatch.js";

import {
  extractClaudeMdBlockVersion,
  patchClaudeMdImport,
} from "./claudeMdPatch.js";

/**
 * Downloads the latest VSIX from Open VSX Registry to a temp file.
 * Returns the temp file path (caller is responsible for deleting it).
 * Throws on network or API errors.
 */
async function downloadVsixFromOpenVsx(): Promise<string> {
  const metaUrl = `https://open-vsx.org/api/${OPEN_VSX_PUBLISHER}/${OPEN_VSX_NAME}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(
      `Open VSX metadata request failed: ${metaRes.status} ${metaRes.statusText}`,
    );
  }
  const meta = (await metaRes.json()) as {
    files?: { download?: string };
    version?: string;
  };
  const downloadUrl = meta?.files?.download;
  if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://")) {
    throw new Error("Open VSX response missing files.download URL");
  }
  const version = meta?.version ?? "unknown";
  process.stderr.write(
    `  Downloading extension v${version} from Open VSX...\n`,
  );
  const vsixRes = await fetch(downloadUrl);
  if (!vsixRes.ok) {
    throw new Error(
      `Open VSX download failed: ${vsixRes.status} ${vsixRes.statusText}`,
    );
  }
  const tmpPath = path.join(
    os.tmpdir(),
    `${OPEN_VSX_NAME}-${version}-${Date.now()}.vsix`,
  );
  const buf = await vsixRes.arrayBuffer();
  writeFileSync(tmpPath, Buffer.from(buf));
  return tmpPath;
}

// Handle --version flag — print package version and exit.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  console.log(`claude-ide-bridge ${PACKAGE_VERSION}`);
  process.exit(0);
}

// Handle start-all subcommand — launches the full 3-pane tmux orchestrator.
// Also triggered when invoked as `claude-ide-bridge-start` directly.
const isStartAll =
  process.argv[2] === "start-all" ||
  path.basename(process.argv[1] ?? "").startsWith("claude-ide-bridge-start");

if (isStartAll) {
  const startAllArgs =
    process.argv[2] === "start-all"
      ? process.argv.slice(3)
      : process.argv.slice(2);
  const scriptPath = path.resolve(
    __dirnameTop,
    "..",
    "scripts",
    "start-all.sh",
  );
  const result = spawnSync("bash", [scriptPath, ...startAllArgs], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function writeRulesFileAtomic(rulesFilePath: string, content: string): void {
  const tmpPath = `${rulesFilePath}.tmp`;
  writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    renameSync(tmpPath, rulesFilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Handles errors from rules file write operations. EACCES → warning + instructions.
 * ELOOP → hard error (symlink cycle — indicates possible symlink attack).
 * EEXIST → hard error (wx exclusive-create failed — indicates a symlink was placed
 *   at the .tmp path, since we pre-clean stale .tmp files before every wx write).
 * Others → warning. Returns the exit code to use (0 for warnings, 1 for hard errors).
 */
function handleRulesWriteError(
  err: unknown,
  rulesFilePath: string,
  indent: string,
): number {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES") {
    process.stderr.write(
      `${indent}[warn] Bridge rules — permission denied writing to ${rulesFilePath}.\n` +
        `${indent}       Run with elevated permissions or create the file manually.\n\n`,
    );
    return 0;
  }
  if (code === "ELOOP" || code === "EEXIST") {
    process.stderr.write(
      `${indent}[error] Bridge rules — suspicious path condition (${code}): ${rulesFilePath}\n\n`,
    );
    return 1;
  }
  process.stderr.write(
    `${indent}[warn] Bridge rules — write failed (${code ?? String(err)})\n\n`,
  );
  return 0;
}

// Handle gen-claude-md subcommand — generates a CLAUDE.md bridge workflow section
if (process.argv[2] === "gen-claude-md") {
  const argv = process.argv.slice(3);

  if (argv.includes("--help")) {
    console.log(`claude-ide-bridge gen-claude-md — Generate CLAUDE.md bridge section

Usage: claude-ide-bridge gen-claude-md [options]

Options:
  --write               Write to CLAUDE.md in the workspace (default: print to stdout)
  --workspace <path>    Target workspace folder (default: cwd)
  --help                Show this help`);
    process.exit(0);
  }

  const writeToDisk = argv.includes("--write");
  const workspaceIdx = argv.indexOf("--workspace");
  const workspace =
    workspaceIdx !== -1 && argv[workspaceIdx + 1]
      ? (argv[workspaceIdx + 1] as string)
      : process.cwd();

  const templatePath = path.resolve(
    __dirnameTop,
    "..",
    "templates",
    "CLAUDE.bridge.md",
  );

  let content: string;
  try {
    content = readFileSync(templatePath, "utf-8");
  } catch {
    process.stderr.write(`Error: template not found at ${templatePath}\n`);
    process.exit(1);
  }

  if (!writeToDisk) {
    process.stdout.write(`${content}\n`);
    process.stderr.write(
      "Note: run with --write to append this section to CLAUDE.md and also write .claude/rules/bridge-tools.md\n",
    );
    process.exit(0);
  }

  const targetPath = path.join(workspace, "CLAUDE.md");
  const marker = "## Claude IDE Bridge";

  const IMPORT_LINE = "@import .claude/rules/bridge-tools.md";

  // Idempotent: skip if the section already exists (with @import line)
  const patchResult = patchClaudeMdImport(targetPath, marker, IMPORT_LINE);
  if (patchResult === "already-current") {
    process.stderr.write(
      `CLAUDE.md bridge block already up to date (v${PACKAGE_VERSION}) — no changes made.\n`,
    );
    repairBridgeToolsRulesIfStale(workspace, undefined, {
      writeIfMissing: true,
    });
    process.exit(0);
  }
  if (patchResult === "updated") {
    process.stderr.write(
      `Updated CLAUDE.md bridge block to v${PACKAGE_VERSION}.\n`,
    );
    repairBridgeToolsRulesIfStale(workspace, undefined, {
      writeIfMissing: true,
    });
    process.exit(0);
  }
  if (patchResult === "patched") {
    process.stderr.write(
      `Patched existing CLAUDE.md — added missing @import line (v${PACKAGE_VERSION}).\n`,
    );
    repairBridgeToolsRulesIfStale(workspace, undefined, {
      writeIfMissing: true,
    });
    process.exit(0);
  }
  if (patchResult === "already-present") {
    process.stderr.write(
      `CLAUDE.md already contains a '${marker}' section — no changes made.\n`,
    );
    repairBridgeToolsRulesIfStale(workspace, undefined, {
      writeIfMissing: true,
    });
    process.exit(0);
  }
  // Wrap the template content in a versioned block so future re-runs can detect the version stamp.
  const versionedGenContent = content
    .trimEnd()
    .replace(
      marker,
      `<!-- claude-ide-bridge:start:${PACKAGE_VERSION} -->\n${marker}`,
    )
    .concat(`\n<!-- claude-ide-bridge:end -->`);

  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf-8");
    // Write tmp first with exclusive-create — if the write fails, the original is intact
    const updated = `${existing.trimEnd()}\n\n${versionedGenContent}\n`;
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, updated, { encoding: "utf-8", flag: "wx" });
    // Backup existing file before replacing
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${targetPath}.${ts}.bak`;
    try {
      renameSync(targetPath, backupPath);
      renameSync(tmpPath, targetPath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
    process.stderr.write(`Backed up existing CLAUDE.md to ${backupPath}\n`);
  } else {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(`${targetPath}.tmp`, `${versionedGenContent}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    renameSync(`${targetPath}.tmp`, targetPath);
  }

  process.stderr.write(
    `✓ Bridge workflow section written to ${targetPath} (v${PACKAGE_VERSION})\n`,
  );

  // Also write bridge-tools rules file alongside CLAUDE.md
  repairBridgeToolsRulesIfStale(workspace, undefined, { writeIfMissing: true });

  process.exit(0);
}

// Handle install subcommand — install a companion MCP server
if (process.argv[2] === "install") {
  const { runInstall } = await import("./commands/install.js");
  await runInstall(process.argv.slice(3));
  process.exit(0);
}

// Handle marketplace subcommand — browse and install community skills
if (process.argv[2] === "marketplace") {
  const { runMarketplace } = await import("./commands/marketplace.js");
  await runMarketplace(process.argv.slice(3));
  process.exit(0);
}

// Handle tools subcommand — search/list tools without a bridge connection
if (process.argv[2] === "tools") {
  const { runToolsCommand } = await import("./commands/tools.js");
  await runToolsCommand(process.argv.slice(3));
  process.exit(0);
}

// Headless parity subcommands — launch Claude tasks from CLI (no sidebar/VS Code required).
// Reuse the bridge's running process; no new dependencies.
if (process.argv[2] === "quick-task") {
  const { runQuickTask } = await import("./commands/task.js");
  await runQuickTask(process.argv.slice(3));
  // runQuickTask calls process.exit() itself
}
if (process.argv[2] === "start-task") {
  const { runStartTask } = await import("./commands/task.js");
  await runStartTask(process.argv.slice(3));
}
if (process.argv[2] === "continue-handoff") {
  const { runContinueHandoff } = await import("./commands/task.js");
  await runContinueHandoff(process.argv.slice(3));
}

// Handle print-token subcommand — print the bridge auth token from a lock file
if (process.argv[2] === "print-token") {
  const argv = process.argv.slice(3);

  if (argv.includes("--help")) {
    console.log(`claude-ide-bridge print-token — Print bridge auth token

Usage: claude-ide-bridge print-token [options]

Options:
  --port <number>  Read token from a specific port's lock file (default: most recent)
  --help           Show this help`);
    process.exit(0);
  }

  const portIdx = argv.indexOf("--port");
  const portArg = portIdx !== -1 ? argv[portIdx + 1] : undefined;

  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  let lockFile: string | undefined;

  if (portArg) {
    lockFile = path.join(lockDir, `${portArg}.lock`);
    if (!existsSync(lockFile)) {
      process.stderr.write(
        `Error: No lock file found for port ${portArg} at ${lockFile}\n`,
      );
      process.exit(1);
    }
  } else {
    // Find the most recently modified lock file
    let bestMtime = 0;
    try {
      for (const f of readdirSync(lockDir)) {
        if (!f.endsWith(".lock")) continue;
        const full = path.join(lockDir, f);
        const mtime = statSync(full).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          lockFile = full;
        }
      }
    } catch {
      // lock dir doesn't exist — handled below
    }
  }

  if (!lockFile) {
    process.stderr.write(`Error: No bridge lock file found in ${lockDir}\n`);
    process.stderr.write(
      "Make sure the bridge is running first, or pass --port <port>.\n",
    );
    process.exit(1);
  }

  try {
    const data = JSON.parse(readFileSync(lockFile, "utf-8")) as {
      authToken?: string;
    };
    if (!data.authToken) {
      process.stderr.write(
        `Error: Lock file ${lockFile} has no authToken field\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${data.authToken}\n`);
  } catch {
    process.stderr.write(`Error: Could not read lock file ${lockFile}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Handle notify subcommand — called from CC hooks to fire bridge automation
// Usage: claude-ide-bridge notify <CcEventName> [--cwd <p>] [--taskId <id>] [--prompt <t>] [--tool <n>] [--reason <r>] [--port <n>]
if (process.argv[2] === "notify") {
  const VALID_NOTIFY_EVENTS = new Set([
    "PreCompact",
    "PostCompact",
    "InstructionsLoaded",
    "TaskCreated",
    "PermissionDenied",
    "CwdChanged",
  ]);
  const notifyArgv = process.argv.slice(3);
  const ccEvent = notifyArgv[0];

  if (!ccEvent || !VALID_NOTIFY_EVENTS.has(ccEvent)) {
    process.stderr.write(
      `Usage: claude-ide-bridge notify <CcEventName> [options]\n\nValid events: ${[...VALID_NOTIFY_EVENTS].join(", ")}\n`,
    );
    process.exit(1);
  }

  const notifyRest = notifyArgv.slice(1);
  const namedArgs: Record<string, string> = {};
  for (let i = 0; i < notifyRest.length - 1; i++) {
    const arg = notifyRest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const val = notifyRest[i + 1] ?? "";
      namedArgs[key] = val;
      i++;
    }
  }

  const notifyLockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  let notifyLockFile: string | undefined;
  let notifyPort: number | undefined;

  if (namedArgs.port) {
    notifyPort = Number(namedArgs.port);
    notifyLockFile = path.join(notifyLockDir, `${notifyPort}.lock`);
    if (!existsSync(notifyLockFile)) {
      process.stderr.write(
        `Error: No lock file found for port ${notifyPort}\n`,
      );
      process.exit(1);
    }
  } else {
    let bestMtime = 0;
    try {
      for (const f of readdirSync(notifyLockDir)) {
        if (!f.endsWith(".lock")) continue;
        const full = path.join(notifyLockDir, f);
        const mtime = statSync(full).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          notifyLockFile = full;
          notifyPort = Number(path.basename(f, ".lock"));
        }
      }
    } catch {
      // lock dir doesn't exist
    }
  }

  if (!notifyLockFile || !notifyPort) {
    process.stderr.write(
      `Error: No bridge lock file found in ${notifyLockDir}\n`,
    );
    process.stderr.write(
      "Make sure the bridge is running first (claude-ide-bridge --watch ...).\n",
    );
    process.exit(1);
  }

  let notifyToken: string;
  try {
    const data = JSON.parse(readFileSync(notifyLockFile, "utf-8")) as {
      authToken?: string;
    };
    if (!data.authToken) {
      process.stderr.write(`Error: Lock file has no authToken field\n`);
      process.exit(1);
    }
    notifyToken = data.authToken;
  } catch {
    process.stderr.write(`Error: Could not read lock file ${notifyLockFile}\n`);
    process.exit(1);
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${notifyPort}/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notifyToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event: ccEvent, args: namedArgs }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      process.stderr.write(`Error: Bridge returned ${resp.status}: ${text}\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(
      `Error: Could not connect to bridge at port ${notifyPort}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// Handle token-efficiency subcommand — show config/session usage or run benchmark
if (process.argv[2] === "token-efficiency") {
  const teArgv = process.argv.slice(3);
  const teSubCommand = teArgv[0] ?? "status";

  if (teSubCommand === "--help" || teArgv.includes("--help")) {
    console.log(`claude-ide-bridge token-efficiency — Token usage tools

Usage: claude-ide-bridge token-efficiency [status|benchmark] [options]

Subcommands:
  status                  Show current config + live session usage (default)
  benchmark [args...]     Run benchmark against a running bridge
                            --iterations N   Number of iterations (default: 50)
                            --json           Emit JSON output
                            --threshold <ms> Fail if p99 RTT exceeds threshold

Options:
  --help  Show this help`);
    process.exit(0);
  }

  const { tokenEfficiencyStatus, tokenEfficiencyBenchmark } = await import(
    "./commands/tokenEfficiency.js"
  );

  if (teSubCommand === "benchmark") {
    await tokenEfficiencyBenchmark(teArgv.slice(1));
  } else {
    // status (default)
    await tokenEfficiencyStatus();
  }
  process.exit(0);
}

// Handle gen-plugin-stub subcommand — scaffolds a new plugin directory
if (process.argv[2] === "gen-plugin-stub") {
  const argv = process.argv.slice(3);

  // Parse args: gen-plugin-stub <dir> [--name <name>] [--prefix <prefix>]
  const dirArg = argv.find((a) => !a.startsWith("--"));
  if (!dirArg) {
    process.stderr.write(
      "Usage: claude-ide-bridge gen-plugin-stub <output-dir> [--name <org/plugin-name>] [--prefix <toolPrefix>]\n",
    );
    process.exit(1);
  }

  const nameIdx = argv.indexOf("--name");
  const prefixIdx = argv.indexOf("--prefix");
  const pluginName: string =
    nameIdx !== -1 && argv[nameIdx + 1]
      ? (argv[nameIdx + 1] as string)
      : "my-org/my-plugin";
  const toolPrefix: string =
    prefixIdx !== -1 && argv[prefixIdx + 1]
      ? (argv[prefixIdx + 1] as string)
      : "myPlugin";

  // Validate name format
  if (!/^[a-zA-Z0-9@._/-]{1,100}$/.test(pluginName)) {
    process.stderr.write(
      `Error: --name "${pluginName}" contains invalid characters. Use only letters, numbers, @, ., _, /, -.\n`,
    );
    process.exit(1);
  }

  // Validate prefix format
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/.test(toolPrefix)) {
    process.stderr.write(
      `Error: --prefix "${toolPrefix}" is invalid. Must match /^[a-zA-Z][a-zA-Z0-9_]{1,19}$/ (2–20 chars, start with a letter).\n`,
    );
    process.exit(1);
  }

  const outDir = path.resolve(dirArg);

  if (existsSync(outDir)) {
    process.stderr.write(
      `Error: "${outDir}" already exists. Choose a new directory.\n`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // claude-ide-bridge-plugin.json
  const manifest = {
    schemaVersion: 1,
    name: pluginName,
    version: "0.1.0",
    description: "A Claude IDE Bridge plugin",
    entrypoint: "./index.mjs",
    toolNamePrefix: toolPrefix,
    minBridgeVersion: "2.1.24",
  };
  writeFileSync(
    path.join(outDir, "claude-ide-bridge-plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  // index.mjs entrypoint
  const entrypoint = `/**
 * ${pluginName} — Claude IDE Bridge plugin
 *
 * Each tool must have a name starting with "${toolPrefix}".
 * The \`ctx\` object provides: ctx.workspace, ctx.workspaceFolders,
 * ctx.config (commandTimeout, maxResultSize), and ctx.logger.
 */

/** @param {import('claude-ide-bridge/plugin').PluginContext} ctx */
export function register(ctx) {
  ctx.logger.info(${JSON.stringify(`${pluginName} loaded`)}, { workspace: ctx.workspace });

  return {
    tools: [
      {
        schema: {
          name: ${JSON.stringify(`${toolPrefix}Hello`)},
          description: "Example tool — returns a greeting",
          inputSchema: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: {
              name: { type: "string", description: "Name to greet" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        handler: async (args, _signal) => ({
          content: [{ type: "text", text: "Hello from " + ${JSON.stringify(pluginName)} + ", " + args.name + "!" }],
        }),
      },
    ],
  };
}
`;
  writeFileSync(path.join(outDir, "index.mjs"), entrypoint, "utf-8");

  // package.json (optional, for npm publishing)
  const pkg = {
    name: pluginName.replace(/^@[^/]+\//, "").replace(/\//g, "-"),
    version: "0.1.0",
    description: "A Claude IDE Bridge plugin",
    type: "module",
    main: "index.mjs",
    keywords: ["claude-ide-bridge", "claude-ide-bridge-plugin"],
    peerDependencies: { "claude-ide-bridge": ">=2.1.24" },
  };
  writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf-8",
  );

  // .gitignore
  writeFileSync(path.join(outDir, ".gitignore"), "node_modules\n", "utf-8");

  process.stderr.write(`✓ Plugin stub created at ${outDir}\n`);
  process.stderr.write("\nNext steps:\n");
  process.stderr.write(
    `  1. Edit ${path.join(outDir, "index.mjs")} to implement your tools\n`,
  );
  process.stderr.write(
    `  2. Run the bridge with: claude-ide-bridge --plugin ${outDir}\n`,
  );
  process.stderr.write(
    `  3. Or add to your config: { "plugins": ["${outDir}"] }\n`,
  );
  process.exit(0);
}

// Handle init subcommand — one-command setup: install extension + write CLAUDE.md + print next steps
if (process.argv[2] === "init") {
  const argv = process.argv.slice(3);

  // Handle init --help
  if (argv.includes("--help")) {
    console.log(`claude-ide-bridge init — One-command setup

Usage: claude-ide-bridge init [options]

Options:
  --workspace <path>  Target workspace folder (default: cwd)
  --help              Show this help

Steps performed:
  1. Install the companion VS Code extension
  2. Write bridge section to CLAUDE.md
  3. Write .claude/rules/bridge-tools.md
  4. Register MCP shim in ~/.claude.json
  5. Wire CC automation hooks in ~/.claude/settings.json
  6. Verify claude-ide-bridge is on PATH
  7. Print next steps`);
    process.exit(0);
  }

  const workspaceIdx = argv.indexOf("--workspace");
  const workspace =
    workspaceIdx !== -1 && argv[workspaceIdx + 1]
      ? path.resolve(argv[workspaceIdx + 1] as string)
      : process.cwd();

  process.stderr.write("Claude IDE Bridge — setup\n\n");

  // WSL detection: warn early if running in WSL without a detected editor
  const isWsl =
    process.platform === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined ||
      process.env.WSLENV !== undefined ||
      (() => {
        try {
          return readFileSync("/proc/version", "utf-8")
            .toLowerCase()
            .includes("microsoft");
        } catch {
          return false;
        }
      })());

  // Step 1: Install extension
  const editor = findEditor();
  if (!editor) {
    const wslHint = isWsl
      ? "\n         WSL detected: ensure VS Code is installed on the Windows host and\n" +
        "         the Remote - WSL extension is active. Then re-run init.\n" +
        "         Alternatively, pass the editor explicitly: claude-ide-bridge install-extension code\n"
      : "";
    process.stderr.write(
      `  [skip] Extension install — no supported editor found on PATH.\n         Install manually: https://open-vsx.org/extension/${OPEN_VSX_PUBLISHER}/${OPEN_VSX_NAME}\n${wslHint}\n`,
    );
  } else {
    process.stderr.write(`  Installing extension into ${editor}...\n`);
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const vsixDir = path.resolve(__dirname2, "..", "vscode-extension");
    let localVsix2: string | undefined;
    if (existsSync(vsixDir)) {
      const vsixFiles = readdirSync(vsixDir)
        .filter((f) => f.endsWith(".vsix"))
        .sort()
        .reverse();
      if (vsixFiles.length > 0)
        localVsix2 = path.join(vsixDir, vsixFiles[0] as string);
    }
    let tmpVsix2: string | undefined;
    let extensionArg2: string | undefined;
    if (localVsix2) {
      extensionArg2 = localVsix2;
    } else {
      try {
        tmpVsix2 = await downloadVsixFromOpenVsx();
        extensionArg2 = tmpVsix2;
      } catch {
        // Download failed — warn but don't abort init
      }
    }
    if (extensionArg2) {
      try {
        execFileSync(editor, ["--install-extension", extensionArg2], {
          stdio: "pipe",
          timeout: 30000,
        });
        process.stderr.write(`  ✓ Extension installed via ${editor}\n\n`);
      } catch {
        process.stderr.write(
          `  [warn] Extension install failed — download manually from:\n         https://open-vsx.org/extension/${OPEN_VSX_PUBLISHER}/${OPEN_VSX_NAME}\n\n`,
        );
      } finally {
        if (tmpVsix2) {
          try {
            unlinkSync(tmpVsix2);
          } catch {
            /* best effort */
          }
        }
      }
    } else {
      process.stderr.write(
        `  [warn] Could not download extension — install manually from:\n         https://open-vsx.org/extension/${OPEN_VSX_PUBLISHER}/${OPEN_VSX_NAME}\n\n`,
      );
    }
  }

  // Step 2: Write CLAUDE.md
  const templatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "CLAUDE.bridge.md",
  );
  if (!existsSync(templatePath)) {
    process.stderr.write(
      "  [skip] CLAUDE.md — template not found. Run gen-claude-md manually.\n\n",
    );
  } else {
    const content = readFileSync(templatePath, "utf-8");
    const targetPath = path.join(workspace, "CLAUDE.md");
    const marker = "## Claude IDE Bridge";
    const importLine = "@import .claude/rules/bridge-tools.md";
    // Capture old version before patching so we can show "v1.2 → v1.3" in the message.
    const prevBlockVersion = existsSync(targetPath)
      ? extractClaudeMdBlockVersion(readFileSync(targetPath, "utf-8"))
      : null;
    const initPatchResult = patchClaudeMdImport(targetPath, marker, importLine);
    if (initPatchResult === "already-current") {
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge block already up to date (v${PACKAGE_VERSION})\n\n`,
      );
    } else if (initPatchResult === "updated") {
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge block updated${prevBlockVersion ? ` v${prevBlockVersion} →` : ""} v${PACKAGE_VERSION}\n\n`,
      );
    } else if (initPatchResult === "patched") {
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge section patched and stamped v${PACKAGE_VERSION}\n\n`,
      );
    } else if (initPatchResult === "already-present") {
      process.stderr.write(
        "  ✓ CLAUDE.md — bridge section already present\n\n",
      );
    } else {
      // no-section: append or create with versioned block
      mkdirSync(workspace, { recursive: true });
      const existing = existsSync(targetPath)
        ? readFileSync(targetPath, "utf-8")
        : null;
      // Wrap the template content in a versioned block before inserting
      const versionedContent = content
        .trimEnd()
        .replace(
          marker,
          `<!-- claude-ide-bridge:start:${PACKAGE_VERSION} -->\n${marker}`,
        )
        .concat(`\n<!-- claude-ide-bridge:end -->`);
      const updated =
        existing !== null
          ? `${existing.trimEnd()}\n\n${versionedContent}\n`
          : `${versionedContent}\n`;
      const tmpPath = `${targetPath}.tmp`;
      writeFileSync(tmpPath, updated, { encoding: "utf-8", flag: "wx" });
      if (existing !== null) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          renameSync(targetPath, `${targetPath}.${ts}.bak`);
          renameSync(tmpPath, targetPath);
        } catch (err) {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* best-effort cleanup */
          }
          throw err;
        }
      } else {
        renameSync(tmpPath, targetPath);
      }
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge section written to ${targetPath} (v${PACKAGE_VERSION})\n\n`,
      );
    }
  }

  // Step 2b: Write bridge-tools rules file to .claude/rules/bridge-tools.md
  const rulesDir = path.join(workspace, ".claude", "rules");
  const rulesFilePath = path.join(rulesDir, "bridge-tools.md");
  const bridgeToolsTemplatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "bridge-tools.md",
  );
  if (isBridgeToolsFileValid(rulesFilePath)) {
    process.stderr.write(
      `  ✓ Bridge rules — already up to date (v${PACKAGE_VERSION}) at ${rulesFilePath}\n\n`,
    );
  } else if (existsSync(bridgeToolsTemplatePath)) {
    const repairing = existsSync(rulesFilePath);
    try {
      mkdirSync(rulesDir, { recursive: true });
      writeRulesFileAtomic(
        rulesFilePath,
        readFileSync(bridgeToolsTemplatePath, "utf-8").replace(
          "{{VERSION}}",
          PACKAGE_VERSION,
        ),
      );
      process.stderr.write(
        repairing
          ? `  ✓ Bridge rules — updated to v${PACKAGE_VERSION} at ${rulesFilePath}\n\n`
          : `  ✓ Bridge rules — written (v${PACKAGE_VERSION}) to ${rulesFilePath}\n\n`,
      );
    } catch (err) {
      const exitCode = handleRulesWriteError(err, rulesFilePath, "  ");
      if (exitCode !== 0) process.exit(exitCode);
    }
  } else {
    process.stderr.write(`  [skip] Bridge rules — template not found\n\n`);
  }

  // Step 3: Register shim in ~/.claude.json so bridge tools appear in every claude session.
  // NOTE: ~/.claude.json is a FILE sitting next to the ~/.claude/ directory, with the same
  // dotted prefix. Earlier versions computed `path.join(CONFIG_DIR, "..", "claude.json")`
  // which dropped the leading dot and wrote to ~/claude.json — a ghost file that Claude
  // Code never reads. Append ".json" to the config dir path instead.
  const claudeDirForJson =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const claudeJsonAbs = path.resolve(`${claudeDirForJson}.json`);
  try {
    let claudeJson: Record<string, unknown> = {};
    if (existsSync(claudeJsonAbs)) {
      claudeJson = JSON.parse(readFileSync(claudeJsonAbs, "utf-8")) as Record<
        string,
        unknown
      >;
    }
    const mcpServers = (claudeJson.mcpServers ?? {}) as Record<string, unknown>;
    if (mcpServers["claude-ide-bridge"]) {
      process.stderr.write(
        `  ✓ MCP shim — already registered in ${claudeJsonAbs}\n\n`,
      );
    } else {
      mcpServers["claude-ide-bridge"] = {
        command: "claude-ide-bridge",
        args: ["shim"],
        type: "stdio",
      };
      claudeJson.mcpServers = mcpServers;
      writeFileSync(claudeJsonAbs, `${JSON.stringify(claudeJson, null, 2)}\n`);
      process.stderr.write(
        `  ✓ MCP shim — registered in ${claudeJsonAbs}\n     Note: bridge tools are wired via ~/.claude.json (global), not .mcp.json.\n     This is intentional — when VS Code/Windsurf/Cursor launches Claude Code it\n     injects --mcp-config which overrides any project .mcp.json. Only ~/.claude.json\n     is always loaded. You do not need to add anything to .mcp.json.\n\n`,
      );
    }
  } catch {
    process.stderr.write(
      `  [warn] Could not update ${claudeJsonAbs} — add manually:\n         { "mcpServers": { "claude-ide-bridge": { "command": "claude-ide-bridge", "args": ["shim"] } } }\n\n`,
    );
  }

  // Step 3b: Wire CC hooks in ~/.claude/settings.json
  const ccSettingsPath = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "settings.json",
  );
  const CC_HOOK_NOTIFY_CMDS: Record<string, string> = {
    PreCompact: "claude-ide-bridge notify PreCompact",
    PostCompact: "claude-ide-bridge notify PostCompact",
    InstructionsLoaded: "claude-ide-bridge notify InstructionsLoaded",
    TaskCreated:
      "claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT",
    PermissionDenied:
      "claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON",
    CwdChanged: "claude-ide-bridge notify CwdChanged --cwd $CWD",
  };
  try {
    let ccSettings: Record<string, unknown> = {};
    if (existsSync(ccSettingsPath)) {
      ccSettings = JSON.parse(readFileSync(ccSettingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    }
    type FlatHook = { type?: string; command?: string };
    type NestedHook = { matcher?: string; hooks?: FlatHook[] };
    type HookEntry = NestedHook | FlatHook;
    const ccHooks = (ccSettings.hooks ?? {}) as Record<string, HookEntry[]>;
    const isNested = (e: HookEntry): e is NestedHook =>
      !!e && Array.isArray((e as NestedHook).hooks);
    const normalize = (e: HookEntry): NestedHook =>
      isNested(e)
        ? { matcher: e.matcher ?? "", hooks: e.hooks ?? [] }
        : { matcher: "", hooks: [e as FlatHook] };
    const added: string[] = [];
    const migrated: string[] = [];
    for (const [ccEvent, cmd] of Object.entries(CC_HOOK_NOTIFY_CMDS)) {
      const rawEntries = ccHooks[ccEvent] ?? [];
      const hadLegacy = rawEntries.some((e) => !isNested(e));
      const normalized: NestedHook[] = rawEntries.map(normalize);
      const alreadyWired = normalized.some((entry) =>
        (entry.hooks ?? []).some(
          (h) =>
            typeof h.command === "string" &&
            (h.command.includes(cmd) ||
              h.command.includes(`notify ${ccEvent}`)),
        ),
      );
      if (!alreadyWired) {
        normalized.push({
          matcher: "",
          hooks: [{ type: "command", command: cmd }],
        });
        added.push(ccEvent);
      }
      if (!alreadyWired || hadLegacy) {
        ccHooks[ccEvent] = normalized;
        if (hadLegacy) migrated.push(ccEvent);
      }
    }
    if (added.length > 0 || migrated.length > 0) {
      ccSettings.hooks = ccHooks;
      writeFileSync(ccSettingsPath, `${JSON.stringify(ccSettings, null, 2)}\n`);
      const addMsg =
        added.length > 0
          ? `  ✓ CC hooks — wired ${added.length} automation hook(s) in ${ccSettingsPath}\n     Added: ${added.join(", ")}\n`
          : "";
      const migMsg =
        migrated.length > 0
          ? `  ✓ CC hooks — migrated ${migrated.length} legacy entrie(s) to matcher+hooks format\n     Migrated: ${migrated.join(", ")}\n`
          : "";
      process.stderr.write(`${addMsg}${migMsg}\n`);
    } else {
      process.stderr.write(
        `  ✓ CC hooks — already wired in ${ccSettingsPath}\n\n`,
      );
    }
  } catch {
    process.stderr.write(
      `  [warn] Could not update ${ccSettingsPath} — add CC hook entries manually.\n` +
        `         See CLAUDE.md Automation Policy section for the settings.json snippet.\n\n`,
    );
  }

  // Patchwork: register PreToolUse approval hook so the dashboard can
  // approve/reject CC tool calls in real time.
  try {
    const { registerPreToolUseHook } = await import("./preToolUseHook.js");
    const result = registerPreToolUseHook(ccSettingsPath);
    if (result.action === "added") {
      process.stderr.write(
        `  ✓ Patchwork PreToolUse hook — registered\n     ${result.hookCommand}\n\n`,
      );
    } else if (result.action === "already-wired") {
      process.stderr.write(
        `  ✓ Patchwork PreToolUse hook — already registered\n\n`,
      );
    } else {
      process.stderr.write(
        `  [warn] Patchwork PreToolUse hook — could not register: ${result.error}\n\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `  [warn] Patchwork PreToolUse hook — ${err instanceof Error ? err.message : String(err)}\n\n`,
    );
  }

  // Step 4: Verify shim can be found on PATH
  let shimOnPath = false;
  try {
    execFileSync("claude-ide-bridge", ["--version"], {
      stdio: "pipe",
      timeout: 5000,
    });
    shimOnPath = true;
  } catch {
    // not on PATH or version flag not supported — non-fatal
    shimOnPath = existsSync(
      path.resolve(__dirnameTop, "..", "scripts", "mcp-stdio-shim.cjs"),
    );
  }

  if (!shimOnPath) {
    process.stderr.write(
      "  [warn] claude-ide-bridge not found on PATH.\n" +
        "         If you installed locally, ensure your npm global bin is in PATH:\n" +
        "           npm config get prefix  # add <prefix>/bin to PATH\n\n",
    );
  } else {
    process.stderr.write("  ✓ Shim — claude-ide-bridge found on PATH\n\n");
  }

  // Step 5: Success message + next steps
  // Check if the workspace is a linked git worktree — surface Cowork gotcha if so.
  // (In main worktree .git is a dir; in a linked worktree it is a file.)
  let inWorktree = false;
  try {
    inWorktree = statSync(path.join(workspace, ".git")).isFile();
  } catch {
    /* no .git at workspace — not a git repo, fine */
  }

  process.stdout.write(
    "\n✅ Setup complete.\n\n" +
      "Next steps:\n" +
      `  1. Start the bridge:    claude-ide-bridge --watch   (runs in this workspace)\n` +
      "  2. Restart your IDE once so it picks up the new extension + MCP config.\n" +
      "  3. Open Claude Code and type /mcp — the claude-ide-bridge server should show as connected.\n" +
      "  4. Type /ide to see live workspace state (open editors, diagnostics, git status).\n\n",
  );

  if (inWorktree) {
    process.stdout.write(
      "⚠ This workspace is a linked git worktree. If this is a Cowork session,\n" +
        "  bridge MCP tools are unreachable from inside Cowork itself — run\n" +
        "  /mcp__bridge__cowork in regular Claude Code/Desktop chat FIRST to\n" +
        "  gather context, then switch to Cowork. See docs/cowork.md.\n\n",
    );
  }

  // Step 6: Verify setup
  process.stdout.write("📋 Setup verification:\n");
  process.stdout.write(
    shimOnPath
      ? "  ✓ bridge on PATH\n"
      : '  ✗ bridge not on PATH — add npm global bin to your PATH (e.g. export PATH="$(npm bin -g):$PATH")\n',
  );

  let mcpWired = false;
  try {
    const claudeJsonPath = path.join(os.homedir(), ".claude.json");
    const cj = JSON.parse(readFileSync(claudeJsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
    mcpWired = !!(
      cj?.mcpServers &&
      typeof cj.mcpServers === "object" &&
      (cj.mcpServers as Record<string, unknown>)["claude-ide-bridge"]
    );
  } catch {
    /* file may not exist yet — non-fatal */
  }
  process.stdout.write(
    mcpWired
      ? "  ✓ MCP shim registered in ~/.claude.json\n"
      : "  ✗ MCP shim not found in ~/.claude.json — re-run init or check Step 3 output above\n",
  );

  let hooksWired = false;
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const sj = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const hooksObj = sj?.hooks;
    if (hooksObj && typeof hooksObj === "object") {
      hooksWired = (
        Object.values(hooksObj as Record<string, unknown[]>).flat() as unknown[]
      ).some(
        (e) =>
          typeof (e as Record<string, string | undefined>)?.command ===
            "string" &&
          ((e as Record<string, string>).command ?? "").includes(
            "claude-ide-bridge",
          ),
      );
    }
  } catch {
    /* file may not exist yet — non-fatal */
  }
  process.stdout.write(
    hooksWired
      ? "  ✓ CC hooks wired in ~/.claude/settings.json\n"
      : "  ✗ CC hooks not wired — re-run init to add them\n",
  );

  // Auto-open automation docs when --workspace was provided
  if (workspaceIdx !== -1 && workspace) {
    const docsPath = path.join(workspace, "docs", "automation.md");
    const fallbackDocs = path.resolve(
      __dirnameTop,
      "..",
      "docs",
      "automation.md",
    );
    const target = existsSync(docsPath)
      ? docsPath
      : existsSync(fallbackDocs)
        ? fallbackDocs
        : null;
    if (target) {
      const { exec } = await import("node:child_process");
      exec(`code "${target}"`, { timeout: 3000 }, () => {});
    }
  }

  // Analytics opt-in prompt — only ask once; skip if preference already set
  const existingPref = getAnalyticsPref();
  if (existingPref === null) {
    process.stdout.write("\n");
    process.stdout.write(
      "Optional: send anonymous usage statistics to help prioritize features?\n" +
        "  Tool names, success/error counts, and durations only.\n" +
        "  No file paths, code, error messages, or personal data. Ever.\n" +
        "  Change anytime: claude-ide-bridge --analytics on|off\n\n",
    );
    const answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("Send anonymous usage stats? [y/N]: ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
      // If stdin is not a TTY (e.g. piped), default to no
      if (!process.stdin.isTTY) {
        rl.close();
        resolve("n");
      }
    });
    const opted = answer === "y" || answer === "yes";
    setAnalyticsPref(opted);
    process.stdout.write(
      opted
        ? "  ✓ Analytics enabled — thank you.\n"
        : "  ✓ Analytics disabled — no data will be sent.\n",
    );
  }

  process.exit(0);
}

// Handle shim subcommand — stdio relay that auto-discovers the running bridge/orchestrator.
// Intended use: add to ~/.claude.json mcpServers so bridge tools are available everywhere.
//   { "command": "claude-ide-bridge", "args": ["shim"] }
if (process.argv[2] === "shim") {
  const shimPath = path.resolve(
    __dirnameTop,
    "..",
    "scripts",
    "mcp-stdio-shim.cjs",
  );
  // Pass remaining args (e.g. explicit port + token for testing)
  const shimArgs = [shimPath, ...process.argv.slice(3)];
  const child = spawn(process.execPath, shimArgs, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
  // Forward signals so the shim can clean up
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => child.kill(sig));
  }
  // Prevent fall-through — keep alive until child exits
  await new Promise<never>(() => {});
}

// Handle orchestrator subcommand — starts the meta-bridge that coordinates multiple IDEs
if (process.argv[2] === "orchestrator") {
  const { parseOrchestratorArgs, OrchestratorBridge } = await import(
    "./orchestrator/index.js"
  );
  const orchConfig = parseOrchestratorArgs(process.argv);
  const orch = new OrchestratorBridge(orchConfig);
  await orch.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Orchestrator error: ${message}\n`);
    process.exit(1);
  });
  // Stay alive serving connections — do not fall through to parseConfig
  await new Promise<never>(() => {});
} else if (process.argv[2] === "install-extension") {
  const KNOWN_EDITORS = new Set([
    "code",
    "windsurf",
    "cursor",
    "antigravity",
    "ag",
  ]);
  const editorArg = process.argv[3];
  if (
    editorArg !== undefined &&
    !KNOWN_EDITORS.has(editorArg) &&
    !path.isAbsolute(editorArg)
  ) {
    process.stderr.write(
      `Error: Unknown editor "${editorArg}". Use one of: code, windsurf, cursor, antigravity, ag\n`,
    );
    process.exit(1);
  }
  const editor = process.argv[3] || findEditor();
  if (!editor) {
    process.stderr.write(
      "Error: No editor found. Specify the editor command: claude-ide-bridge install-extension <code|cursor|windsurf>\n",
    );
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const vsixDir = path.resolve(__dirname, "..", "vscode-extension");

  // Prefer a local .vsix (source checkout / dev build). When installed via
  // `npm install -g` there is no vscode-extension/ dir, so download from Open VSX.
  let localVsix: string | undefined;
  if (existsSync(vsixDir)) {
    const vsixFiles = readdirSync(vsixDir)
      .filter((f) => f.endsWith(".vsix"))
      .sort()
      .reverse();
    if (vsixFiles.length > 0)
      localVsix = path.join(vsixDir, vsixFiles[0] as string);
  }

  let tmpVsix: string | undefined;
  let extensionArg: string;
  if (localVsix) {
    extensionArg = localVsix;
  } else {
    try {
      tmpVsix = await downloadVsixFromOpenVsx();
      extensionArg = tmpVsix;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Error downloading extension from Open VSX: ${msg}\n`,
      );
      process.stderr.write(
        `Install manually: download from https://open-vsx.org/extension/${OPEN_VSX_PUBLISHER}/${OPEN_VSX_NAME}\n`,
      );
      process.exit(1);
    }
  }

  try {
    process.stderr.write(`Installing extension via ${editor}...\n`);
    execFileSync(editor, ["--install-extension", extensionArg], {
      stdio: "inherit",
      timeout: 30000,
    });
    process.stderr.write("Extension installed successfully.\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error installing extension: ${message}\n`);
    process.exit(1);
  } finally {
    if (tmpVsix) {
      try {
        unlinkSync(tmpVsix);
      } catch {
        /* best effort */
      }
    }
  }
  process.exit(0);
}

// Handle --analytics on|off subcommand — update stored preference
if (process.argv[2] === "--analytics") {
  const val = process.argv[3];
  if (val !== "on" && val !== "off") {
    process.stderr.write("Usage: claude-ide-bridge --analytics on|off\n");
    process.exit(1);
  }
  setAnalyticsPref(val === "on");
  process.stdout.write(
    `Analytics ${val === "on" ? "enabled" : "disabled"}. Preference saved to ~/.claude/ide/analytics.json\n`,
  );
  process.exit(0);
}

// Handle status subcommand — check bridge health and extension connectivity
if (process.argv[2] === "status") {
  const argv = process.argv.slice(3);

  if (argv.includes("--help")) {
    console.log(`claude-ide-bridge status — Check bridge health

Usage: claude-ide-bridge status [options]

Options:
  --port <number>  Check a specific port (default: most recent lock file)
  --json           Output as JSON
  --help           Show this help`);
    process.exit(0);
  }

  const portIdx = argv.indexOf("--port");
  const portArg = portIdx !== -1 ? argv[portIdx + 1] : undefined;
  const jsonFlag = argv.includes("--json");

  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  let lockFile: string | undefined;
  let lockPort: string | undefined;

  if (portArg) {
    lockFile = path.join(lockDir, `${portArg}.lock`);
    lockPort = portArg;
    if (!existsSync(lockFile)) {
      process.stderr.write(
        `Error: No lock file found for port ${portArg} at ${lockFile}\n`,
      );
      process.exit(1);
    }
  } else {
    let bestMtime = 0;
    try {
      for (const f of readdirSync(lockDir)) {
        if (!f.endsWith(".lock")) continue;
        const full = path.join(lockDir, f);
        const mtime = statSync(full).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          lockFile = full;
          lockPort = f.replace(".lock", "");
        }
      }
    } catch {
      // lock dir doesn't exist
    }
  }

  if (!lockFile) {
    if (jsonFlag) {
      process.stdout.write(`${JSON.stringify({ status: "not_running" })}\n`);
    } else {
      process.stderr.write(`No bridge lock file found in ${lockDir}\n`);
      process.stderr.write(
        "Bridge is not running. Start it with: claude-ide-bridge --watch\n",
      );
    }
    process.exit(1);
  }

  let lockData: {
    pid?: number;
    authToken?: string;
    workspace?: string;
    ideName?: string;
    startedAt?: number;
  };
  try {
    lockData = JSON.parse(readFileSync(lockFile, "utf-8"));
  } catch {
    process.stderr.write(`Error: Could not read lock file ${lockFile}\n`);
    process.exit(1);
  }

  // Check if PID is alive
  let pidAlive = false;
  if (lockData.pid) {
    try {
      process.kill(lockData.pid, 0);
      pidAlive = true;
    } catch {
      // process not running
    }
  }

  if (!pidAlive) {
    if (jsonFlag) {
      process.stdout.write(
        `${JSON.stringify({
          status: "stale_lock",
          port: lockPort,
          pid: lockData.pid,
        })}\n`,
      );
    } else {
      process.stderr.write(
        `Bridge lock file exists (port ${lockPort}) but process ${lockData.pid} is not running.\n`,
      );
      process.stderr.write(
        "The lock file is stale. Restart with: claude-ide-bridge --watch\n",
      );
    }
    process.exit(1);
  }

  // Fetch /health from the running bridge
  const healthUrl = `http://127.0.0.1:${lockPort}/health`;
  try {
    const resp = await fetch(healthUrl, {
      headers: {
        Authorization: `Bearer ${lockData.authToken}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const health = (await resp.json()) as Record<string, unknown>;

    if (jsonFlag) {
      process.stdout.write(
        `${JSON.stringify({
          status: "running",
          port: lockPort,
          pid: lockData.pid,
          workspace: lockData.workspace,
          ide: lockData.ideName,
          ...health,
        })}\n`,
      );
    } else {
      const uptimeMs = (health.uptimeMs as number) ?? 0;
      const mins = Math.floor(uptimeMs / 60_000);
      const secs = Math.floor((uptimeMs % 60_000) / 1_000);
      const uptime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      process.stdout.write("Bridge status: running\n");
      process.stdout.write(`  Port:       ${lockPort}\n`);
      process.stdout.write(`  PID:        ${lockData.pid}\n`);
      process.stdout.write(
        `  Workspace:  ${lockData.workspace ?? "unknown"}\n`,
      );
      process.stdout.write(`  IDE:        ${lockData.ideName ?? "unknown"}\n`);
      process.stdout.write(`  Uptime:     ${uptime}\n`);
      process.stdout.write(
        `  Extension:  ${health.extensionConnected === true ? "connected" : health.extensionConnected === false ? "disconnected" : "unknown"}\n`,
      );
      process.stdout.write(`  Sessions:   ${health.connections ?? 0}\n`);
      if (health.toolCount !== undefined) {
        process.stdout.write(`  Tools:      ${health.toolCount}\n`);
      }
    }
  } catch (err) {
    if (jsonFlag) {
      process.stdout.write(
        `${JSON.stringify({
          status: "unreachable",
          port: lockPort,
          pid: lockData.pid,
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    } else {
      process.stderr.write(
        `Bridge process is running (PID ${lockData.pid}) but /health endpoint is unreachable.\n`,
      );
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exit(1);
  }
  process.exit(0);
}

// F6: "Did you mean?" for unknown CLI subcommands
{
  const KNOWN_COMMANDS = [
    "init",
    "start-all",
    "install-extension",
    "gen-claude-md",
    "print-token",
    "gen-plugin-stub",
    "notify",
    "install",
    "marketplace",
    "status",
    "shim",
  ];
  const unknownSub = process.argv[2];
  if (
    unknownSub &&
    !unknownSub.startsWith("-") &&
    !KNOWN_COMMANDS.includes(unknownSub)
  ) {
    const lev = (a: string, b: string): number => {
      const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) =>
          i === 0 ? j : j === 0 ? i : 0,
        ),
      );
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          // biome-ignore lint/style/noNonNullAssertion: dp is fully pre-allocated
          dp[i]![j] =
            a[i - 1] === b[j - 1]
              ? // biome-ignore lint/style/noNonNullAssertion: dp is fully pre-allocated
                dp[i - 1]![j - 1]!
              : 1 +
                // biome-ignore lint/style/noNonNullAssertion: dp is fully pre-allocated
                Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
      // biome-ignore lint/style/noNonNullAssertion: dp is fully pre-allocated
      return dp[a.length]![b.length]!;
    };
    const closest = [...KNOWN_COMMANDS].sort(
      (a, b) => lev(unknownSub, a) - lev(unknownSub, b),
    )[0];
    console.error(
      `Unknown command: '${unknownSub}'. Did you mean: ${closest}?`,
    );
    process.exit(1);
  }
}

const config = parseConfig(process.argv);

// Patchwork: resolve --model flag (optional, non-invasive) — stashes the
// configured adapter on globalThis for consumers that opt into the adapter
// layer. Bridge subprocess driver still works when --model is absent.
try {
  const { resolveModel } = await import("./patchworkCli.js");
  const resolved = resolveModel(process.argv);
  if (resolved) {
    (globalThis as { __patchworkAdapter?: unknown }).__patchworkAdapter =
      resolved.adapter;
    process.stderr.write(
      `[patchwork] model adapter initialized: ${resolved.adapter.name}\n`,
    );
  }
} catch (err) {
  process.stderr.write(
    `[patchwork] adapter init failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

// If --analytics flag was passed, persist the preference immediately
if (config.analyticsEnabled !== null) {
  setAnalyticsPref(config.analyticsEnabled);
}

// Auto-tmux: if requested and not already inside tmux or screen, re-exec inside a tmux session
if (
  config.autoTmux &&
  !process.env.TMUX &&
  !process.env.STY &&
  !process.env.ZELLIJ &&
  !process.env.ZELLIJ_SESSION_NAME
) {
  const ws = config.workspace.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  const hash = crypto
    .createHash("sha256")
    .update(config.workspace)
    .digest("hex")
    .slice(0, 6);
  const sessionName = `claude-bridge-${ws}${hash}`;

  // Check if tmux is available
  const tmuxCheck = spawnSync("which", ["tmux"], { stdio: "ignore" });
  if (tmuxCheck.status !== 0) {
    process.stderr.write(
      "WARNING: --auto-tmux requested but tmux is not installed. Running without tmux.\n",
    );
  } else {
    // Strip --auto-tmux from argv to avoid infinite re-exec loop
    const newArgv = process.argv.filter((a) => a !== "--auto-tmux");
    // Pass each argv token as a separate tmux argument so paths with spaces work correctly
    const result = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", sessionName, ...newArgv],
      { stdio: "inherit", timeout: 5000 },
    );

    if (result.status === 0) {
      process.stderr.write(
        `Bridge launched in tmux session '${sessionName}'.\n`,
      );
      process.stderr.write(`  Attach with: tmux attach -t ${sessionName}\n`);
      process.exit(0);
    } else {
      // tmux session likely already exists — attach to it or fall through
      process.stderr.write(
        `WARNING: Could not create tmux session '${sessionName}' (already exists?). Running without auto-tmux.\n`,
      );
    }
  }
}

// --watch: supervisor mode — spawn this binary as a child (without --watch) and restart on crash
if (config.watch) {
  const childArgv = process.argv.filter((a) => a !== "--watch");
  const STABLE_THRESHOLD_MS = 60_000;
  const BASE_DELAY_MS = 2_000;
  const MAX_DELAY_MS = 30_000;
  let delay = BASE_DELAY_MS;
  let stopping = false;

  function runChild(): void {
    if (stopping) return;
    const startAt = Date.now();
    process.stderr.write("[supervisor] starting bridge\n");
    const [cmd, ...args] = childArgv;
    if (!cmd) return;
    const child = spawn(cmd, args, {
      stdio: "inherit",
    });

    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        stopping = true;
        child.kill(sig);
      });
    }

    child.on("exit", (code, signal) => {
      if (stopping) {
        process.stderr.write("[supervisor] bridge stopped\n");
        process.exit(0);
      }
      const uptime = Date.now() - startAt;
      if (uptime >= STABLE_THRESHOLD_MS) {
        delay = BASE_DELAY_MS; // reset backoff after a stable run
      }
      process.stderr.write(
        `[supervisor] bridge exited (code=${code ?? signal}), restarting in ${delay / 1000}s\n`,
      );
      setTimeout(() => {
        delay = Math.min(delay * 2, MAX_DELAY_MS);
        runChild();
      }, delay);
    });
  }

  runChild();
} else {
  const bridge = new Bridge(config);

  bridge.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });

  // F5: Silent self-update nudge (fire-and-forget)
  import("node:child_process")
    .then(({ exec }) => {
      exec(
        "npm view claude-ide-bridge version",
        { timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout) return;
          const latest = stdout.trim();
          if (latest && semverGt(latest, PACKAGE_VERSION)) {
            console.log(
              `\n  Bridge v${latest} available — run: npm update -g claude-ide-bridge\n`,
            );
          }
        },
      );
    })
    .catch(() => {});
}
