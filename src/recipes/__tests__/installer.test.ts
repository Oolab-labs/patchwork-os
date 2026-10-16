import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRecipeFromFile } from "../installer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-inst-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRecipe(name: string, recipe: unknown): string {
  const p = path.join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(recipe));
  return p;
}

const SIMPLE = {
  name: "sentry-autofix",
  version: "1.0",
  trigger: { type: "file_watch", patterns: ["**/*.ts"] },
  steps: [
    {
      id: "fix",
      agent: true,
      prompt: "fix it",
      tools: ["Read", "Edit(/src/**)"],
      risk: "medium",
    },
  ],
};

describe("installRecipeFromFile", () => {
  it("creates recipe in recipesDir; returns suggested permissions JSON without writing sidecar", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("sentry-autofix.json")).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.name).toBe("sentry-autofix");
    // alpha.36+ — sidecar `<name>.permissions.json` is no longer written.
    expect(existsSync(`${result.installedPath}.permissions.json`)).toBe(false);
    // permissionsJson is still returned for callers who want to render it
    // (e.g. CLI install confirmation).
    const perms = JSON.parse(result.permissionsJson);
    expect(perms.permissions.ask).toContain("Edit(/src/**)");
    expect(perms.permissions.ask).toContain("Read");
  });

  it("reports 'replaced' on second install", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    installRecipeFromFile(src, { recipesDir });
    const second = installRecipeFromFile(src, { recipesDir });
    expect(second.action).toBe("replaced");
  });

  it("accepts YAML recipe files", () => {
    const src = path.join(dir, "recipe.yaml");
    writeFileSync(
      src,
      `name: yaml-recipe
version: "1.0"
description: from YAML
trigger:
  type: file_watch
  patterns:
    - "**/*.md"
steps:
  - id: summarize
    agent: true
    prompt: summarize the change
    tools:
      - Read
    risk: low
`,
    );
    const recipesDir = path.join(dir, "recipes");
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("yaml-recipe.json")).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.trigger.type).toBe("file_watch");
    expect(written.steps[0].tools).toEqual(["Read"]);
  });

  it("accepts .yml extension", () => {
    const src = path.join(dir, "recipe.yml");
    writeFileSync(
      src,
      `name: short-ext
version: "1.0"
trigger: { type: manual }
steps:
  - id: x
    agent: false
    tool: send_message
    params: { text: hi }
`,
    );
    // Manual triggers bypass compile by design — install succeeds; asserts .yml is accepted
    const result = installRecipeFromFile(src, { recipesDir: dir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("short-ext.json")).toBe(true);
  });

  describe("the installed file is the recipe that was installed (audit 2026-10-15, H4)", () => {
    // The installer used to write JSON.stringify(parseRecipe(raw)), and the
    // parser keeps only id/prompt/tools/risk/into per step. The installed
    // copy lost its privacy classification, write acknowledgements,
    // completion contracts, required vars and guards — every field lint and
    // doctor check — while 18 tests here stayed green.
    const GOVERNED_YAML = `name: governed-probe
description: d
allowWrites:
  - file.write
expect:
  outputs: [summary]
trigger:
  type: manual
  vars:
    - name: TOPIC
      required: true
steps:
  - agent:
      driver: local
      model: probe-model
      data_policy:
        classification: personal
      prompt: "Summarise {{TOPIC}}"
    into: summary
    timeout: 30
    expect:
      contains: ok
  - tool: file.write
    when: "{{summary}} != ''"
    path: /tmp/probe-out.md
    content: "{{summary}}"
`;

    it("keeps every governance field on a flat (manual) recipe", () => {
      const src = path.join(dir, "governed.yaml");
      writeFileSync(src, GOVERNED_YAML);
      const recipesDir = path.join(dir, "recipes");
      const r = installRecipeFromFile(src, { recipesDir });
      const installed = JSON.parse(readFileSync(r.installedPath, "utf-8"));
      expect(installed.allowWrites).toEqual(["file.write"]);
      expect(installed.expect).toEqual({ outputs: ["summary"] });
      expect(installed.trigger.vars).toEqual([
        { name: "TOPIC", required: true },
      ]);
      expect(installed.steps[0].agent.data_policy).toEqual({
        classification: "personal",
      });
      expect(installed.steps[0].agent.driver).toBe("local");
      expect(installed.steps[0].timeout).toBe(30);
      expect(installed.steps[0].expect).toEqual({ contains: "ok" });
      expect(installed.steps[1].when).toBe("{{summary}} != ''");
    });

    it("keeps governance fields on an event-triggered (compiled) recipe too", () => {
      const src = writeRecipe("evt", {
        ...SIMPLE,
        allowWrites: ["file.write"],
        steps: [
          {
            ...SIMPLE.steps[0],
            agent: {
              prompt: "fix it",
              data_policy: { classification: "restricted" },
            },
          },
        ],
      });
      const r = installRecipeFromFile(src, {
        recipesDir: path.join(dir, "recipes"),
      });
      const installed = JSON.parse(readFileSync(r.installedPath, "utf-8"));
      expect(installed.allowWrites).toEqual(["file.write"]);
      expect(installed.steps[0].agent.data_policy).toEqual({
        classification: "restricted",
      });
    });

    it("still normalises a scoped name to its final segment", () => {
      const src = path.join(dir, "scoped.yaml");
      writeFileSync(
        src,
        GOVERNED_YAML.replace(
          "name: governed-probe",
          "name: org/governed-probe",
        ),
      );
      const r = installRecipeFromFile(src, {
        recipesDir: path.join(dir, "recipes"),
      });
      expect(path.basename(r.installedPath)).toBe("governed-probe.json");
      expect(JSON.parse(readFileSync(r.installedPath, "utf-8")).name).toBe(
        "governed-probe",
      );
    });

    it("still enforces the name pattern on the flat path", () => {
      const src = path.join(dir, "bad-name.yaml");
      writeFileSync(
        src,
        GOVERNED_YAML.replace("name: governed-probe", "name: Bad_Name"),
      );
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("installs every shipped template (15 used to fail on a missing step id)", () => {
      const tdir = path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "templates",
        "recipes",
      );
      const files = readdirSync(tdir).filter((f) => /\.ya?ml$/.test(f));
      expect(files.length).toBeGreaterThan(10);
      const failed: string[] = [];
      for (const f of files) {
        try {
          installRecipeFromFile(path.join(tdir, f), {
            recipesDir: path.join(dir, "all-templates"),
          });
        } catch (err) {
          failed.push(`${f}: ${(err as Error).message}`);
        }
      }
      expect(failed).toEqual([]);
    });
  });

  it("rejects unknown extensions", () => {
    const src = path.join(dir, "recipe.toml");
    writeFileSync(src, "name = 'x'");
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow(
      /Expected \.json, \.yaml, or \.yml/,
    );
  });

  it("propagates parser errors", () => {
    const src = writeRecipe("bad", { name: "x" }); // missing required fields
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow();
  });

  describe("path-traversal defence (audit 2026-05-17)", () => {
    it("neutralizes recipe.name with .. segments — only the final segment is kept", () => {
      // Registry-scope normalization (`stripRecipeScope`) reduces a
      // `/`-delimited name to its last segment BEFORE validation. A
      // traversal payload like `../../../etc/cron.d/pwn` collapses to
      // the bare slug `pwn` — the `..` segments are discarded, so no
      // path can escape recipesDir. The file lands at `pwn.json`.
      const src = writeRecipe("attacker", {
        ...SIMPLE,
        name: "../../../etc/cron.d/pwn",
      });
      const recipesDir = path.join(dir, "recipes");
      const result = installRecipeFromFile(src, { recipesDir });
      expect(result.installedPath).toBe(path.join(recipesDir, "pwn.json"));
    });

    it("normalizes recipe.name with a forward-slash separator to the final segment", () => {
      const src = writeRecipe("attacker", { ...SIMPLE, name: "foo/bar" });
      const recipesDir = path.join(dir, "recipes");
      const result = installRecipeFromFile(src, { recipesDir });
      expect(result.installedPath).toBe(path.join(recipesDir, "bar.json"));
    });

    it("rejects a slash-separated name whose final segment is not kebab-case", () => {
      const src = writeRecipe("attacker", { ...SIMPLE, name: "foo/Bar" });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("rejects recipe.name with backslash separator (Windows)", () => {
      const src = writeRecipe("attacker", {
        ...SIMPLE,
        name: "foo\\..\\..\\evil",
      });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("rejects recipe.name with uppercase chars (kebab-case enforced)", () => {
      const src = writeRecipe("attacker", { ...SIMPLE, name: "ABC" });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("rejects recipe.name with underscore (kebab-case enforced)", () => {
      const src = writeRecipe("attacker", { ...SIMPLE, name: "with_under" });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("rejects recipe.name starting with hyphen", () => {
      const src = writeRecipe("attacker", { ...SIMPLE, name: "-leading-dash" });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("rejects recipe.name longer than 64 chars", () => {
      const src = writeRecipe("attacker", {
        ...SIMPLE,
        name: "a".repeat(65),
      });
      expect(() =>
        installRecipeFromFile(src, { recipesDir: path.join(dir, "recipes") }),
      ).toThrow(/name must match/);
    });

    it("accepts canonical kebab-case names", () => {
      const src = writeRecipe("ok", { ...SIMPLE, name: "morning-brief" });
      const result = installRecipeFromFile(src, {
        recipesDir: path.join(dir, "recipes"),
      });
      expect(result.action).toBe("created");
    });
  });

  // ─── atomic write (audit 2026-05-17) ──────────────────────────────────────
  // Default write path uses temp+rename. Two concurrent installs of the
  // same recipe (cross-process) used to interleave bytes within the
  // JSON payload (torn file → recipe invisible to the scheduler).
  // Temp+rename guarantees the destination is either old content or
  // new content, never partial.
  describe("atomic write", () => {
    it("leaves no .tmp.* sibling after a successful install", () => {
      const src = writeRecipe("source", SIMPLE);
      const recipesDir = path.join(dir, "recipes");
      installRecipeFromFile(src, { recipesDir });
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const entries = readdirSync(recipesDir);
      expect(entries.filter((e: string) => e.includes(".tmp."))).toEqual([]);
      expect(entries).toContain("sentry-autofix.json");
    });

    it("installed file is always valid JSON (no torn payload)", () => {
      const src = writeRecipe("source", SIMPLE);
      const recipesDir = path.join(dir, "recipes");
      const result = installRecipeFromFile(src, { recipesDir });
      // The file on disk parses to a recipe object — the temp+rename
      // path can't observe a half-written JSON document.
      const parsed = JSON.parse(readFileSync(result.installedPath, "utf-8"));
      expect(parsed.name).toBe("sentry-autofix");
    });

    it("repeated installs converge to the latest payload (last writer wins)", () => {
      const recipesDir = path.join(dir, "recipes");
      const srcA = writeRecipe("source-a", { ...SIMPLE, version: "1.1" });
      const srcB = writeRecipe("source-b", { ...SIMPLE, version: "2.0" });
      installRecipeFromFile(srcA, { recipesDir });
      const second = installRecipeFromFile(srcB, { recipesDir });
      const parsed = JSON.parse(readFileSync(second.installedPath, "utf-8"));
      expect(parsed.version).toBe("2.0");
      expect(second.action).toBe("replaced");
    });
  });
});
