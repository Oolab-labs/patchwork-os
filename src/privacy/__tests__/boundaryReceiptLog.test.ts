import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BoundaryReceiptLog } from "../boundaryReceiptLog.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pw-receipts-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const BASE = {
  decision: "DENY" as const,
  classification: "restricted" as const,
  destinationId: "remote-model",
  destinationType: "remote" as const,
  reason: "not cleared",
};

describe("BoundaryReceiptLog", () => {
  it("persists a receipt and reads it back across instances", () => {
    const dir = tempDir();
    new BoundaryReceiptLog({ dir, now: () => 1 }).record(BASE);
    const reopened = new BoundaryReceiptLog({ dir });
    expect(reopened.recent()).toHaveLength(1);
    expect(reopened.recent()[0]).toMatchObject({
      decision: "DENY",
      classification: "restricted",
      destinationId: "remote-model",
    });
  });

  it("HAS NO FIELD FOR THE PAYLOAD", () => {
    // The one property this file must hold. A privacy audit log containing the
    // prompts would be the largest unclassified copy of exactly the material
    // the boundary exists to protect, sitting in plain JSONL.
    const dir = tempDir();
    const log = new BoundaryReceiptLog({ dir });
    log.record({
      ...BASE,
      categories: ["alpha"],
      // A caller trying to sneak the payload through must not succeed. Cast
      // because the interface has no such field — which is the point.
      ...({ prompt: "SENSITIVE-PAYLOAD", text: "SENSITIVE-PAYLOAD" } as Record<
        string,
        string
      >),
    });
    const onDisk = readFileSync(
      path.join(dir, "boundary_receipts.jsonl"),
      "utf-8",
    );
    expect(onDisk).not.toContain("SENSITIVE-PAYLOAD");
    // Category NAMES are metadata and are kept; their contents never appear.
    expect(onDisk).toContain("alpha");
  });

  it("clips a runaway reason", () => {
    const dir = tempDir();
    const log = new BoundaryReceiptLog({ dir });
    const r = log.record({ ...BASE, reason: "x".repeat(5000) });
    expect(r.reason.length).toBeLessThanOrEqual(500);
  });

  it("survives a malformed line rather than losing the whole log", () => {
    const dir = tempDir();
    const log = new BoundaryReceiptLog({ dir });
    log.record(BASE);
    const file = path.join(dir, "boundary_receipts.jsonl");
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(file, "{ not json\n");
    log.record({ ...BASE, decision: "ALLOW", classification: "public" });

    const reopened = new BoundaryReceiptLog({ dir });
    // One bad line must cost one line, not the audit trail.
    expect(reopened.recent()).toHaveLength(2);
  });

  it("never throws when the directory is unwritable", () => {
    // Observability, not enforcement: the decision has already been made and
    // enforced by the time a receipt is attempted.
    const log = new BoundaryReceiptLog({
      dir: "/proc/nonexistent-pw-receipts",
    });
    expect(() => log.record(BASE)).not.toThrow();
  });

  it("summarises counts per decision", () => {
    const dir = tempDir();
    const log = new BoundaryReceiptLog({ dir });
    log.record(BASE);
    log.record({ ...BASE, decision: "ALLOW", classification: "public" });
    log.record({ ...BASE, decision: "ALLOW", classification: "internal" });
    expect(log.summary()).toMatchObject({ ALLOW: 2, DENY: 1, LOCAL_ONLY: 0 });
  });
});
