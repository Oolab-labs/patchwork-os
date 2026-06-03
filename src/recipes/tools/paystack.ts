/**
 * Paystack tools — read-only access to transactions and customers.
 *
 * Self-registering tool module for the recipe tool registry.
 *
 * v1 is READ-ONLY by design: Paystack is a payments connector, so all
 * money-movement methods (initializeTransaction, chargeAuthorization,
 * initiateTransfer, createTransferRecipient, createCustomer) are deliberately
 * NOT wrapped here. Only the inspect/list/verify surface is exposed.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// paystack.list_transactions
// ============================================================================

registerTool({
  id: "paystack.list_transactions",
  namespace: "paystack",
  description:
    "List Paystack transactions, optionally filtered by date range or status.",
  paramsSchema: {
    type: "object",
    properties: {
      perPage: {
        type: "number",
        description: "Number of transactions per page",
      },
      page: {
        type: "number",
        description: "Page number to retrieve",
      },
      from: {
        type: "string",
        description: "Start date (ISO timestamp or YYYY-MM-DD)",
      },
      to: {
        type: "string",
        description: "End date (ISO timestamp or YYYY-MM-DD)",
      },
      status: {
        type: "string",
        description: "Filter by status (e.g. success, failed, abandoned)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      meta: {
        type: "object",
        properties: {
          total: { type: "number" },
          skipped: { type: "number" },
          perPage: { type: "number" },
          page: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPaystackConnector } = await import(
      "../../connectors/paystack.js"
    );
    const connector = getPaystackConnector();
    const result = await connector.listTransactions({
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
      from: typeof params.from === "string" ? params.from : undefined,
      to: typeof params.to === "string" ? params.to : undefined,
      status: typeof params.status === "string" ? params.status : undefined,
    });
    return JSON.stringify(result);
  },
});

// ============================================================================
// paystack.verify_transaction
// ============================================================================

registerTool({
  id: "paystack.verify_transaction",
  namespace: "paystack",
  description: "Verify a Paystack transaction by its reference.",
  paramsSchema: {
    type: "object",
    properties: {
      reference: {
        type: "string",
        description: "Transaction reference to verify",
      },
      into: CommonSchemas.into,
    },
    required: ["reference"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      domain: { type: "string" },
      status: { type: "string" },
      reference: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string" },
      paid_at: { type: ["string", "null"] },
      customer: { type: "object" },
      authorization: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPaystackConnector } = await import(
      "../../connectors/paystack.js"
    );
    const connector = getPaystackConnector();
    const result = await connector.verifyTransaction(
      params.reference as string,
    );
    return JSON.stringify(result);
  },
});

// ============================================================================
// paystack.get_transaction
// ============================================================================

registerTool({
  id: "paystack.get_transaction",
  namespace: "paystack",
  description: "Fetch a single Paystack transaction by its numeric ID.",
  paramsSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "Numeric Paystack transaction ID",
      },
      into: CommonSchemas.into,
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      domain: { type: "string" },
      status: { type: "string" },
      reference: { type: "string" },
      amount: { type: "number" },
      currency: { type: "string" },
      paid_at: { type: ["string", "null"] },
      customer: { type: "object" },
      authorization: { type: "object" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPaystackConnector } = await import(
      "../../connectors/paystack.js"
    );
    const connector = getPaystackConnector();
    const result = await connector.getTransaction(params.id as number);
    return JSON.stringify(result);
  },
});

// ============================================================================
// paystack.list_customers
// ============================================================================

registerTool({
  id: "paystack.list_customers",
  namespace: "paystack",
  description: "List Paystack customers.",
  paramsSchema: {
    type: "object",
    properties: {
      perPage: {
        type: "number",
        description: "Number of customers per page",
      },
      page: {
        type: "number",
        description: "Page number to retrieve",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object" } },
      meta: {
        type: "object",
        properties: {
          total: { type: "number" },
          skipped: { type: "number" },
          perPage: { type: "number" },
          page: { type: "number" },
        },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getPaystackConnector } = await import(
      "../../connectors/paystack.js"
    );
    const connector = getPaystackConnector();
    const result = await connector.listCustomers({
      perPage: typeof params.perPage === "number" ? params.perPage : undefined,
      page: typeof params.page === "number" ? params.page : undefined,
    });
    return JSON.stringify(result);
  },
});
