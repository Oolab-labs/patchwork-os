import { execFile } from "node:child_process";
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
];

export async function probeAll(): Promise<ProbeResults> {
  const entries = await Promise.all(
    COMMANDS.map(async ([key, cmd]) => {
      const available = await probeCommand(cmd);
      return [key, available] as const;
    }),
  );

  return Object.fromEntries(entries) as unknown as ProbeResults;
}
