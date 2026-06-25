/**
 * Dispatch-path guard parity (issue #850, acceptance criterion #2).
 *
 * The bridge has more than one tool-dispatch entry point. The cross-layer
 * invariant this guards: the two MCP-transport dispatch paths — the
 * registered-tool path and the dynamic/proxy path in `src/transport.ts` —
 * enforce the SAME per-session deny-list (`this.denyTools`). The dynamic path
 * was historically a bypass (a session that denied a tool via
 * `X-Bridge-Deny-Tools` could still invoke it as an orchestrator child/proxy
 * tool); the fix mirrored the `denyTools.has(...)` check onto the dynamic path.
 * This test pins that parity so the bypass cannot silently regress.
 *
 * ── On the recipe dispatch path (deliberately NOT asserted as sharing denyTools)
 *
 * `executeTool` in `src/recipes/toolRegistry.ts` is a THIRD dispatch entry
 * point, but it is a different architectural boundary, not a gap:
 *
 *   - It dispatches over a SEPARATE registry (the recipe tool registry, keyed
 *     by `namespace.action` ids like `github.createPR`) — not the MCP tool map
 *     that `denyTools` filters. `denyTools` is populated from the per-MCP-session
 *     `X-Bridge-Deny-Tools` header (`src/transport.ts`), a session-scoped concept
 *     that has no meaning for a recipe run (recipes are not MCP sessions).
 *   - Recipe tool execution is policy-gated by a DIFFERENT, intentional set of
 *     controls: `assertWriteAllowed` (the global write kill-switch), the
 *     write-effect idempotency ledger, and — at the runner layer — the approval
 *     gate. Routing recipe dispatch through the MCP session deny-list would be a
 *     category error.
 *
 * So this test asserts the guarantee that IS real and shared (both transport
 * paths consult `denyTools`) and documents — but does not falsely assert — the
 * recipe path. If a future change makes the recipe path MCP-session-aware, the
 * contract here should be revisited deliberately.
 *
 * Implementation: a source-text scan of `src/transport.ts`, matching the
 * sibling cross-layer parity tests' style (they scan source rather than import
 * across package/tsconfig boundaries).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("dispatch-guard parity (#850)", () => {
  const transport = read("src/transport.ts");

  it("both MCP transport dispatch paths consult denyTools", () => {
    // The deny check appears once on the dynamic/proxy path (inside the
    // `!tool && this.dynamicToolDispatch` branch) and once on the
    // registered-tool path. Anchor on the comment that marks the dynamic-path
    // guard, then assert a denyTools.has() check exists in BOTH regions.
    const dynamicAnchor = transport.indexOf(
      "Per-session deny list applies to dynamic/proxied tools too",
    );
    expect(
      dynamicAnchor,
      "dynamic-dispatch deny-list guard comment missing — the proxy path may have lost its denyTools check",
    ).toBeGreaterThan(-1);

    const denyChecks = [
      ...transport.matchAll(/this\.denyTools\.has\(params\.name\)/g),
    ];
    expect(
      denyChecks.length,
      "expected denyTools.has(params.name) on BOTH the dynamic and registered dispatch paths",
    ).toBeGreaterThanOrEqual(2);

    // At least one deny check must sit in the dynamic region (before the
    // `if (!tool)` not-found branch that begins the registered path) and at
    // least one after it.
    const notFoundBranch = transport.indexOf("\n            if (!tool) {");
    expect(notFoundBranch).toBeGreaterThan(dynamicAnchor);
    const dynamicDeny = denyChecks.some((m) => m.index! < notFoundBranch);
    const registeredDeny = denyChecks.some((m) => m.index! > notFoundBranch);
    expect(dynamicDeny, "dynamic/proxy path missing denyTools check").toBe(
      true,
    );
    expect(registeredDeny, "registered-tool path missing denyTools check").toBe(
      true,
    );
  });

  it("denyTools is the single per-session deny-list source on the transport", () => {
    // Guard against a second, divergent deny structure being introduced on the
    // transport: the only deny-list field should be `denyTools`.
    expect(transport).toMatch(/private denyTools: Set<string>/);
  });

  it("recipe executeTool is a distinct boundary, not the MCP deny-list", () => {
    // Documents the deliberate boundary: the recipe dispatch path does NOT (and
    // should not) reference the MCP-session denyTools. It is gated by
    // assertWriteAllowed instead. If this ever changes, the cross-layer
    // contract above must be reconsidered on purpose.
    const recipeRegistry = read("src/recipes/toolRegistry.ts");
    expect(
      recipeRegistry.includes("denyTools"),
      "recipe executeTool must not consult the MCP-session denyTools (different boundary; see file header)",
    ).toBe(false);
    expect(
      recipeRegistry.includes("assertWriteAllowed"),
      "recipe executeTool is expected to enforce the write kill-switch via assertWriteAllowed",
    ).toBe(true);
  });
});
