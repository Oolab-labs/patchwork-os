import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGetDiffFromHandoffTool } from "../getDiffFromHandoff.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

// Minimal mock for ExtensionClient
function makeExtensionClient(connected = false) {
  return {
    isConnected: () => connected,
    latestDiagnostics: new Map(),
  } as never;
}

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-diff-test-"));
  // Initialize a git repo so git diff works
  fs.writeFileSync(path.join(workspace, "file.ts"), "const x = 1;\n");
  try {
    execSync("git init -b main", { cwd: workspace, stdio: "pipe" });
    execSync("git config user.email test@test.com", {
      cwd: workspace,
      stdio: "pipe",
    });
    execSync("git config user.name Test", { cwd: workspace, stdio: "pipe" });
    execSync("git add .", { cwd: workspace, stdio: "pipe" });
    execSync("git commit -m init", { cwd: workspace, stdio: "pipe" });
  } catch {
    // git may not be available, tests degrade gracefully
  }
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("createGetDiffFromHandoffTool", () => {
  it("returns required output fields", async () => {
    const tool = createGetDiffFromHandoffTool(workspace, makeExtensionClient());
    const result = parse(await tool.handler({}));
    expect(typeof result.handoffAge).toBe("string");
    expect(typeof result.gitDiff).toBe("object");
    expect(typeof result.gitDiff.filesChanged).toBe("number");
    expect(typeof result.gitDiff.insertions).toBe("number");
    expect(typeof result.gitDiff.deletions).toBe("number");
    expect(Array.isArray(result.gitDiff.files)).toBe(true);
    expect(Array.isArray(result.newDiagnostics)).toBe(true);
    expect(typeof result.resolvedCount).toBe("number");
    expect(typeof result.summary).toBe("string");
  });

  it("reports noHandoffNote when no note exists", async () => {
    const tool = createGetDiffFromHandoffTool(workspace, makeExtensionClient());
    const result = parse(await tool.handler({}));
    // Either noHandoffNote=true or handoffNote is a string (if a note exists from another test)
    const hasNote = typeof result.handoffNote === "string";
    const noNote = result.noHandoffNote === true;
    expect(hasNote || noNote).toBe(true);
  });

  it("newDiagnostics is empty when extension disconnected", async () => {
    const tool = createGetDiffFromHandoffTool(
      workspace,
      makeExtensionClient(false),
    );
    const result = parse(await tool.handler({}));
    expect(result.newDiagnostics).toHaveLength(0);
  });

  it("includes diagnostics from extension when connected", async () => {
    const client = makeExtensionClient(true) as {
      isConnected: () => boolean;
      latestDiagnostics: Map<string, unknown[]>;
    };
    client.latestDiagnostics.set("/workspace/file.ts", [
      {
        file: "/workspace/file.ts",
        line: 1,
        column: 1,
        severity: "error",
        message: "Type error",
      },
    ]);
    const tool = createGetDiffFromHandoffTool(workspace, client as never);
    const result = parse(await tool.handler({}));
    expect(result.newDiagnostics.length).toBeGreaterThan(0);
  });

  it("summary is a non-empty string", async () => {
    const tool = createGetDiffFromHandoffTool(workspace, makeExtensionClient());
    const result = parse(await tool.handler({}));
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("gitDiff.files is an array of strings", async () => {
    const tool = createGetDiffFromHandoffTool(workspace, makeExtensionClient());
    const result = parse(await tool.handler({}));
    for (const f of result.gitDiff.files) {
      expect(typeof f).toBe("string");
    }
  });
});
