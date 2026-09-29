import { describe, expect, it } from "vitest";
import { runHref } from "@/lib/runHref";

describe("runHref", () => {
  it("pins the link to the run's taskId, encoded", () => {
    expect(runHref(7, "yaml:example:1")).toBe("/runs/7?task=yaml%3Aexample%3A1");
  });
  it("falls back to the number alone without a taskId", () => {
    expect(runHref(7)).toBe("/runs/7");
    expect(runHref(7, null)).toBe("/runs/7");
  });
  it("keeps a fragment after the query", () => {
    expect(runHref(7, "t:1", "#step-a")).toBe("/runs/7?task=t%3A1#step-a");
  });
});
