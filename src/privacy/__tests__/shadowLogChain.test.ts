/**
 * ADR-0027, one ledger: `privacy_shadow.jsonl` is written through
 * `appendChained`, verified through the real verifier rather than the writer's
 * own return value.
 *
 * Seeded with a LEGACY prefix (a row in the pre-chain shape) so the migration
 * boundary is proven too: legacy bytes untouched and committed to, the writer's
 * first new row chained after them, and the existing summariser still counting
 * only data rows — a `chain-start` marker must never enter the denominator.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLedgerChain } from "../../ledgerChain.js";
import {
  recordPrivacyShadow,
  SHADOW_LOG_BASENAME,
  SHADOW_RECORD_VERSION,
  summarisePrivacyShadow,
} from "../shadowLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "shadow-chain-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dataRows = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    // ADR-0027 marker rows carry `kind` and no data fields; skipped the way
    // every production loader skips them.
    .filter((r) => r.kind !== "chain-start" && r.kind !== "rotation");

describe("privacy shadow ledger chain", () => {
  it("chains after a legacy prefix, stamps rv/iseq, and the summariser ignores the marker", () => {
    const file = path.join(dir, SHADOW_LOG_BASENAME);
    const legacy =
      '{"at":1,"rv":1,"decision":"ALLOW","classification":"internal","destinationId":"d","destinationType":"local","reason":"old","enforcing":false}\n';
    writeFileSync(file, legacy);

    recordPrivacyShadow(
      {
        decision: "DENY",
        classification: "internal",
        destinationId: "d",
        destinationType: "local",
        reason: "new",
        enforcing: false,
      },
      { dir, now: () => 2 },
    );

    // Legacy bytes are byte-identical afterwards — never re-stamped.
    expect(readFileSync(file, "utf-8").startsWith(legacy)).toBe(true);

    const v = verifyLedgerChain(file);
    expect(v.ok).toBe(true);
    expect(v.legacyPrefix).toBe("verified");
    expect(v.legacyRows).toBe(1);
    expect(v.chainedRows).toBe(1);

    const row = dataRows(file).at(-1);
    expect(row).toMatchObject({ rv: SHADOW_RECORD_VERSION, iseq: 1 });
    expect(SHADOW_RECORD_VERSION).toBe(2);
    expect(typeof row?.prev).toBe("string");

    // The marker is a third line in the file and must not be a third
    // observation: the denominator is exactly the two data rows.
    const s = summarisePrivacyShadow({ dir });
    expect(s.observed).toBe(2);
    expect(s.crossings).toBe(1);
    expect(s.byDecision).toEqual({ ALLOW: 1, DENY: 1 });
  });

  it("still never throws when the ledger cannot be written", () => {
    // A file where the directory should be: mkdir and append both fail.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "");
    expect(() =>
      recordPrivacyShadow(
        {
          decision: "ALLOW",
          classification: "internal",
          destinationId: "d",
          destinationType: "local",
          reason: "r",
          enforcing: false,
        },
        { dir: blocked },
      ),
    ).not.toThrow();
  });
});
