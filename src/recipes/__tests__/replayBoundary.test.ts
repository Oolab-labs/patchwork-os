/**
 * Replay boundary — "mocked replay" must never dispatch a real tool or agent.
 *
 * Invariant (src/recipes/replayBoundary.ts): missing replay evidence REDUCES
 * what can be replayed; it never increases permission to execute.
 *
 * Grew out of the 2026-09-24 hunt reproduction: a real local `node:http`
 * server counts requests, the recipe is run ONCE for real to obtain genuine
 * captures, then replayed under each capture condition. Before the boundary
 * landed, cases B/C/D below each sent a real request and re-created a
 * deleted `file.write` target. The request counter and the file's absence
 * are the assertions that could fail — a dispatch spy alone would not have
 * caught the flat runner, whose tool path has no injectable seam.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type RecipeRun, RecipeRunLog } from "../../runLog.js";
import type { ChainedRecipe } from "../chainedRunner.js";
import { runChainedRecipe } from "../chainedRunner.js";
import {
  isReplayRefusal,
  REPLAY_REFUSED_UNMOCKED_STEP,
  ReplayIncompleteError,
} from "../replayBoundary.js";
import { replayFlatMockedRun, replayMockedRun } from "../replayRun.js";
import type { RunnerDeps, YamlRecipe } from "../yamlRunner.js";
import { buildChainedDeps, executeStep, runYamlRecipe } from "../yamlRunner.js";

let server: Server;
let url = "";
let hits = 0;
let tmpDir: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, id: `req-${hits}` }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}/hook`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits = 0;
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "replay-boundary-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOTE = () => path.join(tmpDir, "note.md");

function flatRecipe(withInto = true): YamlRecipe {
  return {
    name: "boundary-flat",
    trigger: { type: "manual" },
    steps: [
      {
        tool: "http.post",
        ...(withInto && { into: "post" }),
        url,
        allowPrivate: true,
        body: '{"k":1}',
      },
      {
        tool: "file.write",
        ...(withInto && { into: "note" }),
        path: "note.md",
        content: "written",
      },
    ],
  } as unknown as YamlRecipe;
}

/** Live deps for the ONE real run that produces genuine captures. */
function liveDeps() {
  const runLog = new RecipeRunLog({ dir: tmpDir });
  const runnerDeps: RunnerDeps = {
    logDir: tmpDir,
    workdir: tmpDir,
    testMode: false,
  };
  return { runLog, activityLog: undefined, runnerDeps };
}

/**
 * Replay deps carry spies on every injectable seam a live step could use.
 * The http server's counter is the assertion that does not depend on a
 * seam being injectable at all.
 */
function replayDeps() {
  const runLog = new RecipeRunLog({ dir: tmpDir });
  const writeFile = vi.fn((_p: string, _c: string) => {
    throw new Error("writeFile must never be reached under replay");
  });
  const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) => {
    return fetch(...args);
  }) as unknown as NonNullable<RunnerDeps["fetchFn"]>;
  const claudeCodeFn = vi.fn(async () => "AGENT MUST NOT RUN");
  const runnerDeps: RunnerDeps = {
    logDir: tmpDir,
    workdir: tmpDir,
    testMode: false,
    writeFile,
    fetchFn,
    claudeCodeFn,
  };
  return {
    deps: { runLog, activityLog: undefined, runnerDeps },
    spies: { writeFile, fetchFn, claudeCodeFn },
  };
}

async function realFlatRun(withInto = true) {
  const d = liveDeps();
  await runYamlRecipe(flatRecipe(withInto), {
    ...d.runnerDeps,
    runLog: d.runLog,
  });
  const original = d.runLog.query({ recipe: "boundary-flat", limit: 1 })[0];
  if (!original) throw new Error("real run not logged");
  return original;
}

function withOutput(run: RecipeRun, id: string, out: unknown): RecipeRun {
  return {
    ...run,
    stepResults: (run.stepResults ?? []).map((s) =>
      s.id === id ? { ...s, output: out } : s,
    ),
  };
}

function expectNothingDispatched(
  spies: ReturnType<typeof replayDeps>["spies"],
) {
  expect(hits).toBe(0);
  expect(existsSync(NOTE())).toBe(false);
  expect(spies.writeFile).not.toHaveBeenCalled();
  expect(spies.fetchFn).not.toHaveBeenCalled();
  expect(spies.claudeCodeFn).not.toHaveBeenCalled();
}

// ── flat runner ──────────────────────────────────────────────────────────

