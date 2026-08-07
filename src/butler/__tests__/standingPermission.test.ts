/**
 * Standing permissions — the four non-negotiable rules, plus the agreement
 * property between the gate and the boundary preview.
 *
 * The agreement test is the important one. Component tests passing separately
 * is exactly how an inverted safety property shipped here before: a preview
 * that says "a person will be asked" while the gate quietly lets the action
 * through tells an operator they are protected when they are not. So the test
 * does not assert what each side returns — it asserts the two sides agree, for
 * every candidate, under grants that do and do not apply.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewActions } from "../../workers/previewActions.js";
import type { WorkerManifest } from "../../workers/worker.js";
import {
  decideWorkerAction,
  resolveGateOutcome,
} from "../../workers/workerGate.js";
import { WorkerLevelStore } from "../../workers/workerLevelStore.js";
import { StandingPermissionStore } from "../permissionStore.js";
import {
  coversAction,
  isActive,
  type StandingPermission,
} from "../standingPermission.js";

const NOW = 1_800_000_000_000;

function perm(over: Partial<StandingPermission> = {}): StandingPermission {
  return {
    id: over.id ?? "p1",
    grantedAt: NOW - 1000,
    grantedBy: null,
    scope: { domains: ["issue"] },
    ...over,
  };
}

describe("coversAction — the rules", () => {
  it("NEVER covers an irreversible action, however broad the grant", () => {
    const broadest = perm({
      scope: { domains: ["issue", "payments", "messaging", "shell", "http"] },
    });
    const check = coversAction(
      [broadest],
      {
        domain: "messaging",
        classKey: "messaging:irreversible:high",
        reversibility: "irreversible",
      },
      { now: NOW },
    );
    expect(check.covered).toBe(false);
    expect(check.reason).toMatch(/irreversible/i);
  });

  it("covers a compensable action inside its scope", () => {
    const check = coversAction(
      [perm()],
      {
        domain: "issue",
        classKey: "issue:compensable:high",
        reversibility: "compensable",
      },
      { now: NOW },
    );
    expect(check.covered).toBe(true);
  });

  it("does not widen to a class it does not name", () => {
    const check = coversAction(
      [perm({ scope: { domains: ["issue"] } })],
      {
        domain: "vcs-remote",
        classKey: "vcs-remote:compensable:high",
        reversibility: "compensable",
      },
      { now: NOW },
    );
    expect(check.covered).toBe(false);
  });

  it("matches on exact class key and on prefix, like WorkerManifest.owns", () => {
    const exact = perm({ scope: { domains: ["issue:compensable:high"] } });
    const prefix = perm({ scope: { domains: ["issue:compensable"] } });
    const subject = {
      domain: "issue",
      classKey: "issue:compensable:high",
      reversibility: "compensable" as const,
    };
    expect(coversAction([exact], subject, { now: NOW }).covered).toBe(true);
    expect(coversAction([prefix], subject, { now: NOW }).covered).toBe(true);
    // ...but a sibling class the prefix does not reach is untouched.
    expect(
      coversAction(
        [prefix],
        { ...subject, classKey: "issue:irreversible:high" },
        {
          now: NOW,
        },
      ).covered,
    ).toBe(false);
  });

  it("stops covering the moment it is revoked", () => {
    const revoked = perm({ revokedAt: NOW - 1 });
    expect(isActive(revoked, NOW)).toBe(false);
    expect(
      coversAction(
        [revoked],
        {
          domain: "issue",
          classKey: "issue:compensable:high",
          reversibility: "compensable",
        },
        { now: NOW },
      ).covered,
    ).toBe(false);
  });

  it("stops covering once expired", () => {
    const expired = perm({ expiresAt: NOW - 1 });
    expect(
      coversAction(
        [expired],
        {
          domain: "issue",
          classKey: "issue:compensable:high",
          reversibility: "compensable",
        },
        { now: NOW },
      ).covered,
    ).toBe(false);
  });

  describe("magnitude ceiling", () => {
    const banded = perm({
      scope: { domains: ["payments"] },
      ceiling: { magnitudeBand: "band<=50" },
    });
    const subject = (
      magnitudeBand?: "band<=50" | "band<=500" | "band>500",
    ) => ({
      domain: "payments",
      classKey: `payments:compensable:high${magnitudeBand ? `:${magnitudeBand}` : ""}`,
      reversibility: "compensable" as const,
      ...(magnitudeBand && { magnitudeBand }),
    });

    it("covers a band at or under the ceiling", () => {
      expect(
        coversAction([banded], subject("band<=50"), { now: NOW }).covered,
      ).toBe(true);
    });

    it("refuses a band above the ceiling", () => {
      expect(
        coversAction([banded], subject("band<=500"), { now: NOW }).covered,
      ).toBe(false);
    });

    it("refuses an action with NO band when a ceiling exists", () => {
      // An unreadable amount must never slip under a cap that exists — the
      // permissive reading is the one an attacker-shaped param would want.
      expect(coversAction([banded], subject(), { now: NOW }).covered).toBe(
        false,
      );
    });
  });

  it("stops covering once the daily cap is reached", () => {
    const capped = perm({ ceiling: { perDay: 2 } });
    const subject = {
      domain: "issue",
      classKey: "issue:compensable:high",
      reversibility: "compensable" as const,
    };
    expect(
      coversAction([capped], subject, { now: NOW, usageToday: () => 1 })
        .covered,
    ).toBe(true);
    const atCap = coversAction([capped], subject, {
      now: NOW,
      usageToday: () => 2,
    });
    expect(atCap.covered).toBe(false);
    expect(atCap.reason).toMatch(/limit of 2/);
  });
});

describe("resolveGateOutcome — only `queue` is convertible", () => {
  const covering = [perm({ scope: { domains: ["issue", "other"] } })];

  it("converts a queue to flow and names the permission", () => {
    const r = resolveGateOutcome(
      {
        action: "gate",
        domain: "issue",
        classKey: "issue:compensable:high",
        reversibility: "compensable",
      },
      { permissions: covering, now: NOW },
    );
    expect(r.outcome).toBe("flow");
    expect(r.standingPermissionId).toBe("p1");
    expect(r.standingPermissionReason).toMatch(/standing permission/i);
  });

  it("NEVER converts a forbid — no grant unlocks a forbidden action", () => {
    const r = resolveGateOutcome(
      {
        action: "forbid",
        domain: "issue",
        classKey: "issue:compensable:high",
        reversibility: "compensable",
      },
      { permissions: covering, now: NOW },
    );
    expect(r.outcome).toBe("refuse");
    expect(r.standingPermissionId).toBeUndefined();
  });

  it("never converts an action this build does not understand", () => {
    const r = resolveGateOutcome(
      {
        action: "something-new" as never,
        domain: "issue",
        classKey: "issue:compensable:high",
        reversibility: "compensable",
      },
      { permissions: covering, now: NOW },
    );
    expect(r.outcome).toBe("refuse");
  });

  it("is a no-op with no permissions — byte-identical to the old mapping", () => {
    for (const action of ["allow", "gate", "forbid"] as const) {
      const withCtx = resolveGateOutcome({
        action,
        domain: "issue",
        classKey: "issue:compensable:high",
        reversibility: "compensable",
      });
      const empty = resolveGateOutcome(
        {
          action,
          domain: "issue",
          classKey: "issue:compensable:high",
          reversibility: "compensable",
        },
        { permissions: [], now: NOW },
      );
      expect(withCtx).toEqual(empty);
      expect(withCtx.standingPermissionId).toBeUndefined();
    }
  });
});

describe("preview and gate agree under standing permissions", () => {
  let levels: WorkerLevelStore;

  const worker: WorkerManifest = {
    id: "errands",
    name: "Errands",
    owns: ["issue", "tasks", "vcs-remote"],
    autonomyCeiling: 1,
  } as WorkerManifest;

  // WorkerLevelStore is in-memory with no constructor args — a fresh one per
  // test is already full isolation, so the worker starts unearned and every
  // compensable action begins in "needs approval".
  beforeEach(() => {
    levels = new WorkerLevelStore();
  });

  const GRANT_SETS: Array<{ name: string; perms: StandingPermission[] }> = [
    { name: "no grants", perms: [] },
    {
      name: "a covering grant",
      perms: [perm({ scope: { domains: ["issue"] } })],
    },
    {
      name: "a revoked grant",
      perms: [perm({ scope: { domains: ["issue"] }, revokedAt: NOW - 1 })],
    },
    {
      name: "a broad grant",
      perms: [
        perm({ scope: { domains: ["issue", "tasks", "vcs-remote", "other"] } }),
      ],
    },
  ];

  for (const set of GRANT_SETS) {
    it(`every candidate lands in the column the gate would produce — ${set.name}`, () => {
      const candidates = [
        { toolName: "githubCreateIssue" },
        { toolName: "gitPush" },
        { toolName: "slackPostMessage" },
        { toolName: "runCommand" },
        { toolName: "getDiagnostics" },
        { toolName: "githubMergePR" },
      ];

      const boundary = previewActions(worker, candidates, levels, {
        standingPermissions: set.perms,
        now: NOW,
      });

      for (const c of candidates) {
        const decision = decideWorkerAction(
          worker,
          c.toolName,
          undefined,
          levels,
        );
        const expected = resolveGateOutcome(decision, {
          permissions: set.perms,
          now: NOW,
        }).outcome;

        const column = boundary.mayDoNow.some((a) => a.toolName === c.toolName)
          ? "flow"
          : boundary.needsApproval.some((a) => a.toolName === c.toolName)
            ? "queue"
            : "refuse";
        expect(column, `${c.toolName} under ${set.name}`).toBe(expected);
      }
    });
  }

  it("a grant moves an action out of `needs approval`, and revoking puts it back", () => {
    const candidates = [{ toolName: "githubCreateIssue" }];
    const granted = perm({ scope: { domains: ["issue"] } });

    const before = previewActions(worker, candidates, levels, { now: NOW });
    expect(before.needsApproval.map((a) => a.toolName)).toEqual([
      "githubCreateIssue",
    ]);

    const during = previewActions(worker, candidates, levels, {
      standingPermissions: [granted],
      now: NOW,
    });
    expect(during.mayDoNow.map((a) => a.toolName)).toEqual([
      "githubCreateIssue",
    ]);
    // ...and it says so in the permission's words, not the trust maths'.
    expect(during.mayDoNow[0]?.reason).toMatch(/standing permission/i);

    const after = previewActions(worker, candidates, levels, {
      standingPermissions: [{ ...granted, revokedAt: NOW - 1 }],
      now: NOW,
    });
    expect(after.needsApproval.map((a) => a.toolName)).toEqual([
      "githubCreateIssue",
    ]);
  });
});

describe("StandingPermissionStore", () => {
  let tmpDir: string;
  let store: StandingPermissionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "perm-store-"));
    store = new StandingPermissionStore({
      dir: tmpDir,
      logger: { warn: () => {} },
    });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("grants, lists and never defaults grantedBy to a person", () => {
    const p = store.grant({ scope: { domains: ["issue"] } });
    expect(p.grantedBy).toBeNull();
    expect(store.list().map((x) => x.id)).toEqual([p.id]);
    expect(store.active()).toHaveLength(1);
  });

  it("revocation keeps the row and drops it from active", () => {
    const p = store.grant({ scope: { domains: ["issue"] } });
    store.revoke(p.id);
    expect(store.active()).toHaveLength(0);
    // The record survives — "allowed for a while, then withdrawn" stays
    // answerable.
    const kept = store.list().find((x) => x.id === p.id);
    expect(kept?.revokedAt).toBeTypeOf("number");
  });

  it("survives a reload — a grant is durable, not in-memory", () => {
    const p = store.grant({ scope: { domains: ["tasks"] }, note: "errands" });
    const reopened = new StandingPermissionStore({
      dir: tmpDir,
      logger: { warn: () => {} },
    });
    expect(reopened.active().map((x) => x.id)).toEqual([p.id]);
    expect(reopened.active()[0]?.note).toBe("errands");
  });

  it("counts exercises for the daily cap", () => {
    const p = store.grant({
      scope: { domains: ["issue"] },
      ceiling: { perDay: 2 },
    });
    expect(store.usageToday(p.id)).toBe(0);
    store.recordExercise({
      permissionId: p.id,
      toolName: "githubCreateIssue",
      classKey: "issue:compensable:high",
    });
    store.recordExercise({
      permissionId: p.id,
      toolName: "githubCreateIssue",
      classKey: "issue:compensable:high",
    });
    expect(store.usageToday(p.id)).toBe(2);
    // Yesterday's uses don't count against today.
    store.recordExercise({
      permissionId: p.id,
      at: Date.now() - 36 * 60 * 60 * 1000,
      toolName: "githubCreateIssue",
      classKey: "issue:compensable:high",
    });
    expect(store.usageToday(p.id)).toBe(2);
  });

  it("refuses an empty scope rather than granting everything", () => {
    expect(() => store.grant({ scope: { domains: [] } })).toThrow();
    expect(() => store.grant({ scope: { domains: ["  "] } })).toThrow();
  });

  it("refuses a nonsense daily cap", () => {
    expect(() =>
      store.grant({ scope: { domains: ["issue"] }, ceiling: { perDay: 0 } }),
    ).toThrow();
  });
});
