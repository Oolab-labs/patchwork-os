/**
 * Idempotency keys for write-tool calls.
 *
 * PR5a of the Val-inspired plan. Foundation for safe retry + safe resume.
 *
 * Two pieces:
 *
 *   `deriveIdempotencyKey(toolId, params)`
 *     A stable, deterministic hash over `(toolId, canonicalised params)`.
 *     Canonicalisation = JSON.stringify with sorted keys, recursive — so
 *     `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash identically. Returns a
 *     hex SHA-256 prefix (first 16 chars; collisions vanishingly small
 *     within a single run scope).
 *
 *   `WriteEffectLedger`
 *     Per-run in-memory map of key → cached output. The runner constructs
 *     one per recipe run and threads it through `StepDeps` / `ToolContext`.
 *     `toolRegistry.executeTool` checks the ledger before invoking write
 *     tools; if the key is present, returns the cached output instead of
 *     re-executing — preventing duplicate side effects when two parallel
 *     branches of a chained recipe both call the same write tool with the
 *     same params.
 *
 * Scope of this PR (deliberately narrow):
 *   - In-run dedup only (Map lives for one recipe run, discarded after).
 *   - Records only on successful execution; errors don't pollute the
 *     ledger, so retry-after-failure still re-executes (correct: if the
 *     tool errored, we can't assume the side effect happened).
 *   - No cross-run persistence — that's PR5b (disk-backed effect ledger).
 *   - No retry-time idempotency on partial-failure cases (Slack posted
 *     but HTTP timed out); that needs tool-side support and is a future
 *     PR.
 *
 * The protection this DOES provide today: a `parallel:` block (or a
 * recipe that calls a write tool from two different chained steps with
 * identical params) cannot duplicate the side effect. Concretely, this
 * was a footgun that pre-dated PR5a: `chainedRunner.ts` schedules steps
 * with dependency-graph parallelism; if two branches happen to call
 * `slack.postMessage` with the same payload, the message went twice.
 */

import { createHash } from "node:crypto";

/**
 * Stable canonical-JSON serialiser. Recursively sorts object keys so two
 * params records with the same shape but different key order produce the
 * same string. Plain objects only — falls back to `JSON.stringify` for
 * arrays / primitives / null.
 */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Derive a stable idempotency key for a write-tool invocation. 16 hex
 * chars is 64 bits of entropy — far more than enough for in-run dedup
 * (a single recipe with even 10⁵ steps has ~5×10⁻¹⁰ collision risk).
 */
export function deriveIdempotencyKey(
  toolId: string,
  params: Record<string, unknown>,
): string {
  const payload = `${toolId}|${canonicalise(params)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * In-memory per-run ledger of executed write-tool calls. Maps idempotency
 * keys to the cached output the tool returned, so a duplicate call can
 * be short-circuited to the same result the first call produced.
 *
 * The ledger is single-threaded by design — runners are single-process
 * and a per-run ledger has no cross-thread access. Concurrency safety
 * within a run is provided by the dependency graph (parallel-only steps
 * with no shared params hash by construction); the ledger catches
 * accidental same-params calls.
 */
export class WriteEffectLedger {
  private readonly cache = new Map<string, string | null>();

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Return the previously-cached output for `key`, or `undefined` if not
   * recorded. `null` is a legitimate cached value (= the tool returned
   * `null` originally), so callers must use `has()` to distinguish "not
   * present" from "present and null".
   */
  get(key: string): string | null | undefined {
    return this.cache.get(key);
  }

  record(key: string, output: string | null): void {
    this.cache.set(key, output);
  }

  /** Test-only inspection of the current key set. */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  size(): number {
    return this.cache.size;
  }
}
