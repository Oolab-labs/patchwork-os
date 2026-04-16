import { describe, expect, it } from "vitest";
import {
  clearActiveTask,
  clearPendingRetry,
  EMPTY_AUTOMATION_STATE,
  isDeduped,
  isOnCooldown,
  isTaskActive,
  mergeAutomationStates,
  recordDedup,
  recordPendingRetry,
  recordTrigger,
  setLastTestOutcome,
  setLatestDiagnostics,
  setPrevDiagnosticErrors,
  setTestRunnerStatus,
  tasksInLastHour,
} from "../automationState.js";

const NOW = 1_700_000_000_000;

describe("isOnCooldown", () => {
  it("returns false when key has never been triggered", () => {
    expect(
      isOnCooldown(EMPTY_AUTOMATION_STATE, "file:/foo.ts", NOW, 5_000),
    ).toBe(false);
  });

  it("returns true when within cooldown window", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "task1", NOW);
    expect(isOnCooldown(state, "k", NOW + 4_000, 5_000)).toBe(true);
  });

  it("returns false when cooldown has expired", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "task1", NOW);
    expect(isOnCooldown(state, "k", NOW + 6_000, 5_000)).toBe(false);
  });

  it("treats exactly at cooldown boundary as expired", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "task1", NOW);
    // now - last = 5000 = cooldownMs → not < cooldownMs → false
    expect(isOnCooldown(state, "k", NOW + 5_000, 5_000)).toBe(false);
  });
});

describe("recordTrigger", () => {
  it("adds key to lastTrigger with now", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "t1", NOW);
    expect(state.lastTrigger.get("k")).toBe(NOW);
  });

  it("records taskId in activeTasks", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "abc123", NOW);
    expect(state.activeTasks.get("k")).toBe("abc123");
  });

  it("appends to taskTimestamps", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "t1", NOW);
    expect(state.taskTimestamps).toContain(NOW);
    expect(state.taskTimestamps.length).toBe(1);
  });

  it("does not mutate input state", () => {
    const original = EMPTY_AUTOMATION_STATE;
    recordTrigger(original, "k", "t1", NOW);
    expect(original.lastTrigger.size).toBe(0);
    expect(original.taskTimestamps.length).toBe(0);
  });

  it("caps taskTimestamps at 10 000 entries", () => {
    // build a state with 10 000 timestamps already
    let state = EMPTY_AUTOMATION_STATE;
    const startTs = 1_000_000;
    // Seed 10 000 entries directly
    const fakeTimestamps = Array.from(
      { length: 10_000 },
      (_, i) => startTs + i,
    );
    state = {
      ...state,
      taskTimestamps: fakeTimestamps,
    };
    const newState = recordTrigger(state, "k", "t", NOW);
    expect(newState.taskTimestamps.length).toBe(10_000);
    // newest entry should be NOW
    expect(newState.taskTimestamps[9_999]).toBe(NOW);
  });
});

describe("isTaskActive", () => {
  it("returns false for unknown key", () => {
    expect(isTaskActive(EMPTY_AUTOMATION_STATE, "k")).toBe(false);
  });

  it("returns true after recordTrigger", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "t1", NOW);
    expect(isTaskActive(state, "k")).toBe(true);
  });

  it("returns false after clearActiveTask", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "t1", NOW);
    const cleared = clearActiveTask(state, "k");
    expect(isTaskActive(cleared, "k")).toBe(false);
  });
});

describe("clearActiveTask", () => {
  it("does not mutate input", () => {
    const state = recordTrigger(EMPTY_AUTOMATION_STATE, "k", "t1", NOW);
    clearActiveTask(state, "k");
    expect(isTaskActive(state, "k")).toBe(true); // original unchanged
  });
});

describe("setPrevDiagnosticErrors", () => {
  it("stores count for file", () => {
    const state = setPrevDiagnosticErrors(EMPTY_AUTOMATION_STATE, "/foo.ts", 3);
    expect(state.prevDiagnosticErrors.get("/foo.ts")).toBe(3);
  });

  it("does not mutate input", () => {
    setPrevDiagnosticErrors(EMPTY_AUTOMATION_STATE, "/foo.ts", 5);
    expect(EMPTY_AUTOMATION_STATE.prevDiagnosticErrors.size).toBe(0);
  });
});

