import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { error, successStructured } from "./utils.js";

function getGlobalNotePath(configDir: string): string {
  return path.join(configDir, "ide", "handoff-note.json");
}

function workspaceScopedNotePath(workspace: string, configDir: string): string {
  // Normalize before hashing so trailing slashes and relative paths don't
  // produce different hashes for the same workspace across restarts.
  const normalizedWorkspace = path.resolve(workspace);
  const hash = crypto
    .createHash("sha256")
    .update(normalizedWorkspace)
    .digest("hex")
    .slice(0, 12);
  return path.join(configDir, "ide", `handoff-note-${hash}.json`);
}

function resolveConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

interface HandoffNote {
  note: string;
  updatedAt: number;
  updatedBy: string; // "desktop" | "cli" | "unknown"
  auto?: boolean;
}

// In-memory read cache: path → { value, expiresAt }
// Eliminates redundant disk reads when getHandoffNote is called repeatedly
// within a short window (e.g. automation hooks, session start sequences).
const READ_CACHE_TTL_MS = 30_000; // 30 seconds
interface CacheEntry {
  value: HandoffNote | null;
  expiresAt: number;
}
const noteReadCache = new Map<string, CacheEntry>();

function getCachedNote(notePath: string): HandoffNote | null | undefined {
  const entry = noteReadCache.get(notePath);
  if (!entry) return undefined; // cache miss
  if (Date.now() > entry.expiresAt) {
    noteReadCache.delete(notePath);
    return undefined; // expired
  }
  return entry.value; // cache hit (may be null for "file not found")
}

const NOTE_READ_CACHE_MAX_SIZE = 50;

function setCachedNote(notePath: string, value: HandoffNote | null): void {
  // Evict oldest entry when cache is at capacity (handles multi-workspace scenarios).
  if (
    !noteReadCache.has(notePath) &&
    noteReadCache.size >= NOTE_READ_CACHE_MAX_SIZE
  ) {
    const oldest = noteReadCache.keys().next().value;
    if (oldest !== undefined) noteReadCache.delete(oldest);
  }
  noteReadCache.set(notePath, {
    value,
    expiresAt: Date.now() + READ_CACHE_TTL_MS,
  });
}

function invalidateCachedNote(notePath: string): void {
  noteReadCache.delete(notePath);
}

/** Maximum handoff note size enforced at read time (matches write-time cap). */
const MAX_NOTE_READ_CHARS = 10_000;

function readNoteFromPath(notePath: string): HandoffNote | null {
  const cached = getCachedNote(notePath);
  if (cached !== undefined) return cached;

  try {
    const raw = fs.readFileSync(notePath, "utf-8");
    const result = JSON.parse(raw) as HandoffNote;
    // Enforce read-time cap: a manually edited or oversized file must not inject
    // unbounded content into Claude's context via contextBundle or getHandoffNote.
    if (
      typeof result.note === "string" &&
      result.note.length > MAX_NOTE_READ_CHARS
    ) {
      // Spread to codepoints before slicing so multibyte chars aren't split mid-sequence.
      result.note =
        [...result.note].slice(0, MAX_NOTE_READ_CHARS).join("") +
        "\n[truncated]";
    }
    setCachedNote(notePath, result);
    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File genuinely missing — cache null so we don't hammer the FS.
      setCachedNote(notePath, null);
    } else {
      // Parse error, permission error, etc. — log and do NOT cache so the
      // next call retries from disk (avoids silently returning "no note" for
      // a temporarily corrupt file).
      console.error(
        `[readNoteFromPath] Failed to read/parse handoff note at ${notePath}:`,
        err,
      );
    }
    return null;
  }
}

export async function readNote(
  workspace?: string,
  configDir?: string,
): Promise<HandoffNote | null> {
  const dir = configDir ?? resolveConfigDir();
  if (workspace) {
    const scoped = readNoteFromPath(workspaceScopedNotePath(workspace, dir));
    if (scoped !== null) return scoped;
  }
  return readNoteFromPath(getGlobalNotePath(dir));
}

