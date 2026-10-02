/**
 * `src/privateHost.ts` must import NOTHING.
 *
 * The dashboard imports `isPrivateHost` across the package boundary
 * (`dashboard/src/lib/pushEndpoint.ts`). The dashboard does not depend on the
 * bridge's runtime packages, so anything this module imports must also
 * resolve from the dashboard — and the obvious way to break that is the way
 * it broke on 2026-10-02: `ssrfGuard.ts` started importing `undici`, and the
 * dashboard's CI typecheck failed with TS2307 because the helper still lived
 * there.
 *
 * A local dashboard typecheck CANNOT catch this: module resolution walks up
 * to the repository root's node_modules, where `undici` exists. Only CI —
 * which installs the dashboard's dependencies alone — sees it. This test is
 * the check that can fail on a laptop.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("src/privateHost.ts stays dependency-free", () => {
  it("contains no import or require", () => {
    const src = readFileSync(
      path.resolve(__dirname, "..", "privateHost.ts"),
      "utf8",
    );
    const offenders = src
      .split("\n")
      .filter((l) => /^\s*import\s|\brequire\s*\(|\bimport\s*\(/.test(l));
    expect(
      offenders,
      "privateHost.ts is imported by the dashboard across the package " +
        "boundary; any import here must also resolve from dashboard/. Keep " +
        "I/O helpers in ssrfGuard.ts.",
    ).toEqual([]);
  });

  it("ssrfGuard still re-exports the same functions (importers unchanged)", async () => {
    const guard = await import("../ssrfGuard.js");
    const pure = await import("../privateHost.js");
    expect(guard.isPrivateHost).toBe(pure.isPrivateHost);
    expect(guard.isLoopbackHost).toBe(pure.isLoopbackHost);
    expect(guard.isPrivateNonLoopbackHost).toBe(pure.isPrivateNonLoopbackHost);
  });
});
