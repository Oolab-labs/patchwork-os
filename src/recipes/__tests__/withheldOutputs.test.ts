/**
 * A run handed a `text` (or `file`) input records NO step outputs.
 *
 * The input VALUE is already kept out of the ledgers by the value-redaction
 * layer (textInputs.test.ts). What that cannot catch is the ANSWER: a model
 * asked to organise pasted notes quotes them back, and the flight recorder
 * used to capture that answer on the step row, in `run_steps.jsonl`, and as
 * the orchestrator task row's `outputTail`. These tests pin that a protected
 * run carries an explicit `outputWithheld` marker (length + sha256) instead,
 * that the same recipe without such an input is recorded exactly as before,
 * and that replay / simulate treat a withheld step as withheld — never empty.
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

import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver } from "../../drivers/types.js";
import { type RecipeRun, RecipeRunLog } from "../../runLog.js";
import { createRecipeRunLog } from "../../runStore/createRunLog.js";
import { saveUpload } from "../../uploadStore.js";
import { runChainedRecipe } from "../chainedRunner.js";
import {
  buildMockedOutputs,
  replayFlatMockedRun,
  replayMockedRun,
} from "../replayRun.js";
import { synthesizeMockedOutputs } from "../simulation/synthesizeMockedOutputs.js";
import {
  OUTPUT_WITHHELD_REASON,
  outputWithheldMarker,
  REPLAY_UNAVAILABLE_OUTPUTS_WITHHELD,
  runWithholdsOutputs,
} from "../withheldOutputs.js";
import { buildChainedDeps, runYamlRecipe } from "../yamlRunner.js";

const ANSWER_MARKER = "ANSWER-MARKER-5d1e9b";
const ANSWER =
  `1. Alex (${ANSWER_MARKER}): ship the importer by the end of the month\n` +
  "2. Open question: does the old plan still apply?";
const NOTES = "Meeting notes. Alex: ship the importer. Old plan unclear.";

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
let prevHome: string | undefined;
let prevClaudeDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "withheld-outputs-"));
  prevHome = process.env.PATCHWORK_HOME;
  prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.PATCHWORK_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  mkdirSync(join(dir, "claude", "ide"), { recursive: true });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Every file persisted under `root`. */
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

