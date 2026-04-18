import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { createEnrichCommitTool } from "../enrichCommit.js";
import { classifyIssueLink, extractIssueRefs } from "../issueRefs.js";
import { execSafe } from "../utils.js";

const mockExec = vi.mocked(execSafe);

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}
function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
}
function fail(stderr: string, exitCode = 1) {
  return {
    stdout: "",
    stderr,
    exitCode,
    timedOut: false,
    durationMs: 1,
  };
}

const WS = "/tmp/ws";

describe("extractIssueRefs", () => {
  it("extracts #N and GH-N, dedupes, preserves order", () => {
    expect(extractIssueRefs("fix #12 and #34 then GH-34 refs #12")).toEqual([
      "#12",
      "#34",
    ]);
  });

  it("returns empty array when no refs", () => {
    expect(extractIssueRefs("just a message")).toEqual([]);
  });

  it("handles mixed case GH- prefix", () => {
    expect(extractIssueRefs("closes gh-7")).toEqual(["#7"]);
  });
});

describe("classifyIssueLink", () => {
  it("identifies closing verbs", () => {
    expect(classifyIssueLink("fixes #12", "#12")).toBe("closes");
    expect(classifyIssueLink("closes #12", "#12")).toBe("closes");
    expect(classifyIssueLink("resolves GH-12", "#12")).toBe("closes");
    expect(classifyIssueLink("closed #12 earlier", "#12")).toBe("closes");
  });

  it("treats bare refs as references", () => {
    expect(classifyIssueLink("see #12 for context", "#12")).toBe("references");
    expect(classifyIssueLink("#12", "#12")).toBe("references");
  });

  it("close verb only applies to the following ref", () => {
    expect(classifyIssueLink("fixes #1\nsee also #2", "#2")).toBe("references");
  });
});

describe("enrichCommit tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns error when not a git repo", async () => {
    mockExec.mockResolvedValueOnce(fail("not a git repo"));
    const tool = createEnrichCommitTool(WS);
    const res = await tool.handler({});
    expect(res.content[0]?.text).toContain("Not a git repository");
  });

  it("enriches commit with validated issue metadata", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git")) // rev-parse
      .mockResolvedValueOnce(
        ok(
          "abc123sha\nJane <j@x>\n2026-04-18T10:00:00Z\nfix: resolve bug\n---BODY---\nfix: resolve bug\n\nFixes #42 and references #99",
        ),
      ) // git show
      .mockResolvedValueOnce(ok("gh version 2.0")) // gh --version
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 42,
            title: "Bug",
            state: "OPEN",
            url: "https://x/42",
          }),
        ),
      ) // issue #42
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 99,
            title: "Other",
            state: "OPEN",
            url: "https://x/99",
          }),
        ),
      ); // issue #99

    const res = parse(await createEnrichCommitTool(WS).handler({}));
    expect(res.sha).toBe("abc123sha");
    expect(res.issueRefs).toEqual(["#42", "#99"]);
    expect(res.unresolved).toBe(0);
    expect(res.ghAvailable).toBe(true);
    expect(res.links).toHaveLength(2);
    expect(res.links[0]).toMatchObject({
      ref: "#42",
      linkType: "closes",
      resolved: true,
    });
    expect(res.links[1]).toMatchObject({
      ref: "#99",
      linkType: "references",
      resolved: true,
    });
  });

  it("flags missing issues as unresolved without failing", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok("sha\nA <a@x>\n2026-01-01\nref #404\n---BODY---\nref #404"),
      )
      .mockResolvedValueOnce(ok("gh v")) // gh available
      .mockResolvedValueOnce(fail("could not resolve to Issue")); // not found

    const res = parse(await createEnrichCommitTool(WS).handler({}));
    expect(res.issueRefs).toEqual(["#404"]);
    expect(res.unresolved).toBe(1);
    expect(res.links[0]).toMatchObject({
      resolved: false,
      reason: "not_found",
    });
  });

  it("flags all refs unresolved when gh CLI is unavailable", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok("sha\nA <a@x>\n2026-01-01\ncloses #1\n---BODY---\ncloses #1"),
      )
      .mockResolvedValueOnce(fail("gh: command not found", 127)); // gh probe fails

    const res = parse(await createEnrichCommitTool(WS).handler({}));
    expect(res.ghAvailable).toBe(false);
    expect(res.unresolved).toBe(1);
    expect(res.links[0]).toMatchObject({
      resolved: false,
      reason: "gh_unavailable",
    });
  });

  it("dedupes repeated references to same issue", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok(
          "sha\nA <a@x>\n2026-01-01\nsubject\n---BODY---\nfix #7\nalso #7 and GH-7",
        ),
      )
      .mockResolvedValueOnce(ok("gh v"))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 7,
            title: "T",
            state: "CLOSED",
            url: "https://x/7",
          }),
        ),
      );

    const res = parse(await createEnrichCommitTool(WS).handler({}));
    expect(res.issueRefs).toEqual(["#7"]);
    expect(res.links).toHaveLength(1);
  });

  it("returns empty links when no refs in message", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok("sha\nA <a@x>\n2026-01-01\nno refs here\n---BODY---\nno refs here"),
      )
      .mockResolvedValueOnce(ok("gh v"));

    const res = parse(await createEnrichCommitTool(WS).handler({}));
    expect(res.issueRefs).toEqual([]);
    expect(res.links).toEqual([]);
    expect(res.unresolved).toBe(0);
  });

  it("surfaces git-show failure with the supplied ref", async () => {
    mockExec
      .mockResolvedValueOnce(ok(".git"))
      .mockRejectedValueOnce(new Error("bad revision 'nope'"));

    const res = await createEnrichCommitTool(WS).handler({ ref: "nope" });
    expect(res.content[0]?.text).toContain("Failed to read commit 'nope'");
  });
});
