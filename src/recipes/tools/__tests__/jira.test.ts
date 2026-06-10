/**
 * jira.list_issues JQL-injection regression (audit-1).
 *
 * The `project` shortcut is interpolated into the JQL string when no explicit
 * `jql` is supplied. Before the fix, `project = ${projectInput} ORDER BY ...`
 * accepted an arbitrary value, so `project: "PROJ OR issue in allIssues()"`
 * widened the query to every visible issue. The fix validates the project key
 * against a strict key pattern and rejects anything else with a structured
 * error before searchIssues() is ever called with attacker-controlled JQL.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const searchIssues = vi.fn();
const authenticate = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../connectors/jira.js", () => ({
  getJiraConnector: () => ({ authenticate, searchIssues }),
}));

import "../jira.js";
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("jira.list_issues — JQL injection guard (audit-1)", () => {
  it("rejects an injection payload in `project` without calling searchIssues", async () => {
    const tool = getTool("jira.list_issues");
    const out = await tool?.execute(
      ctx({ project: "PROJ OR issue in allIssues()" }),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.error).toMatch(/Invalid Jira project key/);
    expect(parsed.count).toBe(0);
    expect(parsed.items).toEqual([]);
    // The malicious value must never reach the connector.
    expect(searchIssues).not.toHaveBeenCalled();
  });

  it("builds the scoped JQL for a valid project key", async () => {
    searchIssues.mockResolvedValue({ issues: [{ key: "ENG-1" }] });
    const tool = getTool("jira.list_issues");
    const out = await tool?.execute(ctx({ project: "ENG" }));
    expect(searchIssues).toHaveBeenCalledTimes(1);
    expect(searchIssues).toHaveBeenCalledWith(
      "project = ENG ORDER BY created DESC",
      50,
    );
    expect(JSON.parse(out ?? "{}").items).toEqual([{ key: "ENG-1" }]);
  });

  it("passes an explicit jql through unchanged (project guard does not apply)", async () => {
    searchIssues.mockResolvedValue({ issues: [] });
    const tool = getTool("jira.list_issues");
    await tool?.execute(
      ctx({ jql: 'status = "In Progress"', project: "ignored value" }),
    );
    expect(searchIssues).toHaveBeenCalledWith('status = "In Progress"', 50);
  });
});
