import { CommonSchemas, registerTool } from "../toolRegistry.js";

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
