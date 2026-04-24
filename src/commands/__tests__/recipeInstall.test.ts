import { describe, expect, it } from "vitest";
import type { RecipeManifest } from "../../recipes/manifest.js";
import { determineInstallName, parseInstallSource } from "../recipeInstall.js";

// ============================================================================
// parseInstallSource
// ============================================================================

describe("parseInstallSource", () => {
  describe("github shorthand", () => {
    it("parses github:user/repo", () => {
      const result = parseInstallSource("github:user/repo");
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
      });
    });

    it("parses github:user/repo/subdir", () => {
      const result = parseInstallSource("github:user/repo/subdir");
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
        subdir: "subdir",
      });
    });

    it("parses github:user/repo/nested/subdir", () => {
      const result = parseInstallSource("github:user/repo/nested/subdir");
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
        subdir: "nested/subdir",
      });
    });

    it("parses official registry shorthand", () => {
      const result = parseInstallSource(
        "github:patchworkos/recipes/morning-brief",
      );
      expect(result).toEqual({
        type: "github",
        owner: "patchworkos",
        repo: "recipes",
        subdir: "morning-brief",
      });
    });

    it("throws when only owner given", () => {
      expect(() => parseInstallSource("github:just-owner")).toThrow();
    });
  });

  describe("full GitHub URL", () => {
    it("parses plain https://github.com/user/repo", () => {
      const result = parseInstallSource("https://github.com/user/repo");
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
      });
    });

    it("parses URL with tree/branch/subdir", () => {
      const result = parseInstallSource(
        "https://github.com/user/repo/tree/main/subdir",
      );
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
        subdir: "subdir",
      });
    });

    it("handles .git suffix", () => {
      const result = parseInstallSource("https://github.com/user/repo.git");
      expect(result).toEqual({
        type: "github",
        owner: "user",
        repo: "repo",
      });
    });
  });

  describe("local paths", () => {
    it("parses ./relative/path", () => {
      const result = parseInstallSource("./local/path");
      expect(result).toEqual({ type: "local", path: "./local/path" });
    });

    it("parses ../relative/path", () => {
      const result = parseInstallSource("../sibling/path");
      expect(result).toEqual({ type: "local", path: "../sibling/path" });
    });

    it("parses /absolute/path", () => {
      const result = parseInstallSource("/absolute/path");
      expect(result).toEqual({ type: "local", path: "/absolute/path" });
    });
  });

  describe("invalid sources", () => {
    it("throws on unrecognized format", () => {
      expect(() => parseInstallSource("not-a-valid-source")).toThrow(
        /Unrecognized install source/,
      );
    });

    it("throws on npm-style package name", () => {
      expect(() => parseInstallSource("@scope/package")).toThrow(
        /Unrecognized install source/,
      );
    });
  });
});

// ============================================================================
// determineInstallName
// ============================================================================

describe("determineInstallName", () => {
  const githubSource = {
    type: "github" as const,
    owner: "user",
    repo: "repo",
  };

  const githubSourceWithSubdir = {
    type: "github" as const,
    owner: "user",
    repo: "repo",
    subdir: "morning-brief",
  };

  const localSource = {
    type: "local" as const,
    path: "/some/path/my-recipe",
  };

  function makeManifest(name: string): RecipeManifest {
    return {
      name,
      version: "1.0.0",
      description: "test",
      recipes: { main: "main.yaml" },
    };
  }

  it("uses manifest name when available", () => {
    const manifest = makeManifest("morning-brief");
    expect(determineInstallName(manifest, githubSource)).toBe("morning-brief");
  });

  it("strips @ prefix from scoped manifest name", () => {
    const manifest = makeManifest("@acme/morning-brief");
    expect(determineInstallName(manifest, githubSource)).toBe(
      "acme--morning-brief",
    );
  });

  it("falls back to owner/repo for github source without manifest", () => {
    expect(determineInstallName(null, githubSource)).toBe("user/repo");
  });

  it("includes subdir in fallback for github source with subdir", () => {
    expect(determineInstallName(null, githubSourceWithSubdir)).toBe(
      "user/repo/morning-brief",
    );
  });

  it("uses directory basename for local source without manifest", () => {
    expect(determineInstallName(null, localSource)).toBe("my-recipe");
  });
});
