import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_STEP_TOOL, classifyActionClass } from "../actionClass.js";
import { foldOutcome } from "../shadowObserver.js";
import { loadWorkersFromDir } from "../workerLoader.js";

const WINDOW = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const settled = now - WINDOW * 2;

describe("an agent step is not trust evidence", () => {
  /**
   * The drift this closes: `decideWorkerAction` carves `agent` out as "not a
   * gated action-class", but `foldOutcome` counted a successful one as earned
   * trust. 50 such unconfirmed positives sat in the real run log.
   */
  it("withholds a SUCCESSFUL agent step (was: counted as earned trust)", () => {
    expect(
      foldOutcome({ tool: AGENT_STEP_TOOL, status: "ok" }, settled, {
        now,
        windowMs: WINDOW,
      }),
    ).toEqual({ fold: false });
  });

  /**
   * Withheld in BOTH directions. A failed agent step says something about a
   * model call, not about whether this worker can be trusted with a side
   * effect — penalising it would be the mirror-image mistake.
   */
  it("withholds a FAILED agent step too — neither credit nor penalty", () => {
    expect(
      foldOutcome({ tool: AGENT_STEP_TOOL, status: "error" }, settled, {
        now,
        windowMs: WINDOW,
      }),
    ).toEqual({ fold: false });
  });

  it("withholds regardless of the join rule or a captured output", () => {
    for (const strict of [false, true]) {
      expect(
        foldOutcome(
          { tool: AGENT_STEP_TOOL, status: "ok", output: { id: "x1" } },
          settled,
          { now, windowMs: WINDOW, strictOutcomeJoin: strict },
        ),
      ).toEqual({ fold: false });
    }
  });

  it("withholds even on the back-compat status-only path (no `now`)", () => {
    expect(
      foldOutcome({ tool: AGENT_STEP_TOOL, status: "ok" }, settled, {
        windowMs: WINDOW,
      }),
    ).toEqual({ fold: false });
  });

  it("does NOT withhold a real side-effecting step (anchor)", () => {
    // Without this, a carve-out that accidentally matched everything would
    // still show all-green above.
    expect(
      foldOutcome({ tool: "file.write", status: "ok" }, settled, {
        now,
        windowMs: WINDOW,
      }),
    ).toEqual({ fold: true, good: true });
  });
});

describe("guard: nothing owns the `other` catch-all domain", () => {
  /**
   * The carve-out above removes the live leak. This guards the LATENT one.
   *
   * `agent` classifies as `other:irreversible:medium`, and `other` is the
   * catch-all every unclassified tool falls into. No shipped worker owns it,
   * so the gate floors that class to L0 regardless of accrued evidence — which
   * is the only reason the pre-fix leak was not exploitable. Adding `other` to
   * an `owns` list would silently convert a pile of unconfirmed evidence into
   * real trust, and nobody editing an `owns` list would expect that.
   *
   * If this test fails, the fix is almost certainly to name the SPECIFIC
   * domain the worker actually needs, not to delete this test.
   */
  it("no shipped worker template declares `other`", () => {
    const dir = path.join(process.cwd(), "templates", "workers");
    const files = readdirSync(dir).filter((f) => f.endsWith(".worker.yaml"));
    expect(files.length).toBeGreaterThan(0); // anchor: the dir must not be empty

    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), "utf-8");
      // Match an `owns:` list entry of exactly `other` (comments allowed).
      if (/^\s*-\s*other\s*(#.*)?$/m.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("`agent` still classifies into `other` — the premise of the guard", () => {
    // If this ever changes, the guard above is testing the wrong domain and
    // would pass vacuously.
    expect(classifyActionClass(AGENT_STEP_TOOL).domain).toBe("other");
  });

  it("the shipped templates all load and declare a non-empty `owns`", () => {
    const workers = loadWorkersFromDir(
      path.join(process.cwd(), "templates", "workers"),
    );
    expect(workers.length).toBeGreaterThan(0);
    for (const w of workers) expect(w.owns.length).toBeGreaterThan(0);
  });
});
