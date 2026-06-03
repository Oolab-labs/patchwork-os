/**
 * Vercel recipe-step tools — read-only set (list_deployments, get_deployment,
 * list_projects).
 *
 * Mocks the Vercel connector module so the self-registering tool module can be
 * imported and each tool exercised through the registry without network or
 * stored credentials. Asserts faithful param mapping into the connector calls
 * and that the raw connector return type is JSON-stringified back out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

// ── Connector mock ───────────────────────────────────────────────────────────
// One shared connector object with spy methods. getVercelConnector returns it.

const listDeployments = vi.fn();
const getDeployment = vi.fn();
const listProjects = vi.fn();

vi.mock("../../../connectors/vercel.js", () => ({
  getVercelConnector: () => ({
    listDeployments,
    getDeployment,
    listProjects,
  }),
}));

// Importing the module self-registers the tools into the shared registry.
import "../vercel.js";

function makeContext(params: Record<string, unknown>) {
  return {
    params,
    step: {},
    ctx: { env: {}, steps: {} } as unknown as RunContext,
    deps: {} as StepDeps,
  };
}

describe("vercel recipe-step tools", () => {
  beforeEach(() => {
    listDeployments.mockReset();
    getDeployment.mockReset();
    listProjects.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── registration metadata ────────────────────────────────────────────────

  it("registers all three read-only tools with low risk / non-write", () => {
    for (const id of [
      "vercel.list_deployments",
      "vercel.get_deployment",
      "vercel.list_projects",
    ]) {
      const tool = getTool(id);
      expect(tool, `tool ${id} should be registered`).toBeDefined();
      expect(tool?.namespace).toBe("vercel");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  // ── vercel.list_deployments ──────────────────────────────────────────────

  it("list_deployments forwards projectId/limit/state and stringifies the array", async () => {
    const deployments = [
      {
        id: "dpl_1",
        uid: "dpl_1",
        name: "web",
        url: "web.vercel.app",
        state: "READY",
        createdAt: 123,
        target: "production",
      },
    ];
    listDeployments.mockResolvedValue(deployments);

    const tool = getTool("vercel.list_deployments");
    const out = await tool?.execute(
      makeContext({ projectId: "prj_1", limit: 5, state: "READY" }),
    );

    expect(listDeployments).toHaveBeenCalledWith({
      projectId: "prj_1",
      limit: 5,
      state: "READY",
    });
    expect(out).toBe(JSON.stringify(deployments));
  });

  it("list_deployments passes undefined for omitted / wrong-typed params", async () => {
    listDeployments.mockResolvedValue([]);

    const tool = getTool("vercel.list_deployments");
    await tool?.execute(makeContext({ limit: "nope" }));

    expect(listDeployments).toHaveBeenCalledWith({
      projectId: undefined,
      limit: undefined,
      state: undefined,
    });
  });

  // ── vercel.get_deployment ────────────────────────────────────────────────

  it("get_deployment passes the id positionally and stringifies the object", async () => {
    const deployment = {
      id: "dpl_42",
      uid: "dpl_42",
      name: "api",
      url: "api.vercel.app",
      state: "BUILDING",
      createdAt: 456,
      target: null,
    };
    getDeployment.mockResolvedValue(deployment);

    const tool = getTool("vercel.get_deployment");
    const out = await tool?.execute(makeContext({ id: "dpl_42" }));

    expect(getDeployment).toHaveBeenCalledWith("dpl_42");
    expect(out).toBe(JSON.stringify(deployment));
  });

  // ── vercel.list_projects ─────────────────────────────────────────────────

  it("list_projects forwards limit and stringifies the array", async () => {
    const projects = [
      {
        id: "prj_1",
        name: "web",
        framework: "nextjs",
        latestDeployments: [],
      },
    ];
    listProjects.mockResolvedValue(projects);

    const tool = getTool("vercel.list_projects");
    const out = await tool?.execute(makeContext({ limit: 10 }));

    expect(listProjects).toHaveBeenCalledWith({ limit: 10 });
    expect(out).toBe(JSON.stringify(projects));
  });

  it("list_projects passes undefined limit when omitted", async () => {
    listProjects.mockResolvedValue([]);

    const tool = getTool("vercel.list_projects");
    await tool?.execute(makeContext({}));

    expect(listProjects).toHaveBeenCalledWith({ limit: undefined });
  });
});
