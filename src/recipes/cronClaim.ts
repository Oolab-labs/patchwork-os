/**
 * Cross-process claim on a scheduled fire (#1458).
 *
 * ## The bug
 *
 * `RecipeScheduler` guards double-fire with an in-memory `Set`, and its own
 * comment states the assumption: *"The guard is scheduler-scoped (one process),
 * which is enough because that's the only place a cron tick can originate."*
 *
 * That assumption does not hold. The recipe store is global — `patchworkPath
 * ("recipes")` — so **every** running bridge schedules **every** enabled cron
 * recipe, and an in-process `Set` cannot see a sibling process. N bridges ⇒ N
 * fires. Observed live on 2026-08-19: one hourly recipe ran twice at the same
 * instant from two pids, and again the next hour.
 *
 * Two bridges is a supported, documented shape, so "run one bridge" is not the
 * answer.
 *
 * ## The claim is on the TICK, not on the recipe
 *
 * This is the whole design, and it is what keeps manual runs working.
 *
 * A tick is an externally generated event — the clock — that N processes each
 * observe independently, and whose correct execution count is one. A manual
 * `patchwork recipe run X` is an operator-generated event that exists exactly
 * once already. Deduping the second against the first would be a category
 * error, and the scheduler's existing comment says manual runs deliberately
 * bypass the guard.
 *
 * So the key is `(recipeName, slotEpochMs)` and the claim is taken by the cron
 * path and by nothing else. Manual runs, HTTP `POST /recipes/:name/run`,
 * webhooks and the file-watch/git-hook paths neither read nor write it. That is
 * structural, not a carve-out in the key.
 *
 * ## Why the slot must be threaded in, never re-read from the clock
 *
 * `fire()` runs an event-loop hop after the cron matcher matched. Re-deriving
 * the slot from `Date.now()` there would let bridge A compute `:00` and bridge
 * B `:01` for the same tick — two keys, and the duplicate is back, in a form
 * that reproduces only when the hop straddles a second boundary.
 *
 * node-cron hands the callback the matched instant with milliseconds already
 * zeroed, identically in every process running the same expression. That value
 * is threaded in as `slotEpochMs`, and floored again here so that an upstream
 * change reintroducing milliseconds cannot silently split the key.
 *
 * **No slot ⇒ no claim.** That covers the `@every` interval path (a bare
 * `setInterval`, phase-anchored to each process's own start, with no canonical
 * slot to agree on) and the `fireForTest` hook. Both then behave exactly as
 * they do today. `@every` is deliberately out of scope here rather than
 * quantised: zero installed recipes use it, and the quantised version has a
 * bias worth deciding on its own evidence. `RecipeScheduler` logs the exclusion
 * once per recipe, because a scheduling gap nobody is told about is how
 * `audit-in-flight` spent its whole life passing.
 *
 * ## The claim is a tombstone, not a lock
 *
 * It is never released. If it were released on completion, a peer whose tick is
 * delayed past the first bridge's completion — a 40 ms recipe and ticks 200 ms
 * apart is entirely reachable — would find no claim and fire. That reintroduces
 * the bug in a narrower window, which is worse, because it stops reproducing on
 * demand.
 *
 * Consequence, stated as a property rather than left as an oversight: this
 * guarantees **at-most-once per slot per `PATCHWORK_HOME`, not exactly-once.**
 * A process that dies between claiming and dispatching consumes the slot and no
 * peer picks it up. Exactly-once needs a claim a peer can safely steal, which
 * needs liveness plus a rule for re-running a run that got most of the way
 * through its side effects — that is crash recovery, a different feature, and
 * its failure mode is a duplicate of a run that DID have external effects.
 *
 * ## Failure is OPEN, and never silent
 *
 * `EEXIST` is not failure — it is the mechanism working, and it skips.
 * "Failure" means the store is unusable: `EACCES`, `EROFS`, `ENOSPC`, or an
 * unexpected throw. On those the tick FIRES, and the caller is told why so it
 * can log it and stamp the run.
 *
 * The reasoning, since this is the opposite of ADR-0016's fail-closed instinct:
 * the conditions that break this store are machine-level, so they break it for
 * every bridge at once, and failing closed would then yield ZERO executions of
 * every scheduled recipe rather than one — silently, for as long as it lasts.
 * Fail-open's worst case is exactly the bug we have today, which is known and
 * bounded. And this store shares a disk with the run log, the effect ledger and
 * the decision record: if `~/.patchwork` is unwritable the recipe is going to
 * run ungoverned or fail on its own, so stopping here selects a stop condition
 * on a *proxy* for "the disk is broken" instead of reporting the disk.
 *
 * ADR-0016 fails closed because its object is a tool call, whose safe default is
 * "no". This decides whether a clock tick has already been consumed by a peer,
 * and with no answer available the safe default is the status quo ante. That is
 * the same reasoning that makes the identity roster fail SOFT.
 *
 * `PATCHWORK_CRON_CLAIM_REQUIRED=1` flips it to fail-closed for deployments
 * whose scheduled recipes send email or post publicly, where the operator knows
 * the trade and we do not.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { patchworkPath } from "../patchworkHome.js";

/** Directory under PATCHWORK_HOME holding day-sharded claim files. */
export const CRON_CLAIM_DIRNAME = "cron-claims";

/**
 * How long claim day-directories are kept.
 *
 * This does not need to cover a schedule's period. It only needs to outlive the
 * window in which a duplicate of the SAME slot can arrive, which is bounded by
 * seconds. 48 h is five orders of magnitude of margin; the sweep exists solely
 * to bound growth.
 */
