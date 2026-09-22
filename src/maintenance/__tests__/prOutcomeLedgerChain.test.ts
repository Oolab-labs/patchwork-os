/**
 * ADR-0027 wave 2, PR 3 — `pr_outcomes.jsonl` is chained.
 *
 * The writer was a bare `appendFileSync` loop inside the `pr-outcomes collect`
 * command. It now goes through `appendObservation` → `appendChained`: locked,
 * `iseq` + `prev`, a `chain-start` marker committing to the legacy prefix, a
 * head sidecar, and a failed append counted then sealed. Unlike the run-step
 * ledger this writer does NOT swallow its errors — `collect` already fails
 * loudly on a failed query, and a collection that silently recorded nothing
 * would leave a gap indistinguishable from a quiet week.
 *
 * The reader half matters as much. `readObservations` cast every parsed line
 * to a `PrObservation` with no shape check, so a marker row would have become
 * a phantom "undefined#undefined" pull request in `rows`, `distinctPrs`,
 * `rosterlessRows`, `byState` and the weekly sweep counts.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPINE_LEDGERS } from "../../evidenceCoverage.js";
import {
  VERIFIED_LEDGERS,
  verifyEvidenceChains,
} from "../../evidenceVerify.js";
import { chainSidecarPaths, verifyLedgerChain } from "../../ledgerChain.js";
import {
  appendObservation,
  dedupeAgainst,
  PR_OBSERVATION_RV,
  type PrObservation,
  readObservations,
  summarise,
} from "../prOutcomeLedger.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pr-outcomes-chain-"));
  file = path.join(dir, "pr_outcomes.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const obs = (number: number, over: Partial<PrObservation> = {}) =>
  ({
    rv: PR_OBSERVATION_RV,
    repo: "example-org/example-repo",
    number,
    observedAt: "2026-09-02T00:00:00.000Z",
    state: "OPEN",
    authorLogin: "example-user",
    createdAt: "2026-09-01T00:00:00.000Z",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...over,
  }) as PrObservation;

const physical = () =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * A legacy prefix with MULTIBYTE UTF-8 in it. An ASCII-only fixture cannot
 * see a byte-length-versus-string-offset defect, which is exactly how one
 * reached a live ledger in PR 2 of this wave.
 */
const LEGACY_MULTIBYTE = `${JSON.stringify({
  rv: 1,
  repo: "example-org/exämple-repo",
  number: 7,
  observedAt: "2026-08-01T00:00:00.000Z",
  state: "MERGED",
  authorLogin: "üser-ünicode",
  createdAt: "2026-07-01T00:00:00.000Z",
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  mergeCommitSha: "abc — em dash, ‚Äö and a snowman ☃",
})}\n`;

describe("the writer", () => {
  it("stamps rv 2, iseq and prev, and the chain verifies", () => {
    appendObservation(file, obs(1));
    appendObservation(file, obs(2));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.chainedRows).toBe(2);
    expect(v.head).toBe("ok");
    const rows = physical().filter((r) => r.kind === undefined);
    expect(PR_OBSERVATION_RV).toBe(2);
    expect(rows[0]).toMatchObject({ rv: 2, iseq: 1 });
    expect(rows[1]).toMatchObject({ rv: 2, iseq: 2 });
    expect(typeof rows[1]?.prev).toBe("string");
  });

  it("leaves a MULTIBYTE legacy prefix byte-identical and commits to it", () => {
    writeFileSync(file, LEGACY_MULTIBYTE);
    const before = readFileSync(file); // Buffer: bytes, never string offsets
    appendObservation(file, obs(1));
    const after = readFileSync(file);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    // Legacy rows are never re-stamped: still rv 1.
    expect(physical()[0]).toMatchObject({ rv: 1 });
  });

  it("handles a legacy file whose last row has NO trailing newline", () => {
    const unterminated = LEGACY_MULTIBYTE.slice(0, -1);
    writeFileSync(file, unterminated);
    const before = Buffer.from(unterminated, "utf-8");
    appendObservation(file, obs(1));
    const after = readFileSync(file);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(readObservations(file)).toHaveLength(2);
  });

  it("propagates a failed append; the failure is pending, then sealed", () => {
    mkdirSync(file); // the ledger path is a directory, so the append fails
    expect(() => appendObservation(file, obs(1))).toThrow();
    expect(existsSync(chainSidecarPaths(file).writeFailed)).toBe(true);
    rmSync(file, { recursive: true, force: true });
    expect(verifyLedgerChain(file).writeFailedPending).toBe(1);
    appendObservation(file, obs(1));
    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.writeFailedPending).toBe(0);
    expect(v.writeFailedSealed).toBe(1);
  });

  it("keeps authorIsWorker OMITTED when the caller omitted it", () => {
    appendObservation(file, obs(1));
    appendObservation(file, obs(2, { authorIsWorker: false }));
    const rows = readObservations(file);
    expect(rows[0] !== undefined && "authorIsWorker" in rows[0]).toBe(false);
    expect(rows[1]?.authorIsWorker).toBe(false);
    expect(summarise(rows).rosterlessRows).toBe(1);
  });
});

