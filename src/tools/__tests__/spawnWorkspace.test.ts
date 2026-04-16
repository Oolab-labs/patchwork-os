import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../spawnWorkspace.js";
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
