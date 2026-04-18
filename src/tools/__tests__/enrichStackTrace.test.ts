import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnrichStackTraceTool } from "../enrichStackTrace.js";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "enrich-stacktrace-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "Tester");
  git("config", "commit.gpgsign", "false");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

async function commit(
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  writeFileSync(path.join(repo, file), contents);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
}

describe("enrichStackTrace tool", () => {
  it("maps a Node stack frame to the introducing commit", async () => {
    const sha = await commit(
      "a.ts",
      "export function doThing() {\n  throw new Error('bang');\n}\n",
      "feat: add doThing",
    );
    const trace = `Error: bang
    at doThing (${path.join(repo, "a.ts")}:2:9)`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({ stackTrace: trace }),
    );
    expect(res.gitAvailable).toBe(true);
    expect(res.framesParsed).toBe(1);
    expect(res.framesBlamed).toBe(1);
    expect(res.frames[0].inWorkspace).toBe(true);
    expect(res.frames[0].commit.sha).toBe(sha);
    expect(res.frames[0].commit.subject).toBe("feat: add doThing");
    expect(res.topSuspect.sha).toBe(sha);
  });

  it("confidence=high when multiple frames agree on the same commit", async () => {
    const sha = await commit("a.ts", "line1\nline2\nline3\nline4\n", "init a");
    const trace = `Error
    at t (${path.join(repo, "a.ts")}:2:1)
    at t (${path.join(repo, "a.ts")}:3:1)`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({ stackTrace: trace }),
    );
    expect(res.confidence).toBe("high");
    expect(res.topSuspect.sha).toBe(sha);
    expect(res.topSuspect.frameCount).toBe(2);
  });

  it("confidence=medium when top frame blamed but other frames disagree", async () => {
    const shaA = await commit("a.ts", "a content\n", "init a");
    const shaB = await commit("b.ts", "b content\n", "init b");
    const trace = `Error
    at t (${path.join(repo, "a.ts")}:1:1)
    at t (${path.join(repo, "b.ts")}:1:1)`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({ stackTrace: trace }),
    );
    expect(res.confidence).toBe("medium");
    expect(res.topSuspect.sha).toBe(shaA);
    expect(shaB).not.toBe(shaA);
  });

  it("confidence=low when top frame is outside the workspace", async () => {
    await commit("a.ts", "a\n", "init");
    const trace = `Error
    at node:internal/modules/cjs/loader (node:internal/cjs/loader:123:9)
    at fn (/tmp/not-in-repo/x.ts:1:1)`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({ stackTrace: trace }),
    );
    expect(res.confidence).toBe("low");
    expect(res.topSuspect).toBeNull();
  });

  it("flags frames outside the workspace as inWorkspace:false", async () => {
    await commit("a.ts", "a\n", "init");
    const trace = `Error
    at fn (${path.join(repo, "a.ts")}:1:1)
    at ext (/usr/lib/foo/bar.ts:1:1)`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({ stackTrace: trace }),
    );
    expect(res.frames[0].inWorkspace).toBe(true);
    expect(res.frames[1].inWorkspace).toBe(false);
    expect(res.frames[1].commit).toBeNull();
  });

  it("respects maxFrames cap", async () => {
    await commit("a.ts", "l1\nl2\nl3\nl4\nl5\n", "init");
    const f = (n: number) => `    at x (${path.join(repo, "a.ts")}:${n}:1)`;
    const trace = `Error\n${[1, 2, 3, 4, 5].map(f).join("\n")}`;
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({
        stackTrace: trace,
        maxFrames: 2,
      }),
    );
    expect(res.framesParsed).toBe(5);
    expect(res.frames).toHaveLength(2);
  });

  it("returns empty frames on unparseable input", async () => {
    const res = parse(
      await createEnrichStackTraceTool(repo).handler({
        stackTrace: "no frames here, just prose",
      }),
    );
    expect(res.framesParsed).toBe(0);
    expect(res.frames).toHaveLength(0);
    expect(res.confidence).toBe("low");
  });

  it("reports gitAvailable=false when workspace is not a git repo", async () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const res = parse(
        await createEnrichStackTraceTool(nonRepo).handler({
          stackTrace: `at fn (${path.join(nonRepo, "x.ts")}:1:1)`,
        }),
      );
      expect(res.gitAvailable).toBe(false);
      expect(res.framesBlamed).toBe(0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
