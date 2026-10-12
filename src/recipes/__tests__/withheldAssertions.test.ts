/**
 * A run handed a `text` (or `file`) input records no ANSWER TEXT through the
 * two channels #1694 left open: completion-contract failures and judge
 * verdicts.
 *
 * - A run-level `expect` failure records the `actual` value that failed, and
 *   its message quotes it. A step-level `expect: equals` failure quotes the
 *   step's output in `error` / `haltReason` / `expectWarnings`. When the
 *   checked value is the model's answer, both carry the operator's material.
 * - A judge verdict carries free-text `reasons`, a `fixList`, and the `raw`
 *   model text when unparseable — all of which can quote the artefact under
 *   review.
 *
 * In a protected run (same predicate as #1694: `runWithholdsOutputs`) the
 * structure survives — assertion id, recipe-authored `expected`, verdict kind
 * — and the text is replaced by an `{ reason, length, sha256 }` marker. The
 * same recipe without such an input is recorded exactly as before.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RecipeRun, RecipeRunLog } from "../../runLog.js";
import { createRecipeRunLog } from "../../runStore/createRunLog.js";
import { runChainedRecipe } from "../chainedRunner.js";
import { OUTPUT_WITHHELD_REASON } from "../withheldOutputs.js";
import { buildChainedDeps, runYamlRecipe } from "../yamlRunner.js";

const MARKER = "ASSERT-MARKER-7c2f41";
const ANSWER = `Organised notes: Alex (${MARKER}) ships the importer.`;
const NOTES = "Meeting notes. Alex: ship the importer.";
const REASONS = [`the draft quotes ${MARKER} verbatim`];
const FIXES = [`remove ${MARKER}`];
const JUDGE_CHANGES = JSON.stringify({
  verdict: "request_changes",
  reasons: REASONS,
  fixList: FIXES,
});
const JUDGE_GARBAGE = `I cannot decide about ${MARKER}`;

const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

const BASE_DEPS = {
  readFile: () => {
    throw new Error("no reads in this test");
  },
  writeFile: () => {},
  appendFile: () => {},
  mkdir: () => {},
  gitLogSince: () => "",
  gitStaleBranches: () => "",
  getDiagnostics: () => "",
  claudeFn: async () => ANSWER,
};

let dir: string;
const openLogs: RecipeRunLog[] = [];
function openLog(): RecipeRunLog {
  const log = createRecipeRunLog({ dir });
  openLogs.push(log);
  return log;
}
let prevHome: string | undefined;
let prevClaudeDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "withheld-assertions-"));
  prevHome = process.env.PATCHWORK_HOME;
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.PATCHWORK_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  mkdirSync(join(dir, "claude", "ide"), { recursive: true });
});
afterEach(() => {
  // Release the sqlite mirror's file handle before removing the directory —
  // Windows refuses to delete an open database file (EPERM).
  for (const log of openLogs.splice(0)) log.close();
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  rmSync(dir, { recursive: true, force: true });
});

function persistedFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

function expectAbsentEverywhere(root: string, needle: string) {
  const files = persistedFiles(root);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(readFileSync(f, "utf-8"), f).not.toContain(needle);
  }
}

function persistedText(root: string): string {
  return persistedFiles(root)
    .map((f) => readFileSync(f, "utf-8"))
    .join("\n");
}

function lastRun(): RecipeRun {
  const rows = readFileSync(join(dir, "runs.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecipeRun)
    .filter((r) => r.taskId !== undefined);
  const run = rows[rows.length - 1];
  if (!run) throw new Error("no run row");
  return run;
}

async function withEchoServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(Buffer.concat(chunks).toString("utf-8"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}/echo`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const TEXT_INPUT = [{ name: "materials", type: "text" }];
const PLAIN_INPUT = [{ name: "materials" }];

/** A model that answers, and judges according to `judge(callNo)`. */
function model(judge: (n: number) => string) {
  let judgeCalls = 0;
  return async (prompt: string) => {
    if (prompt.includes("cold-eyes reviewer")) return judge(judgeCalls++);
    return ANSWER;
  };
}

