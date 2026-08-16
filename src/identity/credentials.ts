/**
 * Per-member local credentials — ADR-0020 Phase A.
 *
 * ## Why this exists
 *
 * `canApproveAction` is referenced by nothing in production, and not because
 * anyone forgot. The bridge authenticates ONE shared bearer token, and the
 * dashboard session cookie's signed payload is literally `v1.${expiresAt}` —
 * not "no subject field" but no field except expiry. Every approver is
 * indistinguishable at the auth layer, so segregation of duties is
 * unenforceable rather than merely unimplemented, and no decision record can
 * honestly name a person.
 *
 * ## `crypto.scrypt`, from the standard library
 *
 * The dependency audit is unambiguous: no bcrypt, argon2, passport, next-auth
 * or jose in this tree, direct or dev. Adding a native-compilation
 * password-hashing dependency to a project that installs globally on macOS,
 * Linux and Windows — and which already documents a macOS TCC symlink footgun
 * around global installs — buys a marginally better KDF for a real
 * cross-platform install risk. scrypt is memory-hard, in the standard library,
 * and present in every runtime the bridge already targets.
 *
 * ## What this module does NOT do
 *
 * It does not read the roster, does not decide authorisation, and does not
 * touch the dashboard cookie. Verifying a secret and deciding what somebody
 * may do are different questions, and the cookie change touches ten consumers
 * and wants its own review. This is the half with no blast radius.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters, stored per-hash rather than assumed.
 *
 * Encoding them in the record is what makes them changeable later: a stored
 * hash that does not say how it was derived can only be verified by a
 * constant, so raising the cost would silently invalidate every existing
 * credential instead of upgrading it.
 *
 * N=2^15 with r=8, p=1 is ~32 MB of memory per verification. `maxmem` must be
 * raised above Node's 32 MB default or scrypt throws at these parameters —
 * a footgun that presents as "the correct password is rejected".
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEYLEN = 64;
const MAXMEM = 192 * 1024 * 1024;

/** Serialised credential: `scrypt$N$r$p$<saltB64>$<hashB64>`. */
export type CredentialRecord = string;

const PREFIX = "scrypt";

/** Hash a password for storage. A fresh 16-byte salt per call. */
export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = SCRYPT_PARAMS,
): Promise<CredentialRecord> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, {
    ...params,
    maxmem: MAXMEM,
  });
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** Parsed form of a stored record, or null when it is not one. */
function parseRecord(record: string): {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
} | null {
  if (typeof record !== "string") return null;
  const parts = record.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  // Bound the work a stored record can demand. Without this, anyone who can
  // write members.json can make one verification consume unbounded CPU and
  // memory — a denial of service authored in a config file.
  if (N < 16384 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    return null;
  }
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(saltRaw ?? "", "base64");
    hash = Buffer.from(hashRaw ?? "", "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length !== KEYLEN) return null;
  return { N, r, p, salt, hash };
}

/**
 * Verify a password against a stored record.
 *
 * Returns false for a malformed record rather than throwing: a corrupt
 * credential must read as "this password is wrong", not as an exception a
 * caller might catch and treat as a pass. It is the same fail-closed reasoning
 * as ADR-0016 — deciding whether an action happens defaults to no.
 *
 * The comparison is `timingSafeEqual` on the derived key. Lengths are checked
 * first because it throws on a length mismatch, and a thrown comparison is a
 * timing signal of its own.
 */
export async function verifyPassword(
  password: string,
  record: CredentialRecord,
): Promise<boolean> {
  const parsed = parseRecord(record);
  if (!parsed) return false;
  if (typeof password !== "string" || password.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(password, parsed.salt, KEYLEN, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/** True when a string is a well-formed credential record. */
export function isCredentialRecord(value: unknown): value is CredentialRecord {
  return typeof value === "string" && parseRecord(value) !== null;
}
