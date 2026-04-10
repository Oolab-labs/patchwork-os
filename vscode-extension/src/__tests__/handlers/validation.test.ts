import { describe, expect, it } from "vitest";
import { requireNumber, requireString } from "../../handlers/validation";

describe("requireString", () => {
  it("returns the value when given a valid non-empty string", () => {
    expect(requireString("hello", "myParam")).toBe("hello");
  });

  it("throws when value is undefined", () => {
    expect(() => requireString(undefined, "myParam")).toThrow(
      "myParam is required and must be a non-empty string",
    );
  });

  it("throws when value is an empty string", () => {
    expect(() => requireString("", "myParam")).toThrow(
      "myParam is required and must be a non-empty string",
    );
  });

  it("throws when value is not a string (number)", () => {
    expect(() => requireString(42, "myParam")).toThrow(
      "myParam is required and must be a non-empty string",
    );
  });

  it("throws when value is not a string (null)", () => {
    expect(() => requireString(null, "myParam")).toThrow(
      "myParam is required and must be a non-empty string",
    );
  });

  it("throws when value is not a string (object)", () => {
    expect(() => requireString({}, "myParam")).toThrow(
      "myParam is required and must be a non-empty string",
    );
  });

  it("error message includes the param name", () => {
    expect(() => requireString(undefined, "targetFile")).toThrow("targetFile");
  });
});

describe("requireNumber", () => {
  it("returns the value when given a valid finite number", () => {
    expect(requireNumber(42, "myNum")).toBe(42);
  });

  it("returns zero, which is a valid finite number", () => {
    expect(requireNumber(0, "myNum")).toBe(0);
  });

  it("returns a negative number", () => {
    expect(requireNumber(-7, "myNum")).toBe(-7);
  });

  it("throws when value is NaN", () => {
    expect(() => requireNumber(Number.NaN, "myNum")).toThrow(
      "myNum is required and must be a finite number",
    );
  });

  it("throws when value is Infinity", () => {
    expect(() => requireNumber(Infinity, "myNum")).toThrow(
      "myNum is required and must be a finite number",
    );
  });

  it("throws when value is -Infinity", () => {
    expect(() => requireNumber(-Infinity, "myNum")).toThrow(
      "myNum is required and must be a finite number",
    );
  });

  it("throws when value is undefined", () => {
    expect(() => requireNumber(undefined, "myNum")).toThrow(
      "myNum is required and must be a finite number",
    );
  });

  it("throws when value is a string", () => {
    expect(() => requireNumber("42", "myNum")).toThrow(
      "myNum is required and must be a finite number",
    );
  });

  it("error message includes the param name", () => {
    expect(() => requireNumber(undefined, "lineNumber")).toThrow("lineNumber");
  });
});