// ---------------------------------------------------------------------------
// Flat runner
// ---------------------------------------------------------------------------

async function runFlat(
  inputs: Record<string, unknown>[],
  judgeAgent: Record<string, unknown>,
  judge: (n: number) => string,
) {
  return withEchoServer((url) =>
    runYamlRecipe(
      {
        name: "noisy-recipe",
        trigger: { type: "manual", inputs },
        steps: [
          {
            agent: {
              prompt: "Organise these notes:\n{{materials}}",
              driver: "claude-code",
              into: "organised",
            },
            // Step-level contract on the AGENT answer — warn keeps it in ctx.
            expect: { equals: "never-this", on_fail: "warn" },
          },
          {
            agent: {
              kind: "judge",
              reviews: "organised",
              prompt: "Review the organised notes.",
              driver: "claude-code",
              into: "review",
              ...judgeAgent,
            },
          },
          {
            tool: "http.post",
            url,
            allowPrivate: true,
            contentType: "text/plain",
            body: "{{organised}}",
            into: "posted",
            // Step-level contract on a TOOL output that echoes the answer.
            expect: { equals: "never-that", on_fail: "warn" },
          },
        ],
        // Run-level completion contract on the answer.
        expect: { context: { organised: "never-present" } },
      } as never,
      {
        ...BASE_DEPS,
        testMode: false,
        logDir: dir,
        workdir: dir,
        runLog: openLog(),
        claudeCodeFn: model(judge),
      } as never,
      { materials: inputs === TEXT_INPUT ? NOTES : "short-topic" },
    ),
  );
}

