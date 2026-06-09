import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocalEmbedFn } from "../index.js";

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getLocalEmbedFn — registration-site wiring helper", () => {
  it("returns undefined when no endpoint is configured anywhere", () => {
    vi.stubEnv("LOCAL_EMBEDDINGS_ENDPOINT", "");
    vi.stubEnv("LOCAL_ENDPOINT", "");
    expect(getLocalEmbedFn()).toBeUndefined();
  });

  it("returns a bound embed fn when configured (falls back to LOCAL_ENDPOINT)", () => {
    vi.stubEnv("LOCAL_EMBEDDINGS_ENDPOINT", "");
    vi.stubEnv("LOCAL_ENDPOINT", "http://127.0.0.1:11434/v1");
    expect(typeof getLocalEmbedFn()).toBe("function");
  });

  it("the returned fn delegates to the provider without losing `this`", async () => {
    const fetchImpl = mockFetch({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    });
    const fn = getLocalEmbedFn({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      fetchImpl,
    });
    expect(fn).toBeDefined();
    await expect(fn?.(["a", "b"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("never throws — a public endpoint without allow-remote yields a fn that resolves to null", async () => {
    vi.stubEnv("LOCAL_ENDPOINT_ALLOW_REMOTE", "");
    const fetchImpl = mockFetch({ data: [] });
    const fn = getLocalEmbedFn({
      endpoint: "https://evil.example.com/v1",
      fetchImpl,
    });
    expect(typeof fn).toBe("function");
    await expect(fn?.(["x"])).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
