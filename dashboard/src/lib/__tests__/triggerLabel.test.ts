import { describe, expect, it } from "vitest";
import { triggerFilterLabel, triggerLabel } from "@/lib/triggerLabel";

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

describe("triggerFilterLabel", () => {
  it("gives the full plain-English phrase for cron-family triggers", () => {
    expect(triggerFilterLabel("cron")).toBe("On a schedule");
    expect(triggerFilterLabel("schedule")).toBe("On a schedule");
    expect(triggerFilterLabel("scheduled")).toBe("On a schedule");
  });

  it("gives the full phrase for file-watch, git, webhook, test, and event triggers", () => {
    expect(triggerFilterLabel("on_file_save")).toBe("When a file is saved");
    expect(triggerFilterLabel("git_hook")).toBe("When you commit");
    expect(triggerFilterLabel("webhook")).toBe("When triggered by a webhook");
    expect(triggerFilterLabel("on_test_run")).toBe("When tests run");
    expect(triggerFilterLabel("event")).toBe("When an event happens");
  });

  it("defaults to 'Run manually' for undefined/null/manual", () => {
    expect(triggerFilterLabel(undefined)).toBe("Run manually");
    expect(triggerFilterLabel(null)).toBe("Run manually");
    expect(triggerFilterLabel("manual")).toBe("Run manually");
  });

  it("title-cases unrecognized trigger strings instead of showing the raw slug", () => {
    expect(triggerFilterLabel("some_unmapped_trigger")).toBe(
      "Some Unmapped Trigger",
    );
  });

  it("does not affect the existing short triggerLabel mapping", () => {
    expect(triggerLabel("cron")).toBe("cron");
  });
});
