import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { successStructured } from "./utils.js";

/** Minimal interface to read stats from AutomationHooks without importing the whole class. */
interface AutomationHooksLike {
  getStats(): {
    hooksEnabled: number;
    lastFiredAt: string | null;
    skipCountsByHookAndReason?: Record<string, Record<string, number>>;
  };
}

const execFileAsync = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "error" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  suggestion?: string;
}

/** Run one binary with --version; resolve to stdout, reject on failure. */
async function runVersion(cmd: string, args = ["--version"]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 3000 });
  return stdout.trim();
}

/**
 * Check whether a Node local binary exists in workspace node_modules/.bin.
 */
function localBinExists(workspace: string, cmd: string): boolean {
  const p = path.join(workspace, "node_modules", ".bin", cmd);
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkExtension(
  extensionClient: ExtensionClient,
): Promise<CheckResult> {
  if (extensionClient.isConnected()) {
    const cb = extensionClient.getCircuitBreakerState();
    if (cb.suspended) {
      return {
        name: "VS Code extension",
        status: "warn",
        detail: `Connected but circuit breaker is open (${cb.failures} recent timeouts)`,
        suggestion:
          "Extension is temporarily throttled — it will auto-recover. If it persists, run 'Claude IDE Bridge: Reconnect' in VS Code.",
      };
    }
    return { name: "VS Code extension", status: "ok", detail: "Connected" };
  }
  return {
    name: "VS Code extension",
    status: "warn",
    detail: "Disconnected — LSP, debugger, and terminal tools unavailable",
    suggestion:
      "Open VS Code and run 'Claude IDE Bridge: Reconnect', or ensure the extension is installed and enabled.",
  };
}

async function checkGit(workspace: string): Promise<CheckResult> {
  try {
    const v = await runVersion("git");
    // Verify workspace is actually a git repo
    await execFileAsync("git", ["rev-parse", "--git-dir"], {
      cwd: workspace,
      timeout: 3000,
    });
    return { name: "Git", status: "ok", detail: v.split("\n")[0] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not a git")) {
      return {
        name: "Git",
        status: "warn",
        detail: "Workspace is not a git repository",
        suggestion: "Run `git init` to initialise a repository.",
      };
    }
    return {
      name: "Git",
      status: "error",
      detail: "git not found on PATH",
      suggestion: "Install git: https://git-scm.com/downloads",
    };
  }
}

async function checkTypeScript(
  workspace: string,
  probes: ProbeResults,
): Promise<CheckResult> {
  if (!probes.tsc) {
    return {
      name: "TypeScript (tsc)",
      status: "skip",
      detail: "tsc not found globally or in node_modules/.bin",
    };
  }

  // Check for tsconfig.json
  const tsconfig = path.join(workspace, "tsconfig.json");
  if (!fs.existsSync(tsconfig)) {
    return {
      name: "TypeScript (tsc)",
      status: "warn",
      detail: "tsc found but no tsconfig.json in workspace root",
      suggestion:
        "Create tsconfig.json — getDiagnostics (workspace-wide mode) requires it.",
    };
  }

  try {
    const tscBin = localBinExists(workspace, "tsc")
      ? path.join(workspace, "node_modules", ".bin", "tsc")
      : "tsc";
    const v = await runVersion(tscBin);
    return {
      name: "TypeScript (tsc)",
      status: "ok",
      detail: v.split("\n")[0],
    };
  } catch {
    return {
      name: "TypeScript (tsc)",
      status: "warn",
      detail: "tsc found but --version failed",
    };
  }
}

async function checkLinter(
  workspace: string,
  probes: ProbeResults,
): Promise<CheckResult> {
  const found: string[] = [];
  if (probes.eslint) found.push("eslint");
  if (probes.biome) found.push("biome");
  if (probes.ruff) found.push("ruff");
  if (probes.pyright) found.push("pyright");

  if (found.length === 0) {
    // Check for common config files to give a better suggestion
    const hasEslintConfig = [
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      "eslint.config.js",
      "eslint.config.mjs",
    ].some((f) => fs.existsSync(path.join(workspace, f)));
    const hasBiomeConfig = fs.existsSync(path.join(workspace, "biome.json"));

    const suggestion =
      hasEslintConfig || hasBiomeConfig
        ? `Config file found but binary missing. Run \`npm install\` to restore node_modules/.bin binaries.`
        : "No linter detected — getDiagnostics will rely on VS Code LSP only.";

    return {
      name: "Linter",
      status: "warn",
      detail: "No linter found (eslint, biome, ruff, pyright)",
      suggestion,
    };
  }

  return {
    name: "Linter",
    status: "ok",
    detail: found.join(", "),
  };
}

async function checkTestRunner(
  workspace: string,
  probes: ProbeResults,
): Promise<CheckResult> {
  const found: string[] = [];
  if (probes.vitest) found.push("vitest");
  if (probes.jest) found.push("jest");
  if (probes.pytest) found.push("pytest");

  if (found.length === 0) {
    const hasPkg = fs.existsSync(path.join(workspace, "package.json"));
    return {
      name: "Test runner",
      status: "warn",
      detail: "No test runner found (vitest, jest, pytest)",
      suggestion: hasPkg
        ? "Run `npm install` — test runner may be missing from node_modules/.bin."
        : "No test runner detected.",
    };
  }

  return { name: "Test runner", status: "ok", detail: found.join(", ") };
}

async function checkLockFile(port: number): Promise<CheckResult> {
  const lockDir = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    "ide",
  );
  const pid = process.pid;

  // If port is known, check that specific lock file first
  if (port > 0) {
    const lockPath = path.join(lockDir, `${port}.lock`);
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data.isBridge) {
        return {
          name: "Lock file",
          status: "warn",
          detail: `Lock file exists but isBridge flag is missing (port ${port})`,
          suggestion:
            "Restart the bridge — this lock may be left over from an IDE process.",
        };
      }
      return {
        name: "Lock file",
        status: "ok",
        detail: `~/.claude/ide/${port}.lock present`,
      };
    } catch {
      // fall through to scan below
    }
  }

  // Port is 0 (stdio/unknown) or specific lock missing — scan for any bridge lock matching our PID
  try {
    const entries = fs.readdirSync(lockDir);
    for (const entry of entries) {
      if (!entry.endsWith(".lock")) continue;
      try {
        const raw = fs.readFileSync(path.join(lockDir, entry), "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (data.isBridge && data.pid === pid) {
          return {
            name: "Lock file",
            status: "ok",
            detail: `~/.claude/ide/${entry} present`,
          };
        }
      } catch {
        // skip unreadable/malformed lock files
      }
    }
  } catch {
    // lockDir doesn't exist or unreadable
  }

  const portLabel = port > 0 ? `${port}.lock` : "(none found for this process)";
  return {
    name: "Lock file",
    status: "warn",
    detail: `No bridge lock file found — ${portLabel}`,
    suggestion:
      "Bridge may not have written its lock file yet, or a previous crash left it missing. Restart the bridge.",
  };
}

