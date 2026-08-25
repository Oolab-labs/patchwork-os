/**
 * An artifact could not cite the run that produced it.
 *
 * The flat runner injects `date`, `time` and the `YYYY`/`ISO_NOW` family into
 * the template context, but never the run's own identity. So a recipe that
 * publishes a document — an audit pack, a reconciliation workbook, a report
 * somebody signs — had no way to print the run it came from. The run ledger
 * knows the `taskId`; the artifact could not reach it.
 *
 * That is the same join this codebase has been closing everywhere else: a gate
 * decision now carries `correlationId`, and so does a boundary receipt. Both
 * are the run's `taskId`, never `seq` — `seq` is a per-instance counter over a
 * file several construction sites write, so it collides across concurrent
 * bridges. An artifact naming a colliding id is worse than one naming none.
 *
 * `{{taskId}}` previously failed template-ref lint outright ("Unknown template
 * reference"), so nothing could depend on it and this is purely additive.
 *
 * ## Why it is NOT overridable
 *
 * `date` and the `YYYY` family sit BEFORE the `envCtx` / `seedContext` spreads,
 * so a recipe variable of the same name wins. `taskId` deliberately sits after
 * them. It is an attribution, not a convenience: a recipe that shadowed it
 * would publish a document naming a run that did not produce it, which is the
 * "never write a claim you cannot honour" rule in a different costume. A false
 * attribution is worse than an absent one.
 */

import { describe, expect, it } from "vitest";

import { runYamlRecipe } from "../yamlRunner.js";

const BASE_DEPS = {
  testMode: true,
  readFile: () => {
    throw new Error("no reads in this test");
  },
  writeFile: () => {},
  appendFile: () => {},
  mkdir: () => {},
  gitLogSince: () => "",
  gitStaleBranches: () => "",
  getDiagnostics: () => "",
  claudeFn: async () => "ok",
};

/** Capture what a `file.write` step would have written. */
function captureRun(content: string): Promise<string[]> {
  const written: string[] = [];
  return runYamlRecipe(
    {
      name: "run-id-probe",
      trigger: { type: "manual" },
      allowWrites: ["file.write"],
      steps: [
        {
          id: "w",
          tool: "file.write",
          path: "~/.patchwork/probe.txt",
          content,
        },
      ],
    } as never,
    {
      ...BASE_DEPS,
      writeFile: (_p: string, c: string) => {
        written.push(c);
      },
    } as never,
  ).then(() => written);
}

describe("{{taskId}} — an artifact can name its own run", () => {
  it("renders the run's taskId, in the run log's own shape", async () => {
    const written = await captureRun("run={{taskId}}");
    expect(written).toHaveLength(1);
    // `yaml:<recipe>:<startedAt>` — the shape `runs.jsonl` records, so the
    // value is a real join key rather than a decorative string.
    expect(written[0]).toMatch(/^run=yaml:run-id-probe:\d+$/);
  });

  it("is the SAME id the run log records, not a second expression", async () => {
    // The failure this guards is subtle: computing the id twice from `now()`
    // looks identical and drifts the moment either expression changes. Two
    // renders inside one run must agree with each other.
    const written = await captureRun("a={{taskId}} b={{taskId}}");
    const m = written[0]?.match(/^a=(\S+) b=(\S+)$/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(m?.[2]);
  });

  it("passes template-ref lint, which it previously failed", async () => {
    const { validateRecipeDefinition } = await import("../validation.js");
    const result = validateRecipeDefinition({
      name: "lint-probe",
      trigger: { type: "manual" },
      allowWrites: ["file.write"],
      steps: [
        {
          id: "w",
          tool: "file.write",
          path: "~/.patchwork/x.txt",
          content: "{{taskId}}",
        },
      ],
    } as never);
    const refIssues = result.issues.filter(
      (i) => i.level === "error" && /taskId/.test(i.message),
    );
    expect(refIssues).toEqual([]);
  });
});
