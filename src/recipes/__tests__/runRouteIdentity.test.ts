/**
 * Detail, replay and plan must reach the run the caller meant.
 *
 * A seq is only unique per bridge (see RecipeRunLog.getAllBySeq); the bridges
 * sharing one run log hand the same number to different runs. The seq routes
 * resolved it with `getBySeq`, which returns the first match, so a run page,
 * a replay or a plan could silently belong to a DIFFERENT run — and a
 * different recipe. These tests put two runs of two recipes under one seq and
 * check each route resolves the right one, through the real orchestration
 * wiring rather than hand-injected functions.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSandbox } from "../../__tests__/phase0/_harness.js";
import { RecipeOrchestration } from "../../recipeOrchestration.js";
import type { RecipeRouteDeps } from "../../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../../recipeRoutes.js";
import { RecipeRunLog } from "../../runLog.js";

let sandbox: ReturnType<typeof makeSandbox>;
beforeEach(() => {
  sandbox = makeSandbox("run-route-identity");
});
afterEach(() => {
  sandbox.dispose();
});

const X = "yaml:example-x:1";
const Y = "yaml:example-y:1";

/** Two bridges sharing one log, each finishing a run under the same seq. */
function twoRunsOneSeq(): number {
  const at = Date.parse("2026-09-01T12:00:00Z");
  const bridgeX = new RecipeRunLog({ dir: sandbox.dir });
  const bridgeY = new RecipeRunLog({ dir: sandbox.dir });
  const seqX = bridgeX.startRun({
    taskId: X,
    recipeName: "example-x",
    trigger: "cron",
    createdAt: at,
    startedAt: at,
  });
  const seqY = bridgeY.startRun({
    taskId: Y,
    recipeName: "example-y",
    trigger: "cron",
    createdAt: at,
    startedAt: at,
  });
  expect(seqX, "precondition: the two runs share a seq").toBe(seqY);
  for (const [log, seq] of [
    [bridgeX, seqX],
    [bridgeY, seqY],
  ] as const) {
    log.completeRun(seq, {
      status: "done",
      doneAt: at + 1000,
      durationMs: 1000,
      stepResults: [],
    });
  }
  return seqX;
}

/** Wire a server object through the production orchestration. */
function wiredServer(): Record<string, unknown> {
  const server: Record<string, unknown> = {};
  const ro = new RecipeOrchestration({
    server,
    getOrchestrator: () => null,
    recipeOrchestrator: {},
    recipeRunLog: new RecipeRunLog({ dir: sandbox.dir }),
    workdir: sandbox.dir,
    logger: {},
  } as unknown as ConstructorParameters<typeof RecipeOrchestration>[0]);
  ro.wireServerFns();
  return server;
}

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}
function makeRes() {
  let status = 0;
  let body = "";
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      done();
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    finished,
    read: () => ({ status, body: body ? JSON.parse(body) : undefined }),
  };
}
async function call(
  method: string,
  url: string,
  deps: Record<string, unknown>,
) {
  const r = makeRes();
  tryHandleRecipeRoute(
    makeReq(method),
    r.res,
    new URL(`http://x${url}`),
    deps as unknown as RecipeRouteDeps,
  );
  await r.finished;
  return r.read();
}

describe("seq routes refuse or flag a seq that names two runs", () => {
  it("replay by an ambiguous seq refuses (409) and names both runs", async () => {
    const seq = twoRunsOneSeq();
    const server = wiredServer();
    const out = await call("POST", `/runs/${seq}/replay`, server);
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("ambiguous_seq");
    expect([...out.body.taskIds].sort()).toEqual([X, Y]);
  });

  it("detail by an ambiguous seq says so, listing every candidate", async () => {
    const seq = twoRunsOneSeq();
    const server = wiredServer();
    const out = await call("GET", `/runs/${seq}`, server);
    expect(out.status).toBe(200);
    expect([...out.body.sameSeqTaskIds].sort()).toEqual([X, Y]);
  });
});

describe("by-task routes reach exactly the named run", () => {
  it("detail returns the named run, not the other run sharing its seq", async () => {
    twoRunsOneSeq();
    const server = wiredServer();
    for (const [taskId, recipe] of [
      [X, "example-x"],
      [Y, "example-y"],
    ] as const) {
      const out = await call(
        "GET",
        `/runs/by-task/${encodeURIComponent(taskId)}`,
        server,
      );
      expect(out.status).toBe(200);
      expect(out.body.run.taskId).toBe(taskId);
      expect(out.body.run.recipeName).toBe(recipe);
    }
  });

  it("plan is built for the named run's recipe", async () => {
    twoRunsOneSeq();
    const server = wiredServer();
    const runPlanFn = vi.fn(async (name: string) => ({ recipe: name }));
    const out = await call(
      "GET",
      `/runs/by-task/${encodeURIComponent(Y)}/plan`,
      { ...server, runPlanFn },
    );
    expect(out.status).toBe(200);
    expect(runPlanFn).toHaveBeenCalledWith("example-y");
  });

  it("replay resolves the named run (unknown taskId → 404)", async () => {
    twoRunsOneSeq();
    const server = wiredServer();
    const missing = await call(
      "POST",
      `/runs/by-task/${encodeURIComponent("yaml:nope:1")}/replay`,
      server,
    );
    expect(missing.status).toBe(404);
    // A known run gets past resolution. Its recipe file is not installed in
    // this sandbox, so the replay itself fails — but not as run_not_found.
    const known = await call(
      "POST",
      `/runs/by-task/${encodeURIComponent(X)}/replay`,
      server,
    );
    expect(known.body.error).not.toBe("run_not_found");
    expect(known.body.error).not.toBe("ambiguous_seq");
  });

  it("an undecodable taskId is a 400, not a lookup", async () => {
    const out = await call("GET", "/runs/by-task/%E0%A4%A", {});
    expect(out.status).toBe(400);
  });
});
