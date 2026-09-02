/**
 * `patchwork evidence verify` — ADR-0027's offline reader over the spine.
 *
 * Counts and positions only, never a value. A break is a machine-readable
 * failure: `ok: false` in the report and exit 1 at the CLI.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPINE_LEDGERS } from "../evidenceCoverage.js";
import {
  formatEvidenceVerify,
  verifyEvidenceChains,
} from "../evidenceVerify.js";
import { appendChained, recordWriteFailure } from "../ledgerChain.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "evidence-verify-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ledger = (name: string) => path.join(dir, name);

describe("verifyEvidenceChains", () => {
  it("covers every spine ledger and reports absent ones as absent and ok", () => {
    const r = verifyEvidenceChains(dir);
    expect(r.ledgers.map((l) => l.file)).toEqual(
      SPINE_LEDGERS.map((l) => l.file),
    );
    expect(r.ledgers.every((l) => l.absent)).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("is ok when every present ledger verifies, and carries the counts", () => {
    appendChained(ledger("boundary_receipts.jsonl"), {
      seq: 1,
      at: 1,
      decision: "ALLOW",
    });
    appendChained(ledger("boundary_receipts.jsonl"), {
      seq: 2,
      at: 2,
      decision: "ALLOW",
    });
    const r = verifyEvidenceChains(dir);
    expect(r.ok).toBe(true);
    const rec = r.ledgers.find((l) => l.file === "boundary_receipts.jsonl");
    expect(rec).toMatchObject({ absent: false, chainedRows: 2, breaks: [] });
  });

  it("flips ok to false on a single break in any ledger and names the ledger and position", () => {
    const f = ledger("worker_gate_decisions.jsonl");
    appendChained(f, { seq: 1, workerId: "w", toolName: "t", action: "allow" });
    appendChained(f, { seq: 2, workerId: "w", toolName: "t", action: "gate" });
    writeFileSync(
      f,
      readFileSync(f, "utf-8").replace('"action":"allow"', '"action":"gate"'),
    );
    const r = verifyEvidenceChains(dir);
    expect(r.ok).toBe(false);
    const gate = r.ledgers.find(
      (l) => l.file === "worker_gate_decisions.jsonl",
    );
    expect(gate?.breaks).toEqual([
      expect.objectContaining({ kind: "hash", iseq: 2, line: 3 }),
    ]);
  });

  it("surfaces pending write failures as NOT ok — a ledger that stopped writing is not a quiet day", () => {
    const f = ledger("privacy_shadow.jsonl");
    appendChained(f, { at: 1 });
    recordWriteFailure(f, "EACCES");
    const r = verifyEvidenceChains(dir);
    expect(r.ok).toBe(false);
    expect(
      r.ledgers.find((l) => l.file === "privacy_shadow.jsonl"),
    ).toMatchObject({
      writeFailedPending: 1,
    });
  });
});

describe("formatEvidenceVerify", () => {
  it("prints counts and positions, and never a row value", () => {
    const f = ledger("outcome-log.jsonl");
    appendChained(f, {
      issueUrl: "https://example.test/issues/1",
      disposition: "confirmed",
    });
    appendChained(f, {
      issueUrl: "https://example.test/issues/2",
      disposition: "junk",
    });
    writeFileSync(f, readFileSync(f, "utf-8").replace("junk", "confirmed"));
    const out = formatEvidenceVerify(verifyEvidenceChains(dir));
    expect(out).toContain("BROKEN");
    expect(out).toContain("outcome-log.jsonl");
    expect(out).toMatch(/hash .*line 3/);
    expect(out).not.toContain("example.test");
    expect(out).not.toContain("confirmed");
  });

  it("says ABSENT for a missing ledger and never '0 rows'", () => {
    const out = formatEvidenceVerify(verifyEvidenceChains(dir));
    expect(out).toContain("ABSENT");
    expect(out).not.toMatch(/\b0 rows\b/);
  });
});
