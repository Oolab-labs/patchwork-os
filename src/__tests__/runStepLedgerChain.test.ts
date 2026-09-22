/**
 * ADR-0027 wave 2, PR 2 — `run_steps.jsonl` is chained.
 *
 * The writer was a bare never-throwing `appendFileSync` with a hand-rolled
 * "drop half the file at 2 MB" trim. It now goes through `appendChained`:
 * locked, `iseq` + `prev`, an explicit rotation marker instead of a silent
 * halving, a head sidecar, and a failed append counted then sealed. The
 * never-throw contract is unchanged — losing a mid-flight row must not take
 * down the run that produced it.
 *
 * Rotation is asserted as BOUNDED AND VALID, not as "exactly half": the old
 * ratio was an implementation detail, and the property that matters is that
 * the file stays under its cap, the newest rows survive, and the chain still
 * verifies across the marker.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPINE_LEDGERS } from "../evidenceCoverage.js";
import { VERIFIED_LEDGERS, verifyEvidenceChains } from "../evidenceVerify.js";
import { chainSidecarPaths, verifyLedgerChain } from "../ledgerChain.js";
import type { RunStepResult } from "../runLog.js";
import {
  appendStepEvidence,
  loadStepEvidence,
  RUN_STEP_LEDGER_RV,
  type RunStepLedgerRow,
  stepLedgerPath,
} from "../runStepLedger.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "runsteps-chain-"));
  file = stepLedgerPath(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const step = (
  id: string,
  over: Partial<RunStepResult> = {},
): RunStepResult => ({
  id,
  tool: "http.post",
  status: "ok",
  durationMs: 5,
  ...over,
});
const row = (
  taskId: string,
  id: string,
  over: Partial<RunStepResult> = {},
): RunStepLedgerRow => ({
  taskId,
  seq: 1,
  recipeName: "noisy-recipe",
  at: 1000,
  step: step(id, over),
});
const physical = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const LEGACY =
  '{"taskId":"legacy-task","seq":1,"recipeName":"noisy-recipe","at":1,"step":{"id":"s1","tool":"http.post","status":"ok","durationMs":1}}\n';

describe("the writer", () => {
  it("stamps rv, iseq and prev and the chain verifies", () => {
    appendStepEvidence(dir, row("t1", "s1"));
    appendStepEvidence(dir, row("t1", "s2"));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.chainedRows).toBe(2);
    expect(v.head).toBe("ok");
    const data = physical().filter((r) => r.kind === undefined);
    expect(data[0]).toMatchObject({ rv: RUN_STEP_LEDGER_RV, iseq: 1 });
    expect(data[1]).toMatchObject({ rv: RUN_STEP_LEDGER_RV, iseq: 2 });
    expect(typeof data[1]?.prev).toBe("string");
  });

  it("leaves a legacy ledger byte-identical and commits to it with chain-start", () => {
    writeFileSync(file, LEGACY);
    appendStepEvidence(dir, row("t1", "s1"));
    expect(readFileSync(file, "utf-8").startsWith(LEGACY)).toBe(true);
    expect(physical()[0]).not.toHaveProperty("rv");
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    // The legacy row is still evidence for its task.
    expect(loadStepEvidence(dir).get("legacy-task")).toHaveLength(1);
  });

  it("never throws on a failed append; the failure is pending, then sealed", () => {
    mkdirSync(file); // the ledger path is a directory, so the append fails
    expect(() => appendStepEvidence(dir, row("t1", "s1"))).not.toThrow();
    expect(existsSync(chainSidecarPaths(file).writeFailed)).toBe(true);
    rmSync(file, { recursive: true, force: true });
    expect(verifyLedgerChain(file).writeFailedPending).toBe(1);
    appendStepEvidence(dir, row("t1", "s1"));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.writeFailedPending).toBe(0);
    expect(v.writeFailedSealed).toBe(1);
  });
});

describe("rotation is bounded, explicit and still verifies", () => {
  it("keeps the file under its cap with a rotation marker, newest rows survive, chain intact", () => {
    const cap = 8_000;
    const pad = "x".repeat(120);
    for (let i = 1; i <= 120; i++) {
      appendStepEvidence(dir, row(`t${i}`, "s1", { error: pad }), undefined, {
        maxBytes: cap,
      });
    }
    expect(statSync(file).size).toBeLessThanOrEqual(cap + 400); // one row of slack past the cap
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.rotations).toBe(1);
    expect(v.droppedByRotation).toBeGreaterThan(0);
    expect(v.chainedRows + v.droppedByRotation).toBe(120);
    expect(v.lastIseq).toBe(120);
    expect(physical()[0]?.kind).toBe("rotation");
    // The newest task is present; the oldest was rotated away.
    const evidence = loadStepEvidence(dir);
    expect(evidence.has("t120")).toBe(true);
    expect(evidence.has("t1")).toBe(false);
  });
});

describe("the loader treats marker rows as metadata", () => {
  it("skips markers by kind, even one that carries a taskId and a step", () => {
    appendStepEvidence(dir, row("t1", "s1"));
    writeFileSync(
      file,
      `${readFileSync(file, "utf-8")}{"kind":"rotation","taskId":"phantom","step":{"id":"s1"},"droppedRows":0,"droppedLegacyRows":0,"lastDroppedHash":null,"lastDroppedIseq":null,"firstKeptIseq":null}\n`,
    );
    const evidence = loadStepEvidence(dir);
    expect(evidence.has("phantom")).toBe(false);
    expect(evidence.get("t1")).toHaveLength(1);
  });
});

describe("verifier and coverage lists", () => {
  it("the verifier covers run_steps.jsonl; the spine does not", () => {
    expect(VERIFIED_LEDGERS.some((l) => l.file === "run_steps.jsonl")).toBe(
      true,
    );
    expect(SPINE_LEDGERS.some((l) => l.file === "run_steps.jsonl")).toBe(false);
    appendStepEvidence(dir, row("t1", "s1"));
    expect(
      verifyEvidenceChains(dir).ledgers.find(
        (l) => l.file === "run_steps.jsonl",
      ),
    ).toMatchObject({ absent: false, chainedRows: 1, ok: true });
  });
});
