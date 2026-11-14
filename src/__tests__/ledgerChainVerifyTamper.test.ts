/**
 * Structural tampering that keeps the hash chain consistent.
 *
 * The chain is unkeyed: anyone who can edit the file can recompute every
 * `prev` and the `.head` sidecar. What still catches such an edit is the
 * verifier's structural rules: a rotation marker only as the first line, one
 * chain-start, well-formed markers, the legacy commitment's counts, and no
 * unparseable rows inside the chain. A mutation run (Stryker, 2026-11-14)
 * showed each of these could be removed with every existing test still green.
 * Each test below makes an edit that recomputes the hashes, so only the rule
 * under test can catch it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendChained,
  chainSidecarPaths,
  hashLine,
  verifyLedgerChain,
} from "../ledgerChain.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ledger-tamper-"));
  file = path.join(dir, "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => readFileSync(file, "utf-8").split("\n").filter(Boolean);

/**
 * Rewrite `lines` as an attacker who recomputes hashes would: every chained
 * row's `prev` is re-pointed at the line before it (or at a rotation marker's
 * `lastDroppedHash`), and the head sidecar is refreshed.
 */
function writeRelinked(lines: string[]): void {
  const out: string[] = [];
  let prev = "";
  let last: { iseq: number; hash: string } | null = null;
  for (const l of lines) {
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(l) as Record<string, unknown>;
    } catch {
      out.push(l);
      continue;
    }
    if (row.kind === "rotation") {
      out.push(l);
      prev = (row.lastDroppedHash as string) ?? "";
      continue;
    }
    if (row.kind === "chain-start") {
      out.push(l);
      prev = hashLine(l);
      continue;
    }
    if (typeof row.iseq === "number") {
      const line = JSON.stringify({ ...row, prev });
      out.push(line);
      prev = hashLine(line);
      last = { iseq: row.iseq, hash: prev };
      continue;
    }
    out.push(l);
  }
  writeFileSync(file, `${out.join("\n")}\n`);
  if (last)
    writeFileSync(chainSidecarPaths(file).head, `${JSON.stringify(last)}\n`);
}

function chainOf(n: number): string[] {
  for (let i = 1; i <= n; i++) appendChained(file, { at: i, v: `row-${i}` });
  return read();
}

describe("the relinking helper is a faithful attacker", () => {
  it("relinking an untouched chain leaves it intact (so a later break is the rule's doing)", () => {
    writeRelinked(chainOf(4));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.breaks).toEqual([]);
    expect(v.head).toBe("ok");
  });
});

describe("structural rules that hold when the hashes are recomputed", () => {
  it("rows deleted mid-file and papered over with a rotation marker are caught", () => {
    const lines = chainOf(4); // [chain-start, r1, r2, r3, r4]
    const r3 = lines[3] as string;
    const marker = JSON.stringify({
      kind: "rotation",
      at: 99,
      droppedRows: 2,
      droppedLegacyRows: 0,
      lastDroppedHash: hashLine(r3),
      lastDroppedIseq: 3,
      firstKeptIseq: 4,
    });
    writeRelinked([
      lines[0] as string,
      lines[1] as string,
      marker,
      lines[4] as string,
    ]);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks).toContainEqual(
      expect.objectContaining({ kind: "malformed-marker", line: 3 }),
    );
  });

  it("a malformed rotation marker on the first line is caught", () => {
    const lines = chainOf(2);
    const marker = JSON.stringify({
      kind: "rotation",
      at: 99,
      droppedRows: "two",
      droppedLegacyRows: 0,
      lastDroppedHash: null,
      lastDroppedIseq: null,
      firstKeptIseq: 1,
    });
    writeRelinked([marker, ...lines]);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.rotations).toBe(0);
    expect(v.breaks).toContainEqual(
      expect.objectContaining({ kind: "malformed-marker", line: 1 }),
    );
  });

  it("a second chain-start inside the chain is caught", () => {
    const lines = chainOf(3);
    writeRelinked([
      lines[0] as string,
      lines[1] as string,
      lines[0] as string, // a fresh commitment restarting the chain
      lines[2] as string,
      lines[3] as string,
    ]);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks).toContainEqual(
      expect.objectContaining({ kind: "malformed-marker", line: 3 }),
    );
  });

  it("a chain-start whose hash matches but whose counts lie is a mismatch", () => {
    writeFileSync(file, '{"legacy":1}\n{"legacy":2}\n');
    appendChained(file, { at: 1, v: "x" });
    const lines = read(); // [legacy, legacy, chain-start, r1]
    const start = JSON.parse(lines[2] as string) as Record<string, unknown>;
    expect(start.legacyRows).toBe(2);
    for (const lie of [
      { legacyRows: 1 },
      { legacyBytes: (start.legacyBytes as number) + 1 },
    ]) {
      writeRelinked([
        lines[0] as string,
        lines[1] as string,
        JSON.stringify({ ...start, ...lie }),
        lines[3] as string,
      ]);
      const v = verifyLedgerChain(file);
      expect(v.legacyPrefix, JSON.stringify(lie)).toBe("mismatch");
      expect(v.ok).toBe(false);
    }
  });

  it("a chain-start whose legacyHash is not a string is malformed", () => {
    const lines = chainOf(1);
    const start = JSON.parse(lines[0] as string) as Record<string, unknown>;
    writeRelinked([
      JSON.stringify({ ...start, legacyHash: 12345 }),
      lines[1] as string,
    ]);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(false);
    expect(v.breaks).toContainEqual(
      expect.objectContaining({ kind: "malformed-marker", line: 1 }),
    );
  });

  it("an unparseable line inside the chain is a break, and does not crash the verifier", () => {
    const lines = chainOf(3);
    writeRelinked([
      ...lines.slice(0, 2),
      "this is not json",
      ...lines.slice(2),
    ]);
    let v: ReturnType<typeof verifyLedgerChain> | undefined;
    expect(() => {
      v = verifyLedgerChain(file);
    }).not.toThrow();
    expect(v?.ok).toBe(false);
    expect(v?.breaks).toContainEqual(
      expect.objectContaining({ kind: "malformed-row", line: 3 }),
    );
  });
});
