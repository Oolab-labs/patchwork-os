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
  const bA = Buffer.from(a);
  const bB = Buffer.from(b);
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
