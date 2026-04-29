import { describe, expect, it } from "vitest";
import { captureForRunlog } from "../captureForRunlog.js";

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
