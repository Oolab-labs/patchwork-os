/**
 * Sentry tools — read wrapper for the Sentry MCP-backed connector.
 *
 * Self-registering tool module for the recipe tool registry. The Sentry
 * connector currently exposes one capability (`fetchIssueStackTrace`) routed
 * through Sentry's official MCP server. This module wraps it so recipes can
 * pull a stack trace by issue ID or URL and pipe it into downstream steps
 * (e.g., enrichStackTrace, runClaudeTask).
 *
 * Read-only: Sentry connector is read-only per the connector inventory.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// sentry.get_issue
// ============================================================================

registerTool({
  id: "sentry.get_issue",
  namespace: "sentry",
  description:
    "Fetch a Sentry issue by ID or full sentry.io URL. Returns the stack trace string, issue title, and resolved issue ID — ready to pipe into enrichStackTrace.",
  paramsSchema: {
    type: "object",
    properties: {
      issue: {
        type: "string",
        description:
          "Sentry issue ID (e.g., '4567890123') or full URL (e.g., 'https://my-org.sentry.io/issues/4567890123/'). Org slug is inferred from the URL when present.",
      },
      into: CommonSchemas.into,
    },
    required: ["issue"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      issueId: { type: "string" },
      title: { type: "string" },
      stackTrace: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { fetchIssueStackTrace, loadTokens } = await import(
      "../../connectors/sentry.js"
    );
    if (!loadTokens()) {
      return JSON.stringify({ ok: false, error: "Sentry not connected" });
    }
    const issue = typeof params.issue === "string" ? params.issue : "";
    if (!issue) {
      return JSON.stringify({
        ok: false,
        error: "get_issue requires `issue` (ID or URL)",
      });
    }
    try {
      const result = await fetchIssueStackTrace(issue);
      return JSON.stringify({
        ok: true,
        issueId: result.issueId,
        title: result.title,
        stackTrace: result.stackTrace,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
