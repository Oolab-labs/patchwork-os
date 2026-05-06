import { describe, expect, it } from "vitest";
import {
  githubBlobUrlFor,
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

  it("treats hyphenated suffixes as the base level (regex \\b is letter↔hyphen boundary)", () => {
    // Documents existing behavior: `risk: medium-aggressive` matches the
    // `risk: medium\b` regex because \b finds a word boundary at the
    // letter→hyphen transition. If we want to forbid suffixes we'd need
    // `[^\w-]` instead of `\b`. Pinned here so a future regex tightening
    // is a deliberate, test-noticed change.
    const yaml = "  risk: medium-aggressive\n  risk: medium\n";
    expect(summarizeRisk(yaml).medium).toBe(2);
  });

  it("counts only step rows that match `- id: <non-space>`", () => {
    // Continuation-of-prior-list lines that don't start with `- id:` shouldn't count.
    const yaml = `
steps:
  - id: real-step
    risk: low
  - name: not-a-step
    risk: high
`;
    expect(summarizeRisk(yaml).steps).toBe(1);
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
