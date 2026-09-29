import { describe, expect, it } from "vitest";
import { replayFailureMessage } from "@/lib/replayMessage";

describe("replayFailureMessage", () => {
  it("refused before a run started: says nothing was run", () => {
    const m = replayFailureMessage(409, { unmockedSteps: ["post"] });
    expect(m).toContain("Nothing was run");
    expect(m).toContain("post");
  });

  it("stopped mid-run (newSeq present): never claims nothing was run", () => {
    const m = replayFailureMessage(409, {
      newSeq: 42,
      unmockedSteps: ["note", "after"],
    });
    expect(m).not.toContain("Nothing was run");
    expect(m).toContain("#42");
    expect(m).toContain("note, after");
    expect(m).toMatch(/earlier steps replayed from captured output/i);
    expect(m).toMatch(/nothing was sent out/i);
  });

  it("falls back to the error, then the status", () => {
    expect(replayFailureMessage(500, { error: "boom" })).toBe("boom");
    expect(replayFailureMessage(500, {})).toBe("HTTP 500");
  });
});
