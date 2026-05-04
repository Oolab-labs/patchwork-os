import { describe, expect, it } from "vitest";
import {
  decryptTraceBundle,
  encryptTraceBundle,
  isEncryptedTraceBundle,
  TRACE_ENCRYPT_MAGIC,
  TRACE_ENCRYPT_VERSION,
} from "../traceEncryption.js";

describe("traceEncryption", () => {
  const PASSPHRASE = "test-passphrase-12345";
  const PLAINTEXT = Buffer.from("Hello, encrypted traces!", "utf8");

  it("round-trips plaintext through encrypt → decrypt", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    const dec = decryptTraceBundle(enc, PASSPHRASE);
    expect(dec.toString("utf8")).toBe(PLAINTEXT.toString("utf8"));
  });

  it("encrypted output starts with magic bytes", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    expect(
      enc.subarray(0, TRACE_ENCRYPT_MAGIC.length).equals(TRACE_ENCRYPT_MAGIC),
    ).toBe(true);
  });

  it("encrypted output contains version byte", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    expect(enc[TRACE_ENCRYPT_MAGIC.length]).toBe(TRACE_ENCRYPT_VERSION);
  });

  it("produces different ciphertext on each call (random IV + salt)", () => {
    const enc1 = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    const enc2 = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    expect(enc1.equals(enc2)).toBe(false);
  });

  it("throws on wrong passphrase", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    expect(() => decryptTraceBundle(enc, "wrong-passphrase")).toThrow(
      /Decryption failed/,
    );
  });

  it("throws on tampered ciphertext", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    enc[enc.length - 1]! ^= 0xff;
    expect(() => decryptTraceBundle(enc, PASSPHRASE)).toThrow();
  });

  it("throws on bad magic", () => {
    // Must be >= HEADER_LEN (53) so the length check passes before magic check.
    const buf = Buffer.alloc(64, 0x42); // 64 bytes of 'B' — wrong magic
    expect(() => decryptTraceBundle(buf, PASSPHRASE)).toThrow(/magic mismatch/);
  });

  it("throws when buffer too short", () => {
    expect(() => decryptTraceBundle(Buffer.from("short"), PASSPHRASE)).toThrow(
      /too short/,
    );
  });

  it("isEncryptedTraceBundle returns true for encrypted output", () => {
    const enc = encryptTraceBundle(PLAINTEXT, PASSPHRASE);
    expect(isEncryptedTraceBundle(enc)).toBe(true);
  });

  it("isEncryptedTraceBundle returns false for plain gzip-like buffer", () => {
    const gzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(isEncryptedTraceBundle(gzip)).toBe(false);
  });

  it("isEncryptedTraceBundle returns false for empty buffer", () => {
    expect(isEncryptedTraceBundle(Buffer.alloc(0))).toBe(false);
  });

  it("round-trips binary data (simulated gzip payload)", () => {
    const gzipLike = Buffer.concat([
      Buffer.from([0x1f, 0x8b]),
      Buffer.from("fake gzip content for testing purposes"),
    ]);
    const enc = encryptTraceBundle(gzipLike, "my passphrase");
    const dec = decryptTraceBundle(enc, "my passphrase");
    expect(dec.equals(gzipLike)).toBe(true);
  });
});
