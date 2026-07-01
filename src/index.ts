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
        const trimmed = line.trim();
        // Skip blank lines and full-line comments outright.
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
        if (m?.[1] && !process.env[m[1]]) {
          let raw = m[2] ?? "";
          // Strip an inline comment, but only when the value is NOT quoted —
          // a quoted value may legitimately contain '#' (cli-commands-6).
          const isQuoted =
            (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
            (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2);
          if (!isQuoted) {
            const hashIdx = raw.indexOf("#");
            if (hashIdx !== -1) raw = raw.slice(0, hashIdx);
            raw = raw.trim();
          }
          process.env[m[1]] = raw.replace(/^["']|["']$/g, "");
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
  type BridgeLockInfo,
  findAllLiveBridges,
  findBridgeLock,
} from "./bridgeLockDiscovery.js";
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
import { treeKill } from "./processTree.js";
import { PACKAGE_VERSION, semverGt } from "./version.js";
import { ensureCmdShim } from "./winShim.js";
import { writeFileAtomicSync } from "./writeFileAtomic.js";

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
  bridgeBlockStartMarker,
  extractClaudeMdBlockVersion,
  patchClaudeMdImport,
  replaceAllBridgeBlocks,
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
  "status",
  "shim",
  "quick-task",
  "start-task",
  "continue-handoff",
  "token-efficiency",
  "recipe",
  "connect",
  "traces",
  "suggest",
  "dashboard",
  "launchd",
  "start",
  "orchestrator",
  "kill-switch",
  "panic",
  "halts",
  "judgments",
  "analytics",
  "doctor",
  "shadow-scan",
  "workers",
  "approvals",
  "gate",
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

// bash/zsh set process.env._ to the actual invoked binary path (e.g. /usr/local/bin/patchwork-os).
// More reliable than argv[1] which resolves to the .js entrypoint via npm global shim.
function invokedBinaryName(): string {
  const fromEnv = process.env._
    ? path.basename(process.env._).replace(/\.(cmd|js)$/i, "")
    : "";
  if (fromEnv && fromEnv !== "node" && fromEnv !== "npm") return fromEnv;
  return path.basename(process.argv[1] ?? "").replace(/\.js$/, "");
}

const __invokedBareBinaryDashboard = (() => {
  if (process.argv[2] && process.argv[2] !== "dashboard") return false;
  const binName = invokedBinaryName();
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

// Handle top-level --help / -h / help — print a grouped command index so a
// first-time user has a discoverable entry point. Without this, bare
// `patchwork --help` falls through to bridge-daemon arg parsing and errors.
if (
  process.argv[2] === "--help" ||
  process.argv[2] === "-h" ||
  process.argv[2] === "help"
) {
  const binName = path.basename(process.argv[1] ?? "patchwork");
  process.stdout.write(
    `${binName} ${PACKAGE_VERSION}\n\n` +
      `First time? Run:\n` +
      `  ${binName} init                          # set up ~/.patchwork + Claude Code hooks\n` +
      `  ${binName} start-all                     # bridge + Claude + dashboard\n\n` +
      `Get started\n` +
      `  init [--workspace <dir>]                  Scaffold ~/.patchwork; register CC hooks\n` +
      `  install-extension                         Install the VS Code / Cursor / Windsurf extension\n` +
      `  start-all [--no-dashboard]                Launch bridge + Claude --ide + dashboard\n` +
      `  start-orchestrator                        Multi-IDE-window meta-bridge\n\n` +
      `Recipes\n` +
      `  recipe new <name> [-i]                    Scaffold a recipe\n` +
      `  recipe list                               List installed recipes\n` +
      `  recipe run <name> [--vars k=v]            Run a recipe by name\n` +
      `  recipe install <source>                   Install from a path or GitHub source\n` +
      `  recipe --help                             Full recipe subcommand index\n\n` +
      `Connectors\n` +
      `  connect [list]                            List connectors + connection status\n` +
      `  connect <vendor>                          OAuth: print authorize URL / PAT: connect\n` +
      `  connect test <vendor>                     Health-probe a connector\n` +
      `  connect disconnect <vendor>               Revoke a connector\n\n` +
      `Operate\n` +
      `  start [--port N] [--workspace <dir>]      Start a single bridge (no tmux)\n` +
      `  status                                    One-line bridge status (port, uptime)\n` +
      `  tools [list|search <q>] [--slim] [--json] List tools the bridge would register\n` +
      `  analytics <show|configure|clear|test>     Manage opt-in telemetry config\n` +
      `  launchd <install|uninstall|status>        Manage the macOS auto-start LaunchAgent\n\n` +
      `Diagnose\n` +
      `  halts [--window 1h|24h|overnight|7d]      Morning summary of recent recipe halts\n` +
      `  judgments [--window ...] [--recipe N]     Recent judge-step verdicts across runs\n` +
      `  suggest [--since-days N]                  Recipe + unused-tool suggestions\n` +
      `  token-efficiency benchmark                Measure token cost across tool sets\n` +
      `  traces export                             Bundle approval / recipe / decision traces\n` +
      `  print-token [--port N]                    Print the active bridge auth token\n\n` +
      `Safety\n` +
      `  kill-switch <engage|release|status>       Block / resume write-tier tools across bridges\n` +
      `  panic [--reason "..."]                    Shorthand for kill-switch engage\n\n` +
      `Daemon (no subcommand)\n` +
      `  --workspace <dir>                         Start the bridge in foreground\n` +
      `  --watch                                   Auto-restart supervisor\n` +
      `  --slim                                    27 IDE-only tools (default: full)\n\n` +
      `Other\n` +
      `  --version, -v                             Print package version\n` +
      `  shim                                      stdio↔WebSocket shim (used by MCP clients)\n` +
      `  notify <event>                            Notify a running bridge of a CC hook event\n\n` +
      `Bridge-daemon flags: run \`${binName} --workspace . --help-flags\` for the full list,\n` +
      `or see https://github.com/Oolab-labs/patchwork-os#readme.\n`,
  );
  process.exit(0);
}

// Handle patchwork-init subcommand — T2 from docs/install-ux-plan.md.
// Separate from the bridge-only `init` to preserve back-compat. See ADR-0008.
if (process.argv[2] === "patchwork-init") {
  const { runPatchworkInit } = await import("./commands/patchworkInit.js");
  await runPatchworkInit(process.argv.slice(3));
  process.exit(0);
}

// `patchwork-os init` → dashboard setup, not IDE bridge installer.
// patchwork init / claude-ide-bridge init still go to the bridge path below.
if (process.argv[2] === "init" && invokedBinaryName() === "patchwork-os") {
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
  // Dispatch the cross-platform Node orchestrator (start-all.mjs). The
  // bash entry-point is kept as a developer shortcut but Windows has no
  // `bash` on PATH by default, and the .mjs is functionally equivalent.
  const scriptPath = path.resolve(
    __dirnameTop,
    "..",
    "scripts",
    "start-all.mjs",
  );
  const result = spawnSync(process.execPath, [scriptPath, ...startAllArgs], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

// `patchwork start` — opinionated front door over start-all.
// Defaults to full mode (all tools registered) and the web dashboard, so the
// doc-promised "patchwork start → everything works" path actually works.
// Pass-through args still go to start-all.mjs; --help short-circuits.
if (process.argv[2] === "start") {
  const passthrough = process.argv.slice(3);
  if (passthrough.includes("--help") || passthrough.includes("-h")) {
    process.stdout.write(`patchwork start — Launch the full Patchwork stack

Starts bridge + Claude + dashboard via the cross-platform Node orchestrator.
Defaults to full mode so all bridge tools are registered.
On macOS/Linux: uses tmux when available, falls back to background mode.
On Windows: runs natively via the Node orchestrator (no WSL required).

Usage: patchwork start [options]

Options:
  --workspace <path>    Directory to open (default: current directory)
  --no-dashboard        Skip the web dashboard
  --dashboard-port <N>  Dashboard port (default: 3200)
  --notify <topic>      Push notifications via ntfy.sh
  --vps <user@host>     SSH reverse tunnel for stable claude.ai URL
  --slim                Slim mode (27 IDE-exclusive tools only — overrides default)
  --help, -h            Show this help

This is a thin wrapper over \`start-all\`. For advanced flags see:
  patchwork start-all --help
`);
    process.exit(0);
  }
  // Default to --full unless caller opted into slim explicitly.
  const args = [...passthrough];
  const slimIdx = args.indexOf("--slim");
  if (slimIdx >= 0) {
    args.splice(slimIdx, 1); // slim is the .mjs default; strip so --full isn't re-added below
  } else if (!args.includes("--full")) {
    args.push("--full");
  }
  // On non-Windows: auto-detect tmux; fall back to --no-tmux background mode if absent.
  if (process.platform !== "win32" && !args.includes("--no-tmux")) {
    const tmuxCheck = spawnSync("which", ["tmux"], { stdio: "ignore" });
    if (tmuxCheck.status !== 0) args.push("--no-tmux");
  }
  // Dispatch to the cross-platform Node orchestrator (see above).
  const scriptPath = path.resolve(
    __dirnameTop,
    "..",
    "scripts",
    "start-all.mjs",
  );
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function writeRulesFileAtomic(rulesFilePath: string, content: string): void {
  writeFileAtomicSync(rulesFilePath, content, { encoding: "utf-8" });
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
  if (code === "ELOOP") {
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
      try {
        renameSync(tmpPath, targetPath);
      } catch (renameErr) {
        if (
          (renameErr as NodeJS.ErrnoException).code === "EEXIST" &&
          process.platform === "win32"
        ) {
          // Concurrent writer recreated targetPath between the two renames.
          try {
            unlinkSync(targetPath);
          } catch {
            /* best-effort */
          }
          renameSync(tmpPath, targetPath);
        } else {
          throw renameErr;
        }
      }
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
    try {
      renameSync(`${targetPath}.tmp`, targetPath);
    } catch (renameErr) {
      if (
        (renameErr as NodeJS.ErrnoException).code === "EEXIST" &&
        process.platform === "win32"
      ) {
        try {
          unlinkSync(targetPath);
        } catch {
          /* best-effort */
        }
        renameSync(`${targetPath}.tmp`, targetPath);
      } else {
        try {
          unlinkSync(`${targetPath}.tmp`);
        } catch {
          /* best-effort */
        }
        throw renameErr;
      }
    }
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

  // Select a *running bridge* lock (isBridge:true + live PID) rather than the
  // most-recently-touched lock in ~/.claude/ide, which can be an IDE-owned
  // lock or a dead bridge.
  let bridgeLock: BridgeLockInfo | null;
  if (portArg) {
    const port = Number(portArg);
    bridgeLock = findAllLiveBridges().find((b) => b.port === port) ?? null;
    if (!bridgeLock) {
      process.stderr.write(
        `Error: No running bridge found for port ${portArg} (no lock file for that port, the lock is IDE-owned, or its process is not alive).\n`,
      );
      process.exit(1);
    }
  } else {
    bridgeLock = findBridgeLock();
  }

  if (!bridgeLock) {
    process.stderr.write(
      `Error: No running bridge lock file found in ${lockDir}\n`,
    );
    process.stderr.write(
      "Make sure the bridge is running first, or pass --port <port>.\n",
    );
    process.exit(1);
  }

  if (!bridgeLock.authToken) {
    process.stderr.write(
      `Error: Bridge lock for port ${bridgeLock.port} has no authToken field\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${bridgeLock.authToken}\n`);
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
  // Iterate the full list (not length-1) so a trailing bare `--flag` with no
  // following value is still recorded rather than silently dropped
  // (cli-commands-5). A flag whose next token is another `--flag` (or which is
  // last) is treated as an empty-valued flag, matching the existing `?? ""`.
  for (let i = 0; i < notifyRest.length; i++) {
    const arg = notifyRest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = notifyRest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        namedArgs[key] = next;
        i++;
      } else {
        namedArgs[key] = "";
      }
    }
  }

  const notifyLockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  // Select a *running bridge* lock (isBridge:true + live PID) rather than the
  // most-recently-touched lock, which can be an IDE-owned or dead-bridge lock.
  let notifyPort: number | undefined;
  let notifyToken: string | undefined;

  if (namedArgs.port) {
    const port = Number(namedArgs.port);
    const lock = findAllLiveBridges().find((b) => b.port === port);
    if (!lock) {
      process.stderr.write(
        `Error: No running bridge found for port ${namedArgs.port} (no lock for that port, the lock is IDE-owned, or its process is not alive).\n`,
      );
      process.exit(1);
    }
    notifyPort = lock.port;
    notifyToken = lock.authToken;
  } else {
    const lock = findBridgeLock();
    if (lock) {
      notifyPort = lock.port;
      notifyToken = lock.authToken;
    }
  }

  if (!notifyPort || !notifyToken) {
    process.stderr.write(
      `Error: No running bridge lock file found in ${notifyLockDir}\n`,
    );
    process.stderr.write(
      "Make sure the bridge is running first (claude-ide-bridge --watch ...).\n",
    );
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

  // Parse args: gen-plugin-stub <dir> [--name <name>] [--prefix <prefix>] [--ts]
  const dirArg = argv.find((a) => !a.startsWith("--"));
  if (!dirArg) {
    process.stderr.write(
      "Usage: claude-ide-bridge gen-plugin-stub <output-dir> [--name <org/plugin-name>] [--prefix <toolPrefix>] [--ts]\n",
    );
    process.exit(1);
  }

  const nameIdx = argv.indexOf("--name");
  const prefixIdx = argv.indexOf("--prefix");
  // --ts emits a TypeScript variant (src/index.ts + tsconfig.json + build
  // scripts) alongside a compiled-output manifest pointing at index.mjs.
  // Plugin authors get type-checked tools without changing the hot-reload
  // contract — `npm run dev` watches src/, emits index.mjs, bridge picks
  // up the rebuilt artifact via --plugin-watch.
  const useTypeScript = argv.includes("--ts");
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

  // ── shared tool body — same logic, different surface syntax ──
  const jsEntrypoint = `/**
 * ${pluginName} — Claude IDE Bridge plugin
 *
 * Each tool must have a name starting with "${toolPrefix}".
 * The \`ctx\` object provides: ctx.workspace, ctx.workspaceFolders,
 * ctx.config (commandTimeout, maxResultSize), and ctx.logger.
 */

/** @param {import('patchwork-os/plugin').PluginContext} ctx */
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

  const tsEntrypoint = `/**
 * ${pluginName} — Claude IDE Bridge plugin
 *
 * Each tool must have a name starting with "${toolPrefix}".
 * The \`ctx\` object provides: ctx.workspace, ctx.workspaceFolders,
 * ctx.config (commandTimeout, maxResultSize), and ctx.logger.
 */
import type { PluginContext } from "patchwork-os/plugin";

interface HelloArgs {
  name: string;
}

export function register(ctx: PluginContext) {
  ctx.logger.info(${JSON.stringify(`${pluginName} loaded`)}, { workspace: ctx.workspace });

  return {
    tools: [
      {
        schema: {
          name: ${JSON.stringify(`${toolPrefix}Hello`)},
          description: "Example tool — returns a greeting",
          inputSchema: {
            type: "object" as const,
            required: ["name"] as const,
            additionalProperties: false as const,
            properties: {
              name: { type: "string" as const, description: "Name to greet" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        handler: async (args: HelloArgs) => ({
          content: [
            {
              type: "text" as const,
              text: \`Hello from ${pluginName}, \${args.name}!\`,
            },
          ],
        }),
      },
    ],
  };
}
`;

  // Write entrypoint — TS goes under src/, JS at root.
  if (useTypeScript) {
    mkdirSync(path.join(outDir, "src"), { recursive: true });
    writeFileSync(path.join(outDir, "src", "index.ts"), tsEntrypoint, "utf-8");
  } else {
    writeFileSync(path.join(outDir, "index.mjs"), jsEntrypoint, "utf-8");
  }

  // tsconfig.json — TS variant only. Emits a single ESM file at index.mjs
  // so the plugin manifest's entrypoint stays the same shape as the JS
  // scaffold and --plugin-watch reload semantics don't change.
  if (useTypeScript) {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "Bundler",
        outDir: ".",
        rootDir: "src",
        declaration: false,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        // Emit .mjs so the plugin loader (which expects ESM) picks it up
        // without relying on package.json "type": "module" alone.
        // tsc doesn't emit .mjs natively, so package.json's "build" script
        // does a rename pass — see below.
      },
      include: ["src/**/*"],
      exclude: ["node_modules"],
    };
    writeFileSync(
      path.join(outDir, "tsconfig.json"),
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      "utf-8",
    );
  }

  // package.json — TS variant adds build + dev (watch) scripts.
  const pkgBase = {
    name: pluginName.replace(/^@[^/]+\//, "").replace(/\//g, "-"),
    version: "0.1.0",
    description: "A Claude IDE Bridge plugin",
    type: "module",
    main: "index.mjs",
    keywords: ["patchwork-os", "claude-ide-bridge-plugin"],
    peerDependencies: { "patchwork-os": ">=0.2.0-alpha.0" },
  };
  const pkg = useTypeScript
    ? {
        ...pkgBase,
        scripts: {
          // tsc emits index.js — rename to index.mjs so the loader treats
          // it as ESM regardless of the consumer's package.json.
          build: "tsc && mv index.js index.mjs",
          dev: "tsc --watch",
          clean: "rm -f index.mjs",
        },
        devDependencies: {
          typescript: "^5.4.0",
          "patchwork-os": ">=0.2.0-alpha.0",
        },
      }
    : pkgBase;
  writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf-8",
  );

  // README.md — included in both variants. Spells out the hot-reload
  // contract so plugin authors don't have to read the platform docs to
  // get started.
  const readmeBody = useTypeScript
    ? `# ${pluginName}

A [Claude IDE Bridge](https://github.com/Oolab-labs/patchwork-os) plugin (TypeScript).

## Quick start

\`\`\`sh
npm install
npm run dev      # in one terminal — watches src/, emits index.mjs

# In another terminal:
claude-ide-bridge --plugin . --plugin-watch
\`\`\`

Edit \`src/index.ts\`. \`tsc --watch\` rebuilds, the bridge hot-reloads, your tool is callable from the live Claude session on the next turn.

## Build for distribution

\`\`\`sh
npm run build    # emits index.mjs
npm publish      # publish to npm (optional)
\`\`\`

When published with the \`claude-ide-bridge-plugin\` keyword, users can install with:

\`\`\`sh
claude-ide-bridge --plugin ${pluginName.replace(/^@[^/]+\//, "")}
\`\`\`

## Tool naming

Every tool exposed by this plugin **must** have a \`name\` starting with \`${toolPrefix}\`. The bridge enforces this at load time (\`/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/\`).

## Plugin context

The \`ctx\` argument to \`register()\` provides:

- \`ctx.workspace\` — workspace root path
- \`ctx.workspaceFolders\` — array of workspace folders
- \`ctx.config\` — \`{ commandTimeout, maxResultSize }\`
- \`ctx.logger\` — \`info\` / \`warn\` / \`error\` logging that respects bridge log level

## Live toolsmithing

The whole point of plugins is that you can author tools *while Claude is using the bridge*. Edit \`src/index.ts\`, save, the watcher rebuilds, the bridge reloads — Claude's next turn sees the new tool.

See [documents/live-toolsmithing.md](https://github.com/Oolab-labs/patchwork-os/blob/main/documents/live-toolsmithing.md) for the full narrative.
`
    : `# ${pluginName}

A [Claude IDE Bridge](https://github.com/Oolab-labs/patchwork-os) plugin.

## Quick start

\`\`\`sh
claude-ide-bridge --plugin . --plugin-watch
\`\`\`

Edit \`index.mjs\`. The bridge hot-reloads on save — your tool is callable from the live Claude session on the next turn. No build step needed for the JS variant.

## Tool naming

Every tool exposed by this plugin **must** have a \`name\` starting with \`${toolPrefix}\`. The bridge enforces this at load time (\`/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/\`).

## Plugin context

The \`ctx\` argument to \`register()\` provides:

- \`ctx.workspace\` — workspace root path
- \`ctx.workspaceFolders\` — array of workspace folders
- \`ctx.config\` — \`{ commandTimeout, maxResultSize }\`
- \`ctx.logger\` — \`info\` / \`warn\` / \`error\` logging that respects bridge log level

## Want types?

Re-scaffold with \`claude-ide-bridge gen-plugin-stub <dir> --ts\` for a TypeScript variant with \`tsc --watch\` build pipeline.

## Live toolsmithing

Edit, save, hot-reload — Claude's next turn sees the new tool. See [documents/live-toolsmithing.md](https://github.com/Oolab-labs/patchwork-os/blob/main/documents/live-toolsmithing.md) for the full narrative.
`;
  writeFileSync(path.join(outDir, "README.md"), readmeBody, "utf-8");

  // .gitignore
  const gitignore = useTypeScript
    ? "node_modules\nindex.mjs\nindex.js\n*.tsbuildinfo\n"
    : "node_modules\n";
  writeFileSync(path.join(outDir, ".gitignore"), gitignore, "utf-8");

  process.stderr.write(
    `✓ Plugin stub created at ${outDir} (${useTypeScript ? "TypeScript" : "JavaScript"})\n`,
  );
  process.stderr.write("\nNext steps:\n");
  if (useTypeScript) {
    process.stderr.write(`  1. cd ${outDir} && npm install\n`);
    process.stderr.write(
      `  2. Edit ${path.join(outDir, "src", "index.ts")} to implement your tools\n`,
    );
    process.stderr.write(`  3. npm run dev  (in one terminal)\n`);
    process.stderr.write(
      `  4. claude-ide-bridge --plugin ${outDir} --plugin-watch  (in another)\n`,
    );
  } else {
    process.stderr.write(
      `  1. Edit ${path.join(outDir, "index.mjs")} to implement your tools\n`,
    );
    process.stderr.write(
      `  2. Run the bridge with: claude-ide-bridge --plugin ${outDir} --plugin-watch\n`,
    );
    process.stderr.write(
      `  3. Or add to your config: { "plugins": ["${outDir}"] }\n`,
    );
  }
  process.exit(0);
}

// Patchwork: `patchwork recipe` (no subcommand) / `recipe --help` — print
// the subcommand index. Without this branch, `patchwork recipe` falls through
// to the bridge daemon, leaving subcommands completely undiscoverable from
// the CLI (the only way to find them today is to read CLAUDE.md or source).
if (
  process.argv[2] === "recipe" &&
  (process.argv[3] === undefined ||
    process.argv[3] === "--help" ||
    process.argv[3] === "-h" ||
    process.argv[3] === "help")
) {
  process.stdout.write(
    `Usage: patchwork recipe <subcommand> [args...]\n\n` +
      `Subcommands:\n` +
      `  new <name>         Scaffold a recipe (interactive with -i)\n` +
      `  list               List installed recipes (workspace + user)\n` +
      `  run <name>         Run a recipe by name\n` +
      `  install <src>      Install a recipe from a path or GitHub source\n` +
      `  uninstall <name>   Remove an installed recipe\n` +
      `  enable <name>      Re-enable a disabled recipe\n` +
      `  disable <name>     Pause a recipe (scheduled triggers stop firing)\n` +
      `  preflight <file>   Static-validate a recipe YAML before running\n` +
      `  doctor <name|file> Diagnose a recipe: lint + policy + recent halts\n` +
      `  lint <file>        Run all lint checks on a recipe YAML\n` +
      `  fmt <file>         Format a recipe YAML in place\n` +
      `  schema             Print the recipe JSON Schema\n` +
      `  audit-env <recipe> Check {{env.FOO}} vars are present in environment\n\n` +
      `Run \`patchwork recipe <subcommand> --help\` for subcommand-specific options.\n`,
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
    "Usage: patchwork recipe run <name-or-file> [--local] [--dry-run] [--step <id>] [--var KEY=VALUE] [--attempt <id>] [--ledger-dir <path>]\n";
  let localFlag = false;
  let dryRun = false;
  let recipeRef: string | undefined;
  let step: string | undefined;
  let attemptId: string | undefined;
  let ledgerDir: string | undefined;
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

    if (currentArg === "--attempt" || currentArg.startsWith("--attempt=")) {
      const value =
        currentArg === "--attempt"
          ? args[++i]
          : currentArg.slice("--attempt=".length);
      if (!value) {
        process.stderr.write(`Error: --attempt requires a value\n${usage}`);
        process.exit(1);
      }
      attemptId = value;
      continue;
    }

    if (
      currentArg === "--ledger-dir" ||
      currentArg.startsWith("--ledger-dir=")
    ) {
      const value =
        currentArg === "--ledger-dir"
          ? args[++i]
          : currentArg.slice("--ledger-dir=".length);
      if (!value) {
        process.stderr.write(`Error: --ledger-dir requires a value\n${usage}`);
        process.exit(1);
      }
      ledgerDir = value;
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
      if (lock && !dryRun && !step && !explicitFile && !attemptId) {
        // 30s per-request deadline — the bridge can pass the findBridgeLock
        // PID check yet be wedged on HTTP. Without this abort the fetch
        // blocks forever. Mirrors the AbortController pattern used by every
        // sibling bridge call (halts, judgments, recipe doctor, kill-switch).
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        let res: Response;
        let body: { ok: boolean; taskId?: string; error?: string };
        try {
          res = await fetch(`http://127.0.0.1:${lock.port}/recipes/run`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${lock.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: recipeArg,
              ...(seedVars ? { vars: seedVars } : {}),
            }),
            signal: controller.signal,
          });
          body = (await res.json()) as {
            ok: boolean;
            taskId?: string;
            error?: string;
          };
        } catch (err) {
          const aborted =
            err instanceof Error &&
            (err.name === "AbortError" || controller.signal.aborted);
          process.stderr.write(
            aborted
              ? `Error: bridge on port ${lock.port} did not respond within 30s — it may be wedged. Restart the bridge or re-run with --local.\n`
              : `Error: failed to reach bridge on port ${lock.port}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
          return;
        } finally {
          clearTimeout(timer);
        }
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
      // PR5c — resume support: when --attempt is given, mint or reuse a
      // stable id and point the runner at a disk-backed effect ledger.
      // `--attempt new` always mints a fresh id; any other value is
      // taken verbatim (so the user can re-run the same attempt and
      // skip already-completed write tools).
      let resolvedAttempt: string | undefined;
      let resolvedLedgerDir: string | undefined;
      if (attemptId !== undefined) {
        resolvedAttempt =
          attemptId === "new"
            ? `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            : attemptId;
        // Validate at the CLI boundary so an invalid id fails loudly
        // before any side effects run (and before it lands in the run
        // log or hashed into a ledger scope key).
        try {
          const { assertValidManualRunId } = await import(
            "./recipes/idempotencyKey.js"
          );
          assertValidManualRunId(resolvedAttempt);
        } catch (err) {
          process.stderr.write(
            `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
        resolvedLedgerDir = ledgerDir ?? path.join(os.homedir(), ".patchwork");
        process.stdout.write(
          `  Attempt id: ${resolvedAttempt} (ledger: ${resolvedLedgerDir})\n`,
        );
      }
      const run = await runRecipe(recipeArg, {
        ...(step ? { step } : {}),
        ...(seedVars ? { vars: seedVars } : {}),
        ...(resolvedAttempt && { manualRunId: resolvedAttempt }),
        ...(resolvedLedgerDir && { ledgerDir: resolvedLedgerDir }),
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
        // alpha.36+ — sidecar `<name>.permissions.json` is no longer written
        // (was decorative, never read by toolRegistry). Print the suggested
        // permissions snippet inline so users can hand-merge into settings.
        process.stdout.write(
          `  ✓ ${result.action} ${result.installedPath}\n` +
            `  ℹ Patchwork does not enforce per-recipe permissions; configure tool gating in ~/.claude/settings.json.\n` +
            `    Suggested permissions snippet:\n${result.permissionsJson
              .split("\n")
              .map((l) => `      ${l}`)
              .join("\n")}\n`,
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

// Patchwork: `patchwork suggest [--since <date>]` — pattern-mine the
// activity log + run history for "you've been doing X by hand; want to
// make a recipe?" hints. See documents/strategic/2026-05-02/memory-
// ecosystem-report.md §6 for the catalog this implements.
//
// Three suggestion kinds: co-occurring tool pairs (worth a recipe), tools
// installed but unused (worth reviewing or pruning), and recipes that
// always succeed (worth trust-graduating). Read-only — does not change
// any policy or registry state.
if (process.argv[2] === "suggest") {
  (async () => {
    try {
      const args = process.argv.slice(3);
      let sinceDays: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--since-days") {
          const next = args[i + 1];
          if (next) sinceDays = Number.parseInt(next, 10);
          i++;
        } else if (a === "--help" || a === "-h") {
          process.stdout.write(
            "patchwork suggest [--since-days <N>]\n\n" +
              "Pattern-mine the activity log + recipe runs for automation hints:\n" +
              "  - Co-occurring tool pairs that don't yet appear in any recipe\n" +
              "  - Installed tools that haven't been called recently\n" +
              "  - Recipes that have succeeded ≥ 10 times in a row (trust-graduation candidates)\n\n" +
              "Default lookback window is 7 days. --since-days overrides.\n\n" +
              "Read-only — does not modify policy, registry, or run history.\n",
          );
          process.exit(0);
        }
      }

      const { ActivityLog } = await import("./activityLog.js");
      const { RecipeRunLog } = await import("./runLog.js");
      const { computeAutomationSuggestions } = await import(
        "./automationSuggestions.js"
      );
      // Side-effect import — populates the tool registry that
      // computeAutomationSuggestions consults for installed-tool inventory.
      await import("./recipes/tools/index.js");

      // Wire up the bridge's standard log paths. The CLI reads from
      // disk; it doesn't need a running bridge.
      const patchworkDir = path.join(os.homedir(), ".patchwork");
      const activityLog = new ActivityLog();
      // Find the most recent activity log file (any port). For the
      // suggest CLI we union all of them.
      const claudeIdeDir = path.join(os.homedir(), ".claude", "ide");
      try {
        const entries = await import("node:fs").then((m) =>
          m.readdirSync(claudeIdeDir),
        );
        for (const name of entries) {
          if (/^activity(-\d+)?\.jsonl$/i.test(name)) {
            activityLog.setPersistPath(path.join(claudeIdeDir, name));
            break; // setPersistPath loads on call; first existing wins
          }
        }
      } catch {
        // No activity dir / files — proceed with an empty log; the
        // suggestions just return fewer / no items.
      }

      const recipeRunLog = new RecipeRunLog({ dir: patchworkDir });

      const opts: Parameters<typeof computeAutomationSuggestions>[0] = {
        activityLog,
        recipeRunLog,
      };
      if (sinceDays !== undefined && Number.isFinite(sinceDays)) {
        opts.activitySinceMs = sinceDays * 24 * 60 * 60 * 1000;
      }
      const suggestions = computeAutomationSuggestions(opts);

      if (suggestions.length === 0) {
        process.stdout.write(
          "No automation suggestions yet. Patchwork mines patterns from the activity log\n" +
            "and recipe run history; come back after a few days of use.\n",
        );
        process.exit(0);
      }

      process.stdout.write(
        `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}:\n\n`,
      );
      for (const s of suggestions) {
        const icon =
          s.kind === "co_occurring_pair"
            ? "→"
            : s.kind === "installed_but_unused"
              ? "·"
              : "★";
        process.stdout.write(`  ${icon} ${s.label}\n`);
      }
      process.stdout.write("\nRead-only output. Nothing changed.\n");
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
// Patchwork: `patchwork traces export [--output <path>]` — bundle the four
// local trace logs into a single .jsonl.gz so a user can move machines,
// take a compliance snapshot, or share traces with another tool. See
// docs/strategic/2026-05-02/memory-ecosystem-report.md items 1, 3, 12 for
// the durability rationale this PR addresses.
if (process.argv[2] === "traces" && process.argv[3] === "export") {
  (async () => {
    try {
      const args = process.argv.slice(4);
      let output: string | undefined;
      let patchworkDir: string | undefined;
      let activityDir: string | undefined;
      let mode: "public" | "keyed" | undefined;
      let passphrase: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--output" || a === "-o") {
          output = args[i + 1];
          i++;
        } else if (a === "--patchwork-dir") {
          patchworkDir = args[i + 1];
          i++;
        } else if (a === "--activity-dir") {
          activityDir = args[i + 1];
          i++;
        } else if (a === "--mode") {
          const m = args[i + 1];
          if (m !== "public" && m !== "keyed") {
            process.stderr.write(
              `Error: --mode must be "public" or "keyed" (got: ${m})\n`,
            );
            process.exit(1);
          }
          mode = m;
          i++;
        } else if (a === "--passphrase") {
          passphrase = args[i + 1];
          i++;
        } else if (a === "--help" || a === "-h") {
          process.stdout.write(
            "patchwork traces export [--output <path>] [--mode public|keyed]\n" +
              "                        [--passphrase <phrase>]\n" +
              "                        [--patchwork-dir <dir>] [--activity-dir <dir>]\n\n" +
              "Bundles ~/.patchwork/{runs,decision_traces,commit_issue_links}.jsonl\n" +
              "and ~/.claude/ide/activity-*.jsonl into a single gzipped JSONL file.\n\n" +
              "Modes:\n" +
              "  public  (default) Plain gzip bundle (.jsonl.gz). Anyone with the file\n" +
              "          can read it.\n" +
              "  keyed   AES-256-GCM encrypted bundle (.enc). Requires --passphrase;\n" +
              "          auto-detected and decrypted by `traces import --passphrase`.\n\n" +
              "Output is a manifest line followed by one envelope per row:\n" +
              '  {"type":"manifest", ...}\n' +
              '  {"source":"runs", "entry":{...}}\n' +
              "  ...\n\n" +
              "Filter one source with:\n" +
              "  gunzip -c traces-export-*.jsonl.gz | jq 'select(.source==\"decision_traces\") | .entry'\n",
          );
          process.exit(0);
        }
      }
      if (mode === "keyed" && !passphrase) {
        process.stderr.write(
          "Error: --mode keyed requires --passphrase <phrase>\n",
        );
        process.exit(1);
      }
      const { runTracesExport } = await import("./commands/tracesExport.js");
      const result = await runTracesExport({
        ...(output !== undefined && { output }),
        ...(patchworkDir !== undefined && { patchworkDir }),
        ...(activityDir !== undefined && { activityDir }),
        ...(mode !== undefined && { mode }),
        ...(passphrase !== undefined && { passphrase }),
      });
      process.stdout.write(`  ✓ Wrote ${result.outputPath}\n`);
      process.stdout.write(
        `    ${result.totalCount} rows from ${result.files.length} file${result.files.length === 1 ? "" : "s"} (${result.totalBytes} bytes read)\n`,
      );
      for (const f of result.files) {
        process.stdout.write(
          `    - ${f.source}: ${f.count} rows  (${f.path})\n`,
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

// Patchwork: `patchwork traces import <bundle>` — restore an export bundle
// into the local patchwork dirs. Closes the half-shipped backup loop.
if (process.argv[2] === "traces" && process.argv[3] === "import") {
  (async () => {
    try {
      const args = process.argv.slice(4);
      let input: string | undefined;
      let patchworkDir: string | undefined;
      let activityDir: string | undefined;
      let mode: "append" | "overwrite" = "append";
      let dryRun = false;
      let passphrase: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--patchwork-dir") {
          patchworkDir = args[i + 1];
          i++;
        } else if (a === "--activity-dir") {
          activityDir = args[i + 1];
          i++;
        } else if (a === "--mode") {
          const m = args[i + 1];
          if (m !== "append" && m !== "overwrite") {
            process.stderr.write(
              `Error: --mode must be "append" or "overwrite" (got: ${m})\n`,
            );
            process.exit(1);
          }
          mode = m;
          i++;
        } else if (a === "--passphrase") {
          passphrase = args[i + 1];
          i++;
        } else if (a === "--dry-run") {
          dryRun = true;
        } else if (a === "--help" || a === "-h") {
          process.stdout.write(
            "patchwork traces import <bundle> [--mode append|overwrite] [--dry-run]\n" +
              "                        [--passphrase <phrase>]\n" +
              "                        [--patchwork-dir <dir>] [--activity-dir <dir>]\n\n" +
              "Restore a bundle written by `patchwork traces export` into the local\n" +
              "patchwork dirs (~/.patchwork/ and ~/.claude/ide/ by default).\n\n" +
              "Formats:\n" +
              "  .jsonl.gz   Plain gzip bundle — no passphrase required.\n" +
              "  .enc        AES-256-GCM encrypted bundle — pass --passphrase.\n\n" +
              "Modes:\n" +
              "  append     (default) Append rows to existing files.\n" +
              "  overwrite  Truncate target files before writing. Use for fresh-machine\n" +
              "             restore; never use when there's local data you want to keep.\n",
          );
          process.exit(0);
        } else if (
          a !== undefined &&
          !a.startsWith("--") &&
          input === undefined
        ) {
          input = a;
        }
      }
      if (!input) {
        process.stderr.write(
          "Usage: patchwork traces import <bundle> [--passphrase <phrase>] [--mode append|overwrite] [--dry-run]\n",
        );
        process.exit(1);
      }

      // Auto-detect encrypted bundle and decrypt before import.
      if (passphrase !== undefined || input.endsWith(".enc")) {
        const { readFileSync } = await import("node:fs");
        const { isEncryptedTraceBundle, decryptTraceBundle } = await import(
          "./traceEncryption.js"
        );
        const raw = readFileSync(input);
        if (isEncryptedTraceBundle(raw)) {
          if (!passphrase) {
            process.stderr.write(
              "Error: bundle is encrypted — provide --passphrase <phrase>\n",
            );
            process.exit(1);
          }
          const plain = decryptTraceBundle(raw, passphrase);
          const { tmpdir } = await import("node:os");
          const { join: pathJoin } = await import("node:path");
          const { writeFileSync } = await import("node:fs");
          const tmp = pathJoin(
            tmpdir(),
            `patchwork-import-${Date.now()}.jsonl.gz`,
          );
          writeFileSync(tmp, plain, { mode: 0o600 });
          input = tmp;
          process.stderr.write("Decryption succeeded.\n");
          // Ensure tmp is removed after import regardless of success/failure.
          // On Windows mode:0o600 is a no-op (NTFS doesn't honour POSIX bits),
          // so the plaintext would persist in %TEMP% until the next reboot.
          process.once("exit", () => {
            try {
              unlinkSync(tmp);
            } catch {
              /* best-effort */
            }
          });
        }
      }

      const { runTracesImport } = await import("./commands/tracesImport.js");
      const result = await runTracesImport({
        input,
        ...(patchworkDir !== undefined && { patchworkDir }),
        ...(activityDir !== undefined && { activityDir }),
        mode,
        dryRun,
      });
      const verb = result.dryRun
        ? "Would restore"
        : result.mode === "overwrite"
          ? "Restored (overwrite)"
          : "Restored (append)";
      process.stdout.write(
        `  ${result.dryRun ? "•" : "✓"} ${verb} ${result.totalCount} rows from ${result.inputPath}\n`,
      );
      process.stdout.write(`    Bundle exportedAt: ${result.exportedAt}\n`);
      for (const f of result.files) {
        process.stdout.write(
          `    - ${f.source}: ${f.count} rows  →  ${f.targetPath}\n`,
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

// `patchwork kill-switch engage|release|status` — issue #422 step 3.
//
// Discovers the running bridge via lock file, POSTs /kill-switch with
// Bearer auth, and surfaces structured errors (env-locked, no-bridge,
// wedged-bridge). Multi-bridge fan-out: iterates ALL live `isBridge:true`
// locks and engages/releases each (v2-B2 from #422).
//
// v2-I4: mandatory 10s deadline per request. No silent fallback on
// timeout/ECONNREFUSED/non-2xx — error message + exit non-zero.
if (process.argv[2] === "kill-switch") {
  const sub = process.argv[3];
  if (!sub || (sub !== "engage" && sub !== "release" && sub !== "status")) {
    process.stderr.write(
      'Usage: patchwork kill-switch <engage|release|status> [--reason "..."]\n' +
        "\n" +
        "  engage   Block all write-tier tool calls across every running bridge.\n" +
        "  release  Resume writes.\n" +
        "  status   Print engaged/locked state per running bridge.\n" +
        "\n" +
        "Exits non-zero if any bridge is unreachable or env-locked.\n",
    );
    process.exit(1);
  }
  (async () => {
    try {
      // Parse optional flags early so --force-local can be used without a bridge.
      const args = process.argv.slice(4);
      const reasonIdx = args.findIndex((a) => a === "--reason" || a === "-m");
      const reason =
        reasonIdx >= 0 && reasonIdx + 1 < args.length
          ? args[reasonIdx + 1]
          : undefined;
      // v2-I4: --force-local writes flags.json directly when no live bridge
      // is reachable. The running bridge's fs.watch (v2-S1) picks up the
      // change within ~100ms; without a running bridge this is "effective
      // next boot" — which is still better than a silent noop.
      const forceLocal = args.includes("--force-local");

      // v2-B2: enumerate ALL live bridge locks (not just the first).
      const { findAllLiveBridges } = await import("./bridgeLockDiscovery.js");
      const liveLocks = findAllLiveBridges();
      type BridgeLockInfo = (typeof liveLocks)[number];

      if (liveLocks.length === 0) {
        if (forceLocal && (sub === "engage" || sub === "release")) {
          // --force-local: write flags.json directly. The running bridge's
          // fs.watch picks this up within ~100ms; if the bridge is wedged
          // or not started, this is effective on next start.
          const { setFlag, KILL_SWITCH_WRITES } = await import(
            "./featureFlags.js"
          );
          const engage = sub === "engage";
          setFlag(KILL_SWITCH_WRITES, engage, true);
          // Audit in a sibling CLI-only JSONL (v2-I10: bridge-only writes
          // go to decision_traces.jsonl; CLI fallback is distinct).
          const os = await import("node:os");
          const path = await import("node:path");
          const fs = await import("node:fs");
          const cliTraceFile = path.join(
            process.env.PATCHWORK_HOME ??
              path.join(os.default.homedir(), ".patchwork"),
            "decision_traces.cli.jsonl",
          );
          const dir = path.dirname(cliTraceFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const entry = JSON.stringify({
            ts: new Date().toISOString(),
            event: engage ? "engage" : "release",
            actor: "cli-force-local",
            ...(reason ? { reason } : {}),
          });
          fs.appendFileSync(cliTraceFile, `${entry}\n`);
          process.stdout.write(
            `  ✓ kill-switch ${engage ? "ENGAGED" : "released"} via --force-local (flags.json written directly).\n` +
              "    Running bridges will pick this up via fs.watch within ~100ms.\n",
          );
          process.exit(0);
        }
        process.stderr.write(
          "No running bridge found.\n" +
            "  - For `engage`/`release`, kill-switch has no live target to update.\n" +
            "  - Use --force-local to write flags.json directly (bridge fs.watch picks it up).\n" +
            "  - Or restart the bridge and re-run this command.\n",
        );
        process.exit(2);
      }

      // v2-I4: 10s per-request deadline. AbortController per call.
      async function callBridge(
        lock: BridgeLockInfo,
        method: "GET" | "POST",
        body?: object,
      ): Promise<{
        ok: boolean;
        status: number;
        json?: Record<string, unknown>;
        error?: string;
      }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await fetch(`http://127.0.0.1:${lock.port}/kill-switch`, {
            method,
            headers: {
              Authorization: `Bearer ${lock.authToken}`,
              "Content-Type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
          });
          let json: Record<string, unknown> | undefined;
          try {
            json = (await res.json()) as Record<string, unknown>;
          } catch {
            json = undefined;
          }
          return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            ...(json ? { json } : {}),
          };
        } catch (err) {
          return {
            ok: false,
            status: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      }

      if (sub === "status") {
        let anyFailed = false;
        for (const lock of liveLocks) {
          const result = await callBridge(lock, "GET");
          if (!result.ok) {
            anyFailed = true;
            process.stderr.write(
              `  ✗ bridge pid=${lock.pid} port=${lock.port} unreachable (${result.error ?? `status ${result.status}`})\n`,
            );
            continue;
          }
          const j = result.json ?? {};
          const engaged = j.engaged === true ? "ENGAGED" : "released";
          const lockedSuffix = j.locked
            ? ` [env-locked: ${j.lockedReason ?? "yes"}]`
            : "";
          const wsLabel = lock.workspace
            ? path.join(
                path.basename(path.dirname(lock.workspace)),
                path.basename(lock.workspace),
              )
            : `pid=${lock.pid}`;
          process.stdout.write(
            `  ${engaged}  port=${lock.port} ${wsLabel}${lockedSuffix}\n`,
          );
        }
        process.exit(anyFailed ? 2 : 0);
      }

      // engage / release: POST to every live bridge, surface aggregate result.
      const engage = sub === "engage";
      let anyFailed = false;
      let anyChanged = false;
      for (const lock of liveLocks) {
        const result = await callBridge(lock, "POST", {
          engage,
          ...(reason ? { reason } : {}),
        });
        const wsLabel = lock.workspace
          ? path.join(
              path.basename(path.dirname(lock.workspace)),
              path.basename(lock.workspace),
            )
          : `pid=${lock.pid}`;
        if (result.status === 409) {
          anyFailed = true;
          const lr =
            (result.json?.lockedReason as string | undefined) ??
            "env-locked at boot";
          process.stderr.write(
            `  ✗ port=${lock.port} ${wsLabel}: cannot ${sub} — ${lr}\n`,
          );
          continue;
        }
        if (!result.ok) {
          anyFailed = true;
          process.stderr.write(
            `  ✗ port=${lock.port} ${wsLabel}: ${result.error ?? `status ${result.status}`}\n`,
          );
          continue;
        }
        const j = result.json ?? {};
        const changedTag =
          j.changed === true ? "" : " (no-op, already in state)";
        if (j.changed === true) anyChanged = true;
        process.stdout.write(
          `  ✓ port=${lock.port} ${wsLabel}: ${engage ? "ENGAGED" : "released"}${changedTag}\n`,
        );
      }
      if (anyFailed) {
        process.exit(2);
      }
      if (!anyChanged) {
        process.stdout.write(
          `\n  All ${liveLocks.length} bridge${liveLocks.length === 1 ? "" : "s"} already in target state — no audit emit.\n`,
        );
      } else {
        process.stdout.write(
          `\n  Kill-switch ${engage ? "engaged" : "released"} on ${liveLocks.length} bridge${liveLocks.length === 1 ? "" : "s"}.\n`,
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

// `patchwork panic` — alias for `patchwork kill-switch engage` (v2-Strong-2).
//
// Discoverable under stress (short command, obvious intent). Canonical noun
// form is `kill-switch engage`; this alias matches it so shell history six
// months later still makes sense. Does not accept sub-verbs — just runs engage.
if (process.argv[2] === "panic") {
  const extra = process.argv.slice(3); // e.g. --reason "..." --force-local
  // Guard against `panic --help` engaging the kill switch — a real
  // footgun if you tab-completed the verb to confirm syntax before
  // committing to the action. `panic` is an alias, so we honor --help
  // here ourselves rather than forwarding to kill-switch engage.
  if (extra.includes("--help") || extra.includes("-h")) {
    console.log(
      'Usage: patchwork panic [--reason "..."] [--force-local]\n\n' +
        "  Alias for `patchwork kill-switch engage` — blocks all write-tier\n" +
        "  tool calls across every running bridge. Use --reason to leave a\n" +
        "  note in the audit trail. Release with `patchwork kill-switch release`.\n",
    );
    process.exit(0);
  }
  // Spawn self with kill-switch engage to reuse the full handler without
  // duplicating 200+ LOC. Passes through any flags (--reason, --force-local).
  import("node:child_process").then(({ spawnSync }) => {
    const self = process.argv[1] ?? process.execPath;
    const result = spawnSync(
      process.execPath,
      [self, "kill-switch", "engage", ...extra],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  });
}

// `patchwork halts` — one-screen morning summary of recent recipe halts.
//
// Composes the haltReason field (#441), category aggregator + endpoint
// (#444), and dashboard pill conventions: queries the live bridge's
// /runs/halt-summary endpoint over the chosen window and prints a
// per-category breakdown plus the 5 most-recent halt reasons. Default
// window is "overnight" (since 6pm yesterday local) so it lines up with
// "what halted while I was asleep?".
if (process.argv[2] === "halts") {
  const args = process.argv.slice(3);
  const wantHelp = args.includes("--help") || args.includes("-h");
  if (wantHelp) {
    process.stdout.write(
      "Usage: patchwork halts [--window <name>] [--recipe <name>] [--json]\n" +
        "\n" +
        "  --window 1h | 24h | overnight | 7d | any   (default: overnight)\n" +
        "  --recipe <name>                            filter to one recipe by name\n" +
        "  --json                                     emit raw JSON (for scripting)\n" +
        "\n" +
        '"overnight" = since 6pm yesterday local time.\n',
    );
    process.exit(0);
  }
  type Win = "1h" | "24h" | "overnight" | "7d" | "any";
  function parseWindow(): Win {
    const idx = args.findIndex((a) => a === "--window" || a === "-w");
    const raw = idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "overnight";
    if (
      raw === "1h" ||
      raw === "24h" ||
      raw === "overnight" ||
      raw === "7d" ||
      raw === "any"
    )
      return raw;
    process.stderr.write(`Unknown --window value: "${raw}"\n`);
    process.exit(1);
  }
  function windowSinceMs(w: Win): number | null {
    if (w === "any") return null;
    if (w === "1h") return 60 * 60 * 1000;
    if (w === "24h") return 24 * 60 * 60 * 1000;
    if (w === "7d") return 7 * 24 * 60 * 60 * 1000;
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return Date.now() - d.getTime();
  }
  const window = parseWindow();
  const wantJson = args.includes("--json");
  const recipeIdx = args.findIndex((a) => a === "--recipe" || a === "-r");
  const recipeFilter =
    recipeIdx >= 0 && recipeIdx + 1 < args.length
      ? args[recipeIdx + 1]
      : undefined;

  (async () => {
    try {
      const { findAllLiveBridges } = await import("./bridgeLockDiscovery.js");
      const liveLocks = findAllLiveBridges();
      if (liveLocks.length === 0) {
        process.stderr.write(
          "No running bridge found. Start one with `patchwork start` (or `--driver subprocess`).\n",
        );
        process.exit(2);
      }
      const sinceMs = windowSinceMs(window);
      const params: string[] = [];
      if (sinceMs != null) params.push(`sinceMs=${sinceMs}`);
      if (recipeFilter)
        params.push(`recipe=${encodeURIComponent(recipeFilter)}`);
      const qs = params.length > 0 ? `?${params.join("&")}` : "";
      // Walk live bridges in order; first responsive one wins. See the
      // matching block in the `judgments` handler — findAllLiveBridges
      // can include stale entries when a recycled PID still answers
      // `kill(pid, 0)` but the lock points at a dead bridge.
      let res: Response | null = null;
      let lastStatus = 0;
      for (const lock of liveLocks) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const candidate = await fetch(
            `http://127.0.0.1:${lock.port}/runs/halt-summary${qs}`,
            {
              headers: { Authorization: `Bearer ${lock.authToken}` },
              signal: controller.signal,
            },
          );
          if (candidate.ok) {
            res = candidate;
            break;
          }
          lastStatus = candidate.status;
        } catch {
          /* unreachable lock — try next */
        } finally {
          clearTimeout(timer);
        }
      }
      if (!res) {
        process.stderr.write(
          `No live bridge served /runs/halt-summary (last status: ${lastStatus || "unreachable"}).\n`,
        );
        process.exit(1);
      }
      const summary = (await res.json()) as {
        total: number;
        byCategory: Record<string, number>;
        recent: Array<{ reason: string; category: string; runSeq: number }>;
      };

      if (wantJson) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        process.exit(0);
      }

      // Shared label + hint maps (also used by `recipe doctor` and
      // mirrored in the dashboard) so the wording stays consistent.
      const { HALT_CATEGORY_LABELS, HALT_CATEGORY_HINTS } = await import(
        "./recipes/haltCategory.js"
      );

      const windowLabel: Record<Win, string> = {
        "1h": "last hour",
        "24h": "last 24h",
        overnight: "since 6pm yesterday",
        "7d": "last 7 days",
        any: "all time",
      };

      const recipeSuffix = recipeFilter ? ` · recipe="${recipeFilter}"` : "";
      process.stdout.write(`Halts — ${windowLabel[window]}${recipeSuffix}\n`);
      process.stdout.write(`Total: ${summary.total}\n`);
      if (summary.total === 0) {
        process.stdout.write("\n  (nothing halted in this window)\n");
        process.exit(0);
      }

      const entries = Object.entries(summary.byCategory).sort(
        ([, a], [, b]) => b - a,
      );
      process.stdout.write("\nBy category:\n");
      for (const [cat, count] of entries) {
        const label =
          HALT_CATEGORY_LABELS[cat as keyof typeof HALT_CATEGORY_LABELS] ?? cat;
        const hint =
          HALT_CATEGORY_HINTS[cat as keyof typeof HALT_CATEGORY_HINTS];
        const hintSuffix = hint ? `  — ${hint}` : "";
        process.stdout.write(
          `  ${String(count).padStart(3)}  ${label}${hintSuffix}\n`,
        );
      }

      if (summary.recent.length > 0) {
        process.stdout.write("\nMost recent:\n");
        for (const r of summary.recent) {
          // Truncate the reason to ~120 chars so a wide stack trace
          // can't blow up the terminal width on phones / narrow panes.
          const reason =
            r.reason.length > 120 ? `${r.reason.slice(0, 117)}…` : r.reason;
          process.stdout.write(`  #${r.runSeq}  [${r.category}]  ${reason}\n`);
        }
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

// `patchwork connect` — connector front-door. Thin CLI→HTTP shim over the
// bridge's `/connections/*` routes (list / OAuth auth / PAT connect / test /
// disconnect). This is the command the 23 connector "Run: patchwork connect
// <vendor>" error messages point at. Lock discovery reuses the same
// isBridge:true + live-PID selector as `recipe run`, `quick-task`, etc.
if (process.argv[2] === "connect") {
  (async () => {
    const { runConnect } = await import("./commands/connect.js");
    const { findBridgeLockForTask } = await import("./commands/task.js");
    await runConnect(process.argv.slice(3), {
      findBridgeLock: (port?: number) => findBridgeLockForTask(port),
    });
  })();
}

// `patchwork analytics` — manage the self-hosted telemetry collector config.
// Replaces the brittle "endpoint+secret in launchd plist" pattern with a
// proper config file the bridge reads at startup.
if (process.argv[2] === "analytics") {
  (async () => {
    const { runAnalyticsCommand } = await import("./commands/analytics.js");
    const code = await runAnalyticsCommand(process.argv.slice(3));
    process.exit(code);
  })();
}

// `patchwork judgments` — PR3b sibling of `patchwork halts`. Same window
// + recipe filter shape; queries /runs/judge-summary and prints a
// per-verdict breakdown plus the 5 most-recent verdicts.
if (process.argv[2] === "judgments") {
  const args = process.argv.slice(3);
  const wantHelp = args.includes("--help") || args.includes("-h");
  if (wantHelp) {
    process.stdout.write(
      "Usage: patchwork judgments [--window <name>] [--recipe <name>] [--json]\n" +
        "\n" +
        "  --window 1h | 24h | overnight | 7d | any   (default: overnight)\n" +
        "  --recipe <name>                            filter to one recipe by name\n" +
        "  --json                                     emit raw JSON (for scripting)\n" +
        "\n" +
        '"overnight" = since 6pm yesterday local time.\n',
    );
    process.exit(0);
  }
  type Win = "1h" | "24h" | "overnight" | "7d" | "any";
  function parseWindow(): Win {
    const idx = args.findIndex((a) => a === "--window" || a === "-w");
    const raw = idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "overnight";
    if (
      raw === "1h" ||
      raw === "24h" ||
      raw === "overnight" ||
      raw === "7d" ||
      raw === "any"
    )
      return raw;
    process.stderr.write(`Unknown --window value: "${raw}"\n`);
    process.exit(1);
  }
  function windowSinceMs(w: Win): number | null {
    if (w === "any") return null;
    if (w === "1h") return 60 * 60 * 1000;
    if (w === "24h") return 24 * 60 * 60 * 1000;
    if (w === "7d") return 7 * 24 * 60 * 60 * 1000;
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return Date.now() - d.getTime();
  }
  const window = parseWindow();
  const wantJson = args.includes("--json");
  const recipeIdx = args.findIndex((a) => a === "--recipe" || a === "-r");
  const recipeFilter =
    recipeIdx >= 0 && recipeIdx + 1 < args.length
      ? args[recipeIdx + 1]
      : undefined;

  (async () => {
    try {
      const { findAllLiveBridges } = await import("./bridgeLockDiscovery.js");
      const liveLocks = findAllLiveBridges();
      if (liveLocks.length === 0) {
        process.stderr.write(
          "No running bridge found. Start one with `patchwork start` (or `--driver subprocess`).\n",
        );
        process.exit(2);
      }
      const sinceMs = windowSinceMs(window);
      const params: string[] = [];
      if (sinceMs != null) params.push(`sinceMs=${sinceMs}`);
      if (recipeFilter)
        params.push(`recipe=${encodeURIComponent(recipeFilter)}`);
      const qs = params.length > 0 ? `?${params.join("&")}` : "";
      // Walk live bridges in order; the first responsive one wins.
      // findAllLiveBridges uses `kill(pid, 0)` for liveness, which
      // returns true for any recycled PID — so liveLocks can contain
      // stale entries from dead bridges. Previously we picked [0]
      // unconditionally and surfaced a confusing 404; now we try each
      // and only fall through to the error path when *all* fail.
      let res: Response | null = null;
      let lastStatus = 0;
      for (const lock of liveLocks) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const candidate = await fetch(
            `http://127.0.0.1:${lock.port}/runs/judge-summary${qs}`,
            {
              headers: { Authorization: `Bearer ${lock.authToken}` },
              signal: controller.signal,
            },
          );
          if (candidate.ok) {
            res = candidate;
            break;
          }
          lastStatus = candidate.status;
        } catch {
          /* unreachable lock — try next */
        } finally {
          clearTimeout(timer);
        }
      }
      if (!res) {
        process.stderr.write(
          `No live bridge served /runs/judge-summary (last status: ${lastStatus || "unreachable"}).\n`,
        );
        process.exit(1);
      }
      const summary = (await res.json()) as {
        total: number;
        byVerdict: Record<string, number>;
        recent: Array<{
          verdict: string;
          firstReason?: string;
          runSeq: number;
          stepId: string;
        }>;
      };

      if (wantJson) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        process.exit(0);
      }

      const labels: Record<string, string> = {
        approve: "approve",
        request_changes: "request changes",
        unparseable: "unparseable",
      };
      const windowLabel: Record<Win, string> = {
        "1h": "last hour",
        "24h": "last 24h",
        overnight: "since 6pm yesterday",
        "7d": "last 7 days",
        any: "all time",
      };

      const recipeSuffix = recipeFilter ? ` · recipe="${recipeFilter}"` : "";
      process.stdout.write(
        `Judgments — ${windowLabel[window]}${recipeSuffix}\n`,
      );
      process.stdout.write(`Total: ${summary.total}\n`);
      if (summary.total === 0) {
        process.stdout.write("\n  (no judge steps fired in this window)\n");
        process.exit(0);
      }

      const entries = Object.entries(summary.byVerdict).sort(
        ([, a], [, b]) => b - a,
      );
      process.stdout.write("\nBy verdict:\n");
      for (const [verdict, count] of entries) {
        const label = labels[verdict] ?? verdict;
        process.stdout.write(`  ${String(count).padStart(3)}  ${label}\n`);
      }

      if (summary.recent.length > 0) {
        process.stdout.write("\nMost recent:\n");
        for (const r of summary.recent) {
          const reason = r.firstReason
            ? r.firstReason.length > 120
              ? `${r.firstReason.slice(0, 117)}…`
              : r.firstReason
            : "(no reason)";
          process.stdout.write(
            `  #${r.runSeq}  [${r.verdict}]  ${r.stepId}: ${reason}\n`,
          );
        }
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
// With `--interactive`, drops into a connector-aware prompt tree instead.
if (process.argv[2] === "recipe" && process.argv[3] === "new") {
  const args = process.argv.slice(4);
  const isInteractive = args.includes("--interactive") || args.includes("-i");
  if (isInteractive) {
    (async () => {
      try {
        const { runNewInteractive } = await import("./commands/recipe.js");
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const outIdx = args.indexOf("--out");
        const outRaw = outIdx >= 0 ? args[outIdx + 1] : undefined;
        const outputDir = outRaw ? path.resolve(outRaw) : undefined;
        const deps = {
          ask: async (q: string) => (await rl.question(`${q}: `)).trim(),
          pickFromList: async (q: string, options: string[]) => {
            process.stdout.write(`\n${q}\n`);
            options.forEach((opt, i) => {
              process.stdout.write(`  ${i + 1}. ${opt}\n`);
            });
            for (let attempt = 0; attempt < 5; attempt++) {
              const raw = (
                await rl.question(`Choose 1-${options.length}: `)
              ).trim();
              const idx = Number.parseInt(raw, 10);
              if (Number.isFinite(idx) && idx >= 1 && idx <= options.length) {
                return idx;
              }
              process.stdout.write(
                `Invalid choice. Enter a number 1-${options.length}.\n`,
              );
            }
            throw new Error("Too many invalid choices");
          },
          confirm: async (q: string) => {
            const a = (await rl.question(`${q} [y/N]: `)).trim().toLowerCase();
            return a === "y" || a === "yes";
          },
          preview: (yaml: string) => {
            process.stdout.write("\n--- Preview ---\n");
            process.stdout.write(yaml);
            process.stdout.write("---\n\n");
          },
        };
        const result = await runNewInteractive({
          deps,
          ...(outputDir ? { outputDir } : {}),
        });
        rl.close();
        process.stdout.write(`  ✓ Created ${result.path}\n`);
        if (result.warnings.length > 0) {
          process.stdout.write(`\n  ⚠ Lint warnings (recipe still written):\n`);
          for (const w of result.warnings) {
            process.stdout.write(`    [${w.level}] ${w.message}\n`);
          }
        }
        process.stdout.write(
          `\n  Run with: patchwork recipe run ${result.path}\n`,
        );
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    })();
  } else {
    const recipeName = args[0];
    if (!recipeName) {
      process.stderr.write(
        "Usage: patchwork recipe new <name> [--template <name>] [--desc <description>] [--out <dir>]\n" +
          "  --interactive (-i)  Run the connector-aware prompt tree instead of using a template.\n" +
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

// Patchwork: `patchwork recipe audit-env <recipe>` — check {{env.FOO}} references are satisfied.
if (process.argv[2] === "recipe" && process.argv[3] === "audit-env") {
  const recipeArg = process.argv[4];
  if (!recipeArg) {
    process.stderr.write(
      "Usage: patchwork recipe audit-env <recipe> [--env-file <path>] [--workspace <path>]\n",
    );
    process.exit(1);
  }
  (async () => {
    try {
      const args = process.argv.slice(5);
      const envFileIdx = args.indexOf("--env-file");
      const envFile = envFileIdx !== -1 ? args[envFileIdx + 1] : undefined;
      const workspaceIdx = args.indexOf("--workspace");
      const workspace =
        workspaceIdx !== -1 && args[workspaceIdx + 1]
          ? args[workspaceIdx + 1]
          : process.cwd();

      const { runAuditEnv } = await import("./commands/auditEnv.js");
      const result = await runAuditEnv(recipeArg, {
        ...(envFile ? { envFile } : {}),
        workspace,
      });

      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          process.stderr.write(`  ⚠ ${w}\n`);
        }
      }
      if (result.present.length > 0) {
        for (const v of result.present) {
          process.stdout.write(`  ✓ ${v}\n`);
        }
      }
      if (result.missing.length > 0) {
        for (const v of result.missing) {
          process.stderr.write(`  ✗ missing: ${v}\n`);
        }
      }
      if (!result.ok) {
        process.exit(1);
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

// `recipe simulate <name|file>` — What-If Preview. Statically simulates a
// recipe before it is enabled: projected actions, side-effect taxonomy,
// blast-radius risk, tier-only approval projection (honestly flagged as NOT
// gated on recipe steps today), low-confidence cost, and undetermined
// conditional branches. Executes nothing. See runRecipeSimulate in
// commands/recipe.ts.
if (process.argv[2] === "recipe" && process.argv[3] === "simulate") {
  const args = process.argv.slice(4);
  const usage =
    "Usage: patchwork recipe simulate <name|file.yaml> [--json] [--step <id>] [--var k=v]\n\n" +
    "What-If Preview: statically simulate a recipe before enabling it.\n" +
    "Shows projected actions, side effects, risk, approvals (tier-only),\n" +
    "cost (low-confidence), and undetermined branches. Executes nothing.\n";
  let json = false;
  let step: string | undefined;
  const vars: Record<string, string> = {};
  let target: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--step" || arg.startsWith("--step=")) {
      const value = arg === "--step" ? args[++i] : arg.slice("--step=".length);
      if (!value) {
        process.stderr.write(`Error: --step requires a value\n${usage}`);
        process.exit(1);
      }
      step = value;
      continue;
    }
    if (arg === "--var" || arg.startsWith("--var=")) {
      const value = arg === "--var" ? args[++i] : arg.slice("--var=".length);
      if (!value?.includes("=")) {
        process.stderr.write(`Error: --var requires k=v\n${usage}`);
        process.exit(1);
      }
      const idx = value.indexOf("=");
      vars[value.slice(0, idx)] = value.slice(idx + 1);
      continue;
    }
    if (!arg.startsWith("--")) {
      target = arg;
    }
  }

  if (!target) {
    process.stderr.write(usage);
    process.exit(1);
  }

  (async () => {
    try {
      const { runRecipeSimulate } = await import("./commands/recipe.js");
      const report = await runRecipeSimulate(target as string, {
        ...(step ? { step } : {}),
        ...(Object.keys(vars).length ? { vars } : {}),
      });

      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exit(0);
      }

      const out = process.stdout;
      const mark = (tier: string): string =>
        tier === "high" ? "●" : tier === "medium" ? "◐" : "○";
      const fidelityLabel =
        report.fidelity === "mocked"
          ? `mocked fidelity, ${report.sampleRuns ?? 0} prior run(s)`
          : `${report.fidelity} fidelity`;
      out.write(
        `\n  What-If Preview — ${report.recipe} (${report.topology}, ${fidelityLabel})\n`,
      );
      out.write(
        `  Trigger: ${report.triggerType} · ${report.summary.totalSteps} step(s)\n\n`,
      );
      out.write(
        `  Risk: ${report.risk.tier.toUpperCase()} (score ${report.risk.score}/100)\n`,
      );
      const c = report.risk.components;
      out.write(
        `    high:${c.highSteps} medium:${c.mediumSteps} writes:${c.writeSteps} connector-writes:${c.connectorWriteSteps} http:${c.externalHttpSteps} unresolved:${c.unresolvedSteps}\n\n`,
      );
      out.write("  Actions:\n");
      for (const s of report.steps) {
        const tool = s.tool ?? s.type;
        const when = s.condition ? `  when: ${s.condition}` : "";
        out.write(
          `    ${mark(s.effectiveRisk)} ${s.id}  ${tool}  [${s.sideEffect}]${when}\n`,
        );
      }
      out.write("\n");
      const ns = report.summary.connectorNamespaces;
      out.write(
        `  Side effects: ${report.summary.writeSteps} write(s) · ${report.summary.connectorSteps} connector call(s)${
          ns.length ? ` (${ns.join(", ")})` : ""
        } · ${report.summary.agentSteps} agent step(s)\n`,
      );
      const gating = report.approvals.projected.filter(
        (a) => a.wouldRequireApproval,
      ).length;
      out.write(
        `  Approvals: ${gating} step(s) would gate IF recipe steps were gated — they are NOT gated today\n`,
      );
      {
        const c = report.cost;
        const toks =
          typeof c.estInputTokens === "number"
            ? ` ~${c.estInputTokens} in / ${c.estOutputTokens ?? 0} out tokens`
            : typeof c.estPromptTokens === "number"
              ? ` ~${c.estPromptTokens} input tokens`
              : "";
        const usd =
          typeof c.usd === "number"
            ? ` ≈$${c.usd.toFixed(4)}${
                typeof c.minUsd === "number" && typeof c.maxUsd === "number"
                  ? ` ($${c.minUsd.toFixed(4)}–$${c.maxUsd.toFixed(4)})`
                  : ""
              }`
            : "";
        const conf = c.confidence ? `/${c.confidence}` : "";
        out.write(`  Cost [${c.basis}${conf}]:${toks}${usd}\n`);
        out.write(`    ${c.note}\n`);
      }
      if (report.branches.length > 0) {
        if (report.fidelity === "mocked") {
          const taken = report.branches.filter(
            (b) => b.outcome === "taken",
          ).length;
          const skipped = report.branches.filter(
            (b) => b.outcome === "skipped",
          ).length;
          const undet = report.branches.filter(
            (b) => b.outcome === "undetermined",
          ).length;
          out.write(
            `  Branches: ${report.branches.length} conditional — ${taken} taken, ${skipped} skipped, ${undet} undetermined\n`,
          );
          for (const b of report.branches) {
            out.write(
              `    ${b.outcome.padEnd(12)} ${b.stepId}  ${b.condition}\n`,
            );
          }
        } else {
          out.write(
            `  Branches: ${report.branches.length} conditional — undetermined (resolve in a later sandbox phase)\n`,
          );
        }
      }
      if (report.lint.errors.length > 0 || report.lint.warnings.length > 0) {
        out.write(
          `  Lint: ${report.lint.errors.length} error(s), ${report.lint.warnings.length} warning(s)\n`,
        );
      }
      out.write("\n  Notes:\n");
      for (const n of report.notes) out.write(`    • ${n}\n`);
      out.write("\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// `recipe doctor <name|file>` — one-screen "why is this recipe unhealthy
// + how do I fix it" diagnosis. Composes the static preflight check with
// the recipe-scoped runtime halt summary from a live bridge (fail-soft:
// no bridge → static-only). See runRecipeDoctor in commands/recipe.ts.
if (process.argv[2] === "recipe" && process.argv[3] === "doctor") {
  const args = process.argv.slice(4);
  const usage =
    "Usage: patchwork recipe doctor <name|file.yaml> [--json] [--local]\n\n" +
    "Diagnoses a recipe: lint + write-policy + plan (static) plus recent\n" +
    "runtime halts from a live bridge, each mapped to a fix hint.\n" +
    "--local skips the bridge runtime check. Exits 1 when unhealthy.\n";
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    process.exit(0);
  }
  const wantJson = args.includes("--json");
  const localOnly = args.includes("--local");
  const ref = args.find((a) => !a.startsWith("--"));
  if (!ref) {
    process.stderr.write(usage);
    process.exit(1);
  }

  (async () => {
    try {
      const { runRecipeDoctor, formatRecipeDoctorReport } = await import(
        "./commands/recipe.js"
      );

      // Runtime halt fetcher: walk live bridges, query the recipe-scoped
      // halt summary over the last 7 days. Returns null when no bridge is
      // reachable so doctor degrades to static-only.
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const fetchHalts = localOnly
        ? undefined
        : async (recipeName: string) => {
            const { findAllLiveBridges } = await import(
              "./bridgeLockDiscovery.js"
            );
            const liveLocks = findAllLiveBridges();
            if (liveLocks.length === 0) return null;
            const sinceMs = Date.now() - SEVEN_DAYS_MS;
            const qs = `?sinceMs=${sinceMs}&recipe=${encodeURIComponent(recipeName)}`;
            for (const lock of liveLocks) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 10_000);
              try {
                const res = await fetch(
                  `http://127.0.0.1:${lock.port}/runs/halt-summary${qs}`,
                  {
                    headers: { Authorization: `Bearer ${lock.authToken}` },
                    signal: controller.signal,
                  },
                );
                if (res.ok) {
                  return (await res.json()) as {
                    total: number;
                    byCategory: Record<string, number>;
                    recent: Array<{
                      reason: string;
                      category: string;
                      runSeq: number;
                    }>;
                  };
                }
              } catch {
                /* unreachable lock — try next */
              } finally {
                clearTimeout(timer);
              }
            }
            return null;
          };

      // Connector auth fetcher: walk live bridges, GET /connections to read
      // each connector's status. Returns null when no bridge is reachable so
      // doctor degrades to static-only (lists required connectors, no auth).
      const fetchConnections = localOnly
        ? undefined
        : async () => {
            const { findAllLiveBridges } = await import(
              "./bridgeLockDiscovery.js"
            );
            const liveLocks = findAllLiveBridges();
            if (liveLocks.length === 0) return null;
            for (const lock of liveLocks) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 10_000);
              try {
                const res = await fetch(
                  `http://127.0.0.1:${lock.port}/connections`,
                  {
                    headers: { Authorization: `Bearer ${lock.authToken}` },
                    signal: controller.signal,
                  },
                );
                if (res.ok) {
                  const body = (await res.json()) as {
                    connectors?: Array<{ id?: string; status?: string }>;
                  };
                  return body.connectors ?? [];
                }
              } catch {
                /* unreachable lock — try next */
              } finally {
                clearTimeout(timer);
              }
            }
            return null;
          };

      const result = await runRecipeDoctor(ref as string, {
        fetchHalts,
        fetchConnections,
      });

      if (wantJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(formatRecipeDoctorReport(result));
      }
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
        // Windows: editor binaries (code/cursor/windsurf) are `.cmd` shims that
        // Node's execFileSync can't launch without a shell. See bridgeProcess.ts.
        execFileSync(editor, ["--install-extension", extensionArg2], {
          stdio: "pipe",
          timeout: 30000,
          shell: process.platform === "win32",
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
      // claude -p spawns the stdio command via Node's child_process, which
      // can't resolve a bare `.cmd` shim on Windows. Record the `.cmd` form
      // on win32 so the bridge binary is findable by the spawned process.
      //
      // This global entry stays even though the project also gets a
      // `patchwork` MCP server (project .mcp.json / project config) covering
      // this same workspace — VS Code/Windsurf/Cursor launches inject
      // --mcp-config, which overrides any project .mcp.json entirely, so
      // this ~/.claude.json entry is the ONLY way bridge tools are wired
      // under an IDE launch. Pin --workspace so that when multiple bridges
      // are running (this one plus others elsewhere), the workspace-aware
      // lock discovery in mcp-stdio-shim.cjs picks THIS project's lock
      // instead of falling back to cwd-based guessing or the wrong bridge.
      mcpServers["claude-ide-bridge"] = {
        command: ensureCmdShim("claude-ide-bridge"),
        args: ["shim", "--workspace", workspace],
        type: "stdio",
      };
      claudeJson.mcpServers = mcpServers;
      // Atomic — `~/.claude.json` holds every MCP server registration on
      // the machine. A crash mid-write would brick Claude Code globally.
      writeFileAtomicSync(
        claudeJsonAbs,
        `${JSON.stringify(claudeJson, null, 2)}\n`,
      );
      process.stderr.write(
        `  ✓ MCP shim — registered in ${claudeJsonAbs}\n     Note: bridge tools are wired via ~/.claude.json (global), not .mcp.json.\n     This is intentional — when VS Code/Windsurf/Cursor launches Claude Code it\n     injects --mcp-config which overrides any project .mcp.json. Only ~/.claude.json\n     is always loaded. You do not need to add anything to .mcp.json.\n\n`,
      );
    }
  } catch {
    process.stderr.write(
      `  [warn] Could not update ${claudeJsonAbs} — add manually:\n         { "mcpServers": { "claude-ide-bridge": { "command": "claude-ide-bridge", "args": ["shim", "--workspace", "${workspace}"] } } }\n\n`,
    );
  }

  // Step 3b: Wire CC hooks in ~/.claude/settings.json
  const ccConfigDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const ccSettingsPath = path.join(ccConfigDir, "settings.json");
  // On a truly fresh machine ~/.claude/ may not exist yet. Every settings.json
  // writer below (CC hooks, the IDE-skip env step, the PreToolUse hook) does an
  // atomic write that needs the parent dir to exist — without this, all three
  // silently fail with ENOENT and the user's onboarding state is never persisted.
  try {
    mkdirSync(ccConfigDir, { recursive: true });
  } catch {
    // best-effort — the individual writers below surface their own warnings
  }
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
      // Atomic — `~/.claude/settings.json` holds every CC hook entry; a
      // crash mid-write loses the user's full hook configuration.
      writeFileAtomicSync(
        ccSettingsPath,
        `${JSON.stringify(ccSettings, null, 2)}\n`,
      );
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

  // Step 3c: Persist CLAUDE_CODE_IDE_SKIP_VALID_CHECK into the settings.json
  // `env` block so `claude --ide` connects without the user prefixing the var
  // on every launch. The bridge writes its own ~/.claude/ide/<port>.lock, but
  // Claude Code's `--ide` "valid check" is an in-IDE-terminal detection that a
  // standalone bridge can't satisfy by lock-file shape alone — so we set the
  // skip flag where Patchwork already manages CC config (NOT the shell rc).
  try {
    const { registerSkipIdeValidCheckEnv } = await import("./settingsEnv.js");
    const envResult = registerSkipIdeValidCheckEnv(ccSettingsPath);
    if (envResult.action === "added") {
      process.stderr.write(
        `  ✓ IDE connect — set CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true in ${ccSettingsPath}\n     You can now run a plain \`claude --ide\` — no env-var prefix needed.\n\n`,
      );
    } else if (envResult.action === "already-present") {
      process.stderr.write(
        `  ✓ IDE connect — CLAUDE_CODE_IDE_SKIP_VALID_CHECK already set in ${ccSettingsPath}\n\n`,
      );
    } else if (envResult.action === "preserved-user-value") {
      process.stderr.write(
        `  [info] IDE connect — left your CLAUDE_CODE_IDE_SKIP_VALID_CHECK="${envResult.existingValue}" untouched.\n` +
          `         If \`claude --ide\` won't connect, set it to "true" in ${ccSettingsPath}.\n\n`,
      );
    } else {
      process.stderr.write(
        `  [warn] IDE connect — could not set CLAUDE_CODE_IDE_SKIP_VALID_CHECK (${envResult.error}).\n` +
          `         Add { "env": { "CLAUDE_CODE_IDE_SKIP_VALID_CHECK": "true" } } to ${ccSettingsPath} manually.\n\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `  [warn] IDE connect — ${err instanceof Error ? err.message : String(err)}\n\n`,
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
      // Windows: global npm bin is a `.cmd` shim that Node's execFileSync
      // can't launch without a shell. See bridgeProcess.ts for context.
      shell: process.platform === "win32",
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
      "  3. Connect Claude Code: claude --ide   (the IDE-detection skip flag is\n" +
      "       already set in ~/.claude/settings.json — no env-var prefix needed).\n" +
      "  4. Type /mcp — the claude-ide-bridge server should show as connected,\n" +
      "       then /ide to see live workspace state (open editors, diagnostics, git).\n" +
      "  5. Run your first recipe (no connectors needed — local git + a brief):\n" +
      "       patchwork recipe run daily-status --local\n" +
      "       Writes a morning brief to ~/.patchwork/inbox/. Try --dry-run first to\n" +
      "       see the plan without spending tokens.\n\n",
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
    const { isPreToolUseHookRegistered } = await import("./preToolUseHook.js");
    hooksWired = isPreToolUseHookRegistered(settingsPath);
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
      // Use execFile with argv — exec(`code "${target}"`) was shell-evaluated
      // and could be injected via `--workspace '"; ...'`. Audit 2026-05-17.
      // Windows: code is a .cmd shim; shell:true lets cmd.exe resolve it
      // without needing ensureCmdShim (args-as-array prevents injection).
      // Wrap in try-catch: in Node 22 on Windows, spawn errors can throw
      // synchronously before the callback is registered.
      try {
        const { execFile } = await import("node:child_process");
        execFile(
          "code",
          [target],
          { timeout: 3000, shell: process.platform === "win32" },
          () => {},
        );
      } catch {
        // best-effort — VS Code may not be installed
      }
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
    // Windows: editor binaries are `.cmd` shims; need shell for resolution.
    execFileSync(editor, ["--install-extension", extensionArg], {
      stdio: "inherit",
      timeout: 30000,
      shell: process.platform === "win32",
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
  // --port wins over PATCHWORK_BRIDGE_PORT wins over workspace-aware discovery.
  const portArg =
    portIdx !== -1 ? argv[portIdx + 1] : process.env.PATCHWORK_BRIDGE_PORT;
  const jsonFlag = argv.includes("--json");

  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );

  let lockFile: string | undefined;
  let lockPort: string | undefined;

  if (portArg) {
    // Validate before path.join — path.join does not block traversal, so an
    // unsanitized `--port ../../../etc/passwd` would read an arbitrary
    // `*.lock` file outside lockDir and leak its JSON contents
    // (cli-commands-1).
    const portNum = Number(portArg);
    if (
      !/^\d{1,5}$/.test(portArg) ||
      !Number.isInteger(portNum) ||
      portNum < 1 ||
      portNum > 65535
    ) {
      process.stderr.write("Error: --port must be a valid port number\n");
      process.exit(1);
    }
    lockFile = path.join(lockDir, `${portArg}.lock`);
    lockPort = portArg;
    if (!existsSync(lockFile)) {
      process.stderr.write(
        `Error: No lock file found for port ${portArg} at ${lockFile}\n`,
      );
      process.exit(1);
    }
  } else {
    // Workspace-aware, isBridge-filtered, live-PID-filtered discovery — the
    // same helper the MCP shim and task runner use (#1052/#1054 fixed the
    // shim's copy of this bug; this was a separate, unfixed copy that instead
    // picked the newest-mtime `.lock` file in the directory with no isBridge
    // check, so an unrelated editor's IDE-owned lock — or a stale bridge from
    // a different workspace — could shadow the real bridge's status).
    const { findBridgeLock } = await import("./bridgeLockDiscovery.js");
    const found = findBridgeLock({ lockDir });
    if (found) {
      lockFile = path.join(lockDir, `${found.port}.lock`);
      lockPort = String(found.port);
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

// `patchwork doctor` — run CLI-safe bridge health checks.
if (process.argv[2] === "doctor") {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: patchwork doctor [--workspace <path>] [--port <n>] [--json]\n\n" +
        "Runs bridge health checks (workspace, git, lock file, automation policy).\n" +
        "Exits 1 if any check fails.\n",
    );
    process.exit(0);
  }
  (async () => {
    try {
      const workspaceIdx = args.indexOf("--workspace");
      const workspace =
        workspaceIdx !== -1 && args[workspaceIdx + 1]
          ? args[workspaceIdx + 1]
          : process.cwd();
      const portIdx = args.indexOf("--port");
      const portArg = portIdx !== -1 ? args[portIdx + 1] : undefined;
      const port = portArg !== undefined ? Number(portArg) : undefined;
      const jsonFlag = args.includes("--json");

      const { runDoctor } = await import("./commands/doctor.js");
      const result = await runDoctor({ workspace, port, json: jsonFlag });

      if (jsonFlag) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        for (const check of result.checks) {
          const icon =
            check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
          const detail = check.detail ? `  ${check.detail}` : "";
          process.stdout.write(`  ${icon} ${check.name}${detail}\n`);
          if (check.suggestion) {
            process.stdout.write(`      → ${check.suggestion}\n`);
          }
        }
      }

      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// `patchwork shadow-scan` — replay run history through the destructive-tool classifier.
if (process.argv[2] === "shadow-scan") {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: patchwork shadow-scan [--since <duration|ISO>] [--limit <n>] [--runs-file <path>] [--json]\n\n" +
        "Replays historical run data through the destructive-tool classifier.\n" +
        "Exits 1 if any runs would be reclassified.\n\n" +
        "  --since <duration|ISO>  Lookback window, e.g. '24h', '7d', or ISO date (default: 7d)\n" +
        "  --limit <n>             Cap the number of runs to scan\n" +
        "  --runs-file <path>      Override default ~/.claude/ide/runs.jsonl path\n" +
        "  --json                  Emit JSON output\n",
    );
    process.exit(0);
  }
  (async () => {
    try {
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined;
      const limitIdx = args.indexOf("--limit");
      const limitArg = limitIdx !== -1 ? args[limitIdx + 1] : undefined;
      const limit = limitArg !== undefined ? Number(limitArg) : undefined;
      const runsFileIdx = args.indexOf("--runs-file");
      const runsFile = runsFileIdx !== -1 ? args[runsFileIdx + 1] : undefined;
      const jsonFlag = args.includes("--json");

      const { runShadowScanCli } = await import("./commands/shadowScan.js");
      await runShadowScanCli({
        ...(since !== undefined ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(runsFile !== undefined
          ? { runsFile, workspace: process.cwd() }
          : {}),
        json: jsonFlag,
      });
      // runShadowScanCli sets process.exitCode = 1 on reclassified > 0; no explicit exit needed.
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Handle workers subcommand — read-only worker trust-dial (shadow). Replays the
// recipe run log + gate decision log through the (worker × action-class) ramp
// and prints the dial + a "ramp would vs gate did" comparison. Changes nothing.
if (process.argv[2] === "workers") {
  const args = process.argv.slice(3);
  const sub = args[0];
  if (
    (sub !== "shadow" && sub !== "backtest") ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    process.stdout.write(
      "Usage: patchwork workers <shadow|backtest> [--workers-dir <path>]\n\n" +
        "  shadow    Read-only worker trust dial: replays ~/.patchwork/runs.jsonl\n" +
        "            + the gate decision log through the (worker × action-class)\n" +
        "            ramp. Computes what the ramp WOULD decide vs what the gate DID.\n" +
        "  backtest  Replays each worker's history and reports DIVERGENCE: where the\n" +
        "            ramp would have auto-run a bad action (false-allow, the risk) or\n" +
        "            gated a good one (false-gate, the cost). Calibration, not a\n" +
        "            success rate. Neither command changes a live decision.\n\n" +
        "  --workers-dir <path>  Where *.worker.yaml live (default ~/.patchwork/workers)\n",
    );
    process.exit(0);
  }
  (async () => {
    try {
      const dirIdx = args.indexOf("--workers-dir");
      const workersDir = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
      const { runWorkerShadowReport, runWorkerBacktest } = await import(
        "./workers/runWorkerShadow.js"
      );
      const opts = workersDir ? { workersDir } : {};
      process.stdout.write(
        sub === "backtest"
          ? runWorkerBacktest(opts)
          : runWorkerShadowReport(opts),
      );
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Handle approvals subcommand — considered-approval KPI. Reads the local
// approval-decision log directly (like `workers shadow`); no bridge round-trip.
// The lens that tells you whether the trust climbing the worker dial was EARNED
// or rubber-stamped: reject rate, latency-to-decision, abandoned, channel split.
if (process.argv[2] === "approvals") {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: patchwork approvals [--window 1h|24h|overnight|7d|any] [--json]\n\n" +
        "Considered-approval KPI from the local approval-decision log:\n" +
        "  reject rate · latency-to-decision · abandoned · dashboard-vs-phone.\n\n" +
        "  --window <name>  lookback (default: any). overnight = since 6pm yesterday.\n" +
        "  --json           emit raw JSON (for scripting)\n",
    );
    process.exit(0);
  }
  (async () => {
    try {
      const wIdx = args.findIndex((a) => a === "--window" || a === "-w");
      const win =
        wIdx >= 0 && wIdx + 1 < args.length
          ? (args[wIdx + 1] as string)
          : "any";
      const fixed: Record<string, number | null> = {
        "1h": 3_600_000,
        "24h": 86_400_000,
        "7d": 604_800_000,
        any: null,
      };
      let sinceMs: number | undefined;
      if (win === "overnight") {
        const d = new Date();
        d.setHours(18, 0, 0, 0);
        if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
        sinceMs = d.getTime();
      } else if (Object.hasOwn(fixed, win)) {
        const dur = fixed[win];
        sinceMs = dur == null ? undefined : Date.now() - dur;
      } else {
        process.stderr.write(`Unknown --window value: "${win}"\n`);
        process.exit(1);
      }
      const {
        readConsideredDecisions,
        computeConsideredApprovalKpi,
        formatConsideredApprovalKpi,
      } = await import("./approvalKpi.js");
      const decisions = readConsideredDecisions(
        sinceMs !== undefined ? { sinceMs } : {},
      );
      const kpi = computeConsideredApprovalKpi(decisions);
      process.stdout.write(
        args.includes("--json")
          ? `${JSON.stringify(kpi, null, 2)}\n`
          : `${formatConsideredApprovalKpi(kpi, { windowLabel: win })}\n`,
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
}

// Handle gate subcommand — "why did the worker allow/gate THIS action" over
// the local Decision Record (worker_gate_decisions.jsonl). Reads the log
// directly (like `workers shadow` / `approvals`); no bridge round-trip needed
// since the record is a local file, not live state.
if (process.argv[2] === "gate") {
  const args = process.argv.slice(3);
  const sub = args[0];
  if (
    sub !== "explain" ||
    args.includes("--help") ||
    args.includes("-h") ||
    args.length < 3
  ) {
    process.stdout.write(
      "Usage: patchwork gate explain <workerId> <classKey> [--limit N] [--json]\n\n" +
        "Explain the worker-autonomy gate's most recent decision(s) for a given\n" +
        "worker × action-class, from the local Decision Record\n" +
        "(~/.patchwork/worker_gate_decisions.jsonl) — no bridge required.\n\n" +
        '  <classKey>       e.g. "issue:compensable:high" (domain:reversibility:blastTier)\n' +
        "  --limit N        show the N most recent decisions (default 1)\n" +
        "  --json            emit raw JSON (for scripting)\n",
    );
    process.exit(sub === "explain" ? 1 : 0);
  }
  (async () => {
    try {
      // Length checked above (args.length < 3 short-circuits to usage), so
      // args[1]/[2] are present here — noUncheckedIndexedAccess just can't see
      // across the `if` block above.
      const workerId = args[1] as string;
      const classKey = args[2] as string;
      const limitIdx = args.indexOf("--limit");
      const limit =
        limitIdx >= 0 && limitIdx + 1 < args.length
          ? Number.parseInt(args[limitIdx + 1] as string, 10)
          : 1;
      if (!Number.isFinite(limit) || limit < 1) {
        process.stderr.write("Error: --limit must be a positive integer\n");
        process.exit(1);
      }
      const { WorkerGateDecisionLog, formatGateDecisionHistory } = await import(
        "./workerGateDecisionLog.js"
      );
      const patchworkDir =
        process.env.PATCHWORK_HOME ?? path.join(os.homedir(), ".patchwork");
      const log = new WorkerGateDecisionLog({ dir: patchworkDir });
      const decisions = log.query({ workerId, classKey, limit });

      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(decisions, null, 2)}\n`);
        process.exit(0);
      }
      if (decisions.length === 0) {
        process.stdout.write(
          `No gate decisions found for worker "${workerId}" on class "${classKey}".\n` +
            "Either the worker hasn't acted on this class yet, or worker.autonomy is off.\n",
        );
        process.exit(0);
      }
      process.stdout.write(`${formatGateDecisionHistory(decisions)}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
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
  const binName = invokedBinaryName();
  const isPatchworkBin =
    binName === "patchwork-os" ||
    binName === "patchwork" ||
    binName === "patchwork.js";
  if (isPatchworkBin && (!process.argv[2] || process.argv[2] === "dashboard")) {
    // First-run guard: if the user hasn't run `patchwork init` yet, launching
    // the dashboard renders an empty panel with no signpost. Print an
    // actionable pointer instead and exit cleanly.
    const cfgPath = path.join(os.homedir(), ".patchwork", "config.json");
    if (!existsSync(cfgPath) && !process.argv[2]) {
      process.stdout.write(
        `No Patchwork config found at ${cfgPath}.\n\n` +
          `Run \`${binName} init\` to scaffold ~/.patchwork and wire up\n` +
          `Claude Code hooks, then \`${binName}\` again to open the dashboard.\n\n` +
          `For just the IDE bridge (no recipes / approval queue), run:\n` +
          `  ${binName} install-extension\n` +
          `  ${binName} --workspace .\n`,
      );
      process.exit(0);
    }
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

    // Check if tmux is available (skip on Windows — tmux doesn't exist there)
    const tmuxCheck =
      process.platform !== "win32"
        ? spawnSync("which", ["tmux"], { stdio: "ignore" })
        : { status: 1 };
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
          // Use treeKill so grandchildren (recipe runners, claude
          // subprocesses, extension watchers) are reaped on Windows.
          // Bare `child.kill(sig)` maps to TerminateProcess on win32
          // and skips descendants → orphaned processes survive a
          // supervisor SIGTERM. Audit 2026-05-17.
          treeKill(child, sig);
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

    // F5: Silent self-update nudge (fire-and-forget).
    // Skip when running from a source tree (any of: a `.git` sibling of the
    // package, or __dirnameTop not under a node_modules/). Otherwise a dev
    // who built locally sees "Bridge v<X> available" pointing at an npm
    // install path they're not using.
    const isSourceBuild =
      existsSync(path.join(__dirnameTop, "..", ".git")) ||
      !__dirnameTop.includes(`${path.sep}node_modules${path.sep}`);
    if (!isSourceBuild) {
      import("node:child_process")
        .then(({ exec }) => {
          exec(
            "npm view patchwork-os version",
            { timeout: 5000 },
            (err, stdout) => {
              if (err || !stdout) return;
              const latest = stdout.trim();
              if (latest && semverGt(latest, PACKAGE_VERSION)) {
                console.log(
                  `\n  Patchwork OS v${latest} available — run: npm update -g patchwork-os\n`,
                );
              }
            },
          );
        })
        .catch(() => {});
    }
  }
} // end of `else` for `if (__subcommandWillRun)` (bridge-mode block)
