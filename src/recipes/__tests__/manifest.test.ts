import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getManifestRecipeFiles,
  loadManifestFromDir,
  parseManifest,
  validateManifest,
} from "../manifest.js";

const VALID_MANIFEST = {
  name: "morning-brief",
  version: "1.0.0",
  description: "Daily morning briefing recipe",
  author: "Acme Corp",
  license: "MIT",
  tags: ["productivity", "morning"],
  connectors: ["gmail", "slack"],
  recipes: {
    main: "morning-brief.yaml",
    children: ["followup-child.yaml"],
  },
  variables: {
    SLACK_CHANNEL: {
      description: "Slack channel to post the brief",
      required: false,
      default: "#general",
    },
  },
  homepage: "https://github.com/acme/morning-brief",
};

// ── parseManifest ────────────────────────────────────────────────────────────

describe("parseManifest", () => {
  it("returns typed object for valid manifest", () => {
    const result = parseManifest(JSON.stringify(VALID_MANIFEST));
    expect(result.name).toBe("morning-brief");
    expect(result.version).toBe("1.0.0");
    expect(result.description).toBe("Daily morning briefing recipe");
    expect(result.recipes.main).toBe("morning-brief.yaml");
    expect(result.recipes.children).toEqual(["followup-child.yaml"]);
    expect(result.tags).toEqual(["productivity", "morning"]);
    expect(result.connectors).toEqual(["gmail", "slack"]);
    expect(result.variables?.SLACK_CHANNEL?.description).toBe(
      "Slack channel to post the brief",
    );
  });

  it("accepts scoped package names", () => {
    const m = { ...VALID_MANIFEST, name: "@acme/morning-brief" };
    const result = parseManifest(JSON.stringify(m));
    expect(result.name).toBe("@acme/morning-brief");
  });

  it("throws for missing name", () => {
    const { name: _n, ...rest } = VALID_MANIFEST;
    expect(() => parseManifest(JSON.stringify(rest))).toThrow(/name/);
  });

  it("throws for invalid name format (uppercase)", () => {
    const m = { ...VALID_MANIFEST, name: "Morning-Brief" };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/name/);
  });

  it("throws for invalid name format (leading dash)", () => {
    const m = { ...VALID_MANIFEST, name: "-bad" };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/name/);
  });

  it("throws for missing version", () => {
    const { version: _v, ...rest } = VALID_MANIFEST;
    expect(() => parseManifest(JSON.stringify(rest))).toThrow(/version/);
  });

  it("throws for invalid version (not semver)", () => {
    const m = { ...VALID_MANIFEST, version: "latest" };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/version/);
  });

  it("throws for invalid version (missing patch)", () => {
    const m = { ...VALID_MANIFEST, version: "1.0" };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/version/);
  });

  it("throws for main recipe with no .yaml extension", () => {
    const m = {
      ...VALID_MANIFEST,
      recipes: { main: "morning-brief.txt" },
    };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/recipes\.main/);
  });

  it("throws for child recipe with no .yaml extension", () => {
    const m = {
      ...VALID_MANIFEST,
      recipes: { main: "morning-brief.yaml", children: ["bad-child.json"] },
    };
    expect(() => parseManifest(JSON.stringify(m))).toThrow(/recipes\.children/);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseManifest("{not valid json")).toThrow(/invalid JSON/);
  });

  it("accepts .yml extension for main recipe", () => {
    const m = { ...VALID_MANIFEST, recipes: { main: "brief.yml" } };
    const result = parseManifest(JSON.stringify(m));
    expect(result.recipes.main).toBe("brief.yml");
  });
});

// ── validateManifest ─────────────────────────────────────────────────────────

describe("validateManifest", () => {
  it("ignores unknown extra fields (additivity)", () => {
    const withExtra = {
      ...VALID_MANIFEST,
      someFutureField: "ignored",
      nested: { also: "ignored" },
    };
    // should not throw
    const result = validateManifest(withExtra);
    expect(result.name).toBe("morning-brief");
  });

  it("throws when manifest is not an object", () => {
    expect(() => validateManifest("a string")).toThrow(/JSON object/);
    expect(() => validateManifest(42)).toThrow(/JSON object/);
    expect(() => validateManifest(null)).toThrow(/JSON object/);
  });
});

// ── getManifestRecipeFiles ───────────────────────────────────────────────────

describe("getManifestRecipeFiles", () => {
  it("returns [main] when no children declared", () => {
    const m = { ...VALID_MANIFEST, recipes: { main: "brief.yaml" } };
    const manifest = validateManifest(m);
    expect(getManifestRecipeFiles(manifest)).toEqual(["brief.yaml"]);
  });

  it("returns [main, ...children] in correct order", () => {
    const manifest = validateManifest(VALID_MANIFEST);
    expect(getManifestRecipeFiles(manifest)).toEqual([
      "morning-brief.yaml",
      "followup-child.yaml",
    ]);
  });

  it("returns [main, child1, child2] preserving order for multiple children", () => {
    const m = {
      ...VALID_MANIFEST,
      recipes: {
        main: "main.yaml",
        children: ["child-a.yaml", "child-b.yaml", "child-c.yml"],
      },
    };
    const manifest = validateManifest(m);
    expect(getManifestRecipeFiles(manifest)).toEqual([
      "main.yaml",
      "child-a.yaml",
      "child-b.yaml",
      "child-c.yml",
    ]);
  });
});

// ── loadManifestFromDir ──────────────────────────────────────────────────────

describe("loadManifestFromDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // cleanup is best-effort
    try {
      const { rmSync } = require("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns null for non-existent directory", () => {
    const result = loadManifestFromDir(path.join(tmpDir, "does-not-exist"));
    expect(result).toBeNull();
  });

  it("returns null for directory without recipe.json", () => {
    const result = loadManifestFromDir(tmpDir);
    expect(result).toBeNull();
  });

  it("parses and returns manifest from directory", () => {
    writeFileSync(
      path.join(tmpDir, "recipe.json"),
      JSON.stringify(VALID_MANIFEST),
      "utf-8",
    );
    const result = loadManifestFromDir(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("morning-brief");
    expect(result?.recipes.main).toBe("morning-brief.yaml");
  });

  it("throws for invalid recipe.json in existing directory", () => {
    writeFileSync(
      path.join(tmpDir, "recipe.json"),
      JSON.stringify({
        name: "Bad Name With Spaces",
        version: "1.0.0",
        description: "test",
        recipes: { main: "x.yaml" },
      }),
      "utf-8",
    );
    expect(() => loadManifestFromDir(tmpDir)).toThrow(/name/);
  });
});