describe("setLastTestOutcome", () => {
  it("stores outcome for runner", () => {
    const state = setLastTestOutcome(EMPTY_AUTOMATION_STATE, "vitest", "pass");
    expect(state.lastTestOutcomeByRunner.get("vitest")).toBe("pass");
  });

  it("does not mutate input", () => {
    setLastTestOutcome(EMPTY_AUTOMATION_STATE, "vitest", "fail");
    expect(EMPTY_AUTOMATION_STATE.lastTestOutcomeByRunner.size).toBe(0);
  });
});

describe("tasksInLastHour", () => {
  it("returns 0 for empty state", () => {
    expect(tasksInLastHour(EMPTY_AUTOMATION_STATE, NOW)).toBe(0);
  });

  it("counts tasks within the last hour", () => {
    let state = EMPTY_AUTOMATION_STATE;
    state = recordTrigger(state, "a", "t1", NOW - 1_000);
    state = recordTrigger(state, "b", "t2", NOW - 7_200_000); // 2hr ago — outside window
    expect(tasksInLastHour(state, NOW)).toBe(1);
  });

  it("counts all tasks within hour when multiple triggered", () => {
    let state = EMPTY_AUTOMATION_STATE;
    for (let i = 0; i < 5; i++) {
      state = recordTrigger(state, `k${i}`, `t${i}`, NOW - i * 60_000);
    }
    expect(tasksInLastHour(state, NOW)).toBe(5);
  });
});

describe("recordDedup + isDeduped", () => {
  it("isDeduped returns false for unknown key", () => {
    expect(isDeduped(EMPTY_AUTOMATION_STATE, "k", NOW, 5_000)).toBe(false);
  });

  it("isDeduped returns true within cooldown after recordDedup", () => {
    const state = recordDedup(EMPTY_AUTOMATION_STATE, "k", NOW);
    expect(isDeduped(state, "k", NOW + 4_000, 5_000)).toBe(true);
  });

  it("isDeduped returns false after cooldown expires", () => {
    const state = recordDedup(EMPTY_AUTOMATION_STATE, "k", NOW);
    expect(isDeduped(state, "k", NOW + 6_000, 5_000)).toBe(false);
  });

  it("does not mutate input", () => {
    recordDedup(EMPTY_AUTOMATION_STATE, "k", NOW);
    expect(EMPTY_AUTOMATION_STATE.deduplicationWindow.size).toBe(0);
  });

  it("caps at 5000 entries (FIFO eviction)", () => {
    let state = EMPTY_AUTOMATION_STATE;
    for (let i = 0; i < 5_000; i++) {
      state = recordDedup(state, `key-${i}`, NOW + i);
    }
    expect(state.deduplicationWindow.size).toBe(5_000);
    // Adding one more should evict oldest
    const newState = recordDedup(state, "key-5000", NOW + 5_000);
    expect(newState.deduplicationWindow.size).toBe(5_000);
    expect(newState.deduplicationWindow.has("key-0")).toBe(false);
    expect(newState.deduplicationWindow.has("key-5000")).toBe(true);
  });
});

describe("recordPendingRetry + clearPendingRetry", () => {
  it("stores retry record", () => {
    const state = recordPendingRetry(
      EMPTY_AUTOMATION_STATE,
      "k",
      1,
      NOW + 30_000,
      "task-1",
    );
    const entry = state.pendingRetries.get("k");
    expect(entry).toEqual({
      attempt: 1,
      nextRetryAt: NOW + 30_000,
      taskId: "task-1",
    });
  });

  it("clearPendingRetry removes the key", () => {
    const state = recordPendingRetry(EMPTY_AUTOMATION_STATE, "k", 1, NOW, "t");
    const cleared = clearPendingRetry(state, "k");
    expect(cleared.pendingRetries.has("k")).toBe(false);
  });

  it("does not mutate input", () => {
    recordPendingRetry(EMPTY_AUTOMATION_STATE, "k", 1, NOW, "t");
    expect(EMPTY_AUTOMATION_STATE.pendingRetries.size).toBe(0);
  });
});

