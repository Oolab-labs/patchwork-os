import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-activation-metrics-token-000000";

let server: Server | null = null;
let port = 0;
let tempDir = "";
let previousPatchworkHome: string | undefined;

function makeRequest(
  options: http.RequestOptions,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-activation-"));
  previousPatchworkHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = tempDir;
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  if (previousPatchworkHome === undefined) {
    delete process.env.PATCHWORK_HOME;
  } else {
    process.env.PATCHWORK_HOME = previousPatchworkHome;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /activation-metrics", () => {
  it("returns raw metrics and derived summary", async () => {
    const now = Date.now();
    const metrics = {
      installedAt: now - 10 * 24 * 60 * 60 * 1000,
      firstRecipeRunAt: now - 8 * 24 * 60 * 60 * 1000,
      recipeRunsTotal: 7,
      recipeRunsByDay: {
        [dayKey(now)]: 2,
        [dayKey(now - 2 * 24 * 60 * 60 * 1000)]: 1,
        [dayKey(now - 10 * 24 * 60 * 60 * 1000)]: 4,
      },
      approvalsPrompted: 4,
      approvalsCompleted: 3,
    };
    fs.writeFileSync(
      path.join(tempDir, "telemetry.json"),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );

    const { status, body } = await makeRequest({
      method: "GET",
      path: "/activation-metrics",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      metrics,
      summary: {
        installedAt: metrics.installedAt,
        firstRecipeRunAt: metrics.firstRecipeRunAt,
        timeToFirstRecipeRunMs: metrics.firstRecipeRunAt - metrics.installedAt,
        recipeRunsTotal: 7,
        recipeRunsLast7Days: 3,
        activeDaysLast7: 2,
        approvalCompletionRate: 0.75,
        approvalsPrompted: 4,
        approvalsCompleted: 3,
      },
    });
  });
});
