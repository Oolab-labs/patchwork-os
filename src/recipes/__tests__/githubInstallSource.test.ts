import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGithubApiUrl,
  buildGithubRawUrl,
  fetchGithubInstallFile,
  loadAllowlist,
  type ParsedGithubInstallSource,
  parseGithubInstallSource,
} from "../githubInstallSource.js";

describe("loadAllowlist", () => {
  it("always includes the default 'patchworkos/recipes'", () => {
    expect(loadAllowlist({})).toEqual(["patchworkos/recipes"]);
  });

  it("merges entries from PATCHWORK_RECIPE_REPO_ALLOWLIST", () => {
    expect(
      loadAllowlist({
        PATCHWORK_RECIPE_REPO_ALLOWLIST: "acme/recipes,oolab-labs/cookbook",
      }),
    ).toEqual(["patchworkos/recipes", "acme/recipes", "oolab-labs/cookbook"]);
  });

  it("lowercases entries (GitHub is case-insensitive)", () => {
    expect(
      loadAllowlist({ PATCHWORK_RECIPE_REPO_ALLOWLIST: "AcMe/Recipes" }),
    ).toEqual(["patchworkos/recipes", "acme/recipes"]);
  });

  it("drops empty + whitespace-only fragments", () => {
    expect(
      loadAllowlist({
        PATCHWORK_RECIPE_REPO_ALLOWLIST: " , , acme/recipes , ,,",
      }),
    ).toEqual(["patchworkos/recipes", "acme/recipes"]);
  });

  it("drops fragments that don't look like owner/repo", () => {
    expect(
      loadAllowlist({
        PATCHWORK_RECIPE_REPO_ALLOWLIST: "no-slash,acme/ok,trailing/",
      }),
    ).toEqual(["patchworkos/recipes", "acme/ok", "trailing/"]);
    // Note: "trailing/" has the slash so it passes the includes-/ check
    // here, but `parseGithubInstallSource` will reject it later because
    // the empty repo segment fails SEGMENT_RE. Belt + suspenders.
  });

  it("de-duplicates", () => {
    expect(
      loadAllowlist({
        PATCHWORK_RECIPE_REPO_ALLOWLIST:
          "patchworkos/recipes,patchworkos/recipes",
      }),
    ).toEqual(["patchworkos/recipes"]);
  });
});

describe("parseGithubInstallSource", () => {
  it("parses the canonical patchworkos recipe shape", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief",
    );
    expect(result).toEqual({
      ok: true,
      parsed: {
        kind: "recipe",
        owner: "patchworkos",
        repo: "recipes",
        name: "morning-brief",
      },
    });
  });

  it("parses the bundle shape", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/bundles/ops-pack",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.kind).toBe("bundle");
      expect(result.parsed.name).toBe("ops-pack");
    }
  });

  it("accepts third-party orgs that are explicitly allowlisted", () => {
    const result = parseGithubInstallSource(
      "github:acme/cookbook/recipes/incident-pager",
      ["patchworkos/recipes", "acme/cookbook"],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.owner).toBe("acme");
      expect(result.parsed.repo).toBe("cookbook");
    }
  });

  it("rejects orgs not on the allowlist with not_allowlisted", () => {
    const result = parseGithubInstallSource(
      "github:evil-corp/recipes/recipes/backdoor",
    );
    expect(result).toEqual({
      ok: false,
      code: "not_allowlisted",
      error: expect.stringContaining("evil-corp/recipes"),
    });
  });

  it("rejects missing 'github:' prefix with bad_shape", () => {
    const result = parseGithubInstallSource("patchworkos/recipes/recipes/foo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_shape");
  });

  it("rejects sources with too few / too many segments", () => {
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo/extra")
        .ok,
    ).toBe(false);
  });

  it("rejects 'recipes' vs 'bundles' typos with bad_shape", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/cookbook/foo",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_shape");
  });

  it("rejects traversal in owner / repo / name with bad_segment", () => {
    expect(parseGithubInstallSource("github:../etc/recipes/passwd").ok).toBe(
      false,
    );
    expect(
      parseGithubInstallSource("github:patchworkos/.../recipes/foo").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/../etc").ok,
    ).toBe(false);
    // L7: pure ".." name segment was accepted by old regex ([a-z0-9_.-]{1,100})
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/..").ok,
    ).toBe(false);
    // Double-dot within a name (e.g. "a..b") is also rejected
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/a..b").ok,
    ).toBe(false);
    // Single dot in a name is still allowed
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/a.b").ok,
    ).toBe(true);
  });

  it("rejects empty segments", () => {
    expect(parseGithubInstallSource("github:patchworkos//recipes/foo").ok).toBe(
      false,
    );
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/").ok,
    ).toBe(false);
  });

  it("rejects oversized segments (DoS guard)", () => {
    const big = "a".repeat(150);
    expect(
      parseGithubInstallSource(`github:${big}/recipes/recipes/foo`).ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource(`github:patchworkos/recipes/recipes/${big}`).ok,
    ).toBe(false);
  });

  it("matches allowlist case-insensitively", () => {
    expect(
      parseGithubInstallSource(
        "github:PatchworkOS/Recipes/recipes/morning-brief",
      ).ok,
    ).toBe(true);
  });

  it("extracts a trailing @ref from the name segment", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief@v1.2.0",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.name).toBe("morning-brief");
      expect(result.parsed.ref).toBe("v1.2.0");
    }
  });

  it("leaves ref undefined when no @ref is present", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.ref).toBeUndefined();
    }
  });

  it("preserves ref case (refs are not lowercased)", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief@Release-2.0",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.ref).toBe("Release-2.0");
    }
  });

  it("accepts a commit SHA as a ref", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief@abc123def456",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.ref).toBe("abc123def456");
    }
  });

  it("rejects an empty ref (trailing @)", () => {
    const result = parseGithubInstallSource(
      "github:patchworkos/recipes/recipes/morning-brief@",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_segment");
  });

  it("rejects refs with disallowed characters", () => {
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo@a:b").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo@a?b").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo@a#b").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo@a b").ok,
    ).toBe(false);
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/foo@a..b")
        .ok,
    ).toBe(false);
  });

  it("still validates the name segment after stripping the ref", () => {
    // name ".." is invalid even with a valid ref
    expect(
      parseGithubInstallSource("github:patchworkos/recipes/recipes/..@v1.0.0")
        .ok,
    ).toBe(false);
  });
});

