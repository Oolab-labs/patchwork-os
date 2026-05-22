import { CommonSchemas, registerTool } from "../toolRegistry.js";

registerTool({
  id: "drive.findLatestDoc",
  namespace: "drive",
  description:
    "Find the most recently modified Google Doc whose name contains the given substring. Returns { id, name, url, modifiedTime } or { error }. If fallbackUrl is provided and non-empty, it is returned verbatim (lets recipes accept an explicit URL OR auto-pick the latest).",
  paramsSchema: {
    type: "object",
    properties: {
      nameContains: { type: "string", default: "Notes by Gemini" },
      fallbackUrl: { type: "string", default: "" },
      into: CommonSchemas.into,
    },
    required: ["nameContains"],
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      modifiedTime: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const fallback = String(params.fallbackUrl ?? "").trim();
    if (fallback.length > 0) {
      return JSON.stringify({ url: fallback, name: "", id: "" });
    }
    const nameContains = String(params.nameContains ?? "").trim();
    if (nameContains.length === 0) {
      return JSON.stringify({ error: "nameContains is required" });
    }
    if (!deps.getDriveToken) {
      return JSON.stringify({ error: "Google Drive not connected" });
    }
    let token: string;
    try {
      token = await deps.getDriveToken();
    } catch (err) {
      return JSON.stringify({
        error:
          err instanceof Error ? err.message : "Google Drive not connected",
      });
    }
    try {
      const { findLatestDoc } = await import("../../connectors/googleDrive.js");
      const hit = await findLatestDoc(nameContains, token);
      if (!hit) {
        return JSON.stringify({
          error: `No Doc found matching "${nameContains}"`,
        });
      }
      return JSON.stringify(hit);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : "Drive search failed",
      });
    }
  },
});

registerTool({
  id: "drive.fetchDoc",
  namespace: "drive",
  description:
    "Fetch the plain-text content of a Google Doc by URL or file ID.",
  paramsSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      into: CommonSchemas.into,
    },
    required: ["url"],
  },
  outputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params, deps }) => {
    const url = String(params.url ?? "");

    let token: string;
    try {
      if (!deps.getDriveToken) {
        return JSON.stringify({
          content: "",
          error: "Google Drive not connected",
        });
      }
      token = await deps.getDriveToken();
    } catch (err) {
      return JSON.stringify({
        content: "",
        error:
          err instanceof Error ? err.message : "Google Drive not connected",
      });
    }

    try {
      const { fetchDocContent } = await import(
        "../../connectors/googleDrive.js"
      );
      const content = await fetchDocContent(url, token);
      return JSON.stringify({ content });
    } catch (err) {
      return JSON.stringify({
        content: "",
        error: err instanceof Error ? err.message : "Drive fetch failed",
      });
    }
  },
});
