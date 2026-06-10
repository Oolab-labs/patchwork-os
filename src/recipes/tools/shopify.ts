/**
 * Shopify tools — read-only access to products, orders, and customers.
 *
 * Self-registering tool module for the recipe tool registry. Each tool lazily
 * imports the Shopify connector and wraps a single read method, returning the
 * connector result verbatim via JSON.stringify.
 *
 * Connector methods mirrored (see src/connectors/shopify.ts):
 *   - listProducts({ limit?, status?, vendor?, productType? }) -> { data: ShopifyProduct[] }
 *   - listOrders({ limit?, status?, financialStatus?, fulfillmentStatus? }) -> { data: ShopifyOrder[] }
 *   - getOrder(orderId: string | number) -> ShopifyOrder
 *   - listCustomers({ limit?, query? }) -> { data: ShopifyCustomer[] }
 *
 * All v1 tools are read-only (`isWrite: false`, `riskDefault: "low"`).
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// shopify.list_products
// ============================================================================

registerTool({
  id: "shopify.list_products",
  namespace: "shopify",
  description:
    "List Shopify products, optionally filtered by status, vendor, or product type.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of products to return (default 50, max 250)",
        default: 50,
      },
      status: {
        type: "string",
        description: "Filter by product status (active, archived, draft)",
      },
      vendor: {
        type: "string",
        description: "Filter by vendor name",
      },
      productType: {
        type: "string",
        description: "Filter by product type",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
            body_html: { type: ["string", "null"] },
            vendor: { type: "string" },
            product_type: { type: "string" },
            status: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
            tags: { type: "string" },
            variants: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getShopifyConnector } = await import("../../connectors/shopify.js");
    const connector = getShopifyConnector();
    const result = await connector.listProducts({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
      vendor: typeof params.vendor === "string" ? params.vendor : undefined,
      productType:
        typeof params.productType === "string" ? params.productType : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// shopify.list_orders
// ============================================================================

registerTool({
  id: "shopify.list_orders",
  namespace: "shopify",
  description:
    "List Shopify orders, optionally filtered by status, financial status, or fulfillment status.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of orders to return (default 50, max 250)",
        default: 50,
      },
      status: {
        type: "string",
        description:
          "Filter by order status (open, closed, cancelled, any; default any)",
      },
      financialStatus: {
        type: "string",
        description:
          "Filter by financial status (e.g. paid, pending, refunded, voided)",
      },
      fulfillmentStatus: {
        type: "string",
        description:
          "Filter by fulfillment status (e.g. shipped, partial, unshipped, any)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            order_number: { type: "number" },
            name: { type: "string" },
            email: { type: ["string", "null"] },
            financial_status: { type: ["string", "null"] },
            fulfillment_status: { type: ["string", "null"] },
            total_price: { type: "string" },
            subtotal_price: { type: "string" },
            currency: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
            customer: { type: ["object", "null"] },
          },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getShopifyConnector } = await import("../../connectors/shopify.js");
    const connector = getShopifyConnector();
    const result = await connector.listOrders({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
      financialStatus:
        typeof params.financialStatus === "string"
          ? params.financialStatus
          : undefined,
      fulfillmentStatus:
        typeof params.fulfillmentStatus === "string"
          ? params.fulfillmentStatus
          : undefined,
    });
    return JSON.stringify(result);
  }),
});

// ============================================================================
// shopify.get_order
// ============================================================================

registerTool({
  id: "shopify.get_order",
  namespace: "shopify",
  description: "Fetch a single Shopify order by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      orderId: {
        type: ["string", "number"],
        description: "Shopify order ID",
      },
      into: CommonSchemas.into,
    },
    required: ["orderId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      order_number: { type: "number" },
      name: { type: "string" },
      email: { type: ["string", "null"] },
      financial_status: { type: ["string", "null"] },
      fulfillment_status: { type: ["string", "null"] },
      total_price: { type: "string" },
      subtotal_price: { type: "string" },
      currency: { type: "string" },
      created_at: { type: "string" },
      updated_at: { type: "string" },
      customer: { type: ["object", "null"] },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getShopifyConnector } = await import("../../connectors/shopify.js");
    const connector = getShopifyConnector();
    const result = await connector.getOrder(params.orderId as string | number);
    return JSON.stringify(result);
  }),
});

// ============================================================================
// shopify.list_customers
// ============================================================================

registerTool({
  id: "shopify.list_customers",
  namespace: "shopify",
  description:
    "List Shopify customers, optionally filtered by a search query string.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of customers to return (default 50, max 250)",
        default: 50,
      },
      query: {
        type: "string",
        description:
          "Search query (uses the Shopify customer search endpoint, e.g. email or name)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            email: { type: ["string", "null"] },
            first_name: { type: ["string", "null"] },
            last_name: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
            orders_count: { type: "number" },
            total_spent: { type: "string" },
            state: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getShopifyConnector } = await import("../../connectors/shopify.js");
    const connector = getShopifyConnector();
    const result = await connector.listCustomers({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      query: typeof params.query === "string" ? params.query : undefined,
    });
    return JSON.stringify(result);
  }),
});
