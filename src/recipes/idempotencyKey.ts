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
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { writeFileAtomicSync } from "../writeFileAtomic.js";

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
 * Compose a collision-safe scope key from `(recipeName, manualRunId)`.
 *
 * Naive `${recipeName}:${manualRunId}` is ambiguous: recipe `a:b` +
 * attempt `c` and recipe `a` + attempt `b:c` both produce `a:b:c` and
 * would share a ledger scope, letting one attempt read another's
 * cached write-tool outputs. We hash both fields separately as a JSON
 * array so the encoding is unambiguous regardless of either field's
 * contents.
 *
 * Returned as a 32-hex-char SHA-256 prefix — long enough that
 * collisions across a realistic ledger are effectively impossible
 * (~2^128 birthday bound), short enough to scan in a JSONL row.
 */
export function deriveScopeKey(
  recipeName: string,
  manualRunId: string,
): string {
  const payload = JSON.stringify([recipeName, manualRunId]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * `manualRunId` charset validation — caller-supplied id from the CLI
 * (`--attempt`), HTTP routes, or SDK. Rejects null bytes, control
 * characters, path-traversal slugs (`/`, `\`, `..`), and anything
 * longer than 64 chars. Returns the id verbatim when valid; throws
 * with a descriptive message otherwise.
 *
 * Why strict: this string is hashed into the disk-ledger scope key,
 * appended to `runs.jsonl` rows (capped audit-row size depends on it),
 * and rendered into dashboard pills + CLI output. A 10 MB id would
 * inflate every row past `MAX_PERSIST_BYTES` and erase audit during
 * rotation; control characters break line-delimited persistence.
 */
const MANUAL_RUN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertValidManualRunId(id: string): string {
  if (typeof id !== "string" || !MANUAL_RUN_ID_PATTERN.test(id)) {
    throw new Error(
      `manualRunId must match ${MANUAL_RUN_ID_PATTERN} (1-64 chars of [A-Za-z0-9_.-]); got: ${JSON.stringify(id).slice(0, 80)}`,
    );
  }
  return id;
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
/**
 * Optional disk-backed persistence for the ledger.
 *
 * PR5b — extends in-memory dedup so a *retry* of the same logical
 * `(recipeName, manualRunId)` attempt won't replay side effects. The
 * ledger stays per-attempt; cron/webhook runs and recipes without a
 * manualRunId stay purely in memory (no scope key = nothing to write).
 *
 * File layout: a single JSONL at `${dir}/effect_ledger.jsonl`. Each row
 * is `{scopeKey, idemKey, output, recordedAt}`. On construction, the
 * ledger streams the file and rehydrates entries whose `scopeKey`
 * matches the configured scope; everything else is left alone for the
 * other attempts' ledgers to pick up.
 *
 * Failure mode: any IO error falls back to in-memory operation and logs
 * a warning. A partially-replayed attempt with an unreadable ledger
 * degrades to "re-execute side effects" — louder than "silently dedup
 * something we can't audit".
 */
export interface DiskLedgerOptions {
  /** Directory holding `effect_ledger.jsonl`. Created if missing. */
  dir: string;
  /** `${recipeName}:${manualRunId}` — composed by the caller. */
  scopeKey: string;
  logger?: Logger;
}

interface LedgerRow {
  scopeKey: string;
  idemKey: string;
  output: string | null;
  recordedAt: number;
}

const LEDGER_FILENAME = "effect_ledger.jsonl";
const MAX_PERSIST_BYTES = 1024 * 1024; // 1 MB — same posture as runLog
const MAX_PERSIST_LINES = 10_000;

/**
 * Validate a caller-supplied ledger directory before any filesystem IO.
 *
 * The dir argument flows from the CLI (`--ledger-dir`) and (if/when
 * exposed) HTTP-runner inputs; we'd rather fail loudly than write JSONL
 * to whatever path is handed in. Three checks:
 *
 *  - **No null bytes** — would short-circuit C string handling in older
 *    libc paths and confuse logs / audit tooling.
 *  - **Absolute** — relative paths resolve against `process.cwd()`,
 *    which for recipe runs is the workspace; an `--ledger-dir foo`
 *    silently scattering ledger files under recipe sources is the
 *    wrong default. Caller can pass `path.resolve(...)` explicitly if
 *    they want relative resolution.
 *  - **Not a symlink** — if the directory already exists and is a
 *    symlink, an attacker who can write to the symlink's owning dir
 *    can swap the target and redirect appends. Rejecting up front
 *    means a fresh dir is created (via mkdirSync) or an existing real
 *    dir is used; symlink-replacement on the JSONL file itself is
 *    handled separately on each read in `loadExisting`.
 */
function assertSafeLedgerDir(dir: string): void {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("ledgerDir must be a non-empty string");
  }
  if (dir.includes("\0")) {
    throw new Error("ledgerDir must not contain null bytes");
  }
  if (!path.isAbsolute(dir)) {
    throw new Error(`ledgerDir must be an absolute path; got: ${dir}`);
  }
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`ledgerDir must not be a symlink: ${dir}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // dir will be created later — fine
    throw err;
  }
}

export class WriteEffectLedger {
  private readonly cache = new Map<string, string | null>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly disk: DiskLedgerOptions | null;
  private readonly file: string | null;

  constructor(disk?: DiskLedgerOptions) {
    if (disk) {
      // Validate + normalise the directory before any IO. Rejects null
      // bytes (would short-circuit C string handling in libc paths),
      // requires absolute paths (relative paths resolve against cwd
      // which is the recipe workspace — surprising and racy), and
      // refuses symlinks (a symlink swap on the ledger directory after
      // construction could redirect appends to an attacker-chosen
      // path).
      assertSafeLedgerDir(disk.dir);
    }
    this.disk = disk ?? null;
    this.file = disk ? path.join(disk.dir, LEDGER_FILENAME) : null;
    if (this.disk && this.file) {
      try {
        mkdirSync(this.disk.dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        this.disk.logger?.warn?.(
          `[effect-ledger] could not create ${this.disk.dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.loadExisting();
    }
  }

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
    if (this.disk && this.file) {
      this.append({
        scopeKey: this.disk.scopeKey,
        idemKey: key,
        output,
        recordedAt: Date.now(),
      });
    }
  }

  /**
   * Atomically check cache + in-flight map, then execute `fn` at most once
   * per key. Concurrent callers with the same key share a single Promise —
   * fixing the TOCTOU window that existed between `has()` and `record()`.
   * Failures are not cached so retry-after-failure still re-executes.
   */
  getOrExecute(
    key: string,
    fn: () => Promise<string | null>,
  ): Promise<string | null> {
    if (this.cache.has(key)) {
      return Promise.resolve(this.cache.get(key) ?? null);
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = fn().then(
      (result) => {
        this.record(key, result);
        this.inFlight.delete(key);
        return result;
      },
      (err: unknown) => {
        this.inFlight.delete(key);
        throw err;
      },
    );
    this.inFlight.set(key, work);
    return work;
  }

  /** Test-only inspection of the current key set. */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  size(): number {
    return this.cache.size;
  }

  private loadExisting(): void {
    if (!this.disk || !this.file) return;
    let raw: string;
    try {
      // `lstat` (not `stat`) so we see the symlink, not its target.
      // A swapped symlink at `${dir}/effect_ledger.jsonl` would
      // otherwise let an attacker substitute another file's contents
      // as cached tool outputs.
      const st = lstatSync(this.file);
      if (st.isSymbolicLink()) {
        this.disk.logger?.warn?.(
          `[effect-ledger] refusing to load ${this.file}: file is a symlink`,
        );
        return;
      }
      raw = readFileSync(this.file, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.disk.logger?.warn?.(
          `[effect-ledger] read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as LedgerRow;
        if (
          typeof row.scopeKey !== "string" ||
          typeof row.idemKey !== "string"
        ) {
          continue;
        }
        if (row.scopeKey === this.disk.scopeKey) {
          this.cache.set(row.idemKey, row.output ?? null);
        }
      } catch {
        /* skip malformed row */
      }
    }
  }

  private append(row: LedgerRow): void {
    if (!this.disk || !this.file) return;
    try {
      try {
        const st = statSync(this.file);
        if (st.size > MAX_PERSIST_BYTES) this.rotate();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch (err) {
      this.disk.logger?.warn?.(
        `[effect-ledger] append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Trim `effect_ledger.jsonl` to the most recent MAX_PERSIST_LINES.
   * Best-effort — failure logs and the next append proceeds against the
   * un-rotated file. Same pattern as RecipeRunLog / DecisionTraceLog.
   */
  private rotate(): void {
    if (!this.file || !this.disk) return;
    try {
      const raw = readFileSync(this.file, "utf-8");
      let lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length > MAX_PERSIST_LINES) {
        lines = lines.slice(-MAX_PERSIST_LINES);
      }
      writeFileAtomicSync(
        this.file,
        lines.length > 0 ? `${lines.join("\n")}\n` : "",
        { mode: 0o600 },
      );
    } catch (err) {
      this.disk.logger?.warn?.(
        `[effect-ledger] rotate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
