/**
 * Integration tests for GET /runs/:seq — single run detail endpoint backing
 * the dashboard step timeline. Uses a stub runDetailFn so server routing is
 * tested independently of bridge state.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-run-detail-token-000000000000";

let server: Server | null = null;
let port = 0;

const FIXTURE_RUN = {
  seq: 7,
  taskId: "yaml:test-recipe:1714000000000",
  recipeName: "test-recipe",
  trigger: "recipe",
  status: "done",
  createdAt: 1714000000000,
  startedAt: 1714000000000,
  doneAt: 1714000005000,
  durationMs: 5000,
  stepResults: [
    { id: "fetch", tool: "jira.searchIssues", status: "ok", durationMs: 1200 },
    { id: "post", tool: "slack.postMessage", status: "ok", durationMs: 300 },
  ],
};

async function startServer(
  detailFn?: (seq: number) => Record<string, unknown> | null,
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (detailFn) server.runDetailFn = detailFn;
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function get(
  path: string,
  auth = true,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${TOKEN}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /runs/:seq", () => {
  it("returns 404 when runDetailFn is not wired", async () => {
    await startServer();
    const { status } = await get("/runs/7");
    expect(status).toBe(404);
  });

  it("returns 404 when detailFn returns null (run not found)", async () => {
    await startServer(() => null);
    const { status, body } = await get("/runs/99");
    expect(status).toBe(404);
    expect(JSON.parse(body)).toMatchObject({ error: "not_found" });
  });

  it("returns the run with stepResults", async () => {
    await startServer((seq) => (seq === 7 ? FIXTURE_RUN : null));
    const { status, body } = await get("/runs/7");
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { run: typeof FIXTURE_RUN };
    expect(parsed.run.seq).toBe(7);
    expect(parsed.run.recipeName).toBe("test-recipe");
    expect(parsed.run.stepResults).toHaveLength(2);
    expect(parsed.run.stepResults[0].tool).toBe("jira.searchIssues");
  });

  it("requires bearer auth", async () => {
    await startServer((seq) => (seq === 7 ? FIXTURE_RUN : null));
    const { status } = await get("/runs/7", false);
    expect(status).toBe(401);
  });

  it("rejects non-numeric seq gracefully", async () => {
    await startServer(() => FIXTURE_RUN);
    // /runs/abc doesn't match the ^\d+$ pattern — falls through to 404
    const { status } = await get("/runs/abc");
    expect(status).toBe(404);
  });
});

describe("GET /runs/:seq/plan", () => {
  const FIXTURE_PLAN = {
    schemaVersion: 1,
    recipe: "test-recipe",
    mode: "dry-run",
    triggerType: "manual",
    generatedAt: new Date().toISOString(),
    steps: [
      {
        id: "fetch",
        type: "tool",
        tool: "jira.searchIssues",
        isConnector: true,
        resolved: true,
      },
    ],
    connectorNamespaces: ["jira"],
    hasWriteSteps: false,
  };

  async function startPlanServer(
    planFn?: (name: string) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    server = new Server(TOKEN, logger);
    server.runDetailFn = (seq) => (seq === 7 ? FIXTURE_RUN : null);
    if (planFn) server.runPlanFn = planFn;
    port = await server.findAndListen(null);
  }

  it("returns 503 when runPlanFn not wired", async () => {
    await startPlanServer();
    const { status, body } = await get("/runs/7/plan");
    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: "plan_unavailable" });
  });

  it("returns 404 when run not found", async () => {
    await startPlanServer(
      async () => FIXTURE_PLAN as unknown as Record<string, unknown>,
    );
    const { status } = await get("/runs/99/plan");
    expect(status).toBe(404);
  });

  it("returns the generated plan", async () => {
    await startPlanServer(
      async () => FIXTURE_PLAN as unknown as Record<string, unknown>,
    );
    const { status, body } = await get("/runs/7/plan");
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { plan: typeof FIXTURE_PLAN };
    expect(parsed.plan.recipe).toBe("test-recipe");
    expect(parsed.plan.steps).toHaveLength(1);
    expect(parsed.plan.connectorNamespaces).toEqual(["jira"]);
  });

  it("requires bearer auth", async () => {
    await startPlanServer(
      async () => FIXTURE_PLAN as unknown as Record<string, unknown>,
    );
    const { status } = await get("/runs/7/plan", false);
    expect(status).toBe(401);
  });
});
