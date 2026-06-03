/**
 * SendGrid tools — transactional email send (write) plus read wrappers for
 * dynamic/legacy templates and email stats.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the
 * SendGridConnector (src/connectors/sendgrid.ts) methods `send`,
 * `listTemplates`, and `getStats`.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// sendgrid.send_email  (write-gated)
// ============================================================================

registerTool({
  id: "sendgrid.send_email",
  namespace: "sendgrid",
  description:
    "Send a transactional email via SendGrid. Requires `to`, `subject`, and at " +
    "least one of `text`/`html`. `from` defaults to the connected verified sender.",
  paramsSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address (required)",
      },
      subject: {
        type: "string",
        description: "Email subject line (required, non-empty)",
      },
      text: {
        type: "string",
        description: "Plain-text body (one of text/html is required)",
      },
      html: {
        type: "string",
        description: "HTML body (one of text/html is required)",
      },
      from: {
        type: "string",
        description:
          "Sender email address. Defaults to the connected verified sender (fromEmail).",
      },
      into: CommonSchemas.into,
    },
    required: ["to", "subject"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      messageId: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getSendGridConnector } = await import(
      "../../connectors/sendgrid.js"
    );
    try {
      const connector = getSendGridConnector();
      const result = await connector.send({
        to: params.to as string,
        subject: params.subject as string,
        text: typeof params.text === "string" ? params.text : undefined,
        html: typeof params.html === "string" ? params.html : undefined,
        from: typeof params.from === "string" ? params.from : undefined,
      });
      return JSON.stringify({ ok: true, messageId: result.messageId });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// sendgrid.list_templates
// ============================================================================

registerTool({
  id: "sendgrid.list_templates",
  namespace: "sendgrid",
  description:
    "List SendGrid email templates, optionally filtered by generation " +
    "(legacy or dynamic).",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of templates to return (page_size)",
      },
      generations: {
        type: "string",
        enum: ["legacy", "dynamic"],
        description: "Filter by template generation",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      result: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getSendGridConnector } = await import(
      "../../connectors/sendgrid.js"
    );
    const connector = getSendGridConnector();
    const result = await connector.listTemplates({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      generations:
        params.generations === "legacy" || params.generations === "dynamic"
          ? params.generations
          : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// sendgrid.get_stats
// ============================================================================

registerTool({
  id: "sendgrid.get_stats",
  namespace: "sendgrid",
  description:
    "Fetch SendGrid email statistics for a date range, optionally aggregated " +
    "by day/week/month.",
  paramsSchema: {
    type: "object",
    properties: {
      startDate: {
        type: "string",
        description: "Start date YYYY-MM-DD (required)",
      },
      endDate: {
        type: "string",
        description: "End date YYYY-MM-DD (optional, defaults to today)",
      },
      aggregatedBy: {
        type: "string",
        enum: ["day", "week", "month"],
        description: "Aggregation bucket size",
      },
      into: CommonSchemas.into,
    },
    required: ["startDate"],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getSendGridConnector } = await import(
      "../../connectors/sendgrid.js"
    );
    const connector = getSendGridConnector();
    const data = await connector.getStats({
      startDate: params.startDate as string,
      endDate: typeof params.endDate === "string" ? params.endDate : undefined,
      aggregatedBy:
        params.aggregatedBy === "day" ||
        params.aggregatedBy === "week" ||
        params.aggregatedBy === "month"
          ? params.aggregatedBy
          : undefined,
    });
    return JSON.stringify({ data });
  },
});
