/**
 * fan_out — dispatch a sub-tool step once per item in a collection.
 *
 * Agentic-workflow slice 1 (revised per cold-eyes review): lands as a tool
 * step rather than a first-class runner construct. Stays out of the step
 * loop so it composes automatically with existing budget admission, retry,
 * fallback, and silent-fail detection at the parent-step level.
 *
 * v1 scope:
 *   - tool-typed `do` only (no agent fan-out — defer to v2, needs per-iter
 *     budget + judge + silent-fail handling)
 *   - serial execution (concurrency knob accepted but clamped to 1 in v1)
 *   - no per-iter `expect` (parent step can have an outer `expect` on the
 *     aggregate; per-iter assertion lands in v2)
 *
 * Output shape: JSON array `[{index, ok, output?, error?}, ...]` in
 * iteration order. `output` is the raw tool output string; `error` is
 * present only when `ok === false`.
 */

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
    "Dispatch a sub-tool step (`do:`) once per item in `items`. Aggregates per-iter outputs into a JSON array under `into`. v1: tool sub-steps only (no agent fan-out), serial execution.",
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
          "Inner tool sub-step. Must include `tool:` and its params. `{{<as>.*}}` placeholders are rendered per iteration.",
      },
      concurrency: {
        type: "number",
        description: "Parallel iterations. v1: clamped to 1 (serial).",
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
          "What to do when a single iteration's sub-tool fails. `continue` (default) records the error in the aggregate and proceeds; `halt` stops fan_out and the step is marked error.",
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
    const innerToolId = doObj.tool;
    if (typeof innerToolId !== "string" || innerToolId.length === 0) {
      throw new Error("fan_out: `do.tool` is required and must be a string");
    }
    if (typeof doObj.agent !== "undefined") {
      throw new Error(
        "fan_out: agent sub-steps are not supported in v1 — use a tool sub-step",
      );
    }
    if (!hasTool(innerToolId)) {
      throw new Error(`fan_out: unknown inner tool "${innerToolId}"`);
    }
    if (innerToolId === "fan_out") {
      throw new Error("fan_out: nested fan_out is not supported in v1");
    }

    const aggregate: IterResult[] = [];

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

      // Deep-render the raw `do` sub-step against iterCtx, then dispatch
      // via executeTool. We import render lazily to avoid a circular
      // import with yamlRunner.
      const { render } = await import("../yamlRunner.js");
      const innerParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(doObj)) {
        if (k === "tool") continue;
        innerParams[k] = deepRenderForIter(v, iterCtx, render);
      }

      try {
        const output = await executeTool(innerToolId, {
          params: innerParams,
          step: doObj,
          ctx: iterCtx,
          deps,
        });
        aggregate.push({
          index: i,
          ok: true,
          ...(output != null && { output }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        aggregate.push({ index: i, ok: false, error: msg });
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
