/**
 * Per-attempt ledger storage for automated runs. Every logical attempt gets its
 * own directory, so one run's rollback pre-images can never be evicted by an
 * unrelated run, and a redelivered webhook resolves to the same store.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attemptIdFor,
  attemptLedgerDir,
  attemptStoreFor,
  findAttemptByRun,
  gcRunLedgers,
  prepareAttemptLedger,
  recordAttemptRun,
} from "../runLedgers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "run-ledgers-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("attemptIdFor", () => {
  it("webhook delivery → stable id from the delivery", () => {
    expect(attemptIdFor({ deliveryId: "d-123" })).toBe("webhook-d-123");
    expect(attemptIdFor({ deliveryId: "d-123" })).toBe(
      attemptIdFor({ deliveryId: "d-123" }),
    );
  });

  it("cron → stable id from the canonical slot (floored to the minute)", () => {
    const a = attemptIdFor({ cronSlotEpochMs: 1_790_000_040_123 });
    const b = attemptIdFor({ cronSlotEpochMs: 1_790_000_040_999 });
    expect(a).toBe(b);
    expect(a).toMatch(/^cron-\d+$/);
  });

  it("anything else → a fresh id every time", () => {
    expect(attemptIdFor({})).not.toBe(attemptIdFor({}));
  });

  it("a delivery id that is not a safe attempt id is hashed, never used raw", () => {
    const id = attemptIdFor({ deliveryId: "../../etc/passwd x".repeat(5) });
    expect(id).toMatch(/^webhook-h-[0-9a-f]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("every id satisfies the manualRunId contract", () => {
    for (const id of [
      attemptIdFor({ deliveryId: "d-1" }),
      attemptIdFor({ cronSlotEpochMs: 1 }),
      attemptIdFor({}),
    ]) {
      expect(id).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
  });
});

describe("attemptLedgerDir / prepareAttemptLedger", () => {
  it("the path component is opaque — neither recipe name nor attempt id appears", () => {
    const d = attemptLedgerDir(root, "my-recipe", "webhook-secret-delivery");
    const leaf = path.basename(d);
    expect(leaf).not.toContain("my-recipe");
    expect(leaf).not.toContain("secret");
    expect(path.dirname(d)).toBe(root);
  });

  it("same (recipe, attempt) → same dir; different attempt → different dir", () => {
    expect(attemptLedgerDir(root, "r", "a")).toBe(
      attemptLedgerDir(root, "r", "a"),
    );
    expect(attemptLedgerDir(root, "r", "a")).not.toBe(
      attemptLedgerDir(root, "r", "b"),
    );
  });

  it("creates the directory and returns it", () => {
    const d = prepareAttemptLedger(root, "r", "a");
    expect(d).toBeDefined();
    expect(existsSync(d as string)).toBe(true);
  });

  it("returns undefined (fail closed) when the store cannot be created", () => {
    const blocker = path.join(root, "blocked");
    writeFileSync(blocker, "a file where the root dir should be");
    expect(prepareAttemptLedger(blocker, "r", "a")).toBeUndefined();
  });
});

describe("recordAttemptRun / findAttemptByRun", () => {
  it("resolves a run's store from its taskId", () => {
    const d = prepareAttemptLedger(root, "r", "cron-5") as string;
    recordAttemptRun(d, {
      runTaskId: "task-1",
      recipeName: "r",
      attemptId: "cron-5",
    });
    expect(findAttemptByRun(root, "task-1")).toEqual({
      dir: d,
      recipeName: "r",
      attemptId: "cron-5",
    });
    expect(findAttemptByRun(root, "task-unknown")).toBeUndefined();
  });

  it("two runs of one redelivered attempt both resolve to the same store", () => {
    const d = prepareAttemptLedger(root, "r", "webhook-d") as string;
    recordAttemptRun(d, {
      runTaskId: "t1",
      recipeName: "r",
      attemptId: "webhook-d",
    });
    recordAttemptRun(d, {
      runTaskId: "t2",
      recipeName: "r",
      attemptId: "webhook-d",
    });
    expect(findAttemptByRun(root, "t1")?.dir).toBe(d);
    expect(findAttemptByRun(root, "t2")?.dir).toBe(d);
  });
});

describe("gcRunLedgers — whole-run retention", () => {
  const DAY = 86_400_000;
  function aged(recipe: string, attempt: string, ageMs: number): string {
    const d = prepareAttemptLedger(root, recipe, attempt) as string;
    writeFileSync(path.join(d, "file_rollback.jsonl"), "{}\n");
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path.join(d, "file_rollback.jsonl"), t, t);
    utimesSync(d, t, t);
    return d;
  }

  it("removes whole stores older than the window, keeps recent ones", () => {
    const old = aged("r", "old", 30 * DAY);
    const fresh = aged("r", "fresh", 1 * DAY);
    const removed = gcRunLedgers(root, { retentionMs: 14 * DAY });
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never removes an active attempt, however old it looks", () => {
    const old = aged("r", "still-running", 30 * DAY);
    gcRunLedgers(root, {
      retentionMs: 14 * DAY,
      active: new Set([path.basename(old)]),
    });
    expect(existsSync(old)).toBe(true);
  });

  it("ignores stray files and a missing root", () => {
    writeFileSync(path.join(root, "stray.txt"), "x");
    expect(gcRunLedgers(root, { retentionMs: 1 })).toBe(0);
    expect(gcRunLedgers(path.join(root, "nope"), { retentionMs: 1 })).toBe(0);
    expect(readdirSync(root)).toContain("stray.txt");
  });
});

describe("attemptStoreFor — the production choice of store", () => {
  it("the same webhook delivery reuses the same store (redelivery)", () => {
    const a = attemptStoreFor("r", { deliveryId: "d-9" }, root);
    const b = attemptStoreFor("r", { deliveryId: "d-9" }, root);
    expect(a.ledgerDir).toBeDefined();
    expect(b).toEqual(a);
  });

  it("the same cron slot reuses its store; a different slot does not", () => {
    const t = 1_790_000_000_000;
    expect(attemptStoreFor("r", { cronSlotEpochMs: t }, root)).toEqual(
      attemptStoreFor("r", { cronSlotEpochMs: t + 5 }, root),
    );
    expect(
      attemptStoreFor("r", { cronSlotEpochMs: t }, root).ledgerDir,
    ).not.toBe(
      attemptStoreFor("r", { cronSlotEpochMs: t + 60_000 }, root).ledgerDir,
    );
  });

  it("a store that cannot be created yields NO ledgerDir (fail closed)", () => {
    const blocker = path.join(root, "blocked");
    writeFileSync(blocker, "x");
    const s = attemptStoreFor("r", {}, blocker);
    expect(s.ledgerDir).toBeUndefined();
    expect(s.attemptId).toMatch(/^once-/);
  });
});
