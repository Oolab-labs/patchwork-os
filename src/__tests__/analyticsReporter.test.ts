/**
 * Long-running bridges (launchd, containers) almost never shut down, and
 * telemetry was sent ONLY at shutdown, so they never reported. The reporter
 * sends on an interval AND at shutdown, and each activity entry is counted
 * exactly once across those sends.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry } from "../activityTypes.js";
import { AnalyticsReporter } from "../analyticsReporter.js";

let id = 0;
function entry(atMs: number, tool = "getDiagnostics"): ActivityEntry {
  return {
    id: ++id,
    timestamp: new Date(atMs).toISOString(),
    tool,
    durationMs: 5,
    status: "success",
  };
}

function setup(enabled = true) {
  let now = Date.parse("2026-10-10T00:00:00Z");
  const log: ActivityEntry[] = [];
  const send = vi.fn(async (_summary: unknown) => {});
  const r = new AnalyticsReporter({
    entries: () => log,
    enabled: () => enabled,
    bridgeVersion: "1.2.0-beta.3",
    salt: () => "s",
    send,
    now: () => now,
  });
  return {
    r,
    log,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

const sentCalls = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map(
    (c) =>
      (c[0] as { toolStats: { calls: number }[] }).toolStats[0]?.calls ?? 0,
  );

describe("AnalyticsReporter", () => {
  it("counts each entry exactly once across interval and shutdown sends", async () => {
    const t = setup();
    t.advance(1000);
    t.log.push(entry(t.at()), entry(t.at()));
    await t.r.flush();
    t.advance(1000);
    t.log.push(entry(t.at()));
    await t.r.flush(); // shutdown
    expect(sentCalls(t.send)).toEqual([2, 1]);
  });

  it("sends nothing for an empty window", async () => {
    const t = setup();
    await t.r.flush();
    t.advance(1000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    await t.r.flush();
    expect(t.send).toHaveBeenCalledOnce();
  });

  it("ignores activity from before the reporter started", async () => {
    const t = setup();
    t.log.push(entry(t.at() - 60_000));
    await t.r.flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it("reports the window length, not the process uptime", async () => {
    const t = setup();
    t.advance(5000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    t.advance(2000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    const durations = t.send.mock.calls.map(
      (c) => (c[0] as { sessionDurationMs: number }).sessionDurationMs,
    );
    expect(durations).toEqual([5000, 2000]);
  });

  it("does nothing while telemetry is not opted in, and does not count it later", async () => {
    let on = false;
    const t = setup();
    // swap the enabled predicate
    (t.r as unknown as { deps: { enabled: () => boolean } }).deps.enabled =
      () => on;
    t.advance(1000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    expect(t.send).not.toHaveBeenCalled();
    on = true;
    t.advance(1000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    expect(sentCalls(t.send)).toEqual([1]);
  });

  it("a failed send does not resend the same entries", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error("down"));
    t.advance(1000);
    t.log.push(entry(t.at()));
    await t.r.flush();
    await t.r.flush();
    expect(t.send).toHaveBeenCalledOnce();
  });

  it("start() schedules flushes and stop() cancels them", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.r.start(1000);
      t.advance(10);
      t.log.push(entry(t.at()));
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.send).toHaveBeenCalledOnce();
      t.r.stop();
      t.advance(10);
      t.log.push(entry(t.at()));
      await vi.advanceTimersByTimeAsync(5000);
      expect(t.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
