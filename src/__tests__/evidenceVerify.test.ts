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
  VERIFIED_LEDGERS,
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
  it("covers every spine ledger, and an EMPTY directory is NOT intact — it verified nothing", () => {
    // Audit 2026-10-15 (H6): nine ABSENT lines followed by STATUS: INTACT and
    // exit 0. A wrong --dir, or every ledger deleted, read as a clean spine.
    // Same rule as audit-shipped-identifiers: a scan of zero files FAILS.
    const r = verifyEvidenceChains(dir);
    // The verifier's list is the spine PLUS non-spine chained ledgers; the
    // spine itself is the coverage/correlation set and must not grow here.
    expect(r.ledgers.map((l) => l.file)).toEqual(
      VERIFIED_LEDGERS.map((l) => l.file),
    );
    expect(r.ledgers.length).toBeGreaterThan(SPINE_LEDGERS.length);
    expect(r.ledgers.every((l) => l.absent)).toBe(true);
    expect(r.verified).toBe(0);
    expect(r.absent).toBe(VERIFIED_LEDGERS.length);
    expect(r.ok).toBe(false);
    const out = formatEvidenceVerify(r);
    expect(out).toContain("STATUS: NOTHING VERIFIED");
    expect(out).not.toContain("STATUS: INTACT");
  });

  it("one present, intact ledger beside legitimately absent ones IS intact, and says the counts", () => {
    appendChained(ledger("run_steps.jsonl"), { seq: 1, at: 1 });
    const r = verifyEvidenceChains(dir);
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(1);
    expect(r.absent).toBe(VERIFIED_LEDGERS.length - 1);
    const out = formatEvidenceVerify(r);
    expect(out).toMatch(
      new RegExp(
        `STATUS: INTACT \\(1 of ${VERIFIED_LEDGERS.length} verified, ${VERIFIED_LEDGERS.length - 1} absent`,
      ),
    );
  });

  it("a ledger whose file is gone but whose .head sidecar remains is a BREAK, not absent", () => {
    // The sidecar is the only thing that can say the file used to be longer.
    // With the file deleted it was never consulted, so a deleted ledger passed.
    const f = ledger("approval_log.jsonl");
    appendChained(f, { seq: 1, at: 1, kind: "request" });
    rmSync(f);
    const r = verifyEvidenceChains(dir);
    const l = r.ledgers.find((x) => x.file === "approval_log.jsonl");
    expect(l?.absent).toBe(true);
    expect(l?.head).toBe("orphaned");
    expect(l?.ok).toBe(false);
    expect(l?.breaks.map((b) => b.kind)).toContain("missing-file");
    expect(r.missingWithHead).toBe(1);
    expect(r.ok).toBe(false);
    const out = formatEvidenceVerify(r);
    expect(out).toContain("MISSING");
    expect(out).toContain("approval_log.jsonl");
    expect(out).toContain("STATUS: NOT INTACT");
  });

  it("legacy rows with no chain are UNCHAINED — non-fatal by default, fatal under expectChained", () => {
    writeFileSync(
      ledger("outcome-log.jsonl"),
      '{"seq":1,"issueUrl":"https://example.test/1","disposition":"junk"}\n',
    );
    appendChained(ledger("run_steps.jsonl"), { seq: 1, at: 1 });
    const r = verifyEvidenceChains(dir);
    expect(r.unchained).toBe(1);
    expect(r.verified).toBe(1);
    expect(r.ok).toBe(true);
    expect(formatEvidenceVerify(r)).toMatch(/UNCHAINED\s+outcome-log\.jsonl/);
    const strict = verifyEvidenceChains(dir, { expectChained: true });
    expect(strict.ok).toBe(false);
    expect(formatEvidenceVerify(strict)).toContain("STATUS: NOT INTACT");
  });

  it("--json carries the four counts", () => {
    appendChained(ledger("run_steps.jsonl"), { seq: 1, at: 1 });
    const r = verifyEvidenceChains(dir);
    expect(r).toMatchObject({
      verified: 1,
      absent: VERIFIED_LEDGERS.length - 1,
      unchained: 0,
      missingWithHead: 0,
    });
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
