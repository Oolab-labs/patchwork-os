/**
 * ADR-0027 — `outcome-log.jsonl` routed through the chained append primitive.
 *
 * This ledger is the trust-replay store, and its reader has one property the
 * other chained ledgers do not: it REPORTS rows it cannot key (`unkeyableRows`)
 * instead of dropping them. A `chain-start` / `rotation` marker has no key, so
 * without an explicit skip every load would report a false defect. The tests
 * here prove the migration boundary (legacy prefix untouched, committed to,
 * first new row chained), the marker skip, and that the write-side contract —
 * `upsert` throws on an unkeyable record and writes nothing — survives.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendChained, verifyLedgerChain } from "../../ledgerChain.js";
import { AmbiguousActionRefError } from "../actionRef.js";
import { OUTCOME_LOG_RV, OutcomeStore } from "../outcomeStore.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "outcome-chain-"));
  file = path.join(dir, "outcome-log.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dataRows = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    // ADR-0027 marker rows live in the same file and are not records.
    .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");

describe("outcome-log chain", () => {
  it("chains after a legacy prefix and stamps rv on the new row", () => {
    const legacy =
      '{"issueUrl":"https://example.test/issues/1","disposition":"junk","checkedAt":1}\n';
    writeFileSync(file, legacy);

    const store = new OutcomeStore(dir);
    store.upsert({
      issueUrl: "https://example.test/issues/2",
      disposition: "confirmed",
      checkedAt: 2,
      origin: "manual",
    });

    expect(readFileSync(file, "utf-8").startsWith(legacy)).toBe(true);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    expect(v.chainedRows).toBe(1);

    const rows = dataRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty("rv"); // legacy row never re-stamped
    expect(rows[1]).toMatchObject({ rv: OUTCOME_LOG_RV, iseq: 1 });
    expect(typeof rows[1]?.prev).toBe("string");

    expect(store.getDisposition("https://example.test/issues/1")).toBe("junk");
    expect(store.getDisposition("https://example.test/issues/2")).toBe(
      "confirmed",
    );
    // A fresh instance over the same file agrees.
    expect(
      new OutcomeStore(dir).getDisposition("https://example.test/issues/2"),
    ).toBe("confirmed");
  });

  it("does not report chain markers as unkeyable rows", () => {
    appendChained(file, {
      issueUrl: "https://example.test/issues/9",
      disposition: "confirmed",
      checkedAt: 9,
      rv: OUTCOME_LOG_RV,
    });
    const store = new OutcomeStore(dir);
    expect(store.unkeyableRows()).toEqual([]);
    expect(store.readAll()).toHaveLength(1);
    expect(store.readAll()[0]).toMatchObject({
      issueUrl: "https://example.test/issues/9",
      disposition: "confirmed",
    });
  });

  it("upsert of an unkeyable record still throws and writes nothing", () => {
    const store = new OutcomeStore(dir);
    store.upsert({
      issueUrl: "https://example.test/issues/1",
      disposition: "confirmed",
      checkedAt: 1,
    });
    const before = readFileSync(file, "utf-8");
    const headBefore = readFileSync(`${file}.head`, "utf-8");

    expect(() =>
      store.upsert({ disposition: "confirmed", checkedAt: 2 }),
    ).toThrowError(AmbiguousActionRefError);

    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(readFileSync(`${file}.head`, "utf-8")).toBe(headBefore);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.chainedRows).toBe(1);
    expect(v.writeFailedPending).toBe(0);
  });
});
