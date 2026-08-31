/**
 * `approvable: true` can be set and never asked (ADR-0021).
 *
 * The claim carried in the handoff notes — and repeated into ADR-0024 — was that
 * `REQUIRE_APPROVAL` is *unreachable*, because rule 1 returns `LOCAL_ONLY`
 * before `approvable` is tested. That is not quite right, and the difference
 * matters enough to pin:
 *
 *   - `REQUIRE_APPROVAL` IS reachable. It fires whenever an uncleared
 *     destination is `approvable` and no local destination accepts the
 *     classification.
 *   - What is true is narrower and worse: on a registry with a permissive
 *     LOCAL destination — which is the shape the docs recommend and the shape
 *     the reference machine runs — the `approvable` flag on a remote
 *     destination can NEVER fire. `localDestinationAccepts` is then always
 *     true, so rule 1 short-circuits every time.
 *
 * So an operator sets `approvable: true`, expecting to be asked, and is never
 * asked. They are refused instead, because `LOCAL_ONLY` does not reroute — it
 * declines with a suggestion. A config knob that silently does nothing is worse
 * than an absent one: it reads as a control that is in place.
 *
 * These tests describe the CURRENT behaviour deliberately. They are not a
 * demand that the ordering change — see the report guard below for why that is
 * a separate decision — they exist so the ordering cannot change by accident,
 * in either direction, without someone reading this.
 */
import { describe, expect, it } from "vitest";

import { type Destination, decideBoundary, narrowest } from "../dataPolicy.js";
import {
  describeDestinations,
  formatDestinationsReport,
} from "../describeDestinations.js";

const REMOTE_APPROVABLE: Destination = {
  id: "hosted",
  type: "remote",
  classifications: ["public", "internal"],
  approvable: true,
};

describe("approvable on a remote destination", () => {
  it("is INERT when a local destination accepts the classification", () => {
    // The reference-machine shape: a local destination cleared for everything.
    const outcome = decideBoundary(
      { classification: "personal" },
      REMOTE_APPROVABLE,
      { localDestinationAccepts: true },
    );
    // Not REQUIRE_APPROVAL. The operator asked to be asked and will not be.
    expect(outcome.decision).toBe("LOCAL_ONLY");
    // And the reason does not mention approval at all, so the report gives no
    // hint that the flag they set was passed over.
    expect(outcome.reason).not.toMatch(/approv/i);
  });

  it("DOES fire when no local destination accepts it", () => {
    // The control. Without it the assertion above would pass equally against a
    // build where REQUIRE_APPROVAL had been deleted outright, which is the
    // stronger claim the handoff note actually made.
    const outcome = decideBoundary(
      { classification: "personal" },
      REMOTE_APPROVABLE,
      { localDestinationAccepts: false },
    );
    expect(outcome.decision).toBe("REQUIRE_APPROVAL");
  });

  it("rule 1 returns the LESS restrictive of the two candidates", () => {
    // Recorded because it is the part that looks like a defect and is not
    // obviously one. `narrowest()` in this same module exists to stop a later
    // stage widening an earlier decision, and ranks REQUIRE_APPROVAL (3) as
    // stricter than LOCAL_ONLY (2) — yet rule 1 hands back LOCAL_ONLY first.
    //
    // Whether that ranking is right is genuinely unclear, which is why nothing
    // is being changed here: in EFFECT today LOCAL_ONLY is the stricter of the
    // two, because it refuses outright and no approval unlocks it, while
    // REQUIRE_APPROVAL can be unlocked by a human. The ranking describes
    // intent; the runtime describes behaviour; they disagree. Reordering rule 1
    // to match the ranking would make live traffic newly approvable — an
    // enforcement change, not a tidy-up.
    const localOnly = decideBoundary(
      { classification: "personal" },
      REMOTE_APPROVABLE,
      { localDestinationAccepts: true },
    );
    const requireApproval = decideBoundary(
      { classification: "personal" },
      REMOTE_APPROVABLE,
      { localDestinationAccepts: false },
    );
    // narrowest() would pick REQUIRE_APPROVAL; rule 1 picked LOCAL_ONLY.
    expect(narrowest(localOnly, requireApproval).decision).toBe(
      "REQUIRE_APPROVAL",
    );
    expect(localOnly.decision).toBe("LOCAL_ONLY");
  });
});

describe("the report says so, since the runtime will not", () => {
  const LOCAL_PERMISSIVE: Destination = {
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

  it("flags an approvable remote destination that can never be asked", () => {
    const described = describeDestinations(
      [LOCAL_PERMISSIVE, REMOTE_APPROVABLE],
      new Map(),
    );
    const hosted = described.find((d) => d.id === "hosted");
    expect(hosted?.approvable).toBe(true);
    expect(hosted?.approvalUnreachable).toBe(true);
    const report = formatDestinationsReport(described);
    expect(report).toMatch(/can NEVER fire/);
    // It must say what happens INSTEAD. "Your flag is inert" leaves an operator
    // guessing whether they are protected more or less than they thought.
    expect(report).toMatch(/REFUSED, not asked/);
  });

  it("does NOT flag it when approval is genuinely reachable", () => {
    // The control. Same remote destination, but the local one is cleared for
    // nothing it refuses, so rule 1 cannot short-circuit and `approvable` does
    // real work. Without this the assertion above passes against a build that
    // flags every approvable destination unconditionally.
    const narrowLocal: Destination = {
      id: "local-models",
      type: "local",
      classifications: ["public"],
    };
    const described = describeDestinations(
      [narrowLocal, REMOTE_APPROVABLE],
      new Map(),
    );
    expect(described.find((d) => d.id === "hosted")?.approvalUnreachable).toBe(
      false,
    );
    expect(formatDestinationsReport(described)).not.toMatch(/can NEVER fire/);
  });

  it("does NOT flag a destination that never set approvable", () => {
    const plain: Destination = {
      id: "hosted",
      type: "remote",
      classifications: ["public", "internal"],
    };
    const described = describeDestinations(
      [LOCAL_PERMISSIVE, plain],
      new Map(),
    );
    expect(described.find((d) => d.id === "hosted")?.approvalUnreachable).toBe(
      false,
    );
  });
});
