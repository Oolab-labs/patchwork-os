#!/usr/bin/env node

// Load .env from repo root if present (connector credentials, etc.).
// Uses Node 20.6+ native dotenv loader; falls back to manual parse for older Node.
{
  const { fileURLToPath: _fileURLToPath } = await import("node:url");
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    // Try both "../.env" (compiled dist/) and ".env" (tsx src/ dev run)
    const candidates = [
      _fileURLToPath(new URL("../.env", import.meta.url)),
      _fileURLToPath(new URL(".env", import.meta.url)),
    ];
    const envPath = candidates.find(existsSync);
    if (envPath) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m?.[1] && !process.env[m[1]]) {
          process.env[m[1]] = m[2]?.replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    /* non-fatal */
  }
}

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
import {
  detectWorkspaceSymlinkInstall,
  PATCHWORK_PACKAGE_NAME,
  SYMLINK_INSTALL_FIX,
} from "./installGuard.js";
import { PACKAGE_VERSION, semverGt } from "./version.js";

const __dirnameTop = path.dirname(fileURLToPath(import.meta.url));

// Warn when a symlinked global install is detected (`npm install -g .`).
// launchctl / sandbox environments can fail through that link with EPERM.
// Warn only — do not crash interactive or dev flows.
{
  const _symlinkInfo = detectWorkspaceSymlinkInstall();
  if (_symlinkInfo) {
    process.stderr.write(
      `\n⚠️  Detected a symlinked global ${PATCHWORK_PACKAGE_NAME} install.\n` +
        `   Logical root: ${_symlinkInfo.logicalRoot}\n` +
        `   Real path:    ${_symlinkInfo.realRoot}\n\n` +
        "   LaunchAgent startup can fail with EPERM when the macOS sandbox\n" +
        "   cannot access workspace files under ~/Documents through that link.\n\n" +
        SYMLINK_INSTALL_FIX +
        "\n",
    );
  }
}

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

// Closes the race where bridge.start() began initialising in parallel with
// a subcommand's async work — observed in the 2026-04-29 dogfood pass
// where `recipe install` errors interleaved with bridge "Tools: full"
// startup logs.
//
// Every subcommand `if`-block below dispatches via an `(async () => {...})()`
// IIFE that ends with `process.exit`. The IIFE invocation returns
// synchronously, so without this gate, control immediately falls through
// to the bridge.start() block at end-of-file and starts initialising
// alongside the subcommand's async work. process.exit fires *eventually*
// after the await chain, but the bridge has already begun in parallel.
// Two IIFEs (patchwork no-args dashboard, recipe watch) lack process.exit
// entirely — without this gate they would run alongside the bridge
// indefinitely.
//
// Single source of truth for "is this argv invoking a subcommand?" — the
// same list is also used by the unknown-command suggester at L2570.
const KNOWN_SUBCOMMANDS = [
  "init",
  "patchwork-init",
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
  "recipe",
  "dashboard",
  "launchd",
] as const;

const __invokedSubcommand = (() => {
  const sub = process.argv[2];
  if (!sub || sub.startsWith("-")) return null;
  // Treat KNOWN_SUBCOMMANDS as the dispatch source. The bare-binary
  // dashboard launcher (no argv) is handled separately below.
  return KNOWN_SUBCOMMANDS.includes(sub as (typeof KNOWN_SUBCOMMANDS)[number])
    ? sub
    : null;
})();

const __invokedBareBinaryDashboard = (() => {
  if (process.argv[2]) return false;
  const binName = path.basename(process.argv[1] ?? "");
  return (
    binName === "patchwork-os" ||
    binName === "patchwork" ||
    binName === "patchwork.js"
  );
})();

const __subcommandWillRun =
  __invokedSubcommand !== null || __invokedBareBinaryDashboard;

// Handle --version flag — print package version and exit.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  console.log(`claude-ide-bridge ${PACKAGE_VERSION}`);
  process.exit(0);
}