export const CLAIM_RETENTION_MS = 48 * 60 * 60 * 1000;

export type ClaimOutcome =
  /** This process owns the slot. Fire. */
  | { kind: "claimed" }
  /** A peer owns the slot. Do not fire. */
  | { kind: "taken" }
  /**
   * The store is unusable. The caller fires anyway (unless the operator set
   * `PATCHWORK_CRON_CLAIM_REQUIRED`), logs, and stamps the run so a resulting
   * duplicate is attributable rather than mysterious.
   */
  | { kind: "unavailable"; reason: string }
  /**
   * The store is unusable AND the operator asked for fail-closed. Do not fire.
   * Distinct from `taken` so the log can say which happened — "a peer has it"
   * and "we could not tell" are different facts about the system.
   */
  | { kind: "refused"; reason: string };

/**
 * Key for one scheduled fire.
 *
 * JSON-array encoding rather than `${a}:${b}`, for the reason `deriveScopeKey`
 * already documents: recipe `a:b` at slot `c` and recipe `a` at slot `b:c` must
 * not collide. Hex-only, so a recipe name containing `/`, spaces or unicode is
 * still a safe filename — the human-readable fields live inside the record.
 *
 * The schedule expression is deliberately NOT in the key. If a schedule is
 * edited and two bridges hot-reload at different moments they compute different
 * slots and both fire regardless; including the expression would not fix that
 * and would make a same-slot collision less likely to dedupe.
 */
export function cronClaimKey(recipeName: string, slotEpochMs: number): string {
  return createHash("sha256")
    .update(JSON.stringify(["cron", recipeName, slotEpochMs]))
    .digest("hex")
    .slice(0, 32);
}

/** `YYYY-MM-DD` in UTC. Day-sharded so the sweep deletes directories, not files. */
function dayShard(slotEpochMs: number): string {
  return new Date(slotEpochMs).toISOString().slice(0, 10);
}

export interface ClaimOptions {
  /** Root override for tests. Defaults to `patchworkPath(CRON_CLAIM_DIRNAME)`. */
  claimsDir?: string;
  /**
   * Fail-closed override. Defaults to reading
   * `PATCHWORK_CRON_CLAIM_REQUIRED`. Injected so a test can drive both
   * branches without mutating the environment.
   */
  required?: boolean;
}

function claimsRoot(opts: ClaimOptions): string {
  return opts.claimsDir ?? patchworkPath(CRON_CLAIM_DIRNAME);
}

function failClosed(opts: ClaimOptions): boolean {
  if (opts.required !== undefined) return opts.required;
  const v = process.env.PATCHWORK_CRON_CLAIM_REQUIRED;
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Try to claim `(recipeName, slotEpochMs)` for this process.
 *
 * `openSync(path, "wx")` is one atomic syscall that is simultaneously the test
 * and the set — no lock file, no shared append-only log, no read-modify-write,
 * and no serialisation between unrelated recipes. `withFileLockSync` was
 * considered and rejected for exactly those costs, plus a 30 s stale-lock TTL
 * that would stall every recipe's scheduling if a process died holding it.
 *
 * The record body is written for a human to read afterwards and is NEVER read
 * to make a decision — the kernel already made it at `open`.
 */
export function claimCronSlot(
  recipeName: string,
  slotEpochMs: number,
  opts: ClaimOptions = {},
): ClaimOutcome {
  // Floor again. The caller threads in an already-zeroed value, but a key that
  // silently splits on stray milliseconds fails in the one way that does not
  // reproduce, so it is worth one multiplication.
  const slot = Math.floor(slotEpochMs / 1000) * 1000;
  const dir = join(claimsRoot(opts), dayShard(slot));
  const file = join(dir, `${cronClaimKey(recipeName, slot)}.json`);

  let fd: number;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(file, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { kind: "taken" };
    const reason = code ?? (err instanceof Error ? err.message : "unknown");
    return failClosed(opts)
      ? { kind: "refused", reason }
      : { kind: "unavailable", reason };
  }

  try {
    writeSync(
      fd,
      `${JSON.stringify({
        v: 1,
        recipeName,
        slotEpochMs: slot,
        slotIso: new Date(slot).toISOString(),
        pid: process.pid,
        claimedAt: Date.now(),
      })}\n`,
    );
  } catch {
    // The claim is the file's EXISTENCE; the body is diagnostics. A failed body
    // write must not surrender a slot we already own — that would hand it to a
    // peer and fire twice.
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }

  return { kind: "claimed" };
}

/**
 * Delete claim day-directories older than the retention horizon.
 *
 * Best-effort and never throws: this is housekeeping, and a scheduler that
 * cannot start because it could not tidy up would be a far worse bug than the
 * disk usage it prevents.
 *
 * Returns the number of directories removed so a caller can log it — a sweep
 * that silently does nothing looks identical to one that has nothing to do.
 */
export function sweepCronClaims(
  now: number = Date.now(),
  opts: ClaimOptions = {},
): number {
  const root = claimsRoot(opts);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0; // nothing claimed yet, or unreadable — both are non-events here
  }
  let removed = 0;
  for (const name of entries) {
    // Parse the shard name rather than stat()-ing it: the directory's own mtime
    // moves every time a claim lands in it, so a busy day would never age out.
    const t = Date.parse(`${name}T00:00:00.000Z`);
    if (!Number.isFinite(t)) continue; // not one of ours; leave it alone
    if (now - t <= CLAIM_RETENTION_MS + 24 * 60 * 60 * 1000) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
