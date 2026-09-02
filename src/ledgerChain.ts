/**
 * Tamper-evident JSONL ledgers — ADR-0027.
 *
 * ONE append primitive for every ledger on the evidence spine, and ONE
 * verifier over the files it writes. The chain is a property of the BYTES on
 * disk: `iseq` is a per-ledger integrity sequence read from the file's tail
 * under the cross-process lock, and `prev` is the SHA-256 of the exact bytes
 * of the previous line. Nothing a process remembers is trusted for either —
 * two bridges sharing one `$PATCHWORK_HOME` is the normal case, not the edge.
 *
 * ## What is and is not repurposed
 *
 * `seq` on the receipt and gate ledgers is a per-PROCESS counter and stays
 * exactly what it was. `rv` is a schema level and stays one. The integrity
 * fields are new names ADDED behind a per-ledger `rv` bump, so a row written
 * before the chain existed is distinguishable from one that should carry it —
 * the sentinel ADR-0025 required before any stamping.
 *
 * ## Marker rows carry `kind` and NEVER `seq`
 *
 * Two marker shapes live in the same file as the data. Every existing loader
 * keys on its own data fields (`seq` + `workerId` + `toolName` + `action` for
 * the gate, numeric `seq` for receipts, known `kind`s for approvals), so a
 * marker with no `seq` is skipped by all of them. Adding `seq` to a marker
 * would put it in the receipt ring as a receipt. Do not.
 *
 * ## Legacy rows are byte-identical and never re-stamped
 *
 * The first chained append to a file that has no chain writes a `chain-start`
 * marker committing to the SHA-256 of every byte before it. That makes the old
 * evidence verifiable from the migration boundary without touching it, which
 * is the never-backfill doctrine applied rather than bent.
 *
 * ## A failed append is a different fact from "nobody recorded this"
 *
 * Every observability writer swallows its own errors on purpose. The cost was
 * that a ledger that silently stopped writing looked like a quiet day. Now a
 * failure is counted in `<file>.write_failed` (when and which errno, never a
 * payload), the NEXT successful row seals the count as `writeFailed: N`, and
 * until it does the verifier reports the count as PENDING.
 *
 * ## What this cannot do
 *
 * Prove authorship. Anyone with the operator's uid can rewrite the file and
 * both sidecars together. What they cannot do is change one row and leave the
 * rest standing, or shorten the file without the head sidecar disagreeing.
 * Signing is a control-plane concern (ADR-0019); no key material lives here.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./fileLockSync.js";

export const CHAIN_HASH_ALGORITHM = "sha256";

/** Written once: commits to the bytes that precede it. */
export interface ChainStartMarker {
  kind: "chain-start";
  at: number;
  legacyRows: number;
  legacyBytes: number;
  legacyHash: string;
}

/**
 * Written as the new FIRST line whenever rotation removes rows. Counts are
 * CUMULATIVE across rotations, so one marker answers "how many rows has this
 * file ever lost to rotation". `lastDroppedHash` re-anchors the chain: the
 * first kept chained row's `prev` must equal it.
 */
export interface RotationMarker {
  kind: "rotation";
  at: number;
  droppedRows: number;
  droppedLegacyRows: number;
  lastDroppedHash: string | null;
  lastDroppedIseq: number | null;
  firstKeptIseq: number | null;
}

export interface AppendChainedOptions {
  now?: () => number;
  /** Rotate when the file exceeds this many bytes. Absent ⇒ never rotate. */
  maxBytes?: number;
  /** Low-water target after rotation. Defaults to 90% of `maxBytes`. */
  rotateTarget?: number;
  /** Rotate when the file exceeds this many lines. Absent ⇒ no line cap. */
  maxLines?: number;
  mode?: number;
  lockTimeoutMs?: number;
  /**
   * Called after a rotation actually removed rows, with how many THIS rotation
   * dropped and how many the file held before. The gate ledger warns with the
   * count because coverage measures over a rotated file converge toward 1.0
   * by deletion (ADR-0025), and a number nobody prints is a number nobody
   * reads.
   */
  onRotate?: (info: { dropped: number; before: number }) => void;
}

