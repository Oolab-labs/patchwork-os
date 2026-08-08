/**
 * Precedence tests for the `driver: "local"` model and endpoint.
 *
 * ## The bug these pin
 *
 * Three settings could name the local model, and they disagreed:
 *
 *   1. the step's own `model:` — the most specific thing anyone wrote
 *   2. `LOCAL_MODEL` in the environment
 *   3. `localModel` in ~/.patchwork/config.json
 *
 * `src/config.ts` seeds (2) from (3) only when (2) is unset, and calls that
 * "non-destructive" — i.e. the environment is documented to win over config.
 * `defaultLocalFn` then read config DIRECTLY and never looked at the
 * environment at all, so for recipe steps the documented precedence was
 * inverted. Worse, it applied `cfg.localModel ?? model`, so a global config
 * default beat the model a recipe author had written explicitly.
 *
 * The failure is silent in the direction that matters: the run completes, the
 * digest looks fine, and the run log names the model the step ASKED for while
 * a different one actually answered. A run that is invalid is indistinguishable
 * from one that is not.
 *
 * Same class as #1256: two paths that must agree, and don't. The fix is one
 * resolver used by everyone, which is what `resolveLocalModel` /
 * `resolveLocalEndpoint` are.
 *
 * ## Why the fallback is not `DEFAULT_MODEL`
 *
 * `agentExecutor.DEFAULT_MODEL` is `claude-haiku-4-5-20251001` — an Anthropic
 * id. It was the fallback on the LOCAL path too, so a `driver: local` step
 * with no `model:` sent an Anthropic model name to Ollama. `cfg.localModel ??`
 * masked that whenever config happened to set a local model, which is why the
 * config override was simultaneously a bug and the only thing making the local
 * path work. Both are fixed here: the local chain ends at the local adapter's
 * own default, never at an Anthropic id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgent } from "../agentExecutor.js";
import {
  LOCAL_FALLBACK_MODEL,
  resolveLocalEndpoint,
  resolveLocalModel,
} from "../localSettings.js";

const SAVED = {
  model: process.env.LOCAL_MODEL,
  endpoint: process.env.LOCAL_ENDPOINT,
};

beforeEach(() => {
  process.env.LOCAL_MODEL = undefined;
  process.env.LOCAL_ENDPOINT = undefined;
  delete process.env.LOCAL_MODEL;
  delete process.env.LOCAL_ENDPOINT;
});

afterEach(() => {
  if (SAVED.model === undefined) delete process.env.LOCAL_MODEL;
  else process.env.LOCAL_MODEL = SAVED.model;
  if (SAVED.endpoint === undefined) delete process.env.LOCAL_ENDPOINT;
  else process.env.LOCAL_ENDPOINT = SAVED.endpoint;
});

describe("resolveLocalModel", () => {
  it("the step's explicit model beats config — the reported bug", () => {
    // Before the fix this returned "cfg-model": `cfg.localModel ?? model`
    // put a global default ahead of what the recipe author wrote.
    expect(resolveLocalModel("step-model", { localModel: "cfg-model" })).toBe(
      "step-model",
    );
  });

  it("the step's explicit model beats the environment too", () => {
    process.env.LOCAL_MODEL = "env-model";
    expect(resolveLocalModel("step-model", {})).toBe("step-model");
  });

  it("environment beats config when the step says nothing", () => {
    // src/config.ts:697-700 seeds env from config only when env is unset and
    // calls it non-destructive. Env-wins is the documented contract; this is
    // the assertion that defaultLocalFn used to violate by ignoring env.
    process.env.LOCAL_MODEL = "env-model";
    expect(resolveLocalModel(undefined, { localModel: "cfg-model" })).toBe(
      "env-model",
    );
  });

  it("config is used when neither the step nor the environment names one", () => {
    expect(resolveLocalModel(undefined, { localModel: "cfg-model" })).toBe(
      "cfg-model",
    );
  });

  it("falls back to a LOCAL model id, never an Anthropic one", () => {
    const resolved = resolveLocalModel(undefined, {});
    expect(resolved).toBe(LOCAL_FALLBACK_MODEL);
    // The regression that matters: sending "claude-…" to Ollama.
    expect(resolved).not.toMatch(/^claude-/);
  });

  it("treats an empty string as unset rather than as a choice", () => {
    process.env.LOCAL_MODEL = "";
    expect(resolveLocalModel("", { localModel: "cfg-model" })).toBe(
      "cfg-model",
    );
  });
});

describe("resolveLocalEndpoint", () => {
  it("environment beats config", () => {
    process.env.LOCAL_ENDPOINT = "http://127.0.0.1:1234";
    expect(
      resolveLocalEndpoint({ localEndpoint: "http://127.0.0.1:9999" }),
    ).toBe("http://127.0.0.1:1234");
  });

  it("config is used when the environment is unset", () => {
    expect(
      resolveLocalEndpoint({ localEndpoint: "http://127.0.0.1:9999" }),
    ).toBe("http://127.0.0.1:9999");
  });

  it("returns undefined when neither is set, letting the adapter default", () => {
    expect(resolveLocalEndpoint({})).toBeUndefined();
  });

  it("treats an empty string as unset", () => {
    process.env.LOCAL_ENDPOINT = "";
    expect(
      resolveLocalEndpoint({ localEndpoint: "http://127.0.0.1:9999" }),
    ).toBe("http://127.0.0.1:9999");
  });
});

/**
 * The resolver being correct in isolation proves nothing about the paths that
 * were broken. These go through `executeAgent`, which is where the wrong
 * model was chosen and where the run log was stamped with a model that never
 * ran. Both assertions below fail against the pre-fix implementation.
 */
