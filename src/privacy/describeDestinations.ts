/**
 * Render the destination registry as something an operator can act on.
 *
 * The registry is already the place the choice lives: clearing a remote
 * destination for `personal` is one line in `~/.patchwork/config.json`, and has
 * been possible since the boundary shipped. Nothing here adds a new policy
 * primitive, deliberately — a recipe-scoped allow-list would put recipe
 * identity into the decision point, which `recordBoundaryDecisionFn` explicitly
 * keeps out of it, and would smuggle in "purpose" ahead of the per-field
 * labels ADR-0021 reserves it for.
 *
 * What was missing is not the mechanism. It is that the choice was invisible:
 * no surface told an operator which destinations leave the machine, what each
 * is cleared to receive, or that clearing one for `personal` sends their data
 * to somebody else's servers.
 *
 * ## The disclosure states only what this runtime can verify
 *
 * A sentence about a provider's retention or training policy rots without
 * anyone touching the code — API retention moved 30 days → 7 in Sept 2025 and
 * a further change was announced in Aug 2026. A claim the code cannot keep is
 * worse than no claim, because it is believed.
 *
 * So the disclosure is confined to what is true by construction: the prompt
 * leaves this machine, over the network, to the named destination. Retention,
 * training and deletion are the provider's claims, not ours. An operator may
 * record those in `note` / `noteReviewedOn`, and a note with no date, or a
 * stale one, is reported AS stale rather than shown as authoritative — the
 * same rule the receipts follow by refusing to hold a payload: record what is
 * known, decline to assert what is not.
 */

import {
  CLASSIFICATIONS,
  type Classification,
  classificationRank,
  type Destination,
} from "./dataPolicy.js";

/** Anything above `internal` is data an operator would not expect to travel. */
const SENSITIVE_FLOOR: Classification = "personal";

export interface DestinationNote {
  /** Operator's own words about this destination. Never asserted by us. */
  note?: string;
  /** ISO date the operator last checked `note` against the provider. */
  noteReviewedOn?: string;
}

export interface DescribedDestination {
  id: string;
  type: "local" | "remote";
  /** Classifications this destination is cleared to receive, ordered. */
  cleared: Classification[];
  /** Driver names routed here. */
  drivers: string[];
  /**
   * True when a REMOTE destination is cleared for `personal` or above. This is
   * the line worth surfacing: it is a legitimate operator choice, and it is
   * the one that sends data an operator may not expect to leave the machine.
   */
  sendsSensitiveOffMachine: boolean;
  note?: string;
  noteReviewedOn?: string;
  /** True when a note exists but carries no reviewed date, or an unparseable one. */
  noteUndated: boolean;
}

export interface DescribeOptions {
  notes?: Record<string, DestinationNote>;
  /** Today, for staleness. Injected so the report is testable. */
  now?: Date;
  /** A note older than this many days is reported as stale. */
  staleAfterDays?: number;
}

const DEFAULT_STALE_DAYS = 180;

export function describeDestinations(
  destinations: Destination[],
  driversFor: Map<string, string[]>,
  opts: DescribeOptions = {},
): DescribedDestination[] {
  const out: DescribedDestination[] = [];
  for (const d of destinations) {
    const note = opts.notes?.[d.id];
    const cleared = [...d.classifications].sort(
      (a, b) => classificationRank(a) - classificationRank(b),
    );
    const sensitive = cleared.some(
      (c) => classificationRank(c) >= classificationRank(SENSITIVE_FLOOR),
    );
    const dated =
      note?.noteReviewedOn !== undefined &&
      !Number.isNaN(Date.parse(note.noteReviewedOn));
    out.push({
      id: d.id,
      type: d.type,
      cleared,
      drivers: driversFor.get(d.id) ?? [],
      sendsSensitiveOffMachine: d.type === "remote" && sensitive,
      ...(note?.note !== undefined && { note: note.note }),
      ...(note?.noteReviewedOn !== undefined && {
        noteReviewedOn: note.noteReviewedOn,
      }),
      noteUndated: note?.note !== undefined && !dated,
    });
  }
  return out;
}

/** True when a dated note is older than the staleness window. */
export function noteIsStale(
  d: DescribedDestination,
  opts: DescribeOptions = {},
): boolean {
  if (d.note === undefined) return false;
  if (d.noteReviewedOn === undefined) return true;
  const t = Date.parse(d.noteReviewedOn);
  if (Number.isNaN(t)) return true;
  const now = (opts.now ?? new Date()).getTime();
  const days = (now - t) / 86_400_000;
  return days > (opts.staleAfterDays ?? DEFAULT_STALE_DAYS);
}

/**
 * The one sentence this runtime can stand behind permanently.
 *
 * Names no retention period, no training policy and no deletion promise: those
 * belong to the provider and change without warning.
 */
export function disclosureFor(d: DescribedDestination): string {
  return d.type === "local"
    ? `stays on this machine`
    : `LEAVES this machine over the network to "${d.id}"`;
}

export function formatDestinationsReport(
  described: DescribedDestination[],
  opts: DescribeOptions = {},
): string {
  const L: string[] = [];
  L.push("[privacy] where your prompts may go");
  if (described.length === 0) {
    // The inert case is a true and expected state, not an error. Saying "0
    // destinations" invites someone to fix a number; saying the boundary is
    // inert says what it MEANS.
    L.push("");
    L.push("  Nothing is registered, so the information boundary is INERT —");
    L.push("  no dispatch is evaluated and no decision is made. Registering a");
    L.push("  destination is the opt-in; once opted in it fails closed.");
    return L.join("\n");
  }
  L.push("");
  for (const d of described) {
    L.push(`  ${d.id}  (${d.type})`);
    L.push(`      ${disclosureFor(d)}`);
    L.push(`      cleared for: ${d.cleared.join(", ") || "(nothing)"}`);
    if (d.drivers.length > 0) {
      L.push(`      drivers:     ${d.drivers.join(", ")}`);
    }
    if (d.sendsSensitiveOffMachine) {
      L.push(
        `      ⚠ cleared for data above "internal" AND off-machine — your`,
      );
      L.push(`        own choice, and the one that sends personal data to a`);
      L.push(`        third party's servers.`);
    }
    if (d.note !== undefined) {
      L.push(`      note: ${d.note}`);
      if (noteIsStale(d, opts)) {
        L.push(
          d.noteReviewedOn === undefined || d.noteUndated
            ? `      ⚠ that note carries no reviewed date — it is your claim, undated.`
            : `      ⚠ that note was last checked ${d.noteReviewedOn} and may be out of date.`,
        );
      }
    }
    L.push("");
  }
  L.push(
    "  Retention, training and deletion are the provider's claims, not this",
  );
  L.push(
    "  tool's. They change without notice, so nothing here asserts them —",
  );
  L.push("  record what you have checked in `note`, with the date.");
  const anySensitive = described.some((d) => d.sendsSensitiveOffMachine);
  if (!anySensitive) {
    L.push("");
    L.push(
      "  No remote destination is cleared above `internal`, so personal data",
    );
    L.push("  currently has nowhere off-machine to go.");
  }
  return L.join("\n");
}

/** Every classification, ordered — for help text that must not drift. */
export const ALL_CLASSIFICATIONS = [...CLASSIFICATIONS];
