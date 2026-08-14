/**
 * Destination registry (ADR-0021).
 *
 * The decision in `dataPolicy.ts` is pure and complete, and until this module
 * existed it was also unreachable: `executeAgent` only evaluates the boundary
 * when a destination is supplied, and nothing supplied one. The engine was
 * built and inert.
 *
 * A destination is *where a prompt is about to go*. Patchwork resolves that
 * from the driver, because that is what actually determines whether bytes
 * cross a network boundary:
 *
 *   local   — a model on this machine (`local`, `ollama`, an OpenAI-compatible
 *             endpoint pointed at localhost)
 *   remote  — anything that sends the prompt to a third party
 *
 * ## Configuration is opt-in, and absence means inert
 *
 * With no `privacy.destinations` block, `resolveDestination` returns null and
 * `executeAgent` skips the boundary entirely — byte-identical to before. That
 * is the same fail-soft posture as the default classification, and for the same
 * reason: a boundary that refuses work on every install that has not configured
 * it would be switched off before it ever protected anyone.
 *
 * The asymmetry is deliberate and worth stating. Configuring a destination is
 * how an operator OPTS IN to enforcement. Once opted in, the decision is
 * fail-CLOSED — an unknown driver resolves to the strictest registered remote
 * profile rather than to "no destination", because "we do not recognise where
 * this is going" must never read as "it is fine to send".
 */

import {
  CLASSIFICATIONS,
  type Classification,
  type Destination,
} from "./dataPolicy.js";

/** Drivers that keep the prompt on this machine. */
const LOCAL_DRIVERS = new Set(["local", "ollama", "lmstudio", "llamacpp"]);

export interface DestinationConfig {
  type?: string;
  classifications?: unknown;
  forbiddenCategories?: unknown;
  approvable?: unknown;
  /** Driver names this destination covers. */
  drivers?: unknown;
}

export interface PrivacyConfig {
  destinations?: Record<string, DestinationConfig>;
}

function parseClassifications(raw: unknown): Classification[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Classification[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    if (!(CLASSIFICATIONS as readonly string[]).includes(v)) return null;
    out.push(v as Classification);
  }
  return out;
}

export interface ParsedRegistry {
  destinations: Destination[];
  /** Destination id → driver names it covers. */
  driversFor: Map<string, string[]>;
  /**
   * Entries that could not be parsed, with a reason. REPORTED rather than
   * dropped: a destination that silently vanishes from the registry downgrades
   * enforcement to "no destination", which is exactly the direction this must
   * never fail in.
   */
  invalid: Array<{ id: string; reason: string }>;
}

export function parseRegistry(cfg: PrivacyConfig | undefined): ParsedRegistry {
  const destinations: Destination[] = [];
  const driversFor = new Map<string, string[]>();
  const invalid: Array<{ id: string; reason: string }> = [];

  for (const [id, raw] of Object.entries(cfg?.destinations ?? {})) {
    if (!raw || typeof raw !== "object") {
      invalid.push({ id, reason: "not an object" });
      continue;
    }
    const type =
      raw.type === "local" ? "local" : raw.type === "remote" ? "remote" : null;
    if (!type) {
      invalid.push({ id, reason: `type must be "local" or "remote"` });
      continue;
    }
    const classifications = parseClassifications(raw.classifications);
    if (!classifications) {
      invalid.push({
        id,
        reason: "classifications must be an array of known classifications",
      });
      continue;
    }
    const dest: Destination = { id, type, classifications };
    if (Array.isArray(raw.forbiddenCategories)) {
      dest.forbiddenCategories = raw.forbiddenCategories.filter(
        (c): c is string => typeof c === "string",
      );
    }
    if (raw.approvable === true) dest.approvable = true;
    destinations.push(dest);
    driversFor.set(
      id,
      Array.isArray(raw.drivers)
        ? raw.drivers.filter((d): d is string => typeof d === "string")
        : [],
    );
  }
  return { destinations, driversFor, invalid };
}

/** The strictest remote destination — fewest classifications wins. */
function strictestRemote(destinations: Destination[]): Destination | null {
  const remotes = destinations.filter((d) => d.type === "remote");
  if (remotes.length === 0) return null;
  return remotes.reduce((a, b) =>
    b.classifications.length < a.classifications.length ? b : a,
  );
}

export interface ResolvedDestination {
  destination: Destination;
  /** True when some registered LOCAL destination is cleared for `forClass`. */
  localDestinationAccepts: boolean;
}

/**
 * Resolve the destination for a dispatch.
 *
 * Returns null ONLY when nothing is registered — the inert case. Once anything
 * is registered, this always yields a destination, because falling back to null
 * on an unrecognised driver would silently disable the boundary for exactly the
 * dispatches nobody anticipated.
 */
export function resolveDestination(
  registry: ParsedRegistry,
  driver: string | undefined,
  forClass: Classification,
): ResolvedDestination | null {
  if (registry.destinations.length === 0) return null;

  const d = (driver ?? "").toLowerCase();
  const localAccepts = registry.destinations.some(
    (dest) => dest.type === "local" && dest.classifications.includes(forClass),
  );

  // Explicit driver mapping wins.
  for (const dest of registry.destinations) {
    if ((registry.driversFor.get(dest.id) ?? []).includes(d)) {
      return { destination: dest, localDestinationAccepts: localAccepts };
    }
  }

  // Otherwise infer by driver family.
  if (LOCAL_DRIVERS.has(d)) {
    const local = registry.destinations.find((x) => x.type === "local");
    if (local) {
      return { destination: local, localDestinationAccepts: localAccepts };
    }
  }

  // Unknown or remote driver → strictest remote. Fail closed: "we do not
  // recognise where this is going" must never read as "it is fine to send".
  const remote = strictestRemote(registry.destinations);
  if (remote) {
    return { destination: remote, localDestinationAccepts: localAccepts };
  }
  // Only local destinations are registered but the driver is not local. The
  // strictest available answer is the local profile, which will refuse
  // anything it is not cleared for.
  const first = registry.destinations[0] as Destination;
  return { destination: first, localDestinationAccepts: localAccepts };
}
