import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, execSafe: vi.fn() };
});

import { CommitIssueLinkLog } from "../../commitIssueLinkLog.js";
import { createCtxGetTaskContextTool } from "../ctxGetTaskContext.js";
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

let linkDir: string;
let linkLog: CommitIssueLinkLog;

beforeEach(() => {
  vi.clearAllMocks();
  linkDir = mkdtempSync(path.join(os.tmpdir(), "ctx-task-ctx-"));
  linkLog = new CommitIssueLinkLog({ dir: linkDir });
});
afterEach(() => rmSync(linkDir, { recursive: true, force: true }));

describe("ctxGetTaskContext — ref detection", () => {
  it("detects issue refs: #42, GH-42, bare 42", async () => {
    // 3 invocations, each short-circuits at gh/git probe → both fail → unknown-path skipped
    for (const ref of ["#42", "GH-42", "42"]) {
      mockExec
        .mockResolvedValueOnce(fail("no gh")) // gh --version
        .mockResolvedValueOnce(fail("no git")); // git rev-parse
      const res = parse(
        await createCtxGetTaskContextTool({ workspace: WS }).handler({ ref }),
      );
      expect(res.refType).toBe("issue");
      expect(res.ref).toBe(ref);
    }
  });

  it("detects PR refs: PR-42, pull/42, pr/42, #PR42", async () => {
    for (const ref of ["PR-42", "pull/42", "pr/42", "#PR42"]) {
      mockExec
        .mockResolvedValueOnce(fail("no gh"))
        .mockResolvedValueOnce(fail("no git"));
      const res = parse(
        await createCtxGetTaskContextTool({ workspace: WS }).handler({ ref }),
      );
      expect(res.refType).toBe("pull_request");
    }
  });

  it("detects commit SHAs: 7-40 hex", async () => {
    for (const ref of ["abc1234", "0123456789abcdef0123456789abcdef01234567"]) {
      mockExec
        .mockResolvedValueOnce(fail("no gh"))
        .mockResolvedValueOnce(fail("no git"));
      const res = parse(
        await createCtxGetTaskContextTool({ workspace: WS }).handler({ ref }),
      );
      expect(res.refType).toBe("commit");
    }
  });

  it("flags unknown refs in warnings", async () => {
    mockExec
      .mockResolvedValueOnce(fail("no gh"))
      .mockResolvedValueOnce(fail("no git"));
    const res = parse(
      await createCtxGetTaskContextTool({ workspace: WS }).handler({
        ref: "not-a-ref-at-all",
      }),
    );
    expect(res.refType).toBe("unknown");
    expect(res.warnings[0]).toMatch(/could not detect ref type/);
  });
});

describe("ctxGetTaskContext — issue flow", () => {
  it("fetches issue via gh and attaches linked commits from log", async () => {
    linkLog.record({
      sha: "aaa111",
      ref: "#42",
      linkType: "closes",
      resolved: true,
      workspace: WS,
      subject: "fix the bug",
      issueState: "OPEN",
    });

    mockExec
      .mockResolvedValueOnce(ok("gh version 2")) // gh --version
      .mockResolvedValueOnce(ok(".git")) // git rev-parse
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 42,
            title: "Auth timeout",
            state: "OPEN",
            url: "https://gh/issues/42",
            labels: [{ name: "bug" }],
          }),
        ),
      ); // gh issue view

    const res = parse(
      await createCtxGetTaskContextTool({
        workspace: WS,
        commitIssueLinkLog: linkLog,
      }).handler({ ref: "#42" }),
    );
    expect(res.issue.number).toBe(42);
    expect(res.issue.title).toBe("Auth timeout");
    expect(res.linkedCommits).toHaveLength(1);
    expect(res.linkedCommits[0].sha).toBe("aaa111");
    expect(res.linkedCommits[0].linkType).toBe("closes");
    expect(res.warnings).toEqual([]);
  });

  it("degrades gracefully when gh is unavailable", async () => {
    mockExec
      .mockResolvedValueOnce(fail("gh: command not found", 127))
      .mockResolvedValueOnce(ok(".git"));

    const res = parse(
      await createCtxGetTaskContextTool({ workspace: WS }).handler({
        ref: "#42",
      }),
    );
    expect(res.refType).toBe("issue");
    expect(res.issue).toBeNull();
    expect(res.sources.gh).toBe(false);
    expect(res.warnings).toContain(
      "gh CLI unavailable — issue details skipped",
    );
  });

  it("records not_found warning when gh reports missing issue", async () => {
    mockExec
      .mockResolvedValueOnce(ok("gh v"))
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(fail("could not resolve to Issue"));

    const res = parse(
      await createCtxGetTaskContextTool({ workspace: WS }).handler({
        ref: "#999",
      }),
    );
    expect(res.issue).toBeNull();
    expect(res.warnings[0]).toMatch(/999/);
  });
});

