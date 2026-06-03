/**
 * Twilio tools — SMS send + message read access via the Twilio REST API.
 *
 * Self-registering tool module for the recipe tool registry. Wraps the
 * `TwilioConnector` methods (`sendSms`, `listMessages`, `getMessage`).
 *
 * `send_sms` is write-gated (isWrite: true) so the approval queue and the
 * write kill-switch gate it. Read tools (`list_messages`, `get_message`) are
 * isWrite: false.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// twilio.send_sms  (write-gated)
// ============================================================================

registerTool({
  id: "twilio.send_sms",
  namespace: "twilio",
  description:
    "Send an SMS via Twilio. 'to' and 'body' are required; 'from' falls back to the connector's defaultFrom. Phone numbers must be E.164 (e.g. +14155551234).",
  paramsSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Destination phone number in E.164 format (+14155551234)",
      },
      body: {
        type: "string",
        description: "SMS message body text",
      },
      from: {
        type: "string",
        description:
          "Optional sender phone number in E.164 format; defaults to the connector's configured defaultFrom",
      },
      into: CommonSchemas.into,
    },
    required: ["to", "body"],
  },
  outputSchema: {
    type: "object",
    properties: {
      sid: { type: "string" },
      account_sid: { type: "string" },
      to: { type: "string" },
      from: { type: "string" },
      body: { type: "string" },
      status: { type: "string" },
      direction: { type: "string" },
      date_sent: { type: ["string", "null"] },
      date_created: { type: "string" },
      date_updated: { type: "string" },
      price: { type: ["string", "null"] },
      price_unit: { type: ["string", "null"] },
      error_code: { type: ["number", "null"] },
      error_message: { type: ["string", "null"] },
      num_segments: { type: "string" },
      num_media: { type: "string" },
      uri: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTwilioConnector } = await import("../../connectors/twilio.js");
    const connector = getTwilioConnector();
    const result = await connector.sendSms({
      to: params.to as string,
      body: params.body as string,
      from: typeof params.from === "string" ? params.from : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// twilio.list_messages
// ============================================================================

registerTool({
  id: "twilio.list_messages",
  namespace: "twilio",
  description:
    "List Twilio messages, optionally filtered by 'to', 'from', or 'dateSent' (YYYY-MM-DD).",
  paramsSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Filter by destination phone number (E.164)",
      },
      from: {
        type: "string",
        description: "Filter by sender phone number (E.164)",
      },
      dateSent: {
        type: "string",
        description: "Filter by send date (YYYY-MM-DD)",
      },
      limit: {
        type: "number",
        description: "Max number of messages to return (default 20)",
        default: 20,
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      messages: { type: "array", items: { type: "object" } },
      page: { type: "number" },
      page_size: { type: "number" },
      next_page_uri: { type: ["string", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTwilioConnector } = await import("../../connectors/twilio.js");
    const connector = getTwilioConnector();
    const result = await connector.listMessages({
      to: typeof params.to === "string" ? params.to : undefined,
      from: typeof params.from === "string" ? params.from : undefined,
      dateSent:
        typeof params.dateSent === "string" ? params.dateSent : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// twilio.get_message
// ============================================================================

registerTool({
  id: "twilio.get_message",
  namespace: "twilio",
  description: "Fetch a single Twilio message by its message SID (SM...).",
  paramsSchema: {
    type: "object",
    properties: {
      messageSid: {
        type: "string",
        description: "Twilio message SID (SM...)",
      },
      into: CommonSchemas.into,
    },
    required: ["messageSid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      sid: { type: "string" },
      account_sid: { type: "string" },
      to: { type: "string" },
      from: { type: "string" },
      body: { type: "string" },
      status: { type: "string" },
      direction: { type: "string" },
      date_sent: { type: ["string", "null"] },
      date_created: { type: "string" },
      date_updated: { type: "string" },
      price: { type: ["string", "null"] },
      price_unit: { type: ["string", "null"] },
      error_code: { type: ["number", "null"] },
      error_message: { type: ["string", "null"] },
      num_segments: { type: "string" },
      num_media: { type: "string" },
      uri: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTwilioConnector } = await import("../../connectors/twilio.js");
    const connector = getTwilioConnector();
    const result = await connector.getMessage(params.messageSid as string);
    return JSON.stringify(result);
  },
});
