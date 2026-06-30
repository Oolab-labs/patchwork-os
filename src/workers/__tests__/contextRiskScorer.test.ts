import { describe, expect, it } from "vitest";
import { contextRiskCeiling } from "../contextRisk.js";
import {
  collectGitContextSignals,
  type ExecFn,
  resolveGitContextRisk,
  scoreContextRisk,
} from "../contextRiskScorer.js";

describe("scoreContextRisk", () => {
  it("a clean situation scores 0 with no reasons", () => {
    const r = scoreContextRisk({ diffLines: 10, dirtyFiles: 1 });
    expect(r.score).toBe(0);
    expect(r.reasons).toBeUndefined();
  });

  it("escalates with uncommitted diff size", () => {
    expect(scoreContextRisk({ diffLines: 250 }).score).toBeCloseTo(0.3);
    expect(scoreContextRisk({ diffLines: 800 }).score).toBeCloseTo(0.5);
    expect(scoreContextRisk({ diffLines: 5000 }).score).toBeCloseTo(0.9);
  });

  it("a huge diff alone caps autonomy to propose-only (ceiling 0)", () => {
    const r = scoreContextRisk({ diffLines: 5000 });
    expect(contextRiskCeiling(r.score)).toBe(0);
    expect(r.reasons?.[0]).toContain("huge uncommitted diff");
  });

  it("combines moderate signals by noisy-OR (they compound)", () => {
    // sizeable diff (0.3) + on default branch (0.3) → 1-(0.7*0.7)=0.51
    const r = scoreContextRisk({ diffLines: 250, onDefaultBranch: true });
    expect(r.score).toBeCloseTo(0.51, 2);
    expect(contextRiskCeiling(r.score)).toBe(1); // crosses into elevated
    expect(r.reasons).toHaveLength(2);
  });

  it("flags many dirty files and the default branch", () => {
    expect(scoreContextRisk({ dirtyFiles: 25 }).score).toBeCloseTo(0.5);
    expect(scoreContextRisk({ onDefaultBranch: true }).score).toBeCloseTo(0.3);
    expect(scoreContextRisk({ onDefaultBranch: false }).score).toBe(0);
  });
});

function fakeExec(out: Record<string, string>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    const v = out[key];
    if (v !== undefined) return v;
    throw new Error(`no fake for: ${key}`);
  };
}

describe("collectGitContextSignals", () => {
  it("parses numstat into diff lines + file count and detects the branch", async () => {
    const s = await collectGitContextSignals({
      cwd: "/x",
      exec: fakeExec({
        "diff HEAD --numstat":
          "10\t5\tsrc/a.ts\n3\t2\tsrc/b.ts\n-\t-\timg.png\n",
        "rev-parse --abbrev-ref HEAD": "main\n",
      }),
    });
    expect(s.diffLines).toBe(20); // 10+5+3+2 (binary "-" counts 0)
    expect(s.dirtyFiles).toBe(3);
    expect(s.onDefaultBranch).toBe(true);
  });

  it("a feature branch is not the default branch", async () => {
    const s = await collectGitContextSignals({
      cwd: "/x",
      exec: fakeExec({
        "diff HEAD --numstat": "",
        "rev-parse --abbrev-ref HEAD": "feat/thing\n",
      }),
    });
    expect(s.onDefaultBranch).toBe(false);
    expect(s.diffLines).toBe(0);
  });

  it("is fail-soft: a git error leaves signals undefined, never throws", async () => {
    const s = await collectGitContextSignals({
      cwd: "/x",
      exec: async () => {
        throw new Error("not a git repo");
      },
    });
    expect(s.diffLines).toBeUndefined();
    expect(s.onDefaultBranch).toBeUndefined();
  });
});

describe("resolveGitContextRisk", () => {
  it("returns a ContextRisk for a risky tree, undefined for a clean one", async () => {
    const risky = await resolveGitContextRisk({
      cwd: "/x",
      exec: fakeExec({
        "diff HEAD --numstat": "3000\t0\tsrc/huge.ts\n",
        "rev-parse --abbrev-ref HEAD": "main\n",
      }),
    });
    expect(risky?.score).toBeGreaterThan(0.8);

    const clean = await resolveGitContextRisk({
      cwd: "/x",
      exec: fakeExec({
        "diff HEAD --numstat": "1\t0\tsrc/tiny.ts\n",
        "rev-parse --abbrev-ref HEAD": "feat/x\n",
      }),
    });
    expect(clean).toBeUndefined();
  });
});
