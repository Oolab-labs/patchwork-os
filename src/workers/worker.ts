import type { ActionClass } from "./actionClass.js";
import {
  DEFAULT_PRIOR,
  type Posterior,
  priorFromCompetence,
  type TrustLevel,
} from "./trustLevel.js";

/**
 * A worker manifest. Deliberately NOT a fork of the recipe schema — the recipe
 * is the worker's *body* (triggers + steps); this manifest adds identity, the
 * action-classes it owns, a trust prior, and the policy autonomy ceiling. It
 * references a recipe by name rather than redefining execution. (worker-ramp-v0)
 */

const WORKER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface WorkerCompetence {
  /** Claimed reliability mean (0–1) — a competence claim, not trust. */
  mean: number;
  /** Prior strength (pseudo-count); capped low so local evidence dominates. */
  strength: number;
}

export interface WorkerManifest {
  id: string;
  name: string;
  responsibilities: string[];
  /** Recipe name that forms this worker's body (its triggers + steps). */
  recipe?: string;
  /**
   * Action-classes this worker is responsible for. Each pattern matches a
   * class by its domain, or by an exact/prefix class-key match
   * (`vcs-local` matches `vcs-local:*`; `fs-write:reversible:medium` is exact).
   */
  owns: string[];
  /**
   * Policy/regulatory cap on the max ramp level this worker may EVER reach,
   * independent of earned track record — the schema encoding of the
   * autonomy-tolerance axis (e.g. a Legal-sector worker is pinned at L2). The
   * dial still shows *earned* level; the gate operates at min(earned, ceiling).
   */
  autonomyCeiling: TrustLevel;
  /** Optional shipped competence → the per-class prior. */
  competence?: WorkerCompetence;
  /** Free-form sector tag (drives default ceilings / reporting). */
  sector?: string;
}

export class WorkerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerParseError";
  }
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v)
    throw new WorkerParseError(`worker.${key} must be a non-empty string`);
  return v;
}

export function parseWorker(raw: unknown): WorkerManifest {
  if (typeof raw !== "object" || raw === null)
    throw new WorkerParseError("worker must be an object");
  const r = raw as Record<string, unknown>;

  const id = reqString(r, "id");
  if (!WORKER_ID_RE.test(id))
    throw new WorkerParseError(
      `worker.id must be kebab-case (got ${JSON.stringify(id)})`,
    );
  const name = reqString(r, "name");

  const owns = Array.isArray(r.owns)
    ? r.owns.filter((x): x is string => typeof x === "string")
    : [];

  const responsibilities = Array.isArray(r.responsibilities)
    ? r.responsibilities.filter((x): x is string => typeof x === "string")
    : [];

  // autonomyCeiling: 0–4, default 4 (uncapped).
  let autonomyCeiling: TrustLevel = 4;
  if (r.autonomyCeiling !== undefined) {
    const c = r.autonomyCeiling;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 4)
      throw new WorkerParseError(
        "worker.autonomyCeiling must be an integer 0–4",
      );
    autonomyCeiling = c as TrustLevel;
  }

  let competence: WorkerCompetence | undefined;
  if (r.competence !== undefined) {
    const c = r.competence as Record<string, unknown>;
    if (
      typeof c !== "object" ||
      c === null ||
      typeof c.mean !== "number" ||
      typeof c.strength !== "number"
    )
      throw new WorkerParseError(
        "worker.competence must be { mean: number, strength: number }",
      );
    if (c.mean < 0 || c.mean > 1)
      throw new WorkerParseError("worker.competence.mean must be in [0,1]");
    competence = { mean: c.mean, strength: c.strength };
  }

  return {
    id,
    name,
    responsibilities,
    recipe: typeof r.recipe === "string" ? r.recipe : undefined,
    owns,
    autonomyCeiling,
    competence,
    sector: typeof r.sector === "string" ? r.sector : undefined,
  };
}

/** The per-class trust prior for a worker (its shipped competence, or uniform). */
export function priorFor(worker: WorkerManifest): Posterior {
  return worker.competence
    ? priorFromCompetence(worker.competence.mean, worker.competence.strength)
    : DEFAULT_PRIOR;
}

/** Whether a worker is responsible for a given action-class. A pattern matches
 * the class domain, an exact key, or a key prefix. Empty `owns` ⇒ owns nothing. */
export function ownsAction(worker: WorkerManifest, ac: ActionClass): boolean {
  return worker.owns.some(
    (p) => p === ac.domain || p === ac.key || ac.key.startsWith(`${p}:`),
  );
}

/**
 * Ownership check against a raw class key (`domain:reversibility:blastTier`),
 * for callers that have a board row's `classKey` but not a full ActionClass
 * (e.g. the dial). Mirrors `ownsAction`: the domain is the key's first segment.
 */
export function ownsClassKey(
  worker: WorkerManifest,
  classKey: string,
): boolean {
  const domain = classKey.split(":")[0];
  return worker.owns.some(
    (p) => p === domain || p === classKey || classKey.startsWith(`${p}:`),
  );
}
