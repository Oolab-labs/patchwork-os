/**
 * `patchwork privacy destinations` says what the runtime will actually do
 * (audit M9, 2026-10-15).
 *
 * - When every registered destination failed to parse, the runtime refuses
 *   EVERY dispatch (resolveDestination's synthetic "unparseable-config"
 *   destination, cleared for nothing). The report said the boundary was
 *   INERT — the opposite. Entries that failed alongside valid ones were not
 *   mentioned at all.
 * - ADR-0021 and claudeOrchestrator.ts both say this command reports a
 *   malformed `privacy.orchestrator.classification`. It did not mention the
 *   orchestrator path at all. (Malformed still fails OPEN — deliberately;
 *   the point is that the operator can see it.)
 */

import { describe, expect, it } from "vitest";
import {
  describeDestinations,
  describeOrchestratorPath,
  formatDestinationsReport,
} from "../describeDestinations.js";
import { parseRegistry } from "../destinationRegistry.js";

function report(privacy: unknown): string {
  const reg = parseRegistry(privacy as never);
  const described = describeDestinations(reg.destinations, reg.driversFor);
  return formatDestinationsReport(described, {
    invalid: reg.invalid,
    orchestrator: describeOrchestratorPath(
      (privacy as { orchestrator?: { classification?: unknown } })?.orchestrator
        ?.classification,
    ),
  });
}

describe("unparseable destinations", () => {
  it("all invalid: says every dispatch is refused, never INERT", () => {
    const out = report({
      destinations: {
        "remote-model": { type: "cloud", classifications: ["internal"] },
      },
    });
    expect(out).not.toMatch(/INERT/);
    expect(out).toMatch(/refus\w* every/i);
    expect(out).toContain("remote-model");
  });

  it("some invalid: names the ones that are not used", () => {
    const out = report({
      destinations: {
        good: { type: "remote", classifications: ["internal"] },
        broken: { type: "cloud", classifications: ["internal"] },
      },
    });
    expect(out).toContain("broken");
    expect(out).toMatch(/not used|could not be parsed/i);
  });

  it("nothing configured is still INERT", () => {
    expect(report({})).toMatch(/INERT/);
  });
});

describe("orchestrator path", () => {
  it("absent: not enforced", () => {
    expect(describeOrchestratorPath(undefined).state).toBe("absent");
  });
  it("valid: enforced at that classification", () => {
    expect(describeOrchestratorPath("internal")).toEqual({
      state: "enforced",
      classification: "internal",
    });
  });
  it("malformed: reported, and NOT enforced (fails open by design)", () => {
    const out = report({
      destinations: { good: { type: "remote", classifications: ["internal"] } },
      orchestrator: { classification: "internl" },
    });
    expect(out).toMatch(/orchestrator/i);
    expect(out).toContain("internl");
    expect(out).toMatch(/not enforced/i);
  });
});
