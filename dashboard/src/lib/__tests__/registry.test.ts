import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentsApiUrlFor,
  fetchBundleManifest,
  fetchGithubFile,
  fetchManifest,
  fetchRecipeYaml,
  fetchRegistry,
  githubBlobUrlFor,
  type ParsedInstallSource,
  rawUrlFor,
  shortName,
  summarizeRisk,
} from "@/lib/registry";

// parseInstallSource / assertValidInstallSource are covered by the
// dedicated installSourceValidation.test.ts. This file focuses on the
// pure helpers around URL building, risk summary, and display naming.

describe("rawUrlFor", () => {
  const base = "https://raw.githubusercontent.com";

  it("builds a raw.githubusercontent.com URL with owner/repo/ref/path/file", () => {
    expect(
      rawUrlFor(
        { owner: "patchworkos", repo: "recipes", path: "examples/hello", ref: "v1" },
        "recipe.yaml",
      ),
    ).toBe(`${base}/patchworkos/recipes/v1/examples/hello/recipe.yaml`);
  });

  it("omits the path segment when it's empty (root install)", () => {
    expect(
      rawUrlFor(
        { owner: "patchworkos", repo: "recipes", path: "", ref: "main" },
        "recipe.json",
      ),
    ).toBe(`${base}/patchworkos/recipes/main/recipe.json`);
  });

  it("omits the file segment when it's empty", () => {
    // Defensive — callers normally pass a filename, but the .filter(Boolean)
    // guard means we shouldn't emit a trailing slash if they don't.
    expect(
      rawUrlFor(
        { owner: "p", repo: "r", path: "sub", ref: "main" },
        "",
      ),
    ).toBe(`${base}/p/r/main/sub`);
  });
});

describe("githubBlobUrlFor", () => {
  it("builds a github.com/blob/<ref>/<path>/<file> URL", () => {
    expect(
      githubBlobUrlFor(
        { owner: "patchworkos", repo: "recipes", path: "examples/hello", ref: "v1" },
        "recipe.yaml",
      ),
    ).toBe("https://github.com/patchworkos/recipes/blob/v1/examples/hello/recipe.yaml");
  });

  it("collapses path/file when path is empty", () => {
    expect(
      githubBlobUrlFor(
        { owner: "p", repo: "r", path: "", ref: "main" },
        "recipe.json",
      ),
    ).toBe("https://github.com/p/r/blob/main/recipe.json");
  });

  it("collapses path/file when file is empty", () => {
    expect(
      githubBlobUrlFor(
        { owner: "p", repo: "r", path: "sub", ref: "main" },
        "",
      ),
    ).toBe("https://github.com/p/r/blob/main/sub");
  });
});

describe("summarizeRisk", () => {
  it("counts risk:low|medium|high occurrences and steps", () => {
    const yaml = `
steps:
  - id: a
    risk: low
  - id: b
    risk: medium
  - id: c
    risk: high
  - id: d
    risk: low
`;
    expect(summarizeRisk(yaml)).toEqual({ low: 2, medium: 1, high: 1, steps: 4 });
  });

  it("returns zeros for empty yaml", () => {
    expect(summarizeRisk("")).toEqual({ low: 0, medium: 0, high: 0, steps: 0 });
  });

  it("requires `risk:` to be at line start (ignoring leading whitespace)", () => {
    // Inline comment "risk: high" should NOT count.
    const yaml = `
steps:
  - id: a # this risk: high comment is not a real key
    risk: low
`;
    const got = summarizeRisk(yaml);
    expect(got.high).toBe(0);
    expect(got.low).toBe(1);
    expect(got.steps).toBe(1);
  });

  it("ignores unrecognised risk values (hyphenated suffix etc) under the parser-based impl", () => {
    // The old regex used `\b` and counted `risk: medium-aggressive` as
    // medium. The new parser-based impl uses strict equality and treats
    // anything outside {low, medium, high} as not-a-risk-level — much
    // better, since the registry's risk enum is exactly those three.
    const yaml = `steps:
  - id: a
    risk: medium-aggressive
  - id: b
    risk: medium
`;
    expect(summarizeRisk(yaml).medium).toBe(1);
  });

  it("counts every map entry under `steps:` as a step (matches YAML semantics, not the legacy `- id:` heuristic)", () => {
    // The pre-fix regex required `^- id:` rows. The parser sees every
    // array entry under `steps:` as a step regardless of which keys it
    // declares — closer to the recipe runtime's actual behaviour, where
    // an id-less step is still a step (it just gets an auto-id).
    const yaml = `steps:
  - id: real-step
    risk: low
  - name: also-a-step
    risk: high
`;
    expect(summarizeRisk(yaml)).toEqual({
      low: 1,
      medium: 0,
      high: 1,
      steps: 2,
    });
  });
});

describe("contentsApiUrlFor", () => {
  it("builds an api.github.com Contents URL with path/file and ref query", () => {
    expect(
      contentsApiUrlFor(
        { owner: "patchworkos", repo: "recipes", path: "examples/hello", ref: "v1" },
        "recipe.yaml",
      ),
    ).toBe(
      "https://api.github.com/repos/patchworkos/recipes/contents/examples/hello/recipe.yaml?ref=v1",
    );
  });

  it("omits the path segment when empty (root install)", () => {
    expect(
      contentsApiUrlFor(
        { owner: "patchworkos", repo: "recipes", path: "", ref: "main" },
        "index.json",
      ),
    ).toBe(
      "https://api.github.com/repos/patchworkos/recipes/contents/index.json?ref=main",
    );
  });
});

