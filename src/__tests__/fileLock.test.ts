import { describe, expect, it } from "vitest";
import { FileLock } from "../fileLock.js";

describe("FileLock", () => {
  it("resolves immediately when no contention", async () => {
    const lock = new FileLock();
    const release = await lock.acquire("/tmp/a.ts");
    expect(typeof release).toBe("function");
    release();
  });

  it("serializes concurrent acquires on the same path", async () => {
    const lock = new FileLock();
    const order: number[] = [];

    const release1 = await lock.acquire("/tmp/a.ts");
    order.push(1);

    // Start waiter 2 — should be blocked behind release1
    const p2 = lock.acquire("/tmp/a.ts").then((release) => {
      order.push(2);
      return release;
    });

    // Start waiter 3 — should be blocked behind waiter 2
    const p3 = lock.acquire("/tmp/a.ts").then((release) => {
      order.push(3);
      return release;
    });

    // Neither 2 nor 3 should have run yet
    expect(order).toEqual([1]);

    release1();
    const release2 = await p2;
    expect(order).toEqual([1, 2]);

    release2();
    const release3 = await p3;
    expect(order).toEqual([1, 2, 3]);

    release3();
  });

  it("does not block concurrent acquires on different paths", async () => {
    const lock = new FileLock();
    const order: number[] = [];

    const release1 = await lock.acquire("/tmp/a.ts");
    order.push(1);
    const release2 = await lock.acquire("/tmp/b.ts");
    order.push(2);

    expect(order).toEqual([1, 2]);
    release1();
    release2();
  });

  it("cleans up map entry after release", async () => {
    const lock = new FileLock();
    const release = await lock.acquire("/tmp/a.ts");
    // Access private field for verification
    expect((lock as unknown as { locks: Map<string, unknown> }).locks.size).toBe(1);
    release();
    // After release with no waiters the entry is removed
    expect((lock as unknown as { locks: Map<string, unknown> }).locks.size).toBe(0);
  });

  it("handles rapid serial acquires without memory leak", async () => {
    const lock = new FileLock();
    for (let i = 0; i < 100; i++) {
      const release = await lock.acquire("/tmp/x.ts");
      release();
    }
    expect((lock as unknown as { locks: Map<string, unknown> }).locks.size).toBe(0);
  });

  it("second waiter gets lock after first releases", async () => {
    const lock = new FileLock();
    let secondAcquired = false;

    const release1 = await lock.acquire("/tmp/a.ts");
    const p2 = lock.acquire("/tmp/a.ts").then((r) => {
      secondAcquired = true;
      return r;
    });

    expect(secondAcquired).toBe(false);
    release1();
    const release2 = await p2;
    expect(secondAcquired).toBe(true);
    release2();
  });
});
