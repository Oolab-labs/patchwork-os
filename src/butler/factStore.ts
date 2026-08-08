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
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../fileLockSync.js";
import { patchworkPath } from "../patchworkHome.js";
import { ButlerNotFoundError, ButlerValidationError } from "./errors.js";
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
  if (!t) throw new ButlerValidationError(`${field} is required`);
  // NUL would corrupt a JSONL row and break `factKey`'s separator assumption.
  if (t.includes("\0"))
    throw new ButlerValidationError(`${field} must not contain null bytes`);
  if (t.length > max)
    throw new ButlerValidationError(`${field} exceeds ${max} characters`);
  return t;
}

export class ButlerFactStore {
  private facts: ButlerFact[] = [];
  private seq = 0;
  private readonly file: string;
  private readonly dir: string;
  private readonly now: () => number;
  /**
   * Never undefined. The torn-row and malformed-row warnings are the store's
   * ONLY signal that a durable belief failed to load, and a caller that simply
   * forgot the option turned them into silent no-ops — which is how
   * `src/tools/index.ts` shipped with them disabled. Defaulting here fixes
   * every present and future call site instead of one.
   */
  private readonly logger: { warn?: (msg: string) => void };
  /** ADR-0007 tail-on-read watermark. */
  private lastReadOffset = 0;

  constructor(opts: FactStoreOptions = {}) {
    this.dir = opts.dir ?? patchworkPath("butler");
    this.file = path.join(this.dir, "facts.jsonl");
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? {
      warn: (msg: string) => console.warn(msg),
    };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.logger.warn?.(
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
      throw new ButlerValidationError("object must not contain null bytes");
    if (object.length > MAX_OBJECT_CHARS)
      throw new ButlerValidationError(
        `object exceeds ${MAX_OBJECT_CHARS} characters`,
      );

    const tier = PROVENANCE_TIER[input.channel];
    if (tier === undefined)
      throw new ButlerValidationError(
        `unknown provenance channel: ${input.channel}`,
      );

    const cc = input.contentConfidence ?? 1;
    if (!Number.isFinite(cc) || cc < 0 || cc > 1)
      throw new ButlerValidationError(
        "contentConfidence must be between 0 and 1",
      );

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
    if (!target)
      throw new ButlerNotFoundError(`no fact with seq ${seqToRetract}`);
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

  /**
   * Undo a `forget`, putting the belief back AS IT WAS.
   *
   * The client used to do this by re-POSTing a plain fact, and
   * `POST /butler/facts` stamps `channel: "user_chat"` unconditionally — right
   * for a new claim from a person, wrong for an undo. A fact Butler had read
   * from a connector (tier 0.3, below `ORIGINATE_THRESHOLD`) came back as
   * something you had said yourself (tier 1.0, above it). The undo button was
   * a trust escalator through the barrier this store exists to enforce, and
   * the only visible difference was that the fact reappeared.
   *
   * Everything needed to rebuild it correctly is already here: `forget` writes
   * a tombstone and never removes the original row. So this reads the original
   * and re-appends its provenance verbatim — channel, source, sourceRef and
   * contentConfidence — rather than asking a caller to reassemble them. A
   * caller that gets that wrong fails in the permissive direction, silently,
   * which is the failure that happened.
   *
   * Appends rather than mutating: the log must still answer "this was
   * retracted at T1 and restored at T2", not pretend neither happened.
   *
   * @param tombstoneSeq The seq of the tombstone written by `forget`.
   */
  restore(tombstoneSeq: number): ButlerFact {
    this.tail();
    const tomb = this.facts.find((f) => f.seq === tombstoneSeq);
    if (!tomb)
      throw new ButlerNotFoundError(`no fact with seq ${tombstoneSeq}`);
    if (tomb.retracts === undefined)
      throw new ButlerValidationError(
        `fact ${tombstoneSeq} is not a retraction — nothing to restore`,
      );
    const original = this.facts.find((f) => f.seq === tomb.retracts);
    if (!original)
      throw new ButlerNotFoundError(`no fact with seq ${tomb.retracts}`);

    const recordedAt = this.now();
    const restored: ButlerFact = {
      ...original,
      seq: ++this.seq,
      recordedAt,
      validFrom: recordedAt,
      // Points at the TOMBSTONE, not at the original. The chain reads
      // "belief → retraction → restoration", which is what happened.
      supersedes: tombstoneSeq,
    };
    this.append(restored);
    return restored;
  }

  /**
   * GDPR Art. 17 erasure. THE ONLY method in this class that rewrites the log.
   *
   * A tombstone (`forget`) stops a belief resolving but leaves the words on
   * disk, which is the right audit behaviour and the wrong erasure behaviour —
   * "delete my address" cannot mean "keep my address, annotated". So the two
   * are separate operations with separate routes, and the caller must ask for
   * this one explicitly.
   *
   * What survives: the row, its seq, its timestamps, its provenance, and
   * `erased: true` + `erasedAt`. What is destroyed: subject, predicate,
   * object — every field that can carry personal data. Keeping the husk is
   * deliberate; see the `erased` docstring in types.ts.
   *
   * Rewrite is atomic (temp file + rename) and holds the same lock as an
   * append, so a sibling process cannot append into the file between the read
   * and the replace and have its row silently dropped.
   */
  erase(seqToErase: number): ButlerFact {
    this.tail();
    if (!this.facts.some((f) => f.seq === seqToErase))
      throw new ButlerNotFoundError(`no fact with seq ${seqToErase}`);

    let erasedRow: ButlerFact | undefined;
    const tmp = `${this.file}.erase.${process.pid}.tmp`;
    withFileLockSync(this.file, () => {
      const lines = readFileSync(this.file, "utf8").split("\n");
      const out: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let f: ButlerFact;
        try {
          f = JSON.parse(line) as ButlerFact;
        } catch {
          // Preserve a torn row verbatim. Dropping it here would turn an
          // erasure request into silent data loss for an unrelated belief.
          out.push(line);
          continue;
        }
        if (f.seq === seqToErase) {
          const row: ButlerFact = {
            ...f,
            subject: "",
            predicate: "",
            object: "",
            erased: true,
            erasedAt: this.now(),
          };
          erasedRow = row;
          out.push(JSON.stringify(row));
        } else {
          out.push(line);
        }
      }
      writeFileSync(tmp, out.length ? `${out.join("\n")}\n` : "", {
        mode: 0o600,
      });
      renameSync(tmp, this.file);
      this.lastReadOffset = statSync(this.file).size;
    });

    if (!erasedRow) {
      // In memory but not on disk — the append that created it failed, or a
      // sibling truncated the file. Say so rather than reporting success.
      throw new Error(`fact ${seqToErase} was not found on disk`);
    }
    // The file changed length underneath the watermark, so a delta read would
    // splice. Reload from scratch.
    this.facts = [];
    this.seq = 0;
    this.lastReadOffset = 0;
    this.tail();
    return erasedRow;
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
      this.logger.warn?.(
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
        this.logger.warn?.(
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
        this.logger.warn?.("[butler-facts] skipped a malformed row");
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
