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

// ── Cluster C2 connector mocks (audit-5/6/7/8/9/10) ──────────────────────────
// Each tool family must convert a connector throw into the soft
// { ok:false, error } envelope rather than propagating and halting the run.
const getPostgresConnector = vi.fn();
vi.mock("../../../connectors/postgres.js", () => ({ getPostgresConnector }));

const getNotionConnector = vi.fn();
vi.mock("../../../connectors/notion.js", () => ({ getNotionConnector }));

const getConfluenceConnector = vi.fn();
vi.mock("../../../connectors/confluence.js", () => ({
  getConfluenceConnector,
}));

const getHubSpotConnector = vi.fn();
vi.mock("../../../connectors/hubspot.js", () => ({ getHubSpotConnector }));

const getVercelConnector = vi.fn();
vi.mock("../../../connectors/vercel.js", () => ({ getVercelConnector }));

const getSendGridConnector = vi.fn();
vi.mock("../../../connectors/sendgrid.js", () => ({ getSendGridConnector }));

// Import AFTER mocks so the self-registering modules pick them up.
import "../monday.js";
import "../stripe.js";
import "../postgres.js";
import "../notion.js";
import "../confluence.js";
import "../hubspot.js";
import "../vercel.js";
import "../sendgrid.js";
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

  // ── audit-6: postgres.* (read + write-gated query) ─────────────────────────
  describe("postgres.* (audit-6)", () => {
    it("postgres.list_tables returns the soft envelope when the connector throws", async () => {
      getPostgresConnector.mockReturnValue({
        listTables: vi.fn().mockRejectedValue(new Error("connection refused")),
      });
      const out = await getTool("postgres.list_tables")?.execute(ctx({}));
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "connection refused" }),
      );
    });

    it("postgres.query (write-gated) returns the soft envelope on a SQL error", async () => {
      getPostgresConnector.mockReturnValue({
        query: vi.fn().mockRejectedValue(new Error('syntax error at "FROM"')),
      });
      const out = await getTool("postgres.query")?.execute(
        ctx({ sql: "SELECT bad FROM" }),
      );
      expect(out).toBe(
        JSON.stringify({ ok: false, error: 'syntax error at "FROM"' }),
      );
    });
  });

  // ── audit-5: notion.* (read + write) ───────────────────────────────────────
  describe("notion.* (audit-5)", () => {
    it("notion.search returns the soft envelope when the connector throws", async () => {
      getNotionConnector.mockReturnValue({
        search: vi.fn().mockRejectedValue(new Error("token expired")),
      });
      const out = await getTool("notion.search")?.execute(ctx({ query: "x" }));
      expect(out).toBe(JSON.stringify({ ok: false, error: "token expired" }));
    });

    it("notion.createPage (write) returns the soft envelope when the connector throws", async () => {
      getNotionConnector.mockReturnValue({
        createPage: vi.fn().mockRejectedValue(new Error("parent not found")),
      });
      const out = await getTool("notion.createPage")?.execute(
        ctx({ parentId: "db1", title: "t" }),
      );
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "parent not found" }),
      );
    });
  });

  // ── audit-7: confluence.* (read + write) ───────────────────────────────────
  describe("confluence.* (audit-7)", () => {
    it("confluence.search returns the soft envelope when the connector throws", async () => {
      getConfluenceConnector.mockReturnValue({
        search: vi.fn().mockRejectedValue(new Error("CQL parse error")),
      });
      const out = await getTool("confluence.search")?.execute(
        ctx({ query: "type=page" }),
      );
      expect(out).toBe(JSON.stringify({ ok: false, error: "CQL parse error" }));
    });

    it("confluence.createPage (write) returns the soft envelope when the connector throws", async () => {
      getConfluenceConnector.mockReturnValue({
        createPage: vi
          .fn()
          .mockRejectedValue(new Error("title already exists")),
      });
      const out = await getTool("confluence.createPage")?.execute(
        ctx({ spaceId: "ENG", title: "t", body: "b" }),
      );
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "title already exists" }),
      );
    });
  });

  // ── audit-8: hubspot.* (read + write createNote) ───────────────────────────
  describe("hubspot.* (audit-8)", () => {
    it("hubspot.getContact returns the soft envelope when the connector throws", async () => {
      getHubSpotConnector.mockReturnValue({
        getContact: vi.fn().mockRejectedValue(new Error("404 not found")),
      });
      const out = await getTool("hubspot.getContact")?.execute(
        ctx({ contactId: "999" }),
      );
      expect(out).toBe(JSON.stringify({ ok: false, error: "404 not found" }));
    });

    it("hubspot.createNote (write) returns the soft envelope when the connector throws", async () => {
      getHubSpotConnector.mockReturnValue({
        createNote: vi.fn().mockRejectedValue(new Error("rate limited")),
      });
      const out = await getTool("hubspot.createNote")?.execute(
        ctx({ body: "n" }),
      );
      expect(out).toBe(JSON.stringify({ ok: false, error: "rate limited" }));
    });
  });

  // ── audit-10: vercel.* (reads) ─────────────────────────────────────────────
  describe("vercel.* (audit-10)", () => {
    it("vercel.list_deployments returns the soft envelope when the connector throws", async () => {
      getVercelConnector.mockReturnValue({
        listDeployments: vi
          .fn()
          .mockRejectedValue(new Error("project not found")),
      });
      const out = await getTool("vercel.list_deployments")?.execute(
        ctx({ projectId: "ghost" }),
      );
      expect(out).toBe(
        JSON.stringify({ ok: false, error: "project not found" }),
      );
    });
  });

  // ── audit-9: sendgrid read tools (list_templates / get_stats) ──────────────
  describe("sendgrid.* read tools (audit-9)", () => {
    it("sendgrid.list_templates returns the soft envelope when the connector throws", async () => {
      getSendGridConnector.mockReturnValue({
        listTemplates: vi.fn().mockRejectedValue(new Error("403 forbidden")),
      });
      const out = await getTool("sendgrid.list_templates")?.execute(ctx({}));
      expect(out).toBe(JSON.stringify({ ok: false, error: "403 forbidden" }));
    });

    it("sendgrid.get_stats returns the soft envelope when the connector throws", async () => {
      getSendGridConnector.mockReturnValue({
        getStats: vi.fn().mockRejectedValue(new Error("revoked key")),
      });
      const out = await getTool("sendgrid.get_stats")?.execute(
        ctx({ startDate: "2026-06-01" }),
      );
      expect(out).toBe(JSON.stringify({ ok: false, error: "revoked key" }));
    });
  });
});
