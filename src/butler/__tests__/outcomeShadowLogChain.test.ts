/**
 * ADR-0027 wave 2, PR 1 — `butler_outcome_shadow.jsonl` is chained.
 *
 * The writer was a bare best-effort `appendFileSync`: no lock, no integrity
 * fields, and a failed append indistinguishable from a quiet day. It now goes
 * through `appendChained`, keeps its never-throw contract (a measurement must
 * never fail the errand it observes), and gains a writer-owned `rv: 1`.
 *
 * Every reader of this ledger validates rows by shape, so marker rows fell out
 * by accident before this PR. The tests here make that explicit: a marker is
 * metadata, never a graded outcome, in the summary, in first-seen and in the
 * rows promotion reads.
 *
 * The verifier gains this ledger; `patchwork evidence` coverage does NOT. The
 * spine list is the correlation set and adding a non-spine ledger there would
 * change denominators an operator is already reading.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPINE_LEDGERS } from "../../evidenceCoverage.js";
import {
  VERIFIED_LEDGERS,
  verifyEvidenceChains,
} from "../../evidenceVerify.js";
import { chainSidecarPaths, verifyLedgerChain } from "../../ledgerChain.js";
import {
  appendShadowOutcome,
  firstSeenByRef,
  readShadowRows,
  SHADOW_LOG_BASENAME,
  SHADOW_OUTCOME_RV,
  shadowLogPath,
  summariseShadowLog,
} from "../outcomeShadowLog.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-shadow-chain-"));
  file = shadowLogPath(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const physicalRows = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const grade = (
  ref: string,
  disposition: "confirmed" | "junk" | "unknown",
  gradedAt: number,
) =>
  appendShadowOutcome(
    {
      ref,
      disposition,
      reason: "completed",
      gradedAt,
      recipe: "noisy-recipe",
    },
    { dir },
  );

const LEGACY =
  '{"ref":"todoist.create_task:1","disposition":"unknown","reason":"open-recent","gradedAt":1000,"wouldCountAsEvidence":false}\n';

describe("the writer", () => {
  it("stamps rv, iseq and prev and produces a chain the verifier accepts", () => {
    grade("todoist.create_task:1", "confirmed", 2000);
    grade("todoist.create_task:2", "junk", 3000);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.chainedRows).toBe(2);
    expect(v.head).toBe("ok");
    const data = physicalRows().filter((r) => r.kind === undefined);
    expect(data[0]).toMatchObject({ rv: SHADOW_OUTCOME_RV, iseq: 1 });
    expect(data[1]).toMatchObject({ rv: SHADOW_OUTCOME_RV, iseq: 2 });
    expect(typeof data[1]?.prev).toBe("string");
  });

  it("leaves a legacy ledger byte-identical and commits to it with chain-start", () => {
    writeFileSync(file, LEGACY);
    grade("todoist.create_task:1", "confirmed", 2000);
    expect(readFileSync(file, "utf-8").startsWith(LEGACY)).toBe(true);
    expect(physicalRows()[0]).not.toHaveProperty("rv");
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    expect(v.chainedRows).toBe(1);
  });

  it("acquires the SHARED lock: a stale lock left by a dead writer is cleared, not fatal", () => {
    const lock = `${file}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    grade("todoist.create_task:1", "confirmed", 2000);
    expect(existsSync(lock)).toBe(false);
    expect(verifyLedgerChain(file).chainedRows).toBe(1);
  });

  it("still never throws on a failed append, and the failure becomes visible then sealed", () => {
    // The ledger path is a DIRECTORY, so the append fails (EISDIR) while the
    // sidecar beside it can still be written.
    mkdirSync(file);
    expect(() =>
      grade("todoist.create_task:1", "confirmed", 2000),
    ).not.toThrow();
    expect(existsSync(chainSidecarPaths(file).writeFailed)).toBe(true);
    rmSync(file, { recursive: true, force: true });
    // Ledger absent, failure pending: two different facts, both reported.
    let v = verifyLedgerChain(file);
    expect(v.absent).toBe(true);
    expect(v.writeFailedPending).toBe(1);
    grade("todoist.create_task:1", "confirmed", 3000);
    v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.writeFailedPending).toBe(0);
    expect(v.writeFailedSealed).toBe(1);
  });
});

describe("readers treat marker rows as metadata, never as graded outcomes", () => {
  beforeEach(() => {
    writeFileSync(file, LEGACY);
    grade("todoist.create_task:1", "confirmed", 2000);
    grade("todoist.create_task:2", "unknown", 2500);
    // The physical file now holds: legacy row, chain-start marker, two rows.
    expect(physicalRows().some((r) => r.kind === "chain-start")).toBe(true);
  });

  it("summary counts errands (last grade wins), not markers", () => {
    const s = summariseShadowLog({ dir });
    expect(s.total).toBe(2);
    expect(s.confirmed).toBe(1);
    expect(s.unknown).toBe(1);
  });

  it("first-seen has one entry per ref and no entry for a marker", () => {
    const seen = firstSeenByRef({ dir });
    expect([...seen.keys()].sort()).toEqual([
      "todoist.create_task:1",
      "todoist.create_task:2",
    ]);
    expect(seen.get("todoist.create_task:1")).toBe(1000);
  });

  it("the rows promotion reads are all graded rows", () => {
    const rows = readShadowRows(dir);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => typeof r.ref === "string" && !("kind" in r))).toBe(
      true,
    );
  });

  it("a marker that LOOKS like a row is still skipped by kind, not by luck", () => {
    // A future marker shape that happened to carry `ref` and `disposition`
    // must still be excluded — the skip is on `kind`, not on missing fields.
    writeFileSync(
      file,
      `${readFileSync(file, "utf-8")}{"kind":"rotation","ref":"x:1","disposition":"confirmed","gradedAt":9,"droppedRows":0,"droppedLegacyRows":0,"lastDroppedHash":null,"lastDroppedIseq":null,"firstKeptIseq":null}\n`,
    );
    expect(readShadowRows(dir).some((r) => r.ref === "x:1")).toBe(false);
    expect(firstSeenByRef({ dir }).has("x:1")).toBe(false);
  });
});

describe("verifier and coverage lists", () => {
  it("the verifier covers the spine PLUS this ledger", () => {
    expect(VERIFIED_LEDGERS.map((l) => l.file)).toEqual([
      ...SPINE_LEDGERS.map((l) => l.file),
      SHADOW_LOG_BASENAME,
    ]);
    grade("todoist.create_task:1", "confirmed", 2000);
    const r = verifyEvidenceChains(dir);
    expect(r.ledgers.find((l) => l.file === SHADOW_LOG_BASENAME)).toMatchObject(
      {
        absent: false,
        chainedRows: 1,
        ok: true,
      },
    );
  });

  it("patchwork evidence coverage does NOT gain a Butler shadow denominator", () => {
    expect(SPINE_LEDGERS.some((l) => l.file === SHADOW_LOG_BASENAME)).toBe(
      false,
    );
  });
});
