import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommitIssueLinkLog } from "../../commitIssueLinkLog.js";
import { createGetCommitsForIssueTool } from "../getCommitsForIssue.js";

let dir: string;
let log: CommitIssueLinkLog;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "get-commits-for-issue-"));
  log = new CommitIssueLinkLog({ dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WS = "/ws/a";

describe("getCommitsForIssue", () => {
  it("returns commits that reference the issue (newest first)", async () => {
    log.record({
      sha: "aaa",
      ref: "#42",
      linkType: "closes",
      resolved: true,
      workspace: WS,
      subject: "fix: a",
      issueState: "OPEN",
    });
    log.record({
      sha: "bbb",
      ref: "#42",
      linkType: "references",
      resolved: true,
      workspace: WS,
      subject: "note: b",
    });

    const tool = createGetCommitsForIssueTool(WS, log);
    const res = parse(await tool.handler({ issue: "#42" }));
    expect(res.ref).toBe("#42");
    expect(res.count).toBe(2);
    expect(res.commits.map((c: { sha: string }) => c.sha)).toEqual([
      "bbb",
      "aaa",
    ]);
  });

  it("normalizes bare number and GH- prefix to #N", async () => {
    log.record({
      sha: "aaa",
      ref: "#7",
      linkType: "closes",
      resolved: true,
      workspace: WS,
    });
    const tool = createGetCommitsForIssueTool(WS, log);
    expect(parse(await tool.handler({ issue: "7" })).ref).toBe("#7");
    expect(parse(await tool.handler({ issue: "GH-7" })).ref).toBe("#7");
    expect(parse(await tool.handler({ issue: "#7" })).count).toBe(1);
  });

  it("filters by linkType when requested", async () => {
    log.record({
      sha: "aaa",
      ref: "#9",
      linkType: "closes",
      resolved: true,
      workspace: WS,
    });
    log.record({
      sha: "bbb",
      ref: "#9",
      linkType: "references",
      resolved: true,
      workspace: WS,
    });
    const tool = createGetCommitsForIssueTool(WS, log);
    const res = parse(await tool.handler({ issue: "#9", linkType: "closes" }));
    expect(res.count).toBe(1);
    expect(res.commits[0].sha).toBe("aaa");
  });

  it("defaults to current workspace; workspaceScope:any returns all", async () => {
    log.record({
      sha: "x",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws/a",
    });
    log.record({
      sha: "y",
      ref: "#1",
      linkType: "closes",
      resolved: true,
      workspace: "/ws/other",
    });
    const tool = createGetCommitsForIssueTool("/ws/a", log);
    expect(parse(await tool.handler({ issue: "#1" })).count).toBe(1);
    expect(
      parse(await tool.handler({ issue: "#1", workspaceScope: "any" })).count,
    ).toBe(2);
  });

  it("errors on missing or malformed issue", async () => {
    const tool = createGetCommitsForIssueTool(WS, log);
    expect((await tool.handler({})).content[0]?.text).toContain(
      "issue is required",
    );
    expect(
      (await tool.handler({ issue: "not-a-ref" })).content[0]?.text,
    ).toContain("invalid issue ref");
  });

  it("returns empty result when issue has no links", async () => {
    const tool = createGetCommitsForIssueTool(WS, log);
    const res = parse(await tool.handler({ issue: "#999" }));
    expect(res.count).toBe(0);
    expect(res.commits).toEqual([]);
  });
});
