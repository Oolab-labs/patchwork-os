/**
 * Regression tests for POST /settings driver persistence.
 *
 * Before the fix, POST /settings only wrote driver to ~/.patchwork/config.json
 * via savePatchworkConfig(). The effective bridge config file
 * (~/.claude/ide/config.json or --config path) was not updated, so the old
 * driver was still loaded on restart.
 *
 * These tests prove that POST /settings writes driver to the authoritative
 * bridge config file (server.bridgeConfigPath) and preserves unrelated keys.
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
vi.mock("../patchworkConfig.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../patchworkConfig.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({
      dashboard: {
        port: 3000,
        requireApproval: ["high"],
        pushNotifications: false,
      },
      approvalGate: "high",
    }),
    saveConfig: vi.fn(),
    defaultConfigPath: vi.fn().mockReturnValue("/tmp/patchwork-stub.json"),
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

  it("POST /settings { enableTimeOfDayAnomaly: true } live-mutates Server", async () => {
    expect(server!.enableTimeOfDayAnomaly).toBe(false);
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ enableTimeOfDayAnomaly: true }),
    );
    expect(status).toBe(200);
    expect(server!.enableTimeOfDayAnomaly).toBe(true);
  });

  it("POST /settings { enableTimeOfDayAnomaly: false } turns it back off", async () => {
    server!.enableTimeOfDayAnomaly = true;
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ enableTimeOfDayAnomaly: false }),
    );
    expect(status).toBe(200);
    expect(server!.enableTimeOfDayAnomaly).toBe(false);
  });

  it("rejects non-boolean enableTimeOfDayAnomaly with 400", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ enableTimeOfDayAnomaly: "yes" }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      error: expect.stringContaining("enableTimeOfDayAnomaly"),
    });
  });

  // chmod 0o500 is a no-op on Win32 so the atomic write never fails — can't
  // exercise this failure mode without a different injection strategy.
  it.skipIf(process.platform === "win32")(
    "returns 500 (not 400 'Invalid request body') when bridge config write fails",
    async () => {
      // Audit found that disk-write failures inside POST /settings were caught
      // by the outer try and reported as HTTP 400 'Invalid request body' — the
      // same shape as a JSON parse error. Callers (the dashboard) couldn't
      // distinguish a malformed payload from a permissions error on the bridge
      // config file. The fix wraps saveBridgeConfigDriver in its own try/catch
      // and returns HTTP 500 with a distinct message.
      const bridgeCfgPath = path.join(tempDir!, "ro", "bridge.json");
      mkdirSync(path.dirname(bridgeCfgPath), { recursive: true });
      // Make the parent directory read-only so the atomic write inside
      // saveBridgeConfigDriver fails on the temp-file rename.
      const fs = await import("node:fs");
      fs.chmodSync(path.dirname(bridgeCfgPath), 0o500);
      server!.bridgeConfigPath = bridgeCfgPath;

      try {
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

        expect(status).toBe(500);
        const parsed = JSON.parse(body) as { error: string };
        expect(parsed.error).not.toBe("Invalid request body");
        expect(parsed.error.toLowerCase()).toContain("config");
      } finally {
        // Restore permissions so cleanup in afterEach can rm -rf.
        fs.chmodSync(path.dirname(bridgeCfgPath), 0o700);
      }
    },
  );

  it("returns 413 when /settings body exceeds 16 KB cap", async () => {
    // Pad a valid-shape body past the 16 KB cap. Without the cap an
    // authenticated caller could stream gigabytes; the cap rejects the
    // request after the first overflowing chunk.
    const filler = "x".repeat(17 * 1024);
    const oversized = JSON.stringify({
      driver: "subprocess",
      filler,
    });
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      oversized,
    );
    expect(status).toBe(413);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
  });
});

describe("POST /settings — pushServiceBaseUrl HTTPS guard", () => {
  // pushServiceBaseUrl is the bridge callback origin embedded in the SW's
  // approveUrl/rejectUrl. If it can be set to plain http:// (or any private
  // host the operator didn't intend), the SW will POST the one-shot
  // approvalToken to that host. An attacker holding the dashboard bearer
  // could redirect every future approval token to attacker.tld and replay
  // them to the real bridge for silent auto-approve. Mirror the existing
  // pushServiceUrl HTTPS check.
  it("rejects http:// pushServiceBaseUrl with 400", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ pushServiceBaseUrl: "http://attacker.example.com" }),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      error: expect.stringContaining("HTTPS"),
    });
    expect(server!.pushServiceBaseUrl).toBeUndefined();
  });

  it("accepts https:// pushServiceBaseUrl and live-mutates the field", async () => {
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ pushServiceBaseUrl: "https://bridge.example.com" }),
    );
    expect(status).toBe(200);
    expect(server!.pushServiceBaseUrl).toBe("https://bridge.example.com");
  });

  it("treats empty-string pushServiceBaseUrl as a clear (no HTTPS check)", async () => {
    server!.pushServiceBaseUrl = "https://old.example.com";
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ pushServiceBaseUrl: "" }),
    );
    expect(status).toBe(200);
    expect(server!.pushServiceBaseUrl).toBeUndefined();
  });
});

describe("POST /settings — validate-before-write", () => {
  // Regression: previously the handler validated fields inline and persisted
  // each as it went, so a valid driver + invalid trailing field (ntfyTopic,
  // pushServiceBaseUrl, ntfyServer) returned 400 but had already written the
  // new driver to bridge config and the new approvalGate to live state.
  it("does not persist driver when a later field fails validation", async () => {
    const bridgeCfgPath = path.join(tempDir!, "bridge.json");
    writeFileSync(
      bridgeCfgPath,
      JSON.stringify({ driver: "subprocess" }, null, 2),
    );
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
      JSON.stringify({ driver: "gemini", ntfyTopic: "bad topic with spaces" }),
    );

    expect(status).toBe(400);
    const saved = JSON.parse(readFileSync(bridgeCfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(saved.driver).toBe("subprocess");
  });

  it("does not mutate live approvalGate when a later field fails validation", async () => {
    server!.approvalGate = "off";
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        approvalGate: "all",
        pushServiceBaseUrl: "http://insecure.example.com",
      }),
    );

    expect(status).toBe(400);
    expect(server!.approvalGate).toBe("off");
  });

  it("does not mutate enableTimeOfDayAnomaly when ntfyServer fails validation", async () => {
    server!.enableTimeOfDayAnomaly = false;
    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        enableTimeOfDayAnomaly: true,
        ntfyServer: "http://insecure.example.com",
      }),
    );

    expect(status).toBe(400);
    expect(server!.enableTimeOfDayAnomaly).toBe(false);
  });
});

describe("POST /settings — push/ntfy persistence", () => {
  // Regression: push/ntfy fields used to live only on server.* and were
  // lost on every bridge restart. They should now flow into the patchwork
  // config object passed to saveConfig (mocked) so a real install picks
  // them up on the next boot via src/config.ts's IIFE.
  it("persists pushServiceUrl + token to patchwork config", async () => {
    const pw = await import("../patchworkConfig.js");
    const saveSpy = vi.mocked(pw.saveConfig);
    saveSpy.mockClear();

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        pushServiceUrl: "https://relay.example.com",
        pushServiceToken: "tok_abc",
      }),
    );

    expect(status).toBe(200);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const persisted = saveSpy.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(persisted.pushServiceUrl).toBe("https://relay.example.com");
    expect(persisted.pushServiceToken).toBe("tok_abc");
  });

  it("persists ntfy fields to patchwork config", async () => {
    const pw = await import("../patchworkConfig.js");
    const saveSpy = vi.mocked(pw.saveConfig);
    saveSpy.mockClear();

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({
        ntfyTopic: "patchwork-oolabs-abc123",
        ntfyServer: "https://ntfy.example.com",
      }),
    );

    expect(status).toBe(200);
    const persisted = saveSpy.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(persisted.ntfyTopic).toBe("patchwork-oolabs-abc123");
    expect(persisted.ntfyServer).toBe("https://ntfy.example.com");
  });

  it("flags restartRequired when localEndpoint changes without model", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ localEndpoint: "http://localhost:8080" }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ restartRequired: true });
  });

  it("persists localEndpoint without requiring model in the same POST", async () => {
    const pw = await import("../patchworkConfig.js");
    const saveSpy = vi.mocked(pw.saveConfig);
    saveSpy.mockClear();

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ localEndpoint: "http://localhost:9090" }),
    );
    expect(status).toBe(200);
    const persisted = saveSpy.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(persisted.localEndpoint).toBe("http://localhost:9090");
  });

  it("does NOT flag restartRequired for pure push/ntfy edits (live-mutated)", async () => {
    const { status, body } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ ntfyTopic: "patchwork-test" }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ restartRequired: false });
  });

  it("persists pushServiceBaseUrl to patchwork config", async () => {
    const pw = await import("../patchworkConfig.js");
    const saveSpy = vi.mocked(pw.saveConfig);
    saveSpy.mockClear();

    const { status } = await makeRequest(
      {
        method: "POST",
        path: "/settings",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      JSON.stringify({ pushServiceBaseUrl: "https://bridge.example.com" }),
    );

    expect(status).toBe(200);
    const persisted = saveSpy.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(persisted.pushServiceBaseUrl).toBe("https://bridge.example.com");
  });
});
