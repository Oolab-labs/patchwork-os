/**
 * Git tools — git.log_since, git.stale_branches
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// git.log_since
// ============================================================================

registerTool({
  id: "git.log_since",
  namespace: "git",
  description:
    "Get git log since a time expression (e.g., '24h', '7d', '2026-01-01').",
  paramsSchema: {
    type: "object",
    properties: {
      since: CommonSchemas.since,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "string",
    description: "Git log output as newline-separated commits",
  },
  riskDefault: "low",
  isWrite: false,
  execute: async ({ params, deps }) => {
    const since = (params.since as string) ?? "24h";
    // Use injected gitLogSince for testability
    return deps.gitLogSince(since, deps.workdir);
  },
});

// ============================================================================
// git.stale_branches
// ============================================================================

registerTool({
  id: "git.stale_branches",
  namespace: "git",
  description: "List branches with no activity in N days.",
  paramsSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Number of days of inactivity to consider stale",
        default: 30,
      },
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "string",
    description: "List of stale branches with last commit dates",
  },
  riskDefault: "low",
  isWrite: false,
  execute: async ({ params, deps }) => {
    const days = typeof params.days === "number" ? params.days : 30;
    // Use injected gitStaleBranches for testability
    return deps.gitStaleBranches(days, deps.workdir);
  },
});
