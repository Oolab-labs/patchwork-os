import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, extensionRequired } from "./utils.js";

export function createCaptureScreenshotTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "captureScreenshot",
      extensionRequired: true,
      description:
        "Capture a screenshot of the current screen. Returns the image as a base64-encoded PNG. " +
        "Supported on macOS (screencapture) and Linux (ImageMagick import). " +
        "Requires the VS Code extension.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
    },
    async handler() {
      if (!extensionClient.isConnected()) {
        return extensionRequired("captureScreenshot");
      }
      try {
        const result = await extensionClient.captureScreenshot();
        if (result === null) {
          return error(
            "Screenshot failed or is not supported on this platform",
          );
        }
        const { base64, mimeType } = result;
        // Return MCP image content block directly — not wrapped in success()
        // which only produces text blocks.
        return {
          content: [{ type: "image", data: base64, mimeType }],
        } as unknown as ReturnType<typeof error>;
      } catch (err) {
        if (err instanceof ExtensionTimeoutError) {
          return error("Extension timed out capturing screenshot");
        }
        throw err;
      }
    },
  };
}
