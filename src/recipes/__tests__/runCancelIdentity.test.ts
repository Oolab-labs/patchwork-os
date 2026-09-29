/**
 * Cancelling a run by `seq` can abort a different run.
 *
 * `seq` is a counter per RecipeRunLog INSTANCE. Each bridge process holds one
 * instance, and every bridge on a machine shares `~/.patchwork/runs.jsonl`,
 * syncing its counter up to the highest seq it has seen. Two bridges running
 * at the same time therefore hand the SAME seq to different runs — the
 * precondition test below reproduces that with two instances over one
 * directory, which is exactly the two-bridge shape.
 *
 * The dashboard lists runs from the shared log, and `POST /runs/:seq/cancel`
 * resolves the number only against the receiving process's in-flight registry.
 * When the number belongs to more than one run, the request cannot say which
 * one it meant, and today the receiving bridge aborts its own run regardless.
 * Contract: an ambiguous seq refuses (409) and aborts nothing; a cancel that
 * must be precise names the run by its `taskId`.
 */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSandbox } from "../../__tests__/phase0/_harness.js";
import { RecipeOrchestration } from "../../recipeOrchestration.js";
import type { RecipeRouteDeps } from "../../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../../recipeRoutes.js";
import { RecipeRunLog } from "../../runLog.js";
import { registerRun, unregisterRun } from "../runRegistry.js";

let sandbox: ReturnType<typeof makeSandbox>;
beforeEach(() => {
  sandbox = makeSandbox("run-cancel-identity");
});
afterEach(() => {
  sandbox.dispose();
});

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}
function makeRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

/** Two bridges over one shared log, each starting a run at the same moment. */
function twoBridgesStartRuns() {
  const bridgeX = new RecipeRunLog({ dir: sandbox.dir });
  const bridgeY = new RecipeRunLog({ dir: sandbox.dir });
  const at = Date.parse("2026-09-01T12:00:00Z");
  const seqX = bridgeX.startRun({
    taskId: "yaml:example-x:1",
    recipeName: "example-x",
    trigger: "cron",
    createdAt: at,
    startedAt: at,
  });
  const seqY = bridgeY.startRun({
    taskId: "yaml:example-y:1",
    recipeName: "example-y",
    trigger: "cron",
    createdAt: at,
    startedAt: at,
  });
  return { bridgeX, bridgeY, seqX, seqY };
}

describe("run identity: seq is not unique across bridges", () => {
  it("precondition: two bridges sharing a log give two live runs one seq", () => {
    const { seqX, seqY } = twoBridgesStartRuns();
    expect(seqX).toBe(seqY);
  });

  it("a cancel whose seq names two runs refuses and aborts nothing", () => {
    const { bridgeX, seqX } = twoBridgesStartRuns();
    // Bridge X's own run is live in X's registry under the shared number.
    const controller = registerRun(seqX);
    try {
      // A fresh reader of the shared log sees both runs, as the dashboard does.
      const shared = new RecipeRunLog({ dir: sandbox.dir });
      const deps = {
        runsBySeqFn: (seq: number) => shared.getAllBySeq(seq),
      } as unknown as RecipeRouteDeps;
      expect(
        (
          deps as unknown as { runsBySeqFn: (s: number) => unknown[] }
        ).runsBySeqFn(seqX).length,
        "the shared log holds two runs under this seq",
      ).toBe(2);

      const { res, read } = makeRes();
      tryHandleRecipeRoute(
        makeReq("POST"),
        res,
        new URL(`http://x/runs/${seqX}/cancel`),
        deps,
      );
      expect(read().status, "ambiguous seq is refused").toBe(409);
      expect(
        controller.signal.aborted,
        "bridge X's run was not cancelled on a guess",
      ).toBe(false);
      void bridgeX;
    } finally {
      unregisterRun(seqX);
    }
  });

  it("a cancel pinned to a taskId aborts only that run", () => {
    const { seqX } = twoBridgesStartRuns();
    const controller = registerRun(seqX, "yaml:example-x:1");
    try {
      const wrong = makeRes();
      tryHandleRecipeRoute(
        makeReq("POST"),
        wrong.res,
        new URL(`http://x/runs/${seqX}/cancel?taskId=yaml:example-y:1`),
        {} as unknown as RecipeRouteDeps,
      );
      expect(wrong.read().status, "the other bridge's run is not ours").toBe(
        409,
      );
      expect(controller.signal.aborted).toBe(false);

      const right = makeRes();
      tryHandleRecipeRoute(
        makeReq("POST"),
        right.res,
        new URL(`http://x/runs/${seqX}/cancel?taskId=yaml:example-x:1`),
        {} as unknown as RecipeRouteDeps,
      );
      expect(right.read().status).toBe(200);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      unregisterRun(seqX);
    }
  });

  it("control: a finished run sharing the seq does not block a cancel", () => {
    const { bridgeY, seqX, seqY } = twoBridgesStartRuns();
    bridgeY.completeRun(seqY, {
      status: "done",
      doneAt: Date.parse("2026-09-01T12:00:01Z"),
      durationMs: 1000,
      stepResults: [],
    });
    const controller = registerRun(seqX, "yaml:example-x:1");
    try {
      const shared = new RecipeRunLog({ dir: sandbox.dir });
      const { res, read } = makeRes();
      tryHandleRecipeRoute(
        makeReq("POST"),
        res,
        new URL(`http://x/runs/${seqX}/cancel`),
        {
          runsBySeqFn: (seq: number) => shared.getAllBySeq(seq),
        } as unknown as RecipeRouteDeps,
      );
      expect(read().status).toBe(200);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      unregisterRun(seqX);
    }
  });

  it("wiring: the orchestration hands the route the shared log's lookup", () => {
    const { seqX } = twoBridgesStartRuns();
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
    const fn = server.runsBySeqFn as (s: number) => Array<{ taskId: string }>;
    expect(typeof fn).toBe("function");
    expect(
      fn(seqX)
        .map((r) => r.taskId)
        .sort(),
    ).toEqual(["yaml:example-x:1", "yaml:example-y:1"]);
  });

  it("a run finished long ago is read at its final status, not its first row", () => {
    // The log appends a run when it starts and again when it finishes. With a
    // memory cap of 1 the older run is on disk only, so this exercises the
    // disk path: its LAST row (done) must win over its first (running).
    const base = {
      recipeName: "example-y",
      trigger: "cron",
      createdAt: 1,
      startedAt: 1,
    };
    const rows = [
      { ...base, seq: 7, taskId: "yaml:example-y:1", status: "running" },
      {
        ...base,
        seq: 7,
        taskId: "yaml:example-y:1",
        status: "done",
        doneAt: 2,
        durationMs: 1,
      },
      {
        ...base,
        recipeName: "example-x",
        seq: 7,
        taskId: "yaml:example-x:1",
        status: "running",
        createdAt: 3,
        startedAt: 3,
      },
    ];
    writeFileSync(
      path.join(sandbox.dir, "runs.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const log = new RecipeRunLog({ dir: sandbox.dir, memoryCap: 1 });
    const finished = log
      .getAllBySeq(7)
      .find((r) => r.taskId === "yaml:example-y:1");
    expect(finished?.status, "not reported as still running").toBe("done");
  });
});
