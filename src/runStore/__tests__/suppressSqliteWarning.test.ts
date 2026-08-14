/**
 * The dangerous half of suppressing a warning is what ELSE stops being seen.
 *
 * So the test that matters is not "is the SQLite warning gone" — a suppressor
 * that silenced everything would pass that perfectly. It is "does an unrelated
 * warning still get through".
 *
 * These tests are also why this module works the way it does. The first
 * implementation used `process.on("warning")`, on the assumption that a
 * listener intercepts. It does not — Node prints from its own handler
 * regardless — so that version suppressed nothing and duplicated every other
 * warning. Caught here, not in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  restoreWarnings,
  suppressSqliteExperimentalWarning,
} from "../suppressSqliteWarning.js";

describe("SQLite experimental-warning suppression", () => {
  let emitted: Array<{ warning: unknown; type: unknown }>;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    restoreWarnings();
    emitted = [];
    // Spy on the ORIGINAL before wrapping, so we observe what actually
    // reaches Node rather than what we handed to our own wrapper.
    spy = vi.spyOn(process, "emitWarning").mockImplementation(((
      warning: unknown,
      type: unknown,
    ) => {
      emitted.push({ warning, type });
    }) as typeof process.emitWarning);
    suppressSqliteExperimentalWarning();
  });

  afterEach(() => {
    // Order matters: unwrap OUR emitWarning wrapper before restoring the spy,
    // or the wrapper is left holding a mock as its delegate and leaks into the
    // next test file in this worker.
    restoreWarnings();
    spy.mockRestore();
    vi.restoreAllMocks();
  });

  const messages = () =>
    emitted
      .map((e) =>
        typeof e.warning === "string"
          ? e.warning
          : ((e.warning as Error)?.message ?? ""),
      )
      .join("\n");

  it("swallows the node:sqlite experimental warning", () => {
    process.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
    expect(emitted, "nothing should reach Node").toHaveLength(0);
  });

  /**
   * THE test. If this fails, the suppressor has disarmed warnings across the
   * whole process — far worse than the noise it was hiding.
   */
  it("still passes unrelated warnings through", () => {
    process.emitWarning("something you should know about", "SomeOtherWarning");
    expect(messages()).toContain("something you should know about");
  });

  /** A DIFFERENT experimental warning is not ours to hide. */
  it("still passes other ExperimentalWarnings through", () => {
    process.emitWarning(
      "Type Stripping is an experimental feature",
      "ExperimentalWarning",
    );
    expect(messages()).toContain("Type Stripping");
  });

  /** The Error overload — `emitWarning(err)` carries its type as `err.name`,
   *  not as a second argument. Handled explicitly because reading the type
   *  wrongly would either leak the warning or swallow unrelated ones. */
  it("handles the Error overload without swallowing unrelated errors", () => {
    const unrelated = Object.assign(new Error("disk is nearly full"), {
      name: "ResourceWarning",
    });
    process.emitWarning(unrelated);
    expect(messages()).toContain("disk is nearly full");
  });

  it("is idempotent — no double delivery", () => {
    suppressSqliteExperimentalWarning();
    suppressSqliteExperimentalWarning();
    process.emitWarning("delivered once please", "SomeOtherWarning");
    expect(emitted).toHaveLength(1);
  });

  it("restoreWarnings puts Node's own behaviour back", () => {
    restoreWarnings();
    process.emitWarning(
      "SQLite is an experimental feature",
      "ExperimentalWarning",
    );
    expect(messages(), "suppression must be reversible").toContain("SQLite");
  });
});
