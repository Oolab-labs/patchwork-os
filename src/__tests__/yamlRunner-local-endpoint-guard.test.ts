import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLoopbackOrPrivateEndpoint } from "../localEndpointGuard.js";

// Control what `loadConfig()` (dynamically imported inside defaultLocalFn)
// returns, so we can inject an attacker-controlled `localEndpoint`.
let mockLocalEndpoint: string | undefined;
vi.mock("../patchworkConfig.js", async () => {
  const actual = await vi.importActual<typeof import("../patchworkConfig.js")>(
    "../patchworkConfig.js",
  );
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ localEndpoint: mockLocalEndpoint })),
  };
});

// Spy on the adapter factory. If the guard is working, a public endpoint must
// short-circuit BEFORE the adapter is ever constructed (so no prompt is
// streamed out). For loopback endpoints the adapter IS constructed and we
// return a canned, network-free response.
const createLocalAdapterSpy = vi.fn(() => ({
  complete: vi.fn(async () => ({ text: "ok-from-local" })),
}));
vi.mock("../adapters/local.js", () => ({
  createLocalAdapter: createLocalAdapterSpy,
}));

import { defaultLocalFn } from "../recipes/yamlRunner.js";

describe("localEndpointGuard predicate", () => {
  it("accepts loopback / private hosts", () => {
    expect(isLoopbackOrPrivateEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://10.0.0.5:8000/v1")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://192.168.1.20:8080/v1")).toBe(
      true,
    );
  });

  it("rejects public hosts", () => {
    expect(isLoopbackOrPrivateEndpoint("https://evil.example.com/v1")).toBe(
      false,
    );
    expect(isLoopbackOrPrivateEndpoint("https://8.8.8.8/v1")).toBe(false);
  });
});

describe("defaultLocalFn anti-SSRF guard (call-site)", () => {
  let prevAllowRemote: string | undefined;

  beforeEach(() => {
    createLocalAdapterSpy.mockClear();
    prevAllowRemote = process.env.LOCAL_ENDPOINT_ALLOW_REMOTE;
    delete process.env.LOCAL_ENDPOINT_ALLOW_REMOTE;
    mockLocalEndpoint = undefined;
  });

  afterEach(() => {
    if (prevAllowRemote === undefined)
      delete process.env.LOCAL_ENDPOINT_ALLOW_REMOTE;
    else process.env.LOCAL_ENDPOINT_ALLOW_REMOTE = prevAllowRemote;
  });

  it("REJECTS a public localEndpoint when ALLOW_REMOTE is unset (no exfiltration)", async () => {
    mockLocalEndpoint = "https://evil.example.com/v1";

    const result = await defaultLocalFn("super secret prompt", "llama3");

    expect(result.text).toBe(
      "[agent step failed: localEndpoint is a public host; set LOCAL_ENDPOINT_ALLOW_REMOTE=1 to override]",
    );
    // Critical: the adapter must never be built, so the prompt is never
    // streamed to the public host.
    expect(createLocalAdapterSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS a loopback localEndpoint (adapter is built, request proceeds)", async () => {
    mockLocalEndpoint = "http://127.0.0.1:11434/v1";

    const result = await defaultLocalFn("hello", "llama3");

    expect(result.text).toBe("ok-from-local");
    expect(createLocalAdapterSpy).toHaveBeenCalledTimes(1);
    expect(createLocalAdapterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://127.0.0.1:11434/v1" }),
    );
  });

  it("ALLOWS a public localEndpoint when LOCAL_ENDPOINT_ALLOW_REMOTE=1 (explicit override)", async () => {
    process.env.LOCAL_ENDPOINT_ALLOW_REMOTE = "1";
    mockLocalEndpoint = "https://internal-cluster.example.com/v1";

    const result = await defaultLocalFn("hello", "llama3");

    expect(result.text).toBe("ok-from-local");
    expect(createLocalAdapterSpy).toHaveBeenCalledTimes(1);
  });
});
