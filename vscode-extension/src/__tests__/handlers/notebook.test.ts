import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createNotebookHandlers } from "../../handlers/notebook";
import { __reset } from "../__mocks__/vscode";

function setup() {
  const { handlers } = createNotebookHandlers();
  return { handlers };
}

beforeEach(() => {
  __reset();
});

// ── helpers ────────────────────────────────────────────────────

function makeMockCell(
  overrides: Partial<{
    index: number;
    kind: number;
    outputs: any[];
    executionSummary: any;
    document: any;
  }> = {},
) {
  return {
    index: overrides.index ?? 0,
    kind: overrides.kind ?? 2, // Code
    outputs: overrides.outputs ?? [],
    executionSummary: overrides.executionSummary ?? { executionOrder: 1 },
    document: overrides.document ?? {
      languageId: "python",
      getText: () => "print('hello')",
    },
  };
}

function makeMockNotebook(cells: any[]) {
  return {
    getCells: () => cells,
    cellAt: vi.fn((idx: number) => cells[idx] ?? null),
    cellCount: cells.length,
  };
}

// ── getNotebookCells ───────────────────────────────────────────

describe("getNotebookCells", () => {
  it("returns cells from a notebook", async () => {
    const cells = [
      makeMockCell({ index: 0 }),
      makeMockCell({ index: 1, kind: 1 }),
    ];
    const notebook = makeMockNotebook(cells);
    vi.mocked(vscode.workspace.openNotebookDocument).mockResolvedValue(
      notebook as any,
    );

    const { handlers } = setup();
    const result = (await handlers["extension/getNotebookCells"]({
      file: "/test.ipynb",
    })) as any;
    expect(result.cellCount).toBe(2);
    expect(result.cells).toHaveLength(2);
  });

  it("throws when file is missing", async () => {
    const { handlers } = setup();
    await expect(handlers["extension/getNotebookCells"]({})).rejects.toThrow(
      "file is required",
    );
  });
});

// ── runNotebookCell ────────────────────────────────────────────

describe("runNotebookCell", () => {
  it("runs a cell and returns output", async () => {
    const cell = makeMockCell({ index: 0, outputs: [] });
    const notebook = makeMockNotebook([cell]);
    vi.mocked(vscode.workspace.openNotebookDocument).mockResolvedValue(
      notebook as any,
    );
    vi.mocked(vscode.window.showNotebookDocument).mockResolvedValue(
      undefined as any,
    );

    // Simulate execution completing immediately (deferred so `timer` is initialized first)
    vi.mocked(
      vscode.notebooks.onDidChangeNotebookCellExecutionState,
    ).mockImplementation((cb) => {
      Promise.resolve().then(() =>
        cb({ cell, state: vscode.NotebookCellExecutionState.Idle } as any),
      );
      return { dispose: vi.fn() };
    });

    const { handlers } = setup();
    const result = (await handlers["extension/runNotebookCell"]({
      file: "/test.ipynb",
      cellIndex: 0,
    })) as any;
    expect(result.cellIndex).toBe(0);
    expect(Array.isArray(result.output)).toBe(true);
  });

  it("throws when file is missing", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/runNotebookCell"]({ cellIndex: 0 }),
    ).rejects.toThrow("file is required");
  });

  it("throws when cellIndex is missing", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/runNotebookCell"]({ file: "/test.ipynb" }),
    ).rejects.toThrow("cellIndex is required");
  });

  // BUG 1: notebook.cellAt() returns null after execution (notebook modified/disposed)
  it("returns error response when cellAt returns null after execution", async () => {
    const cell = makeMockCell({ index: 0 });
    const notebook = makeMockNotebook([cell]);
    vi.mocked(vscode.workspace.openNotebookDocument).mockResolvedValue(
      notebook as any,
    );
    vi.mocked(vscode.window.showNotebookDocument).mockResolvedValue(
      undefined as any,
    );

    vi.mocked(
      vscode.notebooks.onDidChangeNotebookCellExecutionState,
    ).mockImplementation((cb) => {
      Promise.resolve().then(() => {
        // After execution completes, simulate notebook modification: cellAt returns null
        notebook.cellAt.mockImplementation(() => null);
        cb({ cell, state: vscode.NotebookCellExecutionState.Idle } as any);
      });
      return { dispose: vi.fn() };
    });

    const { handlers } = setup();
    // Should NOT throw — should return a graceful error response
    await expect(
      handlers["extension/runNotebookCell"]({
        file: "/test.ipynb",
        cellIndex: 0,
      }),
    ).rejects.toThrow("Cell at index 0 is no longer available");
  });
});

// ── getNotebookOutput ──────────────────────────────────────────

describe("getNotebookOutput", () => {
  it("returns output for a cell", async () => {
    const cell = makeMockCell({ index: 0 });
    const notebook = makeMockNotebook([cell]);
    vi.mocked(vscode.workspace.openNotebookDocument).mockResolvedValue(
      notebook as any,
    );

    const { handlers } = setup();
    const result = (await handlers["extension/getNotebookOutput"]({
      file: "/test.ipynb",
      cellIndex: 0,
    })) as any;
    expect(result.cellIndex).toBe(0);
    expect(Array.isArray(result.output)).toBe(true);
  });

  it("throws when cell not found", async () => {
    const notebook = makeMockNotebook([]);
    vi.mocked(vscode.workspace.openNotebookDocument).mockResolvedValue(
      notebook as any,
    );

    const { handlers } = setup();
    await expect(
      handlers["extension/getNotebookOutput"]({
        file: "/test.ipynb",
        cellIndex: 5,
      }),
    ).rejects.toThrow("Cell at index 5 not found");
  });
});
