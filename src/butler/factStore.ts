/**
 * Append-only durable store for Butler's facts.
 *
 * Mirrors the house JSONL pattern (`decisionTraceLog.ts`): 0o700 dir, 0o600
 * file, `withFileLockSync` around each append so two bridges sharing $HOME
 * cannot interleave bytes within a row, ADR-0007 tail-on-read so a sibling
 * process's writes become visible within one query.
 *
 * ONE DELIBERATE DIVERGENCE: no rotation, no memory cap, no silent drop. The
 * trace log trims to 1 MB / 10 000 lines and discards the oldest rows, which is
 * right for an ops log and wrong for a belief store — "I'm allergic to
 * shellfish" must not evaporate behind ten thousand routine rows. If this file
 * ever needs a bound, it has to be LOUD: refuse the write, or tell the user
 * what is being forgotten. Never quiet truncation.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../fileLockSync.js";
import { patchworkPath } from "../patchworkHome.js";
import { type ResolveOpts, resolveFacts, resolveOne } from "./resolve.js";
import {
  type ButlerFact,
  MAX_OBJECT_CHARS,
  MAX_PREDICATE_CHARS,
  MAX_SUBJECT_CHARS,
  PROVENANCE_TIER,
  type ProvenanceChannel,
} from "./types.js";

export interface FactStoreOptions {
  /** Directory holding `facts.jsonl`. Defaults to `<patchworkHome>/butler`. */
  dir?: string;
  now?: () => number;
  logger?: { warn?: (msg: string) => void };
}

export interface RememberInput {
  subject: string;
  predicate: string;
  object: string;
  channel: ProvenanceChannel;
  ownerId?: string | null;
  source?: string;
  sourceRef?: string;
  contentConfidence?: number;
  validFrom?: number;
  validUntil?: number;
  supersedes?: number;
}

