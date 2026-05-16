import { describe, expect, it } from "vitest";
import {
  buildGithubCreateFileUrl,
  buildManifestJson,
  extractYamlName,
  installSourceFor,
  normalizeAuthor,
  normalizeSlug,
  recipeJsonPath,
  recipeYamlPath,
  REGISTRY_BRANCH,
  REGISTRY_OWNER,
  REGISTRY_REPO,
  RECIPE_PRESETS,
  STARTER_RECIPE_YAML,
  type SubmissionFormData,
  validateSubmission,
} from "@/lib/marketplaceSubmit";

const baseForm: SubmissionFormData = {
  slug: "my-recipe",
  author: "myhandle",
  version: "1.0.0",
  description: "Daily summary of my Linear issues posted to Slack.",
  tags: ["productivity", "daily"],
  connectors: ["linear", "slack"],
  license: "MIT",
  homepage: undefined,
  riskLevel: "low",
  networkAccess: true,
  fileAccess: false,
  approvalBehavior: "ask_on_novel",
};

describe("normalizeSlug", () => {
  it("kebab-cases free-form names", () => {
    expect(normalizeSlug("My Daily Report")).toBe("my-daily-report");
  });

  it("collapses runs of non-alphanumerics", () => {
    expect(normalizeSlug("hello   world___foo")).toBe("hello-world-foo");
  });

  it("strips leading and trailing hyphens", () => {
    expect(normalizeSlug("---foo---")).toBe("foo");
  });

  it("caps length at 64 chars", () => {
    const long = "a".repeat(100);
    expect(normalizeSlug(long).length).toBe(64);
  });

  it("returns empty string for input with no valid chars", () => {
    expect(normalizeSlug("!!!!!")).toBe("");
  });
});

describe("normalizeAuthor", () => {
  it("strips leading @", () => {
    expect(normalizeAuthor("@myhandle")).toBe("myhandle");
  });

  it("strips repeated leading @", () => {
    expect(normalizeAuthor("@@@myhandle")).toBe("myhandle");
  });

  it("trims whitespace", () => {
    expect(normalizeAuthor("  myhandle  ")).toBe("myhandle");
  });
});

describe("validateSubmission", () => {
  it("returns no issues for valid form data", () => {
    expect(validateSubmission(baseForm)).toEqual([]);
  });

  it("rejects an invalid slug", () => {
    const issues = validateSubmission({ ...baseForm, slug: "Bad Slug!" });
    expect(issues.some((i) => i.field === "slug")).toBe(true);
  });

  it("rejects an empty slug", () => {
    const issues = validateSubmission({ ...baseForm, slug: "" });
    expect(issues.some((i) => i.field === "slug")).toBe(true);
  });

  it("rejects an author with a leading hyphen", () => {
    const issues = validateSubmission({ ...baseForm, author: "-myhandle" });
    expect(issues.some((i) => i.field === "author")).toBe(true);
  });

  it("rejects a non-semver version", () => {
    const issues = validateSubmission({ ...baseForm, version: "latest" });
    expect(issues.some((i) => i.field === "version")).toBe(true);
  });

  it("accepts pre-release semver", () => {
    expect(
      validateSubmission({ ...baseForm, version: "1.0.0-beta.2" }),
    ).toEqual([]);
  });

  it("rejects an empty description", () => {
    const issues = validateSubmission({ ...baseForm, description: "" });
    expect(issues.some((i) => i.field === "description")).toBe(true);
  });

  it("rejects an overlong description", () => {
    const issues = validateSubmission({
      ...baseForm,
      description: "a".repeat(281),
    });
    expect(issues.some((i) => i.field === "description")).toBe(true);
  });

  it("requires at least one tag", () => {
    const issues = validateSubmission({ ...baseForm, tags: [] });
    expect(issues.some((i) => i.field === "tags")).toBe(true);
  });

  it("caps tags at 8", () => {
    const issues = validateSubmission({
      ...baseForm,
      tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    });
    expect(issues.some((i) => i.field === "tags")).toBe(true);
  });

  it("rejects a homepage with javascript: scheme", () => {
    const issues = validateSubmission({
      ...baseForm,
      homepage: "javascript:alert(1)",
    });
    expect(issues.some((i) => i.field === "homepage")).toBe(true);
  });

  it("rejects a homepage with http: scheme (https only)", () => {
    const issues = validateSubmission({
      ...baseForm,
      homepage: "http://example.com",
    });
    expect(issues.some((i) => i.field === "homepage")).toBe(true);
  });

  it("rejects a malformed homepage URL", () => {
    const issues = validateSubmission({ ...baseForm, homepage: "not a url" });
    expect(issues.some((i) => i.field === "homepage")).toBe(true);
  });

  it("rejects a homepage with no hostname (https://)", () => {
    const issues = validateSubmission({ ...baseForm, homepage: "https://" });
    expect(issues.some((i) => i.field === "homepage")).toBe(true);
  });

  it("rejects a homepage with embedded NUL byte", () => {
    const issues = validateSubmission({
      ...baseForm,
      homepage: "\x00https://example.com",
    });
    expect(issues.some((i) => i.field === "homepage")).toBe(true);
  });

  it("accepts an https homepage", () => {
    expect(
      validateSubmission({ ...baseForm, homepage: "https://example.com" }),
    ).toEqual([]);
  });

  it("rejects a tag with whitespace", () => {
    const issues = validateSubmission({
      ...baseForm,
      tags: ["valid", "has space"],
    });
    expect(issues.some((i) => i.field === "tags")).toBe(true);
  });

  it("rejects a tag with uppercase characters", () => {
    const issues = validateSubmission({ ...baseForm, tags: ["Productivity"] });
    expect(issues.some((i) => i.field === "tags")).toBe(true);
  });

  it("rejects a connector with a slash", () => {
    const issues = validateSubmission({
      ...baseForm,
      connectors: ["slack/admin"],
    });
    expect(issues.some((i) => i.field === "connectors")).toBe(true);
  });

  it("accepts tags with dots and underscores", () => {
    expect(
      validateSubmission({ ...baseForm, tags: ["v1.0", "my_tag"] }),
    ).toEqual([]);
  });
});