describe("flat replay boundary", () => {
  it("real run captures both steps (fixture sanity — one real request)", async () => {
    const original = await realFlatRun();
    expect(hits).toBe(1);
    expect(existsSync(NOTE())).toBe(true);
    const byId = Object.fromEntries(
      (original.stepResults ?? []).map((s) => [s.id, s]),
    );
    expect(byId.post?.output).toBeDefined();
    expect(byId.note?.output).toBeDefined();
  });

  it("A (positive control): complete capture replays from evidence — same outputs, zero dispatch", async () => {
    const original = await realFlatRun();
    const capturedPost = (original.stepResults ?? []).find(
      (s) => s.id === "post",
    )?.output;
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: original,
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(true);
    expect(r.newSeq).toBeDefined();
    expect(r.unmockedSteps).toBeUndefined();
    expect(r.result?.context.post).toBe(JSON.stringify(capturedPost));
    expectNothingDispatched(spies);
  });

  it("B: missing capture → refused before any run, nothing dispatched", async () => {
    const original = await realFlatRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: withOutput(original, "post", undefined),
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.newSeq).toBeUndefined();
    expect(r.error?.startsWith(REPLAY_REFUSED_UNMOCKED_STEP)).toBe(true);
    expect(r.unmockedSteps).toEqual(["post"]);
    expect(deps.runLog.query({ limit: 10 })).toHaveLength(1); // no replay row
    expectNothingDispatched(spies);
  });

  it("C: truncated capture → refused; the gap is never filled by executing", async () => {
    const original = await realFlatRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: withOutput(original, "post", {
        "[truncated]": true,
        bytes: 20000,
        preview: "x",
      }),
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.unmockedSteps).toEqual(["post"]);
    expectNothingDispatched(spies);
  });

  it("D: flat steps without `into:` (positional ids) → refused even with captures present", async () => {
    const original = await realFlatRun(false);
    expect((original.stepResults ?? []).map((s) => s.id)).toEqual([
      "step_0",
      "step_1",
    ]);
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: original,
      recipe: flatRecipe(false),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.unmockedSteps).toEqual(["step_0", "step_1"]);
    expectNothingDispatched(spies);
  });

  it("mixed run: first step captured, second missing → not an unqualified success", async () => {
    const original = await realFlatRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: withOutput(original, "note", undefined),
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.unmockedSteps).toEqual(["note"]);
    expectNothingDispatched(spies);
  });

  it("legacy record with no evidence at all → refused, never silently live", async () => {
    const original = await realFlatRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: {
        ...original,
        stepResults: (original.stepResults ?? []).map((s) => {
          const { output: _drop, ...rest } = s;
          return rest;
        }),
      },
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.unmockedSteps).toEqual(["post", "note"]);
    expectNothingDispatched(spies);
  });

  it("valid EMPTY capture ('') is evidence, not absence — replays without dispatch", async () => {
    const original = await realFlatRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayFlatMockedRun({
      originalRun: withOutput(withOutput(original, "post", ""), "note", ""),
      recipe: flatRecipe(),
      deps,
    });
    expect(r.ok).toBe(true);
    expect(r.result?.context.post).toBe("");
    expectNothingDispatched(spies);
  });

  it("layer 2 — preflight bypassed: runYamlRecipe under replayOnly refuses the unmocked step in-loop", async () => {
    const { deps, spies } = replayDeps();
    const result = await runYamlRecipe(flatRecipe(), {
      ...deps.runnerDeps,
      replayOnly: true,
      mockedOutputs: new Map([["post", '{"ok":true}']]), // `note` missing
    });
    expect(result.context.post).toBe('{"ok":true}');
    const note = result.stepResults.find((s) => s.id === "note");
    expect(note?.status).toBe("error");
    expect(isReplayRefusal(note?.error)).toBe(true);
    expect(result.errorMessage).toBeDefined();
    expectNothingDispatched(spies);
  });

  it("layer 3 — the dispatch seam itself throws under replayOnly, before the registry is consulted", async () => {
    // Build StepDeps the way the runners do: via buildChainedDeps, whose
    // executeTool closure calls executeStep with resolveStepDeps output.
    const { deps, spies } = replayDeps();
    const chained = buildChainedDeps(
      { ...deps.runnerDeps, replayOnly: true },
      undefined,
      "boundary-seam",
    );
    await expect(
      chained.executeTool("http.post", { url, allowPrivate: true, body: "{}" }),
    ).rejects.toBeInstanceOf(ReplayIncompleteError);
    await expect(
      chained.executeAgent("hello", undefined, "claude-code"),
    ).rejects.toBeInstanceOf(ReplayIncompleteError);
    expectNothingDispatched(spies);
  });

  it("executeStep with replayOnly StepDeps refuses even a tool nothing is registered under", async () => {
    // Without the boundary an unknown tool returns null (the documented
    // forward-compat skip). Under replay that skip is not reachable either.
    const { deps } = replayDeps();
    const chained = buildChainedDeps(
      { ...deps.runnerDeps, replayOnly: true },
      undefined,
      "boundary-seam",
    );
    await expect(
      chained.executeTool("no.such.tool", {}),
    ).rejects.toBeInstanceOf(ReplayIncompleteError);
    void executeStep; // referenced so the seam's export stays in scope
  });
});