describe("executeAgent local paths use the resolver", () => {
  const makeDeps = (cfg: Record<string, string> = {}) => ({
    anthropicFn: vi.fn().mockResolvedValue({ text: "a" }),
    providerDriverFn: vi.fn().mockResolvedValue({ text: "p" }),
    claudeCliFn: vi.fn().mockResolvedValue({ text: "c" }),
    localFn: vi.fn().mockResolvedValue({ text: "local-result" }),
    probeClaudeCli: vi.fn().mockReturnValue(false),
    loadPatchworkConfig: vi.fn().mockReturnValue(cfg),
  });

  it('driver:"local" — the step model beats config, and is what gets stamped', async () => {
    const deps = makeDeps({ localModel: "cfg-model" });
    const result = await executeAgent(
      { driver: "local", prompt: "hi", model: "step-model" },
      deps as never,
    );
    // Pre-fix: localFn received "step-model" but the adapter then applied
    // cfg.localModel, so the wrong model ran while the log said otherwise.
    expect(deps.localFn).toHaveBeenCalledWith("hi", "step-model");
    expect(result.servedBy).toEqual({ driver: "local", model: "step-model" });
  });

  it('driver:"local" with no model: never sends an Anthropic id', async () => {
    const deps = makeDeps({});
    const result = await executeAgent(
      { driver: "local", prompt: "hi" },
      deps as never,
    );
    // Pre-fix this was DEFAULT_MODEL — "claude-haiku-4-5-20251001" — sent to
    // a local server.
    expect(deps.localFn).toHaveBeenCalledWith("hi", LOCAL_FALLBACK_MODEL);
    expect(result.servedBy?.model).not.toMatch(/^claude-/);
  });

  it("config model:local branch resolves the same way", async () => {
    const deps = makeDeps({ model: "local", localModel: "cfg-model" });
    const result = await executeAgent({ prompt: "hi" }, deps as never);
    expect(deps.localFn).toHaveBeenCalledWith("hi", "cfg-model");
    expect(result.servedBy).toEqual({ driver: "local", model: "cfg-model" });
  });
});

/**
 * `defaultLocalFn` itself — where `cfg.localModel ?? model` lived.
 *
 * The executeAgent tests above mock localFn, so they cannot see this: the
 * caller passed the step's model correctly and the corruption happened one
 * layer down, inside the function the mock replaced. Noting it because the
 * first executeAgent test PASSES against the pre-fix code and is therefore
 * not evidence on its own — these are.
 */
describe("defaultLocalFn honours precedence at the adapter boundary", () => {
  it("passes the step model, not cfg.localModel, to the adapter", async () => {
    vi.resetModules();
    const createLocalAdapter = vi.fn().mockReturnValue({
      complete: vi.fn().mockResolvedValue({ text: "ok" }),
    });
    vi.doMock("../../adapters/local.js", () => ({ createLocalAdapter }));
    vi.doMock("../../patchworkConfig.js", () => ({
      loadConfig: () => ({ localModel: "cfg-model" }),
    }));
    const { defaultLocalFn } = await import("../yamlRunner.js");
    await defaultLocalFn("hi", "step-model");
    expect(createLocalAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: "step-model" }),
    );
    vi.doUnmock("../../adapters/local.js");
    vi.doUnmock("../../patchworkConfig.js");
  });

  it("honours LOCAL_ENDPOINT over config", async () => {
    vi.resetModules();
    process.env.LOCAL_ENDPOINT = "http://127.0.0.1:1234";
    const createLocalAdapter = vi.fn().mockReturnValue({
      complete: vi.fn().mockResolvedValue({ text: "ok" }),
    });
    vi.doMock("../../adapters/local.js", () => ({ createLocalAdapter }));
    vi.doMock("../../patchworkConfig.js", () => ({
      loadConfig: () => ({ localEndpoint: "http://127.0.0.1:9999" }),
    }));
    const { defaultLocalFn } = await import("../yamlRunner.js");
    await defaultLocalFn("hi", "m");
    expect(createLocalAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://127.0.0.1:1234" }),
    );
    vi.doUnmock("../../adapters/local.js");
    vi.doUnmock("../../patchworkConfig.js");
  });
});