describe("setLatestDiagnostics", () => {
  it("stores severity+count for file", () => {
    const state = setLatestDiagnostics(EMPTY_AUTOMATION_STATE, "/foo.ts", 0, 3);
    expect(state.latestDiagnosticsByFile.get("/foo.ts")).toEqual({
      severity: 0,
      count: 3,
    });
  });

  it("overwrites existing entry", () => {
    const s1 = setLatestDiagnostics(EMPTY_AUTOMATION_STATE, "/foo.ts", 0, 3);
    const s2 = setLatestDiagnostics(s1, "/foo.ts", 1, 7);
    expect(s2.latestDiagnosticsByFile.get("/foo.ts")).toEqual({
      severity: 1,
      count: 7,
    });
  });

  it("does not mutate input", () => {
    setLatestDiagnostics(EMPTY_AUTOMATION_STATE, "/foo.ts", 0, 1);
    expect(EMPTY_AUTOMATION_STATE.latestDiagnosticsByFile.size).toBe(0);
  });

  it("caps at 5000 entries", () => {
    let state = EMPTY_AUTOMATION_STATE;
    for (let i = 0; i < 5_000; i++) {
      state = setLatestDiagnostics(state, `/file-${i}.ts`, 0, 1);
    }
    expect(state.latestDiagnosticsByFile.size).toBe(5_000);
    const next = setLatestDiagnostics(state, "/file-5000.ts", 0, 1);
    expect(next.latestDiagnosticsByFile.size).toBe(5_000);
    expect(next.latestDiagnosticsByFile.has("/file-0.ts")).toBe(false);
  });
});

describe("setTestRunnerStatus", () => {
  it("stores runner status", () => {
    const state = setTestRunnerStatus(EMPTY_AUTOMATION_STATE, "vitest", "pass");
    expect(state.lastTestRunnerStatusByRunner.get("vitest")).toBe("pass");
  });

  it("overwrites existing entry", () => {
    const s1 = setTestRunnerStatus(EMPTY_AUTOMATION_STATE, "vitest", "pass");
    const s2 = setTestRunnerStatus(s1, "vitest", "fail");
    expect(s2.lastTestRunnerStatusByRunner.get("vitest")).toBe("fail");
  });

  it("does not mutate input", () => {
    setTestRunnerStatus(EMPTY_AUTOMATION_STATE, "vitest", "pass");
    expect(EMPTY_AUTOMATION_STATE.lastTestRunnerStatusByRunner.size).toBe(0);
  });
});

