/**
 * Behavioral parity between the flat (yamlRunner) and chained (chainedRunner)
 * recipe execution paths — Issue #850.
 *
 * The two runners forked long ago and drift in observable behavior is the
 * single most recurring defect class in the recipe subsystem (budget only on
 * one path, env-allowlist only on one path, cancellation only on one path,
 * etc.). `dispatchRecipe.parity.test.ts` pins the *envelope shapes*; this file
 * pins *observable runtime behavior* by driving the SAME logical scenario
 * through `dispatchRecipe` for both a flat (`trigger.type: manual`) and a
 * chained (`trigger.type: chained`) recipe and asserting the same outcome.
 *
 * Where the two paths genuinely diverge today, the gap is recorded with
 * `it.fails(...)` — a test whose body is EXPECTED to throw. This is the xfail
 * convention for this repo:
 *   - It documents the gap as executable spec (not a prose TODO).
 *   - It is self-healing: the day the gap is closed, the body stops throwing,
 *     `it.fails` flips RED, and CI forces the marker's removal.
 *   - The set of `it.fails` markers here IS the M3/Phase-5 runner-unification
 *     backlog. `scripts/audit-parity-xfails.mjs` ratchets the count so no NEW
 *     divergence can be introduced silently.
 *
 * No real LLM calls: agent dispatch is stubbed (flat: `claudeFn`; chained:
 * `chainedDeps.executeAgent`) to return canned text + usage.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Isolate from the developer's real ~/.patchwork/config.json. Agent steps read
// it via a static import; without this the flat runner routes agent dispatch to
// the dev's configured driver (a real `claude -p` subprocess) and the injected
// `claudeFn` test seam is never consulted. Holding config to {} makes the
// default agent path use claudeFn (mirrors yamlRunner.test.ts).
vi.mock("../../patchworkConfig.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../patchworkConfig.js")
  >("../../patchworkConfig.js");
  return { ...actual, loadConfig: vi.fn(() => ({})) };
});

// Stub the provider-driver factory so any API-driver path is deterministic and
// never spawns a process (parity with yamlRunner.test.ts).
const mockProviderRun = vi.fn();
vi.mock("../../drivers/index.js", () => ({
  createDriver: vi.fn(() => ({ name: "stub", run: mockProviderRun })),
}));

import type { ExecutionDeps } from "../chainedRunner.js";
import {
  dispatchRecipe,
  type RunnerDeps,
  type RunResult,
  type YamlRecipe,
} from "../yamlRunner.js";

const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), "behavioral-parity-"));
const TMP = tmpLogDir;

afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
});

function baseDeps(): RunnerDeps {
  return {
    now: () => new Date("2026-06-22T12:00:00Z"),
    logDir: tmpLogDir,
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

const HAIKU = "claude-haiku-4-5-20251001";

/** A flat recipe with N agent steps, each writing into out{i}. */
function flatAgentRecipe(
  steps: Array<Record<string, unknown>>,
  overrides: Partial<YamlRecipe> = {},
): YamlRecipe {
  return {
    name: "flat-parity",
    trigger: { type: "manual" },
    steps: steps as never,
    ...overrides,
  } as YamlRecipe;
}

/** A chained recipe with the matching steps (id + linear awaits chain). */
function chainedAgentRecipe(
  steps: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): YamlRecipe {
  return {
    name: "chained-parity",
    trigger: { type: "chained" },
    steps: steps as never,
    ...overrides,
  } as unknown as YamlRecipe;
}

/** Linear chained steps a→b→c… from agent prompt specs. */
function linearChainedSteps(
  specs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return specs.map((spec, i) => ({
    id: `s${i}`,
    awaits: i === 0 ? undefined : [`s${i - 1}`],
    ...spec,
  }));
}

