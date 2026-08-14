/**
 * Dual-write: the two safety rules, and that the comparison actually detects
 * things.
 *
 * The contract conformance run (below) proves dual-write is transparent — a
 * caller cannot tell it is there. These tests prove the parts a contract
 * cannot: that a broken mirror is harmless, and that a lying mirror is
 * noticed. A comparison layer that reports nothing looks exactly like one
 * where the stores agree, which is the failure this whole migration is
 * guarding against.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipeRun, RunQuery, RunStepResult } from "../../runLog.js";
import {
  type Divergence,
  DualWriteRunRepository,
  type MirrorFailure,
} from "../dualWriteRunRepository.js";
import { JsonlRunRepository } from "../jsonlRunRepository.js";
import type {
  CompleteRunInput,
  RunRepository,
  StartRunInput,
} from "../runRepository.js";
import { SqliteRunRepository } from "../sqliteRunRepository.js";
import { describeRunRepositoryContract } from "./runRepositoryConformance.js";

/* ------------------------------------------------------------------ *
 * 1. Transparency: the pair must satisfy the same contract as either
 *    store alone. If wrapping changed observable behaviour, dual-write
 *    would itself be the migration risk.
 * ------------------------------------------------------------------ */
describeRunRepositoryContract(
  "dual-write (JSONL primary + SQLite mirror)",
  (dir) => {
    const opened: SqliteRunRepository[] = [];
    const open = (): RunRepository => {
      const mirror = new SqliteRunRepository({ dir: path.join(dir, "mirror") });
      opened.push(mirror);
      return new DualWriteRunRepository(
        JsonlRunRepository.open({ dir }),
        mirror,
      );
    };
    return {
      repo: open(),
      reopen: open,
      cleanup: () => {
        for (const m of opened) m.close();
        opened.length = 0;
      },
    };
  },
);

/* ------------------------------------------------------------------ *
 * 2. The rules that make it safe.
 * ------------------------------------------------------------------ */

/** A mirror that fails every call, the way a corrupt or locked db would. */
const brokenMirror = (): RunRepository => ({
  startRun: () => {
    throw new Error("mirror down");
  },
  updateRunSteps: () => {
    throw new Error("mirror down");
  },
  completeRun: () => {
    throw new Error("mirror down");
  },
  query: () => {
    throw new Error("mirror down");
  },
  getBySeq: () => {
    throw new Error("mirror down");
  },
  getChildSeqs: () => {
    throw new Error("mirror down");
  },
  size: () => {
    throw new Error("mirror down");
  },
});

/** A mirror that answers, but wrongly — the case comparison exists to catch. */
class LyingMirror implements RunRepository {
  constructor(private readonly inner: RunRepository) {}
  startRun(i: StartRunInput): number {
    return this.inner.startRun(i);
  }
  updateRunSteps(seq: number, s: RunStepResult[]): void {
    this.inner.updateRunSteps(seq, s);
  }
  completeRun(seq: number, i: CompleteRunInput): void {
    // Silently records the wrong outcome: the #1341 shape, where a run that
    // succeeded is remembered as having been interrupted.
    this.inner.completeRun(seq, { ...i, status: "interrupted" });
  }
  query(q: RunQuery = {}): RecipeRun[] {
    return this.inner.query(q);
  }
  getBySeq(seq: number): RecipeRun | null {
    return this.inner.getBySeq(seq);
  }
  getChildSeqs(p: number): number[] {
    return this.inner.getChildSeqs(p);
  }
  size(): number {
    return this.inner.size();
  }
}

