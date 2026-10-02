/**
 * Security sweep L8: new credentials hash at N=2^17 (OWASP's scrypt floor),
 * while records written at the old N=2^15 keep verifying — parameters are
 * stored per record precisely so the cost can rise without invalidating
 * anyone.
 *
 * The unknown-member path verifies against a dummy record so that "no such
 * member" costs the same as "wrong password". That dummy must track the
 * default cost: if new hashes rose to 2^17 and the dummy stayed at 2^15, an
 * unknown member would answer ~4x faster — a member-existence oracle.
 */
import { describe, expect, it } from "vitest";
import { DUMMY_RECORD } from "../authSeam.js";
import {
  hashPassword,
  isCredentialRecord,
  SCRYPT_PARAMS,
  verifyPassword,
} from "../credentials.js";

describe("scrypt cost (L8)", () => {
  it("defaults to N=2^17, r=8, p=1", () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it("new records encode the new cost and verify", async () => {
    const rec = await hashPassword("correct horse");
    expect(rec.split("$").slice(1, 4)).toEqual(["131072", "8", "1"]);
    expect(await verifyPassword("correct horse", rec)).toBe(true);
    expect(await verifyPassword("wrong", rec)).toBe(false);
  });

  it("a record written at the old N=2^15 still verifies", async () => {
    const old = await hashPassword("legacy pw", { N: 32768, r: 8, p: 1 });
    expect(await verifyPassword("legacy pw", old)).toBe(true);
  });

  it("the unknown-member dummy record uses the default cost", () => {
    const [, n, r, p] = DUMMY_RECORD.split("$");
    expect({ N: Number(n), r: Number(r), p: Number(p) }).toEqual(SCRYPT_PARAMS);
  });

  it("the dummy record is well-formed, so it really runs scrypt", async () => {
    // Pre-L8 the dummy hash decoded to 63 bytes, the parser rejected it, and
    // verifyPassword returned false WITHOUT deriving anything: an unknown
    // member answered instantly. Assert it parses AND costs real time.
    expect(isCredentialRecord(DUMMY_RECORD)).toBe(true);
    const t0 = performance.now();
    expect(await verifyPassword("anything", DUMMY_RECORD)).toBe(false);
    expect(performance.now() - t0).toBeGreaterThan(20);
  });
});
