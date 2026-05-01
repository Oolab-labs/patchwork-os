/**
 * G-security A-PR1 — HTTP `vars` validation regression suite.
 *
 * Closes R2 C-3 (the original vars regex was a no-op) + I-3 (type-strict
 * string-only values). Tests cover the four shapes the brief enumerates:
 *   - vars: {target: "../etc"}        → 400 (slash + `..`)
 *   - vars: {"bad-key": "x"}          → 400 (key regex)
 *   - vars: {ok_key: 42}              → 400 (type-strict per I-3)
 *   - vars: {ok_key: "value"}         → forwards
 */

import { describe, expect, it } from "vitest";
import { validateRecipeVars } from "../recipeRoutes.js";

describe("validateRecipeVars", () => {
  it("rejects values containing path traversal segments", () => {
    const err = validateRecipeVars({ target: "../etc" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
    expect(err?.offendingKey).toBe("target");
  });

  it("rejects values containing forward slashes", () => {
    const err = validateRecipeVars({ ok: "subdir/file.txt" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects values containing tilde", () => {
    const err = validateRecipeVars({ ok: "~/etc/passwd" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects values containing control chars", () => {
    const err = validateRecipeVars({ ok: "abc\x00def" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects keys that don't match the identifier regex", () => {
    const err = validateRecipeVars({ "bad-key": "x" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("key");
    expect(err?.offendingKey).toBe("bad-key");
  });

  it("rejects keys starting with a digit", () => {
    const err = validateRecipeVars({ "1key": "x" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("key");
  });

  it("rejects keys longer than 64 chars", () => {
    const err = validateRecipeVars({ ["a".repeat(65)]: "x" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("key");
  });

  it("rejects numeric values (type-strict per I-3)", () => {
    const err = validateRecipeVars({ ok_key: 42 });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("type");
  });

  it("rejects array values", () => {
    const err = validateRecipeVars({ ok_key: ["a"] });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("type");
  });

  it("rejects object values", () => {
    const err = validateRecipeVars({ ok_key: { nested: "x" } });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("type");
  });

  it("rejects null values", () => {
    const err = validateRecipeVars({ ok_key: null });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("type");
  });

  it("rejects empty-string values", () => {
    const err = validateRecipeVars({ ok_key: "" });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects values longer than 1024 chars", () => {
    const err = validateRecipeVars({ ok_key: "a".repeat(1025) });
    expect(err).not.toBeNull();
    expect(err?.field).toBe("value");
  });

  it("rejects when vars is an array (not a plain object)", () => {
    const err = validateRecipeVars(["a", "b"]);
    expect(err).not.toBeNull();
    expect(err?.field).toBe("type");
  });

  it("accepts a plain string-string vars object", () => {
    expect(validateRecipeVars({ ok_key: "value" })).toBeNull();
  });

  it("accepts vars with allowed punctuation in values", () => {
    expect(
      validateRecipeVars({
        topic: "alpha.beta-gamma:42",
        recipient: "user@example.com",
      }),
    ).toBeNull();
  });

  it("accepts undefined / null vars (request without a body field)", () => {
    expect(validateRecipeVars(undefined)).toBeNull();
    expect(validateRecipeVars(null)).toBeNull();
  });
});
