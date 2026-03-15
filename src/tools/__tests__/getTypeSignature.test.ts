import { describe, expect, it, vi } from "vitest";
import { ExtensionTimeoutError } from "../../extensionClient.js";
import { createGetTypeSignatureTool } from "../getTypeSignature.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

function makeClient(opts: {
  connected: boolean;
  hoverResult?: unknown;
  throwTimeout?: boolean;
}) {
  return {
    isConnected: vi.fn(() => opts.connected),
    getHover: vi.fn(async () => {
      if (opts.throwTimeout) throw new ExtensionTimeoutError("getHover");
      return opts.hoverResult ?? null;
    }),
  } as any;
}

const BASE_ARGS = { file: "/ws/src/foo.ts", line: 10, column: 5 };

describe("createGetTypeSignatureTool", () => {
  it("returns extensionRequired when extension disconnected", async () => {
    const tool = createGetTypeSignatureTool(makeClient({ connected: false }));
    const result = await tool.handler(BASE_ARGS);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("extension");
  });

  it("returns found:false when hover returns null", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({ connected: true, hoverResult: null }),
    );
    const data = parse(await tool.handler(BASE_ARGS));
    expect(data.found).toBe(false);
    expect(data.file).toBe("/ws/src/foo.ts");
    expect(data.line).toBe(10);
    expect(data.column).toBe(5);
  });

  it("extracts signature from typescript fenced code block", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({
        connected: true,
        hoverResult: {
          contents: [
            "```typescript\nfunction greet(name: string): string\n```",
          ],
        },
      }),
    );
    const data = parse(await tool.handler(BASE_ARGS));
    expect(data.found).toBe(true);
    expect(data.signature).toBe("function greet(name: string): string");
  });

  it("extracts signature from ts fenced code block", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({
        connected: true,
        hoverResult: {
          contents: ["```ts\nconst x: number\n```"],
        },
      }),
    );
    const data = parse(await tool.handler(BASE_ARGS));
    expect(data.found).toBe(true);
    expect(data.signature).toBe("const x: number");
  });

  it("falls back to plain text when no code block present", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({
        connected: true,
        hoverResult: {
          contents: ["type MyType = string | number"],
        },
      }),
    );
    const data = parse(await tool.handler(BASE_ARGS));
    expect(data.found).toBe(true);
    expect(data.signature).toBe("type MyType = string | number");
  });

  it("includes raw contents in the response", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({
        connected: true,
        hoverResult: {
          contents: ["```ts\ninterface Foo {}\n```", "Some docs"],
        },
      }),
    );
    const data = parse(await tool.handler(BASE_ARGS));
    expect(data.raw).toEqual(["```ts\ninterface Foo {}\n```", "Some docs"]);
  });

  it("returns error on ExtensionTimeoutError", async () => {
    const tool = createGetTypeSignatureTool(
      makeClient({ connected: true, throwTimeout: true }),
    );
    const result = await tool.handler(BASE_ARGS);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("timed out");
  });

  it("re-throws non-timeout errors", async () => {
    const client = {
      isConnected: vi.fn(() => true),
      getHover: vi.fn(async () => {
        throw new Error("unexpected failure");
      }),
    } as any;
    const tool = createGetTypeSignatureTool(client);
    await expect(tool.handler(BASE_ARGS)).rejects.toThrow("unexpected failure");
  });
});
