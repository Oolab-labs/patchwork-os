/**
 * WooCommerce recipe-step tool tests.
 *
 * Mocks the WooCommerce connector module so each tool's `execute` can be driven
 * without network access, then fetches each registered tool from the recipe
 * tool registry by id and asserts:
 *   - the correct connector method is called with faithfully-mirrored args,
 *   - the JSON-stringified connector result is returned verbatim,
 *   - read + risk metadata is what the registry advertises.
 *
 * All v1 WooCommerce tools are read-only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/woocommerce.js")` lazily, so
// from this test file (in __tests__/) the path is THREE levels up. vi.mock is
// hoisted automatically; the factory exposes getWooCommerceConnector returning
// spies.

const getOrders = vi.fn();
const getOrder = vi.fn();
const getProducts = vi.fn();
const getCustomers = vi.fn();

vi.mock("../../../connectors/woocommerce.js", () => ({
  getWooCommerceConnector: () => ({
    getOrders,
    getOrder,
    getProducts,
    getCustomers,
  }),
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../woocommerce.js";
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

describe("woocommerce recipe-step tools", () => {
  describe("woocommerce.list_orders", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("woocommerce.list_orders");
      expect(tool).toBeDefined();
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getOrders with mirrored params and returns its JSON", async () => {
      const result = [
        {
          id: 10,
          status: "completed",
          currency: "USD",
          date_created: "2026-01-01T00:00:00",
          total: "20.00",
          customer_id: 7,
          billing: {},
          shipping: {},
          line_items: [],
          payment_method: "stripe",
          payment_method_title: "Credit Card",
          transaction_id: "ch_1",
          customer_note: "",
        },
      ];
      getOrders.mockResolvedValue(result);

      const tool = getTool("woocommerce.list_orders");
      const out = await tool?.execute(
        ctx({
          status: "completed",
          perPage: 50,
          page: 2,
          after: "2026-01-01T00:00:00",
          before: "2026-02-01T00:00:00",
        }),
      );

      expect(getOrders).toHaveBeenCalledWith({
        status: "completed",
        perPage: 50,
        page: 2,
        after: "2026-01-01T00:00:00",
        before: "2026-02-01T00:00:00",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      getOrders.mockResolvedValue([]);
      const tool = getTool("woocommerce.list_orders");
      await tool?.execute(ctx({}));

      expect(getOrders).toHaveBeenCalledWith({
        status: undefined,
        perPage: undefined,
        page: undefined,
        after: undefined,
        before: undefined,
      });
    });
  });

  describe("woocommerce.get_order", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("woocommerce.get_order");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getOrder(id) and returns its JSON", async () => {
      const order = {
        id: 10,
        status: "processing",
        currency: "USD",
        date_created: "2026-01-01T00:00:00",
        total: "20.00",
        customer_id: 7,
        billing: {},
        shipping: {},
        line_items: [],
        payment_method: "stripe",
        payment_method_title: "Credit Card",
        transaction_id: "ch_1",
        customer_note: "",
      };
      getOrder.mockResolvedValue(order);

      const tool = getTool("woocommerce.get_order");
      const out = await tool?.execute(ctx({ id: 10 }));

      expect(getOrder).toHaveBeenCalledWith(10);
      expect(out).toBe(JSON.stringify(order));
    });
  });

  describe("woocommerce.list_products", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("woocommerce.list_products");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getProducts with mirrored params and returns its JSON", async () => {
      const result = [
        {
          id: 1,
          name: "Widget",
          status: "publish",
          price: "9.99",
          regular_price: "9.99",
          sale_price: "",
          stock_quantity: 5,
          stock_status: "instock",
          categories: [],
          images: [],
          sku: "W-1",
          description: "",
          short_description: "",
          type: "simple",
        },
      ];
      getProducts.mockResolvedValue(result);

      const tool = getTool("woocommerce.list_products");
      const out = await tool?.execute(
        ctx({
          status: "publish",
          perPage: 25,
          page: 1,
          category: "42",
        }),
      );

      expect(getProducts).toHaveBeenCalledWith({
        status: "publish",
        perPage: 25,
        page: 1,
        category: "42",
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      getProducts.mockResolvedValue([]);
      const tool = getTool("woocommerce.list_products");
      await tool?.execute(ctx({}));

      expect(getProducts).toHaveBeenCalledWith({
        status: undefined,
        perPage: undefined,
        page: undefined,
        category: undefined,
      });
    });
  });

  describe("woocommerce.list_customers", () => {
    it("is registered read-only / low risk / connector", () => {
      const tool = getTool("woocommerce.list_customers");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getCustomers with mirrored params and returns its JSON", async () => {
      const result = [
        {
          id: 7,
          email: "c@example.com",
          first_name: "Casey",
          last_name: "Jones",
          billing: {},
          orders_count: 3,
          total_spent: "60.00",
          date_created: "2026-01-01T00:00:00",
        },
      ];
      getCustomers.mockResolvedValue(result);

      const tool = getTool("woocommerce.list_customers");
      const out = await tool?.execute(
        ctx({ search: "casey", perPage: 30, page: 1 }),
      );

      expect(getCustomers).toHaveBeenCalledWith({
        search: "casey",
        perPage: 30,
        page: 1,
      });
      expect(out).toBe(JSON.stringify(result));
    });

    it("passes undefined for omitted optional params", async () => {
      getCustomers.mockResolvedValue([]);
      const tool = getTool("woocommerce.list_customers");
      await tool?.execute(ctx({}));

      expect(getCustomers).toHaveBeenCalledWith({
        search: undefined,
        perPage: undefined,
        page: undefined,
      });
    });
  });
});
