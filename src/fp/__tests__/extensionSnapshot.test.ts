import { describe, expect, it } from "vitest";
import type { ExtensionClient } from "../../extensionClient.js";
import { snapshotExtension } from "../extensionSnapshot.js";

function makeClient(
  overrides: Partial<{
    latestDiagnostics: ExtensionClient["latestDiagnostics"];
    latestSelection: ExtensionClient["latestSelection"];
    latestActiveFile: ExtensionClient["latestActiveFile"];
    latestAIComments: ExtensionClient["latestAIComments"];
    latestDebugState: ExtensionClient["latestDebugState"];
  }> = {},
): ExtensionClient {
  return {
    latestDiagnostics: new Map(),
    latestSelection: null,
    latestActiveFile: null,
    latestAIComments: new Map(),
    latestDebugState: null,
    ...overrides,
  } as unknown as ExtensionClient;
}

describe("snapshotExtension", () => {
  it("returns correct field values", () => {
    const diags = new Map([
      [
        "/a.ts",
        [
          {
            file: "/a.ts",
            line: 1,
            column: 0,
            severity: "error" as const,
            message: "oops",
          },
        ],
      ],
    ]);
    const selection = {
      file: "/a.ts",
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: 5,
      selectedText: "hello",
    };
    const aiComments = new Map([
      [
        "/b.ts",
        [
          {
            file: "/b.ts",
            line: 2,
            comment: "todo",
            syntax: "//",
            fullLine: "// todo",
          },
        ],
      ],
    ]);
    const debugState = {
      hasActiveSession: false,
      isPaused: false,
      breakpoints: [],
    };

    const client = makeClient({
      latestDiagnostics: diags,
      latestSelection: selection,
      latestActiveFile: "/a.ts",
      latestAIComments: aiComments,
      latestDebugState: debugState,
    });

    const snap = snapshotExtension(client);

    expect(snap.diagnostics.get("/a.ts")).toEqual(diags.get("/a.ts"));
    expect(snap.selection).toBe(selection);
    expect(snap.activeFile).toBe("/a.ts");
    expect(snap.aiComments.get("/b.ts")).toEqual(aiComments.get("/b.ts"));
    expect(snap.debugState).toBe(debugState);
    expect(typeof snap.capturedAt).toBe("number");
  });

  it("deep-copies diagnostics map — mutation after snapshot does not affect snapshot", () => {
    const diagEntry = [
      {
        file: "/x.ts",
        line: 1,
        column: 0,
        severity: "warning" as const,
        message: "warn",
      },
    ];
    const diags = new Map([["/x.ts", diagEntry]]);
    const client = makeClient({ latestDiagnostics: diags });

    const snap = snapshotExtension(client);

    // Mutate original map after snapshot
    diags.set("/new.ts", [
      {
        file: "/new.ts",
        line: 5,
        column: 0,
        severity: "error" as const,
        message: "new",
      },
    ]);
    diags.delete("/x.ts");

    expect(snap.diagnostics.has("/x.ts")).toBe(true);
    expect(snap.diagnostics.has("/new.ts")).toBe(false);
  });

  it("deep-copies aiComments map — mutation after snapshot does not affect snapshot", () => {
    const comments = new Map([
      [
        "/c.ts",
        [
          {
            file: "/c.ts",
            line: 3,
            comment: "fix",
            syntax: "//",
            fullLine: "// fix",
          },
        ],
      ],
    ]);
    const client = makeClient({ latestAIComments: comments });

    const snap = snapshotExtension(client);

    comments.delete("/c.ts");
    comments.set("/other.ts", [
      {
        file: "/other.ts",
        line: 1,
        comment: "x",
        syntax: "//",
        fullLine: "// x",
      },
    ]);

    expect(snap.aiComments.has("/c.ts")).toBe(true);
    expect(snap.aiComments.has("/other.ts")).toBe(false);
  });

  it("capturedAt is in Date.now() range", () => {
    const before = Date.now();
    const snap = snapshotExtension(makeClient());
    const after = Date.now();

    expect(snap.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snap.capturedAt).toBeLessThanOrEqual(after);
  });

  it("empty maps produce empty ReadonlyMaps", () => {
    const snap = snapshotExtension(makeClient());

    expect(snap.diagnostics.size).toBe(0);
    expect(snap.aiComments.size).toBe(0);
    expect(snap.selection).toBeNull();
    expect(snap.activeFile).toBeNull();
    expect(snap.debugState).toBeNull();
  });
});
