import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResults {
  rg: boolean;
  fd: boolean;
  git: boolean;
  gh: boolean;
  tsc: boolean;
  eslint: boolean;
  pyright: boolean;
  ruff: boolean;
  cargo: boolean;
  go: boolean;
  biome: boolean;
  prettier: boolean;
  black: boolean;
  gofmt: boolean;
  rustfmt: boolean;
  vitest: boolean;
  jest: boolean;
  pytest: boolean;
  codex: boolean;
  universalCtags: boolean;
  typescriptLanguageServer: boolean;
  ant: boolean;
}

const PROBE_TIMEOUT = 3000;

async function probeCommand(cmd: string): Promise<boolean> {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(whichCmd, [cmd], {
      timeout: PROBE_TIMEOUT,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a command is available either on the global PATH or as a local
 * node_modules/.bin binary inside the workspace.
 *
 * JS tooling (tsc, eslint, biome, prettier, vitest, jest) is almost always
 * installed locally rather than globally in Node projects. Checking only the
 * global PATH causes probes to report false for these tools on VPS / CI
 * environments where nothing is installed globally, even though the workspace
 * has a perfectly functional local binary.
 */
async function probeCommandWithLocalFallback(
  cmd: string,
  workspace: string,
): Promise<boolean> {
  // 1. Check global PATH first (fast path for globally installed tools)
  if (await probeCommand(cmd)) return true;

  // 2. Fall back to workspace-local node_modules/.bin
  const localBin = path.join(workspace, "node_modules", ".bin", cmd);
  try {
    const stat = fs.statSync(localBin);
    // Must be a file or symlink that is executable
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** JS-ecosystem tools that are commonly installed locally rather than globally. */
const JS_LOCAL_TOOLS = new Set([
  "tsc",
  "eslint",
  "biome",
  "prettier",
  "vitest",
  "jest",
  // ripgrep and fd-find ship pre-built binaries via npm packages
  // (@vscode/ripgrep, fd-find) — check node_modules/.bin as fallback
  "rg",
  "fd",
]);

const COMMANDS: Array<[keyof ProbeResults, string]> = [
  ["rg", "rg"],
  ["fd", "fd"],
  ["git", "git"],
  ["gh", "gh"],
  ["tsc", "tsc"],
  ["eslint", "eslint"],
  ["pyright", "pyright"],
  ["ruff", "ruff"],
  ["cargo", "cargo"],
  ["go", "go"],
  ["biome", "biome"],
  ["prettier", "prettier"],
  ["black", "black"],
  ["gofmt", "gofmt"],
  ["rustfmt", "rustfmt"],
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["pytest", "pytest"],
  ["codex", "codex"],
  // universalCtags and typescriptLanguageServer use custom probes below
];

/**
 * Probe for Universal Ctags specifically.
 * Exuberant Ctags (macOS /usr/bin/ctags, apt install ctags) does NOT support
 * --output-format=json. We check `ctags --version` output for "Universal Ctags".
 */
async function probeUniversalCtags(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ctags", ["--version"], {
      timeout: PROBE_TIMEOUT,
    });
    return stdout.toLowerCase().includes("universal ctags");
  } catch {
    return false;
  }
}

/**
 * Probe for typescript-language-server (npm package).
 * `tsc` in PATH does NOT imply typescript-language-server is installed.
 */
async function probeTypescriptLanguageServer(): Promise<boolean> {
  return probeCommand("typescript-language-server");
}

export async function probeAll(workspace = ""): Promise<ProbeResults> {
  const entries = await Promise.all(
    COMMANDS.map(async ([key, cmd]) => {
      const available =
        workspace && JS_LOCAL_TOOLS.has(cmd)
          ? await probeCommandWithLocalFallback(cmd, workspace)
          : await probeCommand(cmd);
      return [key, available] as const;
    }),
  );

  const [universalCtags, typescriptLanguageServer, ant] = await Promise.all([
    probeUniversalCtags(),
    probeTypescriptLanguageServer(),
    probeCommand("ant"),
  ]);

  const base = Object.fromEntries(entries) as unknown as ProbeResults;
  base.universalCtags = universalCtags;
  base.typescriptLanguageServer = typescriptLanguageServer;
  base.ant = ant;
  return base;
}

/**
 * Resolve the executable path for a command.
 * Returns the absolute local bin path when a workspace-local binary exists,
 * otherwise returns the bare command name (resolved via system PATH).
 *
 * Use this in tool handlers instead of bare command names so that
 * node_modules/.bin binaries (e.g. rg from @vscode/ripgrep) are invoked
 * directly without needing them on the system PATH.
 */
export function resolveCommandPath(cmd: string, workspace: string): string {
  if (!workspace) return cmd;
  const localBin = path.join(workspace, "node_modules", ".bin", cmd);
  try {
    const stat = fs.statSync(localBin);
    if (stat.isFile() || stat.isSymbolicLink()) return localBin;
  } catch {
    // not present — fall through
  }
  return cmd;
}
