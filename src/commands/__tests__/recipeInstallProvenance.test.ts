/**
 * Install provenance: `recipe install` records where an install-dir recipe
 * came from, and the recipe listing exposes it as `installedFrom`.
 *
 * Without it a reader could not tell "this exact source is installed" from "a
 * different recipe happens to have the same name" — and guessing from the
 * name is exactly the mistake the field exists to remove. So absence must stay
 * absence: a legacy install with no record, a top-level recipe file, and a
 * malformed record all report NO field, never a guessed one.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInstallProvenance,
  INSTALL_PROVENANCE_FILE,
  readInstallProvenance,
  writeInstallProvenance,
} from "../../recipes/installProvenance.js";
import {
  invalidateRecipesCache,
  listInstalledRecipes,
} from "../../recipesHttp.js";
import { runRecipeInstall } from "../recipeInstall.js";

// cpSync/rmSync are intercepted for the crash-safety case; ESM namespaces are
// not spy-able, so this goes through vi.mock with real implementations.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    cpSync: vi.fn(actual.cpSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

const GITHUB_FIXTURE = "github:example/recipes/noisy-recipe@main";

let recipesRoot = "";
let srcRoot = "";
let homeRoot = "";

beforeEach(() => {
  recipesRoot = mkdtempSync(path.join(os.tmpdir(), "pw-provenance-recipes-"));
  srcRoot = mkdtempSync(path.join(os.tmpdir(), "pw-provenance-src-"));
  homeRoot = mkdtempSync(path.join(os.tmpdir(), "pw-provenance-home-"));
  // Keep the install's config/policy reads off the real operator home.
  vi.stubEnv("PATCHWORK_HOME", homeRoot);
  invalidateRecipesCache();
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mocked = await import("node:fs");
  vi.mocked(mocked.cpSync).mockImplementation(actual.cpSync);
  vi.mocked(mocked.rmSync).mockImplementation(actual.rmSync);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateRecipesCache();
  for (const d of [recipesRoot, srcRoot, homeRoot]) {
    if (d && existsSync(d)) actual.rmSync(d, { recursive: true, force: true });
  }
});

function writeSrcPackage(recipeName: string, extra = ""): string {
  const dir = mkdtempSync(path.join(srcRoot, "pkg-"));
  writeFileSync(
    path.join(dir, "main.yaml"),
    `name: ${recipeName}\ntrigger:\n  type: manual\nsteps: []\n${extra}`,
  );
  writeFileSync(
    path.join(dir, "recipe.json"),
    JSON.stringify({
      name: recipeName,
      version: "1.0.0",
      description: "x",
      recipes: { main: "main.yaml" },
    }),
  );
  return dir;
}

function listing() {
  invalidateRecipesCache();
  return listInstalledRecipes(recipesRoot, { disabledRecipes: [] }).recipes;
}

describe("runRecipeInstall — writes provenance", () => {
  it("records the source exactly as given, with rv and installedAt", async () => {
    const src = writeSrcPackage("prov-fresh");
    const before = Date.now();
    const result = await runRecipeInstall(src, { recipesDir: recipesRoot });

    const file = path.join(result.installDir, INSTALL_PROVENANCE_FILE);
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, "utf-8"));
    expect(record.rv).toBe(1);
    expect(record.source).toBe(src);
    expect(record.installedAt).toBeGreaterThanOrEqual(before);
    expect(record.installedAt).toBeLessThanOrEqual(Date.now());
    // A local source has no ref to report.
    expect(record).not.toHaveProperty("resolvedRef");
  });

  it("is not reported as an installed file (it is metadata, not recipe content)", async () => {
    const src = writeSrcPackage("prov-files");
    const result = await runRecipeInstall(src, { recipesDir: recipesRoot });
    expect(result.filesInstalled).not.toContain(INSTALL_PROVENANCE_FILE);
  });

  it("reinstall overwrites the record with the new source", async () => {
    const v1 = writeSrcPackage("prov-reinstall");
    const first = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    const v2 = writeSrcPackage("prov-reinstall", "# v2\n");
    const second = await runRecipeInstall(v2, { recipesDir: recipesRoot });

    expect(second.installDir).toBe(first.installDir);
    const record = readInstallProvenance(second.installDir);
    expect(record?.source).toBe(v2);
  });

  it("a crash mid-copy leaves no provenance anywhere, including an orphaned staging dir", async () => {
    const src = writeSrcPackage("prov-crash");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { cpSync, rmSync: mockedRmSync } = await import("node:fs");
    vi.mocked(cpSync).mockImplementation((from, dest, opts) => {
      if (String(dest).includes(recipesRoot)) {
        throw new Error("simulated crash mid-copy");
      }
      return actual.cpSync(from as never, dest as never, opts as never);
    });
    // Leave the staging dir behind, as a killed process would.
    vi.mocked(mockedRmSync).mockImplementation((target, opts) => {
      if (String(target).includes(".installing-")) {
        throw new Error("simulated: process died before cleanup");
      }
      return actual.rmSync(target as string, opts as never);
    });

    await expect(
      runRecipeInstall(src, { recipesDir: recipesRoot }),
    ).rejects.toThrow("simulated crash mid-copy");

    expect(existsSync(path.join(recipesRoot, "prov-crash"))).toBe(false);
    const leftovers = readdirSync(recipesRoot).filter((f) =>
      f.startsWith(".installing-"),
    );
    expect(leftovers.length).toBeGreaterThan(0);
    for (const leftover of leftovers) {
      expect(
        existsSync(path.join(recipesRoot, leftover, INSTALL_PROVENANCE_FILE)),
      ).toBe(false);
    }
  });

  it("a failed reinstall keeps the PREVIOUS record intact", async () => {
    const v1 = writeSrcPackage("prov-crash-reinstall");
    const first = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    const v2 = writeSrcPackage("prov-crash-reinstall", "# v2\n");

    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { cpSync } = await import("node:fs");
    vi.mocked(cpSync).mockImplementation((from, dest, opts) => {
      if (String(dest).includes(recipesRoot)) {
        throw new Error("simulated crash mid-copy");
      }
      return actual.cpSync(from as never, dest as never, opts as never);
    });

    await expect(
      runRecipeInstall(v2, { recipesDir: recipesRoot }),
    ).rejects.toThrow("simulated crash mid-copy");
    expect(readInstallProvenance(first.installDir)?.source).toBe(v1);
  });
});

describe("listInstalledRecipes — installedFrom", () => {
  it("exposes the recorded source for an install-dir recipe", async () => {
    const src = writeSrcPackage("prov-listed");
    await runRecipeInstall(src, { recipesDir: recipesRoot });

    const entry = listing().find((r) => r.name === "prov-listed");
    expect(entry).toBeDefined();
    expect(entry?.installedFrom).toBe(src);
    // `source` is unchanged.
    expect(entry?.source).toBe("user");
  });

  it("exposes a github source string verbatim", () => {
    const dir = path.join(recipesRoot, "noisy-recipe");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "main.yaml"),
      "name: noisy-recipe\ntrigger:\n  type: manual\nsteps: []\n",
    );
    const record = buildInstallProvenance(GITHUB_FIXTURE, {
      resolvedRef: "main",
      now: 1_700_000_000_000,
    });
    expect(record).not.toBeNull();
    writeInstallProvenance(dir, record as NonNullable<typeof record>);

    const entry = listing().find((r) => r.name === "noisy-recipe");
    expect(entry?.installedFrom).toBe(GITHUB_FIXTURE);
  });

  it("omits the field for a top-level recipe file, even with a stray record beside it", () => {
    writeFileSync(
      path.join(recipesRoot, "top-level.yaml"),
      "name: top-level\ntrigger:\n  type: manual\nsteps: []\n",
    );
    writeFileSync(
      path.join(recipesRoot, INSTALL_PROVENANCE_FILE),
      JSON.stringify({ rv: 1, source: GITHUB_FIXTURE, installedAt: 1 }),
    );
    const entry = listing().find((r) => r.name === "top-level");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("installedFrom");
  });

  it("omits the field for a legacy install dir with no record", () => {
    const dir = path.join(recipesRoot, "legacy-install");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "main.yaml"),
      "name: legacy-install\ntrigger:\n  type: manual\nsteps: []\n",
    );
    const entry = listing().find((r) => r.name === "legacy-install");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("installedFrom");
  });

  it.each([
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["wrong rv", JSON.stringify({ rv: 2, source: "x", installedAt: 1 })],
    ["non-string source", JSON.stringify({ rv: 1, source: 5, installedAt: 1 })],
    [
      "over-long source",
      JSON.stringify({ rv: 1, source: "a".repeat(513), installedAt: 1 }),
    ],
    [
      "credentials in the source",
      JSON.stringify({
        rv: 1,
        source: "https://user:secret@example.test/recipes",
        installedAt: 1,
      }),
    ],
  ])("ignores a malformed record (%s): no throw, no field", (_label, body) => {
    const dir = path.join(recipesRoot, "malformed-install");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "main.yaml"),
      "name: malformed-install\ntrigger:\n  type: manual\nsteps: []\n",
    );
    writeFileSync(path.join(dir, INSTALL_PROVENANCE_FILE), body);

    const entry = listing().find((r) => r.name === "malformed-install");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("installedFrom");
  });
});

describe("buildInstallProvenance — what is never recorded", () => {
  it.each([
    ["empty", ""],
    ["over 512 chars", `github:example/recipes/${"a".repeat(512)}`],
    ["non-string", 42],
    ["multi-line", "github:example/recipes\nnoisy-recipe"],
    ["URL userinfo", "https://token@example.test/recipes"],
  ])("returns null for %s", (_label, source) => {
    expect(buildInstallProvenance(source)).toBeNull();
  });

  it("accepts exactly 512 characters", () => {
    const s = "a".repeat(512);
    expect(buildInstallProvenance(s, { now: 1 })?.source).toBe(s);
  });
});
