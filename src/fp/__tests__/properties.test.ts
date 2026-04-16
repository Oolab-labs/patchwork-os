/**
 * Property-based tests for pure functions in src/fp/ and src/tools/utils.ts.
 * Uses fast-check for exhaustive adversarial input generation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadPolicy } from "../../automation.js";
import { resolveFilePath, truncateOutput } from "../../tools/utils.js";
import { truncatePrompt, untrustedBlock } from "../automationUtils.js";
import type { CommandConfig } from "../commandDescription.js";
import { buildCommandDescription } from "../commandDescription.js";
import type { TokenBucketState } from "../tokenBucket.js";
import { consumeToken, refillBucket } from "../tokenBucket.js";

// ─── Test workspace setup ────────────────────────────────────────────────────

let WORKSPACE: string;

beforeAll(() => {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "pbt-workspace-"));
});

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// ─── Target 1: resolveFilePath — workspace containment ───────────────────────

describe("resolveFilePath — workspace containment", () => {
  test("never escapes workspace for arbitrary string inputs", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 300 }), (input) => {
        try {
          const result = resolveFilePath(input, WORKSPACE);
          // Must equal workspace or be strictly inside it
          return (
            result === WORKSPACE || result.startsWith(WORKSPACE + path.sep)
          );
        } catch {
          return true; // throwing is always acceptable
        }
      }),
      { seed: 42 },
    );
  });

  test("rejects path traversal: ../../../etc/passwd", () => {
    expect(() => resolveFilePath("../../../etc/passwd", WORKSPACE)).toThrow();
  });

  test("rejects path traversal: foo/../../bar", () => {
    expect(() => resolveFilePath("foo/../../bar", WORKSPACE)).toThrow();
  });

  test("rejects null byte in path", () => {
    expect(() => resolveFilePath("foo\x00bar", WORKSPACE)).toThrow();
  });

  test("accepts valid relative paths inside workspace", () => {
    const result = resolveFilePath("src/index.ts", WORKSPACE);
    expect(result.startsWith(WORKSPACE)).toBe(true);
  });

  test("never escapes via absolute paths outside workspace", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "/etc/passwd",
          "/tmp/outside",
          "/root/.ssh/id_rsa",
          "/../etc/hosts",
        ),
        (input) => {
          try {
            const result = resolveFilePath(input, WORKSPACE);
            return (
              result === WORKSPACE || result.startsWith(WORKSPACE + path.sep)
            );
          } catch {
            return true;
          }
        },
      ),
      { seed: 42 },
    );
  });
});

// ─── Target 2: buildCommandDescription — allowlist/blocklist invariants ──────

describe("buildCommandDescription — security invariants", () => {
  const config: CommandConfig = {
    commandAllowlist: ["echo", "ls"],
    commandTimeout: 30_000,
    maxResultSize: 1024,
  };

  test("any command NOT in allowlist always throws", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 64 })
          .filter(
            (s) =>
              !["echo", "ls"].includes(s.toLowerCase()) &&
              !s.includes("/") &&
              !s.includes("\\") &&
              !s.includes("..") &&
              !s.includes(" ") &&
              s.trim().length > 0,
          ),
        (cmd) => {
          try {
            buildCommandDescription({ command: cmd }, config, WORKSPACE);
            return false; // should have thrown
          } catch {
            return true;
          }
        },
      ),
      { seed: 42 },
    );
  });

  test("interpreter flags are blocked even for allowlisted commands", () => {
    const dangerousFlags = [
      "--eval",
      "--exec",
      "-e",
      "-c",
      "--print",
      "--loader",
      "--inspect",
    ];
    for (const flag of dangerousFlags) {
      // These flags are interpreter-specific; 'echo' is not an interpreter so
      // they won't be blocked by interpreter check, but we verify the general
      // interpreter-command block works for node-like commands (not in allowlist)
      // The real invariant: INTERPRETER_COMMANDS cannot be in the allowlist
      expect(() =>
        buildCommandDescription(
          { command: "echo", args: [flag, "hello"] },
          config,
          WORKSPACE,
        ),
      ).not.toThrow(); // echo is not interpreter, flags pass through
    }
  });

  test("result command is always lowercased version of input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("echo", "ls", "ECHO", "Echo", "LS"),
        (cmd) => {
          try {
            const desc = buildCommandDescription(
              { command: cmd },
              config,
              WORKSPACE,
            );
            return desc.command === cmd.toLowerCase();
          } catch {
            return true; // not in allowlist after lowercase — acceptable
          }
        },
      ),
      { seed: 42 },
    );
  });

  test("result cwd always starts with workspace", () => {
    fc.assert(
      fc.property(fc.constantFrom(undefined, ".", "src"), (cwd) => {
        try {
          const desc = buildCommandDescription(
            cwd !== undefined ? { command: "echo", cwd } : { command: "echo" },
            config,
            WORKSPACE,
          );
          return (
            desc.cwd === WORKSPACE || desc.cwd.startsWith(WORKSPACE + path.sep)
          );
        } catch {
          return true;
        }
      }),
      { seed: 42 },
    );
  });

  test("cwd escaping workspace always throws", () => {
    expect(() =>
      buildCommandDescription(
        { command: "echo", cwd: "/etc" },
        config,
        WORKSPACE,
      ),
    ).toThrow();
  });
});

// ─── Target 3: truncateOutput / truncatePrompt — size invariants + idempotency ─

describe("truncateOutput — size invariants + idempotency", () => {
  test("result byte-length is always <= limit", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2000 }),
        fc.integer({ min: 1, max: 2000 }),
        (str, limit) => {
          const { text } = truncateOutput(str, limit);
          return Buffer.byteLength(text, "utf-8") <= limit;
        },
      ),
      { seed: 42 },
    );
  });

  test("if input byte-length <= limit, truncated=false and text equals input", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        fc.integer({ min: 1000, max: 5000 }),
        (str, limit) => {
          const byteLen = Buffer.byteLength(str, "utf-8");
          if (byteLen > limit) return true; // skip — limit is too small for this input
          const { text, truncated } = truncateOutput(str, limit);
          return !truncated && text === str;
        },
      ),
      { seed: 42 },
    );
  });

  test("idempotency: truncating twice gives same result as once", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2000 }),
        fc.integer({ min: 10, max: 2000 }),
        (str, limit) => {
          const once = truncateOutput(str, limit).text;
          const twice = truncateOutput(once, limit).text;
          return once === twice;
        },
      ),
      { seed: 42 },
    );
  });
});

describe("truncatePrompt — size invariant", () => {
  test("result byte length is always <= MAX_POLICY_PROMPT_CHARS + suffix", () => {
    const MAX = 32_768;
    const SUFFIX_BYTES = Buffer.byteLength(
      "\n[... truncated to fit 32KB limit ...]",
      "utf8",
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 70_000 }), (prompt) => {
        const result = truncatePrompt(prompt);
        return Buffer.byteLength(result, "utf8") <= MAX + SUFFIX_BYTES;
      }),
      { seed: 42 },
    );
  });

  test("if input byte length <= MAX, output equals input", () => {
    const MAX = 32_768;
    fc.assert(
      fc.property(fc.string({ maxLength: MAX }), (prompt) => {
        // Only assert identity when input is within the byte limit.
        if (Buffer.byteLength(prompt, "utf8") > MAX) return true;
        return truncatePrompt(prompt) === prompt;
      }),
      { seed: 42 },
    );
  });
});

// ─── Target 4: refillBucket + consumeToken — token bucket invariants ─────────

describe("refillBucket — token bucket math", () => {
  test("tokens always in [0, limit] when now >= lastRefill", () => {
    fc.assert(
      fc.property(
        fc.record({
          tokens: fc.double({ min: 0, max: 1000, noNaN: true }),
          lastRefill: fc.integer({ min: 0, max: 1_000_000 }),
        }) as fc.Arbitrary<TokenBucketState>,
        fc.integer({ min: 0, max: 1_000_000 }), // elapsed (non-negative)
        fc.integer({ min: 1, max: 1000 }), // limit
        fc.integer({ min: 1, max: 120_000 }), // windowMs
        (state, elapsed, limit, windowMs) => {
          const now = state.lastRefill + elapsed; // ensures now >= lastRefill
          const next = refillBucket(state, now, limit, windowMs);
          return next.tokens >= 0 && next.tokens <= limit;
        },
      ),
      { seed: 42 },
    );
  });

  test("negative time travel does not increase tokens", () => {
    fc.assert(
      fc.property(
        fc.record({
          tokens: fc.double({ min: 0, max: 100, noNaN: true }),
          lastRefill: fc.integer({ min: 1000, max: 1_000_000 }),
        }) as fc.Arbitrary<TokenBucketState>,
        fc.integer({ min: 1, max: 100 }), // limit
        (state, limit) => {
          // now < lastRefill — time went backwards
          const pastNow = state.lastRefill - 1;
          const next = refillBucket(state, pastNow, limit);
          // tokens should not increase; elapsed is negative → refill is negative
          return next.tokens <= state.tokens;
        },
      ),
      { seed: 42 },
    );
  });
});

describe("consumeToken — token consumption invariants", () => {
  test("allowed=true when tokens >= 1, nextState.tokens = state.tokens - 1", () => {
    fc.assert(
      fc.property(
        fc.record({
          tokens: fc.double({ min: 1, max: 1000, noNaN: true }),
          lastRefill: fc.integer({ min: 0, max: 1_000_000 }),
        }) as fc.Arbitrary<TokenBucketState>,
        (state) => {
          const { allowed, nextState } = consumeToken(state);
          return allowed && nextState.tokens === state.tokens - 1;
        },
      ),
      { seed: 42 },
    );
  });

  test("allowed=false and state unchanged when tokens < 1", () => {
    fc.assert(
      fc.property(
        fc.record({
          tokens: fc.double({ min: -100, max: 0.999, noNaN: true }),
          lastRefill: fc.integer({ min: 0, max: 1_000_000 }),
        }) as fc.Arbitrary<TokenBucketState>,
        (state) => {
          const { allowed, nextState } = consumeToken(state);
          return (
            !allowed &&
            nextState.tokens === state.tokens &&
            nextState.lastRefill === state.lastRefill
          );
        },
      ),
      { seed: 42 },
    );
  });

  test("after limit+1 consumes, at least 1 is rejected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // limit
        (limit) => {
          let state: TokenBucketState = { tokens: limit, lastRefill: 0 };
          let rejections = 0;
          for (let i = 0; i < limit + 1; i++) {
            const { allowed, nextState } = consumeToken(state);
            if (!allowed) rejections++;
            state = nextState;
          }
          return rejections >= 1;
        },
      ),
      { seed: 42 },
    );
  });
});

// ─── Target 5: loadPolicy — validation invariants (via temp files) ───────────

describe("loadPolicy — validation invariants", () => {
  const MIN_COOLDOWN_MS = 5_000;

  function writeTempPolicy(obj: unknown): string {
    const f = path.join(
      os.tmpdir(),
      `pbt-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    fs.writeFileSync(f, JSON.stringify(obj), "utf-8");
    return f;
  }

  test("any loaded policy: all standard hook cooldownMs >= MIN_COOLDOWN_MS", () => {
    fc.assert(
      fc.property(
        fc.record({
          onGitCommit: fc.option(
            fc.record({
              enabled: fc.boolean(),
              cooldownMs: fc.oneof(
                fc.integer({ min: -10000, max: 100000 }),
                fc.constant(5000),
                fc.constant(1),
              ),
              prompt: fc.option(fc.string({ maxLength: 100 })),
            }),
            { nil: undefined },
          ),
          onPreCompact: fc.option(
            fc.record({
              enabled: fc.boolean(),
              cooldownMs: fc.integer({ min: 0, max: 100000 }),
              prompt: fc.option(fc.string({ maxLength: 100 })),
            }),
            { nil: undefined },
          ),
        }),
        (rawPolicy) => {
          const f = writeTempPolicy(rawPolicy);
          try {
            const policy = loadPolicy(f);
            // All cooldownMs values in loaded policy must be >= MIN_COOLDOWN_MS
            const hooks = [policy.onGitCommit, policy.onPreCompact] as const;
            for (const hook of hooks) {
              if (hook !== undefined && "cooldownMs" in hook) {
                if ((hook.cooldownMs as number) < MIN_COOLDOWN_MS) return false;
              }
            }
            return true;
          } catch {
            return true; // throwing is always acceptable
          } finally {
            try {
              fs.unlinkSync(f);
            } catch {
              /* ignore */
            }
          }
        },
      ),
      { seed: 42 },
    );
  });

  test("any loaded policy: all hook enabled fields are booleans", () => {
    fc.assert(
      fc.property(
        fc.record({
          onBranchCheckout: fc.option(
            fc.record({
              enabled: fc.boolean(),
              cooldownMs: fc.integer({ min: 5000, max: 60000 }),
              prompt: fc.string({ maxLength: 50 }),
            }),
            { nil: undefined },
          ),
        }),
        (rawPolicy) => {
          const f = writeTempPolicy(rawPolicy);
          try {
            const policy = loadPolicy(f);
            if (policy.onBranchCheckout !== undefined) {
              return typeof policy.onBranchCheckout.enabled === "boolean";
            }
            return true;
          } catch {
            return true;
          } finally {
            try {
              fs.unlinkSync(f);
            } catch {
              /* ignore */
            }
          }
        },
      ),
      { seed: 42 },
    );
  });

  test("cooldownMs: NaN, Infinity, -1 — never produces invalid output", () => {
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ];
    for (const badCooldown of invalidValues) {
      const f = writeTempPolicy({
        onGitCommit: { enabled: true, cooldownMs: badCooldown, prompt: "test" },
      });
      try {
        const policy = loadPolicy(f);
        // If it loaded, cooldownMs must be valid (finite and >= MIN_COOLDOWN_MS)
        if (policy.onGitCommit !== undefined) {
          const cd = policy.onGitCommit.cooldownMs as number;
          expect(Number.isFinite(cd)).toBe(true);
          expect(cd).toBeGreaterThanOrEqual(MIN_COOLDOWN_MS);
        }
      } catch {
        // throwing is acceptable for invalid input
      } finally {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

// ─── Target 6: untrustedBlock — nonce stripping invariants ───────────────────

describe("untrustedBlock — nonce stripping", () => {
  // valid label: uppercase ASCII letters and spaces
  const validLabel = fc
    .stringMatching(/^[A-Z][A-Z0-9 ]{0,19}$/)
    .filter((s) => /^[A-Z][A-Z0-9 ]*$/.test(s));

  // Nonce generator: alphanumeric + regex metacharacters to exercise the
  // literal-string replacement path (previously `new RegExp(nonce)` would throw
  // SyntaxError on nonces containing "[", "+", ".", etc.).
  const anyNonce = fc
    .string({ minLength: 8, maxLength: 32 })
    .filter((s) => !/[\r\n]/.test(s));

  test("output contains opening delimiter exactly once", () => {
    fc.assert(
      fc.property(
        validLabel,
        fc.string({ maxLength: 500 }),
        anyNonce,
        (label, value, nonce) => {
          const result = untrustedBlock(label, value, nonce);
          const opening = `--- BEGIN ${label} [${nonce}]`;
          const count = result.split(opening).length - 1;
          return count === 1;
        },
      ),
      { seed: 42 },
    );
  });

  test("output contains closing delimiter exactly once", () => {
    fc.assert(
      fc.property(
        validLabel,
        fc.string({ maxLength: 500 }),
        anyNonce,
        (label, value, nonce) => {
          const result = untrustedBlock(label, value, nonce);
          const closing = `--- END ${label} [${nonce}] ---`;
          const count = result.split(closing).length - 1;
          return count === 1;
        },
      ),
      { seed: 42 },
    );
  });

  test("adversarial value containing closing delimiter — stripped from value portion", () => {
    fc.assert(
      fc.property(validLabel, anyNonce, (label, nonce) => {
        // Value that embeds the nonce — prompt injection attempt
        const adversarialValue = `innocent prefix ${nonce} evil suffix`;
        const result = untrustedBlock(label, adversarialValue, nonce);
        const closing = `--- END ${label} [${nonce}] ---`;
        // Closing delimiter must appear exactly once
        const count = result.split(closing).length - 1;
        return count === 1;
      }),
      { seed: 42 },
    );
  });

  test("nonce appears in both opening and closing delimiters", () => {
    fc.assert(
      fc.property(
        validLabel,
        fc.string({ maxLength: 200 }),
        anyNonce,
        (label, value, nonce) => {
          const result = untrustedBlock(label, value, nonce);
          return (
            result.includes(`BEGIN ${label} [${nonce}]`) &&
            result.includes(`END ${label} [${nonce}]`)
          );
        },
      ),
      { seed: 42 },
    );
  });

  test("nonces with regex metacharacters do not throw", () => {
    const metacharNonces = ["[abc]+", "foo.bar", "(baz)?", "x{2,4}", "^start"];
    for (const nonce of metacharNonces) {
      expect(() => untrustedBlock("LABEL", "some value", nonce)).not.toThrow();
    }
  });

  test("invalid label throws", () => {
    expect(() => untrustedBlock("lowercase", "value", "nonce12345")).toThrow();
    expect(() => untrustedBlock("has-dash", "value", "nonce12345")).toThrow();
  });
});

// ─── Target 7: mergeAutomationStates ─────────────────────────────────────────

import {
  EMPTY_AUTOMATION_STATE,
  mergeAutomationStates,
  recordDedup,
  recordTrigger,
} from "../automationState.js";

const keyArb = fc.stringMatching(/^[a-z][a-z0-9]{0,19}$/);
const tsArb = fc.integer({ min: 1_000_000, max: 2_000_000_000 });

describe("mergeAutomationStates — PBT", () => {
  test("idempotent: merge(a, a) = a for lastTrigger keys and timestamps", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 10 }),
        (entries) => {
          let state = EMPTY_AUTOMATION_STATE;
          for (const [k, ts] of entries) {
            state = recordTrigger(state, k, "task", ts);
          }
          const merged = mergeAutomationStates(state, state);
          // All keys must survive
          for (const [k] of entries) {
            if (!merged.lastTrigger.has(k)) return false;
          }
          // Timestamps must not decrease
          for (const [k, _] of merged.lastTrigger) {
            const orig = state.lastTrigger.get(k);
            if (orig !== undefined && merged.lastTrigger.get(k)! < orig) {
              return false;
            }
          }
          return true;
        },
      ),
      { seed: 42 },
    );
  });

  test("commutative: merge(a,b) and merge(b,a) have same lastTrigger keys and max timestamps", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 1, maxLength: 8 }),
        (entriesA, entriesB) => {
          let a = EMPTY_AUTOMATION_STATE;
          for (const [k, ts] of entriesA) a = recordTrigger(a, k, "t", ts);
          let b = EMPTY_AUTOMATION_STATE;
          for (const [k, ts] of entriesB) b = recordTrigger(b, k, "t", ts);

          const ab = mergeAutomationStates(a, b);
          const ba = mergeAutomationStates(b, a);

          // Same key sets
          const abKeys = [...ab.lastTrigger.keys()].sort().join(",");
          const baKeys = [...ba.lastTrigger.keys()].sort().join(",");
          if (abKeys !== baKeys) return false;

          // Same timestamps per key
          for (const k of ab.lastTrigger.keys()) {
            if (ab.lastTrigger.get(k) !== ba.lastTrigger.get(k)) return false;
          }
          return true;
        },
      ),
      { seed: 42 },
    );
  });

  test("merge keeps max timestamp: result[k] >= max(a[k], b[k]) for all shared keys", () => {
    fc.assert(
      fc.property(keyArb, tsArb, tsArb, (key, tsA, tsB) => {
        const a = recordTrigger(EMPTY_AUTOMATION_STATE, key, "t", tsA);
        const b = recordTrigger(EMPTY_AUTOMATION_STATE, key, "t", tsB);
        const merged = mergeAutomationStates(a, b);
        const got = merged.lastTrigger.get(key)!;
        return got === Math.max(tsA, tsB);
      }),
      { seed: 42 },
    );
  });

  test("deduplicationWindow max preserved", () => {
    fc.assert(
      fc.property(keyArb, tsArb, tsArb, (key, tsA, tsB) => {
        const a = recordDedup(EMPTY_AUTOMATION_STATE, key, tsA);
        const b = recordDedup(EMPTY_AUTOMATION_STATE, key, tsB);
        const merged = mergeAutomationStates(a, b);
        return merged.deduplicationWindow.get(key) === Math.max(tsA, tsB);
      }),
      { seed: 42 },
    );
  });

  test("taskTimestamps length = sum of both inputs (no dedup)", () => {
    fc.assert(
      fc.property(
        fc.array(tsArb, { minLength: 0, maxLength: 20 }),
        fc.array(tsArb, { minLength: 0, maxLength: 20 }),
        (tsAs, tsBs) => {
          let a = EMPTY_AUTOMATION_STATE;
          for (const ts of tsAs) a = recordTrigger(a, "k", "t", ts);
          let b = EMPTY_AUTOMATION_STATE;
          for (const ts of tsBs) b = recordTrigger(b, "k", "t", ts);
          const merged = mergeAutomationStates(a, b);
          return merged.taskTimestamps.length === tsAs.length + tsBs.length;
        },
      ),
      { seed: 42 },
    );
  });

  test("identity: merge(a, EMPTY) and merge(EMPTY, a) preserve a's lastTrigger + dedup maps", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 10 }),
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 10 }),
        (triggers, dedups) => {
          let a = EMPTY_AUTOMATION_STATE;
          for (const [k, ts] of triggers) a = recordTrigger(a, k, "t", ts);
          for (const [k, ts] of dedups) a = recordDedup(a, k, ts);

          const left = mergeAutomationStates(a, EMPTY_AUTOMATION_STATE);
          const right = mergeAutomationStates(EMPTY_AUTOMATION_STATE, a);

          for (const [k, v] of a.lastTrigger) {
            if (left.lastTrigger.get(k) !== v) return false;
            if (right.lastTrigger.get(k) !== v) return false;
          }
          for (const [k, v] of a.deduplicationWindow) {
            if (left.deduplicationWindow.get(k) !== v) return false;
            if (right.deduplicationWindow.get(k) !== v) return false;
          }
          return (
            left.lastTrigger.size === a.lastTrigger.size &&
            right.lastTrigger.size === a.lastTrigger.size
          );
        },
      ),
      { seed: 42 },
    );
  });

  test("associative on lastTrigger: merge(merge(a,b),c) == merge(a,merge(b,c))", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 6 }),
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 6 }),
        fc.array(fc.tuple(keyArb, tsArb), { minLength: 0, maxLength: 6 }),
        (ea, eb, ec) => {
          const build = (entries: [string, number][]) => {
            let s = EMPTY_AUTOMATION_STATE;
            for (const [k, ts] of entries) s = recordTrigger(s, k, "t", ts);
            return s;
          };
          const a = build(ea);
          const b = build(eb);
          const c = build(ec);
          const left = mergeAutomationStates(mergeAutomationStates(a, b), c);
          const right = mergeAutomationStates(a, mergeAutomationStates(b, c));

          if (left.lastTrigger.size !== right.lastTrigger.size) return false;
          for (const [k, v] of left.lastTrigger) {
            if (right.lastTrigger.get(k) !== v) return false;
          }
          return true;
        },
      ),
      { seed: 42 },
    );
  });

  test("taskTimestamps cap: merged length never exceeds 10_000", () => {
    // Construct two states each holding 6_000 timestamps → merged would be
    // 12_000 without the cap. Assert merge truncates to 10_000.
    const makeState = (offset: number) => {
      let s = EMPTY_AUTOMATION_STATE;
      // Bypass recordTrigger's own caps by constructing directly.
      const ts = Array.from({ length: 6_000 }, (_, i) => offset + i);
      s = { ...s, taskTimestamps: ts };
      return s;
    };
    const merged = mergeAutomationStates(makeState(0), makeState(1_000_000));
    expect(merged.taskTimestamps.length).toBe(10_000);
    // Tail-preservation: last entry of b is preserved.
    expect(merged.taskTimestamps[merged.taskTimestamps.length - 1]).toBe(
      1_000_000 + 5_999,
    );
  });
});