describe("STARTER_RECIPE_YAML", () => {
  it("declares the apiVersion the registry expects", () => {
    expect(STARTER_RECIPE_YAML).toContain("apiVersion: patchwork.sh/v1");
  });

  it("declares a top-level name extractable by extractYamlName", () => {
    expect(extractYamlName(STARTER_RECIPE_YAML)).toBe("my-recipe");
  });

  it("declares a trigger block (registry requires one)", () => {
    expect(STARTER_RECIPE_YAML).toMatch(/^trigger:/m);
  });

  it("declares at least one step", () => {
    expect(STARTER_RECIPE_YAML).toMatch(/^steps:/m);
    expect(STARTER_RECIPE_YAML).toMatch(/-\s+id:\s/);
  });

  it("includes the schema header for IDE autocomplete", () => {
    expect(STARTER_RECIPE_YAML).toContain(
      "yaml-language-server: $schema=https://raw.githubusercontent.com/patchworkos/recipes/",
    );
  });
});

describe("RECIPE_PRESETS", () => {
  it("includes manual, scheduled, and webhook presets", () => {
    const ids = RECIPE_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["manual", "scheduled", "webhook"]);
  });

  it("each preset has a non-empty label and description", () => {
    for (const preset of RECIPE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("each preset YAML declares a top-level name", () => {
    for (const preset of RECIPE_PRESETS) {
      expect(extractYamlName(preset.yaml)).not.toBeNull();
    }
  });

  it("each preset declares the expected trigger type", () => {
    const triggerLines = RECIPE_PRESETS.map((p) => {
      const match = /^\s*type:\s*(\w+)$/m.exec(p.yaml);
      return { id: p.id, triggerType: match?.[1] };
    });
    expect(triggerLines).toEqual([
      { id: "manual", triggerType: "manual" },
      { id: "scheduled", triggerType: "cron" },
      { id: "webhook", triggerType: "webhook" },
    ]);
  });

  it("manual preset matches STARTER_RECIPE_YAML (single source of truth)", () => {
    const manual = RECIPE_PRESETS.find((p) => p.id === "manual");
    expect(manual?.yaml).toBe(STARTER_RECIPE_YAML);
  });

  it("each preset includes the schema header for IDE autocomplete", () => {
    for (const preset of RECIPE_PRESETS) {
      expect(preset.yaml).toContain("yaml-language-server: $schema=");
    }
  });
});

describe("extractYamlName", () => {
  it("returns the top-level name field", () => {
    expect(extractYamlName("name: morning-brief\nversion: 1.0.0")).toBe(
      "morning-brief",
    );
  });

  it("unwraps double quotes", () => {
    expect(extractYamlName('name: "morning-brief"')).toBe("morning-brief");
  });

  it("unwraps single quotes", () => {
    expect(extractYamlName("name: 'morning-brief'")).toBe("morning-brief");
  });

  it("ignores nested name fields (steps[].name)", () => {
    const yaml = `apiVersion: x
steps:
  - name: nested-thing
`;
    expect(extractYamlName(yaml)).toBeNull();
  });

  it("returns null when no name field is present", () => {
    expect(extractYamlName("apiVersion: x\ndescription: y")).toBeNull();
  });
});

describe("buildManifestJson", () => {
  it("emits all required fields with scoped name", () => {
    const json = buildManifestJson(baseForm);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("@myhandle/my-recipe");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.author).toBe("@myhandle");
    expect(parsed.maintainer).toBe("@myhandle");
    expect(parsed.license).toBe("MIT");
    expect(parsed.tags).toEqual(["productivity", "daily"]);
    expect(parsed.connectors).toEqual(["linear", "slack"]);
    expect(parsed.recipes).toEqual({ main: "recipe.yaml" });
    expect(parsed.risk_level).toBe("low");
    expect(parsed.network_access).toBe(true);
    expect(parsed.file_access).toBe(false);
    expect(parsed.approval_behavior).toBe("ask_on_novel");
  });

  it("omits homepage when not provided", () => {
    const parsed = JSON.parse(buildManifestJson(baseForm));
    expect(parsed.homepage).toBeUndefined();
  });

  it("includes homepage canonicalized when provided", () => {
    const parsed = JSON.parse(
      buildManifestJson({ ...baseForm, homepage: "https://example.com" }),
    );
    // WHATWG URL canonicalisation adds a trailing slash to bare hostnames —
    // that's intentional, so downstream renderers always see a normalised value.
    expect(parsed.homepage).toBe("https://example.com/");
  });

  it("defaults license to MIT when empty", () => {
    const parsed = JSON.parse(buildManifestJson({ ...baseForm, license: "" }));
    expect(parsed.license).toBe("MIT");
  });

  it("ends with a trailing newline (POSIX-friendly)", () => {
    expect(buildManifestJson(baseForm).endsWith("\n")).toBe(true);
  });
});

describe("path builders", () => {
  it("recipeYamlPath uses recipes/<slug>/recipe.yaml", () => {
    expect(recipeYamlPath(baseForm)).toBe("recipes/my-recipe/recipe.yaml");
  });

  it("recipeJsonPath uses recipes/<slug>/recipe.json", () => {
    expect(recipeJsonPath(baseForm)).toBe("recipes/my-recipe/recipe.json");
  });

  it("installSourceFor produces a github: source that matches the registry layout", () => {
    expect(installSourceFor(baseForm)).toBe(
      `github:${REGISTRY_OWNER}/${REGISTRY_REPO}/recipes/my-recipe`,
    );
  });
});

describe("buildGithubCreateFileUrl", () => {
  it("targets the registry repo by default", () => {
    const url = buildGithubCreateFileUrl({
      filename: "recipes/foo/recipe.yaml",
      content: "name: foo",
    });
    expect(url.startsWith(
      `https://github.com/${REGISTRY_OWNER}/${REGISTRY_REPO}/new/${REGISTRY_BRANCH}?`,
    )).toBe(true);
  });

  it("URL-encodes filename and value", () => {
    const url = new URL(
      buildGithubCreateFileUrl({
        filename: "recipes/foo/recipe.yaml",
        content: "name: foo\ndescription: hello world",
      }),
    );
    expect(url.searchParams.get("filename")).toBe("recipes/foo/recipe.yaml");
    expect(url.searchParams.get("value")).toBe(
      "name: foo\ndescription: hello world",
    );
  });

  it("includes commit message and description when provided", () => {
    const url = new URL(
      buildGithubCreateFileUrl({
        filename: "recipes/foo/recipe.yaml",
        content: "name: foo",
        message: "Add foo recipe",
        description: "A new recipe for foo workflows",
      }),
    );
    expect(url.searchParams.get("message")).toBe("Add foo recipe");
    expect(url.searchParams.get("description")).toBe(
      "A new recipe for foo workflows",
    );
  });

  it("omits message and description when not provided", () => {
    const url = new URL(
      buildGithubCreateFileUrl({
        filename: "recipes/foo/recipe.yaml",
        content: "name: foo",
      }),
    );
    expect(url.searchParams.has("message")).toBe(false);
    expect(url.searchParams.has("description")).toBe(false);
  });

  it("respects explicit owner/repo/branch overrides", () => {
    const url = buildGithubCreateFileUrl({
      owner: "alt-owner",
      repo: "alt-repo",
      branch: "develop",
      filename: "x.yaml",
      content: "y",
    });
    expect(url.startsWith("https://github.com/alt-owner/alt-repo/new/develop?"))
      .toBe(true);
  });
});
