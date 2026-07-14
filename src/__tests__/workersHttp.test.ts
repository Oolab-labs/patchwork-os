import * as nodefs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  lintWorkerContent,
  listWorkers,
  loadWorkerContent,
  saveWorkerContent,
} from "../workersHttp.js";

function makeTmpDir(prefix: string): string {
  return nodefs.mkdtempSync(path.join(tmpdir(), prefix));
}

function writeRecipe(recipesDir: string, name: string): void {
  nodefs.writeFileSync(
    path.join(recipesDir, `${name}.yaml`),
    `name: ${name}\ndescription: test\nsteps:\n  - id: s1\n    agent:\n      prompt: hi\n`,
    "utf-8",
  );
}

const WORKER_YAML = (id: string, recipe: string) =>
  `id: ${id}\nname: Test Worker\nrecipe: ${recipe}\nowns:\n  - vcs-read\nautonomyCeiling: 1\n`;

describe("workersHttp", () => {
  let workersDir: string;
  let recipesDir: string;

  beforeEach(() => {
    workersDir = makeTmpDir("pw-workers-test-");
    recipesDir = makeTmpDir("pw-recipes-test-");
    writeRecipe(recipesDir, "release-notes");
  });

  afterEach(() => {
    nodefs.rmSync(workersDir, { recursive: true, force: true });
    nodefs.rmSync(recipesDir, { recursive: true, force: true });
  });

  describe("saveWorkerContent", () => {
    it("rejects an invalid worker id", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "Not_Valid",
        WORKER_YAML("not-valid", "release-notes"),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Invalid worker id/);
    });

    it("rejects empty content", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        "   ",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/required/);
    });

    it("rejects malformed YAML", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        "id: [unterminated",
      );
      expect(result.ok).toBe(false);
    });

    it("rejects a schema violation (bad autonomyCeiling)", () => {
      const bad = "id: my-worker\nname: X\nowns: []\nautonomyCeiling: 9\n";
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        bad,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/autonomyCeiling/);
    });

    it("errors when the referenced recipe does not exist", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        WORKER_YAML("my-worker", "does-not-exist"),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/does not match any installed recipe/);
    });

    it("saves a valid worker referencing an existing recipe", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        WORKER_YAML("my-worker", "release-notes"),
      );
      expect(result.ok).toBe(true);
      expect(result.path).toMatch(/my-worker\.worker\.yaml$/);
      expect(nodefs.existsSync(result.path!)).toBe(true);
    });

    it("warns (not errors) on an unrecognized owns domain", () => {
      const yaml =
        "id: my-worker\nname: X\nrecipe: release-notes\nowns:\n  - not-a-real-domain\nautonomyCeiling: 1\n";
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        yaml,
      );
      expect(result.ok).toBe(true);
      expect(
        result.warnings?.some((w) => w.includes("not-a-real-domain")),
      ).toBe(true);
    });

    it("rewrites a mismatched id to match the filename", () => {
      const result = saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        WORKER_YAML("wrong-id", "release-notes"),
      );
      expect(result.ok).toBe(true);
      const saved = nodefs.readFileSync(result.path!, "utf-8");
      expect(saved).toMatch(/id: my-worker/);
      expect(result.warnings?.some((w) => w.includes("rewritten"))).toBe(true);
    });
  });

  describe("loadWorkerContent / listWorkers", () => {
    it("loads content back after a save", () => {
      saveWorkerContent(
        workersDir,
        recipesDir,
        "my-worker",
        WORKER_YAML("my-worker", "release-notes"),
      );
      const loaded = loadWorkerContent(workersDir, "my-worker");
      expect(loaded?.content).toMatch(/id: my-worker/);
    });

    it("returns null for a nonexistent worker", () => {
      expect(loadWorkerContent(workersDir, "nope")).toBeNull();
    });

    it("lists saved workers sorted by id", () => {
      saveWorkerContent(
        workersDir,
        recipesDir,
        "zeta",
        WORKER_YAML("zeta", "release-notes"),
      );
      saveWorkerContent(
        workersDir,
        recipesDir,
        "alpha",
        WORKER_YAML("alpha", "release-notes"),
      );
      const { workers } = listWorkers(workersDir);
      expect(workers.map((w) => w.id)).toEqual(["alpha", "zeta"]);
    });

    it("returns an empty list for a nonexistent directory", () => {
      const { workers } = listWorkers(path.join(workersDir, "does-not-exist"));
      expect(workers).toEqual([]);
    });
  });

  describe("lintWorkerContent", () => {
    it("reports ok:true for valid content with no issues", () => {
      const result = lintWorkerContent(
        WORKER_YAML("my-worker", "release-notes"),
        recipesDir,
      );
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("reports a schema error without touching disk", () => {
      const result = lintWorkerContent("id: BAD ID\nname: X\n", recipesDir);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("reports a warning for a missing recipe reference", () => {
      const result = lintWorkerContent(
        WORKER_YAML("my-worker", "missing"),
        recipesDir,
      );
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) =>
          e.message.includes("does not match any installed recipe"),
        ),
      ).toBe(true);
    });
  });
});
