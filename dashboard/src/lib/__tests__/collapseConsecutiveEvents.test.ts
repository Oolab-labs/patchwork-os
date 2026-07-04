import { describe, expect, it } from "vitest";
import { collapseConsecutiveEvents } from "@/lib/collapseConsecutiveEvents";

describe("collapseConsecutiveEvents", () => {
  it("merges adjacent duplicate tool events into one row with a count", () => {
    const events = [
      { kind: "tool", tool: "github_search", status: "error" },
      { kind: "tool", tool: "github_search", status: "error" },
      { kind: "tool", tool: "github_search", status: "error" },
    ];
    const result = collapseConsecutiveEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(3);
    expect(result[0].event).toBe(events[0]);
  });

  it("does not merge non-adjacent duplicates", () => {
    const events = [
      { kind: "tool", tool: "github_search", status: "error" },
      { kind: "tool", tool: "slack_post", status: "success" },
      { kind: "tool", tool: "github_search", status: "error" },
    ];
    const result = collapseConsecutiveEvents(events);
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.count === 1)).toBe(true);
  });

  it("treats a different status as a different run even for the same event", () => {
    const events = [
      { kind: "lifecycle", event: "recipe_step_done", status: "ok" },
      { kind: "lifecycle", event: "recipe_step_done", status: "error" },
    ];
    const result = collapseConsecutiveEvents(events);
    expect(result).toHaveLength(2);
  });

  it("groups lifecycle events by the event field, not the tool field", () => {
    const events = [
      { kind: "lifecycle", event: "grace_started" },
      { kind: "lifecycle", event: "grace_started" },
    ];
    const result = collapseConsecutiveEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
  });

  it("returns an empty array for an empty input", () => {
    expect(collapseConsecutiveEvents([])).toEqual([]);
  });

  it("does not mutate the input events", () => {
    const events = [
      { kind: "tool", tool: "x", status: "success" },
      { kind: "tool", tool: "x", status: "success" },
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    collapseConsecutiveEvents(events);
    expect(events).toEqual(snapshot);
  });
});
