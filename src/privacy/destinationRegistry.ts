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

import { isLoopbackOrPrivateEndpoint } from "../localEndpointGuard.js";
import {
  CLASSIFICATIONS,
  type Classification,
  classificationRank,
  type Destination,
} from "./dataPolicy.js";

/**
 * Drivers whose CLIENT code runs on this machine.
 *
 * Membership is NOT on its own evidence that the DATA stays here — see
 * `endpointIsOnBox` and the inference branch in `resolveDestination`.
 */
const LOCAL_DRIVERS = new Set(["local", "ollama", "lmstudio", "llamacpp"]);

/**
 * Whether this driver is one whose destination depends on the configured
 * endpoint. Exported so `executeAgent` can skip resolving the endpoint (and
 * the `config.json` read behind it) for drivers where it cannot matter.
 */
export function isLocalFamilyDriver(driver: string | undefined): boolean {
  return LOCAL_DRIVERS.has((driver ?? "").toLowerCase());
}

/**
 * Whether the endpoint a local driver will POST to actually stays on the
 * machine (or the private network the operator controls).
 *
 * No endpoint configured ⇒ on-box: every driver in `LOCAL_DRIVERS` defaults to
 * a loopback address, and this is the overwhelmingly common case, so treating
 * it as remote would refuse ordinary local-only installs.
 *
 * An endpoint that does not parse ⇒ NOT on-box. "We cannot tell where this
 * goes" must never read as "it stays here" — same fail-closed direction as the
 * unknown-driver branch below.
 */
function endpointIsOnBox(endpoint: string | undefined): boolean {
  if (endpoint === undefined || endpoint.trim() === "") return true;
  return isLoopbackOrPrivateEndpoint(endpoint.trim());
}

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

/**
 * The strictest remote destination.
 *
 * Ranked by the HIGHEST classification each is cleared for, not by how many it
 * lists. Counting was wrong in the direction that matters: a destination
 * cleared for `[restricted]` has one entry and one cleared for
 * `[public, internal]` has two, so "fewest wins" would pick the one trusted
 * with the most sensitive data as the safe fallback for an unrecognised
 * driver. Ties break on the smaller list.
 */
function strictestRemote(destinations: Destination[]): Destination | null {
  const remotes = destinations.filter((d) => d.type === "remote");
  if (remotes.length === 0) return null;
  const ceiling = (d: Destination): number =>
    d.classifications.length === 0
      ? -1
      : Math.max(...d.classifications.map(classificationRank));
  return remotes.reduce((a, b) => {
    const ca = ceiling(a);
    const cb = ceiling(b);
    if (cb !== ca) return cb < ca ? b : a;
    return b.classifications.length < a.classifications.length ? b : a;
  });
}

export interface ResolvedDestination {
  destination: Destination;
  /** True when some registered LOCAL destination is cleared for `forClass`. */
  localDestinationAccepts: boolean;
}

