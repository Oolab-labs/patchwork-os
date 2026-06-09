/**
 * WooCommerce tools — read-only access to orders, products, and customers.
 *
 * Self-registering tool module for the recipe tool registry. Each tool lazily
 * imports the WooCommerce connector and wraps a single read method, returning
 * the connector result verbatim via JSON.stringify.
 *
 * Connector methods mirrored (see src/connectors/woocommerce.ts):
 *   - getOrders({ status?, perPage?, page?, after?, before? }) -> WooOrder[]
 *   - getOrder(id: number) -> WooOrder
 *   - getProducts({ status?, perPage?, page?, category? }) -> WooProduct[]
 *   - getCustomers({ search?, perPage?, page? }) -> WooCustomer[]
 *
 * All v1 tools are read-only (`isWrite: false`, `riskDefault: "low"`). Write
 * operations (updateOrder/updateProduct/createWebhook/deleteWebhook) are
 * deliberately excluded from this first wave.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// woocommerce.list_orders
// ============================================================================

registerTool({
  id: "woocommerce.list_orders",
  namespace: "woocommerce",
  description:
    "List WooCommerce orders, optionally filtered by status or date range.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Filter by order status (e.g. pending, processing, completed, cancelled, refunded, any)",
      },
      perPage: {
        type: "number",
        description:
          "Max number of orders to return per page (WooCommerce default 10, max 100)",
      },
      page: {
        type: "number",
        description: "Page number for pagination (1-based)",
      },
      after: {
        type: "string",
        description: "Only orders created after this ISO 8601 date",
      },
      before: {
        type: "string",
        description: "Only orders created before this ISO 8601 date",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        status: { type: "string" },
        currency: { type: "string" },
        date_created: { type: "string" },
        total: { type: "string" },
        customer_id: { type: "number" },
        billing: { type: "object" },
        shipping: { type: "object" },
        line_items: { type: "array", items: { type: "object" } },
        payment_method: { type: "string" },
        payment_method_title: { type: "string" },
        transaction_id: { type: "string" },
        customer_note: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getWooCommerceConnector } = await import(
      "../../connectors/woocommerce.js"
    );
    const connector = getWooCommerceConnector();
    const result = await connector.getOrders({
      status: typeof params.status === "string" ? params.status : undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
      after: typeof params.after === "string" ? params.after : undefined,
      before: typeof params.before === "string" ? params.before : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// woocommerce.get_order
// ============================================================================

registerTool({
  id: "woocommerce.get_order",
  namespace: "woocommerce",
  description: "Fetch a single WooCommerce order by numeric ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "WooCommerce order ID",
      },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      status: { type: "string" },
      currency: { type: "string" },
      date_created: { type: "string" },
      total: { type: "string" },
      customer_id: { type: "number" },
      billing: { type: "object" },
      shipping: { type: "object" },
      line_items: { type: "array", items: { type: "object" } },
      payment_method: { type: "string" },
      payment_method_title: { type: "string" },
      transaction_id: { type: "string" },
      customer_note: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getWooCommerceConnector } = await import(
      "../../connectors/woocommerce.js"
    );
    const connector = getWooCommerceConnector();
    const result = await connector.getOrder(params.id as number);
    return JSON.stringify(result);
  }),
});

// ============================================================================
// woocommerce.list_products
// ============================================================================

registerTool({
  id: "woocommerce.list_products",
  namespace: "woocommerce",
  description:
    "List WooCommerce products, optionally filtered by status or category.",
  paramsSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Filter by product status (e.g. publish, draft, pending, private, any)",
      },
      perPage: {
        type: "number",
        description:
          "Max number of products to return per page (WooCommerce default 10, max 100)",
      },
      page: {
        type: "number",
        description: "Page number for pagination (1-based)",
      },
      category: {
        type: "string",
        description: "Filter by product category ID",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        status: { type: "string" },
        price: { type: "string" },
        regular_price: { type: "string" },
        sale_price: { type: "string" },
        stock_quantity: { type: ["number", "null"] },
        stock_status: { type: "string" },
        categories: { type: "array", items: { type: "object" } },
        images: { type: "array", items: { type: "object" } },
        sku: { type: "string" },
        description: { type: "string" },
        short_description: { type: "string" },
        type: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getWooCommerceConnector } = await import(
      "../../connectors/woocommerce.js"
    );
    const connector = getWooCommerceConnector();
    const result = await connector.getProducts({
      status: typeof params.status === "string" ? params.status : undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
      category:
        typeof params.category === "string" ? params.category : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// woocommerce.list_customers
// ============================================================================

registerTool({
  id: "woocommerce.list_customers",
  namespace: "woocommerce",
  description:
    "List WooCommerce customers, optionally filtered by a search string.",
  paramsSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Search customers by name or email",
      },
      perPage: {
        type: "number",
        description:
          "Max number of customers to return per page (WooCommerce default 10, max 100)",
      },
      page: {
        type: "number",
        description: "Page number for pagination (1-based)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        email: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        billing: { type: "object" },
        orders_count: { type: "number" },
        total_spent: { type: "string" },
        date_created: { type: "string" },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getWooCommerceConnector } = await import(
      "../../connectors/woocommerce.js"
    );
    const connector = getWooCommerceConnector();
    const result = await connector.getCustomers({
      search: typeof params.search === "string" ? params.search : undefined,
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
    });
    return JSON.stringify(result);
  }),
});