async function checkWorkspacePath(workspace: string): Promise<CheckResult> {
  try {
    const stat = fs.statSync(workspace);
    if (!stat.isDirectory()) {
      return {
        name: "Workspace path",
        status: "error",
        detail: `${workspace} exists but is not a directory`,
      };
    }
    return {
      name: "Workspace path",
      status: "ok",
      detail: workspace,
    };
  } catch {
    return {
      name: "Workspace path",
      status: "error",
      detail: `${workspace} does not exist`,
      suggestion:
        "Restart the bridge with a valid --workspace path, or cd to the correct directory.",
    };
  }
}

async function checkNodeModules(workspace: string): Promise<CheckResult> {
  const nm = path.join(workspace, "node_modules");
  const pkg = path.join(workspace, "package.json");
  if (!fs.existsSync(pkg)) {
    return { name: "node_modules", status: "skip", detail: "No package.json" };
  }
  if (!fs.existsSync(nm)) {
    return {
      name: "node_modules",
      status: "error",
      detail: "package.json found but node_modules is missing",
      suggestion: "Run `npm install` (or `yarn` / `pnpm install`).",
    };
  }
  return { name: "node_modules", status: "ok", detail: nm };
}

async function checkGhCli(probes: ProbeResults): Promise<CheckResult> {
  if (!probes.gh) {
    return {
      name: "GitHub CLI (gh)",
      status: "warn",
      detail: "gh not found — GitHub tools (createPR, listPRs, etc.) disabled",
      suggestion: "Install: https://cli.github.com/",
    };
  }
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "status"], {
      timeout: 5000,
    });
    const authed = stdout.includes("Logged in") || stdout.includes("✓");
    return {
      name: "GitHub CLI (gh)",
      status: authed ? "ok" : "warn",
      detail: authed
        ? "gh present and authenticated"
        : "gh present but not authenticated",
      suggestion: authed
        ? undefined
        : "Run `gh auth login` to enable GitHub tools.",
    };
  } catch (err) {
    // gh auth status exits non-zero when not logged in; stderr has the message
    const msg = err instanceof Error ? err.message : "";
    const notAuthed =
      msg.includes("not logged") || msg.includes("You are not logged");
    return {
      name: "GitHub CLI (gh)",
      status: "warn",
      detail: "gh present but not authenticated",
      suggestion: notAuthed
        ? "Run `gh auth login` to enable GitHub tools."
        : undefined,
    };
  }
}

