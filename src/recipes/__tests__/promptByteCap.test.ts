/**
 * Gap 7 — the prompt byte cap at the `executeAgent` seam.
 *
 * The invariant under test:
 *
 *   Every model-facing request crosses ONE byte-limit decision after the final
 *   prompt is composed and before any transport receives it. No transport
 *   implements its own cap.
 *
 * Three properties this file exists to pin, none of which an error-string
 * assertion can see:
 *
 *   1. On breach there is NO MODEL CALL. Every test counts dep invocations and
 *      asserts zero. A refusal that still dispatched would satisfy a message
 *      assertion and fail the actual requirement.
 *   2. The budget is the AUTHOR's. Mandatory governance text is reserved
 *      separately, so switching compat -> governed must not reduce how much
 *      prompt an author may send (the governed instruction is 550 bytes against
 *      compat's 257; charging it to the author would silently shrink the budget
 *      of every recipe on the machine the day the profile flips).
 *   3. Bytes, not JavaScript string length. A four-byte codepoint counts four.
 *
 * Every describe block carries a positive control that DOES dispatch, so a seam
 * that refused everything — or one that never ran at all — cannot pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveProfileForTesting,
  resolveProfile,
  setActiveProfile,
} from "../../governance/profile.js";
import {
  type AgentExecutorDeps,
  executeAgent,
  MAX_AGENT_PROMPT_BYTES,
} from "../agentExecutor.js";
import {
  categoriseHaltReason,
  HALT_CATEGORY_HINTS,
  HALT_CATEGORY_LABELS,
} from "../haltCategory.js";

function makeDeps(
  overrides: Partial<AgentExecutorDeps> = {},
): AgentExecutorDeps {
  return {
    anthropicFn: vi.fn().mockResolvedValue({ text: "anthropic-result" }),
    providerDriverFn: vi
      .fn()
      .mockImplementation((driver: string) =>
        Promise.resolve({ text: `${driver}-result` }),
      ),
    claudeCliFn: vi.fn().mockResolvedValue({ text: "claude-cli-result" }),
    localFn: vi.fn().mockResolvedValue({ text: "local-result" }),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

const governed = () =>
  setActiveProfile(resolveProfile({ profile: "governed" }));
const compat = () => setActiveProfile(resolveProfile({ profile: "compat" }));

/** A prompt of exactly `bytes` UTF-8 bytes, built from ASCII. */
const ascii = (bytes: number) => "a".repeat(bytes);
/** A prompt of exactly `bytes` UTF-8 bytes, built from 4-byte codepoints. */
const fourByte = (bytes: number) => "\u{1F600}".repeat(bytes / 4);

const noDispatch = (deps: AgentExecutorDeps) => {
  expect(deps.anthropicFn).not.toHaveBeenCalled();
  expect(deps.providerDriverFn).not.toHaveBeenCalled();
  expect(deps.claudeCliFn).not.toHaveBeenCalled();
  expect(deps.localFn).not.toHaveBeenCalled();
};

beforeEach(() => _resetActiveProfileForTesting());

// ── the cap itself ───────────────────────────────────────────────────────────

describe("the cap is 96 KiB of author prompt", () => {
  it("is 98304 bytes", () => {
    expect(MAX_AGENT_PROMPT_BYTES).toBe(98_304);
  });
});

// ── T1 / T2: refusal does not dispatch, and the control does ─────────────────

describe("subprocess", () => {
  beforeEach(compat);

  // T1
  it("over the cap: refuses without calling the CLI", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "subprocess", prompt: ascii(MAX_AGENT_PROMPT_BYTES + 1) },
      deps,
    );
    noDispatch(deps);
    expect(result.text).toMatch(/^\[agent step failed: prompt_too_large/);
  });

  // T2 — positive control. Without this, T1 passes against a seam that
  // refuses unconditionally, or one that was never reached.
  it("at the cap exactly: dispatches", async () => {
    const deps = makeDeps();
    const result = await executeAgent(
      { driver: "subprocess", prompt: ascii(MAX_AGENT_PROMPT_BYTES) },
      deps,
    );
    expect(deps.claudeCliFn).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("claude-cli-result");
  });
});

// ── T3: bytes, not characters ────────────────────────────────────────────────

describe("measured in UTF-8 bytes", () => {
  beforeEach(compat);

  it("refuses a prompt whose CHARACTER count is well under the cap", async () => {
    const deps = makeDeps();
    // (cap/4)+1 emoji => cap+4 bytes, but only ~24.5k JS characters. A
    // `.length` check would admit this.
    const prompt = fourByte(MAX_AGENT_PROMPT_BYTES + 4);
    expect(prompt.length).toBeLessThan(MAX_AGENT_PROMPT_BYTES);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(
      MAX_AGENT_PROMPT_BYTES,
    );
    await executeAgent({ driver: "subprocess", prompt }, deps);
    noDispatch(deps);
  });

  it("admits the same character count in ASCII", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "subprocess", prompt: ascii(MAX_AGENT_PROMPT_BYTES / 4) },
      deps,
    );
    expect(deps.claudeCliFn).toHaveBeenCalledTimes(1);
  });
});

