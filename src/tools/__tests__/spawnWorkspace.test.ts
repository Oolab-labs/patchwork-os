import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthFetcher, SpawnFn } from "../spawnWorkspace.js";
import { createSpawnWorkspaceTool } from "../spawnWorkspace.js";

// ---- helpers ---------------------------------------------------------------

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

function makeChild(pid: number) {
  return { pid, unref: vi.fn() };
}

// ---- fixtures --------------------------------------------------------------

let tmpDir: string;
let lockDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-ws-test-"));
  lockDir = path.join(tmpDir, "ide");
  await fs.mkdir(lockDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---- tests -----------------------------------------------------------------

describe("createSpawnWorkspaceTool schema", () => {
  it("has correct name and required/outputSchema fields", () => {
    const { schema } = createSpawnWorkspaceTool();
    expect(schema.name).toBe("spawnWorkspace");
    expect(schema.inputSchema.required).toContain("path");
    expect(schema.outputSchema.required).toEqual(
      expect.arrayContaining([
        "pid",
        "port",
        "workspace",
        "authToken",
        "lockFile",
      ]),
    );
  });
});

describe("spawnWorkspace handler", () => {
  it("rejects missing path", async () => {
    const { handler } = createSpawnWorkspaceTool();
    const result = await handler({});
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("invalid_arg");
  });

  it("rejects empty string path", async () => {
    const { handler } = createSpawnWorkspaceTool();
    const result = await handler({ path: "   " });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("invalid_arg");
  });

  it("rejects path with null bytes", async () => {
    const { handler } = createSpawnWorkspaceTool();
    const result = await handler({ path: "/some/path\x00evil" });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("invalid_arg");
  });

  it("returns exec_failed when spawn gives no pid", async () => {
    const spawnFn: SpawnFn = () => ({
      pid: undefined as unknown as number,
      unref: vi.fn(),
    });
    const { handler } = createSpawnWorkspaceTool(spawnFn);
    const result = await handler({ path: tmpDir });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("exec_failed");
  });

  it("returns exec_failed when spawn throws", async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error("ENOENT: spawn failed");
    };
    const { handler } = createSpawnWorkspaceTool(spawnFn);
    const result = await handler({ path: tmpDir });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("exec_failed");
  });

  it("returns timeout when no lock file appears", async () => {
    const child = makeChild(99999);
    const spawnFn: SpawnFn = () => child;
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const { handler } = createSpawnWorkspaceTool(spawnFn);
    const result = await handler({ path: tmpDir, timeoutMs: 600 });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("timeout");
    expect(child.unref).toHaveBeenCalled();
  });

  it("returns structured result when lock file appears", async () => {
    const pid = 55555;
    const child = makeChild(pid);
    const spawnFn: SpawnFn = () => child;

    const lockContents = {
      pid,
      workspace: tmpDir,
      authToken: "tok-abc123",
      isBridge: true,
      port: 4444,
    };
    const lockPath = path.join(lockDir, `${pid}.lock`);

    // Write the lock file after a short delay to simulate bridge startup
    setTimeout(() => {
      fs.writeFile(lockPath, JSON.stringify(lockContents)).catch(() => {});
    }, 200);

    const { handler } = createSpawnWorkspaceTool(spawnFn);
    const result = await handler({ path: tmpDir, timeoutMs: 3000 });

    expect(result).not.toMatchObject({ isError: true });
    const data = parseText(result);
    expect(data).toMatchObject({
      pid,
      port: 4444,
      workspace: tmpDir,
      authToken: "tok-abc123",
      lockFile: lockPath,
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it("passes port and fixed-token to spawn args", async () => {
    const capturedArgs: string[] = [];
    const spawnFn: SpawnFn = (_cmd, args) => {
      capturedArgs.push(...args);
      return makeChild(77777);
    };
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const { handler } = createSpawnWorkspaceTool(spawnFn);
    await handler({
      path: tmpDir,
      port: 9999,
      token: "my-token",
      timeoutMs: 300,
    });

    expect(capturedArgs).toContain("--port");
    expect(capturedArgs).toContain("9999");
    expect(capturedArgs).toContain("--fixed-token");
    expect(capturedArgs).toContain("my-token");
    expect(capturedArgs).toContain("--workspace");
    expect(capturedArgs).toContain(tmpDir);
  });

  it("waitForExtension: returns extensionConnected:true when /health reports connected", async () => {
    const pid = 88888;
    const child = makeChild(pid);
    const spawnFn: SpawnFn = () => child;

    const lockContents = {
      pid,
      workspace: tmpDir,
      authToken: "tok-ext-ok",
      isBridge: true,
      port: 5050,
    };
    const lockPath = path.join(lockDir, `${pid}.lock`);
    setTimeout(() => {
      fs.writeFile(lockPath, JSON.stringify(lockContents)).catch(() => {});
    }, 100);

    const healthCalls: Array<{ url: string; token: string }> = [];
    let callCount = 0;
    const healthFetcher: HealthFetcher = async (url, token) => {
      healthCalls.push({ url, token });
      callCount += 1;
      // First poll: not yet connected. Second: connected.
      return { extensionConnected: callCount >= 2 };
    };

    const { handler } = createSpawnWorkspaceTool(spawnFn, healthFetcher);
    const result = await handler({
      path: tmpDir,
      timeoutMs: 3000,
      waitForExtension: true,
    });

    expect(result).not.toMatchObject({ isError: true });
    const data = parseText(result);
    expect(data).toMatchObject({
      pid,
      port: 5050,
      authToken: "tok-ext-ok",
      extensionConnected: true,
    });
    expect(healthCalls[0]?.url).toBe("http://127.0.0.1:5050/health");
    expect(healthCalls[0]?.token).toBe("tok-ext-ok");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("waitForExtension: times out and kills child when extension never connects", async () => {
    const pid = 88889;
    const child = makeChild(pid);
    const spawnFn: SpawnFn = () => child;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const lockContents = {
      pid,
      workspace: tmpDir,
      authToken: "tok-ext-fail",
      isBridge: true,
      port: 5151,
    };
    const lockPath = path.join(lockDir, `${pid}.lock`);
    await fs.writeFile(lockPath, JSON.stringify(lockContents));

    const healthFetcher: HealthFetcher = async () => ({
      extensionConnected: false,
    });

    const { handler } = createSpawnWorkspaceTool(spawnFn, healthFetcher);
    const result = await handler({
      path: tmpDir,
      timeoutMs: 800,
      waitForExtension: true,
    });

    expect(result).toMatchObject({ isError: true });
    const parsed = parseText(result);
    expect(parsed.code).toBe("timeout");
    expect(parsed.error).toMatch(/extension did not connect/);
    expect(killSpy).toHaveBeenCalledWith(pid, "SIGTERM");
  });

  it("waitForExtension unset: returns without extensionConnected field (back-compat)", async () => {
    const pid = 88890;
    const child = makeChild(pid);
    const spawnFn: SpawnFn = () => child;

    const lockContents = {
      pid,
      workspace: tmpDir,
      authToken: "tok-bc",
      isBridge: true,
      port: 5252,
    };
    const lockPath = path.join(lockDir, `${pid}.lock`);
    await fs.writeFile(lockPath, JSON.stringify(lockContents));

    const healthFetcher: HealthFetcher = vi.fn(async () => ({
      extensionConnected: true,
    }));

    const { handler } = createSpawnWorkspaceTool(spawnFn, healthFetcher);
    const result = await handler({ path: tmpDir, timeoutMs: 3000 });

    expect(result).not.toMatchObject({ isError: true });
    const data = parseText(result);
    expect(data.extensionConnected).toBeUndefined();
    // Health endpoint must NOT be polled when waitForExtension is false/unset.
    expect(healthFetcher).not.toHaveBeenCalled();
  });

  it("skips non-bridge lock files (isBridge: false)", async () => {
    const pid = 66666;
    const child = makeChild(pid);
    const spawnFn: SpawnFn = () => child;
    vi.spyOn(process, "kill").mockImplementation(() => true);

    // Write a lock with isBridge:false — should be ignored
    const decoyPath = path.join(lockDir, `${pid}.lock`);
    await fs.writeFile(
      decoyPath,
      JSON.stringify({
        pid,
        workspace: tmpDir,
        authToken: "x",
        isBridge: false,
        port: 1,
      }),
    );

    const { handler } = createSpawnWorkspaceTool(spawnFn);
    const result = await handler({ path: tmpDir, timeoutMs: 700 });
    expect(result).toMatchObject({ isError: true });
    expect(parseText(result).code).toBe("timeout");
  });
});
