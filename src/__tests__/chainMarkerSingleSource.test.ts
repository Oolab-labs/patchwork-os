/**
 * Ledger readers skip ADR-0027 marker rows through ONE predicate
 * (`isChainMarker` in ledgerChain.ts) — never their own copy of the marker
 * names (Private/52 LOW).
 *
 * A reader that spells out `"chain-start" || "rotation"` itself silently
 * starts counting markers as data the day a third marker kind is added — the
 * #1517 reader-whitelist trap. `outcomeStore.ts` held such a copy.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("chain marker kinds have one source", () => {
  it("no reader outside ledgerChain.ts compares against the marker names", () => {
    const pattern =
      /===\s*"chain-start"\s*\|\|[^\n]*===\s*"rotation"|===\s*"rotation"\s*\|\|[^\n]*===\s*"chain-start"/;
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith("ledgerChain.ts"))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("the shared predicate itself still exists (a guard over nothing fails)", () => {
    expect(readFileSync(join(SRC, "ledgerChain.ts"), "utf8")).toMatch(
      /export function isChainMarker\(/,
    );
  });
});
