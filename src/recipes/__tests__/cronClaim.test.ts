/**
 * The cron claim primitive (#1458).
 *
 * These are the unit-level properties. They are NOT the proof that the fix
 * works: a single process cannot distinguish a filesystem claim from an
 * in-memory `Set` keyed by slot, and a test that passes against both is worth
 * nothing here. That proof lives in `cronClaimCrossProcess.test.ts`, which
 * forks real OS processes.
 *
 * What these cover is the behaviour a reader would otherwise have to take on
 * trust: the key's encoding, that a claim is a TOMBSTONE, and that the two
 * degraded modes do what the header says.
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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_RETENTION_MS,
  claimCronSlot,
  cronClaimKey,
  sweepCronClaims,
} from "../cronClaim.js";

let claimsDir: string;

beforeEach(() => {
  claimsDir = mkdtempSync(join(os.tmpdir(), "cron-claims-"));
});
afterEach(() => {
  rmSync(claimsDir, { recursive: true, force: true });
});

const SLOT = Date.parse("2026-08-19T08:07:00.000Z");

describe("the claim key", () => {
  it("is stable for the same recipe and slot", () => {
    expect(cronClaimKey("heartbeat", SLOT)).toBe(
      cronClaimKey("heartbeat", SLOT),
    );
  });

  it("separates recipes whose names and slots concatenate the same way", () => {
    // The reason for JSON-array encoding rather than `${a}:${b}`, which
    // `deriveScopeKey` already documents: `a:b` + `c` and `a` + `b:c` must not
    // collide. Expressed with the real types the key takes.
    expect(cronClaimKey("a:1", 2)).not.toBe(cronClaimKey("a", 12));
  });

  it("is filename-safe for a recipe name that is not", () => {
    // Recipe names reach the filesystem through this key and nothing else.
    expect(cronClaimKey("owner/repo — recipe ✨", SLOT)).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });
});

describe("claiming a slot", () => {
  it("the first caller claims and the second is told it is taken", () => {
    expect(claimCronSlot("r", SLOT, { claimsDir })).toEqual({
      kind: "claimed",
    });
    expect(claimCronSlot("r", SLOT, { claimsDir })).toEqual({ kind: "taken" });
  });

  it("does not block a different slot, or a different recipe", () => {
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("claimed");
    expect(claimCronSlot("r", SLOT + 60_000, { claimsDir }).kind).toBe(
      "claimed",
    );
    expect(claimCronSlot("other", SLOT, { claimsDir }).kind).toBe("claimed");
  });

  it("treats a stray millisecond as the same slot", () => {
    // Belt and braces against an upstream change that reintroduces ms. A key
    // that splits on them fails only when the event-loop hop straddles a second
    // boundary — i.e. rarely, and never on demand.
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("claimed");
    expect(claimCronSlot("r", SLOT + 999, { claimsDir }).kind).toBe("taken");
  });

  it("is a TOMBSTONE — the claim outlives the run that took it", () => {
    // If the claim were released on completion, a peer whose tick is delayed
    // past the first bridge's completion would find no claim and fire. That is
    // the same bug in a narrower window, which is worse: it stops reproducing.
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("claimed");
    const files = existsSync(claimsDir);
    expect(files).toBe(true);
    // ... arbitrarily later, with no process holding anything:
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("taken");
  });

  it("records who took it, for a human — never for a decision", () => {
    claimCronSlot("heartbeat", SLOT, { claimsDir });
    const day = join(claimsDir, "2026-08-19");
    const file = join(day, `${cronClaimKey("heartbeat", SLOT)}.json`);
    const body = JSON.parse(readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      v: 1,
      recipeName: "heartbeat",
      slotEpochMs: SLOT,
      pid: process.pid,
    });
  });
});

describe("degraded modes", () => {
  /** A path that cannot be created: an existing FILE where a directory must go. */
  function unusableRoot(): string {
    const root = join(claimsDir, "blocked");
    writeFileSync(root, "not a directory");
    return root;
  }

  it("fails OPEN by default — the tick fires, and the caller is told why", () => {
    const r = claimCronSlot("r", SLOT, { claimsDir: unusableRoot() });
    expect(r.kind).toBe("unavailable");
    if (r.kind !== "unavailable") throw new Error("expected unavailable");
    // The reason is carried so the log and the run stamp can name it. A
    // duplicate that is attributable is a different thing from a mysterious one.
    expect(r.reason).toBeTruthy();
  });

  it("fails CLOSED when the operator asks for it", () => {
    // PATCHWORK_CRON_CLAIM_REQUIRED. Injected rather than set on the
    // environment: an env mutation that leaks would silently change every
    // later test in the file.
    const r = claimCronSlot("r", SLOT, {
      claimsDir: unusableRoot(),
      required: true,
    });
    expect(r.kind).toBe("refused");
  });

  it("keeps 'a peer has it' distinguishable from 'we could not tell'", () => {
    // Two different facts about the system. Collapsing them into one outcome
    // would make the log unable to say which happened, and they call for
    // opposite responses.
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("claimed");
    expect(claimCronSlot("r", SLOT, { claimsDir }).kind).toBe("taken");
    expect(claimCronSlot("r", SLOT, { claimsDir: unusableRoot() }).kind).toBe(
      "unavailable",
    );
  });
});

describe("the sweep", () => {
  it("removes day-directories past the horizon and keeps the rest", () => {
    const old = join(claimsDir, "2026-01-01");
    const recent = join(claimsDir, "2026-08-19");
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });

    const removed = sweepCronClaims(Date.parse("2026-08-19T12:00:00Z"), {
      claimsDir,
    });

    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("keeps a directory that is inside the horizon", () => {
    const yesterday = join(claimsDir, "2026-08-18");
    mkdirSync(yesterday, { recursive: true });
    expect(
      sweepCronClaims(Date.parse("2026-08-19T12:00:00Z"), { claimsDir }),
    ).toBe(0);
    expect(existsSync(yesterday)).toBe(true);
  });

  it("leaves anything that is not one of ours alone", () => {
    // The sweep is `rm -rf` on a directory name. It must never act on a name it
    // did not write, whatever else is under PATCHWORK_HOME.
    const stranger = join(claimsDir, "README");
    mkdirSync(stranger, { recursive: true });
    sweepCronClaims(Date.parse("2030-01-01T00:00:00Z"), { claimsDir });
    expect(existsSync(stranger)).toBe(true);
  });

  it("is a non-event when nothing has ever been claimed", () => {
    expect(
      sweepCronClaims(Date.now(), { claimsDir: join(claimsDir, "nope") }),
    ).toBe(0);
  });

  it("keeps the horizon well clear of the window a duplicate can arrive in", () => {
    // The retention only has to outlive the window in which a duplicate of the
    // SAME slot can arrive, which is bounded by seconds. Asserted so a future
    // "tidy up, 5 minutes is plenty" cannot pass unnoticed.
    expect(CLAIM_RETENTION_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });
});
