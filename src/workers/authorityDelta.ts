/**
 * What did this change do to a worker's AUTHORITY?
 *
 * A repository gate needs to answer that before a manifest edit lands, and the
 * answer must come from the same primitives that govern the worker while it
 * RUNS — otherwise there are two notions of authority, they drift, and the
 * drift is silent and permissive. So this reuses `parseForbidRules`,
 * `TrustLevel` and the gate's own autonomy thresholds rather than re-deriving
 * them from a diff.
 *
 * ## One inversion, and it is the point
 *
 * `parseForbidRules` reports unparseable entries and DROPS them. At runtime
 * that fails OPEN on purpose, and correctly: a banned action degrading to
 * merely gated is recoverable, because a human still has to approve it.
 *
 * A repository gate cannot inherit that. "I could not read your deny-list" is
 * the one answer that must never resolve to "looks fine" — the whole reason
 * this runs is to catch a prohibition going missing. So an unreadable
 * `forbids` entry in the AFTER manifest is reported as a widening, and the
 * gate fails closed on it.
 *
 * Same classifier, inverted failure mode. That is a deliberate difference, not
 * an inconsistency, and it is why this is not simply `decideWorkerAction` run
 * twice.
 *
 * ## What this does NOT do
 *
 * No model, no scoring, no natural-language summary of intent. Every finding
 * is a set difference or a numeric comparison over declared fields, so it is
 * reproducible from the two manifests alone and testable without a model —
 * the same rule the boundary and the disposition classifier already follow.
 */

import { type ForbidRule, parseForbidRules } from "./forbidPolicy.js";
import type { TrustLevel } from "./trustLevel.js";
import type { WorkerManifest } from "./worker.js";

/**
 * The level at which COMPENSABLE actions stop being gated and start flowing
 * autonomously. Mirrors `COMPENSABLE_AUTONOMY_LEVEL` in `workerGate.ts`.
 *
 * Crossing it is the single most consequential ceiling change and does not
 * look like one: the manifest doc notes that `ceiling: 2` is PERMISSIVE, not
 * conservative. A 1 → 2 edit reads as "+1" and actually converts every
 * compensable class this worker owns from "a human decides" to "it just
 * happens".
 */
const COMPENSABLE_AUTONOMY_LEVEL = 2;

export type AuthorityDeltaKind =
  | "worker-added"
  | "worker-removed"
  | "capability-widened"
  | "capability-narrowed"
  | "ceiling-raised"
  | "ceiling-lowered"
  | "prohibition-removed"
  | "prohibition-added"
  | "prohibition-unreadable"
  | "recipe-rebound"
  | "identity-changed";

export interface AuthorityDelta {
  kind: AuthorityDeltaKind;
  /** Worker id the finding is about (the AFTER id when it changed). */
  workerId: string;
  /** One sentence, safe to put in a receipt or a PR comment. */
  detail: string;
  /**
   * True when this finding means the worker may do MORE than before, or when
   * the change cannot be shown not to. A gate blocks on any of these.
   */
  widens: boolean;
}

function ownsSet(m: WorkerManifest): Set<string> {
  return new Set(m.owns ?? []);
}

function forbidKeys(rules: ForbidRule[]): Set<string> {
  return new Set(rules.map((r) => r.match));
}

/**
 * Compare two versions of one worker manifest.
 *
 * `before === null` means the manifest is new; `after === null` means it was
 * deleted. Both are reported, and DELETION IS A WIDENING — see below.
 */
