/**
 * github.create_issue — the first GitHub-write recipe tool. Wraps the connector
 * createIssue and normalises success/failure into the recipe-tool JSON shape.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const createIssue = vi.fn();

vi.mock("../../../connectors/github.js", () => ({
  createIssue,
  // other exports the github tool module may import dynamically (unused here)
  listIssues: vi.fn(),
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

describe("github.create_issue", () => {
  it("creates an issue and returns number/url/title", async () => {
    createIssue.mockResolvedValue({
      number: 42,
      url: "https://github.com/o/r/issues/42",
      title: "Flaky test in auth",
    });
    const tool = getTool("github.create_issue");
    const out = await tool?.execute(
      ctx({ repo: "o/r", title: "Flaky test in auth", body: "details" }),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed).toEqual({
      ok: true,
      number: 42,
      url: "https://github.com/o/r/issues/42",
      title: "Flaky test in auth",
    });
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "o/r",
        title: "Flaky test in auth",
        body: "details",
      }),
    );
  });

  it("forwards labels and assignees arrays", async () => {
    createIssue.mockResolvedValue({ number: 1, url: "u", title: "t" });
    const tool = getTool("github.create_issue");
    await tool?.execute(
      ctx({
        repo: "o/r",
        title: "t",
        labels: ["bug", "ci"],
        assignees: ["alice"],
      }),
    );
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ["bug", "ci"],
        assignees: ["alice"],
      }),
    );
  });

  it("reports a connector failure as {ok:false, error} so the runner halts (no throw, not silent success)", async () => {
    createIssue.mockRejectedValue(new Error("github connector not connected"));
    const tool = getTool("github.create_issue");
    const out = await tool?.execute(ctx({ repo: "o/r", title: "t" }));
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.ok).toBe(false); // hard ok:false → runner flags a step error
    expect(parsed.error).toMatch(/not connected/);
    expect(parsed.number).toBeUndefined();
  });

  it("is registered as a write tool (kill-switch / approval gated)", () => {
    const tool = getTool("github.create_issue");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("high");
  });
});
