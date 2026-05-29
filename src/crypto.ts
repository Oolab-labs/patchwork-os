/**
 * Shared cryptographic utilities for claude-ide-bridge.
 */

import crypto from "node:crypto";

/**
 * Constant-time string comparison that does not leak length or content
 * information via timing side-channels.
 *
 * Both the byte content and the length are compared with
 * `crypto.timingSafeEqual`. Crucially, **both** comparisons are always
 * executed before the result is computed — the booleans are stored first,
 * then combined with `&&`. This prevents the JS short-circuit `&&` operator
 * from skipping the length check when the byte comparison fails, which would
 * allow an attacker to distinguish "wrong length" from "right length, wrong
 * bytes" via timing.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  // Encode as UTF-16LE (Node's native string representation) so the comparison
  // is over the actual JS code units. UTF-8 encoding is NOT injective for
  // ill-formed strings: two distinct strings containing lone surrogates can
  // produce identical UTF-8 byte sequences (both surrogates → U+FFFD → same bytes),
  // causing a false equality. UTF-16LE preserves each code unit exactly.
  const bA = Buffer.from(a, "utf16le");
  const bB = Buffer.from(b, "utf16le");
  const len = Math.max(bA.length, bB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bA.copy(padA);
  bB.copy(padB);
  const lenA = Buffer.allocUnsafe(4);
  const lenB = Buffer.allocUnsafe(4);
  lenA.writeUInt32BE(bA.length, 0);
  lenB.writeUInt32BE(bB.length, 0);
  // Pre-compute both results before combining — never short-circuit.
  const bytesOk = crypto.timingSafeEqual(padA, padB);
  const lenOk = crypto.timingSafeEqual(lenA, lenB);
  return bytesOk && lenOk;
}