async function checkAutomationPolicy(config: Config): Promise<CheckResult> {
  if (!config.automationEnabled) {
    return {
      name: "Automation Policy",
      status: "skip",
      detail: "Automation not enabled",
    };
  }
  if (config.automationPolicyPath == null) {
    return {
      name: "Automation Policy",
      status: "warn",
      detail: "No --automation-policy path set",
      suggestion: "Pass --automation-policy <path> to enable automation",
    };
  }
  try {
    fs.accessSync(config.automationPolicyPath, fs.constants.R_OK);
    return {
      name: "Automation Policy",
      status: "ok",
      detail: `Policy file readable: ${config.automationPolicyPath}`,
    };
  } catch {
    return {
      name: "Automation Policy",
      status: "error",
      detail: `Policy file unreadable: ${config.automationPolicyPath}`,
      suggestion: "Verify path and file permissions",
    };
  }
}

async function checkOAuthTokenStore(config: Config): Promise<CheckResult> {
  if (!config.issuerUrl) {
    return {
      name: "OAuth Token Store",
      status: "skip",
      detail: "OAuth not active",
    };
  }
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const tokenFile = path.join(configDir, "ide", "oauth-tokens.json");
  if (!fs.existsSync(tokenFile)) {
    return {
      name: "OAuth Token Store",
      status: "ok",
      detail: "No token store yet (created on first auth)",
    };
  }
  try {
    fs.accessSync(tokenFile, fs.constants.R_OK);
    return {
      name: "OAuth Token Store",
      status: "ok",
      detail: "Token store readable",
    };
  } catch {
    return {
      name: "OAuth Token Store",
      status: "warn",
      detail: "oauth-tokens.json unreadable",
      suggestion: "chmod 600 ~/.claude/ide/oauth-tokens.json",
    };
  }
}

async function checkCircuitBreaker(
  extensionClient: ExtensionClient,
): Promise<CheckResult> {
  if (!extensionClient.isConnected()) {
    return {
      name: "Circuit Breaker",
      status: "skip",
      detail: "Extension not connected",
    };
  }
  const cb = extensionClient.getCircuitBreakerState();
  if (cb.suspended) {
    return {
      name: "Circuit Breaker",
      status: "error",
      detail: "Extension circuit is OPEN — requests fast-failing",
      suggestion:
        "Check VS Code Output panel for extension errors, then reconnect",
    };
  }
  if (cb.failures > 0) {
    return {
      name: "Circuit Breaker",
      status: "warn",
      detail: `Circuit has ${cb.failures} recent failure(s)`,
      suggestion: "Extension may be intermittently unstable",
    };
  }
  return {
    name: "Circuit Breaker",
    status: "ok",
    detail: "Circuit closed, no recent opens",
  };
}

