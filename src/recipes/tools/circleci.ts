/**
 * CircleCI recipe-step tools — read wrappers (list_pipelines, get_workflow,
 * get_job) plus a write (trigger_pipeline).
 *
 * Self-registering tool module for the recipe tool registry. Wraps the
 * CircleCI v2 connector methods 1:1 and JSON-stringifies the raw connector
 * return type back out. Read tools declare `isWrite: false`; trigger_pipeline
 * declares `isWrite: true` so the approval queue gates it appropriately.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// circleci.list_pipelines
// ============================================================================

registerTool({
  id: "circleci.list_pipelines",
  namespace: "circleci",
  description:
    "List recent CircleCI pipelines for a project, optionally filtered by branch.",
  paramsSchema: {
    type: "object",
    properties: {
      projectSlug: {
        type: "string",
        description:
          "CircleCI project slug, e.g. gh/owner/repo (github/ and bitbucket/ prefixes accepted)",
      },
      branch: {
        type: "string",
        description: "Filter pipelines by VCS branch name",
      },
      into: CommonSchemas.into,
    },
    required: ["projectSlug"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        project_slug: { type: "string" },
        state: { type: "string" },
        number: { type: "number" },
        trigger: { type: "object" },
        vcs: { type: "object" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCircleCIConnector } = await import(
      "../../connectors/circleci.js"
    );
    const connector = getCircleCIConnector();
    const result = await connector.getPipelines(
      params.projectSlug as string,
      typeof params.branch === "string" ? params.branch : undefined,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// circleci.trigger_pipeline  (write-gated)
// ============================================================================

registerTool({
  id: "circleci.trigger_pipeline",
  namespace: "circleci",
  description:
    "Trigger a new CircleCI pipeline for a project, optionally on a branch or tag with custom pipeline parameters.",
  paramsSchema: {
    type: "object",
    properties: {
      projectSlug: {
        type: "string",
        description:
          "CircleCI project slug, e.g. gh/owner/repo (github/ and bitbucket/ prefixes accepted)",
      },
      branch: {
        type: "string",
        description: "VCS branch to run the pipeline against",
      },
      tag: {
        type: "string",
        description:
          "VCS tag to run the pipeline against (mutually exclusive with branch)",
      },
      parameters: {
        type: "object",
        description:
          "Pipeline parameters map (string/boolean/number values) passed to the pipeline",
      },
      into: CommonSchemas.into,
    },
    required: ["projectSlug"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      state: { type: "string" },
      number: { type: "number" },
      created_at: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCircleCIConnector } = await import(
      "../../connectors/circleci.js"
    );
    const connector = getCircleCIConnector();
    const result = await connector.triggerPipeline(
      params.projectSlug as string,
      {
        branch: typeof params.branch === "string" ? params.branch : undefined,
        tag: typeof params.tag === "string" ? params.tag : undefined,
        parameters:
          params.parameters && typeof params.parameters === "object"
            ? (params.parameters as Record<string, string | boolean | number>)
            : undefined,
      },
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// circleci.get_workflow
// ============================================================================

registerTool({
  id: "circleci.get_workflow",
  namespace: "circleci",
  description: "Fetch a single CircleCI workflow by its workflow ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "CircleCI workflow ID (UUID)",
      },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      status: { type: "string" },
      pipeline_id: { type: "string" },
      pipeline_number: { type: "number" },
      project_slug: { type: "string" },
      started_by: { type: "string" },
      created_at: { type: "string" },
      stopped_at: { type: ["string", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCircleCIConnector } = await import(
      "../../connectors/circleci.js"
    );
    const connector = getCircleCIConnector();
    const result = await connector.getWorkflow(params.id as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// circleci.get_job
// ============================================================================

registerTool({
  id: "circleci.get_job",
  namespace: "circleci",
  description: "Fetch a single CircleCI job by project slug and job number.",
  paramsSchema: {
    type: "object",
    properties: {
      projectSlug: {
        type: "string",
        description:
          "CircleCI project slug, e.g. gh/owner/repo (github/ and bitbucket/ prefixes accepted)",
      },
      jobNumber: {
        type: "number",
        description: "The job number within the project",
      },
      into: CommonSchemas.into,
    },
    required: ["projectSlug", "jobNumber"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      status: { type: "string" },
      job_number: { type: "number" },
      type: { type: "string" },
      created_at: { type: "string" },
      started_at: { type: ["string", "null"] },
      stopped_at: { type: ["string", "null"] },
      approval_request_id: { type: "string" },
      dependencies: { type: "array", items: { type: "string" } },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getCircleCIConnector } = await import(
      "../../connectors/circleci.js"
    );
    const connector = getCircleCIConnector();
    const result = await connector.getJob(
      params.projectSlug as string,
      params.jobNumber as number,
    );
    return JSON.stringify(result);
  },
});