/** Stub flat agent driver returning fixed text + usage, counting calls. */
function flatAgentDeps(usage: { inputTokens: number; outputTokens: number }) {
  let calls = 0;
  return {
    deps: {
      ...baseDeps(),
      claudeFn: async () => {
        calls++;
        return { text: `out ${calls}`, usage };
      },
    } as RunnerDeps,
    calls: () => calls,
  };
}

/** Stub chained agent driver returning fixed text + usage, counting calls. */
function chainedAgentDeps(usage: {
  inputTokens: number;
  outputTokens: number;
}) {
  let calls = 0;
  const executeAgent = vi.fn(async () => {
    calls++;
    return { text: `out ${calls}`, usage };
  });
  return {
    deps: {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    } as ExecutionDeps,
    calls: () => calls,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Budget halt on tokensMax — PARITY (both runners enforce)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: budget halt on tokensMax", () => {
  it("flat runner halts the 2nd agent step once tokensMax is breached", async () => {
    const { deps, calls } = flatAgentDeps({
      inputTokens: 60,
      outputTokens: 60,
    });
    const recipe = flatAgentRecipe(
      [
        { agent: { prompt: "a", model: HAIKU, into: "o0" } },
        { agent: { prompt: "b", model: HAIKU, into: "o1" } },
      ],
      { budget: { tokensMax: 100 } } as Partial<YamlRecipe>,
    );
    const result = (await dispatchRecipe(recipe, deps)) as RunResult;
    expect(calls()).toBe(1); // 2nd admission refused (120 > 100)
    expect(result.stepResults[1]?.status).toBe("error");
    expect(result.stepResults[1]?.haltReason).toMatch(/budget_exceeded/);
  });

  it("chained runner halts the 2nd agent step once tokensMax is breached", async () => {
    const { deps, calls } = chainedAgentDeps({
      inputTokens: 60,
      outputTokens: 60,
    });
    const recipe = chainedAgentRecipe(
      linearChainedSteps([
        { agent: { prompt: "a" } },
        { agent: { prompt: "b" } },
      ]),
      { budget: { tokensMax: 100 } },
    );
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    if ("success" in result) {
      expect(calls()).toBe(1);
      expect(result.success).toBe(false);
      expect(result.stepResults.get("s1")?.error?.message).toMatch(
        /budget_exceeded/,
      );
    } else {
      throw new Error("expected chained result");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Budget halt on usdMax via price table — PARITY
// ─────────────────────────────────────────────────────────────────────────
describe("parity: budget halt on usdMax (price table)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pw-parity-usdmax-"));
  const fixture = path.join(dir, "prices.json");
  writeFileSync(
    fixture,
    JSON.stringify({ prices: { "test-haiku": { input: 1, output: 5 } } }),
  );
  // test-haiku: $1/1M in + $5/1M out → 1M+1M = $6, over the $5 cap on call 1.
  const HEAVY = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

  function withPriceTable<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.PATCHWORK_PRICE_TABLE;
    process.env.PATCHWORK_PRICE_TABLE = fixture;
    return fn().finally(() => {
      if (prev === undefined) delete process.env.PATCHWORK_PRICE_TABLE;
      else process.env.PATCHWORK_PRICE_TABLE = prev;
    });
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("flat runner refuses the 2nd dispatch after usdMax breach", async () => {
    await withPriceTable(async () => {
      const { deps, calls } = flatAgentDeps(HEAVY);
      const recipe = flatAgentRecipe(
        [
          { agent: { prompt: "a", model: "test-haiku", into: "o0" } },
          { agent: { prompt: "b", model: "test-haiku", into: "o1" } },
        ],
        { budget: { usdMax: 5 } } as Partial<YamlRecipe>,
      );
      const result = (await dispatchRecipe(recipe, deps)) as RunResult;
      expect(calls()).toBe(1);
      expect(result.stepResults[1]?.haltCategory).toBe("budget_exceeded");
    });
  });

  // DIVERGENCE (xfail): chained usdMax is NOT enforced through dispatchRecipe.
  // dispatchRecipe builds chained RunOptions without a `priceTable` (and without
  // forwarding chainedOptions.budget), so the RunBudget chainedRunner derives
  // from recipe.budget cannot convert tokens→USD — every dispatch is admitted
  // and the USD cap is silently ignored. tokensMax works (no pricing needed);
  // usdMax does not. The flat runner (above) enforces it. Backlog: thread a
  // loaded priceTable into the chained dispatch options (M3/Phase 5).
  it("chained runner refuses the 2nd dispatch after usdMax breach", async () => {
    await withPriceTable(async () => {
      const { deps, calls } = chainedAgentDeps(HEAVY);
      const recipe = chainedAgentRecipe(
        linearChainedSteps([
          { agent: { prompt: "a", model: "test-haiku" } },
          { agent: { prompt: "b", model: "test-haiku" } },
        ]),
        { budget: { usdMax: 5 } },
      );
      const result = await dispatchRecipe(recipe, {
        ...baseDeps(),
        chainedDeps: deps,
      });
      if ("success" in result) {
        // Parity target: 2nd dispatch refused on USD breach.
        expect(calls()).toBe(1);
        expect(result.stepResults.get("s1")?.error?.message).toMatch(
          /budget_exceeded/,
        );
      } else {
        throw new Error("expected chained result");
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Retry clamp (negative retry → 0 extra attempts) — PARITY
// ─────────────────────────────────────────────────────────────────────────
describe("parity: negative retry is clamped to zero (no extra attempts)", () => {
  it("flat runner makes exactly one attempt when retry is negative", async () => {
    let calls = 0;
    const recipe = flatAgentRecipe(
      [{ agent: { prompt: "a", model: HAIKU, into: "o0" }, retry: -5 }],
      { on_error: { fallback: "abort" } } as Partial<YamlRecipe>,
    );
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      claudeFn: async () => {
        calls++;
        throw new Error("boom");
      },
    })) as RunResult;
    expect(calls).toBe(1); // -5 → max(0) → no retry
    expect(result.stepResults[0]?.status).toBe("error");
  });

  it("chained runner makes exactly one attempt when retry is negative", async () => {
    const executeAgent = vi.fn(async () => {
      throw new Error("boom");
    });
    const deps: ExecutionDeps = {
      executeTool: vi.fn(),
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe(
      linearChainedSteps([{ agent: { prompt: "a" }, retry: -5 }]),
    );
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    expect(executeAgent).toHaveBeenCalledTimes(1);
    if ("success" in result) expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. on_error: abort — PARITY (a fatal step aborts the run)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: on_error fallback=abort halts on a fatal step", () => {
  it("flat runner: fatal step sets errorMessage and stops", async () => {
    const recipe = flatAgentRecipe(
      [
        { tool: "file.read", path: `${TMP}/missing`, into: "data" },
        { tool: "file.write", path: `${TMP}/after`, content: "should-not-run" },
      ],
      { on_error: { fallback: "abort" } } as Partial<YamlRecipe>,
    );
    let wroteAfter = false;
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      readFile: () => {
        throw new Error("boom");
      },
      writeFile: () => {
        wroteAfter = true;
      },
    })) as RunResult;
    expect(typeof result.errorMessage).toBe("string");
    expect(result.stepResults[0]?.status).toBe("error");
    expect(wroteAfter).toBe(false); // aborted before the 2nd step
  });

  it("chained runner: fatal step yields success=false and failed>0", async () => {
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockRejectedValue(new Error("boom")),
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe(
      linearChainedSteps([{ tool: "t" }, { tool: "t" }]),
    );
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    if ("success" in result) {
      expect(result.success).toBe(false);
      expect(result.summary.failed).toBeGreaterThan(0);
    } else {
      throw new Error("expected chained result");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Env allowlist — PARITY (undeclared {{env.X}} resolves to empty)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: undeclared env keys never reach templates", () => {
  const UNDECLARED = "PATCHWORK_PARITY_ENV_LEAK";

  it("flat runner drops undeclared {{env.X}}", async () => {
    process.env[UNDECLARED] = "leak-me";
    try {
      let written = "";
      const recipe = flatAgentRecipe([
        {
          tool: "file.write",
          path: `${TMP}/leak`,
          content: `{{env.${UNDECLARED}}}`,
        },
      ]);
      await dispatchRecipe(recipe, {
        ...baseDeps(),
        writeFile: (_p: string, c: string) => {
          written = c;
        },
      });
      expect(written).toBe("");
    } finally {
      delete process.env[UNDECLARED];
    }
  });

  it("chained runner drops undeclared {{env.X}}", async () => {
    process.env[UNDECLARED] = "leak-me";
    try {
      let resolved: Record<string, unknown> | undefined;
      const deps: ExecutionDeps = {
        executeTool: vi.fn(async (_t: string, r: unknown) => {
          resolved = r as Record<string, unknown>;
          return "ok";
        }),
        executeAgent: vi.fn(),
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
      };
      const recipe = chainedAgentRecipe([
        { id: "s0", tool: "t", leaked: `{{env.${UNDECLARED}}}` },
      ]);
      await dispatchRecipe(recipe, { ...baseDeps(), chainedDeps: deps });
      expect(resolved?.leaked).toBe("");
    } finally {
      delete process.env[UNDECLARED];
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Output capture — PARITY (a later step can read an earlier step's output)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: step output is captured and referenceable downstream", () => {
  it("flat runner: {{key}} resolves a prior step's into-value", async () => {
    let seen = "";
    const recipe = flatAgentRecipe([
      { agent: { prompt: "a", model: HAIKU, into: "captured" } },
      { tool: "file.write", path: `${TMP}/dl`, content: "{{captured}}" },
    ]);
    await dispatchRecipe(recipe, {
      ...baseDeps(),
      claudeFn: async () => ({
        text: "PAYLOAD",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      writeFile: (_p: string, c: string) => {
        seen = c;
      },
    });
    expect(seen).toBe("PAYLOAD");
  });

  it("chained runner: {{steps.<id>.data}} resolves a prior step's output", async () => {
    let seen: unknown;
    const deps: ExecutionDeps = {
      executeTool: vi.fn(async (_t: string, r: unknown) => {
        seen = (r as Record<string, unknown>).content;
        return "ok";
      }),
      executeAgent: vi.fn(async () => ({
        text: "PAYLOAD",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe([
      { id: "s0", agent: { prompt: "a" } },
      {
        id: "s1",
        awaits: ["s0"],
        tool: "file.write",
        content: "{{steps.s0.data}}",
      },
    ]);
    await dispatchRecipe(recipe, { ...baseDeps(), chainedDeps: deps });
    expect(String(seen)).toContain("PAYLOAD");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Approval gate halts a step on rejection — PARITY (Tier-1 #4, audit 2026-06-22)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: approval gate halts a step when requireApprovalFn rejects", () => {
  it("flat runner halts the step when requireApprovalFn returns false", async () => {
    let calls = 0;
    const recipe = flatAgentRecipe([
      { agent: { prompt: "a", model: HAIKU, into: "o0" } },
    ]);
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      claudeFn: async () => {
        calls++;
        return { text: "x", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      requireApprovalFn: async () => false,
    })) as RunResult;
    expect(calls).toBe(0); // dispatch refused before the agent runs
    expect(result.stepResults[0]?.haltCategory).toBe("approval_rejected");
  });

  it("chained runner halts the step when requireApprovalFn returns false", async () => {
    const executeAgent = vi.fn(async () => ({
      text: "x",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const deps: ExecutionDeps = {
      executeTool: vi.fn(),
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
      requireApprovalFn: async () => false,
    };
    const recipe = chainedAgentRecipe(
      linearChainedSteps([{ agent: { prompt: "a" } }]),
    );
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    expect(executeAgent).not.toHaveBeenCalled();
    if ("success" in result) {
      expect(result.success).toBe(false);
      expect(result.stepResults.get("s0")?.error?.message).toMatch(
        /approval_rejected/,
      );
    } else {
      throw new Error("expected chained result");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Declared env secrets redacted from the LLM prompt — PARITY (Tier-1 #5)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: declared env secrets are redacted from the agent prompt", () => {
  const SECRET_KEY = "PARITY_REDACT_SECRET";

  it("flat runner redacts a declared env secret from the agent prompt", async () => {
    process.env[SECRET_KEY] = "s3cr3t-flat";
    try {
      let seenPrompt = "";
      // The flat runner exposes declared env as a bare `{{KEY}}` ctx key (the
      // `env.` prefix is the chained-runner convention); redaction replaces the
      // bare key's value with [REDACTED].
      const recipe = flatAgentRecipe(
        [
          {
            agent: {
              prompt: `key={{${SECRET_KEY}}}`,
              model: HAIKU,
              into: "o0",
            },
          },
        ],
        {
          context: [{ type: "env", keys: [SECRET_KEY] }],
        } as unknown as Partial<YamlRecipe>,
      );
      await dispatchRecipe(recipe, {
        ...baseDeps(),
        claudeFn: async (p: string) => {
          seenPrompt = p;
          return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      });
      expect(seenPrompt).toContain("[REDACTED]");
      expect(seenPrompt).not.toContain("s3cr3t-flat");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("chained runner redacts a declared env secret from the agent prompt", async () => {
    process.env[SECRET_KEY] = "s3cr3t-chained";
    try {
      let seenPrompt = "";
      const executeAgent = vi.fn(async (p: string) => {
        seenPrompt = p;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
      });
      const deps: ExecutionDeps = {
        executeTool: vi.fn(),
        executeAgent,
        loadNestedRecipe: vi.fn().mockResolvedValue(null),
      };
      const recipe = chainedAgentRecipe(
        linearChainedSteps([
          { agent: { prompt: `key={{env.${SECRET_KEY}}}` } },
        ]),
        { context: [{ type: "env", keys: [SECRET_KEY] }] },
      );
      await dispatchRecipe(recipe, { ...baseDeps(), chainedDeps: deps });
      expect(seenPrompt).toContain("[REDACTED]");
      expect(seenPrompt).not.toContain("s3cr3t-chained");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. Budget admission gates a TOOL step (not just agent) — PARITY (Tier-1 #6)
// ─────────────────────────────────────────────────────────────────────────
describe("parity: budget admission gates a tool step after a breach", () => {
  it("flat runner refuses a tool step after a prior agent step breaches tokensMax", async () => {
    let wrote = false;
    const recipe = flatAgentRecipe(
      [
        { agent: { prompt: "a", model: HAIKU, into: "o0" } },
        { tool: "file.write", path: `${TMP}/budget-tool`, content: "x" },
      ],
      { budget: { tokensMax: 100 } } as Partial<YamlRecipe>,
    );
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      claudeFn: async () => ({
        text: "x",
        usage: { inputTokens: 60, outputTokens: 60 },
      }),
      writeFile: () => {
        wrote = true;
      },
    })) as RunResult;
    expect(wrote).toBe(false); // tool step refused on budget breach
    expect(result.stepResults[1]?.haltCategory).toBe("budget_exceeded");
  });

  it("chained runner refuses a tool step after a prior agent step breaches tokensMax", async () => {
    const executeTool = vi.fn().mockResolvedValue("ok");
    const executeAgent = vi.fn(async () => ({
      text: "x",
      usage: { inputTokens: 60, outputTokens: 60 },
    }));
    const deps: ExecutionDeps = {
      executeTool,
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe(
      linearChainedSteps([{ agent: { prompt: "a" } }, { tool: "t" }]),
      { budget: { tokensMax: 100 } },
    );
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    expect(executeTool).not.toHaveBeenCalled(); // gated before dispatch
    if ("success" in result) {
      expect(result.stepResults.get("s1")?.error?.message).toMatch(
        /budget_exceeded/,
      );
    } else {
      throw new Error("expected chained result");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// DOCUMENTED DIVERGENCES (xfail) — the M3 / Phase-5 runner-unification backlog.
// Each `it.fails` body is EXPECTED to throw today. When the gap is closed the
// body stops throwing → `it.fails` turns RED → CI forces the marker's removal.
// `scripts/audit-parity-xfails.mjs` forbids ADDING new ones.
// ═════════════════════════════════════════════════════════════════════════
describe("parity: when:false skips the step on both runners", () => {
  it("flat runner skips a step whose when is false", async () => {
    let ran = false;
    const recipe = flatAgentRecipe([
      {
        tool: "file.write",
        path: `${TMP}/when-f`,
        content: "x",
        when: "false",
      },
    ]);
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      writeFile: () => {
        ran = true;
      },
    })) as RunResult;
    expect(ran).toBe(false);
    expect(result.stepResults[0]?.status).toBe("skipped");
  });

  it("chained runner skips a step whose when is false", async () => {
    const executeTool = vi.fn().mockResolvedValue("ok");
    const deps: ExecutionDeps = {
      executeTool,
      executeAgent: vi.fn(),
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe([
      { id: "s0", tool: "file.write", content: "x", when: "false" },
    ]);
    const result = await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
    });
    expect(executeTool).not.toHaveBeenCalled();
    if ("summary" in result) expect(result.summary.skipped).toBeGreaterThan(0);
  });
});

describe("DIVERGENCE (xfail): AbortSignal is not threaded through dispatchRecipe", () => {
  // dispatchRecipe builds chained RunOptions WITHOUT forwarding
  // chainedOptions.signal (yamlRunner.ts dispatchRecipe), and the flat runner
  // has no signal plumbing at all. A pre-aborted run therefore still executes
  // every step on BOTH paths. Backlog: thread signal through dispatch + wire
  // cancellation into the flat runner (M3/Phase 5).
  it("chained run is cancelled when chainedOptions.signal is pre-aborted", async () => {
    const ctl = new AbortController();
    ctl.abort("cancelled");
    const executeAgent = vi.fn(async () => ({
      text: "ran",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const deps: ExecutionDeps = {
      executeTool: vi.fn().mockResolvedValue("ok"),
      executeAgent,
      loadNestedRecipe: vi.fn().mockResolvedValue(null),
    };
    const recipe = chainedAgentRecipe(
      linearChainedSteps([{ agent: { prompt: "a" } }]),
    );
    await dispatchRecipe(recipe, {
      ...baseDeps(),
      chainedDeps: deps,
      chainedOptions: { signal: ctl.signal },
    });
    // Parity target: a pre-aborted signal prevents dispatch.
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it.fails("flat run is cancelled when caller requests abort (NOT YET — flat has no signal)", async () => {
    // The flat runner exposes no signal seam, so there is no way to stop a
    // run mid-flight. This marker documents that gap for M3.
    let calls = 0;
    const recipe = flatAgentRecipe([
      { agent: { prompt: "a", model: HAIKU, into: "o0" } },
      { agent: { prompt: "b", model: HAIKU, into: "o1" } },
    ]);
    const result = (await dispatchRecipe(recipe, {
      ...baseDeps(),
      claudeFn: async () => {
        calls++;
        return { text: "x", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    })) as RunResult;
    // Parity target: a cancellation seam would let us stop after step 1.
    // Today there is none, so both steps run.
    expect(calls).toBe(1);
    expect(result.stepResults).toHaveLength(1);
  });
});
