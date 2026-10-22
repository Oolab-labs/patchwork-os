/**
 * The canary version is valid semver for every base version (publish-npm.yml
 * `publish-canary`).
 *
 * It was built as `<base>.canary.<run>`. That is valid while the base is a
 * prerelease (`1.2.0-beta.3.canary.930`) and INVALID once the base is stable:
 * `1.2.5.canary.1000` has four dot-separated parts. npm refused every canary
 * from the first stable release on, and the `canary` dist-tag froze at .930.
 */
import { describe, expect, it } from "vitest";
import { canaryVersion } from "../canary-version.mjs";

// The official SemVer 2.0.0 regex (semver.org, "Is there a suggested regular
// expression"). Used instead of the `semver` package, which this repo does
// not declare.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe("canaryVersion", () => {
  it("a stable base becomes a prerelease of the NEXT patch", () => {
    // Above 1.2.5 (already released), below 1.2.6.
    expect(canaryVersion("1.2.5", 1000)).toBe("1.2.6-canary.1000");
  });

  it("a prerelease base keeps the existing shape", () => {
    // Unchanged from before, so canaries cut on a beta line still sort the same.
    expect(canaryVersion("1.2.0-beta.3", 930)).toBe("1.2.0-beta.3.canary.930");
  });

  it.each([
    ["1.2.5", 1000],
    ["0.9.0", 1],
    ["2.0.0", 42],
    ["1.2.0-beta.3", 930],
    ["1.3.0-alpha.1", 7],
  ])("%s run %i yields valid semver", (base, run) => {
    expect(canaryVersion(base, run)).toMatch(SEMVER);
  });

  it("refuses a base that is not a version, rather than publishing garbage", () => {
    expect(() => canaryVersion("not-a-version", 1)).toThrow();
    expect(() => canaryVersion("1.2.5", Number.NaN)).toThrow();
  });
});
