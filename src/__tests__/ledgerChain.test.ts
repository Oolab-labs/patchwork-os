/**
 * ADR-0027 — tamper-evident ledgers.
 *
 * Every test here manipulates a FILE, never the module's own state, because
 * the property being claimed is about bytes on disk: an edit, a deletion, a
 * duplication or a reordering made by anything at all must be visible to
 * `verifyLedgerChain`. A test that only round-trips through the writer would
 * pass against a writer that hashed nothing.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendChained,
  chainSidecarPaths,
  recordWriteFailure,
  verifyLedgerChain,
} from "../ledgerChain.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ledger-chain-"));
  file = path.join(dir, "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0);
const rows = () => lines().map((l) => JSON.parse(l) as Record<string, unknown>);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("a fresh ledger", () => {
  it("starts with a chain-start marker committing to an EMPTY legacy prefix, then chained rows", () => {
    appendChained(file, { a: 1 });
    appendChained(file, { a: 2 });
    const r = rows();
    expect(r[0]).toMatchObject({
      kind: "chain-start",
      legacyRows: 0,
      legacyBytes: 0,
      legacyHash: sha(""),
    });
    expect(r[0]).not.toHaveProperty("seq"); // readers keying on `seq` must skip it
    expect(r[1]).toMatchObject({ a: 1, iseq: 1, prev: sha(lines()[0] ?? "") });
    expect(r[2]).toMatchObject({ a: 2, iseq: 2, prev: sha(lines()[1] ?? "") });
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.breaks).toEqual([]);
    expect(v.chainedRows).toBe(2);
    expect(v.legacyPrefix).toBe("none");
    expect(v.head).toBe("ok");
  });

  it("never mutates the caller's row and stamps AFTER the caller's fields so a row cannot forge its position", () => {
    const row = { a: 1, iseq: 999, prev: "forged" };
    appendChained(file, row);
    expect(row).toEqual({ a: 1, iseq: 999, prev: "forged" });
    expect(rows()[1]).toMatchObject({ iseq: 1 });
    expect(rows()[1]?.prev).not.toBe("forged");
  });
});

describe("legacy prefix: byte-identical, committed to, never backfilled", () => {
  const legacy = '{"seq":1,"x":"old"}\n{"seq":2,"x":"older"}\n';
  it("leaves legacy bytes untouched and commits to them in the chain-start marker", () => {
    writeFileSync(file, legacy);
    appendChained(file, { seq: 3, x: "new" });
    const text = readFileSync(file, "utf-8");
    expect(text.startsWith(legacy)).toBe(true);
    const r = rows();
    expect(r[2]).toMatchObject({
      kind: "chain-start",
      legacyRows: 2,
      legacyBytes: Buffer.byteLength(legacy),
      legacyHash: sha(legacy),
    });
    expect(r[0]).not.toHaveProperty("iseq");
    expect(r[1]).not.toHaveProperty("prev");
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyRows).toBe(2);
    expect(v.legacyPrefix).toBe("verified");
  });

  it("a legacy row edited after the migration boundary is reported as a prefix mismatch", () => {
    writeFileSync(file, legacy);
    appendChained(file, { seq: 3 });
    const text = readFileSync(file, "utf-8").replace('"x":"old"', '"x":"OLD"');
    writeFileSync(file, text);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.legacyPrefix).toBe("mismatch");
  });

  it("verifies a legacy prefix containing non-ASCII bytes (byte length is not string length)", () => {
    // Real ledgers carry em dashes and accented text in `reason` fields. A
    // prefix reconstructed by STRING index against a BYTE length lands on the
    // wrong boundary and hashes differently — every chained real ledger would
    // read as tampered on its first verify.
    const utf8 =
      '{"seq":1,"reason":"gated — café ✓"}\n{"seq":2,"reason":"naïve"}\n';
    writeFileSync(file, utf8);
    appendChained(file, { seq: 3 });
    expect(readFileSync(file, "utf-8").startsWith(utf8)).toBe(true);
    const v = verifyLedgerChain(file);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.ok).toBe(true);
  });

  it("a legacy file with no trailing newline gets its last line terminated, not merged into the marker", () => {
    const unterminated = '{"seq":1,"x":"old"}\n{"seq":2,"x":"last"}';
    writeFileSync(file, unterminated);
    appendChained(file, { seq: 3 });
    const r = rows();
    expect(r[1]).toEqual({ seq: 2, x: "last" }); // still its own parseable line
    expect(r[2]?.kind).toBe("chain-start");
    const v = verifyLedgerChain(file);
    expect(v.legacyRows).toBe(2);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.ok).toBe(true);
  });

  it("a legacy prefix that was never chained is reported as such, not as broken", () => {
    writeFileSync(file, legacy);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyRows).toBe(2);
    expect(v.legacyPrefix).toBe("unchained");
    expect(v.chainedRows).toBe(0);
  });
});

describe("tampering is detected — altered, removed, duplicated, reordered", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) appendChained(file, { n: i });
    expect(verifyLedgerChain(file).ok).toBe(true);
  });

  it("an altered row breaks the hash of the row after it", () => {
    writeFileSync(file, readFileSync(file, "utf-8").replace('"n":3', '"n":30'));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks).toEqual([
      expect.objectContaining({ kind: "hash", iseq: 4 }),
    ]);
  });

  it("a removed row in the middle is a gap AND a hash break at the same place", () => {
    const keep = lines().filter((l) => !l.includes('"n":3'));
    writeFileSync(file, `${keep.join("\n")}\n`);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.kind).sort()).toEqual(["gap", "hash"]);
  });

  it("removed rows at the TAIL leave a valid chain and are caught by the head sidecar", () => {
    const keep = lines().slice(0, -2);
    writeFileSync(file, `${keep.join("\n")}\n`);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.head).toBe("truncated");
    expect(v.breaks).toEqual([
      expect.objectContaining({ kind: "truncated", iseq: 3 }),
    ]);
  });

  it("a duplicated row is a duplicate and a hash break", () => {
    const all = lines();
    const dup = all[3] as string;
    writeFileSync(
      file,
      `${[...all.slice(0, 4), dup, ...all.slice(4)].join("\n")}\n`,
    );
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.kind)).toContain("duplicate");
  });

  it("reordered rows are an order break, positioned by line", () => {
    const all = lines();
    const swapped = [...all];
    [swapped[2], swapped[3]] = [all[3] as string, all[2] as string];
    writeFileSync(file, `${swapped.join("\n")}\n`);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.kind)).toContain("order");
    expect(v.breaks[0]?.line).toBe(3);
  });

  it("a marker row that does not parse is a malformed-marker break, never a silent skip", () => {
    const all = lines();
    all[0] = '{"kind":"chain-start","legacyRows":"two"}';
    writeFileSync(file, `${all.join("\n")}\n`);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.kind)).toContain("malformed-marker");
  });

  it("the head sidecar being deleted is reported, and is not a chain break by itself", () => {
    rmSync(chainSidecarPaths(file).head);
    const v = verifyLedgerChain(file);
    expect(v.head).toBe("missing");
    expect(v.breaks).toEqual([]);
    expect(v.ok).toBe(false); // an unverifiable tail is not an ok ledger
  });
});

describe("rotation writes an explicit marker and re-anchors the chain", () => {
  it("drops oldest rows, records how many and the hash they ended on, and still verifies", () => {
    const opts = { maxBytes: 600, rotateTarget: 400 };
    for (let i = 1; i <= 40; i++)
      appendChained(file, { n: i, pad: "x".repeat(20) }, opts);
    const r = rows();
    expect(r[0]?.kind).toBe("rotation");
    const marker = r[0] as {
      droppedRows: number;
      firstKeptIseq: number;
      lastDroppedHash: string;
    };
    expect(marker.droppedRows).toBeGreaterThan(0);
    expect(r[1]).toMatchObject({
      iseq: marker.firstKeptIseq,
      prev: marker.lastDroppedHash,
    });
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.rotations).toBeGreaterThanOrEqual(1);
    expect(v.chainedRows + v.droppedByRotation).toBe(40);
    // iseq keeps counting across the rotation — the position is global.
    expect((rows().at(-1) as { iseq: number }).iseq).toBe(40);
  });

  it("a rotation that drops the legacy prefix leaves it UNVERIFIABLE, not verified and not broken", () => {
    writeFileSync(
      file,
      `${'{"seq":1,"x":"legacy","pad":"' + "y".repeat(200)}"}\n`,
    );
    const opts = { maxBytes: 600, rotateTarget: 400 };
    for (let i = 1; i <= 30; i++)
      appendChained(file, { n: i, pad: "x".repeat(20) }, opts);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("unverifiable-rotated");
    expect(v.legacyRows).toBe(0);
  });

  it("a rotation marker whose anchor does not match the first kept row is a hash break", () => {
    const opts = { maxBytes: 600, rotateTarget: 400 };
    for (let i = 1; i <= 40; i++)
      appendChained(file, { n: i, pad: "x".repeat(20) }, opts);
    const all = lines();
    const m = JSON.parse(all[0] as string) as Record<string, unknown>;
    m.lastDroppedHash = sha("not the real one");
    all[0] = JSON.stringify(m);
    writeFileSync(file, `${all.join("\n")}\n`);
    expect(verifyLedgerChain(file).ok).toBe(false);
  });
});

describe("failed writes are counted, then sealed into the chain on recovery", () => {
  it("counts a failure in the sidecar, reports it PENDING, and the next row seals it", () => {
    appendChained(file, { n: 1 });
    recordWriteFailure(file, "EACCES");
    recordWriteFailure(file, "ENOSPC");
    let v = verifyLedgerChain(file);
    expect(v.writeFailedPending).toBe(2);
    expect(v.writeFailedSealed).toBe(0);
    expect(existsSync(chainSidecarPaths(file).writeFailed)).toBe(true);

    appendChained(file, { n: 2 });
    expect(rows().at(-1)).toMatchObject({ n: 2, writeFailed: 2 });
    expect(existsSync(chainSidecarPaths(file).writeFailed)).toBe(false);
    v = verifyLedgerChain(file);
    expect(v.writeFailedPending).toBe(0);
    expect(v.writeFailedSealed).toBe(2);
    expect(v.ok).toBe(true);
  });

  it("the sidecar never carries a payload — only when and which code", () => {
    recordWriteFailure(file, "EACCES");
    const row = JSON.parse(
      readFileSync(chainSidecarPaths(file).writeFailed, "utf-8").trim(),
    );
    expect(Object.keys(row).sort()).toEqual(["at", "code"]);
  });

  it("a sealed writeFailed count that is later edited breaks the chain like any other field", () => {
    appendChained(file, { n: 1 });
    recordWriteFailure(file, "EACCES");
    appendChained(file, { n: 2 });
    appendChained(file, { n: 3 });
    writeFileSync(
      file,
      readFileSync(file, "utf-8").replace('"writeFailed":1', '"writeFailed":0'),
    );
    expect(verifyLedgerChain(file).ok).toBe(false);
  });
});

describe("an absent ledger", () => {
  it("is reported absent and ok — nothing to verify is not a failure", () => {
    const v = verifyLedgerChain(file);
    expect(v.absent).toBe(true);
    expect(v.ok).toBe(true);
  });
});

describe("a row appended by something that bypassed the primitive", () => {
  it("is a gap at the tail (no iseq) and a head mismatch", () => {
    appendChained(file, { n: 1 });
    appendFileSync(file, '{"n":2}\n');
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.kind)).toContain("unchained");
  });
});
