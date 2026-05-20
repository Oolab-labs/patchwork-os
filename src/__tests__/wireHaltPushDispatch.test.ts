/**
 * Tests for the bridge-side halt-push wiring. The actual dispatcher
 * (dispatchHaltPushNotification — SSRF / fetch / abort) is exercised
 * indirectly via vi.mock so we can assert *when* and *with what* the
 * dispatch is invoked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../haltPushDispatch.js", () => ({
  dispatchHaltPushNotification: vi.fn(async () => undefined),
}));

import { ActivityLog } from "../activityLog.js";
import { dispatchHaltPushNotification } from "../haltPushDispatch.js";
import { wireHaltPushDispatch } from "../wireHaltPushDispatch.js";

const CFG = { url: "https://relay.example.com/relay", token: "tok-1234567890" };

let activityLog: ActivityLog;

beforeEach(() => {
  activityLog = new ActivityLog();
  vi.mocked(dispatchHaltPushNotification).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wireHaltPushDispatch", () => {
  it("dispatches on recipe_done with status=error", () => {
    wireHaltPushDispatch({
      activityLog,
      getPushConfig: () => CFG,
    });

    activityLog.recordEvent("recipe_done", {
      runSeq: 42,
      recipeName: "morning-brief",
      status: "error",
      errorMessage: "Agent silent-fail in step summarize",
    });

    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(1);
    expect(dispatchHaltPushNotification).toHaveBeenCalledWith(
      CFG.url,
      CFG.token,
      expect.objectContaining({
        recipeName: "morning-brief",
        runSeq: 42,
        status: "error",
        errorMessage: "Agent silent-fail in step summarize",
      }),
    );
  });

  it("skips recipe_done with status=done (successful runs)", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => CFG });
    activityLog.recordEvent("recipe_done", {
      runSeq: 1,
      recipeName: "x",
      status: "done",
    });
    expect(dispatchHaltPushNotification).not.toHaveBeenCalled();
  });

  it("skips non-recipe_done lifecycle events", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => CFG });
    activityLog.recordEvent("recipe_started", { runSeq: 1, recipeName: "x" });
    activityLog.recordEvent("recipe_step_done", {
      runSeq: 1,
      stepId: "s1",
      status: "error",
      error: "step blew up",
    });
    expect(dispatchHaltPushNotification).not.toHaveBeenCalled();
  });

  it("no-ops when push relay config is not set", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => null });
    activityLog.recordEvent("recipe_done", {
      runSeq: 1,
      recipeName: "x",
      status: "error",
    });
    expect(dispatchHaltPushNotification).not.toHaveBeenCalled();
  });

  it("reads config per-event so /settings changes take effect immediately", () => {
    let cfg: typeof CFG | null = null;
    wireHaltPushDispatch({ activityLog, getPushConfig: () => cfg });

    // First fire: no config → no dispatch.
    activityLog.recordEvent("recipe_done", {
      runSeq: 1,
      recipeName: "x",
      status: "error",
    });
    expect(dispatchHaltPushNotification).not.toHaveBeenCalled();

    // Config arrives, second fire dispatches.
    cfg = CFG;
    activityLog.recordEvent("recipe_done", {
      runSeq: 2,
      recipeName: "x",
      status: "error",
    });
    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(1);
  });

  it("returns an unsubscribe that detaches the listener", () => {
    const unsubscribe = wireHaltPushDispatch({
      activityLog,
      getPushConfig: () => CFG,
    });

    unsubscribe();

    activityLog.recordEvent("recipe_done", {
      runSeq: 1,
      recipeName: "x",
      status: "error",
    });
    expect(dispatchHaltPushNotification).not.toHaveBeenCalled();
  });

  it("defaults missing recipeName / runSeq to safe values without throwing", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => CFG });
    activityLog.recordEvent("recipe_done", { status: "error" });
    expect(dispatchHaltPushNotification).toHaveBeenCalledWith(
      CFG.url,
      CFG.token,
      expect.objectContaining({
        recipeName: "recipe",
        runSeq: 0,
        status: "error",
      }),
    );
  });
});

describe("wireHaltPushDispatch — dedup", () => {
  it("collapses repeat recipe_done for the same runSeq inside the window", () => {
    let clock = 1_000;
    wireHaltPushDispatch({
      activityLog,
      getPushConfig: () => CFG,
      dedupWindowMs: 60_000,
      now: () => clock,
    });

    activityLog.recordEvent("recipe_done", {
      runSeq: 7,
      recipeName: "x",
      status: "error",
    });
    clock += 30_000; // still inside the 60s window
    activityLog.recordEvent("recipe_done", {
      runSeq: 7,
      recipeName: "x",
      status: "error",
    });

    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(1);
  });

  it("dispatches again once the dedup window has elapsed", () => {
    let clock = 1_000;
    wireHaltPushDispatch({
      activityLog,
      getPushConfig: () => CFG,
      dedupWindowMs: 60_000,
      now: () => clock,
    });

    activityLog.recordEvent("recipe_done", {
      runSeq: 7,
      recipeName: "x",
      status: "error",
    });
    clock += 61_000; // past the window
    activityLog.recordEvent("recipe_done", {
      runSeq: 7,
      recipeName: "x",
      status: "error",
    });

    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(2);
  });

  it("does not dedup distinct runSeqs", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => CFG });
    activityLog.recordEvent("recipe_done", {
      runSeq: 1,
      recipeName: "x",
      status: "error",
    });
    activityLog.recordEvent("recipe_done", {
      runSeq: 2,
      recipeName: "y",
      status: "error",
    });
    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(2);
  });

  it("never dedups the runSeq=0 unknown sentinel", () => {
    wireHaltPushDispatch({ activityLog, getPushConfig: () => CFG });
    // Two distinct unknown-seq runs must both fire — collapsing them
    // would silently drop a real halt.
    activityLog.recordEvent("recipe_done", { status: "error" });
    activityLog.recordEvent("recipe_done", { status: "error" });
    expect(dispatchHaltPushNotification).toHaveBeenCalledTimes(2);
  });
});
