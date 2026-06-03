/**
 * Google Docs recipe-step tool tests.
 *
 * The google-docs connector uses a MODULE-FUNCTION pattern (standalone
 * exported async functions), not a class+accessor. So the mock replaces the
 * module's exported `getDocument` / `getDocumentText` functions with spies,
 * then each registered tool's `execute` is driven without network access.
 *
 * Asserts, per tool:
 *   - the correct connector function is called with the documentId mirrored
 *     verbatim (the connector resolves ID-or-URL internally),
 *   - the JSON result shape returned by `execute`,
 *   - read/write + risk + connector metadata the registry advertises,
 *   - namespace is "docs".
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Connector mock ────────────────────────────────────────────────────────────
// The tool module `await import("../../connectors/googleDocs.js")` lazily, so
// the mock must be hoisted (vi.mock is hoisted automatically) and export the
// standalone functions as spies. Path is three levels up from __tests__/.

const getDocument = vi.fn();
const getDocumentText = vi.fn();

vi.mock("../../../connectors/googleDocs.js", () => ({
  getDocument,
  getDocumentText,
}));

// Import AFTER the mock is declared so the self-registering module picks it up.
import "../docs.js";
import { getTool } from "../../toolRegistry.js";
import type { RunContext, StepDeps } from "../../yamlRunner.js";

/** Minimal ToolContext factory — these tools only read `params`. */
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

describe("google-docs recipe-step tools", () => {
  describe("docs.get_document", () => {
    it("is registered read-only / low risk / connector in the docs namespace", () => {
      const tool = getTool("docs.get_document");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("docs");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getDocument(documentId) and returns its JSON verbatim", async () => {
      const doc = {
        documentId: "doc-123",
        title: "My Doc",
        body: { content: [] },
        revisionId: "rev-1",
      };
      getDocument.mockResolvedValue(doc);

      const tool = getTool("docs.get_document");
      const out = await tool?.execute(ctx({ documentId: "doc-123" }));

      expect(getDocument).toHaveBeenCalledWith("doc-123");
      expect(getDocument).toHaveBeenCalledTimes(1);
      expect(getDocumentText).not.toHaveBeenCalled();
      expect(out).toBe(JSON.stringify(doc));
    });

    it("passes a Google Docs URL through verbatim (connector resolves ID-or-URL)", async () => {
      getDocument.mockResolvedValue({ documentId: "doc-xyz" });
      const url = "https://docs.google.com/document/d/doc-xyz/edit";

      const tool = getTool("docs.get_document");
      await tool?.execute(ctx({ documentId: url }));

      expect(getDocument).toHaveBeenCalledWith(url);
    });
  });

  describe("docs.get_document_text", () => {
    it("is registered read-only / low risk / connector in the docs namespace", () => {
      const tool = getTool("docs.get_document_text");
      expect(tool).toBeDefined();
      expect(tool?.namespace).toBe("docs");
      expect(tool?.isWrite).toBe(false);
      expect(tool?.riskDefault).toBe("low");
      expect(tool?.isConnector).toBe(true);
    });

    it("calls getDocumentText(documentId) and returns its text wrapped as JSON", async () => {
      getDocumentText.mockResolvedValue("Hello\nworld\n");

      const tool = getTool("docs.get_document_text");
      const out = await tool?.execute(ctx({ documentId: "doc-123" }));

      expect(getDocumentText).toHaveBeenCalledWith("doc-123");
      expect(getDocumentText).toHaveBeenCalledTimes(1);
      expect(getDocument).not.toHaveBeenCalled();
      expect(out).toBe(JSON.stringify({ text: "Hello\nworld\n" }));
    });

    it("passes a Google Docs URL through verbatim (connector resolves ID-or-URL)", async () => {
      getDocumentText.mockResolvedValue("");
      const url = "https://docs.google.com/document/d/doc-xyz/edit";

      const tool = getTool("docs.get_document_text");
      await tool?.execute(ctx({ documentId: url }));

      expect(getDocumentText).toHaveBeenCalledWith(url);
    });
  });
});
