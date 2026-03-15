import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  gracePeriodMs: number;
  autoTmux: boolean;
  claudeDriver: "subprocess" | "api" | "none";
  claudeBinary: string;
  automationEnabled: boolean;
  automationPolicyPath: string | null;
  toolRateLimit: number;
}

const DEFAULT_ALLOWLIST = [
  "git",
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

const EDITOR_IDE_NAMES: Record<string, string> = {
  windsurf: "Windsurf",
  cursor: "Cursor",
  antigravity: "Antigravity",
  ag: "Antigravity",
  code: "VS Code",
};

export function findEditor(): string | null {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const cmd of ["windsurf", "cursor", "antigravity", "ag", "code"]) {
    try {
      execFileSync(whichCmd, [cmd], { stdio: "ignore", timeout: 3000 });
      return cmd;
    } catch {
      // not found
    }
  }
  return null;
}

/** Exported for testing. Maps an editor CLI command to its human-readable IDE name. */
export function ideNameFromEditor(editorCommand: string): string {
  return EDITOR_IDE_NAMES[editorCommand] ?? editorCommand;
}

/** Keys in the config file that mirror CLI flags (camelCase). */
interface ConfigFile {
  workspace?: string;
  port?: number;
  logLevel?: string;
  linters?: string[];
  commandAllowlist?: string[];
  vscodeCommandAllowlist?: string[];
  commandTimeout?: number;
  maxResultSize?: number;
  gracePeriodMs?: number;
  bindAddress?: string;
  editorCommand?: string;
  ideName?: string;
  autoTmux?: boolean;
  claudeDriver?: "subprocess" | "api" | "none";
  claudeBinary?: string;
  automationEnabled?: boolean;
  automationPolicyPath?: string;
}

const KNOWN_CONFIG_FILE_KEYS = new Set<string>([
  "workspace", "port", "logLevel", "linters", "commandAllowlist",
  "vscodeCommandAllowlist", "commandTimeout", "maxResultSize",
  "gracePeriodMs", "bindAddress", "editorCommand", "ideName", "autoTmux",
  "claudeDriver", "claudeBinary", "automationEnabled", "automationPolicyPath",
]);

/**
 * Load a config file and return its contents as a partial Config.
 * Discovery order: $CLAUDE_IDE_BRIDGE_CONFIG → ./claude-ide-bridge.config.json → ~/.claude/ide/config.json
 * On any error (file not found, parse failure) logs a warning and returns {}.
 */
