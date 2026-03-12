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
    expect(
      (lock as unknown as { locks: Map<string, unknown> }).locks.size,
    ).toBe(1);
    release();
    // After release with no waiters the entry is removed
    expect(
      (lock as unknown as { locks: Map<string, unknown> }).locks.size,
    ).toBe(0);
  });

  it("handles rapid serial acquires without memory leak", async () => {
    const lock = new FileLock();
    for (let i = 0; i < 100; i++) {
      const release = await lock.acquire("/tmp/x.ts");
      release();
    }
    expect(
      (lock as unknown as { locks: Map<string, unknown> }).locks.size,
    ).toBe(0);
  });

  it("throws after timeout if lock is never released", async () => {
    // Use a 50ms timeout so the test completes quickly without fake timers
    const lock = new FileLock(50);

    // Hold the lock indefinitely (never released)
    await lock.acquire("/tmp/stuck.ts");

    // Second acquire must time out
    await expect(lock.acquire("/tmp/stuck.ts")).rejects.toThrow(
      /Timed out waiting for file lock/,
    );
  });

  it("third waiter proceeds immediately after second waiter times out (cascade fix)", async () => {
    // Regression test: before the fix, a timed-out waiter (B) left its `next`
    // promise unsettled, forcing any subsequent waiter (C) to burn its entire
    // timeout window instead of proceeding once B threw.
    const lock = new FileLock(50); // 50ms timeout

    // A holds the lock forever
    await lock.acquire("/tmp/cascade.ts");

    // B queues behind A and will time out (A never releases)
    const bResult = lock.acquire("/tmp/cascade.ts").then(
      () => "acquired",
      () => "timed-out",
    );

    // C queues behind B
    // With the fix: B times out AND resolves its tail promise, so C sees B's
    // slot as free and acquires the lock shortly after B throws.
    // Without the fix: C would have to wait another full 50ms on its own timer.
    const cStart = Date.now();
    const cResult = lock.acquire("/tmp/cascade.ts").then(
      (release) => {
        release();
        return "acquired";
      },
      () => "timed-out",
    );

    expect(await bResult).toBe("timed-out");
    expect(await cResult).toBe("acquired");

    // C should have resolved very quickly after B's timeout fired — well within
    // a second 50ms window (give generous 200ms for CI scheduling jitter).
    expect(Date.now() - cStart).toBeLessThan(200);
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
