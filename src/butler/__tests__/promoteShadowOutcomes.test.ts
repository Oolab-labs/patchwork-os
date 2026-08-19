/**
 * Promotion — the one place a Butler grade can become trust evidence.
 *
 * Everything here is about what must NOT happen. The code path that writes is
 * four lines; the reason this file is long is that each refusal below has been
 * a real defect in this subsystem at least once, and a promoter that quietly
 * lost one of them would look identical to a working one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutcomeStore } from "../../workers/outcomeStore.js";
import { SHADOW_LOG_BASENAME } from "../outcomeShadowLog.js";
import {
  formatPromoteResult,
  promoteShadowOutcomes,
  splitStoredRef,
} from "../promoteShadowOutcomes.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "butler-promote-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedLedger(
  rows: Array<{
    ref: string;
    disposition: "confirmed" | "junk" | "unknown";
    reason?: string;
    gradedAt?: number;
    recipe?: string;
  }>,
): void {
  writeFileSync(
    join(dir, SHADOW_LOG_BASENAME),
    `${rows
      .map((r, i) =>
        JSON.stringify({
          ref: r.ref,
          disposition: r.disposition,
          reason: r.reason ?? "completed",
          gradedAt: r.gradedAt ?? 1000 + i,
          ...(r.recipe ? { recipe: r.recipe } : {}),
          wouldCountAsEvidence: r.disposition !== "unknown",
        }),
      )
      .join("\n")}\n`,
  );
}

function ledgerRows(): Record<string, unknown>[] {
  const p = join(dir, "outcome-log.jsonl");
  try {
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("the flag is a decision about evidence, not about code", () => {
  it("writes NOTHING with the flag off, and says so rather than looking clean", () => {
    seedLedger([{ ref: "todoist.create_task:abc", disposition: "confirmed" }]);

    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: false });

    expect(r.promoted).toBe(0);
    expect(r.blockedByFlag).toBe(true);
    expect(ledgerRows()).toEqual([]);
    // A run that wrote nothing because it was told not to must not read the
    // same as a run that had nothing to write.
    expect(r.promotable).toBe(1);
    expect(formatPromoteResult(r)).toMatch(/NOTHING WAS WRITTEN/);
  });

  it("writes with the flag on", () => {
    seedLedger([{ ref: "todoist.create_task:abc", disposition: "confirmed" }]);

    const r = promoteShadowOutcomes({
      patchworkDir: dir,
      enabled: true,
      now: 5,
    });

    expect(r.promoted).toBe(1);
    expect(
      new OutcomeStore(dir).getDispositionForRef({
        tool: "todoist.create_task",
        id: "abc",
      }),
    ).toBe("confirmed");
  });

  it("a dry run reports without writing, even with the flag on", () => {
    seedLedger([{ ref: "todoist.create_task:abc", disposition: "confirmed" }]);
    const r = promoteShadowOutcomes({
      patchworkDir: dir,
      enabled: true,
      dryRun: true,
    });
    expect(r.promotable).toBe(1);
    expect(r.promoted).toBe(0);
    expect(ledgerRows()).toEqual([]);
  });
});

describe("what is refused", () => {
  it("NEVER promotes `unknown`, under any flag", () => {
    // The load-bearing rule. "Nobody has acted yet" is not evidence in either
    // direction, and folding it as good is the trust-by-neglect defect this
    // subsystem has closed four separate times.
    seedLedger([
      {
        ref: "todoist.create_task:open",
        disposition: "unknown",
        reason: "open-recent",
      },
    ]);

    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    expect(r.withheld).toBe(1);
    expect(r.promoted).toBe(0);
    expect(ledgerRows()).toEqual([]);
  });

  it("promotes junk as readily as confirmed — the channel must be able to lower trust", () => {
    seedLedger([
      { ref: "todoist.create_task:a", disposition: "confirmed" },
      { ref: "todoist.create_task:b", disposition: "junk" },
      { ref: "todoist.create_task:c", disposition: "unknown" },
    ]);

    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    // A promoter that only ever raised the dial would be an advertisement, not
    // a measurement.
    expect(r.promoted).toBe(2);
    expect(r.withheld).toBe(1);
  });

  it("reports a row it cannot key rather than dropping it", () => {
    seedLedger([
      { ref: "https://example.test/issues/1", disposition: "confirmed" },
      { ref: "no-colon-here", disposition: "confirmed" },
    ]);

    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    // A run that silently skipped half its rows looks exactly like a clean one.
    expect(r.unkeyable).toHaveLength(2);
    expect(r.promoted).toBe(0);
    expect(formatPromoteResult(r)).toMatch(/unkeyable/);
  });
});

describe("what it writes", () => {
  it("marks the record `ingester`, never `manual`", () => {
    // `manual` is STICKY against later ingester writes because it means a human
    // ruled. This is an automated grade off an HTTP response. Claiming `manual`
    // would let it permanently override the operator it is meant to serve.
    seedLedger([
      {
        ref: "todoist.create_task:abc",
        disposition: "confirmed",
        recipe: "errands",
      },
    ]);

    promoteShadowOutcomes({ patchworkDir: dir, enabled: true, now: 7 });

    expect(ledgerRows()[0]).toMatchObject({
      origin: "ingester",
      disposition: "confirmed",
      checkedAt: 7,
      recipeName: "errands",
      ref: { tool: "todoist.create_task", id: "abc" },
    });
  });

  it("is idempotent — a second run adds no rows", () => {
    // `upsert` APPENDS. Re-running without this check grows the file the
    // autonomy gate reads with rows saying nothing new, and that file's byte cap
    // is already what starves trust evidence (#1337).
    seedLedger([{ ref: "todoist.create_task:abc", disposition: "confirmed" }]);

    const first = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });
    const second = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    expect(first.promoted).toBe(1);
    expect(second.promoted).toBe(0);
    expect(second.alreadyRecorded).toBe(1);
    expect(ledgerRows()).toHaveLength(1);
  });

  it("promotes a CHANGED verdict for a ref it has already seen", () => {
    // Idempotency must not become deafness. An errand confirmed today and
    // deleted tomorrow is a real change of fact, and the ledger has to hear it.
    seedLedger([{ ref: "todoist.create_task:abc", disposition: "confirmed" }]);
    promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    seedLedger([
      { ref: "todoist.create_task:abc", disposition: "confirmed", gradedAt: 1 },
      {
        ref: "todoist.create_task:abc",
        disposition: "junk",
        gradedAt: 2,
        reason: "deleted",
      },
    ]);
    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    expect(r.promoted).toBe(1);
    expect(
      new OutcomeStore(dir).getDispositionForRef({
        tool: "todoist.create_task",
        id: "abc",
      }),
    ).toBe("junk");
  });

  it("takes the LATEST grade per ref, not the first it happens to read", () => {
    // The ledger is append-only and an errand is observed repeatedly, so the
    // same ref appears many times by design. Reading them in file order and
    // writing each would let an older grade land after a newer one.
    seedLedger([
      {
        ref: "todoist.create_task:abc",
        disposition: "junk",
        gradedAt: 9,
        reason: "deleted",
      },
      {
        ref: "todoist.create_task:abc",
        disposition: "confirmed",
        gradedAt: 99,
      },
    ]);

    promoteShadowOutcomes({ patchworkDir: dir, enabled: true });

    expect(
      new OutcomeStore(dir).getDispositionForRef({
        tool: "todoist.create_task",
        id: "abc",
      }),
    ).toBe("confirmed");
  });
});

describe("splitting a stored ref", () => {
  it("splits on the FIRST colon, so an id containing one survives", () => {
    // Tool ids are dot-separated and never contain a colon; connector ids
    // routinely do. Splitting anywhere else silently rekeys the action and
    // attaches the confirmation to nothing.
    expect(splitStoredRef("todoist.create_task:6hG:xyz")).toEqual({
      tool: "todoist.create_task",
      id: "6hG:xyz",
    });
  });

  it("refuses a URL-shaped key instead of mangling it", () => {
    const r = splitStoredRef("https://example.test/issues/1");
    expect("error" in r).toBe(true);
  });

  it("refuses a key with no id, or no tool", () => {
    expect("error" in splitStoredRef("todoist.create_task:")).toBe(true);
    expect("error" in splitStoredRef(":abc")).toBe(true);
    expect("error" in splitStoredRef("nocolon")).toBe(true);
  });
});

describe("an empty or missing ledger is honest", () => {
  it("reports nothing observed rather than a clean zero", () => {
    const r = promoteShadowOutcomes({ patchworkDir: dir, enabled: true });
    expect(r).toMatchObject({ rows: 0, promotable: 0, promoted: 0 });
    // The denominator leads. "0 promoted" over an unread ledger and over an
    // empty one are different facts.
    expect(formatPromoteResult(r)).toMatch(/0 graded row\(s\)/);
  });
});

describe("a worker cannot reach this", () => {
  const SRC = readFileSync(
    path.join(import.meta.dirname, "..", "promoteShadowOutcomes.ts"),
    "utf-8",
  );

  it("is not registered as a recipe tool", () => {
    // A recipe step runs AS the worker. A worker that could call this would
    // promote its own filings — manufacturing the evidence that raises its own
    // dial, which is the entire failure the shadow phase exists to prevent.
    // Checked against the registry's own import barrel, the file that decides
    // what a recipe can call, rather than against a comment saying so.
    const barrel = readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "recipes",
        "tools",
        "index.ts",
      ),
      "utf-8",
    );
    expect(barrel).not.toMatch(/promoteShadowOutcomes/);
    expect(barrel).not.toMatch(/butler\/promote/);
    expect(SRC).not.toMatch(/registerTool/);
  });

  it("names the flag it is gated on, so the gate is greppable", () => {
    // The flag is the whole safety property here. A rename that left the
    // documented name behind would leave an operator setting a variable
    // nothing reads, and believing promotion was on.
    expect(SRC).toMatch(/PATCHWORK_FLAG_BUTLER_PROMOTE/);
  });
});