export function loadConfigFile(configPath?: string): Partial<ConfigFile> {
  const candidates: string[] = [];
  if (configPath) {
    candidates.push(configPath);
  } else {
    if (process.env.CLAUDE_IDE_BRIDGE_CONFIG) {
      candidates.push(process.env.CLAUDE_IDE_BRIDGE_CONFIG);
    }
    candidates.push(path.join(process.cwd(), "claude-ide-bridge.config.json"));
    const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    candidates.push(path.join(claudeDir, "ide", "config.json"));
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(`Warning: Config file ${candidate} is not a JSON object — ignored`);
        return {};
      }
      const obj = parsed as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!KNOWN_CONFIG_FILE_KEYS.has(key)) {
          console.warn(`Warning: Unknown config file key "${key}" in ${candidate} — ignored`);
        }
      }
      return obj as Partial<ConfigFile>;
    } catch (err) {
      console.warn(
        `Warning: Failed to parse config file ${candidate}: ${err instanceof Error ? err.message : String(err)} — ignored`,
      );
      return {};
    }
  }
  return {};
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

  // Find --config path before the main arg parse (lowest priority: loaded first)
  let configFilePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      if (i + 1 >= args.length) {
        throw new Error("--config requires a path argument");
      }
      configFilePath = args[++i] as string;
      if (configFilePath.length > 4096) {
        throw new Error("--config path is too long (max 4096 chars)");
      }
      break;
    }
  }
  const fileConfig = loadConfigFile(configFilePath);

  // Defaults — config file values fill in where CLI/env don't override
  let workspace = fileConfig.workspace ? path.resolve(fileConfig.workspace) : process.cwd();
  let ideName = fileConfig.ideName ?? "External";
  let editorCommand: string | null = fileConfig.editorCommand ?? null;
  let port: number | null = fileConfig.port ?? null;
  let verbose = false;
  let jsonl = false;
  let linters: string[] = fileConfig.linters ?? [];
  const commandAllowlist: string[] = [
    ...DEFAULT_ALLOWLIST,
    ...(fileConfig.commandAllowlist ?? []),
  ];
  const vscodeCommandAllowlist: string[] = fileConfig.vscodeCommandAllowlist ?? [];
  let bindAddress = process.env.BRIDGE_BIND_ADDRESS ?? fileConfig.bindAddress ?? "127.0.0.1";
  let commandTimeout = fileConfig.commandTimeout ?? 30_000;
  let maxResultSize = fileConfig.maxResultSize ?? 512;
  let gracePeriodMs = fileConfig.gracePeriodMs ?? 30_000;
  let autoTmux = fileConfig.autoTmux ?? false;
  let claudeDriver: "subprocess" | "api" | "none" = fileConfig.claudeDriver ?? "none";
  let claudeBinary = fileConfig.claudeBinary ?? "claude";
  let automationEnabled = fileConfig.automationEnabled ?? false;
  let automationPolicyPath: string | null = fileConfig.automationPolicyPath ?? null;
  let toolRateLimit = 60;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workspace":
        workspace = path.resolve(requireArg(args, ++i, "--workspace"));
        break;
      case "--ide-name":
        ideName = requireArg(args, ++i, "--ide-name");
        if (ideName.length > 256)
          throw new Error("--ide-name value too long (max 256 chars)");
        break;
      case "--editor":
        editorCommand = requireArg(args, ++i, "--editor");
        if (editorCommand.length > 4096)
          throw new Error("--editor value too long (max 4096 chars)");
        break;
      case "--bind":
        bindAddress = requireArg(args, ++i, "--bind");
        if (bindAddress.length > 64)
          throw new Error("--bind value too long (max 64 chars)");
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
      case "--linter": {
        const linter = requireArg(args, ++i, "--linter");
        if (linter.length > 256)
          throw new Error("--linter value too long (max 256 chars)");
        linters.push(linter);
        break;
      }
      case "--allow-command": {
        const cmd = requireArg(args, ++i, "--allow-command");
        if (cmd.length > 256)
          throw new Error("--allow-command value too long (max 256 chars)");
        if (INTERPRETER_COMMANDS.has(cmd)) {
          throw new Error(
            `"${cmd}" is an interpreter and cannot be added via --allow-command (arbitrary code execution risk)`,
          );
        }
        commandAllowlist.push(cmd);
        break;
      }
      case "--vscode-allow-command": {
        const vcmd = requireArg(args, ++i, "--vscode-allow-command");
        if (vcmd.length > 256)
          throw new Error(
            "--vscode-allow-command value too long (max 256 chars)",
          );
        vscodeCommandAllowlist.push(vcmd);
        break;
      }
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
      case "--config":
        // Already consumed above to load config file; skip the value
        i++;
        break;
      case "--auto-tmux":
        autoTmux = true;
        break;
      case "--claude-driver": {
        const driverVal = requireArg(args, ++i, "--claude-driver");
        if (driverVal !== "subprocess" && driverVal !== "api" && driverVal !== "none") {
          throw new Error(`Invalid --claude-driver value: "${driverVal}". Must be "subprocess", "api", or "none".`);
        }
        claudeDriver = driverVal;
        break;
      }
      case "--claude-binary":
        claudeBinary = requireArg(args, ++i, "--claude-binary");
        if (claudeBinary.length > 4096)
          throw new Error("--claude-binary value too long (max 4096 chars)");
        break;
      case "--automation":
        automationEnabled = true;
        break;
      case "--automation-policy":
        automationPolicyPath = path.resolve(requireArg(args, ++i, "--automation-policy"));
        break;
      case "--tool-rate-limit": {
        const tlStr = requireArg(args, ++i, "--tool-rate-limit");
        toolRateLimit = Number.parseInt(tlStr, 10);
        if (!Number.isInteger(toolRateLimit) || toolRateLimit < 1 || toolRateLimit > 10_000) {
          throw new Error(
            `Invalid --tool-rate-limit: ${tlStr}. Must be between 1 and 10000.`,
          );
        }
        break;
      }
      case "--grace-period": {
        const gStr = requireArg(args, ++i, "--grace-period");
        gracePeriodMs = Number.parseInt(gStr, 10);
        if (
          !Number.isInteger(gracePeriodMs) ||
          gracePeriodMs < 5000 ||
          gracePeriodMs > 600_000
        ) {
          throw new Error(
            `Invalid grace-period: ${gStr}. Must be between 5000 and 600000 ms.`,
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
  --editor <cmd>            Editor CLI command (default: auto-detect windsurf/cursor/antigravity/code)
  --port <number>           Force specific port (default: random)
  --bind <addr>             Bind address (default: 127.0.0.1, env: BRIDGE_BIND_ADDRESS)
  --linter <name>           Enable specific linter (repeatable; default: auto-detect)
  --allow-command <cmd>     Add command to execution allowlist (repeatable)
  --vscode-allow-command <cmd>  Add VS Code command to invocation allowlist (repeatable)
  --timeout <ms>            Command timeout in ms (default: 30000, max: 120000)
  --max-result-size <KB>    Max output size in KB (default: 512, max: 4096)
  --grace-period <ms>       Reconnect grace period in ms (default: 30000, max: 600000)
  --auto-tmux               Auto-wrap in tmux session if not already inside one
  --config <path>           Load config file (default: ./claude-ide-bridge.config.json)
  --verbose                 Enable debug logging
  --jsonl                   Emit structured JSONL events to stderr
  --help                    Show this help

Automation:
  --claude-driver <mode>    Enable Claude subprocess driver: "subprocess" | "api" | "none" (default: "none")
  --claude-binary <path>    Path to claude binary (default: "claude")
  --automation              Enable event-driven automation hooks (requires --claude-driver != none and --automation-policy)
  --automation-policy <path>  Path to JSON automation policy file

Environment Variables:
  CLAUDE_IDE_BRIDGE_EDITOR           Editor command override
  CLAUDE_IDE_BRIDGE_LINTERS          Comma-separated linter list
  CLAUDE_IDE_BRIDGE_TIMEOUT          Command timeout in ms
  CLAUDE_IDE_BRIDGE_MAX_RESULT_SIZE  Max output size in KB
  CLAUDE_IDE_BRIDGE_GRACE_PERIOD     Reconnect grace period in ms
  CLAUDE_CONFIG_DIR                  Override ~/.claude directory
  CLAUDE_IDE_BRIDGE_CONFIG           Path to config file (overrides auto-discovery)`);
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

  // Auto-derive ideName from editor if not explicitly provided
  if (ideName === "External" && editorCommand) {
    ideName = ideNameFromEditor(editorCommand);
  }

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

  if (process.env.CLAUDE_IDE_BRIDGE_GRACE_PERIOD) {
    const envGrace = Number.parseInt(
      process.env.CLAUDE_IDE_BRIDGE_GRACE_PERIOD,
      10,
    );
    if (Number.isInteger(envGrace) && envGrace >= 5000 && envGrace <= 600_000) {
      gracePeriodMs = envGrace;
    } else {
      console.warn(
        `Warning: CLAUDE_IDE_BRIDGE_GRACE_PERIOD=${process.env.CLAUDE_IDE_BRIDGE_GRACE_PERIOD} is invalid (must be 5000-600000). Using default ${gracePeriodMs}.`,
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
    gracePeriodMs,
    autoTmux,
    claudeDriver,
    claudeBinary,
    automationEnabled,
    automationPolicyPath,
    toolRateLimit,
  };
}
