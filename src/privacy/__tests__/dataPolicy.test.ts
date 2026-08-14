import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLASSIFICATION,
  type Destination,
  decideBoundary,
  narrowest,
  parseDataPolicy,
} from "../dataPolicy.js";

// Every fixture here is synthetic. ADR-0021's own warning applies with force to
// its tests: a privacy engine that leaks real names in its test data is the
// sharpest possible own goal.
const LOCAL: Destination = {
  id: "local-model",
  type: "local",
  classifications: [
    "public",
    "internal",
    "personal",
    "confidential",
    "restricted",
  ],
};
const REMOTE: Destination = {
  id: "remote-model",
  type: "remote",
  classifications: ["public", "internal"],
};

describe("decideBoundary — the five outcomes", () => {
  it("ALLOWs what the destination is cleared for", () => {
    const out = decideBoundary({ classification: "internal" }, REMOTE);
    expect(out.decision).toBe("ALLOW");
  });

  it("routes LOCAL_ONLY when a local destination could take it", () => {
    // Not a failure — the data may be processed, just not there. The caller is
    // expected to retry locally rather than fail the step.
    const out = decideBoundary({ classification: "confidential" }, REMOTE, {
      localDestinationAccepts: true,
    });
    expect(out.decision).toBe("LOCAL_ONLY");
  });

  it("REQUIRE_APPROVALs when the destination is approvable and no local path exists", () => {
    const out = decideBoundary(
      { classification: "confidential" },
      {
        ...REMOTE,
        approvable: true,
      },
    );
    expect(out.decision).toBe("REQUIRE_APPROVAL");
  });

  it("DENIes when not cleared, not approvable, and no local path", () => {
    const out = decideBoundary({ classification: "restricted" }, REMOTE);
    expect(out.decision).toBe("DENY");
    // DENY must mean "no approval unlocks this", exactly as the autonomy gate's
    // `forbid` does — otherwise the two vocabularies disagree.
    expect(out.reason).toMatch(/no approval/i);
  });

  it("ALLOW_REDACTEDs a forbidden category on an otherwise-cleared destination", () => {
    const out = decideBoundary(
      { classification: "internal", categories: ["alpha", "beta"] },
      { ...REMOTE, forbiddenCategories: ["beta"] },
    );
    expect(out.decision).toBe("ALLOW_REDACTED");
    expect(out.redactCategories).toEqual(["beta"]);
  });

  it("does NOT let redaction rescue an uncleared classification", () => {
    // The ordering guarantee. Dropping a tag does not declassify what remains,
    // so a destination must never become cleared by redacting a category.
    const out = decideBoundary(
      { classification: "restricted", categories: ["beta"] },
      { ...REMOTE, forbiddenCategories: ["beta"] },
    );
    expect(out.decision).toBe("DENY");
    expect(out.redactCategories).toBeUndefined();
  });

  it("clears a local destination for everything it declares", () => {
    for (const c of [
      "public",
      "internal",
      "personal",
      "confidential",
      "restricted",
    ] as const) {
      expect(decideBoundary({ classification: c }, LOCAL).decision).toBe(
        "ALLOW",
      );
    }
  });

  it("never contains the payload in the reason", () => {
    const out = decideBoundary(
      { classification: "restricted", categories: ["secret-tag"] },
      REMOTE,
    );
    // The reason is shown to humans and written to receipts; it may name the
    // policy, never the data.
    expect(out.reason).not.toContain("secret-tag");
  });
});

describe("parseDataPolicy — declared, and fail closed on a typo", () => {
  it("defaults an absent policy to internal, so existing recipes are unaffected", () => {
    expect(parseDataPolicy(undefined)).toEqual({
      classification: DEFAULT_CLASSIFICATION,
    });
    expect(DEFAULT_CLASSIFICATION).toBe("internal");
  });

  it("returns null for an unrecognised classification rather than defaulting it", () => {
    // The failure a declared-labels scheme cannot afford: the operator believes
    // they labelled it and the system believes they did not. `confidentail`
    // must not sail through as ordinary internal data.
    expect(parseDataPolicy({ classification: "confidentail" })).toBeNull();
    expect(parseDataPolicy({ classification: 7 })).toBeNull();
    expect(parseDataPolicy("nonsense")).toBeNull();
  });

  it("keeps declared categories and drops non-strings", () => {
    expect(
      parseDataPolicy({
        classification: "confidential",
        categories: ["alpha", 3, "beta"],
      }),
    ).toEqual({
      classification: "confidential",
      categories: ["alpha", "beta"],
    });
  });
});

describe("narrowest — never widen", () => {
  it("takes the more restrictive of two decisions regardless of order", () => {
    const allow = decideBoundary({ classification: "internal" }, REMOTE);
    const deny = decideBoundary({ classification: "restricted" }, REMOTE);
    expect(narrowest(allow, deny).decision).toBe("DENY");
    expect(narrowest(deny, allow).decision).toBe("DENY");
  });

  it("orders every decision so a later stage cannot restore removed context", () => {
    const mk = (d: string) => ({ decision: d, reason: "" }) as never;
    const order = [
      "ALLOW",
      "ALLOW_REDACTED",
      "LOCAL_ONLY",
      "REQUIRE_APPROVAL",
      "DENY",
    ];
    for (let i = 0; i < order.length - 1; i++) {
      const looser = mk(order[i] as string);
      const tighter = mk(order[i + 1] as string);
      expect(narrowest(looser, tighter).decision).toBe(order[i + 1]);
    }
  });
});
