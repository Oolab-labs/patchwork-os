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
        "Capture a screenshot. Returns base64-encoded PNG. " +
        "Supported on macOS (screencapture) and Linux with a display (ImageMagick). Not available on headless servers. ",
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
            "Screenshot unavailable — this environment has no display server. " +
              "captureScreenshot requires a local IDE session with a graphical display (macOS or Linux + X11/Wayland). " +
              "It cannot run on headless VPS or SSH remote sessions.",
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
