import { describe, expect, it, vi } from "vitest";
import { makeConfig as buildConfig } from "../../__tests__/helpers/fixtures.js";
import { registerAllTools } from "../index.js";

/**
 * Regression test for the "ctx WRITE/reverse-lookup tools missing on a stock
 * bridge" bug.
 *
 * The four ctx tools — `ctxQueryTraces`, `ctxGetTaskContext`, `ctxSaveTrace`,
 * `getCommitsForIssue` — are documented (CLAUDE.md) as standard full-mode
 * tools. Two of them (`ctxSaveTrace`, `getCommitsForIssue`) were registered
 * only when a `decisionTraceLog` / `commitIssueLinkLog` argument was supplied.
 *
 * On the default bridge (`driver: "none"`) those logs were never constructed,
 * so the WRITE path and the enrichment reverse-lookup silently vanished and
 * `ctxSaveTrace` returned tool-not-found.
 *
 * After the fix the four ctx tools must register unconditionally — even when
 * the caller passes no log arguments at all.
 *
 * Test seam: full `Bridge.start()` is heavy (probes CLIs, binds a port, writes
 * lock files), so we target the narrowest seam — `registerAllTools` with no log
 * arguments, which is exactly the shape the stock `driver: "none"` bridge used
 * to produce. The companion bridge.ts change guarantees the bridge now always
 * constructs + passes real `commitIssueLinkLog` / `decisionTraceLog` stores.
 */
describe("ctx tools register unconditionally (no log args)", () => {
  function makeDeps() {
    const registered: string[] = [];
    const transport = {
      registerTool: vi.fn((schema: { name: string }) => {
        registered.push(schema.name);
      }),
      applyToolCategories: vi.fn(),
    };
    const extensionClient = {
      isConnected: () => false,
      request: vi.fn(),
      requestOrNull: vi.fn(),
      latestAIComments: [],
      onExtensionDisconnected: null,
      onDiagnosticsChanged: null,
    };
    return { transport, extensionClient, registered };
  }

  const probes = {
    gh: false,
    rg: false,
    fd: false,
    eslint: false,
    biome: false,
    tsc: false,
    pytest: false,
    jest: false,
    vitest: false,
    cargo: false,
    go: false,
    pyright: false,
    ruff: false,
  };

  const activityLog = {
    query: vi.fn(() => []),
    queryTimeline: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    stats: vi.fn(() => ({})),
  };

  it("registers all four ctx tools in full mode with NO log args supplied", () => {
    const { transport, extensionClient, registered } = makeDeps();

    // Full mode, default bridge: no commitIssueLinkLog / decisionTraceLog /
    // recipeRunLog arguments — exactly the stock `driver: "none"` shape.
    registerAllTools(
      transport as never,
      buildConfig({
        workspace: "/tmp/test",
        workspaceFolders: ["/tmp/test"],
        fullMode: true,
      }),
      new Set(),
      probes as never,
      extensionClient as never,
      activityLog as never,
    );

    const set = new Set(registered);
    expect(set.has("ctxQueryTraces")).toBe(true);
    expect(set.has("ctxGetTaskContext")).toBe(true);
    expect(set.has("ctxSaveTrace")).toBe(true);
    expect(set.has("getCommitsForIssue")).toBe(true);
  });
});
