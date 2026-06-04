/**
 * Default-config ⇄ ctx tools availability ratchet.
 *
 * Sibling of:
 *   - `src/__tests__/dashboard-connector-parity.test.ts` — three-way
 *     parity on the connector id surface.
 *   - `src/tools/__tests__/ctxToolsUnconditional.test.ts` — single
 *     regression that proved the four ctx WRITE / reverse-lookup
 *     tools (`ctxQueryTraces`, `ctxGetTaskContext`, `ctxSaveTrace`,
 *     `getCommitsForIssue`) are still reachable on a stock
 *     `driver: "none"` bridge with NO log args supplied.
 *
 * The unconditional test is the minimum bar — it proves the four
 * tools *can* be reached on the default config. This ratchet is the
 * long-running version: it freezes the set of ctx tools that the
 * default config MUST expose, and fails the build the moment a new
 * ctx tool is registered without a corresponding commit to the
 * allowlist (or, conversely, an allowlisted tool silently falls off
 * the default config — which is the exact regression #850's Invariant
 * 4 was created to prevent: "the ctx-platform tools regressed exactly
 * here").
 *
 * Acceptance criterion (#850 cross-layer parity):
 *
 *   > Default-config availability — assert the tools the docs call
 *   > "standard full-mode" register on the default `driver=none`
 *   > bridge (the ctx-platform tools regressed exactly here).
 *
 * The test uses the `ToolContext`-shaped `registerAllTools` entry
 * point (single object argument) rather than the 18-positional-arg
 * form, to keep the test surface small. The `driver: "none"` and
 * `fullMode: true` defaults come from `makeConfig` in
 * `src/__tests__/helpers/fixtures.ts`; no log args are passed so the
 * stock `~/.patchwork`-backed fallback store in `registerAllTools`
 * is the one being exercised.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { makeConfig as buildConfig } from "../../__tests__/helpers/fixtures.js";
import { registerAllTools } from "../index.js";

const TEST_WORKSPACE = join(tmpdir(), "ctx-default-config-test");

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = pathJoin(here, "ctxToolsDefaultConfig-allowlist.json");

interface AllowlistFile {
  _README: string;
  /** Tool names that MUST appear in `registerAllTools`'s output under
   *  the default config (`driver: "none"`, `fullMode: true`, no log
   *  args). The ratchet fails the build if any of these are missing
   *  OR if a NEW ctx tool appears in the output that is not listed
   *  here. Ratchet rule: this list must only ever shrink (a tool is
   *  removed only when the whole project agrees it is gone, not when
   *  one PR temporarily regresses it). */
  ctxToolsRequiredOnDefaultConfig: string[];
}

const allowlist = JSON.parse(
  readFileSync(allowlistPath, "utf8"),
) as AllowlistFile;

/** The "ctx tool" naming convention is informal — the test does not
 *  enforce a prefix, but in practice the ctx tools all start with
 *  `ctx` (with one historical exception: `getCommitsForIssue` is
 *  named for the bridge's reverse-lookup action, not the ctx prefix).
 *  We rely on the explicit allowlist rather than a prefix regex so
 *  a future rename doesn't silently drop a required tool. */

function makeDefaultConfigCtx() {
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
  return {
    transport,
    extensionClient,
    probes,
    activityLog,
    registered,
  };
}

describe("ctx tools default-config availability ratchet (#850 Invariant 4)", () => {
  it("registerAllTools with the default config (driver: none, fullMode: true, no log args) registers the full allowlisted set", () => {
    const { transport, extensionClient, probes, activityLog, registered } =
      makeDefaultConfigCtx();

    registerAllTools({
      transport: transport as never,
      config: buildConfig({
        workspace: TEST_WORKSPACE,
        workspaceFolders: [TEST_WORKSPACE],
        fullMode: true,
        // driver is left at the makeConfig default of "none"
      }),
      openedFiles: new Set(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      activityLog: activityLog as never,
    });

    const registeredSet = new Set(registered);
    for (const tool of allowlist.ctxToolsRequiredOnDefaultConfig) {
      expect(
        registeredSet.has(tool),
        `Default config did not register ctx tool "${tool}". The bridge ` +
          `must register all tools in ctxToolsRequiredOnDefaultConfig ` +
          `even on a stock driver: "none" full-mode bridge with no log ` +
          `args supplied. If this tool was intentionally retired, ` +
          `remove it from the allowlist and commit an explanatory note; ` +
          `otherwise this is the Invariant 4 regression that #850 was ` +
          `created to prevent.`,
      ).toBe(true);
    }
  });

  it("default config does not register ctx tools outside the allowlist (ratchet — no new ctx tools without an allowlist bump)", () => {
    const { transport, extensionClient, probes, activityLog, registered } =
      makeDefaultConfigCtx();

    registerAllTools({
      transport: transport as never,
      config: buildConfig({
        workspace: TEST_WORKSPACE,
        workspaceFolders: [TEST_WORKSPACE],
        fullMode: true,
      }),
      openedFiles: new Set(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      activityLog: activityLog as never,
    });

    const allowlistSet = new Set(allowlist.ctxToolsRequiredOnDefaultConfig);

    // Tools whose name starts with `ctx` OR matches a known bridge
    // reverse-lookup action. We use the explicit allowlist as the
    // source of truth — a future `ctx*` tool that lands without an
    // allowlist bump will fail this assertion, which is the whole
    // point of the ratchet.
    const ctxPrefixTools = registered.filter((name) => name.startsWith("ctx"));
    const reverseLookupTools = registered.filter(
      (name) => name === "getCommitsForIssue",
    );
    const allCtxFamilyTools = [
      ...new Set([...ctxPrefixTools, ...reverseLookupTools]),
    ].sort();

    for (const tool of allCtxFamilyTools) {
      expect(
        allowlistSet.has(tool),
        `Default config registered ctx-family tool "${tool}" but it is ` +
          `not in ctxToolsDefaultConfig-allowlist.json. Either add it to ` +
          `ctxToolsRequiredOnDefaultConfig (conscious expansion of the ` +
          `default-config ctx tool surface) or remove the ` +
          `create<X>Tool(...) call from src/tools/index.ts.`,
      ).toBe(true);
    }
  });

  it("snapshot: default-config tool counts and ctx-family registration", () => {
    const { transport, extensionClient, probes, activityLog, registered } =
      makeDefaultConfigCtx();

    registerAllTools({
      transport: transport as never,
      config: buildConfig({
        workspace: TEST_WORKSPACE,
        workspaceFolders: [TEST_WORKSPACE],
        fullMode: true,
      }),
      openedFiles: new Set(),
      probes: probes as never,
      extensionClient: extensionClient as never,
      activityLog: activityLog as never,
    });

    const ctxPrefixTools = registered.filter((name) => name.startsWith("ctx"));
    const reverseLookupTools = registered.filter(
      (name) => name === "getCommitsForIssue",
    );
    const allCtxFamilyTools = [
      ...new Set([...ctxPrefixTools, ...reverseLookupTools]),
    ].sort();

    // eslint-disable-next-line no-console
    console.log(
      "[ctxToolsDefaultConfig]",
      JSON.stringify({
        totalRegistered: registered.length,
        ctxFamilyToolsRegistered: allCtxFamilyTools,
        allowlistSize: allowlist.ctxToolsRequiredOnDefaultConfig.length,
      }),
    );
    expect(registered.length).toBeGreaterThan(0);
  });
});
