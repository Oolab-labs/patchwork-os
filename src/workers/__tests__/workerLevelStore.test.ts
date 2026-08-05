import { describe, expect, it } from "vitest";
import type { GraduationConfig } from "../graduation.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const CFG: GraduationConfig = {
  dwellMs: 1000,
  demoteCooldownMs: 5000,
  minEvidenceForGraduation: 5,
};
const W = "release-bot";

function climbToL4(store: WorkerLevelStore, worker: string) {
  for (let i = 0; i < 60; i++) {
    store.apply(
      worker,
      { toolName: "editText", good: true, at: 0 },
      { cfg: CFG },
    );
  }
  for (const at of [1000, 2000, 3000, 4000]) {
    store.apply(worker, { toolName: "editText", good: true, at }, { cfg: CFG });
  }
}

describe("WorkerLevelStore", () => {
  it("accumulates per-class trust and surfaces it on the dial board", () => {
    const store = new WorkerLevelStore();
    climbToL4(store, W);
    const board = store.board(W);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      classKey: "fs-write:reversible:medium",
      level: 4,
      observations: 64,
    });
  });

  it("records promotion events stamped with the worker id (audit log)", () => {
    const store = new WorkerLevelStore();
    climbToL4(store, W);
    const ev = store.events(W);
    expect(ev.length).toBeGreaterThanOrEqual(4);
    expect(ev.every((e) => e.workerId === W)).toBe(true);
    expect(ev[0]!.type).toBe("promote");
  });

  it("isolates trust per worker", () => {
    const store = new WorkerLevelStore();
    climbToL4(store, W);
    store.apply(
      "other-bot",
      { toolName: "runTests", good: true, at: 0 },
      { cfg: CFG },
    );
    expect(store.board(W)).toHaveLength(1); // unaffected
    expect(store.board("other-bot")).toHaveLength(1);
    expect(store.events("other-bot")).toHaveLength(0);
  });

  it("round-trips state + audit log through JSONL", () => {
    const store = new WorkerLevelStore();
    climbToL4(store, W);
    const restored = WorkerLevelStore.fromJSONL(store.toJSONL());
    expect(restored.board(W)).toEqual(store.board(W));
    expect(restored.events(W).length).toBe(store.events(W).length);
    expect(restored.getState(W, "fs-write:reversible:medium")?.level).toBe(4);
  });
});

describe("magnitude bands block value-grinding", () => {
  const PAY = "paystack.charge_authorization";

  function grind(store: WorkerLevelStore, worker: string, amount: number) {
    for (let i = 0; i < 60; i++) {
      store.apply(
        worker,
        { toolName: PAY, params: { amount }, good: true, at: 0 },
        { cfg: CFG },
      );
    }
    for (const at of [1000, 2000, 3000, 4000]) {
      store.apply(
        worker,
        { toolName: PAY, params: { amount }, good: true, at },
        { cfg: CFG },
      );
    }
  }

  it("trust ground out on cheap charges does not carry to an expensive one", () => {
    const store = new WorkerLevelStore();
    grind(store, W, 500); // 64 successful £5 charges

    const cheap = store.getState(W, "payments:irreversible:high:band<=50");
    expect(cheap?.level).toBe(4);

    // The £5,000 charge lands in a different cell, which has no evidence at all.
    const dear = store.getState(W, "payments:irreversible:high:band>500");
    expect(dear).toBeUndefined();
  });

  it("keeps each band as its own dial row", () => {
    const store = new WorkerLevelStore();
    grind(store, W, 500);
    grind(store, W, 500_000);
    const keys = store
      .board(W)
      .map((r) => r.classKey)
      .sort();
    expect(keys).toEqual([
      "payments:irreversible:high:band<=50",
      "payments:irreversible:high:band>500",
    ]);
  });
});
