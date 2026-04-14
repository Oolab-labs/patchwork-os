import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { error, successStructured } from "./utils.js";

function getGlobalNotePath(configDir: string): string {
  return path.join(configDir, "ide", "handoff-note.json");
}

function workspaceScopedNotePath(workspace: string, configDir: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(workspace)
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

function readNoteFromPath(notePath: string): HandoffNote | null {
  try {
    const raw = fs.readFileSync(notePath, "utf-8");
    return JSON.parse(raw) as HandoffNote;
  } catch {
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
              "Free-text context summary. Keep it concise — one to a few sentences describing what you were working on, key findings, and the next step.",
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
      const note = await readNote(deps.workspace, deps.configDir);
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
