/**
 * `fan_out` and the information boundary (#1466, ADR-0021).
 *
 * ## The gap this closes
 *
 * `fan_out` is how a recipe processes a BATCH, and a batch of documents is the
 * highest-volume confidential path in the product. Until now it was the one
 * step that could not say so: the iteration honours an allowlist of
 * `prompt`/`driver`/`model`, so `do.agent.data_policy` was refused, and there
 * was nowhere else to put it.
 *
 * The consequence was the wrong way round. In the shipped
 * `private-document-digest` recipe the `scrub` step handles the RAW documents N
 * times and could not be labelled; the `digest` step, which sees only redacted
 * extracts, could. Measured on a three-document run: three rows `assumed`, one
 * `declared` — and the three assumed ones were the raw passes. Point that
 * driver at a hosted model and the boundary would have recorded
 * `internal → remote → ALLOW`, because nothing was able to tell it otherwise.
 *
 * ## Why the label goes on the STEP, not inside `do.agent`
 *
 * The allowlist inside the iteration stays an allowlist, and that is not
 * incidental. Its comment records why: an earlier denylist missed `sandbox`,
 * `tools`, `disallowedTools` and `mcpAccess`, so an author writing
 * `sandbox: true` would believe the iteration was sandboxed while it silently
 * was not — a false SAFETY signal, not a dropped option.
 *
 * `data_policy` is in exactly that class, which is why it must keep being
 * refused there rather than quietly accepted. But it differs from the other
 * rejected options in the way that decides where it belongs: those change HOW a
 * step runs and are plausibly per-item; this describes WHAT THE DATA IS, and it
 * is uniform across the iteration by construction. So it is a property of the
 * batch, declared once on the step, applied to every dispatch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getTool } from "../../toolRegistry.js";
import "../index.js";

let tmpDir: string;
/** Every input `runNestedAgent` was handed, in order. */
let seen: Array<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "fanout-policy-"));
  seen = [];
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

/**
 * Drive the tool directly.
 *
 * Deliberately not through `runYamlRecipe`: the runner hard-wires the privacy
 * seams to the real config and the real ledger, so an end-to-end assertion here
 * would read the developer's own `~/.patchwork/config.json` and its result
 * would depend on whose machine ran it. The contract that actually changed is
 * the one between `fan_out` and the runner's injected executor, and that is
 * what these assert.
 */
async function runFanOut(
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const tool = getTool("fan_out");
  if (!tool) throw new Error("fan_out is not registered");
  try {
    await tool.execute({
      params,
      ctx: {},
      deps: {
        logDir: tmpDir,
        runNestedAgent: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { text: "scrubbed", ok: true };
        },
      },
    } as never);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const BATCH = {
  items: '["doc-a","doc-b"]',
  as: "doc",
  do: { agent: { prompt: "Scrub {{doc}}", driver: "anthropic" } },
};

describe("a batch can declare what it carries", () => {
  it("passes the step's data_policy to every iteration", async () => {
    const r = await runFanOut({
      ...BATCH,
      data_policy: { classification: "confidential" },
    });

    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    // EVERY dispatch, not just the first. A label applied to iteration 0 and
    // dropped afterwards would be worse than none: the ledger would show a
    // confidential row followed by defaults, which reads as a batch that
    // changed classification halfway through.
    for (const call of seen) {
      expect(call.dataPolicy).toEqual({ classification: "confidential" });
    }
  });

  it("passes it RAW, so an unrecognised classification fails closed downstream", async () => {
    // The decision point parses it and refuses a typo rather than defaulting it
    // to `internal`. Normalising here would swallow that, and a step declaring
    // `restrickted` would be dispatched as `internal` with a receipt asserting
    // so — a false-affirmative audit record, which is worse than none.
    await runFanOut({ ...BATCH, data_policy: { classification: "nonsense" } });

    expect(seen[0]?.dataPolicy).toEqual({ classification: "nonsense" });
  });

  it("carries categories through as well", async () => {
    await runFanOut({
      ...BATCH,
      data_policy: {
        classification: "confidential",
        categories: ["financial"],
      },
    });

    expect(seen[0]?.dataPolicy).toEqual({
      classification: "confidential",
      categories: ["financial"],
    });
  });

  it("sends no dataPolicy at all when none is declared", async () => {
    // Absence must stay ABSENT, not become an empty object. The decision point
    // distinguishes "declared" from "assumed" by whether this field is present,
    // and an empty object would make every undeclared batch claim to be
    // labelled — the exact false-affirmative the boundary exists to avoid.
    await runFanOut(BATCH);

    expect(seen[0]).not.toHaveProperty("dataPolicy");
  });
});

describe("the iteration allowlist stays an allowlist", () => {
  it("still refuses data_policy INSIDE do.agent, loudly", async () => {
    // Regression guard on the reasoning, not just the behaviour. Accepting it
    // here would be the `sandbox: true` mistake again — an author would
    // believe the batch was labelled while the runner honoured nothing.
    const r = await runFanOut({
      ...BATCH,
      do: {
        agent: {
          prompt: "Scrub {{doc}}",
          driver: "anthropic",
          data_policy: { classification: "confidential" },
        },
      },
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not supported inside an iteration/);
    // And it must say where the label DOES belong, or the author is left with
    // an error naming only prompt/driver/model and no way to comply.
    expect(r.error).toMatch(/data_policy/);
  });

  it("still refuses an option it has never heard of", async () => {
    const r = await runFanOut({
      ...BATCH,
      do: { agent: { prompt: "x", driver: "anthropic", sandbox: true } },
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not supported inside an iteration/);
  });
});
