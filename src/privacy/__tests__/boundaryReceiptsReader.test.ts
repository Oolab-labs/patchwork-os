/**
 * The reader for `boundary_receipts.jsonl` (ADR-0021).
 *
 * The ledger was write-only in this repo: `BoundaryReceiptLog.recent()` and
 * `.summary()` had no production caller, no CLI verb, no route and no page, so
 * the only thing reading our own enforcement evidence lived outside the MIT
 * tree. ADR-0019:88-92 forbids exactly that — the local ledgers must stay
 * usable standalone.
 *
 * These tests pin the two properties that make the reader honest rather than
 * merely present.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOUNDARY_RECEIPTS_BASENAME,
  boundaryReceiptsPath,
  formatBoundaryReceipts,
  summariseBoundaryReceipts,
} from "../boundaryReceipts.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pw-receipt-read-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function writeRows(dir: string, rows: Record<string, unknown>[]): void {
  writeFileSync(
    path.join(dir, BOUNDARY_RECEIPTS_BASENAME),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    at: 1_000,
    decision: "ALLOW",
    classification: "internal",
    destinationId: "remote-model",
    destinationType: "remote",
    reason: "cleared",
    ...over,
  };
}

describe("summariseBoundaryReceipts", () => {
  it("counts EVERY row on disk, not the last 500 held in memory", () => {
    // The whole point of a separate reader.
    //
    // `BoundaryReceiptLog` trims its in-memory array to DEFAULT_MEMORY_CAP=500
    // on load AND on every write, so a reader built on `.summary()` answers
    // over the most recent 500 receipts and renders as a total. On a ledger
    // this size that is not a rounding error, it is a wrong denominator on the
    // one screen whose job is to state the denominator.
    //
    // 620 rows: a naive implementation reports 500 and fails here.
    const dir = tempDir();
    writeRows(
      dir,
      Array.from({ length: 620 }, (_, i) =>
        row({
          seq: i + 1,
          at: 1_000 + i,
          decision: i % 10 === 0 ? "DENY" : "ALLOW",
        }),
      ),
    );
    const s = summariseBoundaryReceipts({ dir });
    expect(s.recorded).toBe(620);
    expect(s.refusals).toBe(62);
    expect(s.truncated).toBe(false);
  });

  it("reports nothing recorded, never zero refusals, on an absent ledger", () => {
    // "0 refusals" reads as "your policy is fine". On an empty ledger it means
    // "the boundary has never run here" — the same distinction `privacy
    // shadow` refuses to blur.
    const s = summariseBoundaryReceipts({ dir: tempDir() });
    expect(s.recorded).toBe(0);
    expect(formatBoundaryReceipts(s)).toContain("nothing recorded");
    expect(formatBoundaryReceipts(s)).not.toMatch(/\b0 refusals\b/);
  });

  it("leads with the denominator and never prints a bare refusal count", () => {
    const dir = tempDir();
    writeRows(dir, [
      row({ seq: 1, decision: "ALLOW" }),
      row({ seq: 2, decision: "DENY", classification: "personal" }),
      row({ seq: 3, decision: "LOCAL_ONLY", classification: "personal" }),
    ]);
    const out = formatBoundaryReceipts(summariseBoundaryReceipts({ dir }));
    const firstCount = out.indexOf("3");
    const refusalWord = out.search(/refus/i);
    expect(firstCount).toBeGreaterThanOrEqual(0);
    expect(refusalWord).toBeGreaterThan(firstCount);
    expect(out).toContain("2 of 3");
  });

  it("survives a malformed line without losing the rest of the ledger", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, BOUNDARY_RECEIPTS_BASENAME),
      `${JSON.stringify(row({ seq: 1 }))}\n{not json\n${JSON.stringify(row({ seq: 2, decision: "DENY" }))}\n`,
    );
    const s = summariseBoundaryReceipts({ dir });
    expect(s.recorded).toBe(2);
    expect(s.unreadableLines).toBe(1);
  });

  it("filters by since without changing what the denominator MEANS", () => {
    const dir = tempDir();
    writeRows(dir, [
      row({ seq: 1, at: 1_000 }),
      row({ seq: 2, at: 5_000, decision: "DENY" }),
    ]);
    const s = summariseBoundaryReceipts({ dir, since: 4_000 });
    expect(s.recorded).toBe(1);
    expect(s.refusals).toBe(1);
    expect(s.since).toBe(4_000);
  });

  it("groups by decision, destination and recipe for the fix list", () => {
    const dir = tempDir();
    writeRows(dir, [
      row({
        seq: 1,
        decision: "DENY",
        destinationId: "remote-model",
        recipeName: "a",
      }),
      row({
        seq: 2,
        decision: "DENY",
        destinationId: "remote-model",
        recipeName: "a",
      }),
      row({
        seq: 3,
        decision: "ALLOW",
        destinationId: "local-llm",
        recipeName: "b",
      }),
    ]);
    const s = summariseBoundaryReceipts({ dir });
    expect(s.byDecision.DENY).toBe(2);
    expect(s.byDestination["remote-model"]).toBe(2);
    expect(s.refusalsByRecipe.a).toBe(2);
    expect(s.refusalsByRecipe.b).toBeUndefined();
  });

  it("NEVER surfaces a payload field, even if one is somehow on disk", () => {
    // The receipt type has no payload by construction. If a future writer or a
    // hand-edited file smuggles one in, the reader must not become the thing
    // that publishes it.
    const dir = tempDir();
    writeRows(dir, [
      row({
        seq: 1,
        decision: "DENY",
        prompt: "SECRET-PAYLOAD",
        text: "SECRET-PAYLOAD",
      }),
    ]);
    const s = summariseBoundaryReceipts({ dir });
    const rendered = `${formatBoundaryReceipts(s)}\n${JSON.stringify(s)}`;
    expect(rendered).not.toContain("SECRET-PAYLOAD");
  });
});

describe("boundaryReceiptsPath", () => {
  it("resolves to the same file the writer appends to", () => {
    // The writer is `new BoundaryReceiptLog({ dir: patchworkPath() })`, which
    // joins this basename. A reader pointed one directory off would report an
    // empty ledger forever and look exactly like a quiet boundary.
    const dir = tempDir();
    expect(boundaryReceiptsPath(dir)).toBe(
      path.join(dir, "boundary_receipts.jsonl"),
    );
  });
});