// ── chained runner ───────────────────────────────────────────────────────

describe("chained replay boundary", () => {
  function chained(): ChainedRecipe {
    return {
      name: "boundary-chained",
      trigger: { type: "chained" },
      steps: [
        {
          id: "post",
          tool: "http.post",
          url,
          allowPrivate: true,
          body: '{"k":1}',
        },
        {
          id: "note",
          tool: "file.write",
          path: "note.md",
          content: "written",
          awaits: ["post"],
        },
      ],
    } as unknown as ChainedRecipe;
  }

  async function realChainedRun() {
    const d = liveDeps();
    const cd = buildChainedDeps(
      d.runnerDeps,
      async () => "",
      "boundary-chained",
    );
    const res = await runChainedRecipe(
      chained(),
      {
        env: {},
        maxConcurrency: 4,
        maxDepth: 3,
        runLog: d.runLog,
        dryRun: false,
      },
      cd,
    );
    expect(res.success).toBe(true);
    const original = d.runLog.query({
      recipe: "boundary-chained",
      limit: 1,
    })[0];
    if (!original) throw new Error("real chained run not logged");
    return original;
  }

  it("A (positive control): complete capture → replays from evidence, zero dispatch", async () => {
    const original = await realChainedRun();
    expect(hits).toBe(1);
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayMockedRun({
      originalRun: original,
      recipe: chained(),
      deps,
    });
    expect(r.ok).toBe(true);
    expect(r.unmockedSteps).toBeUndefined();
    expect(r.result?.stepResults.get("post")?.success).toBe(true);
    expectNothingDispatched(spies);
  });

  it("B: missing capture → refused before any run, nothing dispatched", async () => {
    const original = await realChainedRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayMockedRun({
      originalRun: withOutput(original, "post", undefined),
      recipe: chained(),
      deps,
    });
    expect(r.ok).toBe(false);
    expect(r.newSeq).toBeUndefined();
    expect(r.error?.startsWith(REPLAY_REFUSED_UNMOCKED_STEP)).toBe(true);
    expect(r.unmockedSteps).toEqual(["post"]);
    expectNothingDispatched(spies);
  });

  it("valid `null` capture is evidence — mocked, not dispatched", async () => {
    const original = await realChainedRun();
    hits = 0;
    unlinkSync(NOTE());
    const { deps, spies } = replayDeps();
    const r = await replayMockedRun({
      originalRun: withOutput(original, "note", null),
      recipe: chained(),
      deps,
    });
    expect(r.ok).toBe(true);
    expectNothingDispatched(spies);
  });

  it("layer 2 — preflight bypassed: runChainedRecipe under replayOnly refuses in-loop; earlier mocked progress does not make it a success", async () => {
    const { deps, spies } = replayDeps();
    const cd = buildChainedDeps(
      { ...deps.runnerDeps, replayOnly: true },
      undefined,
      "boundary-chained",
    );
    const res = await runChainedRecipe(
      chained(),
      {
        env: {},
        maxConcurrency: 4,
        maxDepth: 3,
        dryRun: false,
        replayOnly: true,
        mockedOutputs: new Map([["post", { ok: true }]]), // `note` missing
      },
      cd,
    );
    expect(res.success).toBe(false);
    expect(res.stepResults.get("post")?.success).toBe(true);
    expect(isReplayRefusal(res.stepResults.get("note")?.error)).toBe(true);
    expectNothingDispatched(spies);
  });

  it("layer 3 only — RunOptions WITHOUT replayOnly but replay deps: the seam still refuses", async () => {
    // Models a future caller that forgets the loop-level flag. The deps a
    // replay builds are structurally unable to dispatch, so the step fails
    // at the seam rather than hitting the server.
    const { deps, spies } = replayDeps();
    const cd = buildChainedDeps(
      { ...deps.runnerDeps, replayOnly: true },
      undefined,
      "boundary-chained",
    );
    const res = await runChainedRecipe(
      chained(),
      {
        env: {},
        maxConcurrency: 4,
        maxDepth: 3,
        dryRun: false,
        mockedOutputs: new Map([["post", { ok: true }]]),
      },
      cd,
    );
    expect(res.success).toBe(false);
    expect(isReplayRefusal(res.stepResults.get("note")?.error)).toBe(true);
    expectNothingDispatched(spies);
  });
});
