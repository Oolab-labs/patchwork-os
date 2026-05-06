import { describe, expect, it } from "vitest";
import {
  arr,
  isRecord,
  num,
  shape,
  ShapeValidationError,
  str,
  type ShapeError,
} from "@/lib/validate";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });
  it("rejects null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe("str", () => {
  it("returns the string when present and well-typed", () => {
    const errors: ShapeError[] = [];
    expect(str({ name: "x" }, "name", errors)).toBe("x");
    expect(errors).toHaveLength(0);
  });

  it("treats empty strings as present (does not push 'missing')", () => {
    // The validator only checks typeof; emptiness is the caller's concern.
    const errors: ShapeError[] = [];
    expect(str({ name: "" }, "name", errors)).toBe("");
    expect(errors).toHaveLength(0);
  });

  it("pushes 'missing' when undefined and not optional", () => {
    const errors: ShapeError[] = [];
    expect(str({}, "name", errors)).toBeUndefined();
    expect(errors).toEqual([{ path: "name", reason: "missing" }]);
  });

  it("does not push 'missing' when undefined and optional", () => {
    const errors: ShapeError[] = [];
    expect(str({}, "name", errors, { optional: true })).toBeUndefined();
    expect(errors).toHaveLength(0);
  });

  it("pushes type-mismatch reason when present but wrong type", () => {
    const errors: ShapeError[] = [];
    expect(str({ n: 42 }, "n", errors)).toBeUndefined();
    expect(errors).toEqual([
      { path: "n", reason: "expected string, got number" },
    ]);
  });

  it("type-mismatch fires even when optional", () => {
    // Optional only suppresses 'missing' — wrong-type is still loud.
    const errors: ShapeError[] = [];
    expect(str({ n: 42 }, "n", errors, { optional: true })).toBeUndefined();
    expect(errors).toEqual([
      { path: "n", reason: "expected string, got number" },
    ]);
  });
});

describe("num", () => {
  it("accepts numbers including 0 and negatives", () => {
    const errors: ShapeError[] = [];
    expect(num({ x: 0 }, "x", errors)).toBe(0);
    expect(num({ x: -1 }, "x", errors)).toBe(-1);
    expect(num({ x: 3.14 }, "x", errors)).toBe(3.14);
    expect(errors).toHaveLength(0);
  });

  it("rejects numeric strings", () => {
    const errors: ShapeError[] = [];
    expect(num({ x: "42" }, "x", errors)).toBeUndefined();
    expect(errors).toEqual([
      { path: "x", reason: "expected number, got string" },
    ]);
  });

  it("respects optional", () => {
    const errors: ShapeError[] = [];
    expect(num({}, "x", errors, { optional: true })).toBeUndefined();
    expect(errors).toHaveLength(0);
  });
});

describe("arr", () => {
  it("returns the array when present", () => {
    const errors: ShapeError[] = [];
    const got = arr<number>({ xs: [1, 2, 3] }, "xs", errors);
    expect(got).toEqual([1, 2, 3]);
    expect(errors).toHaveLength(0);
  });

  it("accepts empty array", () => {
    const errors: ShapeError[] = [];
    expect(arr({ xs: [] }, "xs", errors)).toEqual([]);
    expect(errors).toHaveLength(0);
  });

  it("rejects non-array (object/string/null)", () => {
    const errors: ShapeError[] = [];
    expect(arr({ xs: { 0: "a" } }, "xs", errors)).toBeUndefined();
    expect(errors).toEqual([
      { path: "xs", reason: "expected array, got object" },
    ]);
  });

  it("respects optional", () => {
    const errors: ShapeError[] = [];
    expect(arr({}, "xs", errors, { optional: true })).toBeUndefined();
    expect(errors).toHaveLength(0);
  });
});

describe("shape", () => {
  interface Pt {
    x: number;
    y: number;
  }
  const pointShape = shape<Pt>("point", (raw, errors) => {
    if (!isRecord(raw)) {
      errors.push({ path: "$", reason: "expected object" });
      return null;
    }
    const x = num(raw, "x", errors);
    const y = num(raw, "y", errors);
    if (x === undefined || y === undefined) return null;
    return { x, y };
  });

  it("returns the typed value when valid", () => {
    expect(pointShape({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });

  it("throws ShapeValidationError aggregating all field errors", () => {
    let caught: ShapeValidationError | null = null;
    try {
      pointShape({ x: "nope", y: null });
    } catch (e) {
      caught = e as ShapeValidationError;
    }
    expect(caught).toBeInstanceOf(ShapeValidationError);
    expect(caught!.label).toBe("point");
    expect(caught!.errors).toEqual([
      { path: "x", reason: "expected number, got string" },
      { path: "y", reason: "expected number, got object" },
    ]);
    expect(caught!.message).toContain("point:");
    expect(caught!.message).toContain("x expected number");
    expect(caught!.message).toContain("y expected number");
  });

  it("throws with a default reason when check returns null but pushed no errors", () => {
    // Defensive case: if a validator forgets to push() but returns null,
    // shape() should still produce a meaningful error rather than throw an
    // empty list.
    const silentlyFails = shape<unknown>("thing", () => null);
    let caught: ShapeValidationError | null = null;
    try {
      silentlyFails({});
    } catch (e) {
      caught = e as ShapeValidationError;
    }
    expect(caught).toBeInstanceOf(ShapeValidationError);
    expect(caught!.errors).toEqual([
      { path: "$", reason: "validator returned null" },
    ]);
  });

  it("throws for non-objects via the validator's own isRecord check", () => {
    expect(() => pointShape(null)).toThrow(ShapeValidationError);
    expect(() => pointShape([1, 2])).toThrow(ShapeValidationError);
  });
});

describe("ShapeValidationError", () => {
  it("formats message as `label: path reason; path reason`", () => {
    const err = new ShapeValidationError(
      [
        { path: "a", reason: "missing" },
        { path: "b", reason: "expected string, got number" },
      ],
      "MyShape",
    );
    expect(err.message).toBe(
      "MyShape: a missing; b expected string, got number",
    );
    expect(err.name).toBe("ShapeValidationError");
  });
});
