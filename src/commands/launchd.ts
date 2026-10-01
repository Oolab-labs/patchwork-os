import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectWorkspaceSymlinkInstall,
  PATCHWORK_PACKAGE_NAME,
  SYMLINK_INSTALL_FIX,
} from "../installGuard.js";

const PLIST_LABEL = "co.patchwork-os.bridge";
const PLIST_DEST = path.join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const LOG_DIR = path.join(homedir(), "Library", "Logs", "patchwork-os");

/**
 * Escape XML character-data special characters so a path containing `&`, `<`,
 * `>`, `"`, or `'` doesn't corrupt the generated plist (cli-commands-4).
 * `&` must be replaced first so the entity ampersands it introduces aren't
 * double-escaped.
 */
export function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistTemplate(): string {
  // Look for template relative to this file in dist/ → templates/
  const here = fileURLToPath(import.meta.url);
  const templatePath = path.join(
    path.dirname(here),
    "..",
    "..",
    "templates",
    `${PLIST_LABEL}.plist`,
  );
  if (!existsSync(templatePath)) {
    throw new Error(`plist template not found at ${templatePath}`);
  }
  return readFileSync(templatePath, "utf-8");
}

function binaryPath(): string {
  // Try to find the globally installed binary
  const result = spawnSync("which", ["patchwork-os"], { encoding: "utf-8" });
  if (!result.error && result.stdout.trim()) return result.stdout.trim();
  // Fallback: use process.execPath (node) with the main script
  return process.execPath;
}

export async function runLaunchdInstall(_argv: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write("launchd is only available on macOS\n");
    process.exit(1);
  }

  // Refuse to register a LaunchAgent when a symlinked global install is detected.
  // launchctl can hit EPERM when the macOS sandbox follows that link into
  // workspace directories such as ~/Documents.
  const symlinkInfo = detectWorkspaceSymlinkInstall();
  if (symlinkInfo) {
    process.stderr.write(
      `\nError: cannot install LaunchAgent — detected a symlinked global ${PATCHWORK_PACKAGE_NAME} install.\n` +
        `  Logical root: ${symlinkInfo.logicalRoot}\n` +
        `  Real path:    ${symlinkInfo.realRoot}\n\n` +
        "  The macOS sandbox can deny access to workspace files under ~/Documents,\n" +
        "  causing EPERM when launchctl starts the bridge.\n\n" +
        SYMLINK_INSTALL_FIX +
        "  Then re-run: patchwork-os launchd install\n\n",
    );
    process.exit(1);
  }

  const home = homedir();
  const bin = binaryPath();

  // Escape XML character-data special chars before substitution — the
  // placeholders sit inside <string> elements. A binary path or HOME under a
  // directory containing '&', '<', '>' would otherwise emit malformed XML and
  // launchctl would silently reject the plist (cli-commands-4).
  let plist = plistTemplate();
  plist = plist.replaceAll("__BINARY_PATH__", xmlEscape(bin));
  plist = plist.replaceAll("__HOME__", xmlEscape(home));

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(path.dirname(PLIST_DEST), { recursive: true });

  writeFileSync(PLIST_DEST, plist, { mode: 0o644 });

  // Use the modern launchctl bootstrap/bootout API (replaces deprecated
  // `load/unload -w` which macOS 10.10+ deprecated and Sequoia warns on).
  // bootout is idempotent — non-fatal if not previously loaded.
  const uid = process.getuid ? process.getuid() : 501;
  const domain = `gui/${uid}`;
  spawnSync("launchctl", ["bootout", domain, PLIST_DEST]);
  const loadResult = spawnSync("launchctl", ["bootstrap", domain, PLIST_DEST], {
    encoding: "utf-8",
  });
  if (loadResult.status !== 0) {
    process.stderr.write(
      `Warning: launchctl bootstrap failed (status ${loadResult.status}): ${loadResult.stderr || ""}\n`,
    );
  }

  process.stdout.write(`✓ Patchwork OS installed as launchd agent\n`);
  process.stdout.write(`  Plist: ${PLIST_DEST}\n`);
  process.stdout.write(`  Logs:  ${LOG_DIR}/bridge.log\n`);
  process.stdout.write(`  The bridge will start automatically on login.\n`);
  process.stdout.write(`\n  To uninstall: patchwork-os launchd uninstall\n`);
}

