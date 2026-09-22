/**
 * stepObservation — unified tests for both observability shims that ship
 * in the same module: `detectSilentFail` and `captureForRunlog`.
 *
 * Migrated 2026-05-06 from the previously separate
 * `detectSilentFail.test.ts` + `captureForRunlog.test.ts` files (issue
 * #252). Test bodies are unchanged — the only edit is the import path.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSecretValuesForTesting,
  registerSecretValue,
} from "../../governance/secretValues.js";
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

  it("gives recipe_no_workspace its own typed reason, not the generic bucket", () => {
    // Regression: P7 of the 2026-05-20 improvement-research run. With the
    // workspace-root fix shipped in P2, this string is now emitted whenever
    // a recipe step can't resolve a workspace. Without a dedicated pattern
    // it collapses into the generic "agent step skipped or failed" bucket,
    // hiding the actual cause — defeating the point of P2's typed error.
    const m = detectSilentFail(
      '[agent step failed: recipe_no_workspace — no .git ancestor of "/Users/wesh" and PATCHWORK_WORKSPACE not set]',
    );
    expect(m).not.toBeNull();
    expect(m?.reason).toBe("recipe_no_workspace");
    // The generic agent-step pattern (which matches the same prefix) must
    // NOT have fired first.
    expect(m?.reason).not.toMatch(/agent step skipped or failed/);
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

describe("silent-fail marker keeps its reason (#butler-demo)", () => {
  // The real refusal this was found on: worker autonomy declined to run an
  // agent step whose driver could not enforce a tool sandbox. The message said
  // exactly that, and the run record recorded the bare string
  // "[agent step failed:" — the pattern matched only the prefix, and `matched`
  // is built from m[0]. A precise safety message became an opaque failure that
  // had to be diagnosed by reading the source.
  const REAL =
    "[agent step failed: worker autonomy requires the subprocess or codex driver to enforce its tool sandbox — set the agent step (or recipe) driver to `subprocess`/`claude-code`/`codex`; refusing to run un-sandboxed]";

  it("carries the reason, not just the prefix", () => {
    const hit = detectSilentFail(REAL);
    expect(hit).not.toBeNull();
    expect(hit?.matched).toContain("worker autonomy");
    expect(hit?.matched).not.toBe("[agent step failed:");
  });

  it("still caps the fragment so a huge blob cannot flood the log", () => {
    const hit = detectSilentFail(`[agent step failed: ${"x".repeat(500)}]`);
    expect(hit?.matched.length).toBeLessThanOrEqual(120);
  });

  it("still detects a bare prefix with no reason after it", () => {
    // Back-compat: some callers emit the marker with nothing following.
    expect(detectSilentFail("[agent step failed:")).not.toBeNull();
    expect(detectSilentFail("[step skipped: nothing to do]")).not.toBeNull();
  });
});

describe("agent driver enum matches the runtime (#1311 sibling drift)", () => {
  // The schema's driver enum and DOWNSHIFT_KNOWN_DRIVERS are hand-maintained
  // lists that must track agentExecutor's branches. `local` drifted out once
  // (audit 2026-06-10) and `subprocess` drifted out again — rejecting the
  // shipped butler-errand template, which needs a sandbox-capable driver to
  // demonstrate the flag it exists for. A recipe that runs but will not lint
  // is the worst shape: valid in production, rejected at the door.
  it("accepts every driver the executor actually branches on", async () => {
    const { generateSchemaSet } = await import("../schemaGenerator.js");
    const set = generateSchemaSet();
    const json = JSON.stringify(set);
    for (const driver of ["subprocess", "claude-code", "codex", "local"]) {
      expect(json, `${driver} missing from the generated schema`).toContain(
        `"${driver}"`,
      );
    }
  });
});

/**
 * Separator variants of the same secret name must all redact.
 *
 * `SENSITIVE_KEY_PATTERNS` was hand-maintained and carried BOTH separator
 * spellings for some names (`client_secret` / `client-secret`,
 * `refresh_token` / `refresh-token`) — but only `api-key` and `apikey`, never
 * the snake_case `api_key` that recipe YAML naturally uses. So a resolved
 * `api_key` reached the run log, the dashboard, and the approval payload in
 * clear text.
 *
 * Found while making approval prompts show resolved values (#1343): rendering
 * templates before showing them to a human is what turns an inert
 * `{{api_key}}` into an actual credential in a persisted record.
 *
 * The fix normalises separators once rather than enumerating spellings, which
 * is why this test asserts all three forms together — enumerating is the thing
 * that failed.
 */
describe("captureForRunlog — separator variants of a secret key", () => {
  const SECRET = "NOT-A-REAL-CREDENTIAL-abcdef123456";

  for (const key of ["api_key", "api-key", "apikey", "API_KEY"]) {
    it(`redacts ${key}`, () => {
      const out = JSON.stringify(
        captureForRunlog({ [key]: SECRET, keep: "ok" }),
      );
      expect(out).not.toContain(SECRET);
      expect(out).toContain("ok"); // anchor: non-secret fields survive
    });
  }

  for (const key of ["client_secret", "refresh_token", "access_token"]) {
    it(`still redacts ${key}`, () => {
      const out = JSON.stringify(captureForRunlog({ [key]: SECRET }));
      expect(out).not.toContain(SECRET);
    });
  }

  it("does not redact an innocuous key that merely resembles one", () => {
    // Anchor against over-widening: "monkey" ends in "key", "tokenizer"
    // contains "token". The second SHOULD redact (substring match is the
    // existing, deliberate behaviour); the first must not.
    const out = JSON.stringify(captureForRunlog({ monkey: "banana" }));
    expect(out).toContain("banana");
  });
});

describe("captureForRunlog — value-based redaction composes after key-based", () => {
  afterEach(() => _resetSecretValuesForTesting());

  it("a registered secret under a NON-sensitive key is still redacted", () => {
    const secret = "sk-live-0123456789abcdefABCDEF";
    registerSecretValue(secret, "env");
    const captured = captureForRunlog({
      url: `https://example.test/?key=${secret}`,
      body: `{"auth":"${secret}"}`,
      note: "unrelated",
    }) as Record<string, string>;
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect(captured.url).toContain("[REDACTED:env]");
    expect(captured.note).toBe("unrelated");
  });

  it("key-based redaction is unchanged when the registry is empty", () => {
    const captured = captureForRunlog({
      password: "hunter2hunter2",
      plain: "kept",
    }) as Record<string, string>;
    expect(captured.password).toBe("[REDACTED]");
    expect(captured.plain).toBe("kept");
  });
});
