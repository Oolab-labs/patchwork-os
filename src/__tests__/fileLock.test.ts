import { describe, expect, it } from "vitest";
import { FileLock, type LockContention } from "../fileLock.js";

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

  it("HIGH: waiter starting after a timed-out B must chain behind B's slot, not bypass A", async () => {
    // Bug: B times out → calls release() immediately → locks[path] deleted →
    // C (arriving after B's timeout) sees no lock and chains from Promise.resolve()
    // → C acquires immediately while A is still holding.
    //
    // Fix: B's timedOut path keeps locks[path] = nextB in the map (via bridge),
    // so C chains from nextB and only acquires after A releases.
    const lock = new FileLock(50); // 50ms timeout

    // A holds the lock
    const releaseA = await lock.acquire("/tmp/mutex.ts");

    // B times out — wait for it to fully settle
    await lock.acquire("/tmp/mutex.ts").then(
      () => {},
      () => {},
    );

    // C starts AFTER B has timed out (critical: after, not concurrent)
    // BUG:  locks[path] was deleted → C chains from Promise.resolve() → immediate
    // FIX:  locks[path] still has nextB → C chains from nextB → waits for A
    let cAcquiredEarly = false;
    const cPromise = lock.acquire("/tmp/mutex.ts").then(
      (rel) => {
        cAcquiredEarly = true;
        rel();
      },
      () => {},
    );

    // Flush microtasks — with the bug, C fires synchronously
    await Promise.resolve();
    await Promise.resolve();
    expect(cAcquiredEarly).toBe(false);

    // Release A — C should now get the lock via the bridge
    releaseA();
    await cPromise;
    expect(cAcquiredEarly).toBe(true); // got it AFTER A released, not before
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

describe("FileLock.tryAcquire", () => {
  it("grants lock when path is free", () => {
    const lock = new FileLock();
    const result = lock.tryAcquire("/tmp/x.ts", "session-A");
    expect("release" in result).toBe(true);
    (result as { release: () => void }).release();
  });

  it("returns LOCKED_BY_SESSION when held by a different session via tryAcquire", () => {
    const lock = new FileLock();
    const r1 = lock.tryAcquire("/tmp/x.ts", "session-A") as {
      release: () => void;
    };
    const r2 = lock.tryAcquire("/tmp/x.ts", "session-B");
    expect("lockedBySession" in r2).toBe(true);
    expect((r2 as LockContention).lockedBySession).toBe("session-A");
    r1.release();
  });

  it("returns LOCKED_BY_SESSION when held by acquire() (no session)", async () => {
    const lock = new FileLock();
    const release = await lock.acquire("/tmp/x.ts");
    // acquire() doesn't set holders — tryAcquire must detect via locks map
    const result = lock.tryAcquire("/tmp/x.ts", "session-B");
    expect("lockedBySession" in result).toBe(true);
    expect((result as LockContention).lockedBySession).toBe("unknown-session");
    release();
  });

  it("allows re-entry by the same session", () => {
    const lock = new FileLock();
    const r1 = lock.tryAcquire("/tmp/x.ts", "session-A") as {
      release: () => void;
    };
    const r2 = lock.tryAcquire("/tmp/x.ts", "session-A");
    expect("release" in r2).toBe(true);
    r1.release();
    (r2 as { release: () => void }).release();
  });

  it("MEDIUM: re-entry release must not delete the lock map entry, allowing a new waiter to bypass the holder", async () => {
    // Bug: re-entry creates a new promise and overwrites locks[path]. When the
    // re-entry releases, it deletes locks[path]. A subsequent acquire() caller
    // then sees locks[path] = undefined, chains from Promise.resolve(), and
    // gets the lock immediately — while r1 is still active.
    const lock = new FileLock(500);

    // Session-A holds the lock
    const r1 = lock.tryAcquire("/tmp/reentry.ts", "session-A") as {
      release: () => void;
    };

    // Session-A re-enters then immediately releases
    const r2 = lock.tryAcquire("/tmp/reentry.ts", "session-A") as {
      release: () => void;
    };
    r2.release();

    // NEW waiter arrives AFTER re-entry was released
    // Bug: locks[path] was deleted, so this waiter chains from Promise.resolve()
    // and gets the lock immediately while r1 still holds it.
    let r1ReleasedBeforeWaiter = false;
    let waiterFired = false;
    const waiterP = lock.acquire("/tmp/reentry.ts").then((rel) => {
      // If r1 released before this callback, the flag would be set
      waiterFired = true;
      rel();
    });

    // Flush microtasks — with the bug, the new waiter fires immediately
    await Promise.resolve();
    await Promise.resolve();

    // The new waiter must NOT have acquired while r1 is still held
    expect(waiterFired).toBe(false);

    r1ReleasedBeforeWaiter = true;
    r1.release();
    await waiterP;
    // waiterFired should be true now (it acquired after r1 released)
    expect(waiterFired).toBe(true);
    expect(r1ReleasedBeforeWaiter).toBe(true); // sanity: r1 was released first
  });

  it("grants lock after previous holder releases", () => {
    const lock = new FileLock();
    const r1 = lock.tryAcquire("/tmp/x.ts", "session-A") as {
      release: () => void;
    };
    r1.release();
    const r2 = lock.tryAcquire("/tmp/x.ts", "session-B");
    expect("release" in r2).toBe(true);
    (r2 as { release: () => void }).release();
  });

  it("does not interfere with a different path", () => {
    const lock = new FileLock();
    const r1 = lock.tryAcquire("/tmp/a.ts", "session-A") as {
      release: () => void;
    };
    const r2 = lock.tryAcquire("/tmp/b.ts", "session-B");
    expect("release" in r2).toBe(true);
    r1.release();
    (r2 as { release: () => void }).release();
  });

  it("LOW: acquire() release must not wipe a holders entry set by a subsequent tryAcquire", async () => {
    // Bug: acquire()'s wrappedRelease unconditionally called holders.delete(path).
    // If a tryAcquire had set holders[path] after acquire() acquired, the
    // acquire() release would delete that tryAcquire-set entry — making a
    // subsequent contention check report "unknown-session" instead of the real holder.
    const lock = new FileLock();

    // acquire() takes the lock (doesn't set holders)
    const releaseAcquire = await lock.acquire("/tmp/low.ts");

    // While acquire() holds, tryAcquire from session-B is blocked
    const tryResult = lock.tryAcquire("/tmp/low.ts", "session-B");
    expect("lockedBySession" in tryResult).toBe(true);
    // The holder is reported as "unknown-session" (acquire doesn't register)
    expect((tryResult as { lockedBySession: string }).lockedBySession).toBe(
      "unknown-session",
    );

    // Release via acquire — must NOT delete holders[path] for session-B if
    // session-B happened to acquire right after
    releaseAcquire();

    // Now session-B can take the lock via tryAcquire
    const r2 = lock.tryAcquire("/tmp/low.ts", "session-B") as {
      release: () => void;
    };
    expect("release" in r2).toBe(true);

    // A competing session-C must see session-B as the holder
    const r3 = lock.tryAcquire("/tmp/low.ts", "session-C");
    expect("lockedBySession" in r3).toBe(true);
    expect((r3 as { lockedBySession: string }).lockedBySession).toBe(
      "session-B",
    );

    r2.release();
  });
});
