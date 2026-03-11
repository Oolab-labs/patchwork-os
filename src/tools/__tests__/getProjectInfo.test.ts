import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGetProjectInfoTool } from "../getProjectInfo.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("getProjectInfo tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-info-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("works on an empty temp directory and returns a name", async () => {
    const tool = createGetProjectInfoTool(tmpDir);
    const result = await tool.handler();
    const data = parse(result);

    expect(data.workspace).toBe(tmpDir);
    expect(data.project).toBeDefined();
    // For an unknown project type, name should be the basename of the directory
    const project = Array.isArray(data.project)
      ? data.project[0]
      : data.project;
    expect(project.name).toBeDefined();
    expect(typeof project.name).toBe("string");
    expect(project.name.length).toBeGreaterThan(0);
  });

  it("detects TypeScript when tsconfig.json is present", async () => {
    // Create a minimal package.json + tsconfig.json
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "ts-project", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: {} }),
    );

    const tool = createGetProjectInfoTool(tmpDir);
    const result = await tool.handler();
    const data = parse(result);

    const project = Array.isArray(data.project)
      ? data.project[0]
      : data.project;
    expect(project.type).toBe("typescript");
    expect(project.name).toBe("ts-project");
  });

  it("returns the workspace basename as name for unknown project type", async () => {
    const tool = createGetProjectInfoTool(tmpDir);
    const result = await tool.handler();
    const data = parse(result);

    const project = Array.isArray(data.project)
      ? data.project[0]
      : data.project;
    expect(project.name).toBe(path.basename(tmpDir));
  });
});