export function authorityDelta(
  before: WorkerManifest | null,
  after: WorkerManifest | null,
): AuthorityDelta[] {
  const out: AuthorityDelta[] = [];

  if (before === null && after === null) return out;

  if (before === null && after !== null) {
    out.push({
      kind: "worker-added",
      workerId: after.id,
      detail: `new worker "${after.id}" owning ${after.owns.length} class pattern(s) at ceiling L${after.autonomyCeiling}`,
      widens: true,
    });
    // A new manifest still gets its forbids read, so an unreadable rule in a
    // brand-new worker is caught on the way in rather than on its first edit.
    out.push(...unreadableForbids(after));
    return out;
  }

  if (before !== null && after === null) {
    // Deleting a manifest does NOT remove authority — it removes GOVERNANCE.
    // `resolveWorkerIdForRecipe` returns undefined, the caller falls back to
    // the tier-based approval fn, and because the worker gate composes as a
    // FLOOR (it can only ADD approvals), the recipe ends up governed LESS than
    // it was. Any `forbids` list goes inert without a word. This is the least
    // obvious widening in the whole surface and reads like cleanup.
    out.push({
      kind: "worker-removed",
      workerId: before.id,
      detail: `worker "${before.id}" deleted — its recipe falls back to the tier-based approval fn and any \`forbids\` list goes inert, so the recipe becomes governed LESS, not more`,
      widens: true,
    });
    return out;
  }

  const b = before as WorkerManifest;
  const a = after as WorkerManifest;

  if (b.id !== a.id) {
    // Trust is keyed per (workerId × actionClass). Renaming the id abandons
    // the old dial and starts the worker at zero — or, worse, adopts another
    // worker's earned history if the new id already exists.
    out.push({
      kind: "identity-changed",
      workerId: a.id,
      detail: `worker id changed "${b.id}" → "${a.id}" — trust is keyed per worker id, so the earned dial does not follow the rename`,
      widens: true,
    });
  }

  if ((b.recipe ?? "") !== (a.recipe ?? "")) {
    // The manifest is the identity; the recipe is the body. Rebinding swaps
    // the body under a dial earned by the old one.
    out.push({
      kind: "recipe-rebound",
      workerId: a.id,
      detail: `recipe rebound "${b.recipe ?? "(none)"}" → "${a.recipe ?? "(none)"}" — trust earned running the previous recipe now governs a different one`,
      widens: true,
    });
  }

  const bo = ownsSet(b);
  const ao = ownsSet(a);
  const gained = [...ao].filter((x) => !bo.has(x));
  const lost = [...bo].filter((x) => !ao.has(x));
  if (gained.length > 0) {
    out.push({
      kind: "capability-widened",
      workerId: a.id,
      detail: `owns gained: ${gained.join(", ")}`,
      widens: true,
    });
  }
  if (lost.length > 0) {
    out.push({
      kind: "capability-narrowed",
      workerId: a.id,
      detail: `owns removed: ${lost.join(", ")}`,
      widens: false,
    });
  }

  if (a.autonomyCeiling > b.autonomyCeiling) {
    out.push({
      kind: "ceiling-raised",
      workerId: a.id,
      detail: crossesCompensable(b.autonomyCeiling, a.autonomyCeiling)
        ? `autonomy ceiling L${b.autonomyCeiling} → L${a.autonomyCeiling}, CROSSING L${COMPENSABLE_AUTONOMY_LEVEL} — compensable classes this worker owns stop being gated and start flowing autonomously`
        : `autonomy ceiling L${b.autonomyCeiling} → L${a.autonomyCeiling}`,
      widens: true,
    });
  } else if (a.autonomyCeiling < b.autonomyCeiling) {
    out.push({
      kind: "ceiling-lowered",
      workerId: a.id,
      detail: `autonomy ceiling L${b.autonomyCeiling} → L${a.autonomyCeiling}`,
      widens: false,
    });
  }

  const bf = parseForbidRules(b.forbids);
  const af = parseForbidRules(a.forbids);
  const bk = forbidKeys(bf.rules);
  const ak = forbidKeys(af.rules);
  const dropped = [...bk].filter((x) => !ak.has(x));
  const added = [...ak].filter((x) => !bk.has(x));
  if (dropped.length > 0) {
    out.push({
      kind: "prohibition-removed",
      workerId: a.id,
      detail: `forbids removed: ${dropped.join(", ")} — previously no approval could unlock these; now they are merely gated`,
      widens: true,
    });
  }
  if (added.length > 0) {
    out.push({
      kind: "prohibition-added",
      workerId: a.id,
      detail: `forbids added: ${added.join(", ")}`,
      widens: false,
    });
  }
  out.push(...unreadableForbids(a));

  return out;
}

