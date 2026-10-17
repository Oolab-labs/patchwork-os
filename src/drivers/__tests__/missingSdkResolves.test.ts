/**
 * An API driver whose optional SDK is not installed resolves with an error
 * instead of rejecting (audit M25, 2026-10-15).
 *
 * `ProviderDriver.run()` must resolve, never reject (`types.ts`) — callers
 * read the failure from `errorMessage`. Both API drivers honoured that for
 * every request failure, but threw when the dynamic `import()` of their SDK
 * failed. Neither `openai` nor `@anthropic-ai/sdk` is a dependency of this
 * package, so on a default install that is the path every call takes: the
 * caller got a rejection instead of a result naming the missing package.
 *
 * Exercised for real, not by mocking the import: the SDKs are absent here and
 * in CI. If a developer has one installed the case is skipped, since it would
 * otherwise make a live request with a placeholder key.
 */

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiDriver } from "../claude/api.js";
import { OpenAIApiDriver } from "../openai/index.js";
import type { ProviderTaskInput } from "../types.js";

const require = createRequire(import.meta.url);
function installed(pkg: string): boolean {
  try {
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "placeholder-not-a-key");
  vi.stubEnv("OPENAI_API_KEY", "placeholder-not-a-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function input(): ProviderTaskInput {
  return {
    prompt: "hello",
    workspace: process.cwd(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };
}

describe("API drivers with no SDK installed", () => {
  it.skipIf(installed("@anthropic-ai/sdk"))(
    "api (Anthropic): resolves with an error naming the package",
    async () => {
      const result = await new ApiDriver(() => {})
        .run(input())
        .catch((err: unknown) => ({ rejected: err }));
      expect(result).not.toHaveProperty("rejected");
      expect((result as { errorMessage?: string }).errorMessage).toContain(
        "@anthropic-ai/sdk",
      );
      expect((result as { text: string }).text).toBe("");
    },
  );

  it.skipIf(installed("openai"))(
    "openai: resolves with an error naming the package",
    async () => {
      const result = await new OpenAIApiDriver(() => {})
        .run(input())
        .catch((err: unknown) => ({ rejected: err }));
      expect(result).not.toHaveProperty("rejected");
      expect((result as { errorMessage?: string }).errorMessage).toContain(
        "openai",
      );
      expect((result as { text: string }).text).toBe("");
    },
  );
});
