import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRecipeFromFile } from "../installer.js";
import { stripRecipeScope } from "../names.js";
import { parseRecipe, RecipeParseError } from "../parser.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-scope-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SCOPED_YAML = `name: "@patchworkos/sprint-review-prep"
version: "1.0.0"
description: scoped registry recipe
trigger:
  type: manual
steps:
  - id: summarize
    agent: true
    prompt: do the thing
    tools:
      - Read
    risk: low
`;

describe("stripRecipeScope", () => {
  it("strips @scope/ prefix to the bare slug", () => {
    expect(stripRecipeScope("@patchworkos/sprint-review-prep")).toBe(
      "sprint-review-prep",
    );
  });
  it("strips scope/ prefix without @", () => {
    expect(stripRecipeScope("patchworkos/sprint-review-prep")).toBe(
      "sprint-review-prep",
    );
  });
  it("passes a bare name through unchanged", () => {
    expect(stripRecipeScope("sprint-review-prep")).toBe("sprint-review-prep");
  });
  it("yields an empty string for a trailing-slash name (caller's RECIPE_NAME_RE then rejects it)", () => {
    // `"foo/"` → final segment is `""`. stripRecipeScope returns it as-is;
    // the empty string is not a valid recipe name, so the downstream
    // RECIPE_NAME_RE check is the gate that rejects it.
    expect(stripRecipeScope("foo/")).toBe("");
  });
});

describe("scoped recipe name install", () => {
  it("installs a recipe with a scoped YAML name and stores under the bare slug", () => {
    const src = path.join(dir, "source.yaml");
    writeFileSync(src, SCOPED_YAML);
    const recipesDir = path.join(dir, "recipes");

    const result = installRecipeFromFile(src, { recipesDir });

    // Stored under the bare slug, not the scoped name.
    expect(result.installedPath.endsWith("sprint-review-prep.json")).toBe(true);
    expect(existsSync(result.installedPath)).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.name).toBe("sprint-review-prep");
  });

  it("re-loads a once-installed recipe without re-tripping the validator", () => {
    const src = path.join(dir, "source.yaml");
    writeFileSync(src, SCOPED_YAML);
    const recipesDir = path.join(dir, "recipes");

    const first = installRecipeFromFile(src, { recipesDir });
    // Persisted JSON parses again (bare name) — no throw.
    const reloaded = installRecipeFromFile(first.installedPath, { recipesDir });
    expect(reloaded.action).toBe("replaced");
    const written = JSON.parse(readFileSync(reloaded.installedPath, "utf-8"));
    expect(written.name).toBe("sprint-review-prep");
  });

  it("still rejects a genuinely invalid scoped name", () => {
    expect(() =>
      parseRecipe({
        name: "@bad/UPPER",
        version: "1.0",
        trigger: { type: "manual" },
        steps: [{ id: "s", agent: true, prompt: "p", tools: ["Read"] }],
      }),
    ).toThrow(RecipeParseError);
  });

  it("rejects a bare path-traversal name", () => {
    // No `/` → passes through stripRecipeScope unchanged, then fails the
    // kebab-case RECIPE_NAME_RE check (`.` is not an allowed char).
    expect(() =>
      parseRecipe({
        name: "..",
        version: "1.0",
        trigger: { type: "manual" },
        steps: [{ id: "s", agent: true, prompt: "p", tools: ["Read"] }],
      }),
    ).toThrow(RecipeParseError);
  });

  it("strips the scope but still validates the resulting slug (traversal segment discarded)", () => {
    // `@evil/../escape` strips to its last segment `escape` — a valid
    // slug. The `..` middle segment is discarded, so no path can escape
    // recipesDir; the stored file is `escape.json`.
    const r = parseRecipe({
      name: "@evil/../escape",
      version: "1.0",
      trigger: { type: "manual" },
      steps: [{ id: "s", agent: true, prompt: "p", tools: ["Read"] }],
    });
    expect(r.name).toBe("escape");
  });
});
