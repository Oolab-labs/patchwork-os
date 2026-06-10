/**
 * Pipedrive tools — read wrappers (deals, persons, pipelines) plus a write
 * (create_deal) over the Pipedrive CRM REST API v1.
 *
 * Self-registering tool module for the recipe tool registry. Mirrors the
 * connector method signatures faithfully (see src/connectors/pipedrive.ts):
 *   - getDeals({ status?, start?, limit? }) → PipedriveDeal[]
 *   - createDeal({ title, value?, currency?, stageId?, personId?, orgId?,
 *                  status?, expectedCloseDate? }) → PipedriveDeal
 *   - getPersons({ start?, limit? }) → PipedrivePerson[]
 *   - getPipelines() → PipedrivePipeline[]
 *
 * Read tools declare `isWrite: false`; the write tool declares `isWrite: true`
 * so the approval queue gates it appropriately.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// pipedrive.list_deals
// ============================================================================

registerTool({
  id: "pipedrive.list_deals",
  namespace: "pipedrive",
  description:
    "List Pipedrive deals, optionally filtered by status with pagination.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["open", "won", "lost", "deleted", "all_not_deleted"],
        description: "Filter by deal status",
      },
      start: {
        type: "number",
        description: "Pagination offset (0-based index of first item)",
      },
      limit: {
        type: "number",
        description: "Max number of deals to return",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        value: { type: ["number", "null"] },
        currency: { type: "string" },
        status: { type: "string" },
        stage_id: { type: ["number", "null"] },
        expected_close_date: { type: ["string", "null"] },
        add_time: { type: "string" },
        update_time: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPipedriveConnector } = await import(
      "../../connectors/pipedrive.js"
    );
    const connector = getPipedriveConnector();
    const result = await connector.getDeals({
      status:
        typeof params.status === "string"
          ? (params.status as
              | "open"
              | "won"
              | "lost"
              | "deleted"
              | "all_not_deleted")
          : undefined,
      start: typeof params.start === "number" ? params.start : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// pipedrive.create_deal  (write-gated)
// ============================================================================

registerTool({
  id: "pipedrive.create_deal",
  namespace: "pipedrive",
  description:
    "Create a new Pipedrive deal. Requires a title; all other fields optional.",
  paramsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Deal title (required)" },
      value: { type: "number", description: "Deal monetary value" },
      currency: {
        type: "string",
        description: "Currency code (e.g. USD, EUR)",
      },
      stageId: { type: "number", description: "Pipeline stage id" },
      personId: { type: "number", description: "Linked person id" },
      orgId: { type: "number", description: "Linked organization id" },
      status: {
        type: "string",
        enum: ["open", "won", "lost"],
        description: "Initial deal status",
      },
      expectedCloseDate: {
        type: "string",
        description: "Expected close date (ISO YYYY-MM-DD)",
      },
      into: CommonSchemas.into,
    },
    required: ["title"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      title: { type: "string" },
      value: { type: ["number", "null"] },
      currency: { type: "string" },
      status: { type: "string" },
      stage_id: { type: ["number", "null"] },
      expected_close_date: { type: ["string", "null"] },
      add_time: { type: "string" },
      update_time: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPipedriveConnector } = await import(
      "../../connectors/pipedrive.js"
    );
    const connector = getPipedriveConnector();
    const result = await connector.createDeal({
      title: params.title as string,
      value: typeof params.value === "number" ? params.value : undefined,
      currency:
        typeof params.currency === "string" ? params.currency : undefined,
      stageId: typeof params.stageId === "number" ? params.stageId : undefined,
      personId:
        typeof params.personId === "number" ? params.personId : undefined,
      orgId: typeof params.orgId === "number" ? params.orgId : undefined,
      status:
        typeof params.status === "string"
          ? (params.status as "open" | "won" | "lost")
          : undefined,
      expectedCloseDate:
        typeof params.expectedCloseDate === "string"
          ? params.expectedCloseDate
          : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// pipedrive.list_persons
// ============================================================================

registerTool({
  id: "pipedrive.list_persons",
  namespace: "pipedrive",
  description: "List Pipedrive persons (contacts) with pagination.",
  paramsSchema: {
    type: "object",
    properties: {
      start: {
        type: "number",
        description: "Pagination offset (0-based index of first item)",
      },
      limit: {
        type: "number",
        description: "Max number of persons to return",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        email: { type: "array", items: { type: "object" } },
        phone: { type: "array", items: { type: "object" } },
        org_id: { type: ["object", "null"] },
        add_time: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getPipedriveConnector } = await import(
      "../../connectors/pipedrive.js"
    );
    const connector = getPipedriveConnector();
    const result = await connector.getPersons({
      start: typeof params.start === "number" ? params.start : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// pipedrive.list_pipelines
// ============================================================================

registerTool({
  id: "pipedrive.list_pipelines",
  namespace: "pipedrive",
  description: "List all Pipedrive pipelines.",
  paramsSchema: {
    type: "object",
    properties: {
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        order_nr: { type: "number" },
        active: { type: "boolean" },
        add_time: { type: "string" },
        update_time: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async () => {
    const { getPipedriveConnector } = await import(
      "../../connectors/pipedrive.js"
    );
    const connector = getPipedriveConnector();
    const result = await connector.getPipelines();
    return JSON.stringify(result);
  }),
});
