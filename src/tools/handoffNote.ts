import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { error, success } from "./utils.js";

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

  // Dual-write to global path (best-effort) when writing to a scoped path
  if (workspace) {
    const globalPath = getGlobalNotePath(dir);
    try {
      fs.mkdirSync(path.dirname(globalPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(globalPath, contentJson, { mode: 0o600 });
    } catch {
      // best-effort — ignore failures on global write
    }
  }
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
        "Save a context note that persists across sessions — readable by Claude Code CLI, Claude Desktop, and any other MCP client connected to this bridge. Use this to hand off context when switching between the desktop app and the terminal (e.g. 'working on auth bug in login.ts:42, next step: fix token expiry logic').",
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
    },
    handler: async (args: Record<string, unknown>) => {
      const note = args.note as string;
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
      return success({ saved: true, updatedAt: Date.now() });
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
        "Retrieve the handoff context note left by a previous session (Claude Desktop or Claude Code CLI). Call this at the start of a session to pick up where you left off.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      const note = await readNote(deps.workspace, deps.configDir);
      if (!note) {
        return success({
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
      return success({
        note: note.note,
        updatedAt: note.updatedAt,
        updatedBy: note.updatedBy,
        age: ageLabel,
      });
    },
  };
}
