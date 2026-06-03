/**
 * CircleCI recipe-step tools — read set (list_pipelines, get_workflow, get_job)
 * plus the write trigger_pipeline.
 *
 * Mocks the CircleCI connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful param mapping into the connector calls,
 * that the raw connector return type is JSON-stringified back out, and that the
 * write tool is gated (isWrite: true) while reads are not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getCircleCIConnector returns it.

const getPipelines = vi.fn();
const triggerPipeline = vi.fn();
const getWorkflow = vi.fn();
const getJob = vi.fn();

vi.mock("../../../connectors/circleci.js", () => ({
  getCircleCIConnector: () => ({
    getPipelines,
    triggerPipeline,
    getWorkflow,
    getJob,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../circleci.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("circleci recipe-step tools", () => {
  beforeEach(() => {
    getPipelines.mockReset();
    triggerPipeline.mockReset();
    getWorkflow.mockReset();
    getJob.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ──────────────────────────────────────────────────

  it("registers the three read tools with low risk / non-write", () => {
    for (const id of [
      "circleci.list_pipelines",
      "circleci.get_workflow",
      "circleci.get_job",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("circleci");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it("registers trigger_pipeline as a write tool with medium risk", () => {
    const tool = getTool("circleci.trigger_pipeline");
    expect(
      tool,
      "tool circleci.trigger_pipeline should be registered",
    ).toBeDefined();
    expect(tool?.namespace).toBe("circleci");
    expect(tool?.isWrite).toBe(true);
    expect(tool?.riskDefault).toBe("medium");
    expect(tool?.isConnector).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
  });

  // ── circleci.list_pipelines ─────────────────────────────────────────────────

  it("list_pipelines forwards projectSlug + branch and stringifies the array", async () => {
    const pipelines = [
      {
        id: "pl_1",
        project_slug: "gh/acme/web",
        state: "created",
        number: 42,
        trigger: { type: "api", received_at: "2026-06-01T00:00:00Z" },
      },
    ];
    getPipelines.mockResolvedValue(pipelines);

    const tool = getTool("circleci.list_pipelines");
    const out = await tool?.execute(
      makeContext({ projectSlug: "gh/acme/web", branch: "main" }),
    );

    expect(getPipelines).toHaveBeenCalledWith("gh/acme/web", "main");
    expect(out).toBe(JSON.stringify(pipelines));
  });

  it("list_pipelines passes undefined branch when omitted / wrong-typed", async () => {
    getPipelines.mockResolvedValue([]);

    const tool = getTool("circleci.list_pipelines");
    await tool?.execute(
      makeContext({ projectSlug: "gh/acme/web", branch: 123 }),
    );

    expect(getPipelines).toHaveBeenCalledWith("gh/acme/web", undefined);
  });

  // ── circleci.trigger_pipeline ───────────────────────────────────────────────

  it("trigger_pipeline forwards slug + branch/tag/parameters and stringifies the result", async () => {
    const result = {
      id: "pl_new",
      state: "pending",
      number: 99,
      created_at: "2026-06-02T00:00:00Z",
    };
    triggerPipeline.mockResolvedValue(result);

    const tool = getTool("circleci.trigger_pipeline");
    const out = await tool?.execute(
      makeContext({
        projectSlug: "gh/acme/web",
        branch: "release",
        tag: "v1.0.0",
        parameters: { deploy: true, region: "us" },
      }),
    );

    expect(triggerPipeline).toHaveBeenCalledWith("gh/acme/web", {
      branch: "release",
      tag: "v1.0.0",
      parameters: { deploy: true, region: "us" },
    });
    expect(out).toBe(JSON.stringify(result));
  });

  it("trigger_pipeline passes undefined for omitted / wrong-typed optionals", async () => {
    triggerPipeline.mockResolvedValue({
      id: "pl_x",
      state: "pending",
      number: 1,
      created_at: "2026-06-02T00:00:00Z",
    });

    const tool = getTool("circleci.trigger_pipeline");
    await tool?.execute(
      makeContext({
        projectSlug: "gh/acme/web",
        branch: 5,
        parameters: "nope",
      }),
    );

    expect(triggerPipeline).toHaveBeenCalledWith("gh/acme/web", {
      branch: undefined,
      tag: undefined,
      parameters: undefined,
    });
  });

  // ── circleci.get_workflow ───────────────────────────────────────────────────

  it("get_workflow passes the id positionally and stringifies the object", async () => {
    const workflow = {
      id: "wf_42",
      name: "build-and-test",
      status: "success",
      pipeline_id: "pl_1",
      started_by: "user_1",
      created_at: "2026-06-01T00:00:00Z",
    };
    getWorkflow.mockResolvedValue(workflow);

    const tool = getTool("circleci.get_workflow");
    const out = await tool?.execute(makeContext({ id: "wf_42" }));

    expect(getWorkflow).toHaveBeenCalledWith("wf_42");
    expect(out).toBe(JSON.stringify(workflow));
  });

  // ── circleci.get_job ────────────────────────────────────────────────────────

  it("get_job passes slug + jobNumber positionally and stringifies the object", async () => {
    const job = {
      id: "job_7",
      name: "test",
      status: "success",
      job_number: 7,
      type: "build",
    };
    getJob.mockResolvedValue(job);

    const tool = getTool("circleci.get_job");
    const out = await tool?.execute(
      makeContext({ projectSlug: "gh/acme/web", jobNumber: 7 }),
    );

    expect(getJob).toHaveBeenCalledWith("gh/acme/web", 7);
    expect(out).toBe(JSON.stringify(job));
  });
});
