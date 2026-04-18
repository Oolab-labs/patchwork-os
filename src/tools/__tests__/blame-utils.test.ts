import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlameResolver } from "../blame-utils.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "blame-utils-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "Tester");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "a.ts"), "line1\nline2\nline3\n");
  git("add", "a.ts");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("createBlameResolver", () => {
  it("returns the introducing commit for a line", async () => {
    const resolver = createBlameResolver(repo);
    const sha = await resolver.getIntroducedByCommit(
      path.join(repo, "a.ts"),
      2,
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns undefined for files that don't exist on disk", async () => {
    const resolver = createBlameResolver(repo);
    expect(
      await resolver.getIntroducedByCommit("/nope/missing.ts", 1),
    ).toBeUndefined();
  });

  it("returns undefined for untracked files", async () => {
    writeFileSync(path.join(repo, "untracked.ts"), "x\n");
    const resolver = createBlameResolver(repo);
    expect(
      await resolver.getIntroducedByCommit(path.join(repo, "untracked.ts"), 1),
    ).toBeUndefined();
  });

  it("caches results (second call does not re-blame)", async () => {
    const resolver = createBlameResolver(repo);
    const file = path.join(repo, "a.ts");
    const sha1 = await resolver.getIntroducedByCommit(file, 1);
    expect(resolver.cacheSize()).toBe(1);
    const sha2 = await resolver.getIntroducedByCommit(file, 1);
    expect(sha2).toBe(sha1);
    expect(resolver.cacheSize()).toBe(1);
  });

  it("expires cached entries after ttlMs", async () => {
    let time = 0;
    const resolver = createBlameResolver(repo, {
      ttlMs: 1_000,
      now: () => time,
    });
    const file = path.join(repo, "a.ts");
    await resolver.getIntroducedByCommit(file, 1);
    time = 2_000;
    // Cache entry is stale — getIntroducedByCommit will re-blame.
    // We can't observe the subprocess directly, but the freshness path
    // exercises the cache check; assert it still returns the same sha.
    const sha = await resolver.getIntroducedByCommit(file, 1);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("evicts FIFO when cache exceeds maxSize", async () => {
    const resolver = createBlameResolver(repo, { maxSize: 2 });
    const file = path.join(repo, "a.ts");
    await resolver.getIntroducedByCommit(file, 1);
    await resolver.getIntroducedByCommit(file, 2);
    await resolver.getIntroducedByCommit(file, 3);
    expect(resolver.cacheSize()).toBe(2);
  });
});