async function checkClaudeDriver(config: Config): Promise<CheckResult> {
  if (config.claudeDriver !== "subprocess") {
    return {
      name: "Claude Driver",
      status: "skip",
      detail: "Claude driver not set to subprocess",
    };
  }
  const binary = config.claudeBinary || "claude";
  try {
    execSync(
      process.platform === "win32" ? `where ${binary}` : `which ${binary}`,
      { stdio: "pipe" },
    );
    return {
      name: "Claude Driver",
      status: "ok",
      detail: "claude binary found",
    };
  } catch {
    return {
      name: "Claude Driver",
      status: "warn",
      detail: "claude binary not found on PATH",
      suggestion: "Install Claude CLI or set --claude-binary <path>",
    };
  }
}

function checkSkipReasons(
  automationHooks: AutomationHooksLike | undefined,
): CheckResult {
  if (!automationHooks) {
    return {
      name: "Automation Skip Reasons",
      status: "skip",
      detail: "Automation not enabled",
    };
  }
  const stats = automationHooks.getStats();
  const skipMap = stats.skipCountsByHookAndReason ?? {};
  const warnings: string[] = [];
  for (const [hook, reasons] of Object.entries(skipMap)) {
    for (const [reason, count] of Object.entries(reasons)) {
      if (count > 10) {
        warnings.push(`${hook} skipped ${count}x (${reason})`);
      }
    }
  }
  if (warnings.length === 0) {
    return {
      name: "Automation Skip Reasons",
      status: "ok",
      detail: "No frequent skips",
    };
  }
  return {
    name: "Automation Skip Reasons",
    status: "warn",
    detail: warnings.join("; "),
    suggestion:
      "Check your minimatch patterns or cooldownMs settings for the listed hooks",
  };
}

// ── Overall health ────────────────────────────────────────────────────────────

function overallHealth(
  checks: CheckResult[],
): "healthy" | "degraded" | "unhealthy" {
  const hasError = checks.some((c) => c.status === "error");
  const hasWarn = checks.some((c) => c.status === "warn");
  if (hasError) return "unhealthy";
  if (hasWarn) return "degraded";
  return "healthy";
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export function createBridgeDoctorTool(
  workspace: string,
  extensionClient: ExtensionClient,
  probes: ProbeResults,
  port: number,
  config: Config,
  automationHooks?: AutomationHooksLike,
) {
  return {
    schema: {
      name: "bridgeDoctor",
      description:
        "Health check: extension, git, linters, test runners, GitHub CLI. Use when tools misbehave.",
      annotations: { readOnlyHint: true },
      cache_control: { type: "ephemeral" as const },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          overallHealth: {
            type: "string",
            enum: ["healthy", "degraded", "unhealthy"],
          },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                status: {
                  type: "string",
                  enum: ["ok", "warn", "error", "skip"],
                },
                detail: { type: "string" },
                suggestion: { type: "string" },
              },
              required: ["name", "status"],
            },
          },
          summary: { type: "string" },
        },
        required: ["overallHealth", "checks", "summary"],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      const checks = await Promise.all([
        checkWorkspacePath(workspace),
        checkExtension(extensionClient),
        checkGit(workspace),
        checkTypeScript(workspace, probes),
        checkLinter(workspace, probes),
        checkTestRunner(workspace, probes),
        checkNodeModules(workspace),
        checkLockFile(port),
        checkGhCli(probes),
        checkAutomationPolicy(config),
        checkOAuthTokenStore(config),
        checkCircuitBreaker(extensionClient),
        checkClaudeDriver(config),
        Promise.resolve(checkSkipReasons(automationHooks)),
      ]);

      const health = overallHealth(checks);
      const issues = checks.filter(
        (c) => c.status === "error" || c.status === "warn",
      );
      const summary =
        health === "healthy"
          ? `All ${checks.length} checks passed.`
          : `${issues.length} issue${issues.length === 1 ? "" : "s"} found: ${issues.map((c) => c.name).join(", ")}.`;

      return successStructured({ overallHealth: health, checks, summary });
    },
  };
}
