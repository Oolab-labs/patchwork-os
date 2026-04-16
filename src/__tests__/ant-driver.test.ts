/**
 * Unit tests for ant binary support in SubprocessDriver and config parsing.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock child_process ─────────────────────────────────────────────────────

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.emit("close", 0);
    return true;
  });
}

let mockChild: MockChild;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      mockChild = new MockChild();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      (mockChild.stdout as any).setEncoding = vi.fn();
      (mockChild.stderr as any).setEncoding = vi.fn();
      return mockChild;
    }),
  };
});

import { spawn } from "node:child_process";
import { createDriver, SubprocessDriver } from "../claudeDriver.js";
import { parseConfig } from "../config.js";

const spawnMock = vi.mocked(spawn);

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeInput(
  overrides: Partial<Parameters<SubprocessDriver["run"]>[0]> = {},
) {
  return {
    prompt: "hello",
    workspace: "/tmp/test",
    timeoutMs: 5000,
    signal: makeSignal(),
    ...overrides,
  };
}

function closeChild(code = 0) {
  mockChild.stdout.emit(
    "data",
    `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`,
  );
  mockChild.emit("close", code);
}

// ── SubprocessDriver ant binary tests ─────────────────────────────────────

describe("SubprocessDriver — ant binary", () => {
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses claude binary when useAnt is false/undefined", async () => {
    const driver = new SubprocessDriver("claude", "ant", log);
    const runPromise = driver.run(makeInput());
    await new Promise<void>((r) => setTimeout(r, 0));
    closeChild();
    await runPromise;
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
  });

  it("uses ant binary when useAnt is true", async () => {
    const driver = new SubprocessDriver("claude", "/usr/local/bin/ant", log);
    const runPromise = driver.run(makeInput({ useAnt: true }));
    await new Promise<void>((r) => setTimeout(r, 0));
    closeChild();
    await runPromise;
    expect(spawnMock.mock.calls[0]![0]).toBe("/usr/local/bin/ant");
  });

  it("uses claude binary when useAnt is explicitly false", async () => {
    const driver = new SubprocessDriver("claude", "ant", log);
    const runPromise = driver.run(makeInput({ useAnt: false }));
    await new Promise<void>((r) => setTimeout(r, 0));
    closeChild();
    await runPromise;
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
  });

  it("uses claude binary when useAnt is undefined", async () => {
    const driver = new SubprocessDriver("claude", "ant", log);
    const runPromise = driver.run(makeInput({ useAnt: undefined }));
    await new Promise<void>((r) => setTimeout(r, 0));
    closeChild();
    await runPromise;
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
  });
});

// ── createDriver factory ───────────────────────────────────────────────────

describe("createDriver — antBinary parameter", () => {
  const log = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it("passes antBinary through to SubprocessDriver", async () => {
    const driver = createDriver("subprocess", "claude", "/opt/ant", log);
    expect(driver).toBeInstanceOf(SubprocessDriver);

    const runPromise = driver!.run(makeInput({ useAnt: true }));
    await new Promise<void>((r) => setTimeout(r, 0));
    closeChild();
    await runPromise;
    expect(spawnMock.mock.calls[0]![0]).toBe("/opt/ant");
  });

  it("returns null for mode 'none' (antBinary ignored)", () => {
    const driver = createDriver("none", "claude", "ant", log);
    expect(driver).toBeNull();
  });
});

// ── Config parsing ─────────────────────────────────────────────────────────

describe("parseConfig — --ant-binary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults antBinary to 'ant'", () => {
    const config = parseConfig(["node", "bridge"]);
    expect(config.antBinary).toBe("ant");
  });

  it("parses --ant-binary flag", () => {
    const config = parseConfig([
      "node",
      "bridge",
      "--ant-binary",
      "/usr/local/bin/ant",
    ]);
    expect(config.antBinary).toBe("/usr/local/bin/ant");
  });

  it("throws on --ant-binary with missing value", () => {
    expect(() => parseConfig(["node", "bridge", "--ant-binary"])).toThrow();
  });
});
