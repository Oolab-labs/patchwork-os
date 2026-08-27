/**
 * The destination report must state only what the runtime can verify.
 *
 * Its whole reason to exist is that the operator's choice was invisible:
 * clearing a remote destination for `personal` has always been one line of
 * config, and nothing told anyone which destinations leave the machine or what
 * clearing one actually means.
 *
 * The tests that matter are the ones about what it must NOT say. A report that
 * claims a retention period is worse than one that says nothing, because it is
 * believed and it rots on the provider's schedule, not ours.
 */

import { describe, expect, it } from "vitest";
import type { Destination } from "../dataPolicy.js";
import {
  describeDestinations,
  disclosureFor,
  formatDestinationsReport,
  noteIsStale,
} from "../describeDestinations.js";

const local: Destination = {
  id: "local-models",
  type: "local",
  classifications: [
    "public",
    "internal",
    "personal",
    "confidential",
    "restricted",
  ],
};
const hosted: Destination = {
  id: "hosted-models",
  type: "remote",
  classifications: ["public", "internal"],
};
const hostedWide: Destination = {
  ...hosted,
  classifications: ["public", "internal", "personal"],
};

const drivers = new Map([
  ["local-models", ["local"]],
  ["hosted-models", ["anthropic", "subprocess"]],
]);

describe("describeDestinations", () => {
  it("flags a remote destination cleared above internal", () => {
    const [, h] = describeDestinations([local, hostedWide], drivers);
    expect(h?.sendsSensitiveOffMachine).toBe(true);
  });

  it("does NOT flag a remote destination cleared only to internal", () => {
    const [, h] = describeDestinations([local, hosted], drivers);
    expect(h?.sendsSensitiveOffMachine).toBe(false);
  });

  it("never flags a LOCAL destination, however widely cleared", () => {
    // local-models is cleared for `restricted`. That is not a disclosure
    // event: the data does not leave the machine.
    const [l] = describeDestinations([local, hosted], drivers);
    expect(l?.sendsSensitiveOffMachine).toBe(false);
  });
});

describe("the disclosure", () => {
  it("says the data leaves the machine, and nothing about the provider", () => {
    const [, h] = describeDestinations([local, hostedWide], drivers);
    const text = disclosureFor(h as never);
    expect(text).toMatch(/LEAVES this machine/);
    // The load-bearing assertions: claims we cannot keep must be absent.
    expect(text).not.toMatch(/retain|retention|delet|train|day|hour|GDPR/i);
  });

  it("the whole report asserts no provider behaviour", () => {
    const out = formatDestinationsReport(
      describeDestinations([local, hostedWide], drivers),
    );
    // A retention promise would rot without a code change. Nothing in the
    // report may make one.
    expect(out).not.toMatch(/\b\d+\s*(day|days|hour|hours)\b/i);
    expect(out).not.toMatch(/never used for training|is deleted|we delete/i);
    // It must still say the operator owns those claims.
    expect(out).toMatch(/provider's claims/);
  });
});

describe("operator notes", () => {
  it("reports an undated note as the operator's undated claim", () => {
    const d = describeDestinations([hostedWide], drivers, {
      notes: { "hosted-models": { note: "zero retention agreed" } },
    });
    expect(d[0]?.noteUndated).toBe(true);
    expect(noteIsStale(d[0] as never)).toBe(true);
    const out = formatDestinationsReport(d);
    expect(out).toMatch(/no reviewed date/);
  });

  it("reports a stale dated note as stale, naming the date", () => {
    const d = describeDestinations([hostedWide], drivers, {
      notes: {
        "hosted-models": {
          note: "checked the terms",
          noteReviewedOn: "2020-01-01",
        },
      },
    });
    const opts = { now: new Date("2026-08-27T00:00:00Z") };
    expect(noteIsStale(d[0] as never, opts)).toBe(true);
    expect(formatDestinationsReport(d, opts)).toMatch(/2020-01-01/);
  });

  it("leaves a recently reviewed note alone", () => {
    const d = describeDestinations([hostedWide], drivers, {
      notes: {
        "hosted-models": {
          note: "checked the terms",
          noteReviewedOn: "2026-08-01",
        },
      },
    });
    const opts = { now: new Date("2026-08-27T00:00:00Z") };
    expect(noteIsStale(d[0] as never, opts)).toBe(false);
    expect(formatDestinationsReport(d, opts)).not.toMatch(/out of date/);
  });
});

describe("the inert case", () => {
  it("says the boundary is inert, not that there are zero destinations", () => {
    // "0 destinations" invites someone to fix a number. The operator needs to
    // know what it MEANS: nothing is evaluated at all.
    const out = formatDestinationsReport(describeDestinations([], new Map()));
    expect(out).toMatch(/INERT/);
    expect(out).not.toMatch(/^\s*0\b/m);
  });

  it("says so when nothing remote can take personal data", () => {
    const out = formatDestinationsReport(
      describeDestinations([local, hosted], drivers),
    );
    expect(out).toMatch(/nowhere off-machine to go/);
  });
});
