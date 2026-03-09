import * as vscode from "vscode";

const MAX_READ_BYTES = 100 * 1024; // 100 KB
const MAX_WRITE_BYTES = 1024 * 1024; // 1 MB

export async function handleReadClipboard(): Promise<unknown> {
  const text = await vscode.env.clipboard.readText();
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength > MAX_READ_BYTES) {
    const truncated = Buffer.from(text, "utf-8").slice(0, MAX_READ_BYTES).toString("utf-8");
    return { text: truncated, byteLength, truncated: true };
  }
  return { text, byteLength, truncated: false };
}

export async function handleWriteClipboard(params: Record<string, unknown>): Promise<unknown> {
  const text = params.text;
  if (typeof text !== "string") {
    throw new Error("text is required and must be a string");
  }
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength > MAX_WRITE_BYTES) {
    throw new Error(`Text too large: ${byteLength} bytes (max ${MAX_WRITE_BYTES})`);
  }
  await vscode.env.clipboard.writeText(text);
  return { written: true, byteLength };
}