describe("dual-write safety rules", () => {
  let dir: string;
  let mirrors: SqliteRunRepository[];
  let divergences: Divergence[];
  let failures: MirrorFailure[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dualwrite-"));
    mirrors = [];
    divergences = [];
    failures = [];
  });
  afterEach(() => {
    for (const m of mirrors) m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const sqliteMirror = () => {
    const m = new SqliteRunRepository({ dir: path.join(dir, "mirror") });
    mirrors.push(m);
    return m;
  };

  const build = (mirror: RunRepository) =>
    new DualWriteRunRepository(JsonlRunRepository.open({ dir }), mirror, {
      onDivergence: (d) => divergences.push(d),
      onMirrorFailure: (f) => failures.push(f),
    });

  const runOnce = (repo: RunRepository, taskId: string) => {
    const seq = repo.startRun({
      taskId,
      recipeName: "demo",
      trigger: "cron",
      createdAt: 1_000,
    });
    repo.completeRun(seq, {
      status: "done",
      doneAt: 2_000,
      durationMs: 1_000,
      stepResults: [],
    });
    return seq;
  };

  /** Rule 1. The whole point of a migration aid is that it cannot cause the
   *  outage it is meant to de-risk. */
  it("a totally broken mirror does not break anything", () => {
    const repo = build(brokenMirror());

    expect(() => runOnce(repo, "t-1")).not.toThrow();

    // The primary is untouched and still authoritative.
    expect(repo.query({ limit: 10 }).map((r) => r.taskId)).toEqual(["t-1"]);
    expect(repo.size()).toBe(1);
    // ...and the breakage was REPORTED, not swallowed into silence. A mirror
    // that fails quietly would look identical to one that agrees.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.message).toBe("mirror down");
  });

  /** Rule 2. Reads come from the primary even when the mirror answers. */
  it("reads always return the primary's answer", () => {
    const repo = build(new LyingMirror(sqliteMirror()));
    const seq = runOnce(repo, "t-2");

    // The mirror recorded "interrupted"; the caller must still see the truth.
    expect(repo.getBySeq(seq)?.status).toBe("done");
    expect(repo.query({ limit: 10 })[0]?.status).toBe("done");
  });

  /** ...and the lie is not silently tolerated. */
  it("a mirror that records the wrong outcome is reported (#1341 shape)", () => {
    const repo = build(new LyingMirror(sqliteMirror()));
    const seq = runOnce(repo, "t-3");
    repo.getBySeq(seq);

    const statuses = divergences.filter((d) => d.detail.startsWith("status:"));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]?.detail).toContain("primary=done");
    expect(statuses[0]?.detail).toContain("mirror=interrupted");
  });

  it("a run missing from the mirror is reported", () => {
    const mirror = sqliteMirror();
    const repo = build(mirror);
    runOnce(repo, "t-present");

    // Write straight to the primary, bypassing the mirror — the shape of a
    // dropped mirror write.
    const primaryOnly = JsonlRunRepository.open({ dir });
    runOnce(primaryOnly, "t-missing");

    repo.query({ limit: 10 });
    expect(divergences.some((d) => d.detail.includes("row count"))).toBe(true);
  });

  /** Agreement must be silent. A comparison that always fires tells you
   *  nothing — the signal has to mean something when it appears. */
  it("agreeing stores produce no divergences at all", () => {
    const repo = build(sqliteMirror());
    for (let i = 0; i < 5; i++) runOnce(repo, `t-agree-${i}`);

    repo.query({ limit: 50 });
    repo.query({ recipe: "demo" });
    repo.getBySeq(1);
    repo.size();
    repo.getChildSeqs(1);

    expect(divergences, JSON.stringify(divergences)).toEqual([]);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  });

  /** A reporting callback that throws must not become the outage the mirror
   *  was forbidden from causing. */
  it("a throwing callback cannot take the caller down", () => {
    const repo = new DualWriteRunRepository(
      JsonlRunRepository.open({ dir }),
      new LyingMirror(sqliteMirror()),
      {
        onDivergence: () => {
          throw new Error("callback exploded");
        },
        onMirrorFailure: () => {
          throw new Error("callback exploded");
        },
      },
    );
    const seq = runOnce(repo, "t-cb");
    expect(() => repo.getBySeq(seq)).not.toThrow();
    expect(repo.getBySeq(seq)?.status).toBe("done");
  });

  it("compareReads:false keeps mirroring but stops comparing", () => {
    const repo = new DualWriteRunRepository(
      JsonlRunRepository.open({ dir }),
      new LyingMirror(sqliteMirror()),
      {
        compareReads: false,
        onDivergence: (d) => divergences.push(d),
      },
    );
    const seq = runOnce(repo, "t-quiet");
    repo.getBySeq(seq);
    repo.query({ limit: 10 });

    expect(divergences).toEqual([]);
    // The mirror is still being populated — this is a volume control, not an
    // off switch, so the data is present when the flip comes.
    expect(mirrors[0]?.size()).toBe(1);
  });
});
