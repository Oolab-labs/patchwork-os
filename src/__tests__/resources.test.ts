import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listResources, readResource } from "../resources.js";

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "resources-test-"));
  fs.writeFileSync(path.join(workspace, "index.ts"), "export const x = 1;");
  fs.writeFileSync(path.join(workspace, "data.json"), '{"a":1}');
  fs.writeFileSync(path.join(workspace, "README.md"), "# readme");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "util.ts"), "export {};");
  // node_modules dir should be skipped
  fs.mkdirSync(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "pkg", "index.js"), "");
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("listResources", () => {
  it("returns MCP Resource objects for workspace files", () => {
    const result = listResources(workspace);
    expect(result.resources.length).toBeGreaterThanOrEqual(4);
    const names = result.resources.map((r) => r.name);
    expect(names).toContain("README.md");
    expect(names).toContain("index.ts");
    expect(names).toContain("data.json");
    expect(names).toContain(path.join("src", "util.ts"));
  });

  it("skips node_modules", () => {
    const result = listResources(workspace);
    const names = result.resources.map((r) => r.name);
    expect(names.every((n) => !n.includes("node_modules"))).toBe(true);
  });

  it("assigns file:// URIs", () => {
    const result = listResources(workspace);
    for (const r of result.resources) {
      expect(r.uri).toMatch(/^file:\/\//);
    }
  });

  it("assigns correct mimeType", () => {
    const result = listResources(workspace);
    const json = result.resources.find((r) => r.name === "data.json");
    expect(json?.mimeType).toBe("application/json");
    const md = result.resources.find((r) => r.name === "README.md");
    expect(md?.mimeType).toBe("text/markdown");
  });

  it("paginates correctly with cursor", () => {
    // Create extra files to force pagination
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(workspace, `file${i}.ts`), "");
    }
    const page1 = listResources(workspace);
    expect(page1.resources).toHaveLength(50);
    expect(page1.nextCursor).toBeDefined();

    const page2 = listResources(workspace, page1.nextCursor);
    expect(page2.resources.length).toBeGreaterThan(0);
    // No overlap
    const uris1 = new Set(page1.resources.map((r) => r.uri));
    for (const r of page2.resources) {
      expect(uris1.has(r.uri)).toBe(false);
    }
    // Clean up
    for (let i = 0; i < 60; i++) {
      fs.rmSync(path.join(workspace, `file${i}.ts`), { force: true });
    }
  });

  it("returns no nextCursor when all files fit on one page", () => {
    const result = listResources(workspace);
    // After cleanup, we have < 50 files
    expect(result.nextCursor).toBeUndefined();
  });

  it("ignores a malformed cursor and starts from beginning", () => {
    const result = listResources(workspace, "!!!not-base64!!!");
    expect(result.resources.length).toBeGreaterThan(0);
  });
});

describe("readResource", () => {
  it("reads a file by URI and returns its text content", () => {
    const uri = `file://${path.join(workspace, "index.ts")}`;
    const result = readResource(workspace, uri);
    expect("contents" in result).toBe(true);
    if (!("contents" in result)) return;
    expect(result.contents[0]?.text).toBe("export const x = 1;");
    expect(result.contents[0]?.mimeType).toBe("text/plain");
    expect(result.contents[0]?.uri).toBe(uri);
  });

  it("rejects non-file:// URIs", () => {
    const result = readResource(workspace, "https://example.com/file.ts");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.code).toBe("invalid_args");
  });

  it("rejects URIs outside the workspace", () => {
    const result = readResource(workspace, "file:///etc/passwd");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.code).toBe("workspace_escape");
  });

  it("returns file_not_found for missing file", () => {
    const result = readResource(workspace, `file://${path.join(workspace, "nonexistent.ts")}`);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.code).toBe("file_not_found");
  });

  it("rejects binary/unsupported extensions", () => {
    const binPath = path.join(workspace, "image.png");
    fs.writeFileSync(binPath, "fake png data");
    const result = readResource(workspace, `file://${binPath}`);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.code).toBe("invalid_args");
    fs.rmSync(binPath);
  });
});
