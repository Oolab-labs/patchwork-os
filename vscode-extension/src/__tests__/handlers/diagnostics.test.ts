import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  diagnosticToJson,
  handleGetDiagnostics,
} from "../../handlers/diagnostics";
import { __reset, Uri } from "../__mocks__/vscode";

beforeEach(() => {
  __reset();
});

function makeDiag(
  overrides: Partial<{
    message: string;
    severity: number;
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
    source: string;
    code: unknown;
  }> = {},
) {
  return {
    message: overrides.message ?? "test error",
    severity: overrides.severity ?? 0,
    range: {
      start: {
        line: overrides.startLine ?? 0,
        character: overrides.startChar ?? 0,
      },
      end: { line: overrides.endLine ?? 0, character: overrides.endChar ?? 5 },
    },
    source: overrides.source ?? "eslint",
    code: overrides.code ?? 42,
  };
}

// ── diagnosticToJson ──────────────────────────────────────────

describe("diagnosticToJson", () => {
  it("maps Error severity", () => {
    const result = diagnosticToJson(makeDiag({ severity: 0 }) as any);
    expect(result.severity).toBe("error");
  });

  it("maps Warning severity", () => {
    expect(diagnosticToJson(makeDiag({ severity: 1 }) as any).severity).toBe(
      "warning",
    );
  });

  it("maps Information severity", () => {
    expect(diagnosticToJson(makeDiag({ severity: 2 }) as any).severity).toBe(
      "information",
    );
  });

  it("maps Hint severity", () => {
    expect(diagnosticToJson(makeDiag({ severity: 3 }) as any).severity).toBe(
      "hint",
    );
  });

  it("defaults unknown severity to error", () => {
    expect(diagnosticToJson(makeDiag({ severity: 99 }) as any).severity).toBe(
      "error",
    );
  });

  it("converts range to 1-based", () => {
    const result = diagnosticToJson(
      makeDiag({ startLine: 5, startChar: 10, endLine: 5, endChar: 20 }) as any,
    );
    expect(result.line).toBe(6);
    expect(result.column).toBe(11);
    expect(result.endLine).toBe(6);
    expect(result.endColumn).toBe(21);
  });

  it("handles primitive code", () => {
    expect(diagnosticToJson(makeDiag({ code: 42 }) as any).code).toBe(42);
  });

  it("unwraps object code", () => {
    expect(
      diagnosticToJson(makeDiag({ code: { value: "no-unused-vars" } }) as any)
        .code,
    ).toBe("no-unused-vars");
  });

  it("uses empty string for missing source", () => {
    const d = makeDiag();
    (d as any).source = undefined;
    expect(diagnosticToJson(d as any).source).toBe("");
  });
});

// ── handleGetDiagnostics ──────────────────────────────────────

describe("handleGetDiagnostics", () => {
  it("returns diagnostics for a specific file", async () => {
    const diags = [
      makeDiag({ message: "err1" }),
      makeDiag({ message: "err2" }),
    ];
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue(diags as any);

    const result = (await handleGetDiagnostics({ file: "/test.ts" })) as any[];
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("err1");
  });

  it("handles file:// prefix", async () => {
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([]);
    await handleGetDiagnostics({ file: "file:///test.ts" });
    expect(vscode.languages.getDiagnostics).toHaveBeenCalled();
  });

  // Regression: the no-file branch MUST return a FLAT Diagnostic[] where each
  // entry carries a `file` string. Returning a grouped { diagnostics } wrapper
  // silently broke bridge consumers (contextBundle / getProjectContext /
  // screenshotAndAnnotate) which do `Array.isArray(result)` + read `d.file`.
  it("returns a FLAT array (not a wrapper object) when no file param", async () => {
    const uri1 = Uri.file("/a.ts");
    const uri2 = Uri.file("/b.ts");
    const allDiags = [
      [uri1, [makeDiag({ message: "a1" })]],
      [uri2, [makeDiag({ message: "b1" }), makeDiag({ message: "b2" })]],
    ];
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue(allDiags as any);

    const result = await handleGetDiagnostics({});

    // The crux of the bug fix: a flat array, not an object.
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(3); // 1 from a.ts + 2 from b.ts, flattened

    // Every entry must include a `file` string (the inner grouped entries
    // produced by diagnosticToJson did NOT have one).
    for (const entry of arr) {
      expect(typeof entry.file).toBe("string");
      expect((entry.file as string).length).toBeGreaterThan(0);
    }

    // Files are preserved per-entry.
    expect(arr[0].file).toBe("/a.ts");
    expect(arr[0].message).toBe("a1");
    expect(arr[1].file).toBe("/b.ts");
    expect(arr[2].file).toBe("/b.ts");
  });

  it("caps all-diagnostics at 500 (flat)", async () => {
    const uri = Uri.file("/big.ts");
    const manyDiags = Array.from({ length: 600 }, (_, i) =>
      makeDiag({ message: `err${i}` }),
    );
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
      [uri, manyDiags],
    ] as any);

    const result = (await handleGetDiagnostics({})) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(500);
    expect(result[0].file).toBe("/big.ts");
  });

  it("caps across multiple files (flat)", async () => {
    const uri1 = Uri.file("/one.ts");
    const uri2 = Uri.file("/two.ts");
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
      [uri1, Array.from({ length: 400 }, () => makeDiag())],
      [uri2, Array.from({ length: 400 }, () => makeDiag())],
    ] as any);

    const result = (await handleGetDiagnostics({})) as any[];
    expect(result).toHaveLength(500);
    // First 400 from /one.ts, then 100 from /two.ts.
    expect(result[0].file).toBe("/one.ts");
    expect(result[499].file).toBe("/two.ts");
  });

  it("skips files with zero diagnostics", async () => {
    const uri = Uri.file("/clean.ts");
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
      [uri, []],
    ] as any);
    const result = (await handleGetDiagnostics({})) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
