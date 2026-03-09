import * as vscode from "vscode";
import type { RequestHandler } from "../types";

export function createTaskHandlers(): {
  handlers: Record<string, RequestHandler>;
  disposeAll: () => void;
} {
  const handleListTasks: RequestHandler = async () => {
    const tasks = await vscode.tasks.fetchTasks();
    const serialized = tasks.map((t) => ({
      name: t.name,
      type: t.definition.type,
      source: t.source,
      group: t.group?.id,
      detail: t.detail,
    }));
    return { tasks: serialized, count: serialized.length };
  };

  const handleRunTask: RequestHandler = async (params) => {
    const name = params.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("name is required");
    }
    const type = typeof params.type === "string" ? params.type : undefined;
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000;

    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((t) =>
      t.name === name && (type === undefined || t.definition.type === type),
    );

    if (!task) {
      throw new Error(
        `Task "${name}"${type ? ` (type: ${type})` : ""} not found. Available: ${tasks.map((t) => t.name).join(", ")}`,
      );
    }

    const execution = await vscode.tasks.executeTask(task);
    const startTime = Date.now();

    // Wait for the task process to end
    const result = await new Promise<{ exitCode: number | undefined; durationMs: number }>(
      (resolve) => {
        let settled = false;
        let taskEndGraceTimer: ReturnType<typeof setTimeout> | null = null;

        const settle = (exitCode: number | undefined) => {
          if (settled) return;
          settled = true;
          if (taskEndGraceTimer) clearTimeout(taskEndGraceTimer);
          clearTimeout(timeoutId);
          processDisposable.dispose();
          taskEndDisposable.dispose();
          resolve({ exitCode, durationMs: Date.now() - startTime });
        };

        // onDidEndTaskProcess fires with exit code when process exits
        const processDisposable = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution === execution) {
            settle(e.exitCode);
          }
        });

        // Fallback: if no process event fires (e.g. shell task), listen for task end
        const taskEndDisposable = vscode.tasks.onDidEndTask((e) => {
          if (e.execution === execution) {
            // Give the process event a moment to fire first
            taskEndGraceTimer = setTimeout(() => settle(undefined), 500);
          }
        });

        // Timeout — disposes both listeners via settle()
        const timeoutId = setTimeout(() => settle(undefined), timeoutMs);
      },
    );

    return {
      name: task.name,
      type: task.definition.type,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      success: result.exitCode === 0 || result.exitCode === undefined,
    };
  };

  return {
    handlers: {
      "extension/listTasks": handleListTasks,
      "extension/runTask": handleRunTask,
    },
    disposeAll() {
      // No persistent state to clean up
    },
  };
}
