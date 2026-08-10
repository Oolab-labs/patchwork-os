/**
 * `engines.node` is a support claim. This asserts CI actually tests it.
 *
 * The published package declared `>=20.0.0` while every workflow pinned Node
 * 22 — so Node 20 support was advertised to every `npm install` and verified by
 * nothing. (The README separately said "Node 22+", so the repo contradicted
 * itself too.) Nothing here caught it, because nothing compared the two.
 *
 * If you genuinely want to support an older Node, this test failing is the
 * prompt to add that version to the CI matrix FIRST, then lower the floor.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

/** Every distinct major pinned by a `node-version:` key across all workflows. */
function ciNodeMajors(): number[] {
  const dir = path.join(repoRoot, ".github", "workflows");
  const majors = new Set<number>();
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const body = readFileSync(path.join(dir, file), "utf8");
    // Matches `node-version: 22`, `'22'`, `"22"`, and `[22, 24]` list forms.
    for (const m of body.matchAll(
      /node-version:\s*(\[[^\]]*\]|['"]?[\d.]+['"]?)/g,
    )) {
      for (const n of (m[1] ?? "").matchAll(/(\d+)(?:\.\d+)*/g)) {
        majors.add(Number(n[1]));
      }
    }
  }
  return [...majors].sort((a, b) => a - b);
}

function declaredFloorMajor(): number {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { engines?: { node?: string } };
  const raw = pkg.engines?.node;
  expect(raw, "package.json declares no engines.node").toBeDefined();
  const m = /(\d+)/.exec(raw as string);
  expect(m, `could not parse a major from engines.node ${raw}`).not.toBeNull();
  return Number(m?.[1]);
}

describe("engines.node", () => {
  it("does not claim support for a Node version no CI job tests", () => {
    const majors = ciNodeMajors();

    // Guard the guard: if the version-scrape broke, every comparison below
    // would pass vacuously against an empty set.
    expect(
      majors.length,
      "scraped no node-version from any workflow",
    ).toBeGreaterThan(0);

    expect(
      declaredFloorMajor(),
      `engines.node floor is below the oldest Node in CI (${majors.join(", ")}) — ` +
        "add that version to the matrix before lowering the floor",
    ).toBeGreaterThanOrEqual(Math.min(...majors));
  });
});
