import { describe, expect, it } from "vitest";
import { isHaltStatus } from "@/lib/runStatus";

describe("isHaltStatus", () => {
  it.each(["error", "failed", "cancelled", "interrupted"])(
    "returns true for %s",
    (status) => {
      expect(isHaltStatus(status)).toBe(true);
    },
  );

  it.each(["done", "running", "pending", "skipped", "queued"])(
    "returns false for non-halt status %s",
    (status) => {
      expect(isHaltStatus(status)).toBe(false);
    },
  );

  it("returns false for undefined", () => {
    expect(isHaltStatus(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isHaltStatus(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHaltStatus("")).toBe(false);
  });

  it("is case-sensitive — ERROR does not count as a halt", () => {
    expect(isHaltStatus("ERROR")).toBe(false);
  });
});
