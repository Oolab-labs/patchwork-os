import { afterEach, describe, expect, it } from "vitest";
import {
  activeRunCount,
  cancelRun,
  isRunActive,
  registerRun,
  unregisterRun,
} from "../runRegistry.js";

afterEach(() => {
  // Defensive: drop any seqs a test left behind so the module-global map
  // doesn't leak across tests.
  for (const seq of [1, 2, 3, 4]) unregisterRun(seq);
});

describe("runRegistry", () => {
  it("registers a run and reports it active", () => {
    const c = registerRun(1);
    expect(isRunActive(1)).toBe(true);
    expect(c.signal.aborted).toBe(false);
    expect(activeRunCount()).toBeGreaterThanOrEqual(1);
  });

  it("cancelRun aborts the controller and surfaces the reason", () => {
    const c = registerRun(2);
    expect(cancelRun(2, "user requested")).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toBe("user requested");
  });

  it("cancelRun returns false for an unknown seq", () => {
    expect(cancelRun(9999)).toBe(false);
  });

  it("unregisterRun removes the run", () => {
    registerRun(3);
    unregisterRun(3);
    expect(isRunActive(3)).toBe(false);
    expect(cancelRun(3)).toBe(false);
  });

  it("re-registering a seq aborts the stale controller", () => {
    const c1 = registerRun(4);
    const c2 = registerRun(4);
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(false);
  });
});