export type ChainBreakKind =
  | "hash"
  | "gap"
  | "duplicate"
  | "order"
  | "truncated"
  | "unchained"
  | "malformed-row"
  | "malformed-marker";

export interface ChainBreak {
  kind: ChainBreakKind;
  /** 1-based line in the file. A position, never a value. */
  line: number;
  iseq: number | null;
}

export interface ChainVerification {
  file: string;
  absent: boolean;
  /**
   * The chain is internally intact: no breaks, no legacy mismatch, and the
   * head sidecar does not say the file used to be longer. Pending write
   * failures do NOT flip this — the chain is intact; the spine-level report
   * is where "a ledger stopped writing" becomes not-ok.
   */
  ok: boolean;
  /** Rows before the chain-start marker in THIS file. */
  legacyRows: number;
  legacyPrefix:
    | "none"
    | "unchained"
    | "verified"
    | "mismatch"
    | "unverifiable-rotated";
  chainedRows: number;
  lastIseq: number | null;
  rotations: number;
  /** Chained rows ever removed by rotation, from the marker's cumulative count. */
  droppedByRotation: number;
  breaks: ChainBreak[];
  writeFailedSealed: number;
  writeFailedPending: number;
  head: "ok" | "missing" | "truncated" | "mismatch" | "stale" | "n/a";
}

export function hashLine(line: string): string {
  return createHash(CHAIN_HASH_ALGORITHM).update(line, "utf8").digest("hex");
}

export function chainSidecarPaths(file: string): {
  head: string;
  writeFailed: string;
} {
  return { head: `${file}.head`, writeFailed: `${file}.write_failed` };
}

/**
 * Count one failed append. Never throws and never carries a payload: the
 * whole point is that the row that failed to land is not on disk anywhere.
 */
