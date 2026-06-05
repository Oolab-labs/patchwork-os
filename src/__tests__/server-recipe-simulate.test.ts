/**
 * Integration tests for GET /recipes/:name/simulate — the What-If Preview
 * endpoint backing the dashboard SimulatePanel + pre-run risk gate. Uses a stub
 * simulateFn so server routing is tested independently of bridge state.
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-recipe-simulate-token-0000000";

let server: Server | null = null;
let port = 0;

const FIXTURE_REPORT = {
  schemaVersion: 1,
  kind: "what-if-preview",
  recipe: "test-recipe",
  triggerType: "manual",
  generatedAt: new Date().toISOString(),
  fidelity: "static",
  topology: "flat",
  gatedOnRecipeSteps: false,
  steps: [],
  summary: {
    totalSteps: 0,
    writeSteps: 0,
    connectorSteps: 0,
    agentSteps: 0,
    unresolvedSteps: 0,
    sideEffectCounts: {},
    connectorNamespaces: [],
  },
  risk: {
    score: 0,
    tier: "low",
    components: {
      highSteps: 0,
      mediumSteps: 0,
      writeSteps: 0,
      connectorWriteSteps: 0,
      externalHttpSteps: 0,
      unresolvedSteps: 0,
    },
    highestStepRisk: "low",
  },
  approvals: { gatedOnRecipeSteps: false, projected: [], note: "n/a" },
  cost: {
    basis: "unavailable",
    agentSteps: 0,
    estimatedAgentSteps: 0,
    estPromptTokens: null,
    usd: null,
    note: "n/a",
  },
  branches: [],
  lint: { errors: [], warnings: [] },
  notes: [],
};

async function startServer(
  simulateFn?: (name: string) => Promise<Record<string, unknown>>,
): Promise<void> {
  server = new Server(TOKEN, logger);
  if (simulateFn) server.simulateFn = simulateFn;
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

describe("GET /recipes/:name/simulate", () => {
  it("returns 503 when simulateFn is not wired", async () => {
    await startServer();
    const { status, body } = await get("/recipes/test-recipe/simulate");
    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ error: "simulate_unavailable" });
  });

  it("returns the simulation report", async () => {
    await startServer(
      async () => FIXTURE_REPORT as unknown as Record<string, unknown>,
    );
    const { status, body } = await get("/recipes/test-recipe/simulate");
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { report: typeof FIXTURE_REPORT };
    expect(parsed.report.kind).toBe("what-if-preview");
    expect(parsed.report.recipe).toBe("test-recipe");
    // The honesty field must round-trip over the wire.
    expect(parsed.report.gatedOnRecipeSteps).toBe(false);
  });

  it("returns 404 when the recipe is not found", async () => {
    await startServer(async () => {
      const err = new Error("nope") as NodeJS.ErrnoException;
      err.code = "RECIPE_NOT_FOUND";
      throw err;
    });
    const { status, body } = await get("/recipes/missing/simulate");
    expect(status).toBe(404);
    expect(JSON.parse(body)).toMatchObject({ error: "Recipe not found" });
  });

  it("requires bearer auth", async () => {
    await startServer(
      async () => FIXTURE_REPORT as unknown as Record<string, unknown>,
    );
    const { status } = await get("/recipes/test-recipe/simulate", false);
    expect(status).toBe(401);
  });
});
