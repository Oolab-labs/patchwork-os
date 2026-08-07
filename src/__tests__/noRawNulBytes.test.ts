/**
 * No source file may contain a raw NUL byte.
 *
 * Git treats such a file as BINARY: `git diff`, `git blame` and every
 * code-review tool report "Binary files differ" instead of showing content.
 * The file silently becomes unreviewable — it can be changed without anyone
 * seeing the change.
 *
 * This has happened twice. `src/butler/resolve.ts` shipped in #1271 with two
 * literal NUL bytes where `\u0000` was meant, and four separate review passes
 * read that file without noticing it had never once had a readable diff.
 *
 * The escape sequence has the identical runtime value, so there is never a
 * reason to embed the raw byte in source.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const NUL = "\u0000";

/**
 * Files that legitimately contain a raw NUL because the NUL byte IS the thing
 * under test (path-traversal rejection, JSONL torn-row handling) or the
 * documented artefact. Each entry costs the file its reviewable diff, so a new
 * one needs a reason.
 */
const ALLOWED = new Set([
  "src/__tests__/security-path-traversal.test.ts",
  "src/commands/__tests__/recipe.test.ts",
  "src/recipes/__tests__/judgeVerdict.test.ts",
  "docs/dogfood/recipe-dogfood-2026-05-01/PLAN-A-security.md",
]);

function trackedSourceFiles(): string[] {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.mjs",
      "*.json",
      "*.yaml",
      "*.yml",
      "*.md",
    ],
    { cwd: ROOT, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  // `-z` is NUL-separated precisely so paths containing newlines survive.
  return out
    .toString("utf8")
    .split(NUL)
    .filter((f) => f.length > 0);
}

describe("source files are reviewable", () => {
  it("contains no raw NUL bytes (which make git treat a file as binary)", () => {
    const offenders: string[] = [];
    for (const rel of trackedSourceFiles()) {
      let buf: Buffer;
      try {
        buf = readFileSync(path.join(ROOT, rel));
      } catch {
        continue; // tracked but absent mid-rebase / sparse checkout
      }
      if (buf.includes(0) && !ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
