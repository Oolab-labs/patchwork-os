import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGetHandoffNoteTool,
  createSetHandoffNoteTool,
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
      expect(getContent.updatedBy).toBe("session-abc");
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
  });
});
