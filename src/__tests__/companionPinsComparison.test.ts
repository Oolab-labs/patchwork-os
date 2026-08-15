/**
 * `audit-companion-pins` could not fail on a stale pin — its only purpose.
 *
 * TWO defects, and either alone was enough.
 *
 *  1. `versionDistance` kept scanning AFTER a differing segment, so a later
 *     segment could reverse the verdict. `1.0.1` vs `1.7.0`: the minor says
 *     behind, then the patch (1 vs 0) said "ahead" and returned -1. Two real
 *     shipped pins printed as `pinned > latest — likely prerelease` while
 *     being 7 minors and 2 MAJORS behind.
 *
 *  2. `significantlyBehind` was `distance > 5`, where `distance` counted
 *     segments that differ. Semver has three segments, so it was bounded by 3
 *     and the condition was UNREACHABLE. In default mode — the mode the
 *     scheduled workflow runs — the gate could only fail on a fetch error.
 *
 * Together: a weekly job whose stated job is "exit 1 if any pin is more than 5
 * versions behind" had never once been able to do so. When the comparison was
 * fixed, 5 of 6 companions were behind and two were a major version or more
 * back.
 *
 * These tests are network-free on purpose. The script fetches npm, and a test
 * that hits the registry would be both slow and a new flake source — the exact
 * trade the CVE gate (#1413) documents. The comparison is the part that was
 * broken, and it is pure.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "audit-companion-pins.mjs",
);

/** The script's comparison, mirrored; pinned to the source below. */
function compareVersions(pinned: string, latest: string) {
  const p = pinned.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const l = latest.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const LEVELS = ["major", "minor", "patch"] as const;
  for (let i = 0; i < 3; i++) {
    const pv = p[i] ?? 0;
    const lv = l[i] ?? 0;
    if (pv === lv) continue;
    return lv > pv
      ? { behind: true, level: LEVELS[i], by: lv - pv }
      : { behind: false, level: LEVELS[i], by: pv - lv, ahead: true };
  }
  return { behind: false, level: null, by: 0 };
}

function significantlyBehind(pinned: string, latest: string): boolean {
  const c = compareVersions(pinned, latest);
  return (
    c.behind === true &&
    (c.level === "major" || (c.level === "minor" && c.by > 5))
  );
}

describe("a later segment cannot reverse the verdict", () => {
  it("the two real pins that printed as 'likely prerelease' are behind", () => {
    // Verbatim from a live run of the shipped script.
    expect(compareVersions("1.0.1", "1.7.0")).toMatchObject({
      behind: true,
      level: "minor",
      by: 7,
    });
    expect(compareVersions("4.3.2", "6.2.4")).toMatchObject({
      behind: true,
      level: "major",
      by: 2,
    });
  });

  it("a high minor/patch does not mask a major gap", () => {
    // `1.9.9` vs `2.0.0` — the old scan saw major behind, then minor 9 vs 0
    // and patch 9 vs 0, and concluded "ahead".
    expect(compareVersions("1.9.9", "2.0.0")).toMatchObject({
      behind: true,
      level: "major",
      by: 1,
    });
  });

  it("still recognises a genuinely ahead pin (control)", () => {
    // The -1/"prerelease" branch exists for a real case and must survive.
    // Without this, "always report behind" would pass everything above.
    expect(compareVersions("2.0.0", "1.0.0").behind).toBe(false);
    expect(compareVersions("1.0.0", "1.0.0")).toMatchObject({ by: 0 });
  });
});

describe("the failure condition is reachable", () => {
  it("fails on a major-version gap", () => {
    expect(significantlyBehind("0.21.2", "1.2.0")).toBe(true);
    expect(significantlyBehind("4.3.2", "6.2.4")).toBe(true);
  });

  it("fails on more than five minors", () => {
    expect(significantlyBehind("1.0.1", "1.7.0")).toBe(true);
    expect(significantlyBehind("1.0.0", "1.5.0")).toBe(false);
  });

  it("does not fail on a few patches (control)", () => {
    // Patch drift is reported, not failed — otherwise the weekly job is red
    // permanently and stops being read, which is how a gate dies.
    expect(significantlyBehind("0.0.75", "0.0.79")).toBe(false);
  });

  it("the OLD rule could never fire, on any input", () => {
    // Executable proof of defect (2), not an assertion about the new code.
    // `distance` counted differing segments; semver has three.
    const oldDistance = (pinned: string, latest: string) => {
      if (pinned === latest) return 0;
      const p = pinned.split(".").map(Number);
      const l = latest.split(".").map(Number);
      let behind = 0;
      for (let i = 0; i < Math.max(p.length, l.length); i++) {
        const pv = p[i] ?? 0;
        const lv = l[i] ?? 0;
        if (lv > pv) behind++;
        else if (lv < pv) return -1;
      }
      return behind;
    };
    // Exhaustive over every 3-segment shape that can differ.
    let maxSeen = 0;
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++)
        for (let c = 0; c < 3; c++)
          maxSeen = Math.max(maxSeen, oldDistance("0.0.0", `${a}.${b}.${c}`));
    expect(maxSeen).toBe(3);
    // The threshold was `> 5`.
    expect(maxSeen).toBeLessThanOrEqual(5);
  });
});

describe("the tag and the exit code tell the same story", () => {
  it("the script derives both from one rule", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // Comments stripped first — the script DOCUMENTS the old `distance > 5`
    // rule in order to explain why it is gone, and a whole-file grep fails on
    // that prose rather than on any code. (This assertion was written the
    // naive way first and failed exactly that way.)
    //
    // Line comments before block comments, for the reason #1412 and the
    // connector-isolation gate both had to learn: an unpaired `/*` inside a
    // line comment otherwise swallows the file.
    const code = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Two independent expressions is how a pin two majors back printed WARN
    // while the build failed. Both sites must call the shared comparison.
    expect(code.match(/compareVersions\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(code).not.toMatch(/distance > 5/);
  });
});
