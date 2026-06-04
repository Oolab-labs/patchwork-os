/**
 * Shared UTF-8 output-cap helpers — audit 2026-06-03 (MEDIUM #30 / #57).
 *
 * The API drivers used to cap output with `text.slice(0, cap)`, which counts
 * UTF-16 code units, so a byte cap was not honored for multi-byte content and a
 * cut could split a codepoint. These pure helpers cut by UTF-8 bytes.
 */
import { describe, expect, it } from "vitest";
import { truncateToBytes, truncateUtf8Bytes } from "../outputCap.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("truncateUtf8Bytes", () => {
  it("returns the input unchanged when it fits the byte cap", () => {
    expect(truncateUtf8Bytes("hello", 10)).toBe("hello");
    expect(truncateUtf8Bytes("héllo", 10)).toBe("héllo"); // 6 bytes ≤ 10
  });

  it("caps by BYTES, not UTF-16 units — the core bug", () => {
    // 10 emoji = 10 code points (.length 20 UTF-16 units) but 40 UTF-8 bytes.
    // A char-based slice(0, 20) would keep all 10; a byte cap of 20 keeps 5.
    const s = "🚀".repeat(10);
    expect(s.length).toBe(20); // UTF-16 units
    expect(bytes(s)).toBe(40); // UTF-8 bytes
    const out = truncateUtf8Bytes(s, 20);
    expect(bytes(out)).toBeLessThanOrEqual(20);
    expect(out).toBe("🚀".repeat(5));
  });

  it("never splits a multi-byte codepoint at the boundary", () => {
    // Cap lands mid-emoji (🚀 is 4 bytes). Result must not contain U+FFFD and
    // must re-encode to ≤ cap bytes (the partial trailing codepoint is dropped).
    const s = "ab🚀";
    const out = truncateUtf8Bytes(s, 4); // "ab" = 2 bytes, then partial 🚀
    expect(out).toBe("ab");
    expect(out).not.toContain("�");
    expect(bytes(out)).toBeLessThanOrEqual(4);
  });

  it("truncates a CJK string whose char-length is under the cap but byte-length is over", () => {
    const s = "字".repeat(30); // 30 chars, 90 UTF-8 bytes
    expect(s.length).toBe(30);
    const out = truncateUtf8Bytes(s, 30);
    expect(bytes(out)).toBeLessThanOrEqual(30);
    expect(out).toBe("字".repeat(10)); // 10 × 3 bytes = 30
  });
});

describe("truncateToBytes (streaming counter)", () => {
  it("reports the actual UTF-8 byte length consumed", () => {
    const r = truncateToBytes("🚀🚀", 100);
    expect(r.send).toBe("🚀🚀");
    expect(r.bytes).toBe(8); // 2 × 4 bytes — NOT the UTF-16 length (4)
  });

  it("respects the remaining-bytes budget without splitting a codepoint", () => {
    const r = truncateToBytes("🚀🚀🚀", 6); // budget fits 1 emoji (4 bytes)
    expect(r.send).toBe("🚀");
    expect(r.bytes).toBe(4);
    expect(r.bytes).toBeLessThanOrEqual(6);
  });

  it("passes short ASCII through with its true byte length", () => {
    const r = truncateToBytes("ok", 50);
    expect(r.send).toBe("ok");
    expect(r.bytes).toBe(2);
  });
});
