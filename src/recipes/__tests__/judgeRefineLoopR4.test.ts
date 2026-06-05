/**
 * GROUP R4 — run-engine correctness for the judge→refine loop and the
 * Anthropic API caller (defaultClaudeFn).
 *
 * Covers:
 *  (1) Unvalidated-draft contamination — a loop break must NOT leave the
 *      unapproved revised draft in ctx; the prior accepted value must remain.
 *  (2) Unparseable-verdict exhaustion-gate bypass — an unparseable verdict
 *      after a revision must yield a non-ok run status, not silent 'ok'.
 *  (3) defaultClaudeFn timeout + max_tokens=4096 (override honoured).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultClaudeFn,
  type RunnerDeps,
  runYamlRecipe,
  type YamlRecipe,
} from "../yamlRunner.js";

const logDir = mkdtempSync(path.join(os.tmpdir(), "judge-refine-r4-"));

function judgeRecipe(
  maxRevisions: number,
  onExhausted: "halt" | "proceed",
): YamlRecipe {
  return {
    name: "judge-refine-r4",
    trigger: { type: "manual" },
    steps: [
      {
        agent: {
          prompt: "write the thing",
          model: "claude-haiku-4-5-20251001",
          driver: "anthropic",
          into: "draft",
        },
      },
      {
        agent: {
          kind: "judge",
          reviews: "draft",
          max_revisions: maxRevisions,
          on_exhausted: onExhausted,
          prompt: "review the draft",
          model: "claude-haiku-4-5-20251001",
          driver: "anthropic",
        },
      },
    ],
  } as YamlRecipe;
}

const REQUEST_CHANGES =
  '```json\n{"verdict":"request_changes","fixList":["tighten the intro"]}\n```';

/**
 * Drive the agent calls by prompt shape:
 *  - revision-request → reviewed agent revises → "REVISED v2"
 *  - judge prompt over the revised artefact → `reJudge` (controllable)
 *  - judge prompt over the first draft → REQUEST_CHANGES
 *  - otherwise → "DRAFT v1"
 */
function depsWithReJudge(reJudge: string): RunnerDeps {
  return {
    now: () => new Date("2026-06-05T08:00:00Z"),
    logDir,
    claudeFn: async (prompt: string) => {
      if (prompt.includes("<revision-request>")) return "REVISED v2";
      if (prompt.includes("<artefact>")) {
        return prompt.includes("REVISED v2") ? reJudge : REQUEST_CHANGES;
      }
      return "DRAFT v1";
    },
  };
}

function judgeResult(result: Awaited<ReturnType<typeof runYamlRecipe>>) {
  return result.stepResults.find((s) => s.judgeVerdict !== undefined);
}

const UNPARSEABLE = "the draft is fine I guess, no JSON here";

describe("R4 #1 — unvalidated draft contamination", () => {
  it("leaves the ORIGINAL draft in ctx when the loop breaks on a failed re-judge", async () => {
    // Re-judge fails → loop breaks → staged "REVISED v2" must NOT be committed.
    const result = await runYamlRecipe(
      judgeRecipe(1, "proceed"),
      depsWithReJudge("[agent step failed: re-judge timeout]"),
    );
    expect(result.context.draft).toBe("DRAFT v1");
    expect(result.context.draft).not.toBe("REVISED v2");
  });
});

describe("R4 #2 — unparseable verdict exhaustion-gate bypass", () => {
  it("yields a non-ok run status on an unparseable re-judge verdict", async () => {
    const result = await runYamlRecipe(
      judgeRecipe(1, "proceed"),
      depsWithReJudge(UNPARSEABLE),
    );
    const judge = judgeResult(result);
    expect(judge?.judgeVerdict?.verdict).toBe("unparseable");
    // Bug: status stayed 'ok' (while-loop exits on unparseable, gate only
    // fires on request_changes). Must now be an error.
    expect(judge?.status).toBe("error");
    expect(result.errorMessage).toMatch(/unparseable/i);
    // And the unvalidated draft must not be promoted.
    expect(result.context.draft).toBe("DRAFT v1");
  });
});

describe("R4 #3/#4 — defaultClaudeFn timeout + max_tokens", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
    vi.restoreAllMocks();
  });

  it("aborts on a never-resolving fetch when a short timeout is supplied", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    // fetch that only resolves/rejects when its signal aborts.
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as typeof fetch;

    const out = await defaultClaudeFn("hi", "claude-haiku-4-5-20251001", {
      timeoutMs: 20,
    });
    expect(out.text).toMatch(/timed out/i);
  });

  it("sends max_tokens=4096 by default and honours an override", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const bodies: string[] = [];
    globalThis.fetch = ((_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      return Promise.resolve({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "ok" }] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await defaultClaudeFn("hi", "claude-haiku-4-5-20251001");
    await defaultClaudeFn("hi", "claude-haiku-4-5-20251001", {
      maxTokens: 8000,
    });
    expect(JSON.parse(bodies[0] ?? "{}").max_tokens).toBe(4096);
    expect(JSON.parse(bodies[1] ?? "{}").max_tokens).toBe(8000);
  });

  it("warns when the response was truncated at max_tokens", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "partial" }],
          stop_reason: "max_tokens",
        }),
      } as unknown as Response)) as unknown as typeof fetch;
    const out = await defaultClaudeFn("hi", "claude-haiku-4-5-20251001");
    expect(out.text).toMatch(/truncated at max_tokens/i);
  });
});
