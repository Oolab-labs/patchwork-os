/**
 * A recipe step that stops for approval must reach your phone.
 *
 * There are two ways to enqueue an approval in this codebase, and only one of
 * them notifies anybody:
 *
 *   - `enqueueApprovalWithDispatch` (approvalHttp.ts) queues AND fans out to
 *     every configured channel — webhook, Web Push, ntfy.
 *   - `queue.request()` queues silently.
 *
 * That distinction has already caused this exact bug once. The doc comment on
 * `enqueueApprovalWithDispatch` records it: the CLI gate "silently enqueued
 * with NO notification of any kind, since the CLI gate called
 * `queue.request()` directly and never touched the dispatch* helpers". The fix
 * reached the HTTP route and the CLI gate — and missed the recipe runner,
 * which still called `queue.request()` directly.
 *
 * The symptom is the worst kind: a recipe halts mid-run waiting for a human,
 * the human is never told, and the approval expires. A stalled worker and a
 * broken worker look identical from the outside. Observed twice on 2026-08-27
 * with a live errand recipe, on a machine where `ntfyTopic` was configured
 * correctly the whole time.
 *
 * The first test is a SOURCE-LEVEL wiring check, deliberately. The regression
 * it guards is a line going missing, and a behavioural test with hand-injected
 * deps proves the logic while staying blind to whether production wires it —
 * the same reasoning that put a source-level assertion on the privacy
 * boundary's deps.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { enqueueApprovalWithDispatch } from "../approvalHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const orchestration = readFileSync(
  join(here, "..", "recipeOrchestration.ts"),
  "utf-8",
);

describe("recipe approvals are wired to the notifying path", () => {
  it("recipeOrchestration imports the dispatching helper", () => {
    expect(orchestration).toMatch(/enqueueApprovalWithDispatch/);
  });

  it("the recipe approval fn does NOT call queue.request directly", () => {
    // The whole defect in one assertion. `queue.request(` inside
    // makeRecipeApprovalFn is the silent path.
    const fn = orchestration.slice(
      orchestration.indexOf("async function makeRecipeApprovalFn"),
      orchestration.indexOf("async function makeRecipeApprovalFn") + 4000,
    );
    expect(fn).not.toMatch(/queue\.request\(/);
    expect(fn).toMatch(/enqueueApprovalWithDispatch/);
  });

  it("the CALL SITE hands it the server, or the channels are all undefined", () => {
    // Caught by mutation: an earlier version of this file asserted only that
    // the function BODY mentions ntfyTopic. Removing `this.deps.server` from
    // the call site left every channel undefined at runtime — silent again —
    // and all the other tests still passed, because `server` is an optional
    // parameter so the compiler says nothing either.
    expect(orchestration).toMatch(
      /makeRecipeApprovalFn\(\s*approvalGate\s*,\s*this\.deps\.server\s*\)/,
    );
  });

  it("it passes the notification channels through", () => {
    const fn = orchestration.slice(
      orchestration.indexOf("async function makeRecipeApprovalFn"),
      orchestration.indexOf("async function makeRecipeApprovalFn") + 4000,
    );
    // ntfyTopic is the channel that was configured and silent. If the deps are
    // not threaded through, the helper mints no token and dispatches nothing.
    expect(fn).toMatch(/ntfyTopic/);
    expect(fn).toMatch(/pushServiceBaseUrl/);
  });
});

describe("enqueueApprovalWithDispatch forwards an abort signal", () => {
  it("passes opts.signal to the queue", () => {
    // The recipe path cancels its wait when the run is cancelled, instead of
    // blocking for the full approval TTL. Routing it through the dispatching
    // helper must not silently drop that — a cancelled run would then hold a
    // step open for up to four hours.
    const request = vi.fn().mockReturnValue({
      callId: "c1",
      approvalToken: "t1",
      promise: Promise.resolve("approved"),
    });
    const peek = vi.fn().mockReturnValue({ expiresAt: Date.now() + 60_000 });
    const controller = new AbortController();
    enqueueApprovalWithDispatch(
      { queue: { request, peek } as never },
      {
        toolName: "example.tool",
        params: {},
        tier: "high",
        riskSignals: [],
      },
      { signal: controller.signal },
    );
    expect(request).toHaveBeenCalledTimes(1);
    const opts = request.mock.calls[0]?.[1];
    expect(opts?.signal).toBe(controller.signal);
  });

  it("still mints a token when a channel is configured", () => {
    const request = vi.fn().mockReturnValue({
      callId: "c1",
      approvalToken: "t1",
      promise: Promise.resolve("approved"),
    });
    const peek = vi.fn().mockReturnValue({ expiresAt: Date.now() + 60_000 });
    enqueueApprovalWithDispatch(
      { queue: { request, peek } as never, ntfyTopic: "some-topic" },
      { toolName: "t", params: {}, tier: "high", riskSignals: [] },
    );
    expect(request.mock.calls[0]?.[1]?.withToken).toBe(true);
  });
});
