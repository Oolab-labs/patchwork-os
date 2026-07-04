/**
 * POST /copilot/message — Tier 1 lever-action copilot route (Overview
 * deck's 7:copilot pane, docs/plans/dashboard-terminal-copilot-plan-2026-07-03.md).
 * Exercises `tryHandleRecipeRoute` directly with a fake req/res + injected
 * `recipesFn`/`runsFn`, mirroring `decisionTraceRoutes.test.ts`'s pattern.
 *
 * Auth: like every other recipe route, this handler runs AFTER the Bearer
 * auth gate in server.ts — `tryHandleRecipeRoute` itself has no auth check.
 * This suite asserts the route only ever returns a proposal (`reply` +
 * optional `action`), never executes anything, and that deps-injection is
 * the sole path to recipe/run data (no raw fallback).
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { getApprovalQueue } from "../approvalQueue.js";
import type { RecipeRouteDeps } from "../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../recipeRoutes.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  read: () => { status: number; body: string };
} {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

const flush = () => new Promise((r) => setImmediate(r));

const RECIPES = [
  { name: "nightly-review", enabled: true },
  { name: "outcome-ingester", enabled: true },
  { name: "morning-brief", enabled: false },
];

function makeDeps(overrides: Partial<RecipeRouteDeps> = {}): RecipeRouteDeps {
  return {
    recipesFn: () => ({ recipes: RECIPES }),
    runsFn: () => [],
    ...overrides,
  } as unknown as RecipeRouteDeps;
}

async function postCopilotMessage(
  bodyObj: unknown,
  deps: RecipeRouteDeps = makeDeps(),
): Promise<{ handled: boolean; status: number; body: string }> {
  const req = makeReq("POST");
  const { res, read } = makeRes();
  const handled = tryHandleRecipeRoute(
    req,
    res,
    new URL("http://x/copilot/message"),
    deps,
  );
  req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
  req.emit("end");
  await flush();
  await flush();
  return { handled, ...read() };
}

describe("POST /copilot/message", () => {
  beforeEach(() => {
    // getApprovalQueue() is a process-wide singleton other test files also
    // touch — start each test from a known-empty state.
    getApprovalQueue().clear();
  });

  it("proposes a pause_recipe action card for a recognized pause phrase", async () => {
    const { handled, status, body } = await postCopilotMessage({
      text: "pause nightly-review, it's too noisy this week",
    });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toEqual({
      kind: "pause_recipe",
      recipeName: "nightly-review",
    });
    expect(parsed.reply).toMatch(/nightly-review/);
  });

  it("proposes an enable_recipe action card", async () => {
    const { status, body } = await postCopilotMessage({
      text: "enable morning-brief",
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toEqual({
      kind: "enable_recipe",
      recipeName: "morning-brief",
    });
  });

  it("proposes a run_recipe action card", async () => {
    const { body } = await postCopilotMessage({
      text: "run outcome-ingester",
    });
    const parsed = JSON.parse(body);
    expect(parsed.action).toEqual({
      kind: "run_recipe",
      recipeName: "outcome-ingester",
    });
  });

  it("explain_halt looks up the most recent halt reason via runsFn and proposes no action", async () => {
    const deps = makeDeps({
      runsFn: (() => [
        { seq: 1, haltReason: "github.search_issues: HTTP 401" },
      ]) as RecipeRouteDeps["runsFn"],
    });
    const { body } = await postCopilotMessage(
      { text: "why did outcome-ingester halt" },
      deps,
    );
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/HTTP 401/);
  });

  it("falls back to the can-do hint for unrecognized text, proposing no action", async () => {
    const { status, body } = await postCopilotMessage({
      text: "what's the weather like",
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/pause, enable, or run/i);
  });

  it("gives an honest deferred-feature reply for recipe/worker creation asks", async () => {
    const { body } = await postCopilotMessage({
      text: "create a recipe that posts failed deploys to slack",
    });
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/isn't wired up yet/i);
  });

  it("never executes anything — response is always {reply, action?}, no side-effect fields", async () => {
    const { body } = await postCopilotMessage({ text: "pause nightly-review" });
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed).sort()).toEqual(["action", "reply"].sort());
  });

  it("rejects unknown body keys", async () => {
    const { status } = await postCopilotMessage({
      text: "pause nightly-review",
      extra: "nope",
    });
    expect(status).toBe(400);
  });

  it("treats a missing/non-string text field as empty input (unrecognized, no throw)", async () => {
    const { status, body } = await postCopilotMessage({});
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
  });

  it("degrades gracefully when recipesFn is null (no recipe list available)", async () => {
    const deps = makeDeps({ recipesFn: null });
    const { status, body } = await postCopilotMessage(
      { text: "pause nightly-review" },
      deps,
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    // No recipe list to match against → falls back to unrecognized.
    expect(parsed.action).toBeUndefined();
  });

  it("asks for disambiguation and proposes no action when two recipes tie for the longest match", async () => {
    const deps = makeDeps({
      recipesFn: () => ({
        recipes: [
          { name: "foo-bar", enabled: true },
          { name: "baz-qux", enabled: true },
        ],
      }),
    });
    const { status, body } = await postCopilotMessage(
      { text: "pause foo-bar or baz-qux" },
      deps,
    );
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/"foo-bar"/);
    expect(parsed.reply).toMatch(/"baz-qux"/);
  });

  it("answers approvals_status from the real approval queue singleton (zero pending)", async () => {
    const { status, body } = await postCopilotMessage({
      text: "how many approvals pending",
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/no approvals pending/i);
  });

  it("answers kill_switch_status, proposing no action", async () => {
    const { status, body } = await postCopilotMessage({
      text: "what's the kill switch status",
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.action).toBeUndefined();
    expect(parsed.reply).toMatch(/released|engaged/i);
  });
});

describe("POST /copilot/message — routing", () => {
  it("does not handle GET (route is POST-only)", () => {
    const req = makeReq("GET");
    const { res } = makeRes();
    const handled = tryHandleRecipeRoute(
      req,
      res,
      new URL("http://x/copilot/message"),
      makeDeps(),
    );
    expect(handled).toBe(false);
  });
});