describe("flat runner — assertion failures and judge text in a protected run", () => {
  it("withholds assertion actuals, step-expect quotes and judge free text", async () => {
    await runFlat(TEXT_INPUT, {}, () => JUDGE_CHANGES);
    const run = lastRun();

    // Run-level contract: structure kept, actual replaced by a marker.
    expect(run.assertionFailures).toHaveLength(1);
    const f = run.assertionFailures?.[0] as Record<string, unknown>;
    expect(f.assertion).toBe("context.organised");
    expect(f.expected).toBe("never-present");
    expect(Object.hasOwn(f, "actual")).toBe(false);
    expect(f.actualWithheld).toEqual({
      reason: OUTPUT_WITHHELD_REASON,
      length: ANSWER.length,
      sha256: sha256(ANSWER),
    });
    expect(String(f.message)).toContain("withheld");

    const rows = run.stepResults ?? [];
    const postRow = rows.find((s) => s.tool === "http.post");

    // Judge: verdict kind kept, free text withheld with a marker.
    const judgeRow = rows.find((s) => s.judgeVerdict !== undefined);
    expect(judgeRow?.judgeVerdict?.verdict).toBe("request_changes");
    expect(judgeRow?.judgeVerdict?.reasons).toEqual([]);
    expect(judgeRow?.judgeVerdict?.fixList).toBeUndefined();
    const text = JSON.stringify({ reasons: REASONS, fixList: FIXES });
    expect(judgeRow?.judgeVerdict?.textWithheld).toEqual({
      reason: OUTPUT_WITHHELD_REASON,
      length: text.length,
      sha256: sha256(text),
    });
    expect(postRow?.status).toBe("ok");

    expectAbsentEverywhere(dir, MARKER);
  });

  it("step-expect failures in the returned result do not quote the answer", async () => {
    const result = await runFlat(TEXT_INPUT, {}, () => JUDGE_CHANGES);
    const warnings = result.stepResults
      .flatMap((s) => s.expectWarnings ?? [])
      .join("\n");
    expect(warnings).toContain("equals:");
    expect(warnings).toContain("withheld");
    expect(warnings).not.toContain(MARKER);
    // Neither the agent-step site nor the tool-step site quotes.
    expect(
      result.stepResults.filter((s) => (s.expectWarnings ?? []).length > 0),
    ).toHaveLength(2);
    expect(JSON.stringify(result.assertionFailures)).not.toContain(MARKER);
  });

  it("a halting step contract does not quote the answer in error / haltReason", async () => {
    await withEchoServer((url) =>
      runYamlRecipe(
        {
          name: "noisy-recipe",
          trigger: { type: "manual", inputs: TEXT_INPUT },
          steps: [
            {
              tool: "http.post",
              url,
              allowPrivate: true,
              contentType: "text/plain",
              body: `echo ${MARKER}`,
              into: "posted",
              expect: { equals: "never-that" },
            },
          ],
        } as never,
        {
          ...BASE_DEPS,
          testMode: false,
          logDir: dir,
          workdir: dir,
          runLog: openLog(),
        } as never,
        { materials: NOTES },
      ),
    );
    const run = lastRun();
    const row = run.stepResults?.[0];
    expect(row?.status).toBe("error");
    expect(row?.haltReason).toContain("expect_failed");
    expectAbsentEverywhere(dir, MARKER);
  });

  it("the refine loop's final verdict is withheld", async () => {
    await runFlat(
      TEXT_INPUT,
      { max_revisions: 1, on_exhausted: "proceed" },
      () => JUDGE_CHANGES,
    );
    const judgeRow = lastRun().stepResults?.find((s) => s.judgeVerdict);
    expect(judgeRow?.judgeVerdict?.verdict).toBe("request_changes");
    expect(judgeRow?.judgeVerdict?.textWithheld?.reason).toBe(
      OUTPUT_WITHHELD_REASON,
    );
    expectAbsentEverywhere(dir, MARKER);
  });

  it("an unparseable re-judge keeps its raw text out of the ledgers", async () => {
    await runFlat(
      TEXT_INPUT,
      { max_revisions: 1, on_exhausted: "proceed" },
      (n) => (n === 0 ? JUDGE_CHANGES : JUDGE_GARBAGE),
    );
    const judgeRow = lastRun().stepResults?.find((s) => s.judgeVerdict);
    expect(judgeRow?.judgeVerdict?.verdict).toBe("unparseable");
    expect(judgeRow?.judgeVerdict?.raw).toBeUndefined();
    expect(judgeRow?.judgeVerdict?.textWithheld?.reason).toBe(
      OUTPUT_WITHHELD_REASON,
    );
    expectAbsentEverywhere(dir, MARKER);
  });

  it("the same recipe without a text input records actual and verdict text as before", async () => {
    const result = await runFlat(PLAIN_INPUT, {}, () => JUDGE_CHANGES);
    const run = lastRun();
    const f = run.assertionFailures?.[0];
    expect(f?.actual).toBe(ANSWER);
    expect(f?.message).toContain(MARKER);
    expect(JSON.stringify(run)).not.toContain("actualWithheld");
    expect(JSON.stringify(run)).not.toContain("textWithheld");
    const judgeRow = run.stepResults?.find((s) => s.judgeVerdict);
    expect(judgeRow?.judgeVerdict).toEqual({
      verdict: "request_changes",
      reasons: REASONS,
      fixList: FIXES,
    });
    const warnings = result.stepResults
      .flatMap((s) => s.expectWarnings ?? [])
      .join("\n");
    expect(warnings).toContain(MARKER);
    expect(persistedText(dir)).toContain(MARKER);
  });

  it("an unparseable verdict without a text input keeps its raw text", async () => {
    await runFlat(
      PLAIN_INPUT,
      { max_revisions: 1, on_exhausted: "proceed" },
      (n) => (n === 0 ? JUDGE_CHANGES : JUDGE_GARBAGE),
    );
    const judgeRow = lastRun().stepResults?.find((s) => s.judgeVerdict);
    expect(judgeRow?.judgeVerdict?.verdict).toBe("unparseable");
    expect(judgeRow?.judgeVerdict?.raw).toContain(MARKER);
  });
});

