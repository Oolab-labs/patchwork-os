import { describe, expect, it } from "vitest";
import { semverGt } from "../version.js";

describe("semverGt", () => {
  it("returns true when registry major is higher", () => {
    expect(semverGt("3.0.0", "2.34.0")).toBe(true);
  });

  it("returns true when registry minor is higher", () => {
    expect(semverGt("2.35.0", "2.34.0")).toBe(true);
  });

  it("returns true when registry patch is higher", () => {
    expect(semverGt("2.34.1", "2.34.0")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(semverGt("2.34.0", "2.34.0")).toBe(false);
  });

  it("returns false when local is ahead of registry (the bug case)", () => {
    expect(semverGt("2.30.1", "2.34.0")).toBe(false);
  });

  it("returns false when local major is higher", () => {
    expect(semverGt("1.0.0", "2.34.0")).toBe(false);
  });
});
