import { describe, expect, it } from "vitest";
import {
  clearActiveTask,
  EMPTY_AUTOMATION_STATE,
  isOnCooldown,
  isTaskActive,
  recordTrigger,
  setLastTestOutcome,
  setPrevDiagnosticErrors,
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
