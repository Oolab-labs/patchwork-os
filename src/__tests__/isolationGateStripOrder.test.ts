/**
 * `audit-connector-test-isolation` stripped comments in the wrong order.
 *
 * It ran block comments first, then line comments — the #1401 defect that
 * #1412 fixed in the sibling gate `audit-patchwork-home.mjs`. It survived here
 * because that fix was applied to one FILE rather than to the pattern, and
 * nothing was looking for a second instance.
 *
 * Stripping blocks first lets an UNPAIRED `/*` inside a LINE comment open a
 * pseudo-block that runs to the next real terminator anywhere in the file,
 * deleting every line between before a single match is attempted. In the
 * sibling that made 38 files and 3662 lines of live code invisible.
 *
 * Measured across all 76 tracked connector tests when this was fixed: zero
 * files differ between the two orderings, so nothing was hidden at the time.
 * That is the honest scope of the finding — and not a reason to leave it,
 * because a gate that is wrong only until the wrong comment arrives is a gate
 * that fails on the day it is needed.
 *
 * Both directions are pinned below. The multi-line spelling the block pass
 * exists for must keep working, or "fix" here just moves the blindness.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "audit-connector-test-isolation.mjs",
);

/** The gate's stripper, mirrored; pinned to the source by the test below. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The gate's own detection regexes. */
const DELETES_CREDENTIAL = /\bclearTokens\s*\(\)|handle\w*Disconnect\s*\(\)/;
const MENTIONS_HOME = /PATCHWORK_HOME/;

function flagsHazard(file: string): boolean {
  const code = stripComments(file);
  return DELETES_CREDENTIAL.test(code) && !MENTIONS_HOME.test(code);
}

/** An unpaired `/*` in a line comment, then an ordinary block comment. */
const PSEUDO_BLOCK_FILE = [
  'import { clearTokens } from "../tokenStore.js";',
  "// matches fixtures/*  (note the unclosed /* here)",
  'describe("disconnect", () => {',
  '  it("clears the credential", () => {',
  "    clearTokens();",
  "  });",
  "});",
  "/* an ordinary block comment later in the file */",
  "export {};",
].join("\n");

describe("a line comment cannot hide a credential-deleting call", () => {
  it("flags the hazard despite an unpaired /* in a line comment", () => {
    // The shipped order deleted everything between that `/*` and the block
    // comment's `*​/`, so `clearTokens()` was never seen.
    expect(flagsHazard(PSEUDO_BLOCK_FILE)).toBe(true);
  });

  it("the old ordering demonstrably missed it (the bug, pinned)", () => {
    // Kept as an executable record: without it, the assertion above could be
    // satisfied by a stripper that does nothing at all, and the reader has no
    // way to tell the fix mattered.
    const oldOrder = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(DELETES_CREDENTIAL.test(oldOrder(PSEUDO_BLOCK_FILE))).toBe(false);
  });

  it("still strips real block comments (control)", () => {
    // The block pass exists for a reason. Without this, "strip line comments
    // only" would pass the test above while reintroducing the blindness the
    // block pass was added to fix: a commented-out call read as live code.
    const file = [
      'import { clearTokens } from "../tokenStore.js";',
      "/*",
      "  historical note: this used to call clearTokens();",
      "*/",
      'it("does nothing dangerous", () => {});',
    ].join("\n");
    expect(flagsHazard(file)).toBe(false);
  });

  it("a block comment containing // still terminates correctly", () => {
    const file = [
      "/* see // for details */",
      'import { clearTokens } from "../tokenStore.js";',
      "clearTokens();",
    ].join("\n");
    // The call is real code after the block ends, so it must be seen.
    expect(flagsHazard(file)).toBe(true);
  });

  it("an isolated file is still not a hazard (control)", () => {
    // Only the COMBINATION is dangerous. A file that deletes but sandboxes
    // must not be flagged, or the ratchet fills with noise.
    const file = [
      'process.env.PATCHWORK_HOME = "/tmp/sandbox";',
      "clearTokens();",
    ].join("\n");
    expect(flagsHazard(file)).toBe(false);
  });

  it("the script strips line comments before block comments", () => {
    // Pins the mirror above to the real implementation.
    const src = readFileSync(SCRIPT, "utf-8");
    const fn = src.slice(src.indexOf("function stripComments"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // Match the SOURCE text of each regex, escaped slashes and all — the
    // first version of this assertion searched for the unescaped forms, found
    // neither, and failed. Which is the point of writing it down: a
    // source-pinning check that matches nothing asserts nothing.
    const linePass = body.indexOf("\\/\\/.*$");
    const blockPass = body.indexOf("\\/\\*[\\s\\S]*?");
    expect(linePass).toBeGreaterThan(-1);
    expect(blockPass).toBeGreaterThan(-1);
    expect(linePass).toBeLessThan(blockPass);
  });
});
