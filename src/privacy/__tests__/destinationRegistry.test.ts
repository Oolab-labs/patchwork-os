import { describe, expect, it } from "vitest";

import { parseRegistry, resolveDestination } from "../destinationRegistry.js";

// Synthetic throughout — see the note in dataPolicy.test.ts.
const CFG = {
  destinations: {
    "local-profile": {
      type: "local",
      classifications: [
        "public",
        "internal",
        "personal",
        "confidential",
        "restricted",
      ],
      drivers: ["local", "ollama"],
    },
    "remote-wide": {
      type: "remote",
      classifications: ["public", "internal", "personal"],
      drivers: ["anthropic"],
    },
    "remote-narrow": {
      type: "remote",
      classifications: ["public"],
      drivers: ["thirdparty"],
    },
  },
};

describe("parseRegistry", () => {
  it("parses valid destinations", () => {
    const r = parseRegistry(CFG);
    expect(r.destinations.map((d) => d.id).sort()).toEqual([
      "local-profile",
      "remote-narrow",
      "remote-wide",
    ]);
    expect(r.invalid).toEqual([]);
  });

  it("REPORTS a malformed destination instead of dropping it", () => {
    // A destination that silently vanishes downgrades enforcement to "no
    // destination" — the one direction this must never fail in.
    const r = parseRegistry({
      destinations: {
        broken: { type: "sideways", classifications: ["public"] },
        alsoBroken: { type: "remote", classifications: ["nonsense"] },
        missing: { type: "remote" },
      },
    });
    expect(r.destinations).toEqual([]);
    expect(r.invalid.map((i) => i.id).sort()).toEqual([
      "alsoBroken",
      "broken",
      "missing",
    ]);
  });
});

describe("resolveDestination", () => {
  const reg = parseRegistry(CFG);

  it("is INERT when nothing is registered", () => {
    // Absence must be byte-identical to pre-boundary behaviour, or every
    // install that has not configured this starts refusing work.
    expect(
      resolveDestination(parseRegistry(undefined), "anthropic", "internal"),
    ).toBeNull();
  });

  it("uses an explicit driver mapping", () => {
    expect(
      resolveDestination(reg, "anthropic", "internal")?.destination.id,
    ).toBe("remote-wide");
    expect(resolveDestination(reg, "ollama", "internal")?.destination.id).toBe(
      "local-profile",
    );
  });

  it("falls back to the STRICTEST remote for an unknown driver", () => {
    // Fail closed. "We do not recognise where this is going" must never read
    // as "it is fine to send", and picking the widest remote would do exactly
    // that for every driver nobody anticipated.
    const r = resolveDestination(reg, "some-new-driver", "internal");
    expect(r?.destination.id).toBe("remote-narrow");
  });

  it("treats an absent driver as unknown, not as local", () => {
    expect(resolveDestination(reg, undefined, "internal")?.destination.id).toBe(
      "remote-narrow",
    );
  });

  it("reports whether a local destination could take the classification", () => {
    // Drives LOCAL_ONLY rather than DENY: the data may be processed, just not
    // at the remote destination.
    expect(
      resolveDestination(reg, "anthropic", "restricted")
        ?.localDestinationAccepts,
    ).toBe(true);

    const noLocal = parseRegistry({
      destinations: {
        "remote-only": {
          type: "remote",
          classifications: ["public"],
          drivers: ["x"],
        },
      },
    });
    expect(
      resolveDestination(noLocal, "x", "restricted")?.localDestinationAccepts,
    ).toBe(false);
  });

  it("never returns null once anything is registered", () => {
    // The property that keeps the boundary reachable: any dispatch, any
    // driver string, still gets a destination to be judged against.
    for (const drv of ["", "weird", "ANTHROPIC", undefined]) {
      expect(resolveDestination(reg, drv, "internal")).not.toBeNull();
    }
  });
});
