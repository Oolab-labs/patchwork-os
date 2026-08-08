/**
 * Undo must put back what was there — not a fresh claim wearing its words.
 *
 * ## The bug
 *
 * The Butler page's undo re-POSTed a plain fact to `POST /butler/facts`, and
 * that route stamps `channel: "user_chat"` unconditionally — deliberately, with
 * a comment saying the channel is not caller-supplied. Correct for a new claim
 * from a person. Wrong for an undo.
 *
 * `user_chat` carries provenance tier 1.0. `connector` carries 0.3, and
 * `ORIGINATE_THRESHOLD` is 0.6. So deleting a fact Butler had read from a
 * connector — quarantined, not yet acted on — and then pressing undo returned
 * it at **1.0**, above the threshold, as something you had said yourself.
 *
 * The undo button was a trust escalator through the exact barrier the fact
 * store exists to enforce, and the only visible difference was that the fact
 * came back.
 *
 * The permission undo had the matching defect: it re-granted from three fields
 * (`domains`, `note`, `perDay`), silently dropping `expiresAt` and
 * `ceiling.magnitudeBand`, and minted a fresh `id` and `grantedAt`. Undoing an
 * accidental revoke turned a capped, expiring grant into an uncapped permanent
 * one with no link to the original.
 *
 * ## Why restore is a store method and not a smarter client
 *
 * Every input needed to rebuild the row correctly is already on disk: `forget`
 * writes a tombstone and never removes the original. A client cannot be trusted
 * to reassemble it — it would have to know the provenance model, and any caller
 * that gets it wrong fails in the permissive direction, silently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButlerFactStore } from "../factStore.js";
import { StandingPermissionStore } from "../permissionStore.js";
import { ORIGINATE_THRESHOLD } from "../types.js";

let dir: string;
const silent = { warn: () => {} };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-restore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("factStore.restore", () => {
  it("returns a connector fact at its ORIGINAL trust, below the originate threshold", () => {
    const store = new ButlerFactStore({ dir, logger: silent });
    const original = store.remember({
      subject: "user",
      predicate: "diet.avoid",
      object: "shellfish",
      channel: "connector",
      source: "gmail",
    });
    expect(original.trust).toBeLessThan(ORIGINATE_THRESHOLD);

    const tomb = store.forget(original.seq, "user_chat");
    const restored = store.restore(tomb.seq);

    // The whole bug in one assertion: this was 1.0 (user_chat) before.
    expect(restored.provenance.channel).toBe("connector");
    expect(restored.provenance.source).toBe("gmail");
    expect(restored.trust).toBe(original.trust);
    expect(restored.trust).toBeLessThan(ORIGINATE_THRESHOLD);
  });

  it("keeps a user_confirmed fact validated", () => {
    // The other direction: restoring must not DOWNGRADE either.
    const store = new ButlerFactStore({ dir, logger: silent });
    const original = store.remember({
      subject: "user",
      predicate: "household.spouse",
      object: "Alex",
      channel: "user_confirmed",
    });
    expect(original.provenance.validated).toBe(true);

    const tomb = store.forget(original.seq);
    const restored = store.restore(tomb.seq);
    expect(restored.provenance.validated).toBe(true);
    expect(restored.trust).toBe(original.trust);
  });

  it("preserves contentConfidence rather than resetting it to 1", () => {
    const store = new ButlerFactStore({ dir, logger: silent });
    const original = store.remember({
      subject: "user",
      predicate: "travel.prefers",
      object: "aisle",
      channel: "recipe_agent",
      contentConfidence: 0.4,
    });
    const tomb = store.forget(original.seq);
    const restored = store.restore(tomb.seq);
    expect(restored.contentConfidence).toBe(0.4);
  });

  it("links the restoration to the tombstone it undoes", () => {
    // Without this the log says a fact appeared from nowhere at the moment one
    // was retracted, and cannot answer "was this put back, or re-entered?".
    const store = new ButlerFactStore({ dir, logger: silent });
    const original = store.remember({
      subject: "user",
      predicate: "x",
      object: "y",
      channel: "connector",
    });
    const tomb = store.forget(original.seq);
    const restored = store.restore(tomb.seq);
    expect(restored.supersedes).toBe(tomb.seq);
  });

  it("refuses a seq that is not a tombstone", () => {
    const store = new ButlerFactStore({ dir, logger: silent });
    const fact = store.remember({
      subject: "user",
      predicate: "x",
      object: "y",
      channel: "user_chat",
    });
    expect(() => store.restore(fact.seq)).toThrow(/not a retraction/i);
  });

  it("refuses an unknown seq", () => {
    const store = new ButlerFactStore({ dir, logger: silent });
    expect(() => store.restore(9999)).toThrow(/no fact with seq/i);
  });
});

describe("permissionStore.restore", () => {
  it("keeps the SAME grant — id, grantedAt, ceiling and expiry all survive", () => {
    const store = new StandingPermissionStore({ dir, logger: silent });
    const granted = store.grant({
      scope: { domains: ["tasks"] },
      grantedBy: "owner",
      ceiling: { perDay: 3, magnitudeBand: "band<=50" },
      expiresAt: 1_800_000_000_000,
      note: "errands",
    });

    store.revoke(granted.id);
    const restored = store.restore(granted.id);

    // Previously this minted a fresh id/grantedAt and dropped two of these.
    expect(restored.id).toBe(granted.id);
    expect(restored.grantedAt).toBe(granted.grantedAt);
    expect(restored.expiresAt).toBe(granted.expiresAt);
    expect(restored.ceiling?.perDay).toBe(3);
    expect(restored.ceiling?.magnitudeBand).toBe("band<=50");
    expect(restored.revokedAt).toBeUndefined();
  });

  it("is idempotent on a grant that was never revoked", () => {
    const store = new StandingPermissionStore({ dir, logger: silent });
    const granted = store.grant({
      scope: { domains: ["tasks"] },
      grantedBy: "owner",
    });
    const restored = store.restore(granted.id);
    expect(restored.id).toBe(granted.id);
    expect(restored.revokedAt).toBeUndefined();
  });

  it("refuses an unknown id", () => {
    const store = new StandingPermissionStore({ dir, logger: silent });
    expect(() => store.restore("nope")).toThrow(/no standing permission/i);
  });
});
