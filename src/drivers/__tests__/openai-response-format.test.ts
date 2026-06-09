import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIApiDriver } from "../openai/index.js";

const mockCreate = vi.fn();
vi.mock("openai", () => ({
  // biome-ignore lint/complexity/useArrowFunction: must be constructable with `new`
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

const log = vi.fn();

function makeStream(chunks: string[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield { choices: [{ delta: { content: c } }] };
    },
  };
}

async function run(providerOptions?: Record<string, unknown>) {
  mockCreate.mockResolvedValue(makeStream(["{}"]));
  const driver = new OpenAIApiDriver(log);
  await driver.run({
    prompt: "judge this",
    workspace: "/tmp",
    timeoutMs: 5000,
    signal: AbortSignal.timeout(5000),
    ...(providerOptions ? { providerOptions } : {}),
  });
  return mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  mockCreate.mockReset();
  log.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "test-key");
});
afterEach(() => {
  mockCreate.mockReset();
  vi.unstubAllEnvs();
});

describe("OpenAIApiDriver — response_format passthrough (constrained decoding)", () => {
  it("forwards providerOptions.responseFormat as response_format", async () => {
    const body = await run({ responseFormat: { type: "json_object" } });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("forwards a json_schema response_format object verbatim", async () => {
    const rf = {
      type: "json_schema",
      json_schema: { name: "verdict", schema: { type: "object" } },
    };
    const body = await run({ responseFormat: rf });
    expect(body.response_format).toEqual(rf);
  });

  it("omits response_format when not requested", async () => {
    const body = await run();
    expect("response_format" in body).toBe(false);
  });

  it("ignores a non-object responseFormat (fail-safe)", async () => {
    const body = await run({ responseFormat: "json_object" });
    expect("response_format" in body).toBe(false);
  });
});
