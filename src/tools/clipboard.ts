import { execFile } from "node:child_process";
import {
  type ExtensionClient,
  ExtensionTimeoutError,
} from "../extensionClient.js";
import { error, successStructured } from "./utils.js";

const MAX_CLIPBOARD_BYTES = 100 * 1024; // 100 KB
const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB (documented limit for writeClipboard)

/**
 * Upper bound on one native clipboard command. Without it a child that never
 * exits (a cold or wedged PowerShell on a loaded Windows host, a clipboard
 * held open by another process) left the tool call pending forever, so the
 * MCP client got no reply at all. Linux may try two tools, so the worst case
 * is twice this.
 */
export const NATIVE_CLIPBOARD_TIMEOUT_MS = 3_000;

/**
 * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
 * String.slice() counts UTF-16 code units, not bytes, so for content with
 * multi-byte characters (CJK, emoji) a character-based slice can exceed the
 * byte limit by up to 4×. We walk backwards from maxBytes to find the last
 * safe character boundary.
 */
function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  // Binary-search or simple linear walk from the byte-length boundary.
  // A single character is at most 4 bytes, so start at maxBytes chars and shrink.
  let len = maxBytes;
  while (len > 0 && Buffer.byteLength(str.slice(0, len), "utf8") > maxBytes) {
    len--;
  }
  return str.slice(0, len);
}

/**
 * Run a native clipboard command, optionally piping `input` to stdin.
 * Rejects (and kills the child) after NATIVE_CLIPBOARD_TIMEOUT_MS. The bound
 * is our own timer rather than execFile's `timeout` option, because that
 * option only settles once the killed child actually exits.
 */
function runNative(
  cmd: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const proc = execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(String(stdout));
    });
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${cmd} timed out`));
    }, NATIVE_CLIPBOARD_TIMEOUT_MS);
    if (input !== undefined) proc.stdin?.end(input);
  });
}

/** Read clipboard text using platform-native CLI tools. */
async function nativeReadClipboard(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const stdout = await runNative("pbpaste", []);
      return truncateToBytes(stdout, MAX_CLIPBOARD_BYTES);
    }
    if (process.platform === "linux") {
      // xclip preferred; fall back to xsel
      try {
        const stdout = await runNative("xclip", [
          "-selection",
          "clipboard",
          "-o",
        ]);
        return truncateToBytes(stdout, MAX_CLIPBOARD_BYTES);
      } catch {
        const stdout = await runNative("xsel", ["--clipboard", "--output"]);
        return truncateToBytes(stdout, MAX_CLIPBOARD_BYTES);
      }
    }
    if (process.platform === "win32") {
      const stdout = await runNative("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Clipboard",
      ]);
      return truncateToBytes(stdout, MAX_CLIPBOARD_BYTES);
    }
  } catch {
    // tool not available, clipboard empty, or timed out
  }
  return null;
}

/** Write clipboard text using platform-native CLI tools. */
async function nativeWriteClipboard(text: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await runNative("pbcopy", [], text);
      return true;
    }
    if (process.platform === "linux") {
      try {
        await runNative("xclip", ["-selection", "clipboard"], text);
      } catch {
        await runNative("xsel", ["--clipboard", "--input"], text);
      }
      return true;
    }
    if (process.platform === "win32") {
      // Use clip.exe — ships with all Windows versions
      await runNative("clip", [], text);
      return true;
    }
  } catch {
    // tool not available or timed out
  }
  return false;
}

export function createReadClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "readClipboard",
      description: "Read system clipboard. Returns up to 100 KB of text.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    async handler() {
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.readClipboard();
          if (result !== null) return successStructured(result);
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
      return successStructured({ text: result });
    },
  };
}

export function createWriteClipboardTool(extensionClient: ExtensionClient) {
  return {
    schema: {
      name: "writeClipboard",
      description: "Write text to system clipboard. Max 1 MB.",
      annotations: { idempotentHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object" as const,
        required: ["text"],
        properties: {
          text: {
            type: "string" as const,
            description: "Text to write to clipboard",
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
        },
        required: ["success"],
      },
    },
    async handler(args: Record<string, unknown>) {
      const text = args.text;
      if (typeof text !== "string") return error("text is required");
      if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES)
        return error(
          `text exceeds the 1 MB clipboard write limit (${Buffer.byteLength(text, "utf8")} bytes)`,
        );
      if (extensionClient.isConnected()) {
        try {
          const result = await extensionClient.writeClipboard(text);
          // Extension handler returns { written, byteLength } or
          // { written: false, error }. Normalize to the tool's declared
          // schema shape (required: success).
          if (result !== null && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.written === true) {
              return successStructured({
                success: true,
                ...(typeof r.byteLength === "number" && {
                  byteLength: r.byteLength,
                }),
              });
            }
            if (r.written === false) {
              return error(
                typeof r.error === "string"
                  ? r.error
                  : "Clipboard write failed",
              );
            }
          }
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
      return successStructured({ success: true });
    },
  };
}
