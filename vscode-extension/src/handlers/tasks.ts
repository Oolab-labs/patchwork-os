import * as vscode from "vscode";

export async function handleListTasks(): Promise<unknown> {
  const tasks = await vscode.tasks.fetchTasks();
  return {
    tasks: tasks.map((task) => ({
      name: task.name,
      type: task.definition.type,
      source: task.source,
      group: task.group?.id ?? null,
      detail: task.detail ?? null,
    })),
  };
}

export async function handleRunTask(
  params: Record<string, unknown>,
): Promise<unknown> {
  const name = params.name as string;
  const type = typeof params.type === "string" ? params.type : undefined;
  const timeoutMs =
    typeof params.timeoutMs === "number"
      ? Math.min(Math.max(Math.floor(params.timeoutMs), 1_000), 300_000)
      : 60_000;

  const allTasks = await vscode.tasks.fetchTasks(type ? { type } : undefined);
  const task = allTasks.find((t) => t.name === name);

  if (!task) {
    return { success: false, error: `Task not found: ${name}` };
  }

  // Register the completion listener BEFORE starting execution so that a
  // fast-completing task (< 1 event-loop tick) cannot fire the event before
  // the listener is attached.  The listener closes over `exec` via a `let`
  // binding that is populated immediately after `executeTask` returns.
  let exec: vscode.TaskExecution | undefined;

  return new Promise<unknown>((resolve) => {
    let disposable: vscode.Disposable | undefined;

    const timer = setTimeout(() => {
      disposable?.dispose();
      exec?.terminate();
      resolve({
        success: false,
        name,
        error: "Task timed out",
        timedOut: true,
      });
    }, timeoutMs);

    // Listener is set up first; `exec` will be assigned below before any
    // microtask/macrotask can deliver the end event.
    disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== exec) return;
      clearTimeout(timer);
      disposable?.dispose();
      resolve({ success: true, name: task.name, exitCode: e.exitCode });
    });

    vscode.tasks.executeTask(task).then(
      (execution) => {
        exec = execution;
      },
      (err: unknown) => {
        clearTimeout(timer);
        disposable?.dispose();
        resolve({
          success: false,
          name,
          error: `Failed to execute task: ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    );
  });
}
