import { describe, expect, it } from "vitest";
import { eventLevel } from "@/lib/activityLevel";

describe("eventLevel", () => {
  it("maps a successful tool call to 'tool'", () => {
    expect(eventLevel({ kind: "tool", status: "success" })).toBe("tool");
  });

  it("maps a failed tool call to 'halt'", () => {
    expect(eventLevel({ kind: "tool", status: "error" })).toBe("halt");
  });

  it("maps a recipe_step_done with status:error to 'halt', not 'done' (regression)", () => {
    // Regression for the "tail that is all one color" bug: the event name
    // itself contains "done", so a name-only regex misclassifies this.
    expect(
      eventLevel({
        kind: "lifecycle",
        event: "recipe_step_done",
        metadata: { status: "error", haltReason: "tool timeout" },
      }),
    ).toBe("halt");
  });

  it("maps a recipe_step_done with status:ok to 'done'", () => {
    expect(
      eventLevel({
        kind: "lifecycle",
        event: "recipe_step_done",
        metadata: { status: "ok" },
      }),
    ).toBe("done");
  });

  it("maps recipe_done with status:done to 'done'", () => {
    expect(
      eventLevel({
        kind: "lifecycle",
        event: "recipe_done",
        metadata: { status: "done" },
      }),
    ).toBe("done");
  });

  it("maps recipe_done with status:error to 'halt'", () => {
    expect(
      eventLevel({
        kind: "lifecycle",
        event: "recipe_done",
        metadata: { status: "error" },
      }),
    ).toBe("halt");
  });

  it("maps a gate/approval lifecycle event with no status to 'note'", () => {
    expect(eventLevel({ kind: "lifecycle", event: "approval_rejected" })).toBe("note");
  });

  it("maps a plain connectivity lifecycle event to 'note'", () => {
    expect(eventLevel({ kind: "lifecycle", event: "grace_started" })).toBe("note");
  });

  it("maps crash_detected to 'halt' via event-name fallback", () => {
    expect(eventLevel({ kind: "lifecycle", event: "crash_detected" })).toBe("halt");
  });
});
