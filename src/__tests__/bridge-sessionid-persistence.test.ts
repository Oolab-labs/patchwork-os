/**
 * Regression guard for sessionId truncation in activity-log metadata.
 *
 * Background: bridge.ts writes lifecycle events to activityLog so downstream
 * consumers (e.g. dashboard session detail) can correlate by sessionId. A
 * long-standing bug truncated sessionId to 8 chars inside recordEvent
 * metadata, making correlation impossible (truncated "31f13def" never matches
 * the full UUID known to /sessions).
 *
 * This test lints the source to ensure every `activityLog.recordEvent` call
 * that includes a `sessionId` passes the *full* identifier, not `.slice(0, 8)`.
 * Human-readable log strings (logger.info/warn/error) are allowed to keep the
 * short form — readability there outweighs correlation, and logs aren't a
 * structured correlation surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bridge activity log metadata preserves full sessionId", () => {
  it("never truncates sessionId inside activityLog.recordEvent", () => {
    const path = join(__dirname, "..", "bridge.ts");
    const src = readFileSync(path, "utf8");

    // Find every `activityLog.recordEvent(...)` block and assert the
    // metadata object (second arg) doesn't contain `sessionId: <var>.slice(0, 8)`.
    const re = /activityLog\.recordEvent\([^)]*?\{([^}]*)\}/gs;
    const bad: string[] = [];
    for (const m of src.matchAll(re)) {
      const body = m[1] ?? "";
      if (
        /sessionId\s*:\s*[A-Za-z_][A-Za-z0-9_]*\.slice\(\s*0\s*,\s*8\s*\)/.test(
          body,
        )
      ) {
        bad.push(body.trim().replace(/\s+/g, " "));
      }
    }
    expect(
      bad,
      `truncated sessionId in recordEvent metadata: ${bad.join(" | ")}`,
    ).toEqual([]);
  });
});
