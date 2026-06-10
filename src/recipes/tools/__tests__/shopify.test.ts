/**
 * Shopify recipe-step tool tests.
 *
 * Mocks the Shopify connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read + risk metadata is what the registry advertises.
 *
 * All v1 Shopify tools are read-only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/shopify.js")` lazily, so from
// this test file (in __tests__/) the path is THREE levels up. vi.mock is hoisted
// automatically; the factory exposes getShopifyConnector returning spies.

const listProducts = vi.fn();
const listOrders = vi.fn();
const getOrder = vi.fn();
const listCustomers = vi.fn();

vi.mock("../../../connectors/shopify.js", () => ({
  getShopifyConnector: () => ({
    listProducts,
    listOrders,
    getOrder,
    listCustomers,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../shopify.js";
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

describe("shopify recipe-step tools", () => {
  describe("shopify.list_products", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("shopify.list_products");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listProducts with mirrored params and returns its JSON", async () => {
      const result = {
        data: [
          {
            id: 1,
            title: "Widget",
            body_html: null,
            vendor: "Acme",
            product_type: "Gadget",
            status: "active",
            created_at: "t",
            updated_at: "t",
            tags: "",
          },
        ],
      };
      listProducts.mockResolvedValue(result);

      const tool = getTool("shopify.list_products");
      const out = await tool?.execute(
        ctx({
          limit: 25,
          status: "active",
          vendor: "Acme",
          productType: "Gadget",
        }),
      );

      expect(listProducts).toHaveBeenCalledWith({
        limit: 25,
        status: "active",
        vendor: "Acme",
        productType: "Gadget",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listProducts.mockResolvedValue({ data: [] });
      const tool = getTool("shopify.list_products");
      await tool?.execute(ctx({}));

      expect(listProducts).toHaveBeenCalledWith({
        limit: undefined,
        status: undefined,
        vendor: undefined,
        productType: undefined,
      });
    });
  });

  describe("shopify.list_orders", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("shopify.list_orders");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listOrders with mirrored params and returns its JSON", async () => {
      const result = {
        data: [
          {
            id: 10,
            order_number: 1001,
            name: "#1001",
            email: "buyer@example.com",
            financial_status: "paid",
            fulfillment_status: null,
            total_price: "20.00",
            subtotal_price: "18.00",
            currency: "USD",
            created_at: "t",
            updated_at: "t",
          },
        ],
      };
      listOrders.mockResolvedValue(result);

      const tool = getTool("shopify.list_orders");
      const out = await tool?.execute(
        ctx({
          limit: 100,
          status: "open",
          financialStatus: "paid",
          fulfillmentStatus: "unshipped",
        }),
      );

      expect(listOrders).toHaveBeenCalledWith({
        limit: 100,
        status: "open",
        financialStatus: "paid",
        fulfillmentStatus: "unshipped",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listOrders.mockResolvedValue({ data: [] });
      const tool = getTool("shopify.list_orders");
      await tool?.execute(ctx({}));

      expect(listOrders).toHaveBeenCalledWith({
        limit: undefined,
        status: undefined,
        financialStatus: undefined,
        fulfillmentStatus: undefined,
      });
    });
  });

  describe("shopify.get_order", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("shopify.get_order");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getOrder(orderId) and returns its JSON", async () => {
      const order = {
        id: 10,
        order_number: 1001,
        name: "#1001",
        email: null,
        financial_status: "paid",
        fulfillment_status: "shipped",
        total_price: "20.00",
        subtotal_price: "18.00",
        currency: "USD",
        created_at: "t",
        updated_at: "t",
      };
      getOrder.mockResolvedValue(order);

      const tool = getTool("shopify.get_order");
      const out = await tool?.execute(ctx({ orderId: "10" }));

      expect(getOrder).toHaveBeenCalledWith("10");
      expect(out).toBe(JSON.stringify(order));
    });

    it("passes a numeric orderId through unchanged", async () => {
      getOrder.mockResolvedValue({ id: 42 });
      const tool = getTool("shopify.get_order");
      await tool?.execute(ctx({ orderId: 42 }));

      expect(getOrder).toHaveBeenCalledWith(42);
    });
  });

  describe("shopify.list_customers", () => {
    it("is registered read-only / low risk", () => {
      const tool = getTool("shopify.list_customers");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls listCustomers with mirrored params and returns its JSON", async () => {
      const result = {
        data: [
          {
            id: 7,
            email: "c@example.com",
            first_name: "Casey",
            last_name: "Jones",
            phone: null,
            created_at: "t",
            updated_at: "t",
          },
        ],
      };
      listCustomers.mockResolvedValue(result);

      const tool = getTool("shopify.list_customers");
      const out = await tool?.execute(
        ctx({ limit: 30, query: "email:c@example.com" }),
      );

      expect(listCustomers).toHaveBeenCalledWith({
        limit: 30,
        query: "email:c@example.com",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      listCustomers.mockResolvedValue({ data: [] });
      const tool = getTool("shopify.list_customers");
      await tool?.execute(ctx({}));

      expect(listCustomers).toHaveBeenCalledWith({
        limit: undefined,
        query: undefined,
      });
    });
  });

  // Audit 2026-06-09 connector-tools-1/2/3: a connector throw must become the
  // soft `{ ok:false, error }` envelope (via wrapConnectorExecute) so the
  // recipe runner can continue instead of hard-halting with `tool_threw`.
  describe("soft-error envelope on connector throw", () => {
    it("returns { ok:false, error } instead of throwing", async () => {
      listProducts.mockRejectedValue(new Error("Shopify token missing"));
      const tool = getTool("shopify.list_products");
      const out = await tool?.execute(ctx({}));
      expect(out).toBeTypeOf("string");
      const parsed = JSON.parse(out as string);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Shopify token missing");
    });
  });
});
