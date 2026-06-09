import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingsProvider } from "../index.js";
import { LocalEmbeddingsProvider } from "../localEmbeddings.js";

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

describe("LocalEmbeddingsProvider.embed — happy path", () => {
  it("returns the vectors and POSTs { model, input } to <endpoint>/embeddings", async () => {
    const fetchImpl = mockFetch({
      data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
    });
    const provider = new LocalEmbeddingsProvider({
      endpoint: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      fetchImpl,
    });

    const result = await provider.embed(["hello", "world"]);
    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);

    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    const call = mock.mock.calls[0] as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      model: "nomic-embed-text",
      input: ["hello", "world"],
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ollama",
    );
  });

  it("returns [] for an empty input without calling fetch", async () => {
    const fetchImpl = mockFetch({ data: [] });
    const provider = new LocalEmbeddingsProvider({
      endpoint: "http://127.0.0.1:1234/v1",
      fetchImpl,
    });
    const result = await provider.embed([]);
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("createEmbeddingsProvider factory", () => {
  it("returns null when no endpoint is configured (no env, no opts)", () => {
    vi.stubEnv("LOCAL_EMBEDDINGS_ENDPOINT", "");
    vi.stubEnv("LOCAL_ENDPOINT", "");
    // stubEnv("", "") sets empty string, not unset — clear explicitly.
    vi.stubEnv("LOCAL_EMBEDDINGS_ENDPOINT", undefined as unknown as string);
    vi.stubEnv("LOCAL_ENDPOINT", undefined as unknown as string);
    expect(createEmbeddingsProvider()).toBeNull();
  });

  it("returns a provider when an endpoint is given via opts", () => {
    expect(
      createEmbeddingsProvider({ endpoint: "http://localhost:11434/v1" }),
    ).toBeInstanceOf(LocalEmbeddingsProvider);
  });

  it("returns a provider when LOCAL_ENDPOINT env is set", () => {
    vi.stubEnv("LOCAL_ENDPOINT", "http://localhost:11434/v1");
    expect(createEmbeddingsProvider()).toBeInstanceOf(LocalEmbeddingsProvider);
  });
});

describe("SSRF guard", () => {
  it("returns null and does NOT call fetch for a public host (no override)", async () => {
    vi.stubEnv("LOCAL_ENDPOINT_ALLOW_REMOTE", undefined as unknown as string);
    const fetchImpl = mockFetch({ data: [{ embedding: [1, 2, 3] }] });
    const provider = new LocalEmbeddingsProvider({
      endpoint: "https://evil.example.com/v1",
      fetchImpl,
    });
    const result = await provider.embed(["secret prompt"]);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows the public host and calls fetch when LOCAL_ENDPOINT_ALLOW_REMOTE=1", async () => {
    vi.stubEnv("LOCAL_ENDPOINT_ALLOW_REMOTE", "1");
    const fetchImpl = mockFetch({ data: [{ embedding: [1, 2, 3] }] });
    const provider = new LocalEmbeddingsProvider({
      endpoint: "https://internal-cluster.example.com/v1",
      fetchImpl,
    });
    const result = await provider.embed(["prompt"]);
    expect(result).toEqual([[1, 2, 3]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("embed failure modes (fail-soft)", () => {
  it("returns null on non-ok HTTP status", async () => {
    const fetchImpl = mockFetch({ error: "boom" }, false, 500);
    const provider = new LocalEmbeddingsProvider({
      endpoint: "http://localhost:11434/v1",
      fetchImpl,
    });
    expect(await provider.embed(["x"])).toBeNull();
  });

  it("returns null when fetch throws (network error never propagates)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = new LocalEmbeddingsProvider({
      endpoint: "http://localhost:11434/v1",
      fetchImpl,
    });
    await expect(provider.embed(["x"])).resolves.toBeNull();
  });

  it("returns null on an unexpected response shape", async () => {
    const fetchImpl = mockFetch({ notData: true });
    const provider = new LocalEmbeddingsProvider({
      endpoint: "http://localhost:11434/v1",
      fetchImpl,
    });
    expect(await provider.embed(["x"])).toBeNull();
  });
});
