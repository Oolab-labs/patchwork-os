/**
 * The classifier must catch the widenings that do not look like widenings.
 *
 * A diff pretty-printer would catch "owns gained" and stop. The findings worth
 * having are the ones where the edit reads as tidying:
 *
 *   - deleting a manifest REMOVES GOVERNANCE, not authority — the recipe falls
 *     back to the tier fn and ends up governed LESS
 *   - `ceiling: 1 → 2` reads as "+1" and actually converts every compensable
 *     class from "a human decides" to "it happens"
 *   - rebinding `recipe:` swaps the body under a dial the old body earned
 *   - a `forbids` entry that does not parse fails OPEN at runtime, so silence
 *     about it is the one answer that must never be given
 */

import { describe, expect, it } from "vitest";
import {
  authorityDelta,
  authorityDeltaForSet,
  formatAuthorityDeltas,
  widensAuthority,
} from "../authorityDelta.js";
import type { WorkerManifest } from "../worker.js";

const base: WorkerManifest = {
  id: "example-worker",
  name: "Example",
  responsibilities: ["does a thing"],
  recipe: "example-recipe",
  owns: ["vcs-local"],
  autonomyCeiling: 1,
};

const w = (over: Partial<WorkerManifest> = {}): WorkerManifest => ({
  ...base,
  ...over,
});

describe("no change", () => {
  it("reports nothing for an identical manifest", () => {
    expect(authorityDelta(w(), w())).toEqual([]);
    expect(widensAuthority(authorityDelta(w(), w()))).toBe(false);
  });
});

describe("the obvious widenings", () => {
  it("owns gained", () => {
    const d = authorityDelta(w(), w({ owns: ["vcs-local", "vcs-remote"] }));
    expect(d[0]?.kind).toBe("capability-widened");
    expect(d[0]?.detail).toContain("vcs-remote");
    expect(widensAuthority(d)).toBe(true);
  });

  it("owns removed is NOT a widening", () => {
    const d = authorityDelta(w({ owns: ["vcs-local", "fs-write"] }), w());
    expect(d[0]?.kind).toBe("capability-narrowed");
    expect(widensAuthority(d)).toBe(false);
  });
});

describe("the ceiling crossing that does not look like one", () => {
  it("names L2 explicitly when the edit crosses it", () => {
    // The manifest's own doc says ceiling:2 is PERMISSIVE, not conservative.
    // "+1" is the wrong mental model and the message has to say so.
    const d = authorityDelta(
      w({ autonomyCeiling: 1 }),
      w({ autonomyCeiling: 2 }),
    );
    expect(d[0]?.kind).toBe("ceiling-raised");
    expect(d[0]?.detail).toMatch(/CROSSING L2/);
    expect(d[0]?.detail).toMatch(/flowing autonomously/);
  });

  it("does not claim a crossing when there is none", () => {
    const d = authorityDelta(
      w({ autonomyCeiling: 3 }),
      w({ autonomyCeiling: 4 }),
    );
    expect(d[0]?.kind).toBe("ceiling-raised");
    expect(d[0]?.detail).not.toMatch(/CROSSING/);
    expect(widensAuthority(d)).toBe(true);
  });

  it("lowering the ceiling is not a widening", () => {
    const d = authorityDelta(
      w({ autonomyCeiling: 4 }),
      w({ autonomyCeiling: 1 }),
    );
    expect(d[0]?.kind).toBe("ceiling-lowered");
    expect(widensAuthority(d)).toBe(false);
  });
});

describe("deleting a manifest is a WIDENING", () => {
  it("says the recipe becomes governed less, not more", () => {
    // The counterintuitive one. Removing the worker removes the FLOOR the
    // gate composes over the tier fn, so the recipe is governed less and any
    // forbids list goes inert silently.
    const d = authorityDelta(
      w({ forbids: [{ match: "vcs-remote", reason: "never" }] }),
      null,
    );
    expect(d).toHaveLength(1);
    expect(d[0]?.kind).toBe("worker-removed");
    expect(d[0]?.widens).toBe(true);
    expect(d[0]?.detail).toMatch(/governed LESS/);
  });
});

