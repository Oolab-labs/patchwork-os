/**
 * Durable standing-permission record, and the log of every time one was used.
 *
 * Two files, deliberately:
 *
 *   permissions.jsonl           grants and revocations
 *   permission_exercises.jsonl  one row per action taken under a grant
 *
 * They are separated because they have different lifetimes and wildly
 * different volumes. A grant is rare and must never be lost; an exercise is
 * routine and high-volume. Interleaving them would mean every "what am I
 * currently allowing?" read scans months of routine traffic, and any future
 * bound on the busy file would put the grants at risk. Neither file rotates
 * today — same reasoning as `factStore.ts`: if a bound is ever needed here it
 * has to be LOUD, never quiet truncation, because "when did I allow this?" is
 * an audit question.
 *
 * Append-only, like everything else in `src/butler/`. A revocation is a NEW
 * row carrying the same `id` with `revokedAt` set; `list()` folds the rows
 * into current state at read time. Nothing is ever rewritten, so a revoked
 * grant stays fully auditable — "this was allowed for three weeks and then
 * withdrawn" is exactly the shape an audit asks about, and a store that
 * deleted the row could not answer it.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../fileLockSync.js";
import { patchworkPath } from "../patchworkHome.js";
import type { StandingPermission } from "./standingPermission.js";

/** One use of a grant. Written by the enforcement path, never by a preview. */
export interface PermissionExercise {
  permissionId: string;
  at: number;
  toolName: string;
  classKey: string;
  /** Which worker acted under the grant. */
  workerId?: string;
  recipeName?: string;
}

export interface PermissionStoreOptions {
  dir?: string;
  now?: () => number;
  logger?: { warn?: (msg: string) => void };
}

export interface GrantInput {
  scope: { domains: string[] };
  grantedBy?: string | null;
  ceiling?: StandingPermission["ceiling"];
  expiresAt?: number;
  note?: string;
}

/** Local calendar day key. Deliberately local, not UTC: a person granting
 *  "five a day" means five in THEIR day, and a UTC boundary would reset the
 *  count in the middle of their afternoon. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class StandingPermissionStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly exerciseFile: string;
  private readonly now: () => number;
  private readonly logger: { warn?: (msg: string) => void };

  constructor(opts: PermissionStoreOptions = {}) {
    this.dir = opts.dir ?? patchworkPath("butler");
    this.file = path.join(this.dir, "permissions.jsonl");
    this.exerciseFile = path.join(this.dir, "permission_exercises.jsonl");
    this.now = opts.now ?? Date.now;
    // Never undefined — a dropped row means a grant or a revocation failed to
    // load, and silence there is the difference between "you allow this" and
    // "you allowed this once". Same defaulting as ButlerFactStore, for the
    // same reason.
    this.logger = opts.logger ?? { warn: (m: string) => console.warn(m) };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.logger.warn?.(
        `[butler-permissions] could not create ${this.dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Record a new grant. */
  grant(input: GrantInput): StandingPermission {
    const domains = input.scope.domains
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    if (domains.length === 0)
      throw new Error("a standing permission must name at least one domain");
    for (const d of domains) {
      if (d.includes("\0"))
        throw new Error("scope domains must not contain null bytes");
    }
    const perDay = input.ceiling?.perDay;
    if (perDay !== undefined && (!Number.isInteger(perDay) || perDay < 1))
      throw new Error("ceiling.perDay must be a positive integer");

    const p: StandingPermission = {
      id: randomUUID(),
      grantedAt: this.now(),
      // Explicit null, never the implicit owner (ADR-0020).
      grantedBy: input.grantedBy ?? null,
      scope: { domains },
      ...(input.ceiling && { ceiling: input.ceiling }),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      ...(input.note && { note: input.note }),
    };
    this.append(this.file, p);
    return p;
  }

  /**
   * Withdraw a grant. Takes effect on the very next decision — there is no
   * grace period and no in-flight allowance, because "I've changed my mind"
   * has to mean now.
   */
  revoke(id: string): StandingPermission {
    const current = this.list().find((p) => p.id === id);
    if (!current) throw new Error(`no standing permission with id ${id}`);
    if (current.revokedAt !== undefined) return current; // idempotent
    const revoked: StandingPermission = { ...current, revokedAt: this.now() };
    this.append(this.file, revoked);
    return revoked;
  }

  /**
   * Current state of every grant ever made, newest first.
   *
   * Revoked and expired grants are INCLUDED — filtering them here would make
   * the record unable to answer "what did I used to allow?", which is half the
   * point of keeping them. Callers wanting only live grants use `isActive`.
   */
  list(): StandingPermission[] {
    const byId = new Map<string, StandingPermission>();
    for (const row of this.read<StandingPermission>(this.file)) {
      if (typeof row?.id !== "string" || typeof row?.grantedAt !== "number")
        continue;
      // Last row for an id wins — the fold that turns an append-only log into
      // current state.
      byId.set(row.id, row);
    }
    return Array.from(byId.values()).sort((a, b) => b.grantedAt - a.grantedAt);
  }

  /** Live grants only, newest first — the list the gate consults. */
  active(now = this.now()): StandingPermission[] {
    return this.list().filter(
      (p) =>
        (p.revokedAt === undefined || p.revokedAt > now) &&
        (p.expiresAt === undefined || p.expiresAt > now) &&
        p.grantedAt <= now,
    );
  }

  /** Record one use. Fail-soft: a lost receipt must never block the action. */
  recordExercise(e: Omit<PermissionExercise, "at"> & { at?: number }): void {
    try {
      this.append(this.exerciseFile, { ...e, at: e.at ?? this.now() });
    } catch (err) {
      this.logger.warn?.(
        `[butler-permissions] could not record an exercise: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Every recorded use, oldest first. */
  exercises(): PermissionExercise[] {
    return this.read<PermissionExercise>(this.exerciseFile).filter(
      (e) => typeof e?.permissionId === "string" && typeof e?.at === "number",
    );
  }

  /** Uses of one grant on the local calendar day containing `now`. */
  usageToday(permissionId: string, now = this.now()): number {
    const key = dayKey(now);
    let n = 0;
    for (const e of this.exercises()) {
      if (e.permissionId === permissionId && dayKey(e.at) === key) n++;
    }
    return n;
  }

  private append(file: string, row: unknown): void {
    withFileLockSync(file, () => {
      appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    });
  }

  /** Whole-file read. These files are small and read rarely (a gate decision
   *  reads `active()`, not the exercise log), so the tail-on-read watermark
   *  the fact store needs would be complexity without a payoff — and the
   *  watermark has a known clobber bug this deliberately does not inherit. */
  private read<T>(file: string): T[] {
    try {
      statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      this.logger.warn?.(
        `[butler-permissions] could not read ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        this.logger.warn?.(
          `[butler-permissions] skipped an unparseable row in ${path.basename(file)}`,
        );
      }
    }
    return out;
  }
}