// Handle patchwork-init subcommand — T2 from docs/install-ux-plan.md.
// Separate from the bridge-only `init` to preserve back-compat. See ADR-0008.
if (process.argv[2] === "patchwork-init") {
  const { runPatchworkInit } = await import("./commands/patchworkInit.js");
  await runPatchworkInit(process.argv.slice(3));
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

// Patchwork: `patchwork recipe list` — enumerate installed recipes.
if (process.argv[2] === "recipe" && process.argv[3] === "list") {
  (async () => {
    const { listInstalledRecipes, printInstalledList } = await import(
      "./commands/recipeInstall.js"
    );
    const entries = listInstalledRecipes();
    printInstalledList(entries);
    process.exit(0);
  })();
}

// Patchwork: `patchwork recipe enable <name>` / `recipe disable <name>` —
// flip the disabled marker so scheduled triggers (cron/file-watch) take
// effect (or stop). Manual `recipe run` is unaffected.
if (
  process.argv[2] === "recipe" &&
  (process.argv[3] === "enable" || process.argv[3] === "disable")
) {
  const subcommand = process.argv[3];
  const name = process.argv[4];
  if (!name) {
    process.stderr.write(
      `Usage: patchwork recipe ${subcommand} <name>\n` +
        `  See \`patchwork recipe list\` for installed recipe names.\n`,
    );
    process.exit(1);
  }
  (async () => {
    try {
      const { runRecipeEnable, runRecipeDisable } = await import(
        "./commands/recipeInstall.js"
      );
      if (subcommand === "enable") {
        const r = runRecipeEnable(name);
        process.stdout.write(
          r.alreadyEnabled
            ? `  ℹ ${r.name} is already enabled\n`
            : `  ✓ enabled ${r.name}\n`,
        );
      } else {
        const r = runRecipeDisable(name);
        process.stdout.write(
          r.alreadyDisabled
            ? `  ℹ ${r.name} is already disabled\n`
            : `  ✓ disabled ${r.name}\n`,
        );
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe uninstall <name>` — remove an installed recipe
// directory and all its files. Sister to `recipe install`. Idempotent on
// success (subsequent uninstalls error with "no installed recipe").
if (process.argv[2] === "recipe" && process.argv[3] === "uninstall") {
  const name = process.argv[4];
  if (!name) {
    process.stderr.write(
      "Usage: patchwork recipe uninstall <name>\n" +
        "  See `patchwork recipe list` for installed recipe names.\n",
    );
    process.exit(1);
  }
  (async () => {
    try {
      const { runRecipeUninstall } = await import(
        "./commands/recipeInstall.js"
      );
      const r = runRecipeUninstall(name);
      if (!r.ok) {
        process.stderr.write(`Error: ${r.error}\n`);
        process.exit(1);
      }
      process.stdout.write(`  ✓ Uninstalled ${name} (${r.installDir})\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe run <name>` — runs a recipe locally or via
// a running bridge's /recipes/run endpoint if one is available.
if (process.argv[2] === "recipe" && process.argv[3] === "run") {
  const args = process.argv.slice(4);
  const usage =
    "Usage: patchwork recipe run <name-or-file> [--local] [--dry-run] [--step <id>] [--var KEY=VALUE]\n";
  let localFlag = false;
  let dryRun = false;
  let recipeRef: string | undefined;
  let step: string | undefined;
  const vars: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    const currentArg = arg;
    if (currentArg === "--local") {
      localFlag = true;
      continue;
    }

    if (currentArg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (currentArg === "--step" || currentArg.startsWith("--step=")) {
      const value =
        currentArg === "--step"
          ? args[++i]
          : currentArg.slice("--step=".length);
      if (!value) {
        process.stderr.write(`Error: --step requires a value\n${usage}`);
        process.exit(1);
      }
      step = value;
      continue;
    }

    if (currentArg === "--var" || currentArg.startsWith("--var=")) {
      const assignment =
        currentArg === "--var" ? args[++i] : currentArg.slice("--var=".length);
      if (!assignment) {
        process.stderr.write(`Error: --var requires KEY=VALUE\n${usage}`);
        process.exit(1);
      }
      const eqIndex = assignment.indexOf("=");
      if (eqIndex <= 0) {
        process.stderr.write(
          `Error: invalid --var assignment "${assignment}" (expected KEY=VALUE)\n${usage}`,
        );
        process.exit(1);
      }
      const key = assignment.slice(0, eqIndex);
      const value = assignment.slice(eqIndex + 1);
      vars[key] = value;
      continue;
    }

    if (currentArg.startsWith("--")) {
      process.stderr.write(`Error: unknown option ${currentArg}\n${usage}`);
      process.exit(1);
    }

    if (!recipeRef) {
      recipeRef = currentArg;
      continue;
    }

    process.stderr.write(`Error: unexpected argument ${currentArg}\n${usage}`);
    process.exit(1);
  }

  if (!recipeRef) {
    process.stderr.write(usage);
    process.exit(1);
  }
  const recipeArg = recipeRef;
  (async () => {
    try {
      const seedVars = Object.keys(vars).length > 0 ? vars : undefined;
      const explicitFile = (() => {
        try {
          const resolved = path.resolve(recipeArg);
          return existsSync(resolved) && statSync(resolved).isFile();
        } catch {
          return false;
        }
      })();
      const { findBridgeLock } = await import("./bridgeLockDiscovery.js");
      const lock = localFlag ? null : findBridgeLock();
      if (lock && !dryRun && !step && !explicitFile) {
        const res = await fetch(`http://127.0.0.1:${lock.port}/recipes/run`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lock.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: recipeArg,
            ...(seedVars ? { vars: seedVars } : {}),
          }),
        });
        const body = (await res.json()) as {
          ok: boolean;
          taskId?: string;
          error?: string;
        };
        if (!body.ok) {
          // Fall through to local YAML runner if bridge doesn't know the recipe.
          if (!(body.error ?? "").includes("not found")) {
            process.stderr.write(`Error: ${body.error ?? "unknown"}\n`);
            process.exit(1);
            return;
          }
          // else: fall through to local runner below
        } else {
          process.stdout.write(
            `  ✓ enqueued recipe "${recipeArg}" as task ${(body.taskId ?? "").slice(0, 8)}\n` +
              "    Watch progress on the dashboard Tasks page or via listClaudeTasks.\n",
          );
          process.exit(0);
          return;
        }
      }

      const {
        runRecipe,
        runRecipeDryPlan,
        summarizeRecipeExecution,
        formatRunReport,
        extractRunLogStepResults,
      } = await import("./commands/recipe.js");
      if (dryRun) {
        const plan = await runRecipeDryPlan(recipeArg, {
          ...(step ? { step } : {}),
          ...(seedVars ? { vars: seedVars } : {}),
        });
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        process.exit(0);
        return;
      }
      process.stdout.write(
        step
          ? `  Running step "${step}" from recipe "${recipeArg}" locally…\n`
          : `  Running recipe "${recipeArg}" locally…\n`,
      );
      const workdir = lock?.workspace || process.cwd();
      const run = await runRecipe(recipeArg, {
        ...(step ? { step } : {}),
        ...(seedVars ? { vars: seedVars } : {}),
        workdir,
      });
      if (run.stepSelection) {
        process.stdout.write(
          `  Selected step via ${run.stepSelection.matchedBy}: ${run.stepSelection.matchedValue}\n`,
        );
      }
      const summary = summarizeRecipeExecution(run.result);
      process.stdout.write(`${formatRunReport(run.result, run.recipe.name)}\n`);
      if (summary.errorMessage) {
        process.stderr.write(`  Error: ${summary.errorMessage}\n`);
      }

      // Append to run log so CLI runs appear in ctxQueryTraces + dashboard /runs
      try {
        const { RecipeRunLog } = await import("./runLog.js");
        const runLog = new RecipeRunLog({
          dir: path.join(os.homedir(), ".patchwork"),
        });
        const startedAt = Date.now();
        const stepResultsForLog = extractRunLogStepResults(run.result);
        runLog.appendDirect({
          taskId: `cli-${Date.now()}`,
          recipeName: run.recipe.name,
          trigger: "recipe",
          status: summary.ok ? "done" : "error",
          createdAt: startedAt,
          startedAt,
          doneAt: Date.now(),
          durationMs: 0,
          ...(summary.errorMessage
            ? { errorMessage: summary.errorMessage }
            : {}),
          ...(stepResultsForLog ? { stepResults: stepResultsForLog } : {}),
        });
      } catch {
        // Non-fatal — run log write failure must not abort the CLI
      }

      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Handle init subcommand — one-command setup: install extension + write CLAUDE.md + print next steps
// Patchwork: `patchwork recipe install <source>` subcommand.
// Supports: github:owner/repo, github:owner/repo/subdir, https://github.com/owner/repo,
//           ./local/path, or legacy <file.json> (single-recipe install).
if (process.argv[2] === "recipe" && process.argv[3] === "install") {
  const source = process.argv[4];
  if (!source) {
    process.stderr.write(
      "Usage: patchwork recipe install <source>\n" +
        "  <source> can be:\n" +
        "    github:owner/repo\n" +
        "    github:owner/repo/subdir\n" +
        "    https://github.com/owner/repo\n" +
        "    ./local/path\n",
    );
    process.exit(1);
  }
  (async () => {
    try {
      // Legacy path: bare .json file argument → single-file installer
      if (
        source.endsWith(".json") &&
        !source.startsWith("github:") &&
        !source.startsWith("http")
      ) {
        const { installRecipeFromFile } = await import(
          "./recipes/installer.js"
        );
        const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
        const result = installRecipeFromFile(path.resolve(source), {
          recipesDir,
        });
        process.stdout.write(
          `  ✓ ${result.action} ${result.installedPath}\n` +
            `  ℹ permissions snippet written to ${result.installedPath}.permissions.json\n` +
            `    Review + merge into ~/.claude/settings.json to pre-approve recipe steps.\n`,
        );
      } else {
        // Marketplace install: github:, https://, ./local/
        const { runRecipeInstall, printInstallResult } = await import(
          "./commands/recipeInstall.js"
        );
        const result = await runRecipeInstall(source);
        printInstallResult(result);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe schema [outputDir]` — write generated recipe schemas to disk.
if (process.argv[2] === "recipe" && process.argv[3] === "schema") {
  const outputDir = process.argv[4] ?? path.join(process.cwd(), "schemas");
  (async () => {
    try {
      const { runSchema } = await import("./commands/recipe.js");
      const result = await runSchema(path.resolve(outputDir));
      process.stdout.write(`  ✓ Wrote schemas to ${result.outputDir}\n`);
      for (const file of result.filesWritten) {
        process.stdout.write(`    ${file}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe new <name>` — scaffold a new recipe from template.
if (process.argv[2] === "recipe" && process.argv[3] === "new") {
  const args = process.argv.slice(4);
  const recipeName = args[0];
  if (!recipeName) {
    process.stderr.write(
      "Usage: patchwork recipe new <name> [--template <name>] [--desc <description>] [--out <dir>]\n" +
        "  --out <dir>  Write the recipe to <dir>/<name>.yaml.\n" +
        "               Defaults to ~/.patchwork/recipes/ — pass `--out .` to\n" +
        "               write into the current directory instead.\n",
    );
    process.stderr.write("\nTemplates:\n");
    (async () => {
      const { listTemplates } = await import("./commands/recipe.js");
      for (const t of listTemplates()) {
        process.stderr.write(`  ${t}\n`);
      }
      process.exit(1);
    })();
  } else {
    (async () => {
      try {
        const { runNew } = await import("./commands/recipe.js");
        const templateIdx = args.indexOf("--template");
        const template = templateIdx >= 0 ? args[templateIdx + 1] : undefined;
        const descIdx = args.indexOf("--desc");
        const description =
          (descIdx >= 0 ? args[descIdx + 1] : undefined) ??
          `Recipe: ${recipeName}`;
        const outIdx = args.indexOf("--out");
        const outRaw = outIdx >= 0 ? args[outIdx + 1] : undefined;
        // `--out .` is the common case for "scaffold in cwd" — resolve so
        // the success message shows the absolute path the user can open.
        const outputDir = outRaw ? path.resolve(outRaw) : undefined;

        const result = runNew({
          name: recipeName,
          description,
          ...(template ? { template } : {}),
          ...(outputDir ? { outputDir } : {}),
        });
        process.stdout.write(`  ✓ Created ${result.path}\n`);
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    })();
  }
}

// Patchwork: `patchwork recipe lint <file.yaml>` — validate recipe against schema.
if (process.argv[2] === "recipe" && process.argv[3] === "lint") {
  const file = process.argv[4];
  if (!file) {
    process.stderr.write("Usage: patchwork recipe lint <file.yaml>\n");
    process.exit(1);
  }
  (async () => {
    try {
      const { runLint } = await import("./commands/recipe.js");
      const result = runLint(path.resolve(file));

      for (const issue of result.issues) {
        const prefix = issue.level === "error" ? "✗" : "⚠";
        process.stderr.write(`  ${prefix} ${issue.message}\n`);
      }

      if (result.valid) {
        process.stdout.write(
          `  ✓ Valid recipe (${result.warnings} warnings)\n`,
        );
        process.exit(0);
      } else {
        process.stdout.write(
          `\n  ${result.errors} error(s), ${result.warnings} warning(s)\n`,
        );
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe preflight <file.yaml>` — static policy check (lint + plan + writes + fixtures).
if (process.argv[2] === "recipe" && process.argv[3] === "preflight") {
  const args = process.argv.slice(4);
  const usage =
    "Usage: patchwork recipe preflight <file.yaml> [--json] [--watch] [--require-fixtures] [--no-require-write-ack] [--allow-write <tool-or-ns>]\n";
  let json = false;
  let watchMode = false;
  let requireFixtures = false;
  let requireWriteAck = true;
  const allowWrites: string[] = [];
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--watch") {
      watchMode = true;
      continue;
    }
    if (arg === "--require-fixtures") {
      requireFixtures = true;
      continue;
    }
    if (arg === "--no-require-write-ack") {
      requireWriteAck = false;
      continue;
    }
    if (arg === "--allow-write" || arg.startsWith("--allow-write=")) {
      const value =
        arg === "--allow-write"
          ? args[++i]
          : arg.slice("--allow-write=".length);
      if (!value) {
        process.stderr.write(`Error: --allow-write requires a value\n${usage}`);
        process.exit(1);
      }
      allowWrites.push(value);
      continue;
    }
    if (!arg.startsWith("--")) {
      file = arg;
    }
  }

  if (!file) {
    process.stderr.write(usage);
    process.exit(1);
  }

  const renderResult = (result: {
    ok: boolean;
    recipe: string;
    issues: Array<{
      level: string;
      code: string;
      message: string;
      stepId?: string;
    }>;
    plan: { steps: unknown[] };
  }): void => {
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    for (const issue of result.issues) {
      const prefix = issue.level === "error" ? "✗" : "⚠";
      const where = issue.stepId ? ` [${issue.stepId}]` : "";
      process.stderr.write(
        `  ${prefix} ${issue.code}${where}: ${issue.message}\n`,
      );
    }
    if (result.ok) {
      process.stdout.write(
        `  ✓ Preflight passed for ${result.recipe} (${result.plan.steps.length} steps)\n`,
      );
    } else {
      const errorCount = result.issues.filter(
        (i: { level: string }) => i.level === "error",
      ).length;
      process.stdout.write(`\n  ${errorCount} error(s) — preflight failed\n`);
    }
  };

  (async () => {
    try {
      const { runPreflight, runPreflightWatch } = await import(
        "./commands/recipe.js"
      );
      const resolvedPath = path.resolve(file as string);

      if (watchMode) {
        process.stdout.write(
          `  Watching ${resolvedPath} — preflight on save…\n`,
        );
        const stop = runPreflightWatch({
          recipePath: resolvedPath,
          requireWriteAck,
          requireFixtures,
          allowWrites,
          onResult: (result) => renderResult(result),
          onError: (err) => {
            process.stderr.write(`Error: ${err.message}\n`);
          },
        });
        process.on("SIGINT", () => {
          stop();
          process.exit(0);
        });
        return;
      }

      const result = await runPreflight(resolvedPath, {
        requireWriteAck,
        requireFixtures,
        allowWrites,
      });
      renderResult(result);
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe fmt <file.yaml>` — format/normalize recipe.
if (process.argv[2] === "recipe" && process.argv[3] === "fmt") {
  const args = process.argv.slice(4);
  const check = args.includes("--check");
  const watchMode = args.includes("--watch");
  const file = args.find((arg) => !arg.startsWith("--"));

  if (!file) {
    process.stderr.write(
      "Usage: patchwork recipe fmt <file.yaml> [--check] [--watch]\n",
    );
    process.exit(1);
  }

  const renderResult = (
    result: { changed: boolean },
    filePath: string,
  ): void => {
    if (check) {
      process.stdout.write(
        result.changed
          ? "  ✗ File would be reformatted\n"
          : "  ✓ File is already formatted\n",
      );
    } else {
      process.stdout.write(
        result.changed
          ? `  ✓ Formatted ${filePath}\n`
          : `  ✓ Already formatted ${filePath}\n`,
      );
    }
  };

  (async () => {
    try {
      const { runFmt, runFmtWatch } = await import("./commands/recipe.js");
      const resolvedPath = path.resolve(file);

      if (watchMode) {
        process.stdout.write(`  Watching ${resolvedPath} — fmt on save…\n`);
        const stop = runFmtWatch({
          recipePath: resolvedPath,
          check,
          onResult: (result) => {
            process.stdout.write(
              `\n[${new Date().toLocaleTimeString()}] ${resolvedPath}\n`,
            );
            renderResult(result, resolvedPath);
          },
          onError: (err) => {
            process.stderr.write(`Error: ${err.message}\n`);
          },
        });
        process.on("SIGINT", () => {
          stop();
          process.exit(0);
        });
        return;
      }

      const result = runFmt(resolvedPath, { check });
      renderResult(result, file);
      process.exit(check && result.changed ? 1 : 0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe record <file.yaml>` — execute live and record connector fixtures.
if (process.argv[2] === "recipe" && process.argv[3] === "record") {
  const args = process.argv.slice(4);
  const file = args.find((arg) => !arg.startsWith("--"));
  const fixturesIdx = args.indexOf("--fixtures");
  const fixturesDir = fixturesIdx >= 0 ? args[fixturesIdx + 1] : undefined;

  if (!file) {
    process.stderr.write(
      "Usage: patchwork recipe record <file.yaml> [--fixtures <dir>]\n",
    );
    process.exit(1);
  }

  (async () => {
    try {
      const { runRecord } = await import("./commands/recipe.js");
      const result = await runRecord(path.resolve(file), {
        ...(fixturesDir ? { fixturesDir: path.resolve(fixturesDir) } : {}),
      });

      for (const issue of result.issues) {
        const prefix = issue.level === "error" ? "✗" : "⚠";
        process.stderr.write(`  ${prefix} ${issue.message}\n`);
      }

      if (result.recordedFixtures.length > 0) {
        process.stdout.write(
          `  ℹ Recorded fixture libraries: ${result.recordedFixtures.join(", ")}\n`,
        );
      }

      if (result.valid) {
        process.stdout.write("  ✓ Recipe fixtures recorded\n");
        process.exit(0);
      }

      process.stdout.write(
        `\n  ${result.errors} error(s), ${result.warnings} warning(s)\n`,
      );
      process.exit(1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe test <file.yaml>` — validate fixture coverage for mocked execution.
if (process.argv[2] === "recipe" && process.argv[3] === "test") {
  const args = process.argv.slice(4);
  const file = args.find((arg) => !arg.startsWith("--"));
  const fixturesIdx = args.indexOf("--fixtures");
  const fixturesDir = fixturesIdx >= 0 ? args[fixturesIdx + 1] : undefined;
  const watchMode = args.includes("--watch");

  if (!file) {
    process.stderr.write(
      "Usage: patchwork recipe test <file.yaml> [--fixtures <dir>] [--watch]\n",
    );
    process.exit(1);
  }

  const renderResult = (result: {
    valid: boolean;
    issues: Array<{ level: string; message: string }>;
    errors: number;
    warnings: number;
    requiredFixtures: string[];
    assertionFailures: Array<{ assertion: string; message: string }>;
  }): void => {
    for (const issue of result.issues) {
      const prefix = issue.level === "error" ? "✗" : "⚠";
      process.stderr.write(`  ${prefix} ${issue.message}\n`);
    }
    if (result.requiredFixtures.length > 0) {
      process.stdout.write(
        `  ℹ Required fixtures: ${result.requiredFixtures.join(", ")}\n`,
      );
    }
    if (result.valid) {
      process.stdout.write("  ✓ Test passed\n");
    } else {
      process.stdout.write(
        `\n  ${result.errors} error(s), ${result.warnings} warning(s)\n`,
      );
    }
  };

  (async () => {
    try {
      const { runTest, runTestWatch } = await import("./commands/recipe.js");
      const resolvedPath = path.resolve(file);
      const resolvedFixtures = fixturesDir
        ? path.resolve(fixturesDir)
        : undefined;

      if (watchMode) {
        process.stdout.write(`  Watching ${resolvedPath} — test on save…\n`);
        const stop = runTestWatch({
          recipePath: resolvedPath,
          ...(resolvedFixtures ? { fixturesDir: resolvedFixtures } : {}),
          onResult: (result) => {
            process.stdout.write(
              `\n[${new Date().toLocaleTimeString()}] ${resolvedPath}\n`,
            );
            renderResult(result);
          },
          onError: (err) => {
            process.stderr.write(`Error: ${err.message}\n`);
          },
        });
        process.on("SIGINT", () => {
          stop();
          process.exit(0);
        });
        return;
      }

      const result = await runTest(resolvedPath, {
        ...(resolvedFixtures ? { fixturesDir: resolvedFixtures } : {}),
      });
      renderResult(result);
      process.exit(result.valid ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Patchwork: `patchwork recipe watch <file.yaml>` — watch for changes and validate.
if (process.argv[2] === "recipe" && process.argv[3] === "watch") {
  const file = process.argv[4];
  if (!file) {
    process.stderr.write("Usage: patchwork recipe watch <file.yaml>\n");
    process.exit(1);
  }
  (async () => {
    const { findBridgeLock } = await import("./bridgeLockDiscovery.js");
    const {
      runWatch,
      runLint,
      runWatchedRecipe,
      formatRunReport,
      summarizeRecipeExecution,
      extractRunLogStepResults,
    } = await import("./commands/recipe.js");
    const filePath = path.resolve(file);
    const lock = findBridgeLock();
    const workdir = lock?.workspace || process.cwd();

    const initial = runLint(filePath);
    if (!initial.valid) {
      process.stderr.write("  ✗ Recipe has errors - fix before watching\n");
      for (const issue of initial.issues) {
        process.stderr.write(`    ${issue.level}: ${issue.message}\n`);
      }
    } else {
      process.stdout.write(`  ✓ Watching ${file} for changes...\n`);
    }

    const stop = runWatch({
      recipePath: filePath,
      onChange: async () => {
        process.stdout.write(`\n  Change detected, running...\n`);
        const watched = await runWatchedRecipe(filePath, { workdir });
        if (!watched.lint.valid) {
          process.stderr.write(`  ✗ Invalid (${watched.lint.errors} errors)\n`);
          for (const issue of watched.lint.issues) {
            process.stderr.write(`    ${issue.level}: ${issue.message}\n`);
          }
          return;
        }

        if (watched.run?.stepSelection) {
          process.stdout.write(
            `  Selected step via ${watched.run.stepSelection.matchedBy}: ${watched.run.stepSelection.matchedValue}\n`,
          );
        }

        if (watched.run) {
          process.stdout.write(
            `${formatRunReport(watched.run.result, watched.run.recipe.name)}\n`,
          );
          const summary = summarizeRecipeExecution(watched.run.result);
          if (summary.errorMessage) {
            process.stderr.write(`  Error: ${summary.errorMessage}\n`);
          }

          // Append to run log
          try {
            const { RecipeRunLog } = await import("./runLog.js");
            const runLog = new RecipeRunLog({
              dir: path.join(os.homedir(), ".patchwork"),
            });
            const now = Date.now();
            const stepResultsForLog = extractRunLogStepResults(
              watched.run.result,
            );
            runLog.appendDirect({
              taskId: `watch-${now}`,
              recipeName: watched.run.recipe.name,
              trigger: "recipe",
              status: summary.ok ? "done" : "error",
              createdAt: now,
              startedAt: now,
              doneAt: now,
              durationMs: 0,
              ...(summary.errorMessage
                ? { errorMessage: summary.errorMessage }
                : {}),
              ...(stepResultsForLog ? { stepResults: stepResultsForLog } : {}),
            });
          } catch {
            // non-fatal
          }
        }
      },
      onError: (err: Error) => {
        process.stderr.write(`  Error: ${err.message}\n`);
      },
    });

    process.on("SIGINT", () => {
      process.stdout.write("\n  Stopping watch...\n");
      stop();
      process.exit(0);
    });
  })();
}

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

// Handle launchd subcommand — install/uninstall macOS LaunchAgent for auto-start
if (process.argv[2] === "launchd") {
  const sub = process.argv[3];
  if (sub === "install") {
    const { runLaunchdInstall } = await import("./commands/launchd.js");
    await runLaunchdInstall(process.argv.slice(4));
  } else if (sub === "uninstall") {
    const { runLaunchdUninstall } = await import("./commands/launchd.js");
    await runLaunchdUninstall(process.argv.slice(4));
  } else {
    process.stderr.write("Usage: patchwork-os launchd install|uninstall\n");
    process.exit(1);
  }
  process.exit(0);
}

// F6: "Did you mean?" for unknown CLI subcommands
// Patchwork: no-args → terminal dashboard (when invoked as patchwork-os or patchwork).
{
  const binName = path.basename(process.argv[1] ?? "");
  const isPatchworkBin =
    binName === "patchwork-os" ||
    binName === "patchwork" ||
    binName === "patchwork.js";
  if (isPatchworkBin && !process.argv[2]) {
    (async () => {
      const { runDashboard } = await import("./commands/dashboard.js");
      await runDashboard();
    })();
  }
}

{
  // Reuses the KNOWN_SUBCOMMANDS list from the top of this file as a single
  // source of truth for "what subcommand argv tokens are recognized".
  const unknownSub = process.argv[2];
  if (
    unknownSub &&
    !unknownSub.startsWith("-") &&
    !KNOWN_SUBCOMMANDS.includes(
      unknownSub as (typeof KNOWN_SUBCOMMANDS)[number],
    )
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
    const closest = [...KNOWN_SUBCOMMANDS].sort(
      (a, b) => lev(unknownSub, a) - lev(unknownSub, b),
    )[0];
    console.error(
      `Unknown command: '${unknownSub}'. Did you mean: ${closest}?`,
    );
    process.exit(1);
  }
}

// Skip the bridge-mode tail entirely when a subcommand IIFE will own the
// process. `parseConfig` validates argv against the bridge's known-flag list
// and raises "Unknown option" for subcommand-specific flags (e.g. `recipe
// new --out .`); without this guard that throw kills the process before
// the IIFE's microtask runs. The subcommand handles its own arg parsing.
if (__subcommandWillRun) {
  // Subcommand IIFE is in flight or about to fire; sit tight until it
  // process.exits. Empty body — control naturally falls past end-of-file
  // and Node keeps the process alive on the IIFE's pending microtask.
} else {
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

  // Skip bridge boot when a subcommand IIFE is doing the work — avoids the
  // race where bridge.start() began initialising in parallel with the
  // subcommand's async path. See the KNOWN_SUBCOMMANDS / __subcommandWillRun
  // gate at the top of this file.
  if (__subcommandWillRun) {
    // intentionally empty — subcommand IIFE owns the process from here.
  }
  // --watch: supervisor mode — spawn this binary as a child (without --watch) and restart on crash
  else if (config.watch) {
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
} // end of `else` for `if (__subcommandWillRun)` (bridge-mode block)
