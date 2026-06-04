import { describe, expect, it } from "vitest";
import { recipeDisplayName } from "../recipeDisplay";

describe("recipeDisplayName", () => {
  it("turns dashes and underscores into spaced, capitalised words", () => {
    expect(recipeDisplayName("morning-brief")).toBe("Morning Brief");
    expect(recipeDisplayName("inbox_triage")).toBe("Inbox Triage");
    expect(recipeDisplayName("apple-watch_health-log")).toBe("Apple Watch Health Log");
  });

  it("capitalises a single bare word", () => {
    expect(recipeDisplayName("standup")).toBe("Standup");
  });

  it("leaves already-spaced names capitalised", () => {
    expect(recipeDisplayName("daily report")).toBe("Daily Report");
  });

  it("returns an empty string unchanged", () => {
    expect(recipeDisplayName("")).toBe("");
  });
});
