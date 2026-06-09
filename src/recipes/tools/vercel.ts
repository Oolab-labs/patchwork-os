/**
 * Vercel tools — read-only access to deployments and projects.
 *
 * Self-registering tool module for the recipe tool registry. Read-only set
 * only (v1 safe): no createDeployment / cancelDeployment / env-var mutations.
 * Each tool mirrors the real connector signature in `src/connectors/vercel.ts`
 * and returns `JSON.stringify(result)` of the connector's native return type.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// vercel.list_deployments
// ============================================================================

registerTool({
  id: "vercel.list_deployments",
  namespace: "vercel",
  description:
    "List Vercel deployments, optionally filtered by project ID and state.",
  paramsSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "Filter by Vercel project ID",
      },
      limit: {
        type: "number",
        description: "Max number of deployments to return",
      },
      state: {
        type: "string",
        description:
          "Filter by deployment state (BUILDING, ERROR, INITIALIZING, QUEUED, READY, CANCELED)",
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
        id: { type: "string" },
        uid: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        state: { type: "string" },
        createdAt: { type: "number" },
        target: { type: ["string", "null"] },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getVercelConnector } = await import("../../connectors/vercel.js");
    const connector = getVercelConnector();
    const result = await connector.listDeployments({
      projectId:
        typeof params.projectId === "string" ? params.projectId : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
      state: typeof params.state === "string" ? params.state : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// vercel.get_deployment
// ============================================================================

registerTool({
  id: "vercel.get_deployment",
  namespace: "vercel",
  description: "Fetch a single Vercel deployment by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Vercel deployment ID" },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      uid: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      state: { type: "string" },
      createdAt: { type: "number" },
      target: { type: ["string", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getVercelConnector } = await import("../../connectors/vercel.js");
    const connector = getVercelConnector();
    const result = await connector.getDeployment(params.id as string);
    return JSON.stringify(result);
  }),
});

// ============================================================================
// vercel.list_projects
// ============================================================================

registerTool({
  id: "vercel.list_projects",
  namespace: "vercel",
  description: "List Vercel projects.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of projects to return",
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
        id: { type: "string" },
        name: { type: "string" },
        framework: { type: ["string", "null"] },
        link: { type: "object" },
        latestDeployments: { type: "array", items: { type: "object" } },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getVercelConnector } = await import("../../connectors/vercel.js");
    const connector = getVercelConnector();
    const result = await connector.listProjects({
      limit: typeof params.limit === "number" ? params.limit : undefined,
    });
    return JSON.stringify(result);
  }),
});
