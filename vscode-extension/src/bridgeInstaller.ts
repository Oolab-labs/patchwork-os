import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

// Injected at extension build time by esbuild.mjs:
//   define: { MIN_BRIDGE_VERSION: JSON.stringify(rootPkg.version) }
//
// It is the bridge version this build of the extension was made against, and
// the installer reads it as the OLDEST bridge the extension needs. It is only
// ever compared against. It is never the version to install: by the time
// anyone runs the extension, that version is old.
declare const MIN_BRIDGE_VERSION: string;

/** The npm package that provides the `claude-ide-bridge` binary. */
const PACKAGE = "patchwork-os";

const VERSION_CHECK_TIMEOUT_MS = 10_000;
const NPM_QUERY_TIMEOUT_MS = 30_000;
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const NOTICE_MS = 10_000;

// ── Versions ─────────────────────────────────────────────────────────────────

// Anchored at both ends, so it is only ever matched against one short word.
const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(text: string): ParsedVersion | null {
  if (text.length > 64) return null;
  const m = VERSION.exec(text);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release outranks any pre-release of the same numbers.
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      // As numbers: "beta.10" is newer than "beta.9", which text order
      // gets backwards.
      const difference = Number(x) - Number(y);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * SemVer 2.0.0 precedence: negative when `a` is older than `b`, zero when
 * they rank the same, positive when `a` is newer.
 *
 * Returns null when either side is not a version. Callers must read null as
 * "cannot tell" and do nothing — never as "older".
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const difference = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** The first word of `output` that is a version, with any leading "v" removed. */
function findVersion(output: string): string | null {
  for (const word of output.slice(0, 4096).split(/\s+/)) {
    const candidate = word.startsWith("v") ? word.slice(1) : word;
    if (parseVersion(candidate)) return candidate;
  }
  return null;
}

// ── What a look at the machine found ─────────────────────────────────────────

/**
 * The result of looking for an installed bridge.
 *
 * `unknown` is its own answer. A check that timed out, failed or printed
 * something unreadable says nothing about whether a bridge is installed, and
 * must never be folded into `missing` — that is how a newer bridge used to be
 * replaced by an older one.
 */
export type Found =
  | { kind: "installed"; version: string }
  | { kind: "missing" }
  | { kind: "unknown"; reason: string };

interface ExecFailure {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  message?: unknown;
}

function asFailure(err: unknown): ExecFailure {
  return typeof err === "object" && err !== null
    ? (err as ExecFailure)
    : { message: String(err) };
}

function describeFailure(err: unknown): string {
  const failure = asFailure(err);
  if (failure.killed === true) return "it did not finish in time";
  if (typeof failure.code === "number") {
    return `it exited with code ${failure.code}`;
  }
  if (typeof failure.code === "string") {
    return `it could not be started (${failure.code})`;
  }
  const firstLine = String(failure.message ?? "").split("\n")[0] ?? "";
  return firstLine.slice(0, 200) || "it failed";
}

class NpmNotFoundError extends Error {}

export interface BridgeInstallerOptions {
  /** How long `claude-ide-bridge --version` may take. For tests. */
  versionCheckTimeoutMs?: number;
}

/**
 * Detects the globally installed bridge and installs or upgrades it.
 *
 * The npm package is `patchwork-os`, which provides the `claude-ide-bridge`
 * binary as one of its bin aliases.
 *
 * Two rules decide everything here:
 *
 * 1. The version built into the extension is a MINIMUM. What gets installed
 *    is whatever the registry's `latest` tag points at when the install runs.
 * 2. No install may leave the machine with an older bridge than it had. So an
 *    install runs only when a look at both the binary on PATH and npm's own
 *    global directory found nothing, or when the registry's latest release is
 *    strictly newer than every copy found. Anything that cannot be read means
 *    nothing is installed.
 */
export class BridgeInstaller {
  private readonly versionCheckTimeoutMs: number;

  constructor(
    private readonly output: vscode.OutputChannel,
    options: BridgeInstallerOptions = {},
  ) {
    this.versionCheckTimeoutMs =
      options.versionCheckTimeoutMs ?? VERSION_CHECK_TIMEOUT_MS;
  }

  private log(msg: string): void {
    this.output.appendLine(
      `${new Date().toISOString()} [BridgeInstaller] ${msg}`,
    );
  }

  /**
   * Nothing was installed or replaced: say why in the output channel, and
   * show at most a short status-bar message. Never a dialog — every one of
   * these states is survivable and most are not the user's to fix.
   */
  private leaveAsIs(reason: string, notice: string): void {
    this.log(`${reason} Nothing was installed or replaced.`);
    vscode.window.setStatusBarMessage(`Claude Bridge: ${notice}`, NOTICE_MS);
  }

  /**
   * The oldest bridge this build of the extension needs (the build-time
   * `MIN_BRIDGE_VERSION`). Without it — a development or test run — there is
   * no minimum, so the only thing that can be installed is a missing bridge.
   */
  getMinimumVersion(): string {
    return typeof MIN_BRIDGE_VERSION === "string" &&
      parseVersion(MIN_BRIDGE_VERSION)
      ? MIN_BRIDGE_VERSION
      : "0.0.0";
  }

  /**
   * Look for `claude-ide-bridge` on PATH and read its version.
   *
   * Only a binary that is not there (`ENOENT`) is `missing`. A timeout, a
   * non-zero exit, a spawn refused for any other reason and output with no
   * version in it are all `unknown`.
   */
  async probeInstalled(): Promise<Found> {
    // Node's execFile does NOT auto-resolve `.cmd` shims on Windows, so a
    // bare name ENOENTs there even when the bridge is installed — which would
    // read as "missing" and start an install.
    const binary =
      process.platform === "win32"
        ? "claude-ide-bridge.cmd"
        : "claude-ide-bridge";
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], {
        timeout: this.versionCheckTimeoutMs,
      });
      const version = findVersion(stdout);
      return version
        ? { kind: "installed", version }
        : { kind: "unknown", reason: "it printed no version number" };
    } catch (err: unknown) {
      // The error CODE, not the message: a bridge that starts and then fails
      // to open a file also says "ENOENT", and it is installed.
      if (asFailure(err).code === "ENOENT") return { kind: "missing" };
      return { kind: "unknown", reason: describeFailure(err) };
    }
  }

  /** Run npm. A missing npm is surfaced once, as a distinct, actionable error. */
  private async npm(
    args: string[],
    timeout: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      return await execFileAsync(npmCmd, args, { timeout });
    } catch (err: unknown) {
      if (asFailure(err).code === "ENOENT") {
        const notice = "Node.js/npm is required to auto-install the bridge.";
        const action = `Install manually: npm install -g ${PACKAGE}`;
        void vscode.window.showWarningMessage(`${notice} ${action}`);
        throw new NpmNotFoundError(
          `npm not found: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }
  }

  /**
   * Ask npm what its global directory holds. That copy is the one
   * `npm install -g` writes over, and it is not always the one on PATH.
   */
  async probeNpmGlobal(): Promise<Found> {
    let stdout: string;
    try {
      ({ stdout } = await this.npm(
        ["ls", "-g", PACKAGE, "--depth=0", "--json"],
        NPM_QUERY_TIMEOUT_MS,
      ));
    } catch (err: unknown) {
      if (err instanceof NpmNotFoundError) throw err;
      // `npm ls` exits 1 when the package is absent and still prints the
      // tree, so an exit code alone is not a failure. Anything else is.
      const failure = asFailure(err);
      if (typeof failure.code !== "number" || failure.killed === true) {
        return { kind: "unknown", reason: describeFailure(err) };
      }
      stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    }

    let tree: unknown;
    try {
      tree = JSON.parse(stdout);
    } catch {
      return { kind: "unknown", reason: "npm did not print a package tree" };
    }
    if (typeof tree !== "object" || tree === null) {
      return { kind: "unknown", reason: "npm did not print a package tree" };
    }
    const { dependencies, error } = tree as {
      dependencies?: Record<string, { version?: unknown } | undefined>;
      error?: { code?: unknown };
    };
    const entry =
      dependencies && Object.hasOwn(dependencies, PACKAGE)
        ? dependencies[PACKAGE]
        : undefined;
    if (entry) {
      return typeof entry.version === "string" && parseVersion(entry.version)
        ? { kind: "installed", version: entry.version }
        : { kind: "unknown", reason: `npm lists ${PACKAGE} with no version` };
    }
    // ELSPROBLEMS is npm reporting an untidy global tree; the listing itself
    // is complete. Any other error means the tree was not read.
    if (error && error.code !== "ELSPROBLEMS") {
      return { kind: "unknown", reason: `npm reported ${String(error.code)}` };
    }
    return { kind: "missing" };
  }

  /** The version the registry's `latest` tag points at, or null if unreadable. */
  private async latestRelease(): Promise<string | null> {
    try {
      const { stdout } = await this.npm(
        ["view", `${PACKAGE}@latest`, "version"],
        NPM_QUERY_TIMEOUT_MS,
      );
      // Quoted when the user's npm is configured for JSON output.
      const answer = stdout.trim().replace(/^"|"$/g, "");
      // Validated before use: this string becomes part of an npm argument.
      return parseVersion(answer) ? answer : null;
    } catch (err: unknown) {
      if (err instanceof NpmNotFoundError) throw err;
      this.log(`npm view ${PACKAGE}@latest failed: ${describeFailure(err)}`);
      return null;
    }
  }

  /**
   * The only place `npm install` is run. Private, and reachable through
   * exactly two callers: `installLatest` (nothing is installed) and
   * `upgrade` (a strictly newer release replaces an older copy).
   */
  private async npmInstall(spec: string, title: string): Promise<void> {
    this.log(`Running npm install -g ${PACKAGE}@${spec} ...`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      async () => {
        try {
          const { stdout, stderr } = await this.npm(
            ["install", "-g", `${PACKAGE}@${spec}`],
            NPM_INSTALL_TIMEOUT_MS,
          );
          if (stdout) this.log(stdout.trim());
          if (stderr) this.log(stderr.trim());
          this.log(`Installed ${PACKAGE}@${spec} successfully.`);
        } catch (err: unknown) {
          if (err instanceof NpmNotFoundError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`npm install failed: ${msg}`);
        }
      },
    );
  }

  /** First install: no copy was found anywhere, so there is nothing to lower. */
  private async installLatest(): Promise<void> {
    await this.npmInstall("latest", "Claude Bridge: installing the bridge...");
  }

  /**
   * Replace `from` with the release `to`. The comparison is repeated here,
   * next to the command it guards, so that no caller can reach the install
   * with a version that is not strictly newer.
   */
  private async upgrade(from: string, to: string): Promise<void> {
    const order = compareVersions(to, from);
    if (order === null || order <= 0) {
      throw new Error(
        `refusing to install ${PACKAGE}@${to} over ${from}: it is not newer`,
      );
    }
    await this.npmInstall(to, `Claude Bridge: upgrading to v${to}...`);
  }

  /**
   * Make sure a bridge at least as new as this extension needs is installed.
   *
   * - A bridge at or above the minimum: nothing to do.
   * - A version check that failed: nothing is installed. Not being able to
   *   read the version is not evidence that no bridge is there.
   * - No bridge anywhere: `npm install -g patchwork-os@latest`.
   * - A bridge below the minimum: upgraded to the registry's latest release,
   *   and only if that release is strictly newer than every copy found.
   */
  async ensureInstalled(): Promise<void> {
    const minimum = this.getMinimumVersion();
    const onPath = await this.probeInstalled();

    if (onPath.kind === "unknown") {
      this.leaveAsIs(
        `The bridge version check failed (${onPath.reason}). A check that fails is not treated as "not installed". To install or upgrade by hand: npm install -g ${PACKAGE}@latest.`,
        "could not check the installed bridge version — left as is",
      );
      return;
    }
    if (onPath.kind === "installed" && isAtLeast(onPath.version, minimum)) {
      this.log(
        `claude-ide-bridge ${onPath.version} is installed (this extension needs ${minimum} or newer) — no action needed.`,
      );
      return;
    }

    // An install is now possible, so find out what it would replace. The
    // binary on PATH is one copy. The package in npm's global directory is
    // the one `npm install -g` writes over, and it need not be the same one.
    const inNpm = await this.probeNpmGlobal();
    if (inNpm.kind === "unknown") {
      this.leaveAsIs(
        `Could not read npm's global packages (${inNpm.reason}), so it is not known what an install would replace.`,
        "could not check npm's global packages — bridge left as is",
      );
      return;
    }

    const newest = newestOf(
      [onPath, inNpm].flatMap((found) =>
        found.kind === "installed" ? [found.version] : [],
      ),
    );
    if (newest === null) {
      this.log(`No bridge found — installing ${PACKAGE}@latest.`);
      await this.installLatest();
      return;
    }

    if (inNpm.kind === "installed" && isAtLeast(inNpm.version, minimum)) {
      // npm already holds a copy that is new enough. Installing again cannot
      // change which binary PATH finds.
      const seen =
        onPath.kind === "installed"
          ? `an older claude-ide-bridge (${onPath.version}) comes first on this editor's PATH`
          : "claude-ide-bridge is not on this editor's PATH";
      this.leaveAsIs(
        `${PACKAGE} ${inNpm.version} is in npm's global directory, but ${seen}. Check PATH: \`npm prefix -g\` shows where npm installs global packages.`,
        onPath.kind === "installed"
          ? "an older bridge comes first on PATH"
          : "the bridge is installed but not on PATH",
      );
      return;
    }

    // Every copy found is older than this extension needs. Only a release
    // strictly newer than the newest of them may replace it.
    const latest = await this.latestRelease();
    if (latest === null) {
      this.leaveAsIs(
        `claude-ide-bridge ${newest} is older than this extension needs (${minimum}), but the latest release could not be read from the npm registry. It is checked again the next time the extension starts.`,
        "could not reach npm to check for a newer bridge",
      );
      return;
    }
    if ((compareVersions(latest, newest) ?? 0) <= 0) {
      this.leaveAsIs(
        `claude-ide-bridge ${newest} is older than this extension needs (${minimum}), but npm's latest release is ${latest}, which is not newer than what is installed.`,
        "no newer bridge release on npm",
      );
      return;
    }
    this.log(`Upgrading ${newest} → ${PACKAGE}@${latest}.`);
    await this.upgrade(newest, latest);
  }
}

/** True unless `version` is known to be older than `minimum`. */
function isAtLeast(version: string, minimum: string): boolean {
  const order = compareVersions(version, minimum);
  return order === null || order >= 0;
}

/** The newest of the versions found, or null when none was found. */
function newestOf(versions: string[]): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (newest === null || (compareVersions(version, newest) ?? 0) > 0) {
      newest = version;
    }
  }
  return newest;
}
