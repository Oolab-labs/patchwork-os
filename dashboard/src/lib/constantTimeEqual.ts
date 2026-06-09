import crypto from "node:crypto";

/**
 * Constant-time string equality via a fixed-length padded compare.
 *
 * Audit 2026-06-08 (HIGH, dash-api-1): the relay routes had their own copy of
 * this logic that padded into a 256-byte buffer but SKIPPED the copy when an
 * input exceeded the pad (`if (a.length <= PAD) a.copy(pa)`), leaving the
 * buffer all-zeros. Two >256-byte inputs of equal length then both compared
 * as all-zeros, so timingSafeEqual returned true and any same-length payload
 * authenticated. login/route.ts was fixed for this class (HIGH #2) but the
 * relays drifted. This is the single shared implementation so they can't
 * diverge again.
 *
 * Correct shape: always copy up to CAP into equal-sized buffers (Buffer.copy
 * bounds at min(src.length, CAP) so there is no overflow and — for accepted
 * inputs — no all-zero collision), run timingSafeEqual over the FULL CAP every
 * call, then AND the length/cap checks AFTER (never short-circuited before
 * timingSafeEqual) so response time does not leak the expected length
 * (Audit 2026-05-17 / #600 property).
 *
 * Plain equality of a single shared secret from env — NOT password-at-rest
 * hashing. Deliberately no hash/KDF in the data path.
 */
export function constantTimeEqual(
  presented: string,
  expected: string,
  cap = 1024,
): boolean {
  if (expected.length === 0) return false;
  const ab = Buffer.from(presented, "utf8");
  const eb = Buffer.from(expected, "utf8");
  const pa = Buffer.alloc(cap);
  const pb = Buffer.alloc(cap);
  ab.copy(pa, 0, 0, cap);
  eb.copy(pb, 0, 0, cap);
  const bytesEqual = crypto.timingSafeEqual(pa, pb);
  return (
    bytesEqual && ab.length === eb.length && ab.length <= cap && eb.length <= cap
  );
}

/**
 * Verify an `Authorization: Bearer <token>` header against an expected secret
 * in constant time. Fails closed when the expected secret is empty/unset.
 */
export function verifyBearerToken(req: Request, expected: string): boolean {
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), expected);
}
