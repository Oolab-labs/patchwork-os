/**
 * The `patchwork-os/privacy` seam — the same two guards as the gate barrel,
 * plus one this engine needs and the gate does not.
 *
 * The extra one is `carries localDestinationAccepts through to the decision`.
 * `resolveDestination` returns that flag alongside the destination and BOTH
 * must reach `decideBoundary`; dropping the second turns `LOCAL_ONLY` ("a local
 * destination accepts this — set `driver: local`") into `DENY` ("no approval
 * can unlock it"). Nothing leaks either way, which is exactly why that defect
 * survives review — it is wrong in the SENTENCE, telling an operator their
 * situation is unfixable while a registered local destination would take the
 * data. It has already happened once in this repository.
 *
 * A barrel cannot enforce that its consumers pass the flag. What it can do is
 * make sure both halves are exported and that the behaviour they produce
 * together is pinned here, so a consumer has something to check itself against.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as dataPolicy from "../privacy/dataPolicy.js";
import * as describeDestinations from "../privacy/describeDestinations.js";
import * as destinationRegistry from "../privacy/destinationRegistry.js";
import * as privacy from "../privacy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(here, "..", "..", "package.json"), "utf8"),
) as {
  files: string[];
  exports: Record<string, { import: string; types: string } | undefined>;
};

describe("the ./privacy subpath export", () => {
  it("is declared in the export map", () => {
    expect(pkg.exports["./privacy"]).toEqual({
      import: "./dist/privacy.js",
      types: "./dist/privacy.d.ts",
    });
  });

  it("points at a path the tarball actually carries", () => {
    const entry = pkg.exports["./privacy"];
    expect(entry).toBeDefined();
    expect(pkg.files).toContain("dist");

    const target = (entry?.import ?? "").replace(/^\.\//, "");
    // Guard the guard: an empty target satisfies every negation vacuously.
    expect(target).not.toBe("");

    for (const negated of pkg.files.filter((f) => f.startsWith("!"))) {
      expect(target).not.toMatch(
        new RegExp(`^${negated.slice(1).replace(/\*\*?/g, ".*")}$`),
      );
    }
  });
});

describe("the barrel is a pass-through, not an implementation", () => {
  const sources: Array<[string, Record<string, unknown>]> = [
    ["dataPolicy", dataPolicy],
    ["destinationRegistry", destinationRegistry],
    ["describeDestinations", describeDestinations],
  ];

  it("re-exports the identical symbol, never a wrapper", () => {
    const checked: string[] = [];
    for (const [name, mod] of sources) {
      for (const [key, value] of Object.entries(mod)) {
        if (!Object.hasOwn(privacy, key)) continue;
        expect(
          (privacy as Record<string, unknown>)[key],
          `${name}.${key} is re-exported by privacy.ts as a different value — ` +
            "a barrel that adapts is a second implementation of the boundary",
        ).toBe(value);
        checked.push(key);
      }
    }
    // A pass-through test that compared nothing would pass on an empty barrel.
    expect(checked.length).toBeGreaterThan(10);
  });

  it("exports the decision surface and none of the writers", () => {
    for (const required of [
      "decideBoundary",
      "parseDataPolicy",
      "resolveDestination",
      "parseRegistry",
      "describeDestinations",
      "disclosureFor",
      "narrowest",
      "CLASSIFICATIONS",
      "DEFAULT_CLASSIFICATION",
    ]) {
      expect(
        Object.hasOwn(privacy, required),
        `privacy.ts no longer exports ${required}`,
      ).toBe(true);
    }
    // Scope is the decision, not the ledger. A console asks questions; the
    // runtime remains the only thing that records.
    for (const forbidden of [
      "BoundaryReceiptLog",
      "sharedBoundaryReceiptLog",
      "PrivacyShadowLog",
    ]) {
      expect(
        Object.hasOwn(privacy, forbidden),
        `privacy.ts exports ${forbidden}, which writes a ledger`,
      ).toBe(false);
    }
  });
});

describe("the two halves of a resolution belong together", () => {
  // `PrivacyConfig.destinations` is a RECORD keyed by id, not an array. The
  // first version of this test passed an array; it went green because
  // `parseRegistry` iterates entries either way and `resolveDestination` falls
  // back rather than returning null on an unrecognised driver — so the
  // destinations were silently named "0" and "1" and the assertions held for
  // the wrong reason. The core test ratchet caught it; vitest alone did not.
  const registry = privacy.parseRegistry({
    destinations: {
      "local-host": {
        type: "local",
        classifications: ["confidential"],
        drivers: ["local"],
      },
      "remote-api": {
        type: "remote",
        classifications: ["internal"],
        drivers: ["remote-api"],
      },
    },
  });

  it("resolves the destination the config actually named", () => {
    // Pins the fix above: if the registry is mis-shaped again, the id changes
    // and this fails rather than passing on a synthetic entry.
    expect(registry.invalid).toEqual([]);
    expect(registry.destinations.map((d) => d.id).sort()).toEqual([
      "local-host",
      "remote-api",
    ]);
  });

  it("carries localDestinationAccepts through to the decision", () => {
    const resolved = privacy.resolveDestination(
      registry,
      "remote-api",
      "confidential",
    );
    expect(resolved?.destination.id).toBe("remote-api");
    if (!resolved) return;

    // Passing BOTH halves: the operator is told what to do about it.
    const withFlag = privacy.decideBoundary(
      { classification: "confidential" },
      resolved.destination,
      { localDestinationAccepts: resolved.localDestinationAccepts },
    );

    // Dropping the flag: the same policy now says the situation is unfixable.
    const withoutFlag = privacy.decideBoundary(
      { classification: "confidential" },
      resolved.destination,
    );

    expect(resolved.localDestinationAccepts).toBe(true);
    expect(withFlag.decision).toBe("LOCAL_ONLY");
    expect(withoutFlag.decision).toBe("DENY");
    // Named explicitly so the difference cannot be read as cosmetic: one of
    // these tells the operator to set `driver: local`, the other tells them no
    // approval can unlock it. Same data, same policy, opposite advice.
    expect(withFlag.decision).not.toBe(withoutFlag.decision);
  });

  it("still refuses when nothing local accepts the classification", () => {
    // The flag is not a way to soften every refusal — it only reroutes when a
    // local destination genuinely takes the data.
    const narrow = privacy.parseRegistry({
      destinations: {
        "remote-api": {
          type: "remote",
          classifications: ["internal"],
          drivers: ["remote-api"],
        },
      },
    });
    const resolved = privacy.resolveDestination(
      narrow,
      "remote-api",
      "restricted",
    );
    expect(resolved?.destination.id).toBe("remote-api");
    expect(resolved?.localDestinationAccepts).toBe(false);
    if (!resolved) return;
    const outcome = privacy.decideBoundary(
      { classification: "restricted" },
      resolved.destination,
      { localDestinationAccepts: resolved.localDestinationAccepts },
    );
    expect(outcome.decision).toBe("DENY");
  });
});