describe("rebinding the body under an earned dial", () => {
  it("flags a changed recipe", () => {
    const d = authorityDelta(w(), w({ recipe: "some-other-recipe" }));
    expect(d[0]?.kind).toBe("recipe-rebound");
    expect(d[0]?.widens).toBe(true);
  });

  it("flags a changed id, because trust does not follow a rename", () => {
    const d = authorityDelta(w(), w({ id: "renamed-worker" }));
    expect(d[0]?.kind).toBe("identity-changed");
    expect(d[0]?.widens).toBe(true);
  });
});

describe("prohibitions", () => {
  const forbidding = w({
    forbids: [
      { match: "vcs-remote", reason: "never pushes" },
      { match: "payments", reason: "never pays" },
    ],
  });

  it("removing a forbid is a widening and says what it meant", () => {
    const d = authorityDelta(
      forbidding,
      w({ forbids: [{ match: "vcs-remote", reason: "never pushes" }] }),
    );
    const f = d.find((x) => x.kind === "prohibition-removed");
    expect(f?.detail).toContain("payments");
    expect(f?.detail).toMatch(/no approval could unlock/);
    expect(widensAuthority(d)).toBe(true);
  });

  it("adding a forbid is not a widening", () => {
    const d = authorityDelta(w(), forbidding);
    expect(d.find((x) => x.kind === "prohibition-added")).toBeDefined();
    expect(widensAuthority(d)).toBe(false);
  });

  it("an UNREADABLE forbid entry is a widening — the inverted failure mode", () => {
    // At runtime parseForbidRules drops it and the banned action degrades to
    // merely gated: fail-open, and correct there. A repository gate must not
    // inherit that, or "I could not read your deny-list" becomes "looks fine".
    const d = authorityDelta(w(), w({ forbids: [{ nope: true }] }));
    const f = d.find((x) => x.kind === "prohibition-unreadable");
    expect(f).toBeDefined();
    expect(f?.widens).toBe(true);
    expect(f?.detail).toMatch(/fails OPEN/);
    expect(widensAuthority(d)).toBe(true);
  });

  it("catches an unreadable forbid on a BRAND NEW worker too", () => {
    const d = authorityDelta(null, w({ forbids: ["not-an-object"] }));
    expect(d.find((x) => x.kind === "prohibition-unreadable")).toBeDefined();
  });
});

describe("a new worker", () => {
  it("is reported as new authority rather than as no change", () => {
    const d = authorityDelta(null, w());
    expect(d[0]?.kind).toBe("worker-added");
    expect(widensAuthority(d)).toBe(true);
  });
});

describe("comparing whole sets", () => {
  it("keys by FILE so a renamed id is one finding, not a delete plus an add", () => {
    // Keying by id would render this as worker-removed + worker-added and
    // lose the fact that an earned dial was abandoned.
    const before = new Map([["a.yaml", w()]]);
    const after = new Map([["a.yaml", w({ id: "renamed" })]]);
    const d = authorityDeltaForSet(before, after);
    expect(d.map((x) => x.kind)).toEqual(["identity-changed"]);
  });

  it("sees a deleted file and an added file", () => {
    const before = new Map([["gone.yaml", w({ id: "gone" })]]);
    const after = new Map([["fresh.yaml", w({ id: "fresh" })]]);
    const kinds = authorityDeltaForSet(before, after)
      .map((x) => x.kind)
      .sort();
    expect(kinds).toEqual(["worker-added", "worker-removed"]);
  });

  it("reports nothing when the set is unchanged", () => {
    const m = new Map([["a.yaml", w()]]);
    expect(authorityDeltaForSet(m, new Map([["a.yaml", w()]]))).toEqual([]);
  });
});

describe("the report", () => {
  it("says nothing changed rather than printing a zero", () => {
    const out = formatAuthorityDeltas([]);
    expect(out).toMatch(/No worker manifest changed/);
    expect(out).not.toMatch(/\b0 finding/);
  });

  it("leads with widenings and says a widening is not a defect", () => {
    const out = formatAuthorityDeltas(
      authorityDelta(w(), w({ owns: ["vcs-local", "payments"] })),
    );
    expect(out).toMatch(/WIDENS AUTHORITY/);
    expect(out).toMatch(/requires a person to say so/);
  });
});