function runRows(): RecipeRun[] {
  return readFileSync(join(dir, "runs.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecipeRun)
    .filter((r) => r.taskId !== undefined);
}

function lastRun(): RecipeRun {
  const rows = runRows();
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

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe("runWithholdsOutputs", () => {
  const recipe = (input: Record<string, unknown>) => ({
    trigger: { type: "manual", inputs: [{ name: "materials", ...input }] },
  });

  it("is true for a text input given a value", () => {
    expect(
      runWithholdsOutputs(recipe({ type: "text" }), { materials: "x" }),
    ).toBe(true);
  });

  it("is true for a file input — covered by type, not by name", () => {
    expect(
      runWithholdsOutputs(recipe({ type: "file" }), {
        materials: { uploadId: "u1" },
      }),
    ).toBe(true);
  });

  it("is true for a text input with only a default", () => {
    expect(
      runWithholdsOutputs(recipe({ type: "text", default: "seed" }), {}),
    ).toBe(true);
  });

  it("is false for a declared text input with no value and no default", () => {
    expect(runWithholdsOutputs(recipe({ type: "text" }), {})).toBe(false);
    expect(
      runWithholdsOutputs(recipe({ type: "text" }), { materials: "" }),
    ).toBe(false);
  });

  it("is false for a string input, whatever its value", () => {
    expect(runWithholdsOutputs(recipe({}), { materials: "x" })).toBe(false);
    expect(
      runWithholdsOutputs(recipe({ type: "string" }), { materials: "x" }),
    ).toBe(false);
  });

  it("reads trigger.vars too", () => {
    expect(
      runWithholdsOutputs(
        { trigger: { type: "manual", vars: [{ name: "n", type: "text" }] } },
        { n: "x" },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flat runner
// ---------------------------------------------------------------------------

describe("flat runner — a run with a text input records no step outputs", () => {
  async function runFlat(
    inputs: Record<string, unknown>[],
    vars: Record<string, string>,
  ) {
    const cliCalls: unknown[] = [];
    await withEchoServer((url) =>
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
            },
            {
              tool: "http.post",
              url,
              allowPrivate: true,
              contentType: "text/plain",
              body: "{{organised}}",
              into: "posted",
            },
          ],
        } as never,
        {
          ...BASE_DEPS,
          testMode: false,
          logDir: dir,
          workdir: dir,
          runLog: createRecipeRunLog({ dir }),
          claudeCodeFn: async (_p: string, opts?: unknown) => {
            cliCalls.push(opts);
            return ANSWER;
          },
        } as never,
        vars,
      ),
    );
    return cliCalls;
  }

  it("withholds the agent answer and every step output, with markers", async () => {
    const cliCalls = await runFlat([{ name: "materials", type: "text" }], {
      materials: NOTES,
    });
    expectFlatWithheld(cliCalls);
  });

  it("a resolved `type: file` input withholds exactly like a text input", async () => {
    const saved = await saveUpload("notes.txt", Buffer.from(NOTES));
    expect(saved.ok).toBe(true);
    const cliCalls = await runFlat([{ name: "materials", type: "file" }], {
      materials: "notes.txt",
    });
    // The input really resolved: the agent was dispatched with the upload
    // dir as a read grant, i.e. this is a file-input run, not a refused one.
    expect(JSON.stringify(cliCalls[0])).toContain("uploads");
    expectFlatWithheld(cliCalls);
  });

  function expectFlatWithheld(cliCalls: unknown[]) {
    const run = lastRun();
    const agentRow = run.stepResults?.find((s) => s.tool === "agent");
    const postRow = run.stepResults?.find((s) => s.tool === "http.post");
    expect(agentRow?.status).toBe("ok");
    expect(postRow?.status).toBe("ok");
    expect(agentRow?.output).toBeUndefined();
    expect(postRow?.output).toBeUndefined();
    expect(agentRow?.outputWithheld).toEqual({
      reason: OUTPUT_WITHHELD_REASON,
      length: ANSWER.length,
      sha256: sha256(ANSWER),
    });
    expect(postRow?.outputWithheld?.reason).toBe(OUTPUT_WITHHELD_REASON);
    expect(postRow?.outputWithheld?.length).toBeGreaterThanOrEqual(
      ANSWER.length,
    );
    expect(postRow?.outputWithheld?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The in-flight ledger got the non-reversible step — with the marker.
    const steps = readFileSync(join(dir, "run_steps.jsonl"), "utf-8");
    expect(steps).toContain("outputWithheld");

    // The orchestrator was told this agent task belongs to a protected run.
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toMatchObject({ withholdOutput: true });

    // And the answer is in no persisted file at all.
    expectAbsentEverywhere(dir, ANSWER_MARKER);
  }

  it("the same recipe without a text input is recorded exactly as before", async () => {
    const cliCalls = await runFlat([{ name: "materials" }], {
      materials: "short-topic",
    });

    const run = lastRun();
    const postRow = run.stepResults?.find((s) => s.tool === "http.post");
    const agentRow = run.stepResults?.find((s) => s.tool === "agent");
    // Flight recorder unchanged: the echo is captured...
    expect(JSON.stringify(postRow?.output)).toContain(ANSWER_MARKER);
    // ...flat agent rows still carry no output, and nothing is marked.
    expect(agentRow?.output).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("outputWithheld");
    // The driver call shape is untouched.
    expect(cliCalls).toHaveLength(1);
    expect(
      cliCalls[0] === undefined ||
        !Object.hasOwn(cliCalls[0] as object, "withholdOutput"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chained runner
// ---------------------------------------------------------------------------

describe("chained runner — a run with a text input records no step outputs", () => {
  async function runChained(
    inputs: Record<string, unknown>[],
    env: Record<string, string>,
  ) {
    const cliCalls: unknown[] = [];
    const writes: string[] = [];
    const deps = buildChainedDeps(
      {
        ...BASE_DEPS,
        // The destination: captured, never a file under the test home.
        writeFile: (_path: string, content: string) => {
          writes.push(content);
        },
        testMode: false,
        logDir: dir,
        workdir: dir,
      } as never,
      async (_p: string, opts?: unknown) => {
        cliCalls.push(opts);
        return ANSWER;
      },
      "noisy-recipe",
    );
    await runChainedRecipe(
      {
        name: "noisy-recipe",
        trigger: { type: "chained", inputs },
        allowWrites: ["file.write"],
        steps: [
          {
            id: "organise",
            agent: {
              prompt: "Organise these notes:\n{{env.materials}}",
              driver: "claude-code",
            },
          },
          {
            id: "save",
            tool: "file.write",
            path: "~/.patchwork/inbox/organised.md",
            content: "{{steps.organise.data}}",
            awaits: ["organise"],
          },
        ],
      } as never,
      {
        env,
        maxConcurrency: 1,
        maxDepth: 3,
        dryRun: false,
        runLog: createRecipeRunLog({ dir }),
      } as never,
      deps,
    );
    return { cliCalls, writes };
  }

  it("withholds the agent answer, outputs, params and registry snapshots", async () => {
    const { cliCalls, writes } = await runChained(
      [{ name: "materials", type: "text" }],
      {
        materials: NOTES,
      },
    );

    const run = lastRun();
    const organise = run.stepResults?.find((s) => s.id === "organise");
    const save = run.stepResults?.find((s) => s.id === "save");
    expect(organise?.status).toBe("ok");
    expect(save?.status).toBe("ok");
    for (const row of [organise, save]) {
      expect(row?.output).toBeUndefined();
      expect(row?.resolvedParams).toBeUndefined();
      expect(row?.registrySnapshot).toBeUndefined();
    }
    expect(organise?.outputWithheld).toEqual({
      reason: OUTPUT_WITHHELD_REASON,
      length: ANSWER.length,
      sha256: sha256(ANSWER),
    });
    expect(save?.outputWithheld?.reason).toBe(OUTPUT_WITHHELD_REASON);

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]).toMatchObject({ withholdOutput: true });

    // The answer reached its destination...
    expect(writes.join("\n")).toContain(ANSWER_MARKER);
    // ...and no ledger.
    expectAbsentEverywhere(dir, ANSWER_MARKER);
  });

  it("the same recipe without a text input is recorded exactly as before", async () => {
    const { cliCalls } = await runChained([{ name: "materials" }], {
      materials: "short-topic",
    });
    const run = lastRun();
    const organise = run.stepResults?.find((s) => s.id === "organise");
    expect(JSON.stringify(organise?.output)).toContain(ANSWER_MARKER);
    expect(JSON.stringify(run)).not.toContain("outputWithheld");
    expect(
      cliCalls[0] === undefined ||
        !Object.hasOwn(cliCalls[0] as object, "withholdOutput"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator task row
// ---------------------------------------------------------------------------

function answeringDriver(): ProviderDriver {
  return {
    name: "answering",
    async run(input) {
      input.onChunk?.(ANSWER);
      return { text: ANSWER, exitCode: 0, durationMs: 1 };
    },
  };
}

describe("orchestrator — a protected agent task keeps no output", () => {
  it("hands the answer to its caller only; the task, its file and its run row carry the marker", async () => {
    const rows: Array<Parameters<RecipeRunLog["record"]>[0]> = [];
    const log = new RecipeRunLog({ dir });
    let orch: ClaudeOrchestrator;
    orch = new ClaudeOrchestrator(
      answeringDriver(),
      dir,
      () => {},
      undefined,
      (taskId) => {
        // Exactly what the bridge's done-listener records (bridge.ts).
        const t = orch.getTask(taskId);
        if (!t) return;
        const row = {
          id: t.id,
          triggerSource: t.triggerSource,
          status: t.status,
          createdAt: t.createdAt,
          ...(t.output !== undefined && { output: t.output }),
          ...(t.outputWithheld !== undefined && {
            outputWithheld: t.outputWithheld,
          }),
        };
        rows.push(row);
        log.record(row);
      },
    );
    const task = await orch.runAndWait({
      prompt: `Organise these notes:\n${NOTES}`,
      triggerSource: "recipe:noisy-recipe:agent",
      withholdOutput: OUTPUT_WITHHELD_REASON,
    });

    // The runner still gets its answer.
    expect(task.output).toBe(ANSWER);
    // Nothing else does.
    const shared = orch.getTask(task.id);
    expect(shared?.output).toBeUndefined();
    expect(shared?.outputWithheld).toEqual(outputWithheldMarker(ANSWER));
    expect(rows[0]?.output).toBeUndefined();

    const row = lastRun();
    expect(row.recipeName).toBe("noisy-recipe:agent");
    expect(row.outputTail).toBeUndefined();
    expect(row.outputWithheld).toEqual(outputWithheldMarker(ANSWER));

    await orch.persistTasks(4242);
    const file = readFileSync(
      join(dir, "claude", "ide", "tasks-4242.json"),
      "utf-8",
    );
    const persisted = JSON.parse(file).tasks[0];
    expect(persisted.output).toBeUndefined();
    expect(persisted.promptPreview).toBeUndefined();
    expect(persisted.outputWithheld).toEqual(outputWithheldMarker(ANSWER));
    expect(file).not.toContain(ANSWER_MARKER);
    expect(file).not.toContain("Meeting notes");

    expectAbsentEverywhere(dir, ANSWER_MARKER);
  });

  it("an unprotected task is recorded as before", async () => {
    const log = new RecipeRunLog({ dir });
    let orch: ClaudeOrchestrator;
    orch = new ClaudeOrchestrator(
      answeringDriver(),
      dir,
      () => {},
      undefined,
      (taskId) => {
        const t = orch.getTask(taskId);
        if (t) log.record({ ...t });
      },
    );
    const task = await orch.runAndWait({
      prompt: "Organise",
      triggerSource: "recipe:noisy-recipe:agent",
    });
    expect(orch.getTask(task.id)?.output).toBe(ANSWER);
    expect(lastRun().outputTail).toBe(ANSWER);
    expect(lastRun().outputWithheld).toBeUndefined();
  });

  it("RecipeRunLog.record never writes an outputTail beside a withheld marker", () => {
    const log = new RecipeRunLog({ dir });
    log.record({
      id: "t-1",
      triggerSource: "recipe:noisy-recipe:agent",
      status: "done",
      createdAt: 1,
      doneAt: 2,
      output: ANSWER,
      outputWithheld: outputWithheldMarker(ANSWER),
    });
    const row = lastRun();
    expect(row.outputTail).toBeUndefined();
    expect(row.outputWithheld?.length).toBe(ANSWER.length);
    expect(readFileSync(join(dir, "runs.jsonl"), "utf-8")).not.toContain(
      ANSWER_MARKER,
    );
  });
});

// ---------------------------------------------------------------------------
// Readers of captured outputs
// ---------------------------------------------------------------------------

function withheldRun(seq: number): RecipeRun {
  return {
    seq,
    taskId: `yaml:noisy-recipe:${seq}`,
    recipeName: "noisy-recipe",
    trigger: "recipe",
    status: "done",
    createdAt: seq,
    doneAt: seq + 1,
    durationMs: 1,
    stepResults: [
      {
        id: "organised",
        tool: "agent",
        status: "ok",
        durationMs: 1,
        outputWithheld: outputWithheldMarker(ANSWER),
      },
      {
        id: "posted",
        tool: "http.post",
        status: "ok",
        durationMs: 1,
        outputWithheld: outputWithheldMarker("echo"),
      },
    ],
  };
}

describe("replay refuses a run whose outputs were withheld", () => {
  const replayDeps = () => ({
    runLog: new RecipeRunLog({ dir }),
    runnerDeps: { ...BASE_DEPS, workdir: dir } as never,
  });

  it("flat", async () => {
    const result = await replayFlatMockedRun({
      originalRun: withheldRun(7),
      recipe: { name: "noisy-recipe", steps: [] } as never,
      deps: replayDeps(),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.startsWith(REPLAY_UNAVAILABLE_OUTPUTS_WITHHELD)).toBe(
      true,
    );
    expect(result.newSeq).toBeUndefined();
  });

  it("chained", async () => {
    const result = await replayMockedRun({
      originalRun: withheldRun(8),
      recipe: { name: "noisy-recipe", steps: [] } as never,
      deps: replayDeps(),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.startsWith(REPLAY_UNAVAILABLE_OUTPUTS_WITHHELD)).toBe(
      true,
    );
  });

  it("a withheld step is never a mocked value or a replayed failure", () => {
    const { outputs, failures } = buildMockedOutputs(withheldRun(9));
    expect(outputs.has("organised")).toBe(false);
    expect(failures.has("organised")).toBe(false);
  });
});

describe("simulate skips a withheld step rather than treating it as empty", () => {
  it("falls back to an older usable capture, never to the withheld run", () => {
    const older: RecipeRun = {
      ...withheldRun(1),
      stepResults: [
        {
          id: "posted",
          tool: "http.post",
          status: "ok",
          durationMs: 1,
          output: "older",
        },
      ],
    };
    const runLog = {
      query: () => [withheldRun(2), older],
    } as unknown as RecipeRunLog;
    const { outputs, historyStepIds } = synthesizeMockedOutputs(
      "noisy-recipe",
      runLog,
    );
    expect(outputs.get("posted")).toBe("older");
    expect(outputs.has("organised")).toBe(false);
    expect(historyStepIds.has("organised")).toBe(false);
  });
});
