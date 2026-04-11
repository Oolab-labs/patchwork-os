import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleListTasks, handleRunTask } from "../../handlers/tasks";
import { __reset } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function makeTask(
  overrides: Partial<{
    name: string;
    type: string;
    source: string;
    groupId: string | null;
    detail: string | null;
  }> = {},
): any {
  return {
    name: overrides.name ?? "build",
    definition: { type: overrides.type ?? "shell" },
    source: overrides.source ?? "Workspace",
    group:
      overrides.groupId !== undefined && overrides.groupId !== null
        ? { id: overrides.groupId }
        : overrides.groupId === null
          ? null
          : undefined,
    detail: overrides.detail ?? null,
  };
}

describe("handleListTasks", () => {
  it("returns empty task list when no tasks defined", async () => {
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([]);
    const result = (await handleListTasks()) as any;
    expect(result.tasks).toEqual([]);
  });

  it("returns tasks with expected shape", async () => {
    const task = makeTask({
      name: "build",
      type: "npm",
      source: "Workspace",
      groupId: "build",
      detail: "Run the build script",
    });
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([task]);
    const result = (await handleListTasks()) as any;
    expect(result.tasks).toHaveLength(1);
    const t = result.tasks[0];
    expect(t.name).toBe("build");
    expect(t.type).toBe("npm");
    expect(t.source).toBe("Workspace");
    expect(t.group).toBe("build");
    expect(t.detail).toBe("Run the build script");
  });

  it("returns null for group when task has no group", async () => {
    const task = makeTask({ groupId: null });
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([task]);
    const result = (await handleListTasks()) as any;
    expect(result.tasks[0].group).toBeNull();
  });

  it("returns null for detail when task has no detail", async () => {
    const task = makeTask({ detail: null });
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([task]);
    const result = (await handleListTasks()) as any;
    expect(result.tasks[0].detail).toBeNull();
  });
});

describe("handleRunTask", () => {
  it("returns error when task not found", async () => {
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([]);
    const result = (await handleRunTask({ name: "missing" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Task not found: missing/);
  });

  it("runs task and returns exit code on completion", async () => {
    const task = makeTask({ name: "test" });
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([task]);

    const mockExec = { terminate: vi.fn() };
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue(mockExec as any);

    // Simulate onDidEndTaskProcess firing with exit code 0
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockImplementation(
      (listener: (e: any) => void) => {
        // Fire immediately
        setImmediate(() => listener({ execution: mockExec, exitCode: 0 }));
        return { dispose: vi.fn() };
      },
    );

    const result = (await handleRunTask({
      name: "test",
      timeoutMs: 5000,
    })) as any;
    expect(result.success).toBe(true);
    expect(result.name).toBe("test");
    expect(result.exitCode).toBe(0);
  });

  it("returns timeout error and terminates task when it runs too long", async () => {
    const task = makeTask({ name: "slow" });
    vi.mocked(vscode.tasks.fetchTasks).mockResolvedValue([task]);

    const mockExec = { terminate: vi.fn() };
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue(mockExec as any);

    // onDidEndTaskProcess never fires
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockReturnValue({
      dispose: vi.fn(),
    });

    // Use very short timeout
    const result = (await handleRunTask({
      name: "slow",
      timeoutMs: 50,
    })) as any;
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/timed out/i);
    expect(mockExec.terminate).toHaveBeenCalled();
  });

  it("filters tasks by type when type param is provided", async () => {
    const shellTask = makeTask({ name: "build", type: "shell" });
    const npmTask = makeTask({ name: "build", type: "npm" });
    vi.mocked(vscode.tasks.fetchTasks).mockImplementation(
      async (filter?: any) => {
        if (filter?.type === "npm") return [npmTask];
        return [shellTask, npmTask];
      },
    );

    const mockExec = { terminate: vi.fn() };
    vi.mocked(vscode.tasks.executeTask).mockResolvedValue(mockExec as any);
    vi.mocked(vscode.tasks.onDidEndTaskProcess).mockImplementation(
      (listener: (e: any) => void) => {
        setImmediate(() => listener({ execution: mockExec, exitCode: 0 }));
        return { dispose: vi.fn() };
      },
    );

    const result = (await handleRunTask({
      name: "build",
      type: "npm",
      timeoutMs: 5000,
    })) as any;
    expect(result.success).toBe(true);
    // Should have filtered to npm type
    expect(vscode.tasks.fetchTasks).toHaveBeenCalledWith({ type: "npm" });
  });
});
