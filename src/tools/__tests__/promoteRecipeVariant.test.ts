import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteRecipeVariant } from "../../recipesHttp.js";

const YAML_V2 = `apiVersion: patchwork.sh/v1
name: morning-brief-v2
trigger:
  type: manual
steps:
  - agent: claude
    prompt: "Summarize my morning."
`;

const YAML_CANONICAL = `apiVersion: patchwork.sh/v1
name: morning-brief
trigger:
  type: manual
steps:
  - agent: claude
    prompt: "Old prompt."
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `promote-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string) {
  writeFileSync(path.join(tmpDir, `${name}.yaml`), content, "utf-8");
}

describe("promoteRecipeVariant", () => {
  it("promotes variant to target when target does not exist", async () => {
    write("morning-brief-v2", YAML_V2);
    const result = await promoteRecipeVariant(
      tmpDir,
      "morning-brief-v2",
      "morning-brief",
    );
    expect(result.ok).toBe(true);
    expect(result.path).toContain("morning-brief.yaml");
    // name: field should be rewritten
    const content = readFileSync(
      path.join(tmpDir, "morning-brief.yaml"),
      "utf-8",
    );
    expect(content).toMatch(/^name: morning-brief$/m);
    // variant file deleted
    expect(() =>
      readFileSync(path.join(tmpDir, "morning-brief-v2.yaml"), "utf-8"),
    ).toThrow();
  });

  it("returns targetExists when target exists and force not set", async () => {
    write("morning-brief-v2", YAML_V2);
    write("morning-brief", YAML_CANONICAL);
    const result = await promoteRecipeVariant(
      tmpDir,
      "morning-brief-v2",
      "morning-brief",
    );
    expect(result.ok).toBe(false);
    expect(result.targetExists).toBe(true);
    // original canonical should be untouched
    const content = readFileSync(
      path.join(tmpDir, "morning-brief.yaml"),
      "utf-8",
    );
    expect(content).toContain("Old prompt.");
  });

  it("overwrites target when force: true and writes audit log", async () => {
    write("morning-brief-v2", YAML_V2);
    write("morning-brief", YAML_CANONICAL);
    const result = await promoteRecipeVariant(
      tmpDir,
      "morning-brief-v2",
      "morning-brief",
      { force: true },
    );
    expect(result.ok).toBe(true);
    // canonical overwritten
    const content = readFileSync(
      path.join(tmpDir, "morning-brief.yaml"),
      "utf-8",
    );
    expect(content).toMatch(/^name: morning-brief$/m);
    expect(content).toContain("Summarize my morning.");
    // audit log written
    const audit = JSON.parse(
      readFileSync(
        path.join(tmpDir, "morning-brief.promote-audit.json"),
        "utf-8",
      ),
    );
    expect(audit.action).toBe("promote_overwrite");
    expect(audit.variantName).toBe("morning-brief-v2");
    expect(audit.targetName).toBe("morning-brief");
    expect(typeof audit.priorContentHash).toBe("string");
    expect(audit.priorContentHash).toHaveLength(64); // sha256 hex
  });

  it("returns error when variant does not exist", async () => {
    const result = await promoteRecipeVariant(
      tmpDir,
      "nonexistent-v2",
      "nonexistent",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("rejects invalid recipe names", async () => {
    const result = await promoteRecipeVariant(tmpDir, "../evil", "target");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid/i);
  });

  it("rejects same variant and target name", async () => {
    write("morning-brief", YAML_CANONICAL);
    const result = await promoteRecipeVariant(
      tmpDir,
      "morning-brief",
      "morning-brief",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/differ/i);
  });
});
