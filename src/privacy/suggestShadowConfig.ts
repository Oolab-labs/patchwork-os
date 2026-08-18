/**
 * Derive a STARTER `privacy.shadow` block from the drivers a workspace's
 * recipes actually declare (ADR-0021).
 *
 * ## Why this exists
 *
 * Shadow mode was built, wired and shipped, and then collected zero rows —
 * because turning it on means hand-writing a destination registry against a
 * schema most operators have never read. The feature was not unadopted because
 * nobody wanted it; it was unadopted because the first step was homework.
 *
 * This does the mechanical half: enumerate the destinations a workspace's
 * recipes dispatch to. That is genuinely hard by hand across dozens of recipe
 * files and trivial to compute.
 *
 * ## What it deliberately does NOT do
 *
 * It does not tell anyone what their policy should be. Per ADR-0019, curated
 * policy content is regulatory material and belongs in the control plane, not
 * in this MIT repo — and an operator who pastes a suggestion is entitled to
 * assume it reflects only what was measured, not advice about their
 * obligations.
 *
 * So the split is: the DESTINATIONS are derived from evidence, and the
 * CLASSIFICATIONS are a deliberately conservative placeholder the operator is
 * told, in the output, to review. The one thing worse than no starter config is
 * one that looks authoritative.
 */
import { isLocalFamilyDriver } from "./destinationRegistry.js";

export interface DriverUsage {
  driver: string;
  /** How many declaration sites named it. Ordering only; never a policy input. */
  count: number;
}

export interface SuggestInput {
  /** Drivers declared across installed recipes. */
  drivers: DriverUsage[];
  /**
   * How many agent steps declared NO driver and so use the bridge default.
   *
   * Reported rather than silently folded in: those steps DO reach a
   * destination, and a suggestion that omitted them would under-enumerate the
   * exact surface it claims to enumerate.
   */
  unspecified?: number;
  /**
   * The bridge default driver (`driver` in config.json), which is where every
   * `unspecified` step actually goes.
   *
   * Without it the note about those steps is wrong in BOTH directions: it warns
   * they are uncovered when the default is already in the block (needless
   * alarm), and it under-states the gap when the default appears in no recipe
   * at all — the case where the suggestion genuinely misses a live destination.
   * Neither is acceptable in output whose entire job is enumerating a surface.
   */
  defaultDriver?: string;
}

export interface SuggestResult {
  /** Paste-ready value for `privacy.shadow` in config.json. */
  config: {
    destinations: Record<
      string,
      { type: "local" | "remote"; classifications: string[]; drivers: string[] }
    >;
  };
  /** Things the operator must know before pasting. Never omitted. */
  notes: string[];
}

/** Conservative placeholder — reviewed by the operator, not asserted by us. */
const REMOTE_DEFAULT = ["public", "internal"];
const LOCAL_DEFAULT = [
  "public",
  "internal",
  "personal",
  "confidential",
  "restricted",
];

export function suggestShadowConfig(input: SuggestInput): SuggestResult {
  const local: string[] = [];
  const remote: string[] = [];
  const seen = new Set<string>();
  for (const { driver } of input.drivers) {
    seen.add(driver);
    (isLocalFamilyDriver(driver) ? local : remote).push(driver);
  }

  // The default driver is a real destination whether or not any recipe names
  // it — every step that omits `driver:` dispatches there.
  const dflt = input.defaultDriver?.trim().toLowerCase();
  const defaultAlreadyCovered = dflt ? seen.has(dflt) : false;
  if (dflt && !defaultAlreadyCovered) {
    (isLocalFamilyDriver(dflt) ? local : remote).push(dflt);
  }

  const destinations: SuggestResult["config"]["destinations"] = {};
  if (local.length > 0) {
    destinations["candidate-local"] = {
      type: "local",
      classifications: [...LOCAL_DEFAULT],
      drivers: local.sort(),
    };
  }
  if (remote.length > 0) {
    destinations["candidate-remote"] = {
      type: "remote",
      classifications: [...REMOTE_DEFAULT],
      drivers: remote.sort(),
    };
  }

  const notes: string[] = [];
  notes.push(
    "The DESTINATIONS below are measured — they are the drivers your recipes declare.",
  );
  notes.push(
    "The CLASSIFICATIONS are a conservative placeholder, NOT advice about your obligations. Review them.",
  );
  if (input.unspecified && input.unspecified > 0) {
    if (dflt) {
      notes.push(
        `${input.unspecified} agent step(s) declare no driver; they use the bridge default "${dflt}", ` +
          (defaultAlreadyCovered
            ? "which a recipe already names, so this block covers them."
            : "which no recipe names — it has been ADDED below so they are covered."),
      );
    } else {
      notes.push(
        `${input.unspecified} agent step(s) declare no driver and use the bridge default, which could ` +
          "not be read from config.json — this block does not cover them until you name that driver.",
      );
    }
  }
  if (remote.length === 0) {
    notes.push(
      "No remote drivers found. With only local destinations, a shadow run will show few or no crossings — that is a property of this workspace, not a clean bill of health.",
    );
  }
  if (Object.keys(destinations).length === 0) {
    notes.push(
      "No drivers found at all. Nothing to suggest; shadow mode would observe nothing.",
    );
  }
  notes.push(
    "This is `privacy.shadow` — it never enforces. `privacy.destinations` is the enforcing key and is untouched.",
  );
  return { config: { destinations }, notes };
}

export function formatSuggestion(r: SuggestResult): string {
  const L: string[] = [];
  L.push("[privacy-suggest] a starting point, derived from your recipes");
  L.push("");
  for (const n of r.notes) L.push(`  - ${n}`);
  L.push("");
  L.push("  Add to ~/.patchwork/config.json:");
  L.push("");
  const body = JSON.stringify({ privacy: { shadow: r.config } }, null, 2)
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  L.push(body);
  L.push("");
  L.push(
    "  Then run a recipe with an agent step and `patchwork privacy shadow`.",
  );
  return L.join("\n");
}