// ── T4: every transport, not just the argv-bound one ─────────────────────────

describe("every transport inherits the cap", () => {
  beforeEach(compat);

  const cases = [
    ["anthropic", "anthropicFn"],
    ["openai", "providerDriverFn"],
    ["local", "localFn"],
    ["subprocess", "claudeCliFn"],
  ] as const;

  for (const [driver, fn] of cases) {
    it(`${driver}: over the cap refuses without dispatching`, async () => {
      const deps = makeDeps();
      const result = await executeAgent(
        { driver, prompt: ascii(MAX_AGENT_PROMPT_BYTES + 1) },
        deps,
      );
      noDispatch(deps);
      expect(result.text).toMatch(/prompt_too_large/);
    });

    it(`${driver}: under the cap dispatches (control)`, async () => {
      const deps = makeDeps();
      await executeAgent({ driver, prompt: "hello" }, deps);
      expect(deps[fn]).toHaveBeenCalledTimes(1);
    });
  }
});

// ── T5: the author's budget does not shrink under `governed` ─────────────────

describe("mandatory governance text is reserved, not charged to the author", () => {
  // The governed instruction is 550 bytes against compat's 257. If the cap
  // measured the composed prompt, a recipe sitting within 293 bytes of the
  // limit would start failing the day the profile flipped — a policy change
  // silently rewriting what recipes are allowed to say.
  it("a prompt at the cap dispatches under BOTH profiles", async () => {
    const atCap = ascii(MAX_AGENT_PROMPT_BYTES);

    compat();
    const c = makeDeps();
    await executeAgent({ driver: "subprocess", prompt: atCap }, c);
    expect(c.claudeCliFn).toHaveBeenCalledTimes(1);

    _resetActiveProfileForTesting();
    governed();
    const g = makeDeps();
    await executeAgent({ driver: "subprocess", prompt: atCap }, g);
    expect(g.claudeCliFn).toHaveBeenCalledTimes(1);
  });

  it("refuses at the same byte figure under BOTH profiles", async () => {
    const overCap = ascii(MAX_AGENT_PROMPT_BYTES + 1);

    compat();
    const c = makeDeps();
    await executeAgent({ driver: "subprocess", prompt: overCap }, c);
    noDispatch(c);

    _resetActiveProfileForTesting();
    governed();
    const g = makeDeps();
    await executeAgent({ driver: "subprocess", prompt: overCap }, g);
    noDispatch(g);
  });
});

// ── T6 / T12: the halt reason ────────────────────────────────────────────────

describe("the halt reason", () => {
  beforeEach(compat);

  const reasonFor = async (bytes: number) => {
    const deps = makeDeps();
    const r = await executeAgent(
      { driver: "subprocess", prompt: ascii(bytes) },
      deps,
    );
    return r.text;
  };

  // T6 — and it must not be swallowed by the generic `agent ... threw` matcher.
  it("categorises as prompt_too_large", async () => {
    const reason = await reasonFor(MAX_AGENT_PROMPT_BYTES + 1);
    expect(categoriseHaltReason(reason)).toBe("prompt_too_large");
  });

  // T12 — `stepObservation` truncates the matched fragment at 120 characters,
  // which once amputated the actionable half of the LOCAL_ONLY message. Both
  // byte figures must survive that cut.
  it("carries both byte figures within the first 120 characters", async () => {
    const reason = (await reasonFor(MAX_AGENT_PROMPT_BYTES + 3538)).slice(
      0,
      120,
    );
    expect(reason).toContain(String(MAX_AGENT_PROMPT_BYTES + 3538));
    expect(reason).toContain(String(MAX_AGENT_PROMPT_BYTES));
  });

  it("never contains the prompt itself", async () => {
    const deps = makeDeps();
    const secretish = `SENTINEL${"b".repeat(MAX_AGENT_PROMPT_BYTES)}`;
    const r = await executeAgent(
      { driver: "subprocess", prompt: secretish },
      deps,
    );
    expect(r.text).not.toContain("SENTINEL");
    expect(r.text.length).toBeLessThan(400);
  });
});

// ── T11: compat is structural, not careful ───────────────────────────────────

describe("under the cap, the transport call shape is unchanged", () => {
  beforeEach(compat);

  it("passes no extra argument", async () => {
    const deps = makeDeps();
    await executeAgent(
      { driver: "anthropic", prompt: "hello", model: "claude-haiku" },
      deps,
    );
    expect(deps.anthropicFn).toHaveBeenCalledWith("hello", "claude-haiku");
  });
});

// ── the category is a first-class member, not a string in one matcher ────────

describe("prompt_too_large is a real halt category", () => {
  // Both maps are `Record<HaltCategory, string>`, so a missing entry is a
  // compile error here — but the DASHBOARD keeps its own union and compiles
  // separately, and `haltCategoryContract.test.ts` is what catches that drift
  // as text. This test only pins that the bridge half exists and is worded.
  it("has a label and a fix hint", () => {
    expect(HALT_CATEGORY_LABELS.prompt_too_large).toBeTruthy();
    expect(HALT_CATEGORY_HINTS.prompt_too_large).toBeTruthy();
  });
});
