import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { inferTierFromName, matchesSearchReplace } from "../riskTier.js";

/**
 * The search-and-replace heuristic used to be `/search[A-Z].*Replace/i`, which
 * CodeQL flags as polynomial ReDoS: `.*` backtracks against every later
 * position. The replacement must accept exactly the names that regex did.
 *
 * The oracle is a brute-force transcription of the regex's semantics rather
 * than the regex itself, so this file does not reintroduce the flagged sink:
 * ASCII-only case folding (`/i` without `u` never folds a non-ASCII char to
 * ASCII), a letter after "search", then "replace" with no line terminator
 * (`.` excludes \n \r    ) in between.
 */
const LINE_TERMINATOR = new Set(["\n", "\r", " ", " "]);
const eqAscii = (a: string, b: string) =>
  a.length === b.length &&
  [...a].every((c, k) => {
    const x = c.charCodeAt(0);
    const y = b.charCodeAt(k);
    const fold = (n: number) => (n >= 65 && n <= 90 ? n + 32 : n);
    return fold(x) === fold(y);
  });
const isAsciiLetter = (c: string | undefined) => !!c && /^[A-Za-z]$/.test(c);

function oracle(s: string): boolean {
  for (let i = 0; i + 7 <= s.length; i++) {
    if (!eqAscii(s.slice(i, i + 6), "search") || !isAsciiLetter(s[i + 6]))
      continue;
    for (let j = i + 7; j < s.length; j++) {
      if (eqAscii(s.slice(j, j + 7), "replace")) return true;
      if (LINE_TERMINATOR.has(s[j] as string)) break;
    }
  }
  return false;
}

const FRAGMENT = fc.constantFrom(
  "search",
  "Search",
  "SEARCH",
  "sEaRcH",
  "replace",
  "Replace",
  "REPLACE",
  "A",
  "z",
  "_",
  "1",
  "\n",
  "\r",
  " ",
  " ",
  "K", // Kelvin sign: toLowerCase() gives ASCII "k", the regex does not fold it
  "İ", // dotted capital I: toLowerCase() changes the string length
  "ſ", // long s
  "x",
  "",
);

describe("matchesSearchReplace agrees with /search[A-Z].*Replace/i", () => {
  test("oracle sanity: it is not vacuous", () => {
    expect(oracle("searchAndReplace")).toBe(true);
    expect(oracle("search_Replace")).toBe(false);
    expect(oracle("searchA\nReplace")).toBe(false);
    expect(oracle("searchReplace")).toBe(false); // "R" is the letter, then no "replace" left
    expect(oracle("searchXreplace")).toBe(true);
  });

  test("agrees on every generated name", () => {
    fc.assert(
      fc.property(fc.array(FRAGMENT, { maxLength: 14 }), (parts) => {
        const name = parts.join("");
        expect(matchesSearchReplace(name)).toBe(oracle(name));
      }),
      { numRuns: 20_000 },
    );
  });

  test("agrees on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        expect(matchesSearchReplace(name)).toBe(oracle(name));
      }),
      { numRuns: 5_000 },
    );
  });

  test.each([
    ["searchAndReplace", true],
    ["qSEARCHxREPLACE", true],
    ["search_Replace", false],
    ["searchA\nReplace", false],
    ["searchA\nsearchBReplace", true], // a later occurrence on its own line
    ["searchKReplace", false],
    ["searchReplace", false],
  ])("%j → %s", (name, expected) => {
    expect(matchesSearchReplace(name)).toBe(expected);
  });

  test("the searchAndReplace tool still classifies as a local write", () => {
    expect(inferTierFromName("searchAndReplace")).toBe("medium");
  });

  test("stays linear on adversarial input", () => {
    const start = performance.now();
    matchesSearchReplace(`search${"A".repeat(200_000)}`);
    matchesSearchReplace("searchA".repeat(30_000));
    inferTierFromName(`search${"A".repeat(200_000)}`);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
