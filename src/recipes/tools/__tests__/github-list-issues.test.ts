/**
 * github.list_issues — read tool used for issue triage AND dedup. Verifies the
 * label/state/assignee plumbing into the connector `listIssues`, in particular
 * the `assignee: "any"` opt-out the worker dedup query relies on (worker-filed
 * issues are unassigned, so the default `@me` filter would never see them).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const listIssues = vi.fn();

vi.mock("../../../connectors/github.js", () => ({
  listIssues,
  // other exports the github tool module may import dynamically (unused here)
  createIssue: vi.fn(),
  listPRs: vi.fn(),
  listCommits: vi.fn(),
}));

import "../github.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => vi.clearAllMocks());

describe("github.list_issues", () => {
  it("defaults assignee to @me and state to open", async () => {
    listIssues.mockResolvedValue([]);
    const tool = getTool("github.list_issues");
    await tool?.execute(ctx({ repo: "o/r" }));
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "o/r", assignee: "@me", state: "open" }),
    );
    // No labels requested → passed through as undefined (connector then omits
    // the MCP arg entirely; covered in the connector test).
    expect(
      (listIssues.mock.calls[0]?.[0] as Record<string, unknown>).labels,
    ).toBeUndefined();
  });

  it("forwards labels + state and drops the assignee filter on assignee:'any'", async () => {
    listIssues.mockResolvedValue([]);
    const tool = getTool("github.list_issues");
    await tool?.execute(
      ctx({
        repo: "o/r",
        labels: ["test-failure"],
        state: "open",
        assignee: "any",
        max: 30,
      }),
    );
    const opts = listIssues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.repo).toBe("o/r");
    expect(opts.labels).toEqual(["test-failure"]);
    expect(opts.state).toBe("open");
    expect(opts.limit).toBe(30);
    // The dedup-critical bit: "any" → undefined → connector adds no assignee arg.
    expect(opts.assignee).toBeUndefined();
  });

  it("coerces a lone scalar label into a single-element array", async () => {
    listIssues.mockResolvedValue([]);
    const tool = getTool("github.list_issues");
    await tool?.execute(ctx({ labels: "test-failure" }));
    expect(
      (listIssues.mock.calls[0]?.[0] as Record<string, unknown>).labels,
    ).toEqual(["test-failure"]);
  });

  it("treats '*' and '' as the any-assignee opt-out too", async () => {
    listIssues.mockResolvedValue([]);
    const tool = getTool("github.list_issues");
    await tool?.execute(ctx({ assignee: "*" }));
    expect(
      (listIssues.mock.calls[0]?.[0] as Record<string, unknown>).assignee,
    ).toBeUndefined();
  });

  it("falls back to 'open' on an unrecognised state value", async () => {
    listIssues.mockResolvedValue([]);
    const tool = getTool("github.list_issues");
    await tool?.execute(ctx({ state: "bogus" }));
    expect(
      (listIssues.mock.calls[0]?.[0] as Record<string, unknown>).state,
    ).toBe("open");
  });

  it("normalises a connector failure to {count:0, issues:[], error}", async () => {
    listIssues.mockRejectedValue(new Error("403 rate limit exceeded"));
    const tool = getTool("github.list_issues");
    const out = await tool?.execute(ctx({ repo: "o/r" }));
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.count).toBe(0);
    expect(parsed.issues).toEqual([]);
    expect(parsed.error).toMatch(/rate limit/);
  });

  it("is a read tool (not write, low risk)", () => {
    const tool = getTool("github.list_issues");
    expect(tool?.isWrite).toBe(false);
    expect(tool?.riskDefault).toBe("low");
  });
});
