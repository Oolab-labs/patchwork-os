import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGetGitDiffTool } from "../getGitDiff.js";
import { createGetGitLogTool } from "../getGitLog.js";
import { createGetGitStatusTool } from "../getGitStatus.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("git tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
    // Init a git repo with a single commit
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync('git config user.name "Test User"', {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execSync('git config user.email "test@example.com"', {
      cwd: tmpDir,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello world\n");
    execSync("git add hello.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', {
      cwd: tmpDir,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getGitStatus", () => {
    it("returns branch name and empty arrays after a clean commit", async () => {
      const tool = createGetGitStatusTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.branch).toBe("main");
      expect(data.staged).toEqual([]);
      expect(data.unstaged).toEqual([]);
      expect(data.untracked).toEqual([]);
    });

    it("reports untracked files", async () => {
      fs.writeFileSync(path.join(tmpDir, "new.txt"), "new file\n");
      const tool = createGetGitStatusTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.untracked).toContain("new.txt");
    });

    it("reports staged files", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "changed\n");
      execSync("git add hello.txt", { cwd: tmpDir, stdio: "ignore" });
      const tool = createGetGitStatusTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.staged).toContain("hello.txt");
    });

    it("reports unstaged modifications", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "modified\n");
      const tool = createGetGitStatusTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.unstaged).toContain("hello.txt");
    });
  });

  describe("getGitStatus on non-git directory", () => {
    it("returns available: false for a non-git directory", async () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "nongit-"));
      try {
        const tool = createGetGitStatusTool(nonGitDir);
        const result = await tool.handler({});
        const data = parse(result);

        expect(data.available).toBe(false);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe("getGitDiff", () => {
    it("shows diff output for a modified file", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello changed\n");
      const tool = createGetGitDiffTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.diff).toContain("hello.txt");
      expect(data.diff).toContain("-hello world");
      expect(data.diff).toContain("+hello changed");
      expect(data.truncated).toBe(false);
    });

    it("returns empty diff when nothing changed", async () => {
      const tool = createGetGitDiffTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.diff).toBe("");
      expect(data.truncated).toBe(false);
    });

    it("shows staged diff with staged option", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "staged change\n");
      execSync("git add hello.txt", { cwd: tmpDir, stdio: "ignore" });
      const tool = createGetGitDiffTool(tmpDir);
      const result = await tool.handler({ staged: true });
      const data = parse(result);

      expect(data.diff).toContain("+staged change");
    });
  });

  describe("getGitLog", () => {
    it("returns at least one entry with hash, author, date, subject", async () => {
      const tool = createGetGitLogTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.entries.length).toBeGreaterThanOrEqual(1);
      const entry = data.entries[0];
      expect(entry.hash).toBeDefined();
      expect(entry.hash.length).toBeGreaterThan(0);
      expect(entry.author).toBe("test@example.com");
      expect(entry.date).toBeDefined();
      expect(entry.subject).toBe("initial commit");
    });

    it("respects maxEntries", async () => {
      // Add a second commit
      fs.writeFileSync(path.join(tmpDir, "second.txt"), "second\n");
      execSync("git add second.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "second commit"', {
        cwd: tmpDir,
        stdio: "ignore",
      });

      const tool = createGetGitLogTool(tmpDir);
      const result = await tool.handler({ maxEntries: 1 });
      const data = parse(result);

      expect(data.entries.length).toBe(1);
      expect(data.entries[0].subject).toBe("second commit");
    });
  });
});
