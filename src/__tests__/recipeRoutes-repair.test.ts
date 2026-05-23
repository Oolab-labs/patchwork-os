/**
 * Phase 2A.1 — /recipes/repair endpoint tests.
 *
 * Covers: flag-off → 503, missing repairRecipeFn → 503, body
 * validation (400), cooldown bucket → 429, happy path → 200 with
 * stubbed repairRecipeFn. Real Claude integration lives in
 * RecipeOrchestration and is exercised by the integration test that
 * uses a mock orchestrator separately.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetEnvLockForTesting,
  FLAG_REPAIR_AI,
  setFlag,
} from "../featureFlags.js";
import { Logger } from "../logger.js";
import {
  _resetRepairRateLimitForTests,
  RECIPE_ROUTE_BODY_CAPS,
} from "../recipeRoutes.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-recipes-repair-token-0000000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(
  options: http.RequestOptions,
  body = "",
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
  _resetEnvLockForTesting();
  _resetRepairRateLimitForTests();
});

afterEach(async () => {
  setFlag(FLAG_REPAIR_AI, false, false);
  await server?.close();
  server = null;
  port = 0;
});

describe("Server /recipes/repair — Phase 2A.1", () => {
  const VALID_BODY = JSON.stringify({
    currentYaml: "name: x\ntrigger:\n  type: manual\nsteps:\n  - agent: {}\n",
    lintIssues: [
      { level: "error", message: "Step 1: Agent step missing 'prompt'" },
    ],
  });

  it("flag-off → 503 feature_disabled, never consumes a bucket token", async () => {
    setFlag(FLAG_REPAIR_AI, false, false);
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      VALID_BODY,
    );
    expect(status).toBe(503);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("feature_disabled");
    expect(parsed.unavailable).toBe(true);
  });

  it("flag-on, no repairRecipeFn wired → 503 unavailable", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      VALID_BODY,
    );
    expect(status).toBe(503);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.unavailable).toBe(true);
    expect(parsed.error).toMatch(/requires --driver subprocess/i);
  });

  it("flag-on, missing currentYaml → 400", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ lintIssues: [] }),
    );
    expect(status).toBe(400);
  });

  it("flag-on, body exceeds 256 KB cap → 413", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    // Overshoot the cap with a single oversized currentYaml string.
    const oversized = "x".repeat(RECIPE_ROUTE_BODY_CAPS.repair + 1024);
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ currentYaml: oversized, lintIssues: [] }),
    );
    expect(status).toBe(413);
  });

  it("flag-on + repairRecipeFn stubbed → 200 with proposed yaml", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    server!.repairRecipeFn = async ({ currentYaml, lintIssues }) => {
      // Stub: return the body unchanged so we can assert plumbing.
      return {
        ok: true,
        yaml: `${currentYaml}# repaired (${lintIssues.length} issues)\n`,
        warnings: [],
      };
    };
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      VALID_BODY,
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.yaml).toMatch(/# repaired \(1 issues\)/);
  });

  it("flag-on, 11th request inside a minute → 429 with Retry-After", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    server!.repairRecipeFn = async () => ({ ok: true, yaml: "name: ok\n" });
    // Burn the bucket — default capacity is RECIPE_REPAIR_LIMIT_PER_MIN.
    for (let i = 0; i < 10; i++) {
      const r = await makeRequest(
        {
          method: "POST",
          path: "/recipes/repair",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
        },
        VALID_BODY,
      );
      expect(r.status).toBe(200);
    }
    const { status, body, headers } = await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      VALID_BODY,
    );
    expect(status).toBe(429);
    expect(headers["retry-after"]).toBeDefined();
    const parsed = JSON.parse(body);
    expect(parsed.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("flag-on + lint-issue shape guard rejects junk, accepts valid", async () => {
    setFlag(FLAG_REPAIR_AI, true, false);
    let received: unknown;
    server!.repairRecipeFn = async ({ lintIssues }) => {
      received = lintIssues;
      return { ok: true, yaml: "name: x\n" };
    };
    await makeRequest(
      {
        method: "POST",
        path: "/recipes/repair",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        currentYaml: "name: x\n",
        lintIssues: [
          // Valid
          { level: "error", message: "Step 1: missing prompt", line: 3 },
          // Valid with all fields
          {
            level: "warning",
            message: "deprecation",
            path: "trigger.at",
            code: "deprecated",
          },
          // Junk — no level
          { message: "no level field" },
          // Junk — no message
          { level: "error" },
          // Junk — wrong level value
          { level: "info", message: "wrong level" },
          // Junk — not an object
          "string item",
          null,
          42,
        ],
      }),
    );
    expect(Array.isArray(received)).toBe(true);
    expect(received).toHaveLength(2);
    expect((received as Array<{ message: string }>)[0]?.message).toBe(
      "Step 1: missing prompt",
    );
    expect((received as Array<{ message: string }>)[1]?.message).toBe(
      "deprecation",
    );
  });
});