describe("buildGithubRawUrl", () => {
  it("constructs the recipe YAML URL", () => {
    expect(
      buildGithubRawUrl({
        kind: "recipe",
        owner: "patchworkos",
        repo: "recipes",
        name: "morning-brief",
      }),
    ).toBe(
      "https://raw.githubusercontent.com/patchworkos/recipes/main/recipes/morning-brief/morning-brief.yaml",
    );
  });

  it("constructs the bundle manifest URL", () => {
    expect(
      buildGithubRawUrl({
        kind: "bundle",
        owner: "acme",
        repo: "cookbook",
        name: "ops-pack",
      }),
    ).toBe(
      "https://raw.githubusercontent.com/acme/cookbook/main/bundles/ops-pack/patchwork-bundle.json",
    );
  });

  it("uses the pinned ref instead of 'main' when present", () => {
    expect(
      buildGithubRawUrl({
        kind: "recipe",
        owner: "patchworkos",
        repo: "recipes",
        name: "morning-brief",
        ref: "v1.2.0",
      }),
    ).toBe(
      "https://raw.githubusercontent.com/patchworkos/recipes/v1.2.0/recipes/morning-brief/morning-brief.yaml",
    );
  });
});

describe("buildGithubApiUrl", () => {
  it("constructs the Contents-API recipe URL", () => {
    expect(
      buildGithubApiUrl({
        kind: "recipe",
        owner: "patchworkos",
        repo: "recipes",
        name: "morning-brief",
      }),
    ).toBe(
      "https://api.github.com/repos/patchworkos/recipes/contents/recipes/morning-brief/morning-brief.yaml?ref=main",
    );
  });

  it("constructs the Contents-API bundle URL", () => {
    expect(
      buildGithubApiUrl({
        kind: "bundle",
        owner: "acme",
        repo: "cookbook",
        name: "ops-pack",
      }),
    ).toBe(
      "https://api.github.com/repos/acme/cookbook/contents/bundles/ops-pack/patchwork-bundle.json?ref=main",
    );
  });

  it("uses the pinned ref in the ?ref= query when present", () => {
    expect(
      buildGithubApiUrl({
        kind: "recipe",
        owner: "patchworkos",
        repo: "recipes",
        name: "morning-brief",
        ref: "v1.2.0",
      }),
    ).toBe(
      "https://api.github.com/repos/patchworkos/recipes/contents/recipes/morning-brief/morning-brief.yaml?ref=v1.2.0",
    );
  });
});

describe("fetchGithubInstallFile — raw-first, api.github.com fallback", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const parsed: ParsedGithubInstallSource = {
    kind: "recipe",
    owner: "patchworkos",
    repo: "recipes",
    name: "morning-brief",
  };
  const rawUrl =
    "https://raw.githubusercontent.com/patchworkos/recipes/main/recipes/morning-brief/morning-brief.yaml";
  const apiUrl =
    "https://api.github.com/repos/patchworkos/recipes/contents/recipes/morning-brief/morning-brief.yaml?ref=main";

  it("uses raw when raw responds ok — no API call made", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("name: morning-brief", { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await result.response.text()).toBe("name: morning-brief");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(rawUrl);
  });

  it("falls back to api.github.com when raw throws a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: ENOTFOUND"))
      .mockResolvedValueOnce(new Response("name: from-api", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await result.response.text()).toBe("name: from-api");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(rawUrl);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(apiUrl);
    // Fallback sends the raw-bytes Accept header.
    const apiInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((apiInit.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github.raw",
    );
  });

  it("falls back to api.github.com when raw responds non-ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("blocked", { status: 503 }))
      .mockResolvedValueOnce(new Response("name: from-api", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await result.response.text()).toBe("name: from-api");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces network_error when BOTH raw and api throw", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("raw blocked"))
      .mockRejectedValueOnce(new TypeError("api blocked"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network_error");
    }
  });

  it("surfaces not_found when both hosts return 404 (genuine missing recipe)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_found");
      if (result.kind === "not_found") {
        expect(result.response.status).toBe(404);
      }
    }
  });

  it("surfaces upstream_error when raw 404s but api returns a non-404 failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("upstream_error");
      if (result.kind === "upstream_error") {
        expect(result.response.status).toBe(403);
      }
    }
  });

  it("treats a raw 404 as not_found when the api also throws a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockRejectedValueOnce(new TypeError("api blocked"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchGithubInstallFile(parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_found");
    }
  });

  it("forwards the abort signal to both fetch attempts", async () => {
    const ctl = new AbortController();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("raw blocked"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchGithubInstallFile(parsed, { signal: ctl.signal });
    const rawInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const apiInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(rawInit.signal).toBe(ctl.signal);
    expect(apiInit.signal).toBe(ctl.signal);
  });
});
