/**
 * GitHub tools — github.list_issues, github.list_prs
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// github.list_issues
// ============================================================================

registerTool({
  id: "github.list_issues",
  namespace: "github",
  description: "List GitHub issues assigned to a user or matching filters.",
  paramsSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "Repository in 'owner/repo' format (omit for all accessible repos)",
      },
      assignee: {
        type: "string",
        description: "User to filter by (use '@me' for current user)",
        default: "@me",
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
    const { listIssues } = await import("../../connectors/github.js");
    const repo = params.repo ? String(params.repo) : undefined;
    const assignee = params.assignee ? String(params.assignee) : "@me";
    const limit = typeof params.max === "number" ? params.max : 20;
    try {
      const issues = await listIssues({ repo, assignee, limit });
      return JSON.stringify({ count: issues.length, issues });
    } catch (err) {
      // Translate connector throw into the {count:0, items:[], error}
      // shape that the runner's silent-fail detector (PR #72) catches
      // as a step error. Pre-fix this just propagated as a thrown
      // error which the runner caught fine — but the connector
      // itself used to silently `[]`-swallow all failures.
      return JSON.stringify({
        count: 0,
        issues: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// github.list_prs
// ============================================================================

registerTool({
  id: "github.list_prs",
  namespace: "github",
  description: "List GitHub pull requests authored by or involving a user.",
  paramsSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description:
          "Repository in 'owner/repo' format (omit for all accessible repos)",
      },
      author: {
        type: "string",
        description: "Author to filter by (use '@me' for current user)",
        default: "@me",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      prs: { type: "array" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { listPRs } = await import("../../connectors/github.js");
    const repo = params.repo ? String(params.repo) : undefined;
    const author = params.author ? String(params.author) : "@me";
    const limit = typeof params.max === "number" ? params.max : 20;
    try {
      const prs = await listPRs({ repo, author, limit });
      return JSON.stringify({ count: prs.length, prs });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        prs: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
