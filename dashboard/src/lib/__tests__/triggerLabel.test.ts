import { describe, expect, it } from "vitest";
import { triggerLabel } from "@/lib/triggerLabel";

describe("triggerLabel", () => {
  it("maps cron-family triggers to 'cron'", () => {
    expect(triggerLabel("cron")).toBe("cron");
    expect(triggerLabel("schedule")).toBe("cron");
    expect(triggerLabel("scheduled")).toBe("cron");
  });

  it("maps on_test_run to the short label 'test', not a truncated raw string", () => {
    expect(triggerLabel("on_test_run")).toBe("test");
  });

  it("maps file-watch family to 'save'", () => {
    expect(triggerLabel("on_file_save")).toBe("save");
    expect(triggerLabel("file_watch")).toBe("save");
  });

  it("maps git_hook to 'git'", () => {
    expect(triggerLabel("git_hook")).toBe("git");
  });

  it("defaults to 'manual' for undefined/null", () => {
    expect(triggerLabel(undefined)).toBe("manual");
    expect(triggerLabel(null)).toBe("manual");
  });

  it("falls back to an 8-char slice for unknown trigger strings", () => {
    expect(triggerLabel("some_unmapped_trigger")).toBe("some_unm");
  });
});
