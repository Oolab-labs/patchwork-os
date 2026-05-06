import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

// Injected at extension build time by esbuild.mjs:
//   define: { BRIDGE_VERSION: JSON.stringify(pkg.version) }
declare const BRIDGE_VERSION: string;

/**
 * Compare two semver strings. Returns true if `a >= b`.
 * Supports the standard `MAJOR.MINOR.PATCH` format; pre-release suffixes are
 * compared lexicographically as a last resort.
 */
function semverGte(a: string, b: string): boolean {
  const parseParts = (v: string): [number, number, number, string] => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!m) return [0, 0, 0, v];
    return [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      (m[4] ?? "").replace(/^[-+]/, ""),
    ];
  };
  const [aMaj, aMin, aPat, aPre] = parseParts(a);
  const [bMaj, bMin, bPat, bPre] = parseParts(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  if (aPat !== bPat) return aPat > bPat;
  // Both identical numerics — a release (no pre-release) is >= any pre-release
  if (aPre === "" && bPre !== "") return true;
  if (aPre !== "" && bPre === "") return false;
  return aPre >= bPre;
}

/**
 * Handles detection and silent global install/upgrade of the bridge.
 * The npm package is `patchwork-os` (which provides the `claude-ide-bridge`
 * binary as one of its bin aliases). Compares the installed semver against
 * BRIDGE_VERSION (bundled at build time) and runs
 * `npm install -g patchwork-os@<version>` when needed.
 */
export class BridgeInstaller {
  constructor(private readonly output: vscode.OutputChannel) {}

  private log(msg: string): void {
    this.output.appendLine(
      `${new Date().toISOString()} [BridgeInstaller] ${msg}`,
    );
  }

  /**
   * Return the currently installed global version of `claude-ide-bridge`,
   * or null if the binary is not found or cannot be executed.
   */
  async getInstalledVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "claude-ide-bridge",
        ["--version"],
        {
          timeout: 10_000,
        },
      );
      const match = stdout.trim().match(/(\d+\.\d+\.\d+[^\s]*)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** The version the extension was built against (from BRIDGE_VERSION constant). */
  getRequiredVersion(): string {
    // BRIDGE_VERSION is injected by esbuild at build time. The fallback
    // "0.0.0" is only reached in development/test environments where the
    // define is absent — it will always trigger an install attempt.
    try {
      return BRIDGE_VERSION;
    } catch {
      return "0.0.0";
    }
  }

  /**
   * Run `npm install -g patchwork-os@<version>` and pipe output to the
   * output channel. Rejects on non-zero exit.
   */
  async installOrUpgrade(version: string): Promise<void> {
    this.log(`Installing patchwork-os@${version} globally...`);
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      const { stdout, stderr } = await execFileAsync(
        npmCmd,
        ["install", "-g", `patchwork-os@${version}`],
        { timeout: 120_000 },
      );
      if (stdout) this.log(stdout.trim());
      if (stderr) this.log(stderr.trim());
      this.log(`Installed patchwork-os@${version} successfully.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface npm-not-found as a distinct, actionable error.
      // Check err.code first — it's precise. msg.includes("ENOENT") is a
      // fallback for environments where code is not propagated.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || msg.includes("ENOENT")) {
        const notice = "Node.js/npm is required to auto-install the bridge.";
        const action = "Install manually: npm install -g patchwork-os";
        void vscode.window.showWarningMessage(`${notice} ${action}`);
        throw new Error(`npm not found: ${msg}`);
      }
      throw new Error(`npm install failed: ${msg}`);
    }
  }

  /**
   * Ensure the globally installed `claude-ide-bridge` matches BRIDGE_VERSION.
   * No-op if the correct version is already installed.
   * Shows a progress notification on first install.
   */
  async ensureInstalled(): Promise<void> {
    const required = this.getRequiredVersion();
    const installed = await this.getInstalledVersion();

    if (installed !== null && semverGte(installed, required)) {
      this.log(
        `patchwork-os (claude-ide-bridge@${installed}) already installed (>= required ${required}) — no action needed.`,
      );
      return;
    }

    const isFirstInstall = installed === null;
    const verb = isFirstInstall ? "Installing" : `Upgrading ${installed} →`;
    this.log(`${verb} patchwork-os@${required}...`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: isFirstInstall
          ? `Claude Bridge: installing v${required}...`
          : `Claude Bridge: upgrading to v${required}...`,
      },
      async () => {
        await this.installOrUpgrade(required);
      },
    );
  }
}