describe("ctxGetTaskContext — PR flow", () => {
  it("fetches PR and extracts linkedIssueRefs from body", async () => {
    mockExec
      .mockResolvedValueOnce(ok("gh v"))
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            number: 7,
            title: "Fix auth",
            state: "OPEN",
            url: "https://gh/pr/7",
            body: "Closes #42 and references GH-99",
          }),
        ),
      );

    const res = parse(
      await createCtxGetTaskContextTool({ workspace: WS }).handler({
        ref: "PR-7",
      }),
    );
    expect(res.pullRequest.number).toBe(7);
    expect(res.pullRequest.linkedIssueRefs).toEqual(["#42", "#99"]);
  });
});

describe("ctxGetTaskContext — commit flow", () => {
  it("fetches commit via git show and attaches linked issues", async () => {
    linkLog.record({
      sha: "abc1234def5678",
      ref: "#7",
      linkType: "closes",
      resolved: true,
      workspace: WS,
      issueState: "CLOSED",
    });

    mockExec
      .mockResolvedValueOnce(fail("no gh")) // gh --version
      .mockResolvedValueOnce(ok(".git")) // git rev-parse
      .mockResolvedValueOnce(
        // git show — format: meta\n---BODY---\nbody\n---END---\nstat
        ok(
          "abc1234def5678\nJane <j@x>\n2026-04-18T00:00:00Z\nfix: bug\n---BODY---\nfix: bug\n\nCloses #7\n---END---\n a.ts | 2 +-",
        ),
      );

    const res = parse(
      await createCtxGetTaskContextTool({
        workspace: WS,
        commitIssueLinkLog: linkLog,
      }).handler({ ref: "abc1234def5678" }),
    );
    expect(res.refType).toBe("commit");
    expect(res.commit.sha).toBe("abc1234def5678");
    expect(res.commit.subject).toBe("fix: bug");
    expect(res.commit.linkedIssues).toHaveLength(1);
    expect(res.commit.linkedIssues[0].ref).toBe("#7");
  });

  it("warns when commit is not found", async () => {
    mockExec
      .mockResolvedValueOnce(fail("no gh"))
      .mockResolvedValueOnce(ok(".git"))
      .mockRejectedValueOnce(new Error("bad revision"));

    const res = parse(
      await createCtxGetTaskContextTool({ workspace: WS }).handler({
        ref: "deadbeef",
      }),
    );
    expect(res.commit).toBeNull();
    expect(res.warnings.join(" ")).toMatch(/not found/);
  });
});

describe("ctxGetTaskContext — sources map", () => {
  it("reports gh/git/linkLog availability", async () => {
    mockExec
      .mockResolvedValueOnce(ok("gh v"))
      .mockResolvedValueOnce(ok(".git"))
      .mockResolvedValueOnce(
        ok(JSON.stringify({ number: 1, title: "x", state: "OPEN", url: "u" })),
      );

    const res = parse(
      await createCtxGetTaskContextTool({
        workspace: WS,
        commitIssueLinkLog: linkLog,
      }).handler({ ref: "#1" }),
    );
    expect(res.sources).toEqual({ gh: true, git: true, linkLog: true });
  });
});
