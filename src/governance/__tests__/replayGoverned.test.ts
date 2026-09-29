/**
 * Replay under the governed profile.
 *
 * Replay used to REFUSE a worker-owned recipe under governed
 * (`replay_refused_worker_owned_under_governed`) because it could not rebuild
 * the worker gate, and a replay "with fewer gates than the live run" would
 * have made a `forbids` rule reachable. Since the three-layer replay boundary
 * (src/recipes/replayBoundary.ts) replay dispatches NOTHING — every step
 * returns its captured output, replays its recorded failure, or is refused —
 * so there is no action for the worker gate to decide. What remains are the
 * two ways a replay could still touch governance state, each pinned here:
 *
 *   - it must not write a worker gate Decision Record (nothing was decided);
 *   - its run row must carry the replay marker, so trust replay never folds
 *     it as evidence (see workers/__tests__/replayRunsNotTrustEvidence.test.ts).
 *
 * And the boundary itself must still hold for a worker-owned recipe: an
 * unmocked step refuses the whole replay and starts no run.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeOrchestration } from "../../recipeOrchestration.js";
import { RecipeRunLog } from "../../runLog.js";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../profile.js";

let home: string;
const RECIPE = "replay-owned";

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "replay-gov-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("PATCHWORK_FLAG_WORKER_AUTONOMY", "1");
  mkdirSync(path.join(home, "recipes"), { recursive: true });
  mkdirSync(path.join(home, "workers"), { recursive: true });
  writeFileSync(
    path.join(home, "recipes", `${RECIPE}.yaml`),
    `name: ${RECIPE}\ntrigger: { type: manual }\nsteps:\n  - tool: file.read\n    path: ./x\n    into: x\n`,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetActiveProfileForTesting();
  rmSync(home, { recursive: true, force: true });
});

function bindWorker(): void {
  const tplDir = path.join(process.cwd(), "templates", "workers");
  const first = (
    readFileSync(path.join(tplDir, "release-notes.worker.yaml"), "utf8") ?? ""
  ).replace(/^recipe:.*$/m, `recipe: ${RECIPE}`);
  writeFileSync(path.join(home, "workers", "owned.worker.yaml"), first);
}

/** An original run in a real run log; `captured` decides step x's output. */
function seedOriginal(captured: boolean): { log: RecipeRunLog; seq: number } {
  const log = new RecipeRunLog({ dir: home });
  const t = Date.now() - 60_000;
  const seq = log.startRun({
    taskId: `yaml:${RECIPE}:${t}`,
    recipeName: RECIPE,
    trigger: "recipe",
    createdAt: t,
    startedAt: t,
  });
  log.completeRun(seq, {
    status: "done",
    doneAt: t + 10,
    durationMs: 10,
    stepResults: [
      {
        id: "x",
        tool: "file.read",
        status: "ok",
        durationMs: 1,
        ...(captured && { output: "synthetic captured content" }),
      },
    ],
  });
  return { log, seq };
}

function orchestration(log: RecipeRunLog): Record<string, unknown> {
  const server: Record<string, unknown> = { approvalGate: "off" };
  const ro = new RecipeOrchestration({
    server: server as never,
    getOrchestrator: () => null,
    recipeOrchestrator: {
      loadRecipe: () => ({}),
      listRecipes: () => [],
    } as never,
    recipeRunLog: log as never,
    workdir: home,
    logger: {},
  } as never);
  ro.wireServerFns();
  return server;
}

type ReplayFn = (seq: number) => Promise<{
  ok: boolean;
  error?: string;
  newSeq?: number;
  unmockedSteps?: string[];
}>;

describe("replay under the governed profile", () => {
  it("replays a worker-owned recipe whose every step was captured", async () => {
    bindWorker();
    setActiveProfile(GOVERNED_PROFILE);
    const { log, seq } = seedOriginal(true);
    const r = await (orchestration(log).runReplayFn as ReplayFn)(seq);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.newSeq).toBeDefined();
    const replayed = log.query({ recipe: RECIPE, limit: 5 });
    const row = replayed.find((x) => x.seq === r.newSeq);
    // The trust fold's exclusion keys on this marker.
    expect(row?.replay).toBe(true);
  });

  it("writes no worker gate Decision Record and queues no approval", async () => {
    bindWorker();
    setActiveProfile(GOVERNED_PROFILE);
    const { log, seq } = seedOriginal(true);
    const server = orchestration(log);
    const r = await (server.runReplayFn as ReplayFn)(seq);
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(home, "worker_gate_decisions.jsonl"))).toBe(
      false,
    );
    expect(existsSync(path.join(home, "approval_log.jsonl"))).toBe(false);
  });

  it("still refuses an unmocked step of a worker-owned recipe, starting no run", async () => {
    bindWorker();
    setActiveProfile(GOVERNED_PROFILE);
    const { log, seq } = seedOriginal(false);
    const before = log.query({ recipe: RECIPE, limit: 50 }).length;
    const r = await (orchestration(log).runReplayFn as ReplayFn)(seq);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^replay_refused_unmocked_step/);
    expect(r.unmockedSteps).toEqual(["x"]);
    expect(log.query({ recipe: RECIPE, limit: 50 }).length).toBe(before);
  });

  it("a recipe no worker owns replays the same way", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const { log, seq } = seedOriginal(true);
    const r = await (orchestration(log).runReplayFn as ReplayFn)(seq);
    expect(r.ok).toBe(true);
  });

  it("compat replays a worker-owned recipe (unchanged)", async () => {
    bindWorker();
    const { log, seq } = seedOriginal(true);
    const r = await (orchestration(log).runReplayFn as ReplayFn)(seq);
    expect(r.ok).toBe(true);
    const row = log
      .query({ recipe: RECIPE, limit: 5 })
      .find((x) => x.seq === r.newSeq);
    expect(row?.replay).toBe(true);
  });
});
