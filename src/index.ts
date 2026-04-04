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
import { findEditor, parseConfig } from "./config.js";

const __dirnameTop = path.dirname(fileURLToPath(import.meta.url));

const OPEN_VSX_PUBLISHER = "oolab-labs";
const OPEN_VSX_NAME = "claude-ide-bridge-extension";

/**
 * Returns true if a bridge-tools.md file exists and contains the expected
 * content (at minimum the two most important tool name references). A file
 * that is empty, truncated, or corrupted returns false so the caller can
 * overwrite/repair it.
 */
function isBridgeToolsFileValid(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes("runTests") && content.includes("getDiagnostics");
  } catch {
    return false;
  }
}

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

// Handle gen-claude-md subcommand — generates a CLAUDE.md bridge workflow section
if (process.argv[2] === "gen-claude-md") {
  const argv = process.argv.slice(3);
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
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf-8");
    if (existing.includes(marker)) {
      if (!existing.includes(IMPORT_LINE)) {
        // Patch: insert the @import line immediately after the marker heading
        const patched = existing.replace(
          `${marker}\n`,
          `${marker}\n\n${IMPORT_LINE}\n`,
        );
        writeFileSync(`${targetPath}.tmp`, patched, "utf-8");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        renameSync(targetPath, `${targetPath}.${ts}.bak`);
        renameSync(`${targetPath}.tmp`, targetPath);
        process.stderr.write(
          `Patched existing CLAUDE.md — added missing @import line.\n`,
        );
      } else {
        process.stderr.write(
          `CLAUDE.md already contains a '${marker}' section — no changes made.\n`,
        );
      }
      process.exit(0);
    }
    // Write tmp first — if the write fails, the original is still intact
    const updated = `${existing.trimEnd()}\n\n${content.trimEnd()}\n`;
    writeFileSync(`${targetPath}.tmp`, updated, "utf-8");
    // Backup existing file before replacing
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${targetPath}.${ts}.bak`;
    renameSync(targetPath, backupPath);
    process.stderr.write(`Backed up existing CLAUDE.md to ${backupPath}\n`);
  } else {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(`${targetPath}.tmp`, content, "utf-8");
  }

  renameSync(`${targetPath}.tmp`, targetPath);
  process.stderr.write(`✓ Bridge workflow section written to ${targetPath}\n`);

  // Also write bridge-tools rules file alongside CLAUDE.md
  const genRulesDir = path.join(workspace, ".claude", "rules");
  const genRulesFilePath = path.join(genRulesDir, "bridge-tools.md");
  const genBridgeToolsTemplate = path.resolve(
    __dirnameTop,
    "..",
    "templates",
    "bridge-tools.md",
  );
  if (
    !isBridgeToolsFileValid(genRulesFilePath) &&
    existsSync(genBridgeToolsTemplate)
  ) {
    const repairing = existsSync(genRulesFilePath);
    try {
      mkdirSync(genRulesDir, { recursive: true });
      writeFileSync(
        genRulesFilePath,
        readFileSync(genBridgeToolsTemplate, "utf-8"),
      );
      process.stderr.write(
        repairing
          ? `✓ Bridge rules repaired at ${genRulesFilePath}\n`
          : `✓ Bridge rules written to ${genRulesFilePath}\n`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES") {
        process.stderr.write(
          `[warn] Bridge rules — permission denied writing to ${genRulesFilePath}.\n` +
            `       Run with elevated permissions or create the file manually.\n`,
        );
      } else {
        process.stderr.write(
          `[warn] Bridge rules — write failed (${code ?? String(err)})\n`,
        );
      }
    }
  }

  process.exit(0);
}

// Handle print-token subcommand — print the bridge auth token from a lock file
if (process.argv[2] === "print-token") {
  const argv = process.argv.slice(3);
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
    if (
      existsSync(targetPath) &&
      readFileSync(targetPath, "utf-8").includes(marker)
    ) {
      const existing = readFileSync(targetPath, "utf-8");
      if (!existing.includes(importLine)) {
        // Patch: insert the @import line immediately after the marker heading
        const patched = existing.replace(
          `${marker}\n`,
          `${marker}\n\n${importLine}\n`,
        );
        writeFileSync(`${targetPath}.tmp`, patched, "utf-8");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        renameSync(targetPath, `${targetPath}.${ts}.bak`);
        renameSync(`${targetPath}.tmp`, targetPath);
        process.stderr.write(
          "  ✓ CLAUDE.md — patched with missing @import line\n\n",
        );
      } else {
        process.stderr.write(
          "  ✓ CLAUDE.md — bridge section already present\n\n",
        );
      }
    } else {
      mkdirSync(workspace, { recursive: true });
      const updated = existsSync(targetPath)
        ? `${readFileSync(targetPath, "utf-8").trimEnd()}\n\n${content.trimEnd()}\n`
        : content;
      writeFileSync(`${targetPath}.tmp`, updated, "utf-8");
      if (existsSync(targetPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        renameSync(targetPath, `${targetPath}.${ts}.bak`);
      }
      renameSync(`${targetPath}.tmp`, targetPath);
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge section written to ${targetPath}\n\n`,
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
      `  ✓ Bridge rules — already present at ${rulesFilePath}\n\n`,
    );
  } else if (existsSync(bridgeToolsTemplatePath)) {
    const repairing = existsSync(rulesFilePath);
    try {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(
        rulesFilePath,
        readFileSync(bridgeToolsTemplatePath, "utf-8"),
      );
      process.stderr.write(
        repairing
          ? `  ✓ Bridge rules — repaired at ${rulesFilePath}\n\n`
          : `  ✓ Bridge rules — written to ${rulesFilePath}\n\n`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES") {
        process.stderr.write(
          `  [warn] Bridge rules — permission denied writing to ${rulesFilePath}.\n` +
            `         Run with elevated permissions or create the file manually.\n\n`,
        );
      } else {
        process.stderr.write(
          `  [warn] Bridge rules — write failed (${code ?? String(err)})\n\n`,
        );
      }
    }
  } else {
    process.stderr.write(`  [skip] Bridge rules — template not found\n\n`);
  }

  // Step 3: Register shim in ~/.claude.json so bridge tools appear in every claude session
  const claudeJsonPath = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "..",
    "claude.json",
  );
  const claudeJsonAbs = path.resolve(claudeJsonPath);
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

  // Step 5: Env var check + next steps
  const envSet = process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK === "true";
  let step = 1;
  process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  process.stdout.write("Setup complete. Next:\n\n");
  if (!envSet) {
    process.stdout.write(
      `  ${step++}. Add to your shell profile (~/.zshrc or ~/.bashrc):\n\n       export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true\n\n     Then reload: source ~/.zshrc\n\n`,
    );
  }
  process.stdout.write(
    `  ${step++}. Start the bridge (run in your project directory):\n\n       claude-ide-bridge --watch\n\n`,
  );
  process.stdout.write(
    `  ${step++}. Open Claude Code:\n\n       claude --ide\n\n`,
  );
  process.stdout.write(
    `  ${step++}. Confirm the connection — type inside Claude:\n\n       /mcp          (shows server status — claude-ide-bridge should be green)\n       /ide          (shows open files, diagnostics, editor state)\n\n`,
  );
  const scheduledTasksDir = path.resolve(
    __dirnameTop,
    "..",
    "templates",
    "scheduled-tasks",
  );
  if (existsSync(scheduledTasksDir)) {
    process.stdout.write(
      `  ${step++}. Optional: activate scheduled task templates (nightly-review, health-check, dependency-audit):\n\n` +
        `       cp -r $(npm root -g)/claude-ide-bridge/templates/scheduled-tasks/* ~/.claude/scheduled-tasks/\n\n`,
    );
  }
  process.stdout.write(
    "  Troubleshooting: https://github.com/Oolab-labs/claude-ide-bridge/blob/main/docs/troubleshooting.md\n",
  );
  process.stdout.write(
    "  Tools not showing up? Run /mcp in Claude to see the connection state.\n",
  );
  process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

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
        `  Extension:  ${health.extension === true ? "connected" : health.extension === false ? "disconnected" : "unknown"}\n`,
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

const config = parseConfig(process.argv);

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
}
