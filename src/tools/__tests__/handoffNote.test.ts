import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGetHandoffNoteTool,
  createSetHandoffNoteTool,
  readNote,
  writeNote,
} from "../handoffNote.js";

describe("handoffNote tools", () => {
  let tmpDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-test-"));
    origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, "ide"), { recursive: true });
  });

  afterEach(() => {
    if (origEnv === undefined) {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    } else {
      process.env.CLAUDE_CONFIG_DIR = origEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getHandoffNote", () => {
    it("returns null note when no file exists", async () => {
      const tool = createGetHandoffNoteTool();
      const result = await tool.handler({});
      expect(result.isError).toBeFalsy();
      const content = JSON.parse((result.content[0] as { text: string }).text);
      expect(content.note).toBeNull();
    });
  });

  describe("setHandoffNote + getHandoffNote", () => {
    it("round-trips a note", async () => {
      const setter = createSetHandoffNoteTool("session-abc");
      const getter = createGetHandoffNoteTool();

      const setResult = await setter.handler({
        note: "Working on auth bug in login.ts:42",
      });
      expect(setResult.isError).toBeFalsy();
      const setContent = JSON.parse(
        (setResult.content[0] as { text: string }).text,
      );
      expect(setContent.saved).toBe(true);

      const getResult = await getter.handler({});
      expect(getResult.isError).toBeFalsy();
      const getContent = JSON.parse(
        (getResult.content[0] as { text: string }).text,
      );
      expect(getContent.note).toBe("Working on auth bug in login.ts:42");
      expect(getContent.updatedBy).toBe("cli");
      expect(getContent.age).toMatch(/m ago|h ago/);
    });

    it("overwrites the previous note", async () => {
      const setter = createSetHandoffNoteTool("s1");
      await setter.handler({ note: "first note" });
      await setter.handler({ note: "second note" });

      const getter = createGetHandoffNoteTool();
      const result = await getter.handler({});
      const content = JSON.parse((result.content[0] as { text: string }).text);
      expect(content.note).toBe("second note");
    });

    it("writes the note file with restricted permissions", async () => {
      const setter = createSetHandoffNoteTool("s1");
      await setter.handler({ note: "secret context" });

      const notePath = path.join(tmpDir, "ide", "handoff-note.json");
      const stat = fs.statSync(notePath);
      // mode & 0o777 should be 0o600
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("rejects notes exceeding 10,000 characters", async () => {
      const setter = createSetHandoffNoteTool("s1");
      const longNote = "x".repeat(10_001);
      const result = await setter.handler({ note: longNote });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/10,000/);
    });

    it("accepts notes at exactly 10,000 characters", async () => {
      const setter = createSetHandoffNoteTool("s1");
      const exactNote = "x".repeat(10_000);
      const result = await setter.handler({ note: exactNote });
      expect(result.isError).toBeFalsy();
    });

    it("stores updatedBy as 'cli' not a raw session UUID", async () => {
      const setter = createSetHandoffNoteTool("some-uuid-1234");
      await setter.handler({ note: "test" });

      const getter = createGetHandoffNoteTool();
      const result = await getter.handler({});
      const content = JSON.parse((result.content[0] as { text: string }).text);
      expect(content.updatedBy).toBe("cli");
      expect(content.updatedBy).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // not a UUID
    });
  });

  describe("workspace-scoped note helpers", () => {
    const workspace = "/home/user/my-project";

    function scopedPath(ws: string, dir: string): string {
      const hash = crypto
        .createHash("sha256")
        .update(ws)
        .digest("hex")
        .slice(0, 12);
      return path.join(dir, "ide", `handoff-note-${hash}.json`);
    }

    it("writeNote with workspace writes to scoped path", async () => {
      await writeNote("scoped note", workspace, tmpDir);
      const sp = scopedPath(workspace, tmpDir);
      expect(fs.existsSync(sp)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      expect(parsed.note).toBe("scoped note");
    });

    it("writeNote with workspace does NOT dual-write to global path", async () => {
      await writeNote("workspace only note", workspace, tmpDir);
      const globalPath = path.join(tmpDir, "ide", "handoff-note.json");
      // Global path must NOT be written when workspace is provided
      expect(fs.existsSync(globalPath)).toBe(false);
    });

    it("readNote with workspace reads scoped path first", async () => {
      // Write different notes to scoped and global
      const sp = scopedPath(workspace, tmpDir);
      fs.writeFileSync(
        sp,
        JSON.stringify({
          note: "scoped",
          updatedAt: Date.now(),
          updatedBy: "cli",
        }),
        { mode: 0o600 },
      );
      const globalPath = path.join(tmpDir, "ide", "handoff-note.json");
      fs.writeFileSync(
        globalPath,
        JSON.stringify({
          note: "global",
          updatedAt: Date.now(),
          updatedBy: "cli",
        }),
        { mode: 0o600 },
      );
      const result = await readNote(workspace, tmpDir);
      expect(result?.note).toBe("scoped");
    });

    it("readNote with workspace falls back to global when scoped path missing", async () => {
      const globalPath = path.join(tmpDir, "ide", "handoff-note.json");
      fs.writeFileSync(
        globalPath,
        JSON.stringify({
          note: "fallback note",
          updatedAt: Date.now(),
          updatedBy: "cli",
        }),
        { mode: 0o600 },
      );
      const result = await readNote(workspace, tmpDir);
      expect(result?.note).toBe("fallback note");
    });

    it("readNote without workspace reads global path", async () => {
      const globalPath = path.join(tmpDir, "ide", "handoff-note.json");
      fs.writeFileSync(
        globalPath,
        JSON.stringify({
          note: "global only",
          updatedAt: Date.now(),
          updatedBy: "cli",
        }),
        { mode: 0o600 },
      );
      const result = await readNote(undefined, tmpDir);
      expect(result?.note).toBe("global only");
    });

    it("readNote returns null when no files exist", async () => {
      const result = await readNote(workspace, tmpDir);
      expect(result).toBeNull();
    });

    it("workspace A note does not leak into workspace B via global fallback", async () => {
      // Workspace A writes a note
      const workspaceA = "/home/user/project-a-leak-test";
      const workspaceB = "/home/user/project-b-leak-test";
      await writeNote("secret from A", workspaceA, tmpDir);
      // Workspace B has no scoped note — should NOT fall back to global with A's content
      const resultB = await readNote(workspaceB, tmpDir);
      expect(resultB?.note).not.toBe("secret from A");
    });

    it("scoped note path differs per workspace", async () => {
      const ws1 = "/home/user/project-a";
      const ws2 = "/home/user/project-b";
      await writeNote("note for a", ws1, tmpDir);
      await writeNote("note for b", ws2, tmpDir);

      const r1 = await readNote(ws1, tmpDir);
      const r2 = await readNote(ws2, tmpDir);
      expect(r1?.note).toBe("note for a");
      expect(r2?.note).toBe("note for b");
    });

    it("writeNote with _auto=true sets auto flag in stored note", async () => {
      await writeNote("auto snapshot", workspace, tmpDir, true);
      const sp = scopedPath(workspace, tmpDir);
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      expect(parsed.auto).toBe(true);
    });

    it("tool with workspace dep reads scoped note", async () => {
      await writeNote("workspace-specific", workspace, tmpDir);
      const getter = createGetHandoffNoteTool({
        workspace,
        configDir: tmpDir,
      });
      const result = await getter.handler({});
      expect(result.isError).toBeFalsy();
      const content = JSON.parse((result.content[0] as { text: string }).text);
      expect(content.note).toBe("workspace-specific");
    });

    it("tool with workspace dep writes scoped note", async () => {
      const setter = createSetHandoffNoteTool("s1", {
        workspace,
        configDir: tmpDir,
      });
      await setter.handler({ note: "tool scoped write" });

      const sp = scopedPath(workspace, tmpDir);
      expect(fs.existsSync(sp)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(sp, "utf-8"));
      expect(parsed.note).toBe("tool scoped write");
    });
  });
});