describe("marker rows are metadata, never a pull request", () => {
  const withMarkers = () => {
    appendObservation(file, obs(1));
    appendObservation(file, obs(2, { state: "MERGED" }));
    return readObservations(file);
  };

  it("a chain-start marker never reaches rows, counts or the sweep", () => {
    writeFileSync(file, LEGACY_MULTIBYTE);
    appendObservation(file, obs(1));
    const rows = readObservations(file);
    // 1 legacy + 1 chained. The chain-start marker is not a third.
    expect(rows).toHaveLength(2);
    const s = summarise(rows);
    expect(s.rows).toBe(2);
    expect(s.distinctPrs).toBe(2);
    expect(s.rosterlessRows).toBe(2);
    expect(Object.keys(s.byState).sort()).toEqual(["MERGED", "OPEN"]);
    expect(s.byState.undefined).toBeUndefined();
  });

  it("a marker SHAPED like a row is still skipped, by kind", () => {
    withMarkers();
    writeFileSync(
      file,
      `${readFileSync(file, "utf-8")}${JSON.stringify({
        kind: "rotation",
        at: 1,
        droppedRows: 0,
        droppedLegacyRows: 0,
        lastDroppedHash: null,
        lastDroppedIseq: null,
        firstKeptIseq: null,
        // Everything a PrObservation needs, so only `kind` can save us.
        rv: 2,
        repo: "example-org/example-repo",
        number: 999,
        observedAt: "2026-09-02T00:00:00.000Z",
        state: "CLOSED",
        authorLogin: "phantom",
        createdAt: "2026-09-01T00:00:00.000Z",
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      })}\n`,
    );
    const rows = readObservations(file);
    expect(rows.some((r) => r.number === 999)).toBe(false);
    const s = summarise(rows);
    expect(s.rows).toBe(2);
    expect(s.distinctPrs).toBe(2);
    expect(s.prsWithHistory).toBe(0);
  });

  it("markers do not pollute the dedupe seen-set", () => {
    writeFileSync(file, LEGACY_MULTIBYTE);
    appendObservation(file, obs(1));
    const existing = readObservations(file);
    // A first sighting must still count as one: a marker in `existing` would
    // otherwise sit in the seen-set under its own phantom key.
    const d = dedupeAgainst(existing, [obs(1), obs(3)]);
    expect(d.unchanged).toBe(1);
    expect(d.firstSighting).toBe(1);
    expect(d.toAppend.map((o) => o.number)).toEqual([3]);
  });
});

describe("verifier and coverage lists", () => {
  it("the verifier covers pr_outcomes.jsonl; the spine does not", () => {
    expect(VERIFIED_LEDGERS.some((l) => l.file === "pr_outcomes.jsonl")).toBe(
      true,
    );
    expect(SPINE_LEDGERS.some((l) => l.file === "pr_outcomes.jsonl")).toBe(
      false,
    );
    appendObservation(file, obs(1));
    expect(
      verifyEvidenceChains(dir).ledgers.find(
        (l) => l.file === "pr_outcomes.jsonl",
      ),
    ).toMatchObject({ absent: false, chainedRows: 1, ok: true });
  });
});

describe("the collect command writes through the ledger", () => {
  it("src/index.ts no longer appends to the ledger itself", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "..", "index.ts"),
      "utf-8",
    );
    const collect = src.slice(src.indexOf('if (sub === "collect")'));
    const body = collect.slice(0, collect.indexOf("pull request(s) queried"));
    expect(body).not.toMatch(/appendFileSync\s*\(\s*file/);
    expect(body).toContain("appendObservation(file");
  });
});
