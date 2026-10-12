/**
 * Install provenance for TOP-LEVEL recipe files — the `POST /recipes/install`
 * path, which writes `<recipesDir>/<name>.json` through `installRecipeFromFile`
 * rather than an install directory.
 *
 * The record is a sidecar at `<recipesDir>/.install/<file basename>.json`,
 * never inside the recipe file. It is bound to the installed bytes by sha256,
 * so a record can never attach to a different file that later takes the same
 * name — whether that file arrived through a route (delete/archive clean the
 * sidecar up) or out of band (the hash no longer matches).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { installRecipeFromFile } from "../recipes/installer.js";
import {
  INSTALL_SIDECAR_DIR,
  topLevelProvenancePath,
} from "../recipes/installProvenance.js";
import {
  archiveRecipe,
  deleteRecipeContent,
  invalidateRecipesCache,
  listInstalledRecipes,
  saveRecipe,
} from "../recipesHttp.js";
import { Server } from "../server.js";

const SOURCE = "github:example/recipes/recipes/noisy-recipe";

const RECIPE = {
  name: "noisy-recipe",
  description: "synthetic fixture",
  trigger: { type: "manual" },
  steps: [{ id: "s1", agent: true, prompt: "summarise the inbox" }],
};

let root = "";
let recipesDir = "";

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pw-toplevel-provenance-"));
  recipesDir = path.join(root, "recipes");
  mkdirSync(recipesDir, { recursive: true });
  vi.stubEnv("PATCHWORK_HOME", root);
  invalidateRecipesCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateRecipesCache();
  rmSync(root, { recursive: true, force: true });
});

function writeSource(recipe: unknown = RECIPE): string {
  const p = path.join(root, `src-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(recipe));
  return p;
}

function entry(name = "noisy-recipe") {
  invalidateRecipesCache();
  return listInstalledRecipes(recipesDir, { disabledRecipes: [] }).recipes.find(
    (r) => r.name === name,
  );
}

function install(source?: string, recipe: unknown = RECIPE) {
  return installRecipeFromFile(writeSource(recipe), {
    recipesDir,
    ...(source !== undefined ? { provenance: { source } } : {}),
  });
}

describe("installRecipeFromFile — top-level provenance sidecar", () => {
  it("writes the sidecar under .install/, never into the recipe file", () => {
    const result = install(SOURCE);
    const sidecar = topLevelProvenancePath(result.installedPath);
    expect(sidecar).toBe(
      path.join(recipesDir, INSTALL_SIDECAR_DIR, "noisy-recipe.json.json"),
    );
    const record = JSON.parse(readFileSync(sidecar, "utf-8"));
    expect(record.rv).toBe(1);
    expect(record.source).toBe(SOURCE);
    expect(typeof record.installedAt).toBe("number");
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    const installed = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(installed).not.toHaveProperty("source");
    expect(installed).not.toHaveProperty("installedFrom");
  });

  it("writes nothing when no provenance is passed", () => {
    install();
    expect(existsSync(path.join(recipesDir, INSTALL_SIDECAR_DIR))).toBe(false);
  });

  it("writes nothing for an unrecordable source, and drops a previous record on replace", () => {
    const first = install(SOURCE);
    install("https://user:secret@example.test/recipes/noisy-recipe.yaml");
    expect(existsSync(topLevelProvenancePath(first.installedPath))).toBe(false);
    expect(entry()).not.toHaveProperty("installedFrom");
  });

  it("reinstall overwrites the record", () => {
    install(SOURCE);
    const other = "github:example/recipes/recipes/noisy-recipe-alt";
    install(other, { ...RECIPE, description: "changed" });
    expect(entry()?.installedFrom).toBe(other);
  });
});

describe("listInstalledRecipes — installedFrom for top-level files", () => {
  it("exposes the recorded source", () => {
    install(SOURCE);
    const e = entry();
    expect(e?.installedFrom).toBe(SOURCE);
    expect(e?.source).toBe("user");
  });

  it("omits it when there is no sidecar", () => {
    install();
    expect(entry()).toBeDefined();
    expect(entry()).not.toHaveProperty("installedFrom");
  });

  it("omits it when the sidecar is malformed (no throw)", () => {
    const result = install(SOURCE);
    writeFileSync(topLevelProvenancePath(result.installedPath), "{not json");
    expect(entry()).toBeDefined();
    expect(entry()).not.toHaveProperty("installedFrom");
  });

  it("omits it when the file changed after install (hash no longer matches)", () => {
    const result = install(SOURCE);
    writeFileSync(
      result.installedPath,
      JSON.stringify({ ...RECIPE, description: "edited out of band" }),
    );
    expect(entry()).toBeDefined();
    expect(entry()).not.toHaveProperty("installedFrom");
  });

  it("the sidecar directory is not itself listed as a recipe", () => {
    install(SOURCE);
    invalidateRecipesCache();
    const all = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    expect(all.recipes.map((r) => r.name)).toEqual(["noisy-recipe"]);
  });
});

describe("route cleanup — a stale origin never attaches to a later file", () => {
  it("delete removes the sidecar; a later same-name recipe has no installedFrom", () => {
    const result = install(SOURCE);
    const sidecar = topLevelProvenancePath(result.installedPath);
    expect(deleteRecipeContent(recipesDir, "noisy-recipe").ok).toBe(true);
    expect(existsSync(sidecar)).toBe(false);

    const saved = saveRecipe(recipesDir, {
      name: "noisy-recipe",
      description: "a different recipe",
      trigger: { type: "manual" },
      steps: [{ id: "s1", agent: true, prompt: "something else" }],
    });
    expect(saved.ok).toBe(true);
    expect(saved.path).toBe(result.installedPath);
    expect(entry()).toBeDefined();
    expect(entry()).not.toHaveProperty("installedFrom");
  });

  it("archive moves the sidecar out of the live recipes dir", () => {
    const result = install(SOURCE);
    const sidecar = topLevelProvenancePath(result.installedPath);
    const archived = archiveRecipe(recipesDir, "noisy-recipe");
    expect(archived.ok).toBe(true);
    expect(existsSync(sidecar)).toBe(false);
    // Kept next to the archived file, mirroring the permissions sidecar.
    expect(existsSync(topLevelProvenancePath(archived.path as string))).toBe(
      true,
    );

    install(undefined, { ...RECIPE, description: "a later file" });
    expect(entry()).toBeDefined();
    expect(entry()).not.toHaveProperty("installedFrom");
  });
});

describe("POST /recipes/install — records the request's source", () => {
  const TOKEN = "test-toplevel-provenance-token-00000000";
  let server: Server | null = null;
  let port = 0;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    await server?.close();
    server = null;
    globalThis.fetch = originalFetch;
  });

  function post(body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path: "/recipes/install",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => {
            data += c.toString();
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data }),
          );
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  it("a single-recipe install exposes installedFrom equal to the source string", async () => {
    vi.stubEnv("PATCHWORK_RECIPE_REPO_ALLOWLIST", "example/recipes");
    const yaml = [
      "name: noisy-recipe",
      "description: synthetic fixture",
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: s1",
      "    agent: true",
      "    prompt: summarise the inbox",
      "",
    ].join("\n");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(yaml, {
          status: 200,
          headers: { "Content-Type": "text/yaml" },
        }),
    ) as unknown as typeof fetch;

    server = new Server(TOKEN, new Logger(false));
    port = await server.findAndListen(null);

    const res = await post(JSON.stringify({ source: SOURCE }));
    expect(res.status).toBe(200);
    expect(entry()?.installedFrom).toBe(SOURCE);
    expect(readdirSync(path.join(recipesDir, INSTALL_SIDECAR_DIR))).toEqual([
      "noisy-recipe.json.json",
    ]);
  });
});
