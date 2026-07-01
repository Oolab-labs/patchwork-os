/**
 * gmail.fetch_thread / gmail.getMessage — regression test for a hard-halt bug.
 *
 * gmailSearch wraps the whole request (fetch + json parsing) in try/catch and
 * returns a soft `{..., error}` envelope on failure. gmailFetchThread and
 * gmailGetMessage only wrapped the token fetch — a network error or malformed
 * JSON from fetch()/res.json() threw uncaught, hard-halting the recipe run
 * instead of returning the same soft error envelope.
 */

import { describe, expect, it } from "vitest";

import "../gmail.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

function ctx(params: Record<string, unknown>, deps: Partial<StepDeps> = {}) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: deps as StepDeps,
  };
}

describe("gmail.fetch_thread", () => {
  it("returns a soft error envelope when the fetch throws (network error)", async () => {
    const tool = getTool("gmail.fetch_thread");
    const out = await tool?.execute(
      ctx(
        { id: "thread123" },
        {
          getGmailToken: async () => "tok",
          fetchFn: async () => {
            throw new Error("network down");
          },
        },
      ),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.error).toBeTruthy();
    expect(parsed.messages).toEqual([]);
  });

  it("returns a soft error envelope when res.json() throws (malformed response)", async () => {
    const tool = getTool("gmail.fetch_thread");
    const out = await tool?.execute(
      ctx(
        { id: "thread123" },
        {
          getGmailToken: async () => "tok",
          fetchFn: async () =>
            ({
              ok: true,
              json: async () => {
                throw new Error("bad json");
              },
            }) as unknown as Response,
        },
      ),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.error).toBeTruthy();
    expect(parsed.messages).toEqual([]);
  });
});

describe("gmail.getMessage", () => {
  it("returns a soft error envelope when the fetch throws (network error)", async () => {
    const tool = getTool("gmail.getMessage");
    const out = await tool?.execute(
      ctx(
        { id: "msg123" },
        {
          getGmailToken: async () => "tok",
          fetchFn: async () => {
            throw new Error("network down");
          },
        },
      ),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.error).toBeTruthy();
    expect(parsed.body).toBe("");
  });

  it("returns a soft error envelope when res.json() throws (malformed response)", async () => {
    const tool = getTool("gmail.getMessage");
    const out = await tool?.execute(
      ctx(
        { id: "msg123" },
        {
          getGmailToken: async () => "tok",
          fetchFn: async () =>
            ({
              ok: true,
              json: async () => {
                throw new Error("bad json");
              },
            }) as unknown as Response,
        },
      ),
    );
    const parsed = JSON.parse(out ?? "{}");
    expect(parsed.error).toBeTruthy();
    expect(parsed.body).toBe("");
  });
});
