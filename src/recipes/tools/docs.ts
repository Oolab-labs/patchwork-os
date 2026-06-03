/**
 * Google Docs tools — docs.get_document, docs.get_document_text
 *
 * Self-registering tool modules for the recipe tool registry. The
 * google-docs connector (src/connectors/googleDocs.ts) follows a
 * module-function pattern (standalone exported async functions) rather
 * than a class+accessor, so each tool lazily `await import`s the module
 * and calls the exported function directly.
 *
 * Both exported functions accept a Doc ID *or* a Google Docs URL — they
 * call `extractDocumentId(urlOrId)` internally — so the `documentId`
 * param is passed through verbatim.
 *
 * Namespace is "docs" (the parent wires the docs → google-docs alias in
 * the parity ratchet, matching how "calendar" → google-calendar and
 * "drive" → google-drive are aliased).
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// docs.get_document
// ============================================================================

registerTool({
  id: "docs.get_document",
  namespace: "docs",
  description:
    "Fetch the structured Google Docs document tree by document ID or URL. Returns the raw Docs API document (documentId, title, body, headers, footers, revisionId).",
  paramsSchema: {
    type: "object",
    properties: {
      documentId: {
        type: "string",
        description: "Google Docs document ID or a Google Docs URL",
      },
      into: CommonSchemas.into,
    },
    required: ["documentId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      documentId: { type: "string" },
      title: { type: "string" },
      body: { type: "object" },
      headers: { type: "object" },
      footers: { type: "object" },
      revisionId: { type: "string" },
    },
    required: ["documentId"],
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDocument } = await import("../../connectors/googleDocs.js");
    return JSON.stringify(await getDocument(params.documentId as string));
  },
});

// ============================================================================
// docs.get_document_text
// ============================================================================

registerTool({
  id: "docs.get_document_text",
  namespace: "docs",
  description:
    "Fetch a Google Docs document by ID or URL and return its flat plain-text content (paragraphs, tables and table-of-contents text concatenated).",
  paramsSchema: {
    type: "object",
    properties: {
      documentId: {
        type: "string",
        description: "Google Docs document ID or a Google Docs URL",
      },
      into: CommonSchemas.into,
    },
    required: ["documentId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Flat plain-text content of the document",
      },
    },
    required: ["text"],
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDocumentText } = await import("../../connectors/googleDocs.js");
    const text = await getDocumentText(params.documentId as string);
    return JSON.stringify({ text });
  },
});
