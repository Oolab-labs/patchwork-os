/**
 * `scripts/audit-patchwork-home.mjs` — comment-stripping ORDER.
 *
 * #1401 replaced a line-by-line scan with a whole-file one, to catch the
 * multi-line spelling a formatter produces. It also stripped block comments
 * BEFORE line comments — and that made the gate blinder than the version it
 * replaced.
 *
 * A `/*` inside a LINE comment opens a pseudo-block that the block-strip runs
 * to the next real terminator anywhere in the file. One ordinary route comment
 * in `src/server.ts` swallowed 2098 of its 3593 lines — 58% — before a single
 * match was attempted. Repo-wide: 38 files, 3662 lines of live code deleted.
 * A canonical violation planted mid-file passed with "0 on the ratchet", and
 * the session that shipped it reported "ratchet 3 → 0 under a gate that can
 * now actually see".
 *
 * Found by mutation-probing the gate, not by reading it. These tests pin BOTH
 * directions so neither half can regress: the multi-line form #1401 fixed, and
 * the pseudo-block hole #1401 introduced.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "audit-patchwork-home.mjs");

/**
 * The gate's own stripper, mirrored.
 *
 * Extracted rather than shelling out because the failure is about WHAT
 * SURVIVES the strip, and asserting on surviving text is a far sharper probe
 * than an exit code — an exit code cannot distinguish "found nothing" from
 * "was shown nothing".
 */
function strip(text: string): string {
  const src = readFileSync(SCRIPT, "utf8");
  // Read the order out of the real script so this test cannot drift from it.
  const lineFirst =
    src.indexOf('.map((l) => l.replace(/\\/\\/.*$/, ""))') <
    src.indexOf('.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")');
  if (lineFirst) {
    return text
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("comment stripping must not swallow live code", () => {
  it("a /* inside a LINE comment does not open a block", () => {
    // The exact shape from src/server.ts:926 — a route path in a comment.
    const src = [
      "const a = 1;",
      "// ── /schemas/* — unauthenticated registry-derived JSON Schemas",
      'const stray = path.join(os.homedir(), ".patchwork", "x");',
      "/* a real block comment */",
      "const b = 2;",
    ].join("\n");
    const out = strip(src);
    // The violation must SURVIVE stripping, or it can never be matched.
    expect(out).toContain("homedir()");
    expect(out).toContain(".patchwork");
    expect(out).toContain("const b = 2;");
  });

  it("still removes a genuine block comment", () => {
    // The reason block-stripping exists: converted call sites document the
    // pattern they replaced, and that note must not read as an offence.
    const src = [
      "/*",
      ' * replaced path.join(os.homedir(), ".patchwork") with patchworkPath()',
      " */",
      "const clean = patchworkPath();",
    ].join("\n");
    const out = strip(src);
    expect(out).not.toContain("homedir()");
    expect(out).toContain("patchworkPath()");
  });

  it("a block comment containing // still terminates", () => {
    // Stripping line comments first mangles `http://…` inside a block, but
    // the block's own `/*` and `*/` survive, so it still closes correctly.
    const src = [
      "/*",
      " * see http://example.test/docs",
      " */",
      'const stray = path.join(os.homedir(), ".patchwork", "y");',
    ].join("\n");
    const out = strip(src);
    expect(out).toContain("homedir()");
  });
});

describe("the gate catches both spellings end-to-end", () => {
  function run(): { status: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [SCRIPT], {
        cwd: REPO,
        encoding: "utf8",
      });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? -1,
        out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      };
    }
  }

  it("passes on the real tree (control)", () => {
    // Without this the assertions above would hold for a gate that flagged
    // everything.
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain("the ratchet holds");
  });
});