function clean(s: string, max: number, field: string): string {
  const t = s.trim();
  if (!t) throw new Error(`${field} is required`);
  // NUL would corrupt a JSONL row and break `factKey`'s separator assumption.
  if (t.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  if (t.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return t;
}

export class ButlerFactStore {
  private facts: ButlerFact[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;
  /** ADR-0007 tail-on-read watermark. */
  private lastReadOffset = 0;

  constructor(private readonly opts: FactStoreOptions = {}) {
    this.dir = opts.dir ?? patchworkPath("butler");
    this.file = path.join(this.dir, "facts.jsonl");
    this.now = opts.now ?? Date.now;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      opts.logger?.warn?.(
        `[butler-facts] could not create ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.tail();
  }

  /** Record a claim. Returns the stored row. Throws on invalid input. */
  remember(input: RememberInput): ButlerFact {
    const subject = clean(input.subject, MAX_SUBJECT_CHARS, "subject");
    const predicate = clean(input.predicate, MAX_PREDICATE_CHARS, "predicate");
    // `object` may legitimately be empty — an explicit "none" — so it is length
    // checked but not required.
    const object = input.object ?? "";
    if (object.includes("\0"))
      throw new Error("object must not contain null bytes");
    if (object.length > MAX_OBJECT_CHARS)
      throw new Error(`object exceeds ${MAX_OBJECT_CHARS} characters`);

    const tier = PROVENANCE_TIER[input.channel];
    if (tier === undefined)
      throw new Error(`unknown provenance channel: ${input.channel}`);

    const cc = input.contentConfidence ?? 1;
    if (!Number.isFinite(cc) || cc < 0 || cc > 1)
      throw new Error("contentConfidence must be between 0 and 1");

    this.tail();
    const recordedAt = this.now();
    const fact: ButlerFact = {
      seq: ++this.seq,
      // Explicit null, never a fallback to "the owner". An unattributed claim
      // must stay distinguishable from an attributed one (ADR-0020).
      ownerId: input.ownerId ?? null,
      subject,
      predicate,
      object,
      recordedAt,
      validFrom: input.validFrom ?? recordedAt,
      ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
      provenance: {
        channel: input.channel,
        ...(input.source && { source: input.source }),
        ...(input.sourceRef && { sourceRef: input.sourceRef }),
        tier,
        validated: input.channel === "user_confirmed",
      },
      contentConfidence: cc,
      trust: Math.min(tier, cc),
      ...(input.supersedes !== undefined && { supersedes: input.supersedes }),
    };
    this.append(fact);
    return fact;
  }

  /**
   * Retract a belief by writing a tombstone. The original row is never
   * removed — the log must still be able to answer "what did Butler believe
   * last Tuesday, and when did that stop".
   */
  forget(
    seqToRetract: number,
    by: ProvenanceChannel = "user_chat",
    ownerId?: string | null,
  ): ButlerFact {
    this.tail();
    const target = this.facts.find((f) => f.seq === seqToRetract);
    if (!target) throw new Error(`no fact with seq ${seqToRetract}`);
    const tier = PROVENANCE_TIER[by];
    const recordedAt = this.now();
    const tomb: ButlerFact = {
      seq: ++this.seq,
      ownerId: ownerId ?? target.ownerId,
      subject: target.subject,
      predicate: target.predicate,
      object: "",
      recordedAt,
      validFrom: recordedAt,
      provenance: { channel: by, tier, validated: by === "user_confirmed" },
      contentConfidence: 1,
      trust: tier,
      retracts: seqToRetract,
    };
    this.append(tomb);
    return tomb;
  }

  /** Current beliefs. Pure resolution over the tailed log. */
  recall(opts?: Partial<ResolveOpts>): ButlerFact[] {
    this.tail();
    return resolveFacts(this.facts, { now: this.now(), ...opts });
  }

  one(
    subject: string,
    predicate: string,
    opts?: Partial<ResolveOpts>,
  ): ButlerFact | undefined {
    this.tail();
    return resolveOne(this.facts, subject, predicate, {
      now: this.now(),
      ...opts,
    });
  }

  /** Every row, including tombstones and superseded values (audit view). */
  all(): ButlerFact[] {
    this.tail();
    return this.facts.slice();
  }

  size(): number {
    this.tail();
    return this.facts.length;
  }

  private append(fact: ButlerFact): void {
    this.facts.push(fact);
    try {
      withFileLockSync(this.file, () => {
        appendFileSync(this.file, `${JSON.stringify(fact)}\n`, { mode: 0o600 });
        try {
          this.lastReadOffset = statSync(this.file).size;
        } catch {
          /* next tail() reloads cleanly */
        }
      });
    } catch (err) {
      // A belief that did not reach disk must not look like one that did.
      this.facts.pop();
      throw new Error(
        `could not persist fact: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** ADR-0007 tail-on-read: absorb any rows a sibling process appended. */
  private tail(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
    if (size === this.lastReadOffset) return;
    if (size < this.lastReadOffset) {
      // Shrank — truncated or replaced underneath us. Reload from scratch
      // rather than reading a delta that would splice two different files.
      this.facts = [];
      this.seq = 0;
      this.lastReadOffset = 0;
    }
    let raw: string;
    try {
      const buf = readFileSync(this.file);
      raw = buf.subarray(this.lastReadOffset).toString("utf8");
    } catch (err) {
      this.opts.logger?.warn?.(
        `[butler-facts] could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.lastReadOffset = size;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn row is skipped, not fatal — but say so. Silence here would
        // make a lost belief indistinguishable from one never recorded.
        this.opts.logger?.warn?.(
          "[butler-facts] skipped an unparseable row — a belief may be missing",
        );
        continue;
      }
      const f = parsed as ButlerFact;
      if (
        typeof f?.seq !== "number" ||
        typeof f?.subject !== "string" ||
        typeof f?.predicate !== "string" ||
        typeof f?.trust !== "number"
      ) {
        this.opts.logger?.warn?.("[butler-facts] skipped a malformed row");
        continue;
      }
      this.facts.push(f);
      if (f.seq > this.seq) this.seq = f.seq;
    }
  }

  /** Test seam: overwrite the file with a known set. Never used in prod. */
  _writeAllForTests(facts: ButlerFact[]): void {
    writeFileSync(this.file, facts.map((f) => JSON.stringify(f)).join("\n"), {
      mode: 0o600,
    });
    this.facts = [];
    this.seq = 0;
    this.lastReadOffset = 0;
    this.tail();
  }
}
