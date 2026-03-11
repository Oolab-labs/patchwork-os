import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCreateSnapshotTool,
  createDeleteSnapshotTool,
  createListSnapshotsTool,
  createRestoreSnapshotTool,
  createShowSnapshotTool,
} from "../workspaceSnapshots.js";

function parse(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content.at(0)?.text ?? "{}");
}

describe("workspaceSnapshots tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execSync("git config user.name Test", { cwd: tmpDir, stdio: "ignore" });
    // Need at least one commit for git stash to work
    fs.writeFileSync(path.join(tmpDir, "base.txt"), "base content\n");
    execSync("git add base.txt", { cwd: tmpDir, stdio: "ignore" });
    execSync('git commit -m "initial commit"', {
      cwd: tmpDir,
      stdio: "ignore",
    });
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
    const found = data.snapshots.find(
      (s: { name: string }) => s.name === "list-test-snapshot",
    );
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

  it("restoreSnapshot by index-only detects stash index drift when a new stash is created after listing", async () => {
    // Setup: create a snapshot so it gets stash index 0
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "my-snapshot" });

    // List to confirm the snapshot is at index 0
    const listTool = createListSnapshotsTool(tmpDir);
    const listResult = await listTool.handler({});
    const listData = parse(listResult);
    const snap = listData.snapshots.find(
      (s: { name: string }) => s.name === "my-snapshot",
    );
    expect(snap).toBeDefined();
    expect(snap.index).toBe(0);

    // Simulate index drift: push a new (non-snapshot) stash on top, shifting "my-snapshot" to index 1.
    // The new stash does NOT have the claude-snapshot prefix.
    fs.writeFileSync(
      path.join(tmpDir, "base.txt"),
      "another change for drift\n",
    );
    execSync('git stash push -m "unrelated stash"', {
      cwd: tmpDir,
      stdio: "ignore",
    });

    // Restore by original index 0 (which now points to the unrelated stash, not a claude-snapshot).
    // Before the fix: the wrong stash was silently applied.
    // After the fix: the tool returns an error because index 0 is not a claude-snapshot.
    const restoreTool = createRestoreSnapshotTool(tmpDir);
    const restoreResult = await restoreTool.handler({ index: 0 });

    // Must be an error — stash drift detected because index 0 is no longer a claude-snapshot
    expect((restoreResult as { isError?: boolean }).isError).toBe(true);
    const restoreData = parse(restoreResult);
    expect(typeof restoreData).toBe("string");
    expect(restoreData).toMatch(/No claude-snapshot found at stash index 0/);
  });

  it("restoreSnapshot by index-only includes resolvedName in success response", async () => {
    // Setup: create a snapshot at index 0, then commit changes so working tree is clean
    // (git stash apply fails if working tree already contains the same changes)
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "named-snapshot" });

    // Commit the current working tree so stash apply can proceed without conflict
    execSync("git add -A && git commit -qm 'interim commit'", {
      cwd: tmpDir,
      stdio: "ignore",
    });

    const restoreTool = createRestoreSnapshotTool(tmpDir);
    const restoreResult = await restoreTool.handler({ index: 0 });
    const restoreData = parse(restoreResult);

    // After the fix: even when no name is provided, the response includes resolvedName
    // so the caller can confirm what was actually restored.
    // Before the fix: resolvedName was absent and no verification was done.
    expect(restoreData.restored).toBe(true);
    expect(restoreData.resolvedName).toBe("named-snapshot");
  });

  it("deleteSnapshot removes the snapshot from the list", async () => {
    const createTool = createCreateSnapshotTool(tmpDir);
    await createTool.handler({ name: "delete-me-snapshot" });

    const deleteTool = createDeleteSnapshotTool(tmpDir);
    const deleteResult = await deleteTool.handler({
      name: "delete-me-snapshot",
    });
    const deleteData = parse(deleteResult);
    expect(deleteData.deleted).toBe(true);

    const listTool = createListSnapshotsTool(tmpDir);
    const listResult = await listTool.handler({});
    const listData = parse(listResult);

    const stillPresent = listData.snapshots.find(
      (s: { name: string }) => s.name === "delete-me-snapshot",
    );
    expect(stillPresent).toBeUndefined();
  });
});
