import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { error, success } from "./utils.js";

function getNotePath(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "ide", "handoff-note.json");
}

interface HandoffNote {
  note: string;
  updatedAt: number;
  updatedBy: string; // "desktop" | "cli" | "unknown"
}

function readNote(): HandoffNote | null {
  try {
    const raw = fs.readFileSync(getNotePath(), "utf-8");
    return JSON.parse(raw) as HandoffNote;
  } catch {
    return null;
  }
}

export function createSetHandoffNoteTool(_sessionId: string) {
  return {
    schema: {
      name: "setHandoffNote",
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
      const notePath = getNotePath();
      const content: HandoffNote = {
        note,
        updatedAt: Date.now(),
        updatedBy: "cli",
      };
      try {
        fs.mkdirSync(path.dirname(notePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(notePath, JSON.stringify(content, null, 2), {
          mode: 0o600,
        });
      } catch (err) {
        return error(
          `Failed to write handoff note: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return success({ saved: true, updatedAt: content.updatedAt });
    },
  };
}

export function createGetHandoffNoteTool() {
  return {
    schema: {
      name: "getHandoffNote",
      description:
        "Retrieve the handoff context note left by a previous session (Claude Desktop or Claude Code CLI). Call this at the start of a session to pick up where you left off.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      const note = readNote();
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
