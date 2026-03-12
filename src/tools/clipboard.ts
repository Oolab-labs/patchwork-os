import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, success } from "./utils.js";

const execFileAsync = promisify(execFile);

const MAX_CLIPBOARD_BYTES = 100 * 1024; // 100 KB

/** Read clipboard text using platform-native CLI tools. */
async function nativeReadClipboard(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("pbpaste");
      return stdout.slice(0, MAX_CLIPBOARD_BYTES);
    }
    if (process.platform === "linux") {
      // xclip preferred; fall back to xsel
      try {
        const { stdout } = await execFileAsync("xclip", [
          "-selection",
          "clipboard",
          "-o",
        ]);
        return stdout.slice(0, MAX_CLIPBOARD_BYTES);
      } catch {
        const { stdout } = await execFileAsync("xsel", [
          "--clipboard",
          "--output",
        ]);
        return stdout.slice(0, MAX_CLIPBOARD_BYTES);
      }
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Clipboard",
      ]);
      return stdout.slice(0, MAX_CLIPBOARD_BYTES);
    }
  } catch {
    // tool not available or clipboard empty
  }
  return null;
}

/** Write clipboard text using platform-native CLI tools. */
async function nativeWriteClipboard(text: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        const proc = execFile("pbcopy", (err) =>
          err ? reject(err) : resolve(),
        );
        proc.stdin?.end(text);
      });
      return true;
    }
    if (process.platform === "linux") {
      const writeVia = async (cmd: string, args: string[]) => {
        await new Promise<void>((resolve, reject) => {
          const proc = execFile(cmd, args, (err) =>
            err ? reject(err) : resolve(),
          );
          proc.stdin?.end(text);
        });
      };
      try {
        await writeVia("xclip", ["-selection", "clipboard"]);
      } catch {
        await writeVia("xsel", ["--clipboard", "--input"]);
      }
      return true;
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        // Use clip.exe — ships with all Windows versions
        const proc = execFile("clip", (err) => (err ? reject(err) : resolve()));
        proc.stdin?.end(text);
      });
      return true;
    }
  } catch {
    // tool not available
  }
  return false;
}

export function createReadClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "readClipboard",
      description:
        "Read the current contents of the system clipboard. " +
        "Returns up to 100 KB of text. Useful for reading error messages, stack traces, " +
        "or code snippets the user has copied.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
    },
    async handler() {
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.readClipboard();
          if (result !== null) return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
        }
      }
      // Native fallback: pbpaste / xclip / xsel / powershell
      const result = await nativeReadClipboard();
      if (result === null)
        return error(
          "Clipboard unavailable — VS Code extension not connected and no native clipboard tool found",
        );
      return success(result);
    },
  };
}

export function createWriteClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "writeClipboard",
      description:
        "Write text to the system clipboard. " +
        "Useful for placing formatted output, transformed snippets, or summaries " +
        "directly on the clipboard for the user to paste. Max 1 MB.",
      annotations: { idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["text"],
        properties: {
          text: {
            type: "string" as const,
            description: "Text to write to the clipboard",
          },
        },
        additionalProperties: false as const,
      },
    },
    async handler(args: Record<string, unknown>) {
      const text = args.text;
      if (typeof text !== "string") return error("text is required");
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.writeClipboard(text);
          if (result !== null) return success(result);
        } catch (err) {
          if (!(err instanceof ExtensionTimeoutError)) throw err;
        }
      }
      // Native fallback: pbcopy / xclip / xsel / clip.exe
      const ok = await nativeWriteClipboard(text);
      if (!ok)
        return error(
          "Clipboard unavailable — VS Code extension not connected and no native clipboard tool found",
        );
      return success({ success: true });
    },
  };
}
