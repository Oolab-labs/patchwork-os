/**
 * fan_out — dispatch a sub-tool step once per item in a collection.
 *
 * Agentic-workflow slice 1 (revised per cold-eyes review): lands as a tool
 * step rather than a first-class runner construct. Stays out of the step
 * loop so it composes automatically with existing budget admission, retry,
 * fallback, and silent-fail detection at the parent-step level.
 *
 * Scope:
 *   - `do.tool` (v1) and `do.agent` (v2a). Agent iterations do NOT call the
 *     model directly: the runner injects `runNestedAgent`, which owns budget
 *     admission, usage reconciliation and silent-fail detection, because
 *     `RunBudget` and the usage accumulator are closure locals of
 *     `runYamlRecipe` that a tool cannot reach. A loop the budget cannot see
 *     is the S1 finding (unenforced budget) reintroduced one level down.
 *   - Judge verdicts / refine loops / per-step routing inside an iteration are
 *     NOT implemented and are REJECTED by name rather than ignored.
 *   - serial execution (concurrency knob accepted but clamped to 1 in v1)
 *   - no per-iter `expect` (parent step can have an outer `expect` on the
 *     aggregate; per-iter assertion lands in v2)
 *
 * Output shape: JSON array `[{index, ok, output?, error?}, ...]` in
 * iteration order. `output` is the raw tool output string; `error` is
 * present only when `ok === false`.
 */

import { FLAG_CIRCUIT_BREAKER, isEnabled } from "../../featureFlags.js";
import { deriveBreakerKey, getCircuitBreaker } from "../circuitBreaker.js";
import { isReturnValueFailure } from "../idempotencyKey.js";
import { executeTool, hasTool, registerTool } from "../toolRegistry.js";
import type { RunContext } from "../yamlRunner.js";

