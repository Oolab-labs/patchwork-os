import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCreateSnapshotTool,
  createListSnapshotsTool,
  createShowSnapshotTool,
  createDeleteSnapshotTool,
} from "../workspaceSnapshots.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("workspaceSnapshots tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
    // Need at least one commit for git stash to work
    fs.writeFileSync(path.join(tmpDir, "base.txt"), "base content\n");
    execSync("git add base.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: "ignore" });
    // Add an uncommitted change so stash has something to save
    fs.writeFileSync(path.join(tmpDir, "base.txt"), "modified content\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createSnapshot with a name creates a stash with claude-snapshot prefix", async () => {
    const tool = createCreateSnapshotTool(tmpDir);
    const result = await tool.handler({ name: "my-test-snapshot" });
    const data = parse(result);

    expect(data.created).toBe(true);
    expect(data.name).toBe("my-test-snapshot");

    // Verify the stash entry exists and has the prefix
    const stashList = execSync("git stash list", { cwd: tmpDir }).toString();
    expect(stashList).toContain("claude-snapshot:");
    expect(stashList).toContain("my-test-snapshot");
  });

  it("listSnapshots returns the created snapshot", async () => {
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "list-test-snapshot" });

    const listTool = createListSnapshotsTool(tmpDir);
    const result = await listTool.handler({});
    const data = parse(result);

    expect(data.snapshots).toBeDefined();
    expect(data.count).toBeGreaterThanOrEqual(1);
    const found = data.snapshots.find((s: { name: string }) => s.name === "list-test-snapshot");
    expect(found).toBeDefined();
  });

  it("showSnapshot returns output for a named snapshot", async () => {
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "show-test-snapshot" });

    const showTool = createShowSnapshotTool(tmpDir);
    const result = await showTool.handler({ name: "show-test-snapshot" });
    const data = parse(result);

    expect(data.output).toBeDefined();
  });

  it("deleteSnapshot removes the snapshot from the list", async () => {
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "delete-me-snapshot" });

    const deleteTool = createDeleteSnapshotTool(tmpDir);
    const deleteResult = await deleteTool.handler({ name: "delete-me-snapshot" });
    const deleteData = parse(deleteResult);
    expect(deleteData.deleted).toBe(true);

    const listTool = createListSnapshotsTool(tmpDir);
    const listResult = await listTool.handler({});
    const listData = parse(listResult);

    const stillPresent = listData.snapshots.find((s: { name: string }) => s.name === "delete-me-snapshot");
    expect(stillPresent).toBeUndefined();
  });
});
