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

  let plist = plistTemplate();
  plist = plist.replaceAll("__BINARY_PATH__", bin);
  plist = plist.replaceAll("__HOME__", home);

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
