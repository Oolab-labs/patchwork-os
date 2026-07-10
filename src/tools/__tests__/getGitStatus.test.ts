import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGetGitStatusTool } from "../getGitStatus.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("getGitStatus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "get-git-status-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports available:false outside a git repository", async () => {
    const tool = createGetGitStatusTool(tmpDir);
    const data = parse(await tool.handler({}));
    expect(data.available).toBe(false);
    expect(data.error).toBe("Not a git repository");
  });

  describe("inside a repo", () => {
    beforeEach(() => {
      execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.email test@test.com", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "hello\n");
      execSync("git add committed.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "initial commit"', {
        cwd: tmpDir,
        stdio: "ignore",
      });
    });

    it("reports a clean repo with branch name and zero ahead/behind", async () => {
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.available).toBe(true);
      expect(data.branch).toBe("main");
      expect(data.ahead).toBe(0);
      expect(data.behind).toBe(0);
      expect(data.staged).toEqual([]);
      expect(data.unstaged).toEqual([]);
      expect(data.untracked).toEqual([]);
      expect(data.conflicts).toEqual([]);
    });

    it("detects a staged new file", async () => {
      fs.writeFileSync(path.join(tmpDir, "staged.txt"), "new\n");
      execSync("git add staged.txt", { cwd: tmpDir, stdio: "ignore" });
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.staged).toEqual(["staged.txt"]);
      expect(data.unstaged).toEqual([]);
    });

    it("detects an unstaged modification", async () => {
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "changed\n");
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.unstaged).toEqual(["committed.txt"]);
      expect(data.staged).toEqual([]);
    });

    it("detects a file that is both staged and further modified", async () => {
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "staged-change\n");
      execSync("git add committed.txt", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "then-more\n");
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.staged).toEqual(["committed.txt"]);
      expect(data.unstaged).toEqual(["committed.txt"]);
    });

    it("detects an untracked file", async () => {
      fs.writeFileSync(path.join(tmpDir, "untracked.txt"), "new\n");
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.untracked).toEqual(["untracked.txt"]);
    });

    it("detects a renamed file and reports the destination path", async () => {
      execSync("git mv committed.txt renamed.txt", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.staged).toEqual(["renamed.txt"]);
      expect(data.staged.some((f: string) => f.includes("->"))).toBe(false);
    });

    it("detects a merge conflict", async () => {
      execSync("git checkout -b feature", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "feature-side\n");
      execSync("git commit -am 'feature change'", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execSync("git checkout main", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "main-side\n");
      execSync("git commit -am 'main change'", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      try {
        execSync("git merge feature", { cwd: tmpDir, stdio: "ignore" });
      } catch {
        // expected — merge conflict leaves a non-zero exit code
      }
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.conflicts).toEqual(["committed.txt"]);
      expect(data.staged).toEqual([]);
      expect(data.unstaged).toEqual([]);
    });

    it("reports ahead/behind against an upstream", async () => {
      const remoteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "get-git-status-remote-"),
      );
      execSync("git init --bare -b main", {
        cwd: remoteDir,
        stdio: "ignore",
      });
      execSync(`git remote add origin ${remoteDir}`, {
        cwd: tmpDir,
        stdio: "ignore",
      });
      execSync("git push -u origin main", { cwd: tmpDir, stdio: "ignore" });
      fs.writeFileSync(path.join(tmpDir, "committed.txt"), "ahead\n");
      execSync("git commit -am 'ahead commit'", {
        cwd: tmpDir,
        stdio: "ignore",
      });
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.ahead).toBe(1);
      expect(data.behind).toBe(0);
      fs.rmSync(remoteDir, { recursive: true, force: true });
    });

    it("reports branch:'HEAD' for a detached HEAD", async () => {
      const hash = execSync("git rev-parse HEAD", { cwd: tmpDir })
        .toString()
        .trim();
      execSync(`git checkout ${hash}`, { cwd: tmpDir, stdio: "ignore" });
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(await tool.handler({}));
      expect(data.branch).toBe("HEAD");
    });

    it("filters status to a single file via filePath", async () => {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "b\n");
      const tool = createGetGitStatusTool(tmpDir);
      const data = parse(
        await tool.handler({ filePath: path.join(tmpDir, "a.txt") }),
      );
      expect(data.untracked).toEqual(["a.txt"]);
    });
  });
});
