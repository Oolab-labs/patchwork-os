import { execFileSync } from "node:child_process";
import path from "node:path";

export interface Config {
  workspace: string;
  workspaceFolders: string[];
  ideName: string;
  editorCommand: string | null;
  port: number | null;
  bindAddress: string;
  verbose: boolean;
  jsonl: boolean;
  linters: string[];
  commandAllowlist: string[];
  commandTimeout: number;
  maxResultSize: number;
  vscodeCommandAllowlist: string[];
  activeWorkspaceFolder: string;
}

const DEFAULT_ALLOWLIST = [
  "npm",
  "cargo",
  "go",
  "pytest",
  "jest",
  "vitest",
  "tsc",
  "eslint",
  "biome",
];

/** Commands that can execute arbitrary code via flags like -e, -c, --eval.
 *  These are blocked from the default allowlist but can be added via --allow-command. */
export const INTERPRETER_COMMANDS = new Set([
  "node",
  "python",
  "python3",
  "make",
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ruby",
  "perl",
  "lua",
  "php",
]);

export function findEditor(): string | null {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const cmd of ["windsurf", "code", "cursor"]) {
    try {
      execFileSync(whichCmd, [cmd], { stdio: "ignore", timeout: 3000 });
      return cmd;
    } catch {
      // not found
    }
  }
  return null;
}

function requireArg(args: string[], i: number, flag: string): string {
  const value = args[i];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseConfig(argv: string[]): Config {
  const args = argv.slice(2);
  let workspace = process.cwd();
  let ideName = "External";
  let editorCommand: string | null = null;
  let port: number | null = null;
  let verbose = false;
  let jsonl = false;
  let linters: string[] = [];
  const commandAllowlist: string[] = [...DEFAULT_ALLOWLIST];
  const vscodeCommandAllowlist: string[] = [];
  let bindAddress = process.env.BRIDGE_BIND_ADDRESS ?? "127.0.0.1";
  let commandTimeout = 30_000;
  let maxResultSize = 512;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workspace":
        workspace = path.resolve(requireArg(args, ++i, "--workspace"));
        break;
      case "--ide-name":
        ideName = requireArg(args, ++i, "--ide-name");
        break;
      case "--editor":
        editorCommand = requireArg(args, ++i, "--editor");
        break;
      case "--bind":
        bindAddress = requireArg(args, ++i, "--bind");
        break;
      case "--port": {
        const portStr = requireArg(args, ++i, "--port");
        port = Number.parseInt(portStr, 10);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error(
            `Invalid port: ${portStr}. Must be an integer between 1024 and 65535.`,
          );
        }
        break;
      }
      case "--verbose":
        verbose = true;
        break;
      case "--jsonl":
        jsonl = true;
        break;
      case "--linter":
        linters.push(requireArg(args, ++i, "--linter"));
        break;
      case "--allow-command":
        commandAllowlist.push(requireArg(args, ++i, "--allow-command"));
        break;
      case "--vscode-allow-command":
        vscodeCommandAllowlist.push(
          requireArg(args, ++i, "--vscode-allow-command"),
        );
        break;
      case "--timeout": {
        const tStr = requireArg(args, ++i, "--timeout");
        commandTimeout = Number.parseInt(tStr, 10);
        if (
          !Number.isInteger(commandTimeout) ||
          commandTimeout < 1000 ||
          commandTimeout > 120_000
        ) {
          throw new Error(
            `Invalid timeout: ${tStr}. Must be between 1000 and 120000 ms.`,
          );
        }
        break;
      }
      case "--max-result-size": {
        const mStr = requireArg(args, ++i, "--max-result-size");
        maxResultSize = Number.parseInt(mStr, 10);
        if (
          !Number.isInteger(maxResultSize) ||
          maxResultSize < 1 ||
          maxResultSize > 4096
        ) {
          throw new Error(
            `Invalid max-result-size: ${mStr}. Must be between 1 and 4096 KB.`,
          );
        }
        break;
      }
      case "--help": {
        console.log(`claude-ide-bridge - Standalone MCP bridge for Claude Code IDE integration

Usage: claude-ide-bridge [options]

Options:
  --workspace <path>        Workspace folder (default: cwd)
  --ide-name <name>         IDE name shown to Claude (default: "External")
  --editor <cmd>            Editor CLI command (default: auto-detect windsurf/code/cursor)
  --port <number>           Force specific port (default: random)
  --bind <addr>             Bind address (default: 127.0.0.1, env: BRIDGE_BIND_ADDRESS)
  --linter <name>           Enable specific linter (repeatable; default: auto-detect)
  --allow-command <cmd>     Add command to execution allowlist (repeatable)
  --vscode-allow-command <cmd>  Add VS Code command to invocation allowlist (repeatable)
  --timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
  --max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
  --verbose                 Enable debug logging
  --jsonl                   Emit structured JSONL events to stderr
  --help                    Show this help

Environment Variables:
  CLAUDE_IDE_BRIDGE_EDITOR           Editor command override
  CLAUDE_IDE_BRIDGE_LINTERS          Comma-separated linter list
  CLAUDE_IDE_BRIDGE_TIMEOUT          Command timeout in ms
  CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE  Max output size in KB
  CLAUDE_CONFIG_DIR                  Override ~/.claude directory`);
        return process.exit(0);
      }
      default: {
        const arg = args[i];
        if (arg?.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
        }
      }
    }
  }

  // Auto-detect editor
  editorCommand =
    editorCommand || process.env.CLAUDE_IDE_BRIDGE_EDITOR || findEditor();

  // Env var overrides
  if (process.env.CLAUDE_IDE_BRIDGE_LINTERS) {
    linters = process.env.CLAUDE_IDE_BRIDGE_LINTERS.split(",").map((s) =>
      s.trim(),
    );
  }
  if (process.env.CLAUDE_IDE_BRIDGE_TIMEOUT) {
    const envTimeout = Number.parseInt(
      process.env.CLAUDE_IDE_BRIDGE_TIMEOUT,
      10,
    );
    if (
      Number.isInteger(envTimeout) &&
      envTimeout >= 1000 &&
      envTimeout <= 120_000
    ) {
      commandTimeout = envTimeout;
    } else {
      // console.warn rather than logger — Logger is constructed after parseConfig() returns
      console.warn(
        `Warning: CLAUDE_IDE_BRIDGE_TIMEOUT=${process.env.CLAUDE_IDE_BRIDGE_TIMEOUT} is invalid (must be 1000-120000). Using default ${commandTimeout}.`,
      );
    }
  }
  if (process.env.CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE) {
    const envSize = Number.parseInt(
      process.env.CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE,
      10,
    );
    if (Number.isInteger(envSize) && envSize >= 1 && envSize <= 4096) {
      maxResultSize = envSize;
    } else {
      // console.warn rather than logger — Logger is constructed after parseConfig() returns
      console.warn(
        `Warning: CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE=${process.env.CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE} is invalid (must be 1-4096). Using default ${maxResultSize}.`,
      );
    }
  }

  return {
    workspace,
    workspaceFolders: [workspace],
    ideName,
    editorCommand,
    port,
    bindAddress,
    verbose,
    jsonl,
    linters,
    commandAllowlist,
    commandTimeout,
    maxResultSize,
    vscodeCommandAllowlist,
    activeWorkspaceFolder: workspace,
  };
}