describe("fetchGithubFile + fallback", () => {
  const SRC: ParsedInstallSource = {
    owner: "patchworkos",
    repo: "recipes",
    path: "examples/hello",
    ref: "main",
  };
  const RAW = rawUrlFor(SRC, "recipe.yaml");
  const API = contentsApiUrlFor(SRC, "recipe.yaml");

  const okText = (body: string) =>
    ({ ok: true, text: async () => body, json: async () => JSON.parse(body) }) as Response;
  const notOk = () => ({ ok: false, text: async () => "", json: async () => ({}) }) as Response;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the raw URL directly when raw succeeds (no API call)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === RAW) return okText("name: from-raw");
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchGithubFile(SRC, "recipe.yaml");
    expect(text).toBe("name: from-raw");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(RAW, expect.anything());
  });

  it("falls back to the Contents API when raw throws a network error", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === RAW) throw new Error("ENOTFOUND raw.githubusercontent.com");
      if (url === API) return okText("name: from-api");
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchGithubFile(SRC, "recipe.yaml");
    expect(text).toBe("name: from-api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, API, expect.anything());
  });

  it("falls back to the Contents API when raw returns a non-ok response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === RAW) return notOk();
      if (url === API) return okText("name: from-api");
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchGithubFile(SRC, "recipe.yaml");
    expect(text).toBe("name: from-api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the Accept: application/vnd.github.raw header on the API fallback", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === RAW) return notOk();
      if (url === API) {
        expect((init?.headers as Record<string, string>)?.Accept).toBe(
          "application/vnd.github.raw",
        );
        return okText("ok");
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchGithubFile(SRC, "recipe.yaml")).toBe("ok");
  });

  it("returns null when both raw and the API fail", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network blocked");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchGithubFile(SRC, "recipe.yaml")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards an AbortSignal to both attempts", async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(ac.signal);
      throw new Error("blocked");
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchGithubFile(SRC, "recipe.yaml", { signal: ac.signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetch* functions use the fallback", () => {
  const SRC: ParsedInstallSource = {
    owner: "patchworkos",
    repo: "recipes",
    path: "examples/hello",
    ref: "main",
  };
  const INDEX_SRC: ParsedInstallSource = {
    owner: "patchworkos",
    repo: "recipes",
    path: "",
    ref: "main",
  };

  const okText = (body: string) => ({ ok: true, text: async () => body }) as Response;
  const notOk = () => ({ ok: false, text: async () => "" }) as Response;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchRegistry: raw blocked → API fallback returns parsed RegistryData", async () => {
    const rawUrl = rawUrlFor(INDEX_SRC, "index.json");
    const apiUrl = contentsApiUrlFor(INDEX_SRC, "index.json");
    const payload = JSON.stringify({
      version: "1",
      updated_at: "2026-05-20",
      recipes: [],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === rawUrl) throw new Error("raw blocked");
      if (url === apiUrl) return okText(payload);
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchRegistry();
    expect(data?.version).toBe("1");
    expect(data?.recipes).toEqual([]);
  });

  it("fetchRegistry: both endpoints fail → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("blocked");
      }),
    );
    expect(await fetchRegistry()).toBeNull();
  });

  it("fetchRegistry: raw returns invalid JSON → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okText("not json")),
    );
    expect(await fetchRegistry()).toBeNull();
  });

  it("fetchManifest: raw non-ok → API fallback returns parsed manifest", async () => {
    const rawUrl = rawUrlFor(SRC, "recipe.json");
    const apiUrl = contentsApiUrlFor(SRC, "recipe.json");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === rawUrl) return notOk();
      if (url === apiUrl)
        return okText(JSON.stringify({ name: "hello", version: "1.0.0" }));
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const manifest = await fetchManifest(SRC);
    expect(manifest?.name).toBe("hello");
  });

  it("fetchRecipeYaml: raw blocked → API fallback returns yaml text", async () => {
    const rawUrl = rawUrlFor(SRC, "main.yaml");
    const apiUrl = contentsApiUrlFor(SRC, "main.yaml");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === rawUrl) throw new Error("raw blocked");
      if (url === apiUrl) return okText("steps: []");
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchRecipeYaml(SRC, "main.yaml")).toBe("steps: []");
  });

  it("fetchRecipeYaml: both fail → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("blocked");
      }),
    );
    expect(await fetchRecipeYaml(SRC, "main.yaml")).toBeNull();
  });

  it("fetchBundleManifest: raw non-ok → API fallback returns parsed bundle", async () => {
    const rawUrl = rawUrlFor(SRC, "patchwork-bundle.json");
    const apiUrl = contentsApiUrlFor(SRC, "patchwork-bundle.json");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === rawUrl) return notOk();
      if (url === apiUrl)
        return okText(
          JSON.stringify({
            name: "@patchworkos/demo",
            version: "1.0.0",
            description: "d",
            tags: [],
            connectors: [],
            recipes: [],
          }),
        );
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bundle = await fetchBundleManifest(SRC);
    expect(bundle?.name).toBe("@patchworkos/demo");
  });

  it("fetchBundleManifest: both fail → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => notOk()),
    );
    expect(await fetchBundleManifest(SRC)).toBeNull();
  });
});

describe("shortName", () => {
  it("strips the @scope/ prefix from scoped names", () => {
    expect(shortName("@patchwork/code-review")).toBe("code-review");
  });

  it("returns unscoped names unchanged", () => {
    expect(shortName("code-review")).toBe("code-review");
  });

  it("only strips the leading scope, not later @ chars", () => {
    // Real-world: scoped name with an @-bearing path segment shouldn't be
    // collapsed past the first /.
    expect(shortName("@scope/foo@bar")).toBe("foo@bar");
  });

  it("returns empty string unchanged", () => {
    expect(shortName("")).toBe("");
  });
});
