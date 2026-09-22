/**
 * Replay under the governed profile.
 *
 * A replay cannot rebuild the worker gate (no live trust context), so a
 * worker-owned recipe must be REFUSED rather than replayed with fewer gates
 * than the live run had — otherwise a `forbids` rule is reachable by
 * re-running yesterday's evidence.
 */

import {
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

function orchestration(): {
  server: Record<string, unknown>;
  ro: RecipeOrchestration;
} {
  const server: Record<string, unknown> = { approvalGate: "off" };
  const ro = new RecipeOrchestration({
    server: server as never,
    getOrchestrator: () => null,
    recipeOrchestrator: {
      loadRecipe: () => ({}),
      listRecipes: () => [],
    } as never,
    recipeRunLog: {
      getBySeq: (seq: number) =>
        seq === 7 ? { seq: 7, recipeName: RECIPE, taskId: "t" } : undefined,
    } as never,
    workdir: home,
    logger: {},
  } as never);
  ro.wireServerFns();
  return { server, ro };
}

describe("replay under the governed profile", () => {
  it("refuses to replay a worker-owned recipe (no worker gate can be rebuilt)", async () => {
    bindWorker();
    setActiveProfile(GOVERNED_PROFILE);
    const { server } = orchestration();
    const fn = server.runReplayFn as (
      seq: number,
    ) => Promise<{ ok: boolean; error?: string }>;
    const r = await fn(7);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("replay_refused_worker_owned_under_governed");
  });
  it("a recipe no worker owns is not refused for that reason", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    const { server } = orchestration();
    const fn = server.runReplayFn as (
      seq: number,
    ) => Promise<{ ok: boolean; error?: string }>;
    const r = await fn(7);
    expect(r.error).not.toBe("replay_refused_worker_owned_under_governed");
  });
  it("compat does not refuse a worker-owned recipe", async () => {
    bindWorker();
    const { server } = orchestration();
    const fn = server.runReplayFn as (
      seq: number,
    ) => Promise<{ ok: boolean; error?: string }>;
    const r = await fn(7);
    expect(r.error).not.toBe("replay_refused_worker_owned_under_governed");
  });
});
