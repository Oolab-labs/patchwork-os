import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitAddTool,
  createGitBlameTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitListBranchesTool,
  createGitPushTool,
} from "../gitWrite.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("gitWrite tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-write-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
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

  describe("gitAdd", () => {
    it("stages a specified file", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "changed content\n");
      const tool = createGitAddTool(tmpDir);
      const result = await tool.handler({ files: ["hello.txt"] });
      const data = parse(result);

      expect(data.staged).toContain("hello.txt");
      expect(data.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe("gitCommit", () => {
    it("creates a commit from staged changes", async () => {
      fs.writeFileSync(path.join(tmpDir, "hello.txt"), "updated content\n");
      execSync("git add hello.txt", { cwd: tmpDir, stdio: "ignore" });

      const tool = createGitCommitTool(tmpDir);
      const result = await tool.handler({ message: "test commit message" });
      const data = parse(result);

      expect(data.hash).toBeDefined();
      expect(data.message).toBe("test commit message");
      expect(data.files).toContain("hello.txt");
    });

    it("returns error when nothing is staged", async () => {
      const tool = createGitCommitTool(tmpDir);
      const result = await tool.handler({ message: "empty commit" });

      expect(result.isError).toBe(true);
      // The error content is a JSON-encoded string message
      const raw = result.content.at(0)?.text ?? "";
      expect(raw.length).toBeGreaterThan(0);
    });
  });

  describe("gitListBranches", () => {
    it("returns at least one branch", async () => {
      const tool = createGitListBranchesTool(tmpDir);
      const result = await tool.handler({});
      const data = parse(result);

      expect(data.local).toBeDefined();
      expect(data.local.length).toBeGreaterThanOrEqual(1);
      expect(data.current).toBeDefined();
    });
  });

  describe("gitPush", () => {
    it("blocks force push to main", async () => {
      // Rename default branch to 'main' for this check
      try {
        execSync("git branch -m main", { cwd: tmpDir, stdio: "ignore" });
      } catch {
        // branch may already be main
      }
      const tool = createGitPushTool(tmpDir);
      const result = await tool.handler({ branch: "main", force: true });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/Force push to 'main' is blocked/);
    });

    it("blocks force push to master", async () => {
      const tool = createGitPushTool(tmpDir);
      const result = await tool.handler({ branch: "master", force: true });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/blocked/i);
    });

    it("returns error for invalid remote name", async () => {
      const tool = createGitPushTool(tmpDir);
      const result = await tool.handler({ remote: "bad remote!" });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/Invalid remote name/);
    });

    it("returns error for invalid branch name", async () => {
      const tool = createGitPushTool(tmpDir);
      const result = await tool.handler({ branch: "bad branch!" });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toMatch(/Invalid branch name/);
    });

    it("returns error when no upstream is set and remote doesn't exist", async () => {
      const tool = createGitPushTool(tmpDir);
      // tmpDir has no remotes configured — push should fail
      const result = await tool.handler({ remote: "origin" });
      expect(result.isError).toBe(true);
    });
  });

  describe("gitCheckout", () => {
    it("reports previousBranch: null and wasDetached: true when switching away from detached HEAD", async () => {
      // Regression: previousBranch was set to the literal string "HEAD" when in
      // detached HEAD state. "HEAD" is not a valid branch name for gitCheckout, so
      // callers couldn't use it to navigate back. The fix returns null + a commit hash.
      const hash = execSync("git rev-parse HEAD", { cwd: tmpDir })
        .toString()
        .trim();
      execSync(`git checkout --detach ${hash}`, {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execSync("git branch feature", { cwd: tmpDir, stdio: "ignore" });

      const tool = createGitCheckoutTool(tmpDir);
      const result = await tool.handler({ branch: "feature" });
      const data = parse(result);

      expect(result.isError).toBeFalsy();
      expect(data.branch).toBe("feature");
      expect(data.previousBranch).toBeNull();
      expect(data.wasDetached).toBe(true);
      expect(data.previousCommit).toMatch(/^[0-9a-f]{12}$/);
    });

    it("reports previousBranch name (not null) when switching from a normal branch", async () => {
      const initialBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: tmpDir,
      })
        .toString()
        .trim();
      execSync("git branch feature", { cwd: tmpDir, stdio: "ignore" });

      const tool = createGitCheckoutTool(tmpDir);
      const result = await tool.handler({ branch: "feature" });
      const data = parse(result);

      expect(result.isError).toBeFalsy();
      expect(data.branch).toBe("feature");
      expect(data.previousBranch).toBe(initialBranch);
      expect(data.wasDetached).toBeUndefined();
      expect(data.previousCommit).toBeUndefined();
    });
  });

  describe("gitBlame", () => {
    it("returns blame output for a committed file", async () => {
      const tool = createGitBlameTool(tmpDir);
      const result = await tool.handler({ filePath: "hello.txt" });
      const data = parse(result);

      expect(data.lines).toBeDefined();
      expect(data.lines.length).toBeGreaterThanOrEqual(1);
      expect(data.lines[0].author).toBeDefined();
      expect(data.lines[0].code).toBeDefined();
    });

    it("returns error for an untracked file", async () => {
      fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "not committed\n");
      const tool = createGitBlameTool(tmpDir);
      const result = await tool.handler({ filePath: "untracked.txt" });

      expect(result.isError).toBe(true);
    });
  });
});
