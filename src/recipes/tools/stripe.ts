/**
 * Stripe tools — read-only access to charges, customers, subscriptions, invoices.
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// stripe.listCharges
// ============================================================================

registerTool({
  id: "stripe.listCharges",
  namespace: "stripe",
  description:
    "List Stripe charges, optionally filtered by customer ID or status.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of charges to return (default 10, max 100)",
        default: 10,
      },
      customerId: {
        type: "string",
        description: "Filter by Stripe customer ID",
      },
      status: {
        type: "string",
        description: "Filter by charge status (e.g. succeeded, failed)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      has_more: { type: "boolean" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.listCharges({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      customerId:
        typeof params.customerId === "string" ? params.customerId : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// stripe.getCharge
// ============================================================================

registerTool({
  id: "stripe.getCharge",
  namespace: "stripe",
  description: "Fetch a single Stripe charge by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      chargeId: { type: "string", description: "Stripe charge ID (ch_...)" },
      into: CommonSchemas.into,
    },
    required: ["chargeId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string" },
      status: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.getCharge(params.chargeId as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// stripe.listCustomers
// ============================================================================

registerTool({
  id: "stripe.listCustomers",
  namespace: "stripe",
  description: "List Stripe customers, optionally filtered by email.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of customers to return (default 10, max 100)",
        default: 10,
      },
      email: {
        type: "string",
        description: "Filter by customer email address",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      has_more: { type: "boolean" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.listCustomers({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      email: typeof params.email === "string" ? params.email : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// stripe.getCustomer
// ============================================================================

registerTool({
  id: "stripe.getCustomer",
  namespace: "stripe",
  description: "Fetch a single Stripe customer by ID.",
  paramsSchema: {
    type: "object",
    properties: {
      customerId: {
        type: "string",
        description: "Stripe customer ID (cus_...)",
      },
      into: CommonSchemas.into,
    },
    required: ["customerId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: ["string", "null"] },
      name: { type: ["string", "null"] },
      balance: { type: "number" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.getCustomer(params.customerId as string);
    return JSON.stringify(result);
  },
});

// ============================================================================
// stripe.listSubscriptions
// ============================================================================

registerTool({
  id: "stripe.listSubscriptions",
  namespace: "stripe",
  description:
    "List Stripe subscriptions, optionally filtered by customer ID or status.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description:
          "Max number of subscriptions to return (default 10, max 100)",
        default: 10,
      },
      customerId: {
        type: "string",
        description: "Filter by Stripe customer ID",
      },
      status: {
        type: "string",
        description:
          "Filter by status: active, past_due, canceled, trialing, all",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      has_more: { type: "boolean" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.listSubscriptions({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      customerId:
        typeof params.customerId === "string" ? params.customerId : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// stripe.listInvoices
// ============================================================================

registerTool({
  id: "stripe.listInvoices",
  namespace: "stripe",
  description:
    "List Stripe invoices, optionally filtered by customer ID or status.",
  paramsSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max number of invoices to return (default 10, max 100)",
        default: 10,
      },
      customerId: {
        type: "string",
        description: "Filter by Stripe customer ID",
      },
      status: {
        type: "string",
        description:
          "Filter by invoice status (draft, open, paid, uncollectible, void)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      has_more: { type: "boolean" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getStripeConnector } = await import("../../connectors/stripe.js");
    const connector = getStripeConnector();
    const result = await connector.listInvoices({
      limit: typeof params.limit === "number" ? params.limit : undefined,
      customerId:
        typeof params.customerId === "string" ? params.customerId : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
    });
    return JSON.stringify(result);
  },
});
