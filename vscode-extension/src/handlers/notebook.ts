import * as vscode from "vscode";
import { MAX_OUTPUT_BYTES } from "../constants";
import type { RequestHandler } from "../types";

function serializeCellOutput(cell: vscode.NotebookCell): unknown[] {
  const results: unknown[] = [];
  let totalBytes = 0;

  for (const output of cell.outputs) {
    for (const item of output.items) {
      if (totalBytes >= MAX_OUTPUT_BYTES) break;

      if (
        item.mime === "text/plain" ||
        item.mime === "text/html" ||
        item.mime === "application/vnd.code.notebook.stdout" ||
        item.mime === "application/vnd.code.notebook.stderr"
      ) {
        const text = new TextDecoder().decode(item.data);
        const bytes = item.data.byteLength;
        totalBytes += bytes;
        results.push({
          mime: item.mime,
          text:
            totalBytes > MAX_OUTPUT_BYTES
              ? `${text.slice(0, MAX_OUTPUT_BYTES - (totalBytes - bytes))}\n[truncated]`
              : text,
        });
      } else if (item.mime.startsWith("text/")) {
        const text = new TextDecoder().decode(item.data);
        totalBytes += item.data.byteLength;
        results.push({ mime: item.mime, text });
      } else {
        results.push({
          mime: item.mime,
          text: `[binary ${item.data.byteLength} bytes]`,
        });
      }
    }
  }

  return results;
}

export function createNotebookHandlers(): {
  handlers: Record<string, RequestHandler>;
  disposeAll: () => void;
} {
  const handleGetNotebookCells: RequestHandler = async (params) => {
    const file = params.file;
    if (typeof file !== "string") throw new Error("file is required");

    const uri = vscode.Uri.file(file);
    const notebook = await vscode.workspace.openNotebookDocument(uri);

    const cells = notebook.getCells().map((cell) => ({
      index: cell.index,
      kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
      languageId: cell.document.languageId,
      source: cell.document.getText(),
      executionCount: cell.executionSummary?.executionOrder ?? null,
      hasOutput: cell.outputs.length > 0,
    }));

    return { file, cellCount: cells.length, cells };
  };

  const handleRunNotebookCell: RequestHandler = async (params) => {
    const file = params.file;
    const cellIndex = params.cellIndex;
    if (typeof file !== "string") throw new Error("file is required");
    if (typeof cellIndex !== "number") throw new Error("cellIndex is required");

    const timeoutMs =
      typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    const uri = vscode.Uri.file(file);
    const notebook = await vscode.workspace.openNotebookDocument(uri);

    // Notebook must be visible for execution
    await vscode.window.showNotebookDocument(notebook);

    const cell = notebook.cellAt(cellIndex);
    if (!cell) {
      throw new Error(
        `Cell at index ${cellIndex} not found (notebook has ${notebook.cellCount} cells)`,
      );
    }

    const startTime = Date.now();

    // Execute the cell via command
    await vscode.commands.executeCommand("notebook.cell.execute", {
      ranges: [{ start: cellIndex, end: cellIndex + 1 }],
      document: uri,
    });

    // Wait for execution to complete
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        disposable.dispose();
        resolve();
      };
      // onDidChangeNotebookCellExecutionState was removed in VS Code 1.88+; fall back to a no-op disposable
      const notebooks = vscode.notebooks as unknown as {
        onDidChangeNotebookCellExecutionState?: (
          cb: (e: { cell: vscode.NotebookCell; state: number }) => void,
        ) => vscode.Disposable;
      };
      const disposable = notebooks.onDidChangeNotebookCellExecutionState
        ? notebooks.onDidChangeNotebookCellExecutionState((e) => {
            const IdleState = (
              vscode as unknown as {
                NotebookCellExecutionState?: { Idle: number };
              }
            ).NotebookCellExecutionState?.Idle;
            if (
              e.cell === cell &&
              IdleState !== undefined &&
              e.state === IdleState
            ) {
              finish();
            }
          })
        : { dispose: () => {} };
      const timer = setTimeout(finish, timeoutMs);
    });

    const postCell = notebook.cellAt(cellIndex);
    if (!postCell) {
      throw new Error(
        `Cell at index ${cellIndex} is no longer available (notebook was modified during execution)`,
      );
    }
    const output = serializeCellOutput(postCell);
    return {
      cellIndex,
      durationMs: Date.now() - startTime,
      executionCount: postCell.executionSummary?.executionOrder ?? null,
      output,
    };
  };

  const handleGetNotebookOutput: RequestHandler = async (params) => {
    const file = params.file;
    const cellIndex = params.cellIndex;
    if (typeof file !== "string") throw new Error("file is required");
    if (typeof cellIndex !== "number") throw new Error("cellIndex is required");

    const uri = vscode.Uri.file(file);
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    const cell = notebook.cellAt(cellIndex);
    if (!cell) {
      throw new Error(`Cell at index ${cellIndex} not found`);
    }

    return {
      cellIndex,
      executionCount: cell.executionSummary?.executionOrder ?? null,
      output: serializeCellOutput(cell),
    };
  };

  return {
    handlers: {
      "extension/getNotebookCells": handleGetNotebookCells,
      "extension/runNotebookCell": handleRunNotebookCell,
      "extension/getNotebookOutput": handleGetNotebookOutput,
    },
    disposeAll() {
      // No persistent state to clean up
    },
  };
}
