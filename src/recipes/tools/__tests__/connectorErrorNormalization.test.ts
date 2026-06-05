/**
 * Connector error-normalization tests (S6 reliability).
 *
 * Newer connector tools historically had no try/catch in `execute()`: a
 * connector throw (network failure, missing-token `authenticate()`/`loadTokens()`
 * inside a class-accessor connector, …) propagated uncaught → the recipe runner
 * recorded a null result → `ctx[step.into]` was never written → downstream
 * `{{steps.X.field}}` resolved empty → the run halted.
 *
 * The early tools (slack/linear/jira) instead return a SOFT envelope:
 *   JSON.stringify({ ok: false, error })
 * so a downstream step can read `.error` and the run can continue.
 *
 * These tests drive two representative tools — `monday.list_boards`
 * (module-function connector) and `stripe.listCharges` (class-accessor connector
 * that can throw inside the accessor) — with an injected dependency that THROWS,
 * and assert the tool returns the soft envelope instead of throwing. They also
 * assert the success path is unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mocks ──────────────────────────────────────────────────────────
const listBoards = vi.fn();
vi.mock("../../../connectors/monday.js", () => ({
  listBoards,
  listItems: vi.fn(),
  getItem: vi.fn(),
  createItem: vi.fn(),
}));

const getStripeConnector = vi.fn();
vi.mock("../../../connectors/stripe.js", () => ({ getStripeConnector }));

// Import AFTER mocks so the self-registering modules pick them up.
import "../monday.js";
import "../stripe.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

function ctx(params: Record<string, unknown>) {
  return {
    params,
    step: {} as Record<string, unknown>,
    ctx: {} as RunContext,
    deps: {} as StepDeps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("connector error normalization → soft { ok:false, error } envelope", () => {
  describe("monday.list_boards (module-function connector throw)", () => {
    it("returns the soft envelope instead of throwing when the connector throws", async () => {
      listBoards.mockRejectedValue(new Error("network down"));
      const tool = getTool("monday.list_boards");

      // Must resolve to the soft envelope, NOT reject.
      const out = await tool?.execute(ctx({ limit: 10 }));
      expect(out).toBe(JSON.stringify({ ok: false, error: "network down" }));
    });

    it("passes the success path through unchanged", async () => {
      const boards = [{ id: "1", name: "Roadmap" }];
      listBoards.mockResolvedValue(boards);
      const tool = getTool("monday.list_boards");

      const out = await tool?.execute(ctx({ limit: 10 }));
      expect(out).toBe(JSON.stringify(boards));
    });
  });

  describe("stripe.listCharges (class-accessor connector throw)", () => {
    it("returns the soft envelope when the accessor itself throws (missing config)", async () => {
      getStripeConnector.mockImplementation(() => {
        throw new Error("Stripe not connected");
      });
      const tool = getTool("stripe.listCharges");

      // Accessor throws synchronously inside execute → wrapper must catch it.
      const out = await tool?.execute(ctx({}));
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "Stripe not connected" }),
      );
    });

    it("returns the soft envelope when the connector method rejects", async () => {
      getStripeConnector.mockReturnValue({
        listCharges: vi.fn().mockRejectedValue(new Error("401 unauthorized")),
      });
      const tool = getTool("stripe.listCharges");

      const out = await tool?.execute(ctx({}));
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "401 unauthorized" }),
      );
    });

    it("passes the success path through unchanged", async () => {
      const result = { data: [{ id: "ch_1" }], has_more: false };
      getStripeConnector.mockReturnValue({
        listCharges: vi.fn().mockResolvedValue(result),
      });
      const tool = getTool("stripe.listCharges");

      const out = await tool?.execute(ctx({}));
      expect(out).toBe(JSON.stringify(result));
    });
  });
});
