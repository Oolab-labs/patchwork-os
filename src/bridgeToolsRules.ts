/**
 * Shared helpers for validating and repairing .claude/rules/bridge-tools.md.
 * Used by both the CLI (src/index.ts) and the bridge server (src/bridge.ts)
 * so the bridge can auto-repair stale files at startup instead of just warning.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRIDGE_TOOLS_MIN_BYTES = 200;

/**
 * Returns true if bridge-tools.md is present and up-to-date with current package version.
 * Returns false on missing file, stale version sentinel, or read error.
 */
export function isBridgeToolsFileValid(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (content.length > 512 * 1024) return false;
    if (content.length < BRIDGE_TOOLS_MIN_BYTES) return false;
    return (
      content.includes("getDiagnostics") &&
      content.includes("MANDATORY") &&
      content.includes("batchGetHover") &&
      content.includes(`<!-- bridge-tools v${PACKAGE_VERSION} -->`)
    );
  } catch {
    return false;
  }
}

function writeRulesFileAtomic(rulesFilePath: string, content: string): void {
  const tmpPath = `${rulesFilePath}.tmp`;
  writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    renameSync(tmpPath, rulesFilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Writes or repairs .claude/rules/bridge-tools.md.
 * - `writeIfMissing: true` (default for gen-claude-md): writes even when absent.
 * - `writeIfMissing: false` (default for bridge startup): only updates existing stale files.
 * No-ops if the file is already valid or the template is missing.
 * Returns true if a write/repair was performed, false otherwise.
 */
export function repairBridgeToolsRulesIfStale(
  workspace: string,
  log?: (msg: string) => void,
  { writeIfMissing = false }: { writeIfMissing?: boolean } = {},
): boolean {
  const rulesDir = path.join(workspace, ".claude", "rules");
  const rulesFilePath = path.join(rulesDir, "bridge-tools.md");
  if (!writeIfMissing && !existsSync(rulesFilePath)) return false;
  if (isBridgeToolsFileValid(rulesFilePath)) return false;

  const templatePath = path.resolve(
    __dirname,
    "..",
    "templates",
    "bridge-tools.md",
  );
  if (!existsSync(templatePath)) return false;

  try {
    // Clean up any leftover .tmp from a previous crashed write
    const tmpPath = `${rulesFilePath}.tmp`;
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore ENOENT */
    }
    mkdirSync(rulesDir, { recursive: true });
    writeRulesFileAtomic(
      rulesFilePath,
      readFileSync(templatePath, "utf-8").replace(
        "{{VERSION}}",
        PACKAGE_VERSION,
      ),
    );
    log?.(
      `[bridge-tools] Repaired stale .claude/rules/bridge-tools.md → v${PACKAGE_VERSION}`,
    );
    return true;
  } catch {
    /* non-fatal — best-effort repair only */
    return false;
  }
}
