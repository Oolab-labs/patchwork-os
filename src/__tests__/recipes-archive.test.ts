/**
 * Unit tests for archiveRecipe — covers happy path, sidecar move, missing
 * recipe, invalid name, and timestamped collision suffix.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveRecipe } from "../recipesHttp.js";

let recipesDir = "";

beforeEach(() => {
  recipesDir = mkdtempSync(path.join(os.tmpdir(), "archive-recipe-"));
});

afterEach(() => {
  if (recipesDir && existsSync(recipesDir)) {
    rmSync(recipesDir, { recursive: true, force: true });
  }
});

describe("archiveRecipe", () => {
  it("moves a yaml recipe and its sidecar into .archive/", () => {
    writeFileSync(
      path.join(recipesDir, "demo.yaml"),
      "name: demo\ntrigger:\n  type: manual\n",
    );
    writeFileSync(
      path.join(recipesDir, "demo.yaml.permissions.json"),
      JSON.stringify({ trust: "auto" }),
    );

    const result = archiveRecipe(recipesDir, "demo");

    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/\.archive\/demo\.yaml$/);
    expect(existsSync(path.join(recipesDir, "demo.yaml"))).toBe(false);
    expect(existsSync(path.join(recipesDir, ".archive", "demo.yaml"))).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(recipesDir, ".archive", "demo.yaml.permissions.json"),
      ),
    ).toBe(true);
  });

  it("returns 404-style error for unknown recipe", () => {
    const result = archiveRecipe(recipesDir, "nope");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Recipe not found");
  });

  it("rejects invalid recipe names", () => {
    const result = archiveRecipe(recipesDir, "../etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid recipe name");
  });

  it("suffixes archives on collision so history survives", () => {
    // First archive lands at .archive/demo.yaml.
    writeFileSync(path.join(recipesDir, "demo.yaml"), "name: demo\n");
    expect(archiveRecipe(recipesDir, "demo").ok).toBe(true);

    // Re-create demo.yaml and archive again — must NOT overwrite.
    writeFileSync(path.join(recipesDir, "demo.yaml"), "name: demo\nv: 2\n");
    const result = archiveRecipe(recipesDir, "demo");

    expect(result.ok).toBe(true);
    expect(result.path).not.toBe(
      path.join(recipesDir, ".archive", "demo.yaml"),
    );
    expect(result.path).toMatch(/\.archive\/demo\..+\.yaml$/);

    const archived = readdirSync(path.join(recipesDir, ".archive"));
    expect(archived.filter((f) => f.startsWith("demo")).length).toBe(2);
  });

  it("moves a json recipe (no yaml present)", () => {
    writeFileSync(
      path.join(recipesDir, "json-only.json"),
      JSON.stringify({ name: "json-only", trigger: { type: "manual" } }),
    );

    const result = archiveRecipe(recipesDir, "json-only");
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(recipesDir, "json-only.json"))).toBe(false);
    expect(
      existsSync(path.join(recipesDir, ".archive", "json-only.json")),
    ).toBe(true);
  });

  it("creates .archive/ on demand", () => {
    writeFileSync(path.join(recipesDir, "fresh.yaml"), "name: fresh\n");
    expect(existsSync(path.join(recipesDir, ".archive"))).toBe(false);

    const result = archiveRecipe(recipesDir, "fresh");
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(recipesDir, ".archive"))).toBe(true);
  });
});
