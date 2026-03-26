#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.js";
import { findEditor, parseConfig } from "./config.js";

const __dirnameTop = path.dirname(fileURLToPath(import.meta.url));

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
    process.exit(0);
  }

  const targetPath = path.join(workspace, "CLAUDE.md");
  const marker = "## Claude IDE Bridge";

  // Idempotent: skip if the section already exists
  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf-8");
    if (existing.includes(marker)) {
      process.stderr.write(
        `CLAUDE.md already contains a '${marker}' section — no changes made.\n`,
      );
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

  // Step 1: Install extension
  const editor = findEditor();
  if (!editor) {
    process.stderr.write(
      "  [skip] Extension install — no supported editor found on PATH.\n" +
        "         Install manually: code --install-extension oolab-labs.claude-ide-bridge-extension\n\n",
    );
  } else {
    process.stderr.write(`  Installing extension into ${editor}...\n`);
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const vsixDir = path.resolve(__dirname2, "..", "vscode-extension");
    const MARKETPLACE_ID = "oolab-labs.claude-ide-bridge-extension";
    let extensionArg = MARKETPLACE_ID;
    if (existsSync(vsixDir)) {
      const vsixFiles = readdirSync(vsixDir)
        .filter((f) => f.endsWith(".vsix"))
        .sort()
        .reverse();
      if (vsixFiles.length > 0)
        extensionArg = path.join(vsixDir, vsixFiles[0] as string);
    }
    try {
      execFileSync(editor, ["--install-extension", extensionArg], {
        stdio: "pipe",
        timeout: 30000,
      });
      process.stderr.write(`  ✓ Extension installed via ${editor}\n\n`);
    } catch {
      process.stderr.write(
        `  [warn] Extension install failed — try manually:\n         ${editor} --install-extension ${MARKETPLACE_ID}\n\n`,
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
    if (
      existsSync(targetPath) &&
      readFileSync(targetPath, "utf-8").includes(marker)
    ) {
      process.stderr.write(
        "  ✓ CLAUDE.md — bridge section already present\n\n",
      );
    } else {
      const updated = existsSync(targetPath)
        ? `${readFileSync(targetPath, "utf-8").trimEnd()}\n\n${content.trimEnd()}\n`
        : content;
      writeFileSync(`${targetPath}.tmp`, updated, "utf-8");
      if (existsSync(targetPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        renameSync(targetPath, `${targetPath}.${ts}.bak`);
      } else {
        mkdirSync(workspace, { recursive: true });
      }
      renameSync(`${targetPath}.tmp`, targetPath);
      process.stderr.write(
        `  ✓ CLAUDE.md — bridge section written to ${targetPath}\n\n`,
      );
    }
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
        "  ✓ MCP shim — already registered in ~/.claude.json\n\n",
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
        "  ✓ MCP shim — registered in ~/.claude.json (bridge tools available in all sessions)\n\n",
      );
    }
  } catch {
    process.stderr.write(
      "  [warn] Could not update ~/.claude.json — add manually:\n" +
        '         { "mcpServers": { "claude-ide-bridge": { "command": "claude-ide-bridge", "args": ["shim"] } } }\n\n',
    );
  }

  // Step 4: Env var check + next steps
  const envSet = process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK === "true";
  process.stdout.write("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  process.stdout.write("Setup complete. Next:\n\n");
  if (!envSet) {
    process.stdout.write(
      "  1. Add to your shell profile (~/.zshrc or ~/.bashrc):\n\n" +
        "       export CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true\n\n" +
        "     Then reload: source ~/.zshrc\n\n",
    );
    process.stdout.write(
      "  2. Start the bridge (run in your project directory):\n\n" +
        "       claude-ide-bridge --watch\n\n",
    );
    process.stdout.write(
      "  3. Open Claude Code:\n\n" + "       claude --ide\n\n",
    );
  } else {
    process.stdout.write(
      "  1. Start the bridge (run in your project directory):\n\n" +
        "       claude-ide-bridge --watch\n\n",
    );
    process.stdout.write(
      "  2. Open Claude Code:\n\n" + "       claude --ide\n\n",
    );
  }
  process.stdout.write(
    "Type /ide in Claude Code to confirm the connection.\n" +
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n",
  );
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

  // Prefer a local .vsix (source checkout / dev build). Fall back to the
  // marketplace extension ID when installed via `npm install -g` (no vscode-extension/ dir).
  let extensionArg: string;
  const MARKETPLACE_ID = "oolab-labs.claude-ide-bridge-extension";
  if (existsSync(vsixDir)) {
    // Pick the newest .vsix dynamically — avoids hardcoding a version that goes stale
    const vsixFiles = readdirSync(vsixDir)
      .filter((f) => f.endsWith(".vsix"))
      .sort()
      .reverse();
    extensionArg =
      vsixFiles.length > 0
        ? path.join(vsixDir, vsixFiles[0] as string)
        : MARKETPLACE_ID;
  } else {
    extensionArg = MARKETPLACE_ID;
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
  }
  process.exit(0);
}

const config = parseConfig(process.argv);

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
