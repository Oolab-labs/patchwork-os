import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { __reset } from "../__mocks__/vscode";
import { createDecorationHandlers } from "../../handlers/decorations";

function setup() {
  const { handlers, disposeAll } = createDecorationHandlers();
  return { handlers, disposeAll };
}

beforeEach(() => {
  __reset();
});

// ── setDecorations ────────────────────────────────────────────

describe("setDecorations", () => {
  it("creates a decoration entry and applies to visible editors", async () => {
    const setDecorations = vi.fn();
    const editor = {
      document: { uri: { fsPath: "/test.ts" } },
      setDecorations,
    };
    vscode.window.visibleTextEditors = [editor as any];

    const { handlers } = setup();
    const result = (await handlers["extension/setDecorations"]({
      id: "highlight-1",
      file: "/test.ts",
      decorations: [{ startLine: 1, endLine: 1, style: "info" }],
    })) as any;

    expect(result.applied).toBe(1);
    expect(result.editorsUpdated).toBe(1);
    expect(setDecorations).toHaveBeenCalled();
  });

  it("throws on invalid id", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/setDecorations"]({ id: "bad id!", file: "/test.ts", decorations: [] }),
    ).rejects.toThrow("alphanumeric");
  });

  it("throws on missing id", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/setDecorations"]({ file: "/test.ts", decorations: [] }),
    ).rejects.toThrow("id is required");
  });

  it("throws on missing file", async () => {
    const { handlers } = setup();
    await expect(
      handlers["extension/setDecorations"]({ id: "x", decorations: [] }),
    ).rejects.toThrow("file is required");
  });

  it("disposes old decoration type when style changes", async () => {
    const disposeOld = vi.fn();
    const firstType = { dispose: disposeOld };
    vi.mocked(vscode.window.createTextEditorDecorationType)
      .mockReturnValueOnce(firstType as any)
      .mockReturnValue({ dispose: vi.fn() } as any);

    const { handlers } = setup();
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });
    // Change style
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "error" }],
    });

    expect(disposeOld).toHaveBeenCalled();
  });

  // BUG 2: When style changes, the old type is disposed while the entry still exists
  // in `activeDecorations`. If the `onDidChangeVisibleTextEditors` listener fires
  // synchronously inside `dispose()` (e.g. VS Code fires it when an editor loses
  // its decorations), it iterates `activeDecorations` and calls applyToEditor with
  // the already-disposed type. Fix: remove the entry from the map BEFORE disposing,
  // so the listener can never find the stale entry.
  it("does not apply decorations with a disposed type when editor becomes visible during dispose (BUG 2)", async () => {
    // Capture the onDidChangeVisibleTextEditors listener
    let visibilityListener: ((editors: any[]) => void) | undefined;
    vi.mocked(vscode.window.onDidChangeVisibleTextEditors).mockImplementation((cb) => {
      visibilityListener = cb;
      return { dispose: vi.fn() };
    });

    const applyCallsWithFirstType: any[][] = [];
    const newEditor = {
      document: { uri: { fsPath: "/test.ts" } },
      setDecorations: vi.fn(),
    };

    const firstType = {
      dispose: vi.fn(() => {
        // Simulate VS Code firing onDidChangeVisibleTextEditors synchronously during dispose
        if (visibilityListener) {
          visibilityListener([newEditor]);
        }
      }),
    };
    vi.mocked(vscode.window.createTextEditorDecorationType)
      .mockReturnValueOnce(firstType as any)
      .mockReturnValue({ dispose: vi.fn() } as any);

    const { handlers } = setup();

    // Set decorations with style "info"
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });

    // Change style — this triggers dispose of firstType, which fires the listener mid-dispose
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 2, style: "error" }],
    });

    // The listener fired during dispose — it must NOT have called setDecorations with firstType
    for (const call of newEditor.setDecorations.mock.calls) {
      expect(call[0]).not.toBe(firstType);
    }
  });
});

// ── clearDecorations ──────────────────────────────────────────

describe("clearDecorations", () => {
  it("clears a specific decoration by id", async () => {
    const disposeType = vi.fn();
    vi.mocked(vscode.window.createTextEditorDecorationType).mockReturnValue({
      dispose: disposeType,
    } as any);

    const setDecorations = vi.fn();
    const editor = {
      document: { uri: { fsPath: "/test.ts" } },
      setDecorations,
    };
    vscode.window.visibleTextEditors = [editor as any];

    const { handlers } = setup();
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });

    const result = (await handlers["extension/clearDecorations"]({ id: "x" })) as any;
    expect(result.cleared).toBe(1);
    expect(disposeType).toHaveBeenCalled();
  });

  it("returns 0 when id not found", async () => {
    const { handlers } = setup();
    const result = (await handlers["extension/clearDecorations"]({ id: "nonexistent" })) as any;
    expect(result.cleared).toBe(0);
  });

  it("clears all decorations when no id given", async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    vi.mocked(vscode.window.createTextEditorDecorationType)
      .mockReturnValueOnce({ dispose: disposeA } as any)
      .mockReturnValueOnce({ dispose: disposeB } as any);

    const { handlers } = setup();
    await handlers["extension/setDecorations"]({
      id: "a",
      file: "/a.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });
    await handlers["extension/setDecorations"]({
      id: "b",
      file: "/b.ts",
      decorations: [{ startLine: 1, style: "warning" }],
    });

    const result = (await handlers["extension/clearDecorations"]({})) as any;
    expect(result.cleared).toBe(2);
    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalled();
  });

  it("editors are cleared BEFORE the type is disposed (ordering guard)", async () => {
    const callOrder: string[] = [];
    const disposeType = vi.fn(() => callOrder.push("dispose"));
    vi.mocked(vscode.window.createTextEditorDecorationType).mockReturnValue({
      dispose: disposeType,
    } as any);

    const setDecorations = vi.fn((_type: any, _ranges: any[]) => callOrder.push("clear"));
    const editor = {
      document: { uri: { fsPath: "/test.ts" } },
      setDecorations,
    };
    vscode.window.visibleTextEditors = [editor as any];

    const { handlers } = setup();
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });

    // Reset to track only clear-then-dispose ordering for the clearDecorations call
    callOrder.length = 0;

    await handlers["extension/clearDecorations"]({ id: "x" });

    // "clear" must come before "dispose"
    const clearIdx = callOrder.indexOf("clear");
    const disposeIdx = callOrder.indexOf("dispose");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThan(clearIdx);
  });
});

// ── disposeAll ────────────────────────────────────────────────

describe("disposeAll", () => {
  it("disposes all active decoration types", async () => {
    const dispose = vi.fn();
    vi.mocked(vscode.window.createTextEditorDecorationType).mockReturnValue({ dispose } as any);

    const { handlers, disposeAll } = setup();
    await handlers["extension/setDecorations"]({
      id: "x",
      file: "/test.ts",
      decorations: [{ startLine: 1, style: "info" }],
    });
    disposeAll();
    expect(dispose).toHaveBeenCalled();
  });
});
