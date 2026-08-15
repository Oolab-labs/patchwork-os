/**
 * `audit-third-party-licenses` reported a copyleft-free production tree while
 * copyleft binaries shipped in it. Two independent holes, which compounded:
 *
 *  1. `optional: true` packages were skipped alongside `dev` ones. An optional
 *     dependency is INSTALLED by default — npm omits it only on
 *     `--omit=optional` or on a platform mismatch — so its terms ship. 131
 *     packages sat outside the gate; 14 of them carry LGPL-3.0-or-later.
 *
 *  2. the copyleft test was applied to the WHOLE expression and anchored at
 *     its start, so `Apache-2.0 AND LGPL-3.0-or-later` escaped — four of the
 *     fourteen declare exactly that. Whether the gate fired depended on which
 *     operand the publisher wrote first.
 *
 * Fixing either hole alone would still have missed those four, so both are
 * pinned below.
 *
 * ON WHAT IS LOAD-BEARING. The fix for (2) is PARSING the expression into
 * AND/OR terms, not rewriting the regex — the identifier test is still
 * start-anchored, and reverting it to the old pattern changes no result now
 * that it only ever sees one term. That was established by running the
 * mutation, which passed 9/9 and disproved the tidier story. The tests below
 * therefore probe the SPLIT, because a test guarding the regex would be
 * guarding the part that does not matter.
 *
 * The disposition is an allowlist with written reasons rather than a silent
 * pass: the obligations are real, they are accepted, and an accepted
 * obligation nobody can see is one nobody re-examines.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(root, "scripts", "audit-third-party-licenses.mjs");
const ALLOW = path.join(
  root,
  "scripts",
  "audit-third-party-licenses-allow.json",
);

/** The predicate the script uses, mirrored; pinned to the source below. */
const COPYLEFT_ID = /^(AGPL|GPL|LGPL|SSPL)(-|$)/i;
function isCopyleft(expression: string): boolean {
  const expr = String(expression).trim();
  if (!expr || expr === "UNDECLARED") return false;
  const bare = /^\((.*)\)$/s.exec(expr)?.[1] ?? expr;
  return !bare
    .split(/\s+OR\s+/i)
    .some((alt) => !alt.split(/\s+AND\s+/i).some((t) => COPYLEFT_ID.test(t)));
}

describe("the copyleft test reads the whole SPDX expression", () => {
  it("catches a conjunctive copyleft term that is not written first", () => {
    // The exact form four shipped packages declare, and the exact form the
    // anchored regex let through.
    expect(isCopyleft("Apache-2.0 AND LGPL-3.0-or-later")).toBe(true);
    expect(isCopyleft("MIT AND GPL-3.0-only")).toBe(true);
    expect(isCopyleft("Apache-2.0 AND LGPL-3.0-or-later AND MIT")).toBe(true);
  });

  it("still ignores a disjunction offering a permissive option (control)", () => {
    // Without this the assertions above hold equally for a predicate that
    // returns true for everything, which would fail CI permanently.
    expect(isCopyleft("(BSD-3-Clause OR GPL-2.0)")).toBe(false);
    expect(isCopyleft("MIT OR Apache-2.0")).toBe(false);
  });

  it("leaves permissive and undeclared licences alone", () => {
    for (const l of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "CC0-1.0"])
      expect(isCopyleft(l)).toBe(false);
    // Absent metadata is not a licence claim; it is reported, never failed.
    expect(isCopyleft("UNDECLARED")).toBe(false);
  });

  it("keeps catching the plain forms it already caught", () => {
    for (const l of ["GPL-3.0-only", "AGPL-3.0", "SSPL-1.0", "LGPL-3.0"])
      expect(isCopyleft(l)).toBe(true);
  });
});

describe("optional dependencies are audited", () => {
  it("the script no longer skips meta.optional", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // `dev` alone. `meta.dev || meta.optional` is the bug.
    expect(src).not.toMatch(/meta\.dev\s*\|\|\s*meta\.optional/);
    expect(src).toContain("if (meta.dev) continue;");
  });

  it("the shipped optional copyleft packages are in scope and accounted for", () => {
    // Drives the REAL script. This is the assertion that would have caught
    // the original bug, and it cannot pass if either hole is reopened: with
    // optional skipped the packages vanish from the report entirely, and with
    // the anchored regex the four `Apache-2.0 AND …` ones stop being counted
    // as copyleft and so are never reported as accepted.
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out).toContain("@img/sharp-libvips-linux-x64");
    expect(out).toContain("@img/sharp-win32-x64");
    expect(out).toMatch(/accepted:.*Apache-2\.0 AND LGPL-3\.0-or-later/);
    // The green line must not claim there are none.
    expect(out).not.toContain("no copyleft dependencies");
    expect(out).toContain("copyleft dependency(ies) accepted");
  });
});

describe("an exemption must say why", () => {
  it("every allowlist entry carries a non-empty reason", () => {
    const parsed = JSON.parse(readFileSync(ALLOW, "utf8")) as {
      allow: { name: string; license: string; reason: string }[];
    };
    expect(parsed.allow.length).toBeGreaterThan(0);
    for (const e of parsed.allow) {
      expect(e.name).toBeTruthy();
      expect(e.license).toBeTruthy();
      // Not just present — long enough to be an actual reason. A one-word
      // "needed" is how an allowlist stops being a record of a decision.
      expect(e.reason.trim().length).toBeGreaterThan(30);
    }
  });

  it("the script rejects an entry with no reason", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const idx = src.indexOf("allowlist entry #");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, idx - 400), idx + 200)).toContain(
      "process.exit(2)",
    );
  });

  it("the expression is split on AND and OR — the load-bearing part", () => {
    // Guards the change that actually fixed hole (2). Collapsing either split
    // breaks a case here: without the AND split `Apache-2.0 AND LGPL` reads
    // as one unmatched term and goes clean; without the OR split
    // `(BSD-3-Clause OR GPL-2.0)` starts failing and the gate is red forever.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/split\(\/\\s\+OR\\s\+\/i\)/);
    expect(src).toMatch(/split\(\/\\s\+AND\\s\+\/i\)/);
  });

  it("an exemption is bound to the licence, not just the package name", () => {
    // A package changing licence between versions must re-surface rather
    // than inherit its own exemption.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("e.name === pkg.name && e.license === pkg.license");
  });
});
