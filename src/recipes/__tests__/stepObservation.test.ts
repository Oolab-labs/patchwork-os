/**
 * stepObservation — unified tests for both observability shims that ship
 * in the same module: `detectSilentFail` and `captureForRunlog`.
 *
 * Migrated 2026-05-06 from the previously separate
 * `detectSilentFail.test.ts` + `captureForRunlog.test.ts` files (issue
 * #252). Test bodies are unchanged — the only edit is the import path.
 */

import { describe, expect, it } from "vitest";
import { captureForRunlog, detectSilentFail } from "../stepObservation.js";

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

describe("captureForRunlog — pass-through", () => {
  it("returns undefined for undefined", () => {
    expect(captureForRunlog(undefined)).toBeUndefined();
  });

  it("preserves primitives and small structures", () => {
    expect(captureForRunlog("hello")).toBe("hello");
    expect(captureForRunlog(42)).toBe(42);
    expect(captureForRunlog(null)).toBeNull();
    expect(captureForRunlog({ a: 1, b: ["x", "y"] })).toEqual({
      a: 1,
      b: ["x", "y"],
    });
  });
});

describe("captureForRunlog — redaction", () => {
  it("redacts top-level sensitive keys", () => {
    const captured = captureForRunlog({
      authorization: "Bearer abc",
      Cookie: "session=xyz",
      "x-api-key": "k1",
      payload: "ok",
    }) as Record<string, unknown>;
    expect(captured.authorization).toBe("[REDACTED]");
    expect(captured.Cookie).toBe("[REDACTED]");
    expect(captured["x-api-key"]).toBe("[REDACTED]");
    expect(captured.payload).toBe("ok");
  });

  it("redacts nested sensitive keys", () => {
    const captured = captureForRunlog({
      step1: {
        headers: { Authorization: "Bearer t" },
        body: { username: "x", password: "p" },
      },
    }) as {
      step1: {
        headers: Record<string, unknown>;
        body: Record<string, unknown>;
      };
    };
    expect(captured.step1.headers.Authorization).toBe("[REDACTED]");
    expect(captured.step1.body.password).toBe("[REDACTED]");
    expect(captured.step1.body.username).toBe("x");
  });

  it("matches partial key patterns case-insensitively", () => {
    const captured = captureForRunlog({
      MY_SECRET_KEY: "sek",
      AccessToken: "tok",
      user_password_hash: "hsh",
      ok: 1,
    }) as Record<string, unknown>;
    expect(captured.MY_SECRET_KEY).toBe("[REDACTED]");
    expect(captured.AccessToken).toBe("[REDACTED]");
    expect(captured.user_password_hash).toBe("[REDACTED]");
    expect(captured.ok).toBe(1);
  });

  it("redacts inside arrays", () => {
    const captured = captureForRunlog([
      { token: "t1" },
      { token: "t2" },
    ]) as Array<Record<string, unknown>>;
    expect(captured[0]?.token).toBe("[REDACTED]");
    expect(captured[1]?.token).toBe("[REDACTED]");
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const captured = captureForRunlog(a) as Record<string, unknown>;
    expect(captured.name).toBe("a");
    // self-loop replaced with marker
    expect(captured.self).toBe("[circular]");
  });
});

describe("captureForRunlog — size cap", () => {
  it("preserves payloads under 8KB", () => {
    const small = { items: Array.from({ length: 100 }, (_, i) => `item-${i}`) };
    const captured = captureForRunlog(small);
    // Equals input — no truncation envelope.
    expect((captured as { items: string[] }).items.length).toBe(100);
  });

  it("wraps over-cap payloads in a truncation envelope", () => {
    // 20KB of data — well over 8KB cap.
    const huge = { blob: "x".repeat(20_000) };
    const captured = captureForRunlog(huge) as Record<string, unknown>;
    expect(captured["[truncated]"]).toBe(true);
    expect(typeof captured.bytes).toBe("number");
    expect(captured.bytes).toBeGreaterThan(8_000);
    expect(typeof captured.preview).toBe("string");
    expect((captured.preview as string).length).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("captureForRunlog — exotic values", () => {
  it("serializes bigint as string", () => {
    const captured = captureForRunlog({ count: BigInt(123) }) as {
      count: string;
    };
    // The redacted form preserves the original value, but JSON serialize
    // is what hits disk — captureForRunlog itself returns the in-memory
    // redacted form. Validate that the helper's stringification path
    // doesn't throw on bigint by going through the over-cap path:
    const big = { count: BigInt(123), padding: "x".repeat(20_000) };
    const out = captureForRunlog(big) as Record<string, unknown>;
    expect(out["[truncated]"]).toBe(true);
    expect(typeof out.preview).toBe("string");
    void captured; // silence unused
  });

  it("survives functions and symbols (replaced with placeholders during serialization)", () => {
    const big = {
      fn: () => 1,
      sym: Symbol("s"),
      padding: "x".repeat(20_000),
    };
    expect(() => captureForRunlog(big)).not.toThrow();
  });
});
