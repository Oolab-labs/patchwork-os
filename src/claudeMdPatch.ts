/**
 * CLAUDE.md versioned-block patching helpers.
 *
 * Extracted from src/index.ts so tests can import the pure helpers without
 * triggering the top-level CLI side effects (parseConfig + Bridge.start)
 * that otherwise cause ports like 55000 to be bound from a test run.
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { PACKAGE_VERSION } from "./version.js";

/**
 * Returns the sentinel comment that opens a versioned bridge block in CLAUDE.md.
 * Format: <!-- claude-ide-bridge:start:VERSION -->
 */
export function bridgeBlockStartMarker(version: string): string {
  return `<!-- claude-ide-bridge:start:${version} -->`;
}

/** Sentinel comment that closes a versioned bridge block in CLAUDE.md. */
export const BRIDGE_BLOCK_END = "<!-- claude-ide-bridge:end -->";

/** Regex that matches ANY versioned bridge block (any version). */
export const BRIDGE_BLOCK_RE =
  /<!-- claude-ide-bridge:start:[^\s>]+ -->[\s\S]*?<!-- claude-ide-bridge:end -->/g;

/** Regex that matches a versioned bridge block with a specific version captured. */
const BRIDGE_BLOCK_VERSION_RE =
  /<!-- claude-ide-bridge:start:([^\s>]+) -->[\s\S]*?<!-- claude-ide-bridge:end -->/;

/**
 * Returns the version embedded in an existing versioned bridge block in
 * CLAUDE.md content, or null if no block is present.
 */
export function extractClaudeMdBlockVersion(content: string): string | null {
  const m = BRIDGE_BLOCK_VERSION_RE.exec(content);
  return m?.[1] ?? null;
}

/**
 * Wraps the bridge section (marker line + import line) in versioned sentinels.
 */
function buildVersionedBlock(
  marker: string,
  importLine: string,
  version: string,
): string {
  return `${bridgeBlockStartMarker(version)}\n${marker}\n${importLine}\n${BRIDGE_BLOCK_END}`;
}

/**
 * Patches CLAUDE.md with a versioned bridge block that init can detect and
 * update on re-run.
 *
 * Logic:
 *   - If a versioned block with the current version exists → "already-current"
 *   - If a versioned block with a different version exists → replace it → "updated"
 *   - If the unversioned marker exists but no versioned block → wrap it → "patched"
 *   - If the import line exists standalone (no marker block) → "already-present"
 *   - Otherwise → "no-section"
 *
 * All writes are atomic (write to .tmp with exclusive-create, backup original,
 * rename into place).
 */
export function patchClaudeMdImport(
  targetPath: string,
  marker: string,
  importLine: string,
  version: string = PACKAGE_VERSION,
):
  | "patched"
  | "already-present"
  | "already-current"
  | "updated"
  | "no-section" {
  if (!existsSync(targetPath)) return "no-section";
  const existing = readFileSync(targetPath, "utf-8");

  // Case 1: versioned block present — check if current
  const existingVersion = extractClaudeMdBlockVersion(existing);
  if (existingVersion !== null) {
    if (existingVersion === version) return "already-current";
    // Stale versioned block → replace
    const newBlock = buildVersionedBlock(marker, importLine, version);
    const patched = existing.replace(BRIDGE_BLOCK_RE, newBlock);
    if (patched === existing) return "no-section"; // safety guard
    const remaining = (patched.match(/<!-- claude-ide-bridge:start:/g) ?? [])
      .length;
    if (remaining > 1) {
      console.warn(
        `[patchClaudeMdImport] ${remaining} bridge start sentinels remain after replace — manual cleanup may be needed in ${targetPath}`,
      );
    }
    writePatchedClaudeMd(targetPath, patched);
    return "updated";
  }

  // Case 2: unversioned marker present — wrap it
  if (existing.includes(marker)) {
    if (existing.includes(importLine)) {
      // marker + import present but not versioned — wrap the whole block
      const normalised = existing.endsWith("\n") ? existing : `${existing}\n`;
      // Replace the old "marker\n\nimportLine\n" pattern with versioned block
      const oldBlock1 = `${marker}\n\n${importLine}\n`;
      const oldBlock2 = `${marker}\n${importLine}\n`;
      const newBlock = `${buildVersionedBlock(marker, importLine, version)}\n`;
      const patched = normalised.includes(oldBlock1)
        ? normalised.replace(oldBlock1, newBlock)
        : normalised.includes(oldBlock2)
          ? normalised.replace(oldBlock2, newBlock)
          : null;
      if (patched === null || patched === normalised) {
        // Can't safely restructure — just mark as already-present
        return "already-present";
      }
      writePatchedClaudeMd(targetPath, patched);
      return "patched";
    }
    // marker present, import missing — replace the marker line with the full
    // versioned block (marker included inside sentinels) so that BRIDGE_BLOCK_RE
    // can match it on future passes. Preserves any content that follows.
    const normalised = existing.endsWith("\n") ? existing : `${existing}\n`;
    const markerIdx = normalised.indexOf(marker);
    const markerLineEnd = normalised.indexOf("\n", markerIdx);
    if (markerLineEnd === -1) return "no-section";
    const versionedBlock = buildVersionedBlock(marker, importLine, version);
    const patched =
      normalised.slice(0, markerIdx) +
      versionedBlock +
      "\n" +
      normalised.slice(markerLineEnd + 1);
    writePatchedClaudeMd(targetPath, patched);
    return "patched";
  }

  // Case 3: import line present with no marker section at all
  if (existing.includes(importLine)) return "already-present";

  return "no-section";
}

/** Atomically write patched CLAUDE.md content, backing up the original. */
function writePatchedClaudeMd(targetPath: string, patched: string): void {
  // Use a unique tmp path to avoid EEXIST from a concurrent init run.
  // Do NOT pre-unlink — let `wx` (exclusive create) handle collision on its own.
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, patched, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Concurrent init detected: tmp file ${tmpPath} already exists. Retry once the other process finishes.`,
      );
    }
    throw err;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${targetPath}.${ts}.bak`;
  try {
    renameSync(targetPath, backupPath);
    try {
      renameSync(tmpPath, targetPath);
    } catch (err) {
      // step-2 failed — restore original from backup before re-throwing
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort tmp cleanup */
      }
      try {
        renameSync(backupPath, targetPath);
      } catch (restoreErr) {
        console.error(
          `[writePatchedClaudeMd] Failed to restore backup ${backupPath} → ${targetPath}:`,
          restoreErr,
        );
      }
      throw err;
    }
  } catch (err) {
    // step-1 failed (backup rename) — just clean up tmp
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
