import { describe, expect, it } from "vitest";
import { detectSilentFail } from "../detectSilentFail.js";

describe("detectSilentFail — pass-through", () => {
  it("null / undefined / empty string → no match", () => {
    expect(detectSilentFail(null)).toBeNull();
    expect(detectSilentFail(undefined)).toBeNull();
    expect(detectSilentFail("")).toBeNull();
  });

  it("happy-path strings → no match", () => {
    expect(detectSilentFail("Branch Health Report")).toBeNull();
    expect(detectSilentFail("3 commits in last 7 days")).toBeNull();
    expect(
      detectSilentFail("(parenthetical aside that doesn't match keywords)"),
    ).toBeNull();
  });

  it("happy-path objects → no match", () => {
    expect(detectSilentFail({ count: 5, items: [1, 2, 3] })).toBeNull();
    expect(detectSilentFail({ ok: true, data: "hello" })).toBeNull();
  });
});

describe("detectSilentFail — placeholder strings", () => {
  it("flags parens-wrapped 'unavailable'", () => {
    const m = detectSilentFail("(git branches unavailable)");
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/parens-wrapped placeholder/);
    expect(m?.matched).toContain("unavailable");
  });

  it("flags parens-wrapped 'not configured'", () => {
    expect(detectSilentFail("(slack token not configured)")).not.toBeNull();
  });

  it("flags 'no data'", () => {
    expect(detectSilentFail("(no data)")).not.toBeNull();
  });

  it("flags 'failed' in placeholder shape", () => {
    expect(detectSilentFail("(github api failed)")).not.toBeNull();
  });

  it("flags 'error' in placeholder shape", () => {
    expect(detectSilentFail("(generic error)")).not.toBeNull();
  });

  it("does NOT flag a sentence ending with 'unavailable' (not in parens)", () => {
    expect(
      detectSilentFail("The service is currently unavailable today."),
    ).toBeNull();
  });

  it("does NOT flag a parens phrase WITHOUT keywords", () => {
    expect(detectSilentFail("(see also notes below)")).toBeNull();
  });
});

describe("detectSilentFail — agent-step placeholders", () => {
  it("flags [agent step skipped: ...]", () => {
    const m = detectSilentFail(
      "[agent step skipped: ANTHROPIC_API_KEY not set]",
    );
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/agent step skipped or failed/);
  });

  it("flags [agent step failed: ...]", () => {
    expect(
      detectSilentFail("[agent step failed: empty response from local LLM]"),
    ).not.toBeNull();
  });

  it("flags [step skipped: ...]", () => {
    expect(detectSilentFail("[step skipped: missing dep]")).not.toBeNull();
  });

  it("does NOT flag bracketed text that isn't the placeholder shape", () => {
    expect(detectSilentFail("[INFO] some log line")).toBeNull();
    expect(detectSilentFail("[error] handled gracefully")).toBeNull();
  });
});

describe("detectSilentFail — list-tool antipattern", () => {
  it("flags {count: 0, error: '...'}", () => {
    const m = detectSilentFail({
      count: 0,
      error: "GitHub API rate limit exceeded",
    });
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/list-tool returned empty/);
    expect(m?.matched).toContain("rate limit");
  });

  it("flags {items: [], error: '...'}", () => {
    expect(
      detectSilentFail({ items: [], error: "Unauthorized" }),
    ).not.toBeNull();
  });

  it("flags {results: [], error: '...'}", () => {
    expect(
      detectSilentFail({ results: [], error: "service down" }),
    ).not.toBeNull();
  });

  it("does NOT flag {count: 0} without an error field (genuinely empty)", () => {
    expect(detectSilentFail({ count: 0 })).toBeNull();
    expect(detectSilentFail({ count: 0, items: [] })).toBeNull();
  });

  it("does NOT flag {count: 5, error: '...'} (partial success)", () => {
    expect(
      detectSilentFail({ count: 5, error: "1 of 6 calls failed" }),
    ).toBeNull();
  });
});

describe("detectSilentFail — JSON-string passthrough", () => {
  it("parses a stringified silent-fail object", () => {
    const m = detectSilentFail(
      JSON.stringify({ count: 0, error: "rate limit" }),
    );
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/list-tool/);
  });

  it("malformed JSON-looking string → no match (not a real failure)", () => {
    expect(detectSilentFail("{not json here}")).toBeNull();
  });
});

describe("detectSilentFail — caps", () => {
  it("matched fragment is capped at 120 chars", () => {
    const long = `(${"x".repeat(500)} unavailable)`;
    const m = detectSilentFail(long);
    expect(m).not.toBeNull();
    expect(m!.matched.length).toBeLessThanOrEqual(120);
  });
});