export async function runLaunchdUninstall(_argv: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write("launchd is only available on macOS\n");
    process.exit(1);
  }

  if (!existsSync(PLIST_DEST)) {
    process.stdout.write("Patchwork OS launchd agent not installed.\n");
    return;
  }

  // Modern launchctl API: bootout replaces deprecated `unload -w`.
  const uid = process.getuid ? process.getuid() : 501;
  spawnSync("launchctl", ["bootout", `gui/${uid}`, PLIST_DEST]);

  const { unlinkSync } = await import("node:fs");
  try {
    unlinkSync(PLIST_DEST);
  } catch {
    /* ok */
  }

  process.stdout.write(`✓ Patchwork OS launchd agent removed\n`);
}

/**
 * Seams for `launchd status`, injected so the command is testable without a
 * LaunchAgent and on non-macOS CI. Production passes nothing and gets the
 * real filesystem, `launchctl` and platform.
 */
export interface LaunchdStatusDeps {
  platform: NodeJS.Platform;
  uid: number;
  exists: (path: string) => boolean;
  /** `launchctl print gui/<uid>/<label>` — exit status and stdout. */
  launchctlPrint: (target: string) => { status: number | null; stdout: string };
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function defaultStatusDeps(): LaunchdStatusDeps {
  return {
    platform: process.platform,
    uid: process.getuid ? process.getuid() : 501,
    exists: existsSync,
    launchctlPrint: (target) => {
      const r = spawnSync("launchctl", ["print", target], {
        encoding: "utf-8",
      });
      return { status: r.error ? 1 : r.status, stdout: r.stdout ?? "" };
    },
    stdout: (s) => {
      process.stdout.write(s);
    },
    stderr: (s) => {
      process.stderr.write(s);
    },
  };
}

/**
 * `patchwork launchd status [--json]` — is the LaunchAgent installed, loaded
 * and running? Advertised in `--help` since the command shipped; the
 * dispatcher had no branch for it until 2026-10-01, so it printed the
 * install|uninstall usage and exited 1.
 *
 * Three facts, in the order they can fail: the plist exists; launchd has it
 * loaded (`launchctl print` exits 0 — a plist on disk that was never
 * bootstrapped is the common half-installed state); and the job has a pid.
 * Exit 0 only when all three hold, so `launchd status && …` means "the agent
 * is actually serving". Returns the exit code rather than calling
 * `process.exit`, so the dispatcher owns the exit and the tests can assert.
 */
export async function runLaunchdStatus(
  argv: string[],
  deps: LaunchdStatusDeps = defaultStatusDeps(),
): Promise<number> {
  const json = argv.includes("--json");
  if (deps.platform !== "darwin") {
    deps.stderr("launchd is only available on macOS\n");
    return 1;
  }

  const installed = deps.exists(PLIST_DEST);
  let loaded = false;
  let running = false;
  let pid: number | null = null;
  let lastExitCode: number | null = null;

  if (installed) {
    const r = deps.launchctlPrint(`gui/${deps.uid}/${PLIST_LABEL}`);
    loaded = r.status === 0;
    if (loaded) {
      const pidMatch = r.stdout.match(/^\s*pid = (\d+)\s*$/m);
      if (pidMatch) pid = Number(pidMatch[1]);
      const exitMatch = r.stdout.match(/^\s*last exit code = (-?\d+)\s*$/m);
      if (exitMatch) lastExitCode = Number(exitMatch[1]);
      running = pid !== null && /^\s*state = running\s*$/m.test(r.stdout);
    }
  }

  const ok = installed && loaded && running;

  if (json) {
    deps.stdout(
      `${JSON.stringify({
        label: PLIST_LABEL,
        plistPath: PLIST_DEST,
        installed,
        loaded,
        running,
        pid,
        lastExitCode,
        ok,
      })}\n`,
    );
    return ok ? 0 : 1;
  }

  const lines = [`Patchwork OS LaunchAgent (${PLIST_LABEL})`];
  if (!installed) {
    lines.push(
      `  Plist:   ${PLIST_DEST} — not installed`,
      "  Run `patchwork-os launchd install` to register it.",
    );
  } else {
    lines.push(`  Plist:   ${PLIST_DEST}`);
    lines.push(
      `  Loaded:  ${loaded ? "yes" : "no"}${loaded ? "" : " (on disk but not bootstrapped — re-run `launchd install`)"}`,
    );
    if (loaded) {
      lines.push(
        running
          ? `  State:   running (pid ${pid})`
          : `  State:   not running${lastExitCode === null ? "" : ` (last exit code ${lastExitCode})`}`,
      );
    }
  }
  deps.stdout(`${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}
