/**
 * Resend tools — transactional email send + read access to sent emails.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the Resend
 * connector (src/connectors/resend.ts). `send_email` is write-gated; the two
 * read tools surface a single email / a list of emails.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// resend.send_email  (write-gated)
// ============================================================================

registerTool({
  id: "resend.send_email",
  namespace: "resend",
  description:
    "Send a transactional email via Resend. Requires from, to, subject, and one of html/text.",
  paramsSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Sender address (must be a verified Resend domain)",
      },
      to: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Recipient address or array of addresses",
      },
      subject: { type: "string", description: "Email subject line" },
      html: {
        type: "string",
        description: "HTML body (either html or text is required)",
      },
      text: {
        type: "string",
        description: "Plain-text body (either html or text is required)",
      },
      reply_to: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Optional reply-to address or array of addresses",
      },
      into: CommonSchemas.into,
    },
    required: ["from", "to", "subject"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getResendConnector } = await import("../../connectors/resend.js");
    const connector = getResendConnector();
    const result = await connector.sendEmail({
      from: params.from as string,
      to: params.to as string | string[],
      subject: params.subject as string,
      html: typeof params.html === "string" ? params.html : undefined,
      text: typeof params.text === "string" ? params.text : undefined,
      replyTo:
        typeof params.reply_to === "string" || Array.isArray(params.reply_to)
          ? (params.reply_to as string | string[])
          : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// resend.list_emails
// ============================================================================

registerTool({
  id: "resend.list_emails",
  namespace: "resend",
  description: "List emails sent via Resend, with optional limit/page paging.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of emails to return",
      },
      page: {
        type: "number",
        description: "Page number for pagination",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      object: { type: "string" },
      data: { type: "array", items: { type: "object" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getResendConnector } = await import("../../connectors/resend.js");
    const connector = getResendConnector();
    const result = await connector.listEmails({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// resend.get_email
// ============================================================================

registerTool({
  id: "resend.get_email",
  namespace: "resend",
  description: "Fetch a single email sent via Resend by its ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Resend email ID" },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      object: { type: "string" },
      id: { type: "string" },
      to: { type: ["string", "array"], items: { type: "string" } },
      from: { type: "string" },
      subject: { type: "string" },
      html: { type: ["string", "null"] },
      text: { type: ["string", "null"] },
      created_at: { type: "string" },
      last_event: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getResendConnector } = await import("../../connectors/resend.js");
    const connector = getResendConnector();
    const result = await connector.getEmail(params.id as string);
    return JSON.stringify(result);
  }),
});