export function recordWriteFailure(
  file: string,
  code: string,
  now: () => number = Date.now,
): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(
      chainSidecarPaths(file).writeFailed,
      `${JSON.stringify({ at: now(), code })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* the disk that lost the row is losing the counter too; nothing to do */
  }
}

function countLines(file: string): number {
  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

function splitLines(text: string): string[] {
  const out = text.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function atomicWrite(file: string, text: string, mode: number): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode });
  try {
    renameSync(tmp, file);
  } catch (err) {
    if (
      process.platform === "win32" &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      try {
        unlinkSync(file);
      } catch {
        /* best-effort */
      }
      renameSync(tmp, file);
    } else {
      throw err;
    }
  }
}

/** What the tail of the file says the next row must chain to. */
interface TailState {
  /** No chain in the file yet — the whole file is a legacy prefix. */
  unchained: boolean;
  prevHash: string;
  nextIseq: number;
}

function readTail(lines: string[]): TailState {
  if (lines.length === 0) return { unchained: true, prevHash: "", nextIseq: 1 };
  let chained = false;
  let lastIseq: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = parseLine(lines[i] as string);
    if (!p) continue;
    if (isFiniteNumber(p.iseq)) {
      chained = true;
      lastIseq = p.iseq;
      break;
    }
    if (p.kind === "rotation") {
      chained = true;
      lastIseq = isFiniteNumber(p.lastDroppedIseq) ? p.lastDroppedIseq : 0;
      break;
    }
    if (p.kind === "chain-start") {
      chained = true;
      lastIseq = 0;
      break;
    }
  }
  if (!chained) return { unchained: true, prevHash: "", nextIseq: 1 };
  return {
    unchained: false,
    prevHash: hashLine(lines[lines.length - 1] as string),
    nextIseq: (lastIseq ?? 0) + 1,
  };
}

function rotate(
  file: string,
  lines: string[],
  opts: AppendChainedOptions,
  now: number,
  mode: number,
): string[] {
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const target = opts.rotateTarget ?? Math.floor(maxBytes * 0.9);
  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;

  // Fold the previous rotation marker's cumulative counts, then drop it: a
  // file has exactly one rotation marker, at line 1.
  let prior: RotationMarker | null = null;
  let body = lines;
  const first = lines.length > 0 ? parseLine(lines[0] as string) : null;
  if (first && first.kind === "rotation") {
    prior = first as unknown as RotationMarker;
    body = lines.slice(1);
  }

  let budget = target;
  let keepFrom = body.length;
  let kept = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(body[i] as string, "utf8") + 1;
    if (cost > budget || kept + 1 > maxLines) break;
    budget -= cost;
    keepFrom = i;
    kept++;
  }
  if (keepFrom === 0 && prior === null) return lines; // nothing to drop

  let droppedRows = prior?.droppedRows ?? 0;
  let droppedLegacyRows = prior?.droppedLegacyRows ?? 0;
  let lastDroppedIseq = prior?.lastDroppedIseq ?? null;
  let lastDroppedHash = prior?.lastDroppedHash ?? null;
  let seenChainStart = false;
  for (let i = 0; i < keepFrom; i++) {
    const line = body[i] as string;
    const p = parseLine(line);
    if (p && isFiniteNumber(p.iseq)) {
      droppedRows++;
      lastDroppedIseq = p.iseq;
    } else if (p && p.kind === "chain-start") {
      seenChainStart = true;
    } else if (!p || p.kind === undefined) {
      // Anything before chain-start that is not a marker is legacy; so is an
      // unparseable line, which the legacy hash committed to as bytes.
      if (!seenChainStart) droppedLegacyRows++;
    }
    lastDroppedHash = hashLine(line);
  }
  if (keepFrom > 0 && lastDroppedHash === null) lastDroppedHash = null;

  const keptLines = body.slice(keepFrom);
  const firstKept =
    keptLines.length > 0 ? parseLine(keptLines[0] as string) : null;
  const marker: RotationMarker = {
    kind: "rotation",
    at: now,
    droppedRows,
    droppedLegacyRows,
    lastDroppedHash,
    lastDroppedIseq,
    firstKeptIseq:
      firstKept && isFiniteNumber(firstKept.iseq) ? firstKept.iseq : null,
  };
  const out = [JSON.stringify(marker), ...keptLines];
  atomicWrite(file, out.length > 0 ? `${out.join("\n")}\n` : "", mode);
  return out;
}

/**
 * Append one row to a chained ledger. Under the cross-process lock: rotate if
 * over cap, read the tail, stamp `iseq` / `prev` / `writeFailed`, append,
 * update the head sidecar, clear the failure counter.
 *
 * The integrity fields are stamped AFTER the caller's fields, so a row cannot
 * forge its own position. The caller's object is never mutated.
 *
 * Throws on failure — after counting it in the write_failed sidecar — so a
 * writer keeps whatever contract it already has (most swallow and warn).
 */
export function appendChained(
  file: string,
  row: Record<string, unknown>,
  opts: AppendChainedOptions = {},
): { line: string; iseq: number } {
  const now = opts.now ?? Date.now;
  const mode = opts.mode ?? 0o600;
  const side = chainSidecarPaths(file);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return withFileLockSync(
      file,
      () => {
        let text = "";
        try {
          text = readFileSync(file, "utf-8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        let lines = splitLines(text);
        const overBytes =
          opts.maxBytes !== undefined &&
          Buffer.byteLength(text, "utf8") > opts.maxBytes;
        const overLines =
          opts.maxLines !== undefined && lines.length > opts.maxLines;
        if (overBytes || overLines) {
          const before = lines.length;
          lines = rotate(file, lines, opts, now(), mode);
          text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
          // The marker is one line, so `before - lines.length + 1` is what
          // rotation removed; a file with a prior marker also lost that one.
          const dropped = Math.max(0, before - (lines.length - 1));
          if (dropped > 0) opts.onRotate?.({ dropped, before });
        }

        const tail = readTail(lines);
        let prevHash = tail.prevHash;
        let iseq = tail.nextIseq;
        if (tail.unchained) {
          const marker: ChainStartMarker = {
            kind: "chain-start",
            at: now(),
            legacyRows: lines.length,
            legacyBytes: Buffer.byteLength(text, "utf8"),
            legacyHash: hashLine(text),
          };
          const markerLine = JSON.stringify(marker);
          appendFileSync(file, `${markerLine}\n`, { mode });
          prevHash = hashLine(markerLine);
          iseq = 1;
        }

        const pending = countLines(side.writeFailed);
        const stamped: Record<string, unknown> = {
          ...row,
          iseq,
          prev: prevHash,
          ...(pending > 0 ? { writeFailed: pending } : {}),
        };
        const line = JSON.stringify(stamped);
        appendFileSync(file, `${line}\n`, { mode });
        atomicWrite(
          side.head,
          `${JSON.stringify({ iseq, hash: hashLine(line) })}\n`,
          mode,
        );
        if (pending > 0) rmSync(side.writeFailed, { force: true });
        return { line, iseq };
      },
      { timeoutMs: opts.lockTimeoutMs ?? 5000 },
    );
  } catch (err) {
    recordWriteFailure(
      file,
      (err as NodeJS.ErrnoException).code ?? "EUNKNOWN",
      now,
    );
    throw err;
  }
}

function readHead(file: string): { iseq: number; hash: string } | null {
  try {
    const p = parseLine(
      readFileSync(chainSidecarPaths(file).head, "utf-8").trim(),
    );
    if (p && isFiniteNumber(p.iseq) && typeof p.hash === "string") {
      return { iseq: p.iseq, hash: p.hash };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify one ledger from its bytes. Read-only. Reports positions (line, iseq)
 * and counts, never a value.
 */
export function verifyLedgerChain(file: string): ChainVerification {
  const v: ChainVerification = {
    file,
    absent: !existsSync(file),
    ok: true,
    legacyRows: 0,
    legacyPrefix: "none",
    chainedRows: 0,
    lastIseq: null,
    rotations: 0,
    droppedByRotation: 0,
    breaks: [],
    writeFailedSealed: 0,
    writeFailedPending: countLines(chainSidecarPaths(file).writeFailed),
    head: "n/a",
  };
  if (v.absent) return v;

  const text = readFileSync(file, "utf-8");
  const lines = splitLines(text);

  // Every iseq in the file, so "the expected one exists later" (reordered) can
  // be told apart from "it exists nowhere" (a gap).
  const present = new Set<number>();
  for (const l of lines) {
    const p = parseLine(l);
    if (p && isFiniteNumber(p.iseq)) present.add(p.iseq);
  }

  let inChain = false;
  let sawChainStart = false;
  let legacyUnverifiable = false;
  let legacyBytes = 0;
  let expectedPrev = "";
  let expectedIseq: number | null = null;
  const seen = new Set<number>();
  let lastLine = "";
  let lastHash = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    const p = parseLine(line);
    const kind = p?.kind;

    if (kind === "rotation") {
      if (i !== 0 || !p) {
        v.breaks.push({ kind: "malformed-marker", line: lineNo, iseq: null });
        continue;
      }
      const ok =
        isFiniteNumber(p.droppedRows) &&
        isFiniteNumber(p.droppedLegacyRows) &&
        (p.lastDroppedHash === null || typeof p.lastDroppedHash === "string") &&
        (p.lastDroppedIseq === null || isFiniteNumber(p.lastDroppedIseq));
      if (!ok) {
        v.breaks.push({ kind: "malformed-marker", line: lineNo, iseq: null });
        continue;
      }
      v.rotations++;
      v.droppedByRotation = p.droppedRows as number;
      inChain = true;
      if ((p.droppedLegacyRows as number) > 0) legacyUnverifiable = true;
      if (typeof p.lastDroppedHash === "string")
        expectedPrev = p.lastDroppedHash;
      if (isFiniteNumber(p.lastDroppedIseq))
        expectedIseq = p.lastDroppedIseq + 1;
      continue;
    }

    if (kind === "chain-start") {
      const ok =
        p !== null &&
        !sawChainStart &&
        isFiniteNumber(p.legacyRows) &&
        isFiniteNumber(p.legacyBytes) &&
        typeof p.legacyHash === "string";
      sawChainStart = true;
      inChain = true;
      if (!ok) {
        v.breaks.push({ kind: "malformed-marker", line: lineNo, iseq: null });
      } else if (legacyUnverifiable) {
        v.legacyPrefix = "unverifiable-rotated";
      } else if (v.legacyRows === 0 && (p.legacyRows as number) === 0) {
        v.legacyPrefix = "none";
      } else {
        const prefix = text.slice(0, legacyBytes);
        v.legacyPrefix =
          hashLine(prefix) === p.legacyHash &&
          Buffer.byteLength(prefix, "utf8") === p.legacyBytes &&
          v.legacyRows === p.legacyRows
            ? "verified"
            : "mismatch";
      }
      expectedPrev = hashLine(line);
      if (expectedIseq === null) expectedIseq = 1;
      continue;
    }

    if (!inChain) {
      // Legacy prefix: committed to as bytes, so the content is not judged.
      v.legacyRows++;
      legacyBytes += Buffer.byteLength(line, "utf8") + 1;
      continue;
    }

    if (!p) {
      v.breaks.push({ kind: "malformed-row", line: lineNo, iseq: null });
      continue;
    }
    if (!isFiniteNumber(p.iseq)) {
      v.breaks.push({ kind: "unchained", line: lineNo, iseq: null });
      continue;
    }

    const iseq = p.iseq;
    v.chainedRows++;
    if (p.prev !== expectedPrev) {
      v.breaks.push({ kind: "hash", line: lineNo, iseq });
    }
    if (expectedIseq !== null && iseq !== expectedIseq) {
      let kind: ChainBreakKind;
      if (iseq > expectedIseq)
        kind = present.has(expectedIseq) ? "order" : "gap";
      else kind = seen.has(iseq) ? "duplicate" : "order";
      v.breaks.push({ kind, line: lineNo, iseq });
    }
    if (isFiniteNumber(p.writeFailed)) v.writeFailedSealed += p.writeFailed;
    seen.add(iseq);
    v.lastIseq = iseq;
    expectedIseq = iseq + 1;
    expectedPrev = hashLine(line);
    lastLine = line;
    lastHash = expectedPrev;
  }

  if (!inChain) {
    v.legacyPrefix = v.legacyRows > 0 ? "unchained" : "none";
  } else if (legacyUnverifiable && v.legacyPrefix === "none") {
    v.legacyPrefix = "unverifiable-rotated";
  }

  // The head sidecar is the only thing that can say the file used to be longer.
  if (inChain) {
    const head = readHead(file);
    if (!head) {
      v.head = "missing";
    } else if (v.lastIseq === null || head.iseq > v.lastIseq) {
      v.head = "truncated";
      v.breaks.push({
        kind: "truncated",
        line: lines.length,
        iseq: v.lastIseq,
      });
    } else if (head.iseq < v.lastIseq) {
      v.head = "stale";
    } else if (head.hash !== lastHash || lastLine === "") {
      v.head = "mismatch";
      v.breaks.push({ kind: "hash", line: lines.length, iseq: v.lastIseq });
    } else {
      v.head = "ok";
    }
  }

  v.ok =
    v.breaks.length === 0 &&
    v.legacyPrefix !== "mismatch" &&
    v.head !== "missing" &&
    v.head !== "truncated" &&
    v.head !== "mismatch";
  return v;
}
