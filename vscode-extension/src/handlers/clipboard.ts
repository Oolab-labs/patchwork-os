import * as vscode from "vscode";

const MAX_READ_BYTES = 100 * 1024; // 100 KB
const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB

export async function handleReadClipboard(): Promise<unknown> {
  const text = await vscode.env.clipboard.readText();
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength > MAX_READ_BYTES) {
    // Decode with `fatal: false` (default) so a partial multi-byte sequence at
    // the truncation boundary is replaced with U+FFFD instead of throwing —
    // and so we don't corrupt earlier valid characters by returning raw bytes.
    const decoder = new TextDecoder("utf-8");
    const buf = Buffer.from(text, "utf-8").subarray(0, MAX_READ_BYTES);
    const truncated = decoder
      .decode(buf)
      // Strip a trailing replacement char so we don't leak a half-character.
      .replace(/\uFFFD$/, "");
    return { text: truncated, byteLength, truncated: true };
  }
  return { text, byteLength, truncated: false };
}

export async function handleWriteClipboard(
  params: Record<string, unknown>,
): Promise<unknown> {
  const text = params.text;
  if (typeof text !== "string") {
    throw new Error("text is required and must be a string");
  }
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength > MAX_WRITE_BYTES) {
    throw new Error(
      `Text too large: ${byteLength} bytes (max ${MAX_WRITE_BYTES})`,
    );
  }
  try {
    await vscode.env.clipboard.writeText(text);
  } catch (err) {
    return {
      written: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { written: true, byteLength };
}
