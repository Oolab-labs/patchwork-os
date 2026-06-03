/**
 * Paystack recipe-step tool tests.
 *
 * Mocks the Paystack connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read + risk metadata is what the registry advertises.
 *
 * All v1 Paystack tools are read-only — money-movement methods
 * (initializeTransaction / chargeAuthorization / initiateTransfer /
 * createTransferRecipient / createCustomer) are deliberately NOT wrapped.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/paystack.js")` lazily, so from
// this test file (in __tests__/) the path is THREE levels up. vi.mock is hoisted
// automatically; the factory exposes getPaystackConnector returning spies.

const listTransactions = vi.fn();
const verifyTransaction = vi.fn();
const getTransaction = vi.fn();
const listCustomers = vi.fn();

vi.mock("../../../connectors/paystack.js", () => ({
  getPaystackConnector: () => ({
    listTransactions,
    verifyTransaction,
    getTransaction,
    listCustomers,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../paystack.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — tools only read `params`. */
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

describe("paystack recipe-step tools", () => {
  describe("paystack.list_transactions", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("paystack.list_transactions");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listTransactions with mirrored params and returns its JSON", async () => {
      const result = {
        data: [
          {
            id: 1,
            domain: "test",
            status: "success",
            reference: "ref_1",
            amount: 10000,
            currency: "NGN",
            paid_at: "2026-01-01T00:00:00Z",
            customer: { email: "buyer@example.com" },
            authorization: {
              authorization_code: "AUTH_x",
              card_type: "visa",
              bank: "Test Bank",
              last4: "4081",
              exp_month: "12",
              exp_year: "2030",
            },
          },
        ],
        meta: { total: 1, skipped: 0, perPage: 50, page: 1 },
      };
      listTransactions.mockResolvedValue(result);

      const tool = getTool("paystack.list_transactions");
      const out = await tool?.execute(
        ctx({
          perPage: 50,
          page: 2,
          from: "2026-01-01",
          to: "2026-02-01",
          status: "success",
        }),
      );

      expect(listTransactions).toHaveBeenCalledWith({
        perPage: 50,
        page: 2,
        from: "2026-01-01",
        to: "2026-02-01",
        status: "success",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listTransactions.mockResolvedValue({ data: [] });
      const tool = getTool("paystack.list_transactions");
      await tool?.execute(ctx({}));

      expect(listTransactions).toHaveBeenCalledWith({
        perPage: undefined,
        page: undefined,
        from: undefined,
        to: undefined,
        status: undefined,
      });
    });
  });

  describe("paystack.verify_transaction", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("paystack.verify_transaction");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls verifyTransaction(reference) and returns its JSON", async () => {
      const txn = {
        id: 99,
        domain: "test",
        status: "success",
        reference: "ref_abc",
        amount: 5000,
        currency: "NGN",
        paid_at: "2026-01-02T00:00:00Z",
        customer: { email: "c@example.com" },
        authorization: {
          authorization_code: "AUTH_y",
          card_type: "mastercard",
          bank: "Other Bank",
          last4: "1234",
          exp_month: "01",
          exp_year: "2031",
        },
      };
      verifyTransaction.mockResolvedValue(txn);

      const tool = getTool("paystack.verify_transaction");
      const out = await tool?.execute(ctx({ reference: "ref_abc" }));

      expect(verifyTransaction).toHaveBeenCalledWith("ref_abc");
      expect(out).toBe(JSON.stringify(txn));
    });
  });

  describe("paystack.get_transaction", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("paystack.get_transaction");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getTransaction(id) and returns its JSON", async () => {
      const txn = {
        id: 42,
        domain: "live",
        status: "success",
        reference: "ref_42",
        amount: 25000,
        currency: "GHS",
        paid_at: "2026-01-03T00:00:00Z",
        customer: { email: "g@example.com" },
        authorization: {
          authorization_code: "AUTH_z",
          card_type: "verve",
          bank: "GH Bank",
          last4: "9999",
          exp_month: "06",
          exp_year: "2029",
        },
      };
      getTransaction.mockResolvedValue(txn);

      const tool = getTool("paystack.get_transaction");
      const out = await tool?.execute(ctx({ id: 42 }));

      expect(getTransaction).toHaveBeenCalledWith(42);
      expect(out).toBe(JSON.stringify(txn));
    });
  });

  describe("paystack.list_customers", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("paystack.list_customers");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listCustomers with mirrored params and returns its JSON", async () => {
      const result = {
        data: [
          {
            id: 7,
            email: "cust@example.com",
            customer_code: "CUS_x",
            first_name: "Casey",
            last_name: "Jones",
            phone: null,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
      listCustomers.mockResolvedValue(result);

      const tool = getTool("paystack.list_customers");
      const out = await tool?.execute(ctx({ perPage: 30, page: 3 }));

      expect(listCustomers).toHaveBeenCalledWith({
        perPage: 30,
        page: 3,
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listCustomers.mockResolvedValue({ data: [] });
      const tool = getTool("paystack.list_customers");
      await tool?.execute(ctx({}));

      expect(listCustomers).toHaveBeenCalledWith({
        perPage: undefined,
        page: undefined,
      });
    });
  });
});
