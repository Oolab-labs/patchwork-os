/**
 * Regression tests for POST /settings driver persistence.
 *
 * Before the fix, POST /settings only wrote driver to ~/.patchwork/config.json
 * via savePatchworkConfig(). The effective bridge config file
 * (~/.claude/ide/config.json or --config path) was not updated, so the old
 * driver was still loaded on restart.
 *
 * These tests prove that POST /settings writes driver to the authoritative
 * bridge config file (server.bridgeConfigPath), preserves unrelated keys, and
 * strips the deprecated claudeDriver field.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

// Stub loadPatchworkConfig / savePatchworkConfig so the handler doesn't need a
// real ~/.patchwork directory.
vi.mock("../patchwork.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../patchwork.js")>();
  return {
    ...actual,
    loadPatchworkConfig: vi.fn().mockReturnValue({
      dashboard: {
        port: 3000,
        requireApproval: ["high"],
        pushNotifications: false,
      },
      approvalGate: "high",
    }),
    savePatchworkConfig: vi.fn(),
    patchworkConfigPath: vi.fn().mockReturnValue("/tmp/patchwork-stub.json"),
  };
});

const logger = new Logger(false);
const TOKEN = "test-settings-token-00000000000000";

let server: Server | null = null;
let port = 0;
let tempDir: string | null = null;

function makeRequest(
  options: http.RequestOptions,
  body: string,
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
    req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "pw-settings-test-"));
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.clearAllMocks();
});

describe("POST /settings — driver persistence to bridge config file", () => {
  it("writes driver to bridgeConfigPath, not only patchwork config", async () => {
    const bridgeCfgPath = path.join(tempDir!, "bridge.json");
    writeFileSync(bridgeCfgPath, JSON.stringify({ port: 9999 }, null, 2));
    server!.bridgeConfigPath = bridgeCfgPath;

    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ driver: "gemini" }),
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true, restartRequired: true });

    const saved = JSON.parse(readFileSync(bridgeCfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved.driver).toBe("gemini");
  });

  it("preserves unrelated bridge config keys when saving driver", async () => {
    const bridgeCfgPath = path.join(tempDir!, "bridge.json");
    writeFileSync(
      bridgeCfgPath,
      JSON.stringify(
        { port: 4747, fullMode: true, automationEnabled: false },
        null,
        2,
      ),
    );
    server!.bridgeConfigPath = bridgeCfgPath;

    await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ driver: "openai" }),
    );

    const saved = JSON.parse(readFileSync(bridgeCfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved.driver).toBe("openai");
    expect(saved.port).toBe(4747);
    expect(saved.fullMode).toBe(true);
    expect(saved.automationEnabled).toBe(false);
  });

  it("strips deprecated claudeDriver key when saving driver", async () => {
    const bridgeCfgPath = path.join(tempDir!, "bridge.json");
    writeFileSync(
      bridgeCfgPath,
      JSON.stringify({ claudeDriver: "subprocess", port: 3101 }, null, 2),
    );
    server!.bridgeConfigPath = bridgeCfgPath;

    await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ driver: "gemini" }),
    );

    const saved = JSON.parse(readFileSync(bridgeCfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved.driver).toBe("gemini");
    expect(saved).not.toHaveProperty("claudeDriver");
  });

  it("creates bridge config file if it does not exist yet", async () => {
    const bridgeCfgPath = path.join(tempDir!, "new", "bridge.json");
    mkdirSync(path.dirname(bridgeCfgPath), { recursive: true });
    server!.bridgeConfigPath = bridgeCfgPath;

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ driver: "subprocess" }),
    );

    expect(status).toBe(200);
    const saved = JSON.parse(readFileSync(bridgeCfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved.driver).toBe("subprocess");
  });

  it("returns 401 without auth token", async () => {
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: { "Content-Type": "application/json" },
      },
      JSON.stringify({ driver: "gemini" }),
    );
    expect(status).toBe(401);
  });

  it("returns 400 for unknown driver value", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ driver: "bogus-driver" }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      error: expect.stringContaining("driver"),
    });
  });
});
