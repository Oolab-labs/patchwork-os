/**
 * ADR-0027 — `approval_log.jsonl` is chained.
 *
 * Verified through the real verifier and the real writers (`ApprovalQueue`
 * over `ApprovalPersistence`), never through a return value. The file is
 * seeded with a LEGACY prefix — a request + decision pair in the rv-1 shape,
 * written before the chain existed — so the test also proves the migration
 * boundary: legacy bytes untouched, committed to by the `chain-start` marker,
 * and the first new row chained after them.
 *
 * The restore path is exercised on the same file, because marker rows carry
 * `kind` and no `callId`, and `loadUnresolvedRequests` keys on `kind`. A
 * marker is neither a request nor a decision and must not break restore.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_LOG_RV,
  ApprovalPersistence,
} from "../approvalPersistence.js";
import { ApprovalQueue } from "../approvalQueue.js";
import { verifyLedgerChain } from "../ledgerChain.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-approval-chain-"));
  file = path.join(dir, "approval_log.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const allRows = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// ADR-0027 marker rows (`chain-start`, `rotation`) live in the same file and
// carry `kind` and no data fields; skipped the way every production loader
// skips them.
const dataRows = () =>
  allRows().filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");

// The rv-1 shape: `rv` on the request only, no integrity fields anywhere.
const LEGACY =
  '{"kind":"request","callId":"legacy-1","toolName":"gitPush","params":{},"tier":"high","requestedAt":1000,"expiresAt":null,"rv":1}\n' +
  '{"kind":"decision","callId":"legacy-1","decision":"approved","decidedAt":2000}\n';

describe("approval log chains after a legacy prefix", () => {
  it("commits to the legacy rows, chains new request and decision, and restore ignores markers", () => {
    writeFileSync(file, LEGACY);

    const queue = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    const { callId } = queue.request({
      toolName: "gitPush",
      params: { remote: "origin" },
      tier: "high",
    });
    queue.approve(callId);
    // A second request, left undecided, so restore has something to return.
    const { callId: openId } = queue.request({
      toolName: "gitPush",
      params: { remote: "upstream" },
      tier: "high",
    });

    // Legacy bytes are untouched.
    expect(readFileSync(file, "utf-8").startsWith(LEGACY)).toBe(true);

    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(2);
    expect(v.chainedRows).toBe(3);

    const rows = allRows();
    expect(rows[2]?.kind).toBe("chain-start");
    const fresh = dataRows().slice(2);
    expect(fresh.map((r) => r.kind)).toEqual([
      "request",
      "decision",
      "request",
    ]);
    expect(fresh.map((r) => r.iseq)).toEqual([1, 2, 3]);
    for (const r of fresh) {
      expect(r.rv).toBe(APPROVAL_LOG_RV);
      expect(typeof r.prev).toBe("string");
    }

    // Restore: exactly the undecided request, and the marker row neither
    // counts as a request nor breaks the replay.
    const unresolved = new ApprovalPersistence({
      dir,
    }).loadUnresolvedRequests();
    expect(unresolved.map((r) => r.callId)).toEqual([openId]);
    expect(unresolved[0]).toMatchObject({ rv: APPROVAL_LOG_RV, iseq: 3 });
    expect(typeof unresolved[0]?.prev).toBe("string");

    const restored = new ApprovalQueue({ persistDir: dir, ttlMs: 60_000 });
    expect(restored.list().map((e) => e.callId)).toEqual([openId]);
  });

  it("a marker row alone is neither a request nor a decision", () => {
    writeFileSync(
      file,
      `${JSON.stringify({
        kind: "chain-start",
        at: 1,
        legacyRows: 0,
        legacyBytes: 0,
        legacyHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      })}\n`,
    );
    expect(new ApprovalPersistence({ dir }).loadUnresolvedRequests()).toEqual(
      [],
    );
    expect(new ApprovalQueue({ persistDir: dir }).list()).toEqual([]);
  });

  it("rv is bumped past the pre-chain level", () => {
    expect(APPROVAL_LOG_RV).toBeGreaterThanOrEqual(2);
  });
});
