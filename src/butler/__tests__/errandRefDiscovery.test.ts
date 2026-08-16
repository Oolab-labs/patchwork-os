/**
 * Finding the errands worth observing, from the run log.
 *
 * Fixtures throughout — the real log is operator data and must never be read
 * into a test. The SHAPES here were measured against a real 1129-run log
 * (1795 step results, 187 successful, 11 keyable, 3 of them Todoist); the
 * values are synthetic.
 *
 * Two properties carry this file:
 *
 *  1. the key is DERIVED by `deriveActionKey`, the same function the trust
 *     fold uses — a key invented by a different rule produces refs the fold
 *     cannot resolve, and a graded row under an unresolvable key measures
 *     nothing while still inflating the counts somebody reads;
 *  2. coverage is REPORTED with its denominator, because a discoverer that
 *     silently returns three refs looks identical to one that is broken.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverTodoistErrandRefs,
  formatDiscovery,
} from "../errandRefDiscovery.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ref-discovery-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLog(
  rows: unknown[],
  basename: "runs.jsonl" | "runs.jsonl.1" = "runs.jsonl",
) {
  writeFileSync(
    path.join(dir, basename),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

const okStep = (tool: string, output: unknown) => ({
  tool,
  status: "ok",
  output,
});

describe("finding observable errands", () => {
  it("derives the ref and the task id from a created task", () => {
    writeLog([
      {
        recipeName: "errands",
        stepResults: [okStep("todoist.create_task", { id: "12345" })],
      },
    ]);
    const r = discoverTodoistErrandRefs({ dir });
    expect(r.refs).toEqual([
      { taskId: "12345", ref: "todoist.create_task:12345", recipe: "errands" },
    ]);
  });

  it("ignores failed steps", () => {
    // A step that errored created nothing to observe. Grading it would be
    // grading an action that did not happen.
    writeLog([
      {
        stepResults: [
          { tool: "todoist.create_task", status: "error", output: { id: "9" } },
        ],
      },
    ]);
    expect(discoverTodoistErrandRefs({ dir }).refs).toEqual([]);
  });

  it("ignores other tools (control)", () => {
    // Without this, "return every successful step" would pass the first test.
    writeLog([
      {
        stepResults: [
          okStep("http.post", { id: "77" }),
          okStep("todoist.create_task", { id: "88" }),
        ],
      },
    ]);
    const r = discoverTodoistErrandRefs({ dir });
    expect(r.refs.map((x) => x.taskId)).toEqual(["88"]);
    // The http.post step still counts toward the denominator.
    expect(r.successfulSteps).toBe(2);
  });

  it("reports URL-shaped keys as unusable rather than dropping them", () => {
    // `deriveActionKey` returns the URL itself when the output carries one, so
    // legacy rows keep joining. A URL is a fine outcome ref and a useless task
    // id. "We found nothing" and "we found things we cannot look up" are
    // different facts about coverage.
    writeLog([
      {
        stepResults: [
          okStep("todoist.create_task", {
            url: "https://example.test/task/1",
          }),
        ],
      },
    ]);
    const r = discoverTodoistErrandRefs({ dir });
    expect(r.refs).toEqual([]);
    expect(r.urlShaped).toBe(1);
  });

  it("counts steps that captured no id at all", () => {
    writeLog([
      { stepResults: [okStep("todoist.create_task", { nothing: "useful" })] },
    ]);
    const r = discoverTodoistErrandRefs({ dir });
    expect(r.refs).toEqual([]);
    expect(r.unkeyable).toBe(1);
  });

  it("dedupes within a walk but reads the rotation archive too", () => {
    // One task re-observed twice in a single batch would double-count in a
    // ledger whose summary counts rows.
    writeLog(
      [{ stepResults: [okStep("todoist.create_task", { id: "1" })] }],
      "runs.jsonl.1",
    );
    writeLog([
      { stepResults: [okStep("todoist.create_task", { id: "1" })] },
      { stepResults: [okStep("todoist.create_task", { id: "2" })] },
    ]);
    const r = discoverTodoistErrandRefs({ dir });
    expect(r.refs.map((x) => x.taskId).sort()).toEqual(["1", "2"]);
  });

  it("survives a half-written row", () => {
    // An interrupted append must not end the walk and lose everything after.
    writeFileSync(
      path.join(dir, "runs.jsonl"),
      `${JSON.stringify({ stepResults: [okStep("todoist.create_task", { id: "1" })] })}\n{"stepResults":[{"tool":\n${JSON.stringify({ stepResults: [okStep("todoist.create_task", { id: "2" })] })}\n`,
    );
    expect(
      discoverTodoistErrandRefs({ dir })
        .refs.map((x) => x.taskId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("an absent run log is empty, not an error", () => {
    expect(discoverTodoistErrandRefs({ dir }).refs).toEqual([]);
  });
});

describe("coverage is reported with its denominator", () => {
  it("states the ratio rather than just the count", () => {
    writeLog([
      {
        stepResults: [
          okStep("todoist.create_task", { id: "1" }),
          okStep("http.post", { id: "2" }),
          okStep("gmail.search", {}),
        ],
      },
    ]);
    const out = formatDiscovery(discoverTodoistErrandRefs({ dir }));
    // "1 errand found" reads like success; "1 from 3 successful steps" reads
    // like what it is.
    expect(out).toContain("1 observable errand(s) from 3 successful step(s)");
  });

  it("says why an empty result is not a failure", () => {
    const out = formatDiscovery(discoverTodoistErrandRefs({ dir }));
    expect(out).toContain("run-log coverage limit, not");
  });
});
