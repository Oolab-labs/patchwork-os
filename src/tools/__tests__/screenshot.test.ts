import { describe, expect, it } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createCaptureScreenshotTool } from "../screenshot.js";

function mockClient(overrides: Record<string, unknown> = {}): any {
  return {
    isConnected: () => true,
    captureScreenshot: async () => null,
    ...overrides,
  };
}

function mockDisconnected(): any {
  return { isConnected: () => false };
}

describe("captureScreenshot", () => {
  it("returns extensionRequired when extension is disconnected", async () => {
    const tool = createCaptureScreenshotTool(mockDisconnected());
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("captureScreenshot");
  });

  it("returns error when extension returns null", async () => {
    const tool = createCaptureScreenshotTool(
      mockClient({ captureScreenshot: async () => null }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("not supported");
  });

  it("returns image content block when extension returns base64 data", async () => {
    const fakeBase64 = Buffer.from("fake-png-bytes").toString("base64");
    const tool = createCaptureScreenshotTool(
      mockClient({
        captureScreenshot: async () => ({
          base64: fakeBase64,
          mimeType: "image/png",
        }),
      }),
    );
    const result = await tool.handler();
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("image");
    expect(content[0]?.data).toBe(fakeBase64);
    expect(content[0]?.mimeType).toBe("image/png");
  });

  it("returns timeout error when extension throws ExtensionTimeoutError", async () => {
    const tool = createCaptureScreenshotTool(
      mockClient({
        captureScreenshot: async () => {
          throw new ExtensionTimeoutError("timed out");
        },
      }),
    );
    const result = await tool.handler();
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("timed out");
  });
});
