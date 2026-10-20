/**
 * `--since-days` refuses a value it cannot use (Private/52 LOW).
 *
 * `privacy receipts`, `privacy shadow` and `suggest` each parsed the flag
 * their own way, and all three answered a bad value (`abc`, `-3`, `0`) with
 * the WHOLE history — a different question, answered as if it were the one
 * asked. One parser now serves all three and reports the bad value instead.
 */

import { describe, expect, it } from "vitest";
import { parseSinceDays } from "../sinceDays.js";

describe("parseSinceDays", () => {
  it("absent flag: no window, no error", () => {
    expect(parseSinceDays(["--json"])).toEqual({ ok: true });
  });

  it.each([
    ["7", 7],
    ["1.5", 1.5],
  ])("accepts %s", (v, n) => {
    expect(parseSinceDays(["--since-days", v])).toEqual({ ok: true, days: n });
  });

  it.each([["abc"], ["-3"], ["0"], ["Infinity"], [""]])("refuses %s", (v) => {
    const r = parseSinceDays(["--since-days", v]);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("--since-days");
  });

  it("refuses a missing value", () => {
    const r = parseSinceDays(["--since-days"]);
    expect(r.ok).toBe(false);
  });

  it("refuses a following flag taken as the value", () => {
    expect(parseSinceDays(["--since-days", "--json"]).ok).toBe(false);
  });
});