/** Coerce `items` param into an array. Accepts an array directly, or a JSON-array string. */
function coerceItems(raw: unknown): unknown[] | { error: string } {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      return {
        error: `items: parsed JSON is not an array (got ${typeof parsed})`,
      };
    } catch (err) {
      return {
        error: `items: not a JSON array (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
  return {
    error: `items: expected array or JSON-array string, got ${typeof raw}`,
  };
}

interface IterResult {
  index: number;
  ok: boolean;
  output?: string;
  error?: string;
}

registerTool({
  id: "fan_out",
  namespace: "fan_out",
  description:
    "Run a sub-step (`do:`) once per item in `items`. `do.tool` runs a tool; `do.agent` runs one agent call per item (budget-admitted and usage-reconciled by the runner). Aggregates per-iter results into a JSON array under `into`. Serial execution.",
  paramsSchema: {
    type: "object",
    properties: {
      items: {
        description:
          "Array of items to iterate over, or a JSON-array string (e.g. `{{steps.fetch.rows}}`).",
      },
      as: {
        type: "string",
        description:
          "Loop variable name. Default `item`. Also exposes `<as>_index` and `<as>_total`.",
        default: "item",
      },
      do: {
        type: "object",
        description:
          "Inner sub-step, one of two shapes. TOOL: `{tool: <id>, ...params}`. AGENT: `{agent: {prompt, driver?, model?}}` — one agent call per item. ONLY those three keys are honoured; any other agent option (sandbox, tools, mcpAccess, kind, reviews, downshift, …) is rejected rather than ignored, because silently dropping `sandbox` would be a false safety signal. Agent sub-steps require the flat recipe runner. `{{<as>.*}}` placeholders are rendered per iteration.",
      },
      concurrency: {
        type: "number",
        description:
          "Parallel iterations. Clamped to 1 (serial) — accepted so recipes don't break when it lands.",
        default: 1,
      },
      max_iterations: {
        type: "number",
        description:
          "Safety cap. Halts with `max_iterations exceeded` if array longer.",
        default: 100,
      },
      on_iter_error: {
        type: "string",
        enum: ["continue", "halt"],
        description:
          "What to do when a single iteration fails. `continue` (default) records the error in the aggregate and proceeds; `halt` stops fan_out and the step is marked error. Does NOT apply to a budget refusal, which always halts.",
        default: "continue",
      },
    },
    required: ["items", "do"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        index: { type: "number" },
        ok: { type: "boolean" },
        output: { type: "string" },
        error: { type: "string" },
      },
      required: ["index", "ok"],
    },
  },
  riskDefault: "low",
  isWrite: false,
  execute: async ({ params, ctx, deps }) => {
    const itemsResult = coerceItems(params.items);
    if (!Array.isArray(itemsResult)) {
      throw new Error(itemsResult.error);
    }
    const items = itemsResult;

    const maxIter =
      typeof params.max_iterations === "number" && params.max_iterations > 0
        ? Math.min(Math.floor(params.max_iterations), 1000)
        : 100;
    if (items.length > maxIter) {
      throw new Error(
        `fan_out: max_iterations exceeded (${items.length} > ${maxIter})`,
      );
    }

    const onIterError = params.on_iter_error === "halt" ? "halt" : "continue";

    const loopVar =
      typeof params.as === "string" && params.as.length > 0
        ? params.as
        : "item";

    const doStep = params.do;
    if (!doStep || typeof doStep !== "object") {
      throw new Error("fan_out: `do` must be an object with a `tool` field");
    }
    const doObj = doStep as Record<string, unknown>;
    const agentCfg =
      doObj.agent &&
      typeof doObj.agent === "object" &&
      !Array.isArray(doObj.agent)
        ? (doObj.agent as Record<string, unknown>)
        : undefined;
    const innerToolId = doObj.tool;
    // Narrowed inside the branches below: `innerToolId` is `unknown` here and
    // only the tool path validates it to a non-empty string.
    let toolId: string;

    if (agentCfg) {
      if (typeof innerToolId === "string" && innerToolId.length > 0) {
        throw new Error(
          "fan_out: `do` sets both `agent` and `tool` — an iteration runs one or the other",
        );
      }
      if (typeof agentCfg.prompt !== "string" || !agentCfg.prompt.trim()) {
        throw new Error("fan_out: `do.agent.prompt` is required");
      }
      if (!deps.runNestedAgent) {
        // No executor injected ⇒ no budget admission and no usage
        // reconciliation available. Refuse rather than run un-budgeted: an
        // agent loop that the run budget cannot see is precisely the failure
        // the seam exists to prevent.
        throw new Error(
          "fan_out: agent sub-steps require the flat recipe runner (no agent executor is wired here)",
        );
      }
      // ALLOWLIST, not a denylist. The first version enumerated the options
      // to reject and missed `sandbox`, `tools`, `disallowedTools` and
      // `mcpAccess` — the dangerous ones, because an author writing
      // `sandbox: true` would believe the iteration is sandboxed while it
      // silently was not. That is a false safety signal, not merely a dropped
      // option. An allowlist also survives new keys being added to the agent
      // block: an option this loop has never heard of is refused by default
      // instead of being quietly ignored.
      const HONOURED = new Set(["prompt", "driver", "model"]);
      const unsupported = Object.keys(agentCfg).filter((k) => !HONOURED.has(k));
      if (unsupported.length > 0) {
        throw new Error(
          `fan_out: \`do.agent.${unsupported.join("`, `do.agent.")}\` is not supported inside an iteration ` +
            "— only `prompt`, `driver` and `model` are honoured. Judge verdicts, refine loops, " +
            "per-step routing and tool sandboxes are step-level features: move the agent to its " +
            "own step, or drop the option.",
        );
      }
      toolId = "";
    } else {
      if (typeof innerToolId !== "string" || innerToolId.length === 0) {
        throw new Error(
          "fan_out: `do.tool` is required and must be a string (or use `do.agent`)",
        );
      }
      if (!hasTool(innerToolId)) {
        throw new Error(`fan_out: unknown inner tool "${innerToolId}"`);
      }
      if (innerToolId === "fan_out") {
        throw new Error("fan_out: nested fan_out is not supported in v1");
      }
      toolId = innerToolId;
    }

    const aggregate: IterResult[] = [];

    /**
     * Say an iteration finished.
     *
     * Called from EVERY path that appends to `aggregate` — success, agent
     * failure, circuit-breaker short-circuit, tool error. Reporting only the
     * happy path would be worse than reporting nothing: the run would appear
     * to stall at the first failure while it was in fact still working.
     */
    const report = (index: number, ok: boolean, error?: string): void => {
      deps.onIterationProgress?.({
        index,
        total: items.length,
        ok,
        ...(error ? { error } : {}),
      });
    };

    // Hoist the lazy import outside the loop — dynamic imports cache the
    // module after the first load so correctness is unaffected, but resolving
    // the same promise on every iteration adds async overhead for each item.
    const { render } = await import("../yamlRunner.js");

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Build per-iter ctx clone. Bind the loop variable as the raw item
      // (objects get JSON-stringified by `render`'s value coercion at use
      // sites; dot-notation `{{row.id}}` works because render JSON-parses
      // string intermediates).
      const iterCtx: RunContext = { ...ctx };
      iterCtx[loopVar] = typeof item === "string" ? item : JSON.stringify(item);
      iterCtx[`${loopVar}_index`] = String(i);
      iterCtx[`${loopVar}_total`] = String(items.length);

      // Agent iteration: render the prompt against this item's context and
      // run it through the injected executor, which owns budget admission and
      // usage reconciliation. Checked before the tool path so the breaker /
      // executeTool machinery below stays tool-only.
      if (agentCfg) {
        const prompt = render(String(agentCfg.prompt), iterCtx);
        // biome-ignore lint/style/noNonNullAssertion: presence validated above
        const res = await deps.runNestedAgent!({
          prompt,
          ...(typeof agentCfg.driver === "string" && {
            driver: agentCfg.driver,
          }),
          ...(typeof agentCfg.model === "string" && { model: agentCfg.model }),
        });
        aggregate.push(
          res.ok
            ? { index: i, ok: true, output: res.text }
            : { index: i, ok: false, error: res.error ?? "agent failed" },
        );
        report(i, res.ok, res.ok ? undefined : (res.error ?? "agent failed"));
        // A budget refusal is NOT an ordinary iteration failure:
        // `on_iter_error: continue` must not carry the loop past a cap that
        // just said stop. Halt regardless of the setting, keeping the
        // partial aggregate so the caller sees what did run.
        if (res.budgetHalt) {
          throw new Error(
            `fan_out: halted at iter ${i} — ${res.error ?? "budget_exceeded"}`,
          );
        }
        if (!res.ok && onIterError === "halt") {
          throw new Error(
            `fan_out: iter ${i} failed (on_iter_error=halt): ${res.error}`,
          );
        }
        continue;
      }

      const innerParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(doObj)) {
        if (k === "tool") continue;
        innerParams[k] = deepRenderForIter(v, iterCtx, render);
      }

      // Circuit breaker — fan_out calls executeTool DIRECTLY, bypassing
      // executeStep's own breaker check/record (that logic lives in the
      // step loop, not in executeTool). Without this, a fan_out whose
      // inner tool is broken would hammer it once per item with zero
      // protection, defeating the whole point of the breaker for exactly
      // the workload (many repeated calls to the same tool) it matters
      // most for. Mirrors executeStep's gating: only when deps.recipeName
      // is known and FLAG_CIRCUIT_BREAKER is on.
      const breakerKey =
        !agentCfg && deps.recipeName && isEnabled(FLAG_CIRCUIT_BREAKER)
          ? deriveBreakerKey(deps.recipeName, toolId)
          : null;
      if (breakerKey && getCircuitBreaker().isOpen(breakerKey)) {
        const msg = `circuit_open: "${toolId}" has failed repeatedly for recipe "${deps.recipeName}" — short-circuiting until the cooldown elapses.`;
        aggregate.push({ index: i, ok: false, error: msg });
        report(i, false, msg);
        if (onIterError === "halt") {
          throw new Error(
            `fan_out: iter ${i} failed (on_iter_error=halt): ${msg}`,
          );
        }
        continue;
      }

      try {
        const output = await executeTool(toolId, {
          params: innerParams,
          step: doObj,
          ctx: iterCtx,
          deps,
        });
        if (breakerKey) {
          if (isReturnValueFailure(output)) {
            getCircuitBreaker().recordFailure(breakerKey);
          } else {
            getCircuitBreaker().recordSuccess(breakerKey);
          }
        }
        aggregate.push({
          index: i,
          ok: true,
          ...(output != null && { output }),
        });
        report(i, true);
      } catch (err) {
        if (breakerKey) getCircuitBreaker().recordFailure(breakerKey);
        const msg = err instanceof Error ? err.message : String(err);
        aggregate.push({ index: i, ok: false, error: msg });
        report(i, false, msg);
        if (onIterError === "halt") {
          throw new Error(
            `fan_out: iter ${i} failed (on_iter_error=halt): ${msg}`,
          );
        }
      }
    }

    return JSON.stringify(aggregate);
  },
});

/**
 * Per-iter deep render. Mirrors `deepRender` in yamlRunner but takes the
 * render fn as a parameter to keep the import dynamic (avoids the circular
 * import between yamlRunner ↔ tool registry).
 */
function deepRenderForIter(
  value: unknown,
  ctx: RunContext,
  render: (template: string, ctx: RunContext) => string,
): unknown {
  if (typeof value === "string") return render(value, ctx);
  if (Array.isArray(value)) {
    return value.map((v) => deepRenderForIter(v, ctx, render));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRenderForIter(v, ctx, render);
    }
    return out;
  }
  return value;
}
