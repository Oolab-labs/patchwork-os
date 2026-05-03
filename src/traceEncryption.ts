/**
 * Trace bundle encryption/decryption — AES-256-GCM with scrypt KDF.
 *
 * Binary format (all multi-byte values big-endian):
 *
 *   Offset  Len  Field
 *   0       8    Magic: ASCII "PWTRACE\0"
 *   8       1    Version: 0x01
 *   9       16   Salt (random, for scrypt)
 *   25      12   IV / nonce (random, for AES-GCM)
 *   37      16   GCM authentication tag
 *   53      N    Ciphertext (the original .jsonl.gz bytes)
 *
 * Key derivation: scrypt(passphrase, salt, N=16384, r=8, p=1, keyLen=32).
 * N=2^14 matches Node's `crypto.scryptSync` default and is safe for
 * interactive use on a modern laptop (~50ms, 16MB RAM). They are stored implicitly
 * (fixed); changing them is a version bump.
 *
 * Security properties:
 * - Unique salt per export → unique key per file even with the same passphrase.
 * - GCM authentication tag → any tamper of ciphertext or header is detected.
 * - scrypt → GPU-resistant brute-force on passphrase.
 * - Buffer.fill(0) on key material after use → minimise in-process lifetime.
 *
 * The encrypted file is NOT gzip-compressed on top (the plaintext already
 * is). Compressing ciphertext adds no size benefit and obscures the magic
 * header used by the import command to auto-detect the format.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export const TRACE_ENCRYPT_MAGIC = Buffer.from("PWTRACE\0", "ascii");
export const TRACE_ENCRYPT_VERSION = 0x01;

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = TRACE_ENCRYPT_MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN; // 53

const SCRYPT_N = 16384; // 2^14 — Node scryptSync default; needs 128*N*r = 16MB RAM
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Encrypt a Buffer (the gzip-compressed trace bundle) with a passphrase.
 * Returns a new Buffer in the wire format described above.
 */
export function encryptTraceBundle(
  plaintext: Buffer,
  passphrase: string,
): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_LEN);
    let offset = 0;
    TRACE_ENCRYPT_MAGIC.copy(header, offset);
    offset += TRACE_ENCRYPT_MAGIC.length;
    header[offset++] = TRACE_ENCRYPT_VERSION;
    salt.copy(header, offset);
    offset += SALT_LEN;
    iv.copy(header, offset);
    offset += IV_LEN;
    tag.copy(header, offset);

    return Buffer.concat([header, encrypted]);
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt a Buffer that was produced by `encryptTraceBundle`.
 * Returns the original plaintext (the gzip-compressed trace bundle).
 * Throws if the magic, version, or GCM tag don't match.
 */
export function decryptTraceBundle(
  ciphertext: Buffer,
  passphrase: string,
): Buffer {
  if (ciphertext.length < HEADER_LEN) {
    throw new Error("Trace bundle too short to be a valid encrypted file");
  }

  const magic = ciphertext.subarray(0, TRACE_ENCRYPT_MAGIC.length);
  if (!magic.equals(TRACE_ENCRYPT_MAGIC)) {
    throw new Error("Not an encrypted Patchwork trace bundle (magic mismatch)");
  }

  const version = ciphertext[TRACE_ENCRYPT_MAGIC.length];
  if (version !== TRACE_ENCRYPT_VERSION) {
    throw new Error(
      `Unsupported encrypted bundle version: 0x${version?.toString(16) ?? "??"} (expected 0x01)`,
    );
  }

  let offset = TRACE_ENCRYPT_MAGIC.length + 1;
  const salt = ciphertext.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = ciphertext.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = ciphertext.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const encrypted = ciphertext.subarray(offset);

  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted file");
  } finally {
    key.fill(0);
  }
}

/**
 * Returns true if the buffer starts with the encrypted trace bundle magic.
 * Use this to auto-detect encrypted bundles at import time.
 */
export function isEncryptedTraceBundle(buf: Buffer): boolean {
  if (buf.length < TRACE_ENCRYPT_MAGIC.length) return false;
  return buf
    .subarray(0, TRACE_ENCRYPT_MAGIC.length)
    .equals(TRACE_ENCRYPT_MAGIC);
}