export interface ResolveDestinationOptions {
  /**
   * The endpoint the local driver will actually POST to, when one is
   * configured (`LOCAL_ENDPOINT` / `config.json` `localEndpoint`). Absent
   * means the driver talks to its own default, which is loopback for every
   * driver in `LOCAL_DRIVERS`.
   */
  endpoint?: string;
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
  opts: ResolveDestinationOptions = {},
): ResolvedDestination | null {
  if (registry.destinations.length === 0) {
    // NOTHING configured is the inert case, and is fine.
    //
    // Something configured that ALL failed to parse is not. Returning null
    // there reverts the boundary to inert on a typo — `type: "cloud"` instead
    // of `"remote"` — while the operator believes they have opted in. That is
    // the fail-open this module's own header says it prevents, reachable by a
    // single misspelled word.
    //
    // So: any invalid entry with no valid entry surviving yields a synthetic
    // destination cleared for NOTHING. Every dispatch is refused, loudly and
    // immediately, which is the correct reading of "the operator asked for
    // enforcement and we cannot tell what they meant".
    if (registry.invalid.length > 0) {
      return {
        destination: {
          id: `unparseable-config(${registry.invalid.map((i) => i.id).join(", ")})`,
          type: "remote",
          classifications: [],
        },
        localDestinationAccepts: false,
      };
    }
    return null;
  }

  const d = (driver ?? "").toLowerCase();
  const localAccepts = registry.destinations.some(
    (dest) => dest.type === "local" && dest.classifications.includes(forClass),
  );

  // #1398: a `type: "local"` destination is disqualified for THIS dispatch when
  // the endpoint the driver will actually POST to is off-box.
  //
  // This is applied to the explicit driver mapping as well as to inference,
  // and that is the load-bearing part. An operator's `drivers: ["local"]` entry
  // on a local destination is a STATIC claim about where a driver goes; the
  // resolved endpoint is what actually happens at dispatch. When the two
  // disagree the endpoint wins, because the alternative lets a stale mapping
  // launder an off-box send into a receipt that says the data never left —
  // the precise failure this issue describes, merely reached by config rather
  // than by driver name.
  const localDisqualified =
    LOCAL_DRIVERS.has(d) && !endpointIsOnBox(opts.endpoint);
  const eligible = localDisqualified
    ? registry.destinations.filter((x) => x.type !== "local")
    : registry.destinations;

  // Explicit driver mapping wins.
  for (const dest of eligible) {
    if ((registry.driversFor.get(dest.id) ?? []).includes(d)) {
      return { destination: dest, localDestinationAccepts: localAccepts };
    }
  }

  // Otherwise infer by driver family.
  //
  // #1398: a driver in LOCAL_DRIVERS is only evidence of a local DESTINATION
  // when the endpoint it will actually POST to is on-box. `LOCAL_ENDPOINT` is
  // configurable and `LOCAL_ENDPOINT_ALLOW_REMOTE` exists precisely because
  // pointing it off-box is a supported deployment — so the driver NAME is a
  // statement about which client code runs, never about where the bytes land.
  //
  // Note what is deliberately NOT consulted here: `LOCAL_ENDPOINT_ALLOW_REMOTE`.
  // That flag is permission to SEND to a remote box; it is not evidence that
  // the box is local. Reading it as "the operator allowed this, so treat it as
  // local" would re-open exactly the hole this closes, and would do so on the
  // deployments most likely to be sending real data off-machine.
  if (LOCAL_DRIVERS.has(d) && endpointIsOnBox(opts.endpoint)) {
    const local = registry.destinations.find((x) => x.type === "local");
    if (local) {
      return { destination: local, localDestinationAccepts: localAccepts };
    }
  }

  // Unknown or remote driver → strictest remote. Fail closed: "we do not
  // recognise where this is going" must never read as "it is fine to send".
  const remote = strictestRemote(eligible);
  if (remote) {
    return { destination: remote, localDestinationAccepts: localAccepts };
  }

  // #1398: a local driver aimed off-box, with ONLY local destinations
  // registered. There is no registered destination that describes where this
  // data is actually going, so there is nothing to fall back TO — returning
  // the local profile here would hand a `restricted`-cleared local destination
  // to a dispatch leaving the machine, which is the worst version of this bug
  // rather than a mitigation of it. Synthesise a remote destination cleared
  // for nothing, the same shape the unparseable-config branch uses.
  if (localDisqualified) {
    return {
      destination: {
        id: "local-driver-remote-endpoint",
        type: "remote",
        classifications: [],
      },
      localDestinationAccepts: localAccepts,
    };
  }

  // Only local destinations are registered but the driver is not local. The
  // strictest available answer is the local profile, which will refuse
  // anything it is not cleared for.
  const first = registry.destinations[0] as Destination;
  return { destination: first, localDestinationAccepts: localAccepts };
}
