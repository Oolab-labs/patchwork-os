import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { createGetPRTemplateTool } from "../getPRTemplate.js";
import { execSafe } from "../utils.js";

const mockExecSafe = vi.mocked(execSafe);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 10 };
}

function fail(stderr: string) {
  return { stdout: "", stderr, exitCode: 1, timedOut: false, durationMs: 10 };
}

const WORKSPACE = "/tmp/test-ws";

describe("getPRTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when not a git repo", async () => {
    mockExecSafe.mockResolvedValueOnce(fail("not a git repository"));

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = await tool.handler({});
    expect(result.content[0]?.text).toContain("Not a git repository");
  });

  it("generates bullet-style PR body", async () => {
    // base: "main" provided — no branch detection call
    mockExecSafe
      .mockResolvedValueOnce(ok(".git")) // rev-parse
      .mockResolvedValueOnce(
        ok(
          "abc123 feat: add getDependencyTree tool\ndef456 fix: handle timeout",
        ),
      ) // git log
      .mockResolvedValueOnce(
        ok("5 files changed, 312 insertions(+), 14 deletions(-)"),
      ); // git diff --stat

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = parse(await tool.handler({ base: "main" }));
    expect(result.body).toContain("## Changes");
    expect(result.body).toContain("feat: add getDependencyTree tool");
    expect(result.commits).toBe(2);
    expect(result.filesChanged).toBe(5);
  });

  it("extracts issue refs from commits", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(ok("abc123 fix: close #42 and also #99"))
      .mockResolvedValueOnce(ok("1 file changed, 5 insertions(+)"));

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = parse(await tool.handler({ base: "main" }));
    expect(result.issueRefs).toContain("#42");
    expect(result.issueRefs).toContain("#99");
    expect(result.body).toContain("Closes #42");
  });

  it("returns empty body when no commits", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(ok("")) // no commits
      .mockResolvedValueOnce(ok(""));

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = parse(await tool.handler({ base: "main" }));
    expect(result.commits).toBe(0);
    expect(result.body).toBe("");
    expect(result.note).toBeTruthy();
  });

  it("conventional style groups by type", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(ok("abc feat: add tool\ndef fix: handle error"))
      .mockResolvedValueOnce(ok("3 files changed, 50 insertions(+)"));

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = parse(
      await tool.handler({ base: "main", style: "conventional" }),
    );
    expect(result.body).toContain("### feat");
    expect(result.body).toContain("### fix");
    expect(result.style).toBe("conventional");
  });

  it("returns error when git log fails", async () => {
    mockExecSafe
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(fail("unknown revision 'nonexistent'"));

    const tool = createGetPRTemplateTool(WORKSPACE);
    const result = await tool.handler({ base: "nonexistent" });
    expect(result.content[0]?.text).toContain("Failed to get git history");
  });
});
