/**
 * Linear tools — linear.list_issues
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// linear.list_issues
// ============================================================================

registerTool({
  id: "linear.list_issues",
  namespace: "linear",
  description:
    "List Linear issues assigned to the current user, optionally filtered by team and state.",
  paramsSchema: {
    type: "object",
    properties: {
      team: {
        type: "string",
        description: "Team key to filter by (e.g., 'ENG', 'PROD')",
      },
      assignee: {
        type: "string",
        description:
          "Use '@me' for current user (default), or omit for all assignees",
        default: "@me",
      },
      state: {
        type: "string",
        description: "Comma-separated state names (e.g., 'started,unstarted')",
        default: "started,unstarted",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      issues: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { loadTokens, listIssues: listLinearIssues } = await import(
      "../../connectors/linear.js"
    );

    if (!loadTokens()) {
      return JSON.stringify({
        count: 0,
        issues: [],
        error: "Linear not connected",
      });
    }

    const teamKey = params.team ? String(params.team) : undefined;
    const assigneeMe =
      params.assignee === "@me" || params.assignee === undefined;
    const stateFilter = params.state
      ? String(params.state)
      : "started,unstarted";
    const limit = typeof params.max === "number" ? params.max : 20;
    const states = stateFilter
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    try {
      const issues = await listLinearIssues({
        team: teamKey,
        assigneeMe,
        states,
        limit,
      });
      return JSON.stringify({ count: issues.length, issues });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