describe("mergeAutomationStates", () => {
  it("keeps max timestamp per key in lastTrigger", () => {
    const a = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "t1", NOW - 1000);
    const b = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "t2", NOW);
    expect(mergeAutomationStates(a, b).lastTrigger.get("K")).toBe(NOW);
    expect(mergeAutomationStates(b, a).lastTrigger.get("K")).toBe(NOW);
  });

  it("unions disjoint keys from both states", () => {
    const a = recordTrigger(EMPTY_AUTOMATION_STATE, "A", "t", NOW);
    const b = recordTrigger(EMPTY_AUTOMATION_STATE, "B", "t", NOW);
    const merged = mergeAutomationStates(a, b);
    expect(merged.lastTrigger.get("A")).toBe(NOW);
    expect(merged.lastTrigger.get("B")).toBe(NOW);
  });

  it("concatenates taskTimestamps", () => {
    const a = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "t", 1);
    const b = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "t", 2);
    expect(mergeAutomationStates(a, b).taskTimestamps).toEqual([1, 2]);
  });

  it("keeps max dedup timestamp per key", () => {
    const a = recordDedup(EMPTY_AUTOMATION_STATE, "d", 100);
    const b = recordDedup(EMPTY_AUTOMATION_STATE, "d", 500);
    expect(mergeAutomationStates(a, b).deduplicationWindow.get("d")).toBe(500);
  });

  // ── Parallel-merge regression edges (stabilize sprint, v2.42.x) ─────────────
  // Seeds after v2.40.1 parallel-merge fix. If any of these fail, a hook in
  // one Parallel branch is losing state from a sibling branch.

  it("3-way parallel: interleaved dedup triggers all survive", () => {
    // Simulates three branches each recording a distinct dedup key.
    const a = recordDedup(EMPTY_AUTOMATION_STATE, "x", NOW - 200);
    const b = recordDedup(EMPTY_AUTOMATION_STATE, "y", NOW - 100);
    const c = recordDedup(EMPTY_AUTOMATION_STATE, "z", NOW);
    const merged = mergeAutomationStates(mergeAutomationStates(a, b), c);
    expect(merged.deduplicationWindow.get("x")).toBe(NOW - 200);
    expect(merged.deduplicationWindow.get("y")).toBe(NOW - 100);
    expect(merged.deduplicationWindow.get("z")).toBe(NOW);
    expect(merged.deduplicationWindow.size).toBe(3);
  });

  it("WithRetry × Parallel nesting: pendingRetries merged from both branches", () => {
    // Branch A schedules a retry for key "hookA", Branch B schedules for "hookB".
    // The outer Parallel must preserve both pending records.
    const a = recordPendingRetry(
      EMPTY_AUTOMATION_STATE,
      "hookA",
      1,
      NOW + 1000,
      "task-A",
    );
    const b = recordPendingRetry(
      EMPTY_AUTOMATION_STATE,
      "hookB",
      2,
      NOW + 2000,
      "task-B",
    );
    const merged = mergeAutomationStates(a, b);
    expect(merged.pendingRetries.get("hookA")).toEqual({
      attempt: 1,
      nextRetryAt: NOW + 1000,
      taskId: "task-A",
    });
    expect(merged.pendingRetries.get("hookB")).toEqual({
      attempt: 2,
      nextRetryAt: NOW + 2000,
      taskId: "task-B",
    });
  });

  it("schedule/exec drift: older state merged with newer keeps newer max", () => {
    // Branch A snapshot captured at schedule-time (NOW - 60s).
    // Branch B ran later and recorded a trigger at NOW.
    // Merging must not revive the older timestamp.
    const older = recordTrigger(
      EMPTY_AUTOMATION_STATE,
      "K",
      "t1",
      NOW - 60_000,
    );
    const newer = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "t2", NOW);
    const merged = mergeAutomationStates(older, newer);
    // Max per key → newer wins.
    expect(merged.lastTrigger.get("K")).toBe(NOW);
    // Still on cooldown against the newer timestamp.
    expect(isOnCooldown(merged, "K", NOW + 100, 5_000)).toBe(true);
  });

  it("millisecond timestamp collision: merge is deterministic, not racy", () => {
    // Both branches trigger at exactly the same ms with different task IDs.
    // activeTasks uses unionMap (b wins), but lastTrigger uses max (either, equal).
    const a = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "task-A", NOW);
    const b = recordTrigger(EMPTY_AUTOMATION_STATE, "K", "task-B", NOW);
    const ab = mergeAutomationStates(a, b);
    const ba = mergeAutomationStates(b, a);
    // lastTrigger timestamp must agree regardless of argument order.
    expect(ab.lastTrigger.get("K")).toBe(NOW);
    expect(ba.lastTrigger.get("K")).toBe(NOW);
    // activeTasks: argument-order-dependent (right wins) — document the behavior.
    expect(ab.activeTasks.get("K")).toBe("task-B");
    expect(ba.activeTasks.get("K")).toBe("task-A");
  });

  it("post-GC dedup window: empty a-side merges cleanly with populated b-side", () => {
    // Branch A's dedup window was GC'd (capped + evicted), leaving empty.
    // Branch B still has records. Merge must not resurrect evicted keys.
    const emptyA = EMPTY_AUTOMATION_STATE;
    const populatedB = recordDedup(
      recordDedup(EMPTY_AUTOMATION_STATE, "k1", NOW - 100),
      "k2",
      NOW,
    );
    const merged = mergeAutomationStates(emptyA, populatedB);
    expect(merged.deduplicationWindow.size).toBe(2);
    expect(merged.deduplicationWindow.get("k1")).toBe(NOW - 100);
    expect(merged.deduplicationWindow.get("k2")).toBe(NOW);
    // Reverse order: same result (symmetry for disjoint keys).
    const mergedReverse = mergeAutomationStates(populatedB, emptyA);
    expect(mergedReverse.deduplicationWindow.size).toBe(2);
  });
});
