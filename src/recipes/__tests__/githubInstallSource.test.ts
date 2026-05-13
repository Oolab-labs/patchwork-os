import { describe, expect, it } from "vitest";
import {
  buildGithubRawUrl,
  loadAllowlist,
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
});
