/**
 * Shared UTF-8-aware output truncation for driver results.
 *
 * Audit 2026-06-03 (MEDIUM #30): the API drivers (claude/api, openai, gemini)
 * capped output with `text.slice(0, OUTPUT_CAP)`, which counts UTF-16 code
 * units — so a 50K "byte" cap could emit ~200KB of UTF-8 wire bytes for CJK /
 * emoji content and could leave a lone surrogate at the boundary. These
 * helpers (previously private to claude/subprocess.ts) measure and cut by
 * UTF-8 bytes. Shared so every driver path uses one implementation.
 */

/**
 * Largest byte length ≤ `cap` that ends on a UTF-8 codepoint boundary. UTF-8
 * continuation bytes match `0b10xxxxxx`; if the byte at the cut is one, we're
 * mid-sequence, so back off to the preceding lead byte. This drops a partial
 * trailing codepoint cleanly (no U+FFFD, no lone surrogate, never over `cap`).
 */
function codepointBoundary(buf: Buffer, cap: number): number {
  let end = cap;
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Truncate `text` to at most `cap` UTF-8 bytes without splitting a multi-byte
 * codepoint. `String.slice(0, cap)` counts UTF-16 code units, so a 50K cap can
 * emit ~200KB of UTF-8 wire bytes for CJK / emoji content; this cuts by bytes
 * at a codepoint boundary.
 */
export function truncateUtf8Bytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  return buf.subarray(0, codepointBoundary(buf, cap)).toString("utf8");
}

/**
 * Truncate `text` so it adds at most `remaining` UTF-8 bytes to a stream and
 * never splits a multi-byte codepoint. Returns the safely-truncated slice plus
 * its actual byte length so a running byte total can be advanced correctly
 * (used by the streaming accumulators).
 */
export function truncateToBytes(
  text: string,
  remaining: number,
): { send: string; bytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= remaining) return { send: text, bytes: buf.length };
  const send = buf
    .subarray(0, codepointBoundary(buf, remaining))
    .toString("utf8");
  return { send, bytes: Buffer.byteLength(send, "utf8") };
}