export async function writeNote(
  note: string,
  workspace?: string,
  configDir?: string,
  _auto?: boolean,
): Promise<void> {
  const dir = configDir ?? resolveConfigDir();
  const content: HandoffNote = {
    note,
    updatedAt: Date.now(),
    updatedBy: "cli",
    ...(_auto === true ? { auto: true } : {}),
  };
  const contentJson = JSON.stringify(content, null, 2);

  // Determine primary write path
  const primaryPath = workspace
    ? workspaceScopedNotePath(workspace, dir)
    : getGlobalNotePath(dir);

  fs.mkdirSync(path.dirname(primaryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(primaryPath, contentJson, { mode: 0o600 });

  // Invalidate cache so next read reflects the new value immediately.
  invalidateCachedNote(primaryPath);
  // Also update cache with the freshly written value to avoid a disk read.
  setCachedNote(primaryPath, content);

  // Do NOT dual-write to global path when a workspace is provided — this
  // would allow workspace A's note to leak into workspace B via the global
  // fallback read path (cross-workspace prompt injection vector).
}

export function createSetHandoffNoteTool(
  _sessionId: string,
  deps: { workspace?: string; configDir?: string } = {},
) {
  return {
    schema: {
      name: "setHandoffNote",
      annotations: { destructiveHint: true, idempotentHint: true },
      description:
        "Save context note that persists across sessions. Use when switching between CLI and Desktop.",
      inputSchema: {
        type: "object" as const,
        properties: {
          note: {
            type: "string",
            maxLength: 10_000,
            description:
              "Context summary: what you worked on, key findings, and next step.",
          },
        },
        required: ["note"],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          saved: { type: "boolean" },
          updatedAt: { type: "number" },
          message: { type: "string" },
        },
        required: ["saved", "updatedAt"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const note = args.note;
      if (typeof note !== "string") {
        return error("note must be a string");
      }
      if (note.length > 10_000) {
        return error(
          `Note exceeds maximum length of 10,000 characters (got ${note.length}).`,
        );
      }
      try {
        await writeNote(note, deps.workspace, deps.configDir);
      } catch (err) {
        return error(
          `Failed to write handoff note: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return successStructured({ saved: true, updatedAt: Date.now() });
    },
  };
}

export function createGetHandoffNoteTool(
  deps: { workspace?: string; configDir?: string } = {},
) {
  // Pre-compute note paths once at factory time — avoids repeated sha256 hash,
  // path.resolve, and env-var lookups on every handler invocation.
  const configDir = deps.configDir ?? resolveConfigDir();
  const scopedNotePath = deps.workspace
    ? workspaceScopedNotePath(deps.workspace, configDir)
    : null;
  const globalNotePath = getGlobalNotePath(configDir);

  return {
    schema: {
      name: "getHandoffNote",
      annotations: { readOnlyHint: true },
      description:
        "Retrieve handoff note from prior session (Desktop or CLI). Call at session start to resume.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          note: { type: ["string", "null"] },
          message: { type: "string" },
          updatedAt: { type: "number" },
          updatedBy: { type: "string" },
          age: { type: "string" },
        },
        required: ["note"],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      // Use pre-computed paths; cache handles repeated reads without disk I/O.
      let note: HandoffNote | null = null;
      if (scopedNotePath !== null) {
        note = readNoteFromPath(scopedNotePath);
      }
      if (note === null) {
        note = readNoteFromPath(globalNotePath);
      }

      if (!note) {
        return successStructured({
          note: null,
          message: "No handoff note found. Use setHandoffNote to save context.",
        });
      }
      const ageMs = Date.now() - note.updatedAt;
      const ageMinutes = Math.round(ageMs / 60_000);
      const ageLabel =
        ageMinutes < 60
          ? `${ageMinutes}m ago`
          : `${Math.round(ageMinutes / 60)}h ago`;
      return successStructured({
        note: note.note,
        updatedAt: note.updatedAt,
        updatedBy: note.updatedBy,
        age: ageLabel,
      });
    },
  };
}
