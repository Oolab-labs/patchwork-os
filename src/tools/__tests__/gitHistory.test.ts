import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGetCommitDetailsTool,
  createGetDiffBetweenRefsTool,
} from "../gitHistory.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("gitHistory tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-history-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello\n");
    execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', {
      cwd: tmpDir,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getCommitDetails", () => {
    it("returns commit info for a known commit hash", async () => {
      const hash = execSync("git rev-parse HEAD", { cwd: tmpDir })
        .toString()
        .trim();
      const tool = createGetCommitDetailsTool(tmpDir);
      const result = await tool.handler({ commitHash: hash });
      const data = parse(result);

      expect(data.output).toBeDefined();
      expect(data.output).toContain("initial commit");
      expect(data.output).toContain("Test");
    });

    it("returns an error for an invalid commit hash", async () => {
      const tool = createGetCommitDetailsTool(tmpDir);
      const result = await tool.handler({ commitHash: "deadbeef1234" });
      const data = parse(result);

      expect(data.error).toBeDefined();
      expect(typeof data.error).toBe("string");
    });
  });

  describe("getDiffBetweenRefs", () => {
    it("returns a diff between two commits", async () => {
      const firstHash = execSync("git rev-parse HEAD", { cwd: tmpDir })
        .toString()
        .trim();

      fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello\nworld\n");
      execSync("git add file.txt", { cwd: tmpDir, stdio: "ignore" });
      execSync('git commit -m "second commit"', {
        cwd: tmpDir,
        stdio: "ignore",
      });
      const secondHash = execSync("git rev-parse HEAD", { cwd: tmpDir })
        .toString()
        .trim();

      const tool = createGetDiffBetweenRefsTool(tmpDir);
      const result = await tool.handler({ ref1: firstHash, ref2: secondHash });
      const data = parse(result);

      expect(data.diff).toBeDefined();
      expect(data.diff).toContain("world");
    });

    it("returns an error object for invalid refs", async () => {
      const tool = createGetDiffBetweenRefsTool(tmpDir);
      const result = await tool.handler({
        ref1: "nonexistentref",
        ref2: "alsobad",
      });
      const data = parse(result);

      expect(data.error).toBeDefined();
    });
  });
});