describe("sqlite run-store mirror", () => {
  let prevFlag: string | undefined;
  beforeEach(() => {
    prevFlag = process.env.PATCHWORK_FLAG_RUNSTORE_MIRROR;
    process.env.PATCHWORK_FLAG_RUNSTORE_MIRROR = "1";
  });
  afterEach(() => {
    if (prevFlag === undefined)
      delete process.env.PATCHWORK_FLAG_RUNSTORE_MIRROR;
    else process.env.PATCHWORK_FLAG_RUNSTORE_MIRROR = prevFlag;
  });

  const mirrorText = () => persistedText(join(dir, "runstore-mirror"));

  it("a protected run leaves no assertion or verdict text in the mirror", async () => {
    await runFlat(TEXT_INPUT, {}, () => JUDGE_CHANGES);
    const text = mirrorText();
    expect(text).toContain("actualWithheld");
    expect(text).toContain("textWithheld");
    expectAbsentEverywhere(dir, MARKER);
  });

  it("without a text input the mirror carries the text (the check can fail)", async () => {
    await runFlat(PLAIN_INPUT, {}, () => JUDGE_CHANGES);
    expect(mirrorText()).toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// Chained runner
// ---------------------------------------------------------------------------

async function runChained(inputs: Record<string, unknown>[]) {
  const deps = buildChainedDeps(
    {
      ...BASE_DEPS,
      testMode: false,
      logDir: dir,
      workdir: dir,
    } as never,
    async () => ANSWER,
    "noisy-recipe",
  );
  return withEchoServer((url) =>
    runChainedRecipe(
      {
        name: "noisy-recipe",
        trigger: { type: "chained", inputs },
        steps: [
          {
            id: "organise",
            agent: {
              prompt: "Organise these notes:\n{{env.materials}}",
              driver: "claude-code",
            },
            expect: { equals: "never-this", on_fail: "warn" },
          },
          {
            id: "post",
            tool: "http.post",
            url,
            allowPrivate: true,
            contentType: "text/plain",
            body: "{{steps.organise.data}}",
            awaits: ["organise"],
            expect: { equals: "never-that", on_fail: "warn" },
          },
        ],
        expect: { context: { organise: "never-present" } },
      } as never,
      {
        env: { materials: inputs === TEXT_INPUT ? NOTES : "short-topic" },
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLog: openLog(),
      } as never,
      deps,
    ),
  );
}

describe("chained runner — assertion failures in a protected run", () => {
  it("withholds the assertion actual and step-expect quotes", async () => {
    const result = await runChained(TEXT_INPUT);
    const run = lastRun();
    const f = run.assertionFailures?.[0] as Record<string, unknown>;
    expect(f.assertion).toBe("context.organise");
    expect(f.expected).toBe("never-present");
    expect(Object.hasOwn(f, "actual")).toBe(false);
    expect(f.actualWithheld).toEqual({
      reason: OUTPUT_WITHHELD_REASON,
      length: ANSWER.length,
      sha256: sha256(ANSWER),
    });
    // Both step-expect sites warned, neither quotes.
    const warned = (run.stepResults ?? []).filter(
      (s) => ((s as { expectWarnings?: string[] }).expectWarnings ?? []).length,
    );
    expect(warned.map((s) => s.id).sort()).toEqual(["organise", "post"]);
    expect(JSON.stringify(result.assertionFailures)).not.toContain(MARKER);
    expectAbsentEverywhere(dir, MARKER);
  });

  it("the same recipe without a text input records actual as before", async () => {
    await runChained(PLAIN_INPUT);
    const run = lastRun();
    const f = run.assertionFailures?.[0];
    expect(f?.actual).toBe(ANSWER);
    expect(JSON.stringify(run)).not.toContain("actualWithheld");
    const warned = JSON.stringify(
      (run.stepResults ?? []).map(
        (s) => (s as { expectWarnings?: string[] }).expectWarnings,
      ),
    );
    expect(warned).toContain(MARKER);
  });
});
