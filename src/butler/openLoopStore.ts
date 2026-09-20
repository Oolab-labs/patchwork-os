/**
 * Durable store for Butler Loose Ends.
 *
 * This is intentionally NOT ButlerFactStore. Facts are durable beliefs about
 * the user; loose ends are temporary unfinished things. Mixing the two would
 * turn errands and promises into long-lived personal beliefs.
 *
 * Events append to <PATCHWORK_HOME>/butler/open_loops.jsonl. Reads re-read the
 * whole small experimental log so sibling-process writes are immediately
 * visible. Writes hold the shared file mutex so rows cannot interleave.
 *
 * Erasure is the one rewrite operation: it removes every row for the target
 * loop and replaces them with a content-free erased marker. "Complete" is not
 * deletion; the original words remain available for the experiment history.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../fileLockSync.js";
import { patchworkPath } from "../patchworkHome.js";
import { writeFileAtomicSync } from "../writeFileAtomic.js";
import { ButlerNotFoundError, ButlerValidationError } from "./errors.js";
import { resolveOpenLoops } from "./openLoopResolve.js";
import {
  MAX_OPEN_LOOP_TEXT_CHARS,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_RV,
  type OpenLoop,
  type OpenLoopBriefItem,
  type OpenLoopEvent,
  type OpenLoopKind,
  type OpenLoopSource,
} from "./openLoopTypes.js";

export interface OpenLoopStoreOptions {
  /** Directory holding open_loops.jsonl. Defaults to <PATCHWORK_HOME>/butler. */
  dir?: string;
  now?: () => number;
  uuid?: () => string;
  logger?: { warn?: (msg: string) => void };
}

export interface CreateOpenLoopInput {
  kind: OpenLoopKind;
  text: string;
  source?: OpenLoopSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenLoopEvent(value: unknown): value is OpenLoopEvent {
  if (!isRecord(value)) return false;
  if (value.rv !== OPEN_LOOP_RV) return false;
  if (typeof value.eventId !== "string" || typeof value.loopId !== "string")
    return false;

  switch (value.event) {
    case "created":
      return (
        typeof value.kind === "string" &&
        OPEN_LOOP_KINDS.has(value.kind as OpenLoopKind) &&
        typeof value.text === "string" &&
        typeof value.createdAt === "number" &&
        Number.isFinite(value.createdAt) &&
        (value.source === "http" ||
          value.source === "shortcut" ||
          value.source === "import")
      );
    case "completed":
    case "reopened":
      return typeof value.at === "number" && Number.isFinite(value.at);
    case "erased":
      return (
        typeof value.erasedAt === "number" && Number.isFinite(value.erasedAt)
      );
    default:
      return false;
  }
}

function cleanText(raw: string): string {
  const text = raw.trim();
  if (!text) throw new ButlerValidationError("text is required");
  if (text.includes("\0"))
    throw new ButlerValidationError("text must not contain null bytes");
  if (text.length > MAX_OPEN_LOOP_TEXT_CHARS) {
    throw new ButlerValidationError(
      `text exceeds ${MAX_OPEN_LOOP_TEXT_CHARS} characters`,
    );
  }
  return text;
}

export class ButlerOpenLoopStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly logger: { warn?: (msg: string) => void };

  constructor(opts: OpenLoopStoreOptions = {}) {
    this.dir = opts.dir ?? patchworkPath("butler");
    this.file = path.join(this.dir, "open_loops.jsonl");
    this.now = opts.now ?? Date.now;
    this.uuid = opts.uuid ?? randomUUID;
    this.logger = opts.logger ?? { warn: (msg: string) => console.warn(msg) };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  create(input: CreateOpenLoopInput): OpenLoop {
    if (!OPEN_LOOP_KINDS.has(input.kind)) {
      throw new ButlerValidationError(`unknown kind: ${String(input.kind)}`);
    }
    const text = cleanText(input.text);
    const loopId = this.uuid();
    const event: OpenLoopEvent = {
      rv: OPEN_LOOP_RV,
      event: "created",
      eventId: this.uuid(),
      loopId,
      kind: input.kind,
      text,
      createdAt: this.now(),
      source: input.source ?? "http",
    };
    this.append(event);
    const created = this.get(loopId);
    if (!created) throw new Error("created loose end could not be re-read");
    return created;
  }

  list(opts: { status?: "open" | "done"; kind?: OpenLoopKind } = {}): OpenLoop[] {
    let loops = resolveOpenLoops(this.readEvents());
    if (opts.status) loops = loops.filter((loop) => loop.status === opts.status);
    if (opts.kind) loops = loops.filter((loop) => loop.kind === opts.kind);
    return loops;
  }

  get(loopId: string): OpenLoop | undefined {
    return this.list().find((loop) => loop.id === loopId);
  }

  complete(loopId: string): OpenLoop {
    const current = this.require(loopId);
    if (current.status === "done") return current;
    this.append({
      rv: OPEN_LOOP_RV,
      event: "completed",
      eventId: this.uuid(),
      loopId,
      at: this.now(),
    });
    return this.require(loopId);
  }

  reopen(loopId: string): OpenLoop {
    const current = this.require(loopId);
    if (current.status === "open") return current;
    this.append({
      rv: OPEN_LOOP_RV,
      event: "reopened",
      eventId: this.uuid(),
      loopId,
      at: this.now(),
    });
    return this.require(loopId);
  }

  brief(limit = 3): { openCount: number; items: OpenLoopBriefItem[] } {
    const open = this.list({ status: "open" });
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.max(0, Math.min(limit, 20))
      : 3;
    return {
      openCount: open.length,
      items: open.slice(0, safeLimit).map((loop) => ({
        id: loop.id,
        kind: loop.kind,
        text: loop.text,
        reason: "Still open",
      })),
    };
  }

  erase(loopId: string): { id: string; erasedAt: number } {
    this.require(loopId);
    const erasedAt = this.now();
    const marker: OpenLoopEvent = {
      rv: OPEN_LOOP_RV,
      event: "erased",
      eventId: this.uuid(),
      loopId,
      erasedAt,
    };
    withFileLockSync(this.file, () => {
      const rows = this.readRawRows();
      const kept: string[] = [];
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row);
        } catch {
          // Preserve unrelated malformed/torn rows verbatim. Erasing one loose
          // end must not become a cleanup operation for another record.
          kept.push(row);
          continue;
        }
        if (
          isOpenLoopEvent(parsed) &&
          parsed.loopId === loopId
        ) {
          continue;
        }
        kept.push(row);
      }
      kept.push(JSON.stringify(marker));
      writeFileAtomicSync(this.file, `${kept.join("\n")}\n`, { mode: 0o600 });
    });

    return { id: loopId, erasedAt };
  }

  private require(loopId: string): OpenLoop {
    if (!loopId || loopId.includes("\0")) {
      throw new ButlerValidationError("id is required");
    }
    const loop = this.get(loopId);
    if (!loop) throw new ButlerNotFoundError(`no loose end with id ${loopId}`);
    return loop;
  }

  private append(event: OpenLoopEvent): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    withFileLockSync(this.file, () => {
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  private readRawRows(): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }

  private readEvents(): OpenLoopEvent[] {
    const events: OpenLoopEvent[] = [];
    for (const line of this.readRawRows()) {
      try {
        const value: unknown = JSON.parse(line);
        if (!isOpenLoopEvent(value)) {
          this.logger.warn?.("[butler-open-loops] ignored malformed event row");
          continue;
        }
        events.push(value);
      } catch {
        this.logger.warn?.("[butler-open-loops] ignored malformed JSON row");
      }
    }
    return events;
  }
}
