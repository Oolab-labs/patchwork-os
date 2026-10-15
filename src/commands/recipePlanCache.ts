/**
 * In-memory cache for dry-run plans (`runRecipeDryPlan`).
 *
 * Building a plan is synchronous CPU — YAML parse, normalisation, every lint
 * rule, registry enrichment — and a dashboard that shows readiness for every
 * installed recipe asks for one plan per recipe. Uncached, each of those
 * requests blocks the event loop for every other request on the bridge.
 *
 * A cached plan must be indistinguishable from a freshly built one, so the
 * key carries EVERY input the plan is derived from:
 *
 *   - the resolved recipe path and the sha256 of the file's bytes (the bytes
 *     are still read and hashed on every request; only parse + lint are
 *     skipped);
 *   - the tool registry generation (bumped on every register / clear), since
 *     step enrichment, output-context keys and schema lint read the registry;
 *   - the request options that change the plan: `step` and `vars`;
 *   - the lint environment: whether `ANTHROPIC_API_KEY` is set (a lint rule
 *     warns on its absence) and whether schema lint is enabled.
 *
 * Two inputs only matter for SOME recipes, so they are recorded on the entry
 * and checked on a hit rather than paid for on every request:
 *
 *   - the clock: a flat recipe whose steps render `{{date}}` / `{{time}}` gets
 *     the minute it was rendered in, and a hit in a different minute rebuilds;
 *   - the plugin policy (active profile + `config.plugins.allow`), which lint
 *     consults only for a recipe that declares `servers:`.
 *
 * Chained recipes are NOT cached. Their plan and lint read child recipes from
 * disk (recursively, through named and relative refs), and the set of files a
 * plan depended on is not cleanly knowable from the parent's bytes. Rather
 * than key on a partial dependency list, they are always rebuilt.
 */
import { activeProfile } from "../governance/profile.js";
import { loadConfig as loadPatchworkConfig } from "../patchworkConfig.js";

export const PLAN_CACHE_MAX_ENTRIES = 256;

export interface PlanCacheEntry<T> {
  plan: T;
  /** Minute stamp the plan was rendered in, or null when it renders no clock token. */
  clockStamp: string | null;
  /** Plugin-policy fingerprint at build time, or null when lint never consulted it. */
  pluginPolicy: string | null;
}

/** Bounded LRU over a Map's insertion order. */
export class PlanCache<T> {
  private readonly entries = new Map<string, PlanCacheEntry<T>>();

  constructor(private readonly maxEntries = PLAN_CACHE_MAX_ENTRIES) {}

  get(key: string): PlanCacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: PlanCacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The clock values a flat dry-run plan renders — must match the `date` /
 * `time` context entries `buildSimpleRecipeDryRunSteps` builds from `now`.
 */
export function clockStampOf(now: Date): string {
  return `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)}`;
}

const TEMPLATE_EXPR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Does any string anywhere in `value` contain a template expression rooted at
 * `date` or `time`? Deliberately broader than what the dry-run renderer
 * actually expands (it walks every nested string, not only rendered fields),
 * so the answer can be a false "yes" — a shorter cache lifetime — but never a
 * false "no".
 */
export function rendersClockToken(value: unknown): boolean {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_EXPR_RE)) {
      const root = (match[1] ?? "").trim().split(".")[0];
      if (root === "date" || root === "time") return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(rendersClockToken);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      rendersClockToken,
    );
  }
  return false;
}

/**
 * Does lint consult the plugin policy for this recipe? It does whenever the
 * recipe carries a `servers:` key (see `lintPluginPolicy`). Checked on the
 * raw parse AND the normalised recipe so a migration that moves the key
 * cannot hide it.
 */
export function declaresServers(raw: unknown, normalized: unknown): boolean {
  const has = (v: unknown) =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).servers !== undefined;
  return has(raw) || has(normalized);
}

/**
 * Everything `lintPluginPolicy` reads when no explicit policy is passed: the
 * active profile, `config.plugins.allow`, and the working directory relative
 * plugin specs are normalised against. Mirrors its error handling (an
 * unreadable config is treated as no allow-list).
 */
export function pluginPolicyFingerprint(): string {
  let allow: unknown;
  try {
    allow = loadPatchworkConfig().plugins?.allow;
  } catch {
    allow = undefined;
  }
  return JSON.stringify([activeProfile(), allow ?? null, process.cwd()]);
}
