/**
 * The terminal tools report the extension's own reason for a failure
 * (audit M33, 2026-10-15).
 *
 * The extension's terminal handlers answer a non-fatal failure with a value,
 * not a throw: `{available: false, error}` from getTerminalOutput and
 * `{matched: false, error}` from waitForTerminalOutput. The client read them
 * through `validatedRequest`, whose error-shape check turns ANY `{error}` reply
 * into null — so "output capture is not available" became "Terminal not found",
 * and every waitForTerminalOutput refusal (bad regex, no active terminal)
 * became "Extension did not respond".
 *
 * A real ExtensionClient, with only the wire call stubbed, so the client's
 * unwrapping is what is under test. The reply shapes are copied from
 * `vscode-extension/src/handlers/terminal.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { ExtensionClient } from "../../extensionClient.js";
import { Logger } from "../../logger.js";
import {
  createGetTerminalOutputTool,
  createWaitForTerminalOutputTool,
} from "../terminal.js";

function clientReplying(reply: unknown): ExtensionClient {
  const client = new ExtensionClient(new Logger(false));
  vi.spyOn(
    client as unknown as { requestOrNull: () => Promise<unknown> },
    "requestOrNull",
  ).mockResolvedValue(reply);
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  return client;
}

function text(result: unknown): string {
  return (
    (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

describe("getTerminalOutput: the extension's reason reaches the caller", () => {
  it("capture unavailable is reported as such, not as 'Terminal not found'", async () => {
    const tool = createGetTerminalOutputTool(
      clientReplying({
        available: false,
        terminalName: "build",
        error:
          "Terminal output capture not available (requires VS Code proposed API onDidWriteTerminalData)",
      }),
    );
    const result = (await tool.handler({ name: "build" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("capture not available");
    expect(text(result)).not.toContain("Terminal not found");
  });

  it("no output yet is reported as such", async () => {
    const tool = createGetTerminalOutputTool(
      clientReplying({
        available: false,
        terminalName: "build",
        error: "No output captured for this terminal",
      }),
    );
    const result = await tool.handler({ name: "build" });
    expect(text(result)).toContain("No output captured");
  });

  it("a missing terminal still says so, with the name the extension saw", async () => {
    const tool = createGetTerminalOutputTool(
      clientReplying({
        available: false,
        error: 'Terminal not found with name "build"',
      }),
    );
    const result = await tool.handler({ name: "build" });
    expect(text(result)).toContain('Terminal not found with name "build"');
  });

  it("a successful read is unchanged", async () => {
    const tool = createGetTerminalOutputTool(
      clientReplying({
        available: true,
        terminalName: "build",
        lines: ["ok"],
        lineCount: 1,
      }),
    );
    const result = (await tool.handler({ name: "build" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('"ok"');
  });
});

describe("waitForTerminalOutput: a refusal is not 'did not respond'", () => {
  it("a refusal by the extension carries its reason", async () => {
    const tool = createWaitForTerminalOutputTool(
      clientReplying({
        matched: false,
        error: "No active terminal. Specify a terminal by name or index.",
      }),
    );
    const result = (await tool.handler({ pattern: "ready" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No active terminal");
    expect(text(result)).not.toContain("did not respond");
  });

  it("a timeout (no error field) is still a normal result", async () => {
    const tool = createWaitForTerminalOutputTool(
      clientReplying({ matched: false, timedOut: true, terminalName: "build" }),
    );
    const result = (await tool.handler({ pattern: "ready" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("timedOut");
  });

  it("no reply at all is still 'did not respond'", async () => {
    const tool = createWaitForTerminalOutputTool(clientReplying(null));
    const result = await tool.handler({ pattern: "ready" });
    expect(text(result)).toContain("did not respond");
  });
});