/**
 * An entry `parseForbidRules` could not read.
 *
 * Reported as a WIDENING even though nothing was demonstrably removed, because
 * the alternative is to report "no prohibition changes" about a deny-list we
 * could not read. That is the failure this whole check exists to prevent.
 */
function unreadableForbids(m: WorkerManifest): AuthorityDelta[] {
  const parsed = parseForbidRules(m.forbids);
  if (parsed.invalid.length === 0) return [];
  return [
    {
      kind: "prohibition-unreadable",
      workerId: m.id,
      detail: `forbids entr${parsed.invalid.length === 1 ? "y" : "ies"} at position ${parsed.invalid.join(", ")} could not be parsed — at runtime an unreadable rule fails OPEN, so this cannot be reported as "no change"`,
      widens: true,
    },
  ];
}

function crossesCompensable(from: TrustLevel, to: TrustLevel): boolean {
  return from < COMPENSABLE_AUTONOMY_LEVEL && to >= COMPENSABLE_AUTONOMY_LEVEL;
}

/** True when any finding widens authority — the gate's decision. */
export function widensAuthority(deltas: AuthorityDelta[]): boolean {
  return deltas.some((d) => d.widens);
}

/**
 * Compare two whole SETS of manifests — the shape a repository gate needs.
 *
 * Keyed by manifest FILE, not by worker id, deliberately: a renamed id must
 * surface as `identity-changed` on the same file rather than as a delete plus
 * an add, which would hide the fact that a dial was abandoned. Keying by id
 * would also make two files claiming one id indistinguishable from an edit —
 * and `resolveWorkerIdForRecipe` refuses to guess between two claimants, so
 * that state must stay visible.
 */
export function authorityDeltaForSet(
  before: Map<string, WorkerManifest>,
  after: Map<string, WorkerManifest>,
): AuthorityDelta[] {
  const out: AuthorityDelta[] = [];
  const files = new Set([...before.keys(), ...after.keys()]);
  for (const f of [...files].sort()) {
    out.push(...authorityDelta(before.get(f) ?? null, after.get(f) ?? null));
  }
  return out;
}

/** Render findings for a human. Widenings first — they are the decision. */
export function formatAuthorityDeltas(deltas: AuthorityDelta[]): string {
  const L: string[] = [];
  L.push("[authority] what this change does to worker authority");
  if (deltas.length === 0) {
    // "0 findings" invites a reader to assume nothing was examined. Say what
    // was compared and that it came back unchanged.
    //
    // And say it PRECISELY: "no manifest changed" would be false whenever a
    // comment, reordering or an unread field changed, which is exactly the
    // case this classifier exists to distinguish from a real one. A reader who
    // sees a nine-line diff and a report claiming nothing changed will stop
    // trusting the report, and they would be right to.
    L.push("");
    L.push("  No authority changed.");
    L.push("");
    L.push("  Manifest files may still have changed — comments, ordering and");
    L.push("  any field the gate does not read cannot affect what a worker is");
    L.push("  permitted to do.");
    return L.join("\n");
  }
  const widening = deltas.filter((d) => d.widens);
  const narrowing = deltas.filter((d) => !d.widens);
  L.push("");
  if (widening.length > 0) {
    L.push(`  WIDENS AUTHORITY — ${widening.length} finding(s):`);
    for (const d of widening) L.push(`    ${d.workerId}: ${d.detail}`);
    L.push("");
  }
  if (narrowing.length > 0) {
    L.push(`  narrows or neutral — ${narrowing.length} finding(s):`);
    for (const d of narrowing) L.push(`    ${d.workerId}: ${d.detail}`);
    L.push("");
  }
  if (widening.length > 0) {
    L.push("  A widening is not a defect and is often exactly what was");
    L.push("  intended. It requires a person to say so.");
  }
  return L.join("\n");
}
