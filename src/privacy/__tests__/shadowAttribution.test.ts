/**
 * The shadow report has to name a problem you can LOCATE (#1469).
 *
 * The report's honesty rules are already strong — it leads with the
 * denominator, refuses a bare crossing count, and says "nothing observed"
 * rather than "0 crossings" on an empty ledger. It had one gap left, and it was
 * an actionability gap rather than an honesty one:
 *
 *     assumed: 23 of 29 row(s) carry a DEFAULTED classification
 *
 * The remedy for an assumed row is to declare a `data_policy` on the step that
 * produced it. Nothing in the row said which step, or even which recipe — the
 * complete key set was `at, classification, decision, destinationId,
 * destinationType, enforcing, labelSource, path, reason`, where `path` is the
 * dispatch PATH (`recipe-agent-step`), not the recipe. So an operator with 80
 * installed recipes was told a number and given nothing to act on.
 *
 * `ShadowRow` already DECLARED `recipeName` — and nothing supplied it. That is
 * the "declared but supplied nowhere" pattern the repo's wiring guard exists to
 * catch, on a surface the guard does not cover. The boundary RECEIPT log
 * declares `recipeName` and populates it, so the two records describing the
 * same dispatch disagreed about whether attribution was possible.
 *
 * Not a payload concern: a recipe name is not the prompt, is already in
 * `runs.jsonl`, and is the same class of attribution metadata #1455 established
 * for evidence records. ADR-0021's "receipts carry no payload" rule is
 * untouched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatPrivacyShadow, summarisePrivacyShadow } from "../shadowLog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "shadow-attr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(rows: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(dir, "privacy_shadow.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: 1_787_000_000_000,
    decision: "ALLOW",
    reason: "ok",
    destinationId: "candidate-local",
    destinationType: "local",
    classification: "internal",
    labelSource: "assumed",
    path: "recipe-agent-step",
    enforcing: false,
    ...over,
  };
}

describe("assumed rows are attributed to the recipe that produced them", () => {
  it("counts unlabelled dispatches per recipe", () => {
    seed([
      row({ recipeName: "nightly-scout" }),
      row({ recipeName: "nightly-scout" }),
      row({ recipeName: "weekly-report" }),
      row({ recipeName: "labelled-one", labelSource: "declared" }),
    ]);

    const s = summarisePrivacyShadow({ dir });

    // The whole point: "4 rows, 3 assumed" is a number. This is a to-do list.
    expect(s.assumedByRecipe).toEqual({
      "nightly-scout": 2,
      "weekly-report": 1,
    });
  });

  it("does not credit a recipe for its DECLARED rows", () => {
    seed([
      row({ recipeName: "mixed" }),
      row({ recipeName: "mixed", labelSource: "declared" }),
    ]);

    // A recipe that is half-labelled still has work outstanding, and the count
    // must be of the work, not of the recipe's total traffic.
    expect(summarisePrivacyShadow({ dir }).assumedByRecipe).toEqual({
      mixed: 1,
    });
  });

  it("keeps unattributable rows visible rather than dropping them", () => {
    // Orchestrator dispatches carry no recipe, and rows written before
    // attribution existed carry none either. Silently omitting them would make
    // the per-recipe counts add up to less than `assumed` — and a reader who
    // fixed every recipe listed would find the headline number had not reached
    // zero, with nothing to explain the remainder.
    seed([
      row({ recipeName: "known" }),
      row({ path: "orchestrator-task", destinationId: "candidate-remote" }),
      row(),
    ]);

    const s = summarisePrivacyShadow({ dir });

    expect(s.assumed).toBe(3);
    expect(s.assumedByRecipe.known).toBe(1);
    expect(s.assumedUnattributed).toBe(2);
    // The invariant a reader relies on.
    expect(
      Object.values(s.assumedByRecipe).reduce((a, b) => a + b, 0) +
        s.assumedUnattributed,
    ).toBe(s.assumed);
  });
});

describe("the report tells you where to go", () => {
  it("lists the recipes with unlabelled dispatches, worst first", () => {
    // `alpha` sorts FIRST alphabetically and LAST by count. The previous
    // version of this test used `big`/`small`, where the two orderings agree —
    // so it passed against an alphabetical sort and proved nothing about
    // ranking. Caught by mutating the comparator and watching it stay green.
    seed([
      row({ recipeName: "alpha" }),
      row({ recipeName: "zulu" }),
      row({ recipeName: "zulu" }),
      row({ recipeName: "zulu" }),
    ]);

    const out = formatPrivacyShadow(summarisePrivacyShadow({ dir }));

    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/zulu/);
    // Worst first, so the one line an operator reads is the one worth acting on.
    expect(out.indexOf("zulu")).toBeLessThan(out.indexOf("alpha"));
  });

  it("says how many it cannot attribute, rather than quietly omitting them", () => {
    seed([row({ recipeName: "known" }), row({ path: "orchestrator-task" })]);

    expect(formatPrivacyShadow(summarisePrivacyShadow({ dir }))).toMatch(
      /not attributed|no recipe/i,
    );
  });

  it("says nothing about recipes when every row is labelled", () => {
    // A section that renders empty on a healthy system is noise, and noise is
    // how the honest parts of this report stop being read.
    seed([row({ recipeName: "good", labelSource: "declared" })]);

    const out = formatPrivacyShadow(summarisePrivacyShadow({ dir }));
    expect(out).not.toMatch(/unlabelled/i);
  });
});

describe("the WIRING, not just the summariser", () => {
  /**
   * Everything above tests `summarisePrivacyShadow` against rows a test wrote.
   * That proves the arithmetic and proves nothing about whether anything ever
   * PUTS a `recipeName` on a row — and the field was declared and supplied by
   * nothing for exactly that reason.
   *
   * Caught by mutation: deleting the `recipeName` pass-through in
   * `yamlRunner`'s `recordPrivacyShadowFn` left every test above green.
   *
   * So this one drives the real `runYamlRecipe`, with `PATCHWORK_HOME` pointed
   * at a temp directory so the runner's hard-wired config read and ledger write
   * both land there. `PATCHWORK_HOME` and not a spy on `os.homedir` — a
   * namespace spy misses named imports and has previously let a test write to
   * the developer's real `~/.patchwork`.
   */
  it("a real recipe run writes its own name onto the row", async () => {
    const {
      mkdirSync,
      readFileSync,
      writeFileSync: wf,
    } = await import("node:fs");
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    wf(
      join(home, "config.json"),
      JSON.stringify({
        privacy: {
          shadow: {
            destinations: {
              "test-local": {
                type: "local",
                classifications: ["public", "internal", "confidential"],
                drivers: ["local"],
              },
            },
          },
        },
      }),
    );

    const prev = process.env.PATCHWORK_HOME;
    process.env.PATCHWORK_HOME = home;
    try {
      const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
      await runYamlRecipe(
        {
          name: "a-named-recipe",
          trigger: { type: "manual" },
          steps: [{ agent: { prompt: "hi", driver: "local" } }],
        } as never,
        {
          testMode: true,
          logDir: dir,
          now: () => new Date("2026-08-19T00:00:00Z"),
          readFile: () => {
            throw new Error("nope");
          },
          writeFile: () => {},
          appendFile: () => {},
          mkdir: () => {},
          gitLogSince: () => "",
          gitStaleBranches: () => "",
          getDiagnostics: () => "",
          claudeFn: async () => "ok",
        } as never,
      );

      const rows = readFileSync(join(home, "privacy_shadow.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { recipeName?: string });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1)?.recipeName).toBe("a-named-recipe");
    } finally {
      // Restore rather than delete: with PATCHWORK_HOME unset the next reader
      // resolves the developer's real store.
      if (prev === undefined) delete process.env.PATCHWORK_HOME;
      else process.env.PATCHWORK_HOME = prev;
    }
  });
});
