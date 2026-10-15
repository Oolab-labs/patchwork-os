/**
 * GET /runs — the older-than cursor (`before`) and the `fields=summary`
 * projection. Exercises `tryHandleRecipeRoute` with a fake req/res, plus one
 * walk through the route against a real `RecipeRunLog`.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RecipeRouteDeps, tryHandleRecipeRoute } from "../recipeRoutes.js";
import { RecipeRunLog } from "../runLog.js";
import { encodeRunCursor } from "../runPage.js";

function makeReq(method: string, url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  return req;
}

function makeRes() {
  let status = 0;
  let resolveDone!: (v: { status: number; body: string }) => void;
  const done = new Promise<{ status: number; body: string }>((r) => {
    resolveDone = r;
  });
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(body?: string) {
      resolveDone({ status, body: body ?? "" });
      return this;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeDeps(overrides: Partial<RecipeRouteDeps>): RecipeRouteDeps {
  return {
    runsFn: null,
    runsPageFn: null,
    ...overrides,
  } as unknown as RecipeRouteDeps;
}

async function get(deps: RecipeRouteDeps, pathAndQuery: string) {
  const { res, done } = makeRes();
  const handled = tryHandleRecipeRoute(
    makeReq("GET", pathAndQuery),
    res,
    new URL(`http://x${pathAndQuery}`),
    deps,
  );
  expect(handled).toBe(true);
  return done;
}

const ROWS = [
  { seq: 2, taskId: "b", stepResults: [{ id: "s" }] },
  { seq: 1, taskId: "a" },
];

describe("GET /runs without `before` — unchanged", () => {
  it("returns the legacy body byte-for-byte and never consults the pager", async () => {
    const runsPageFn = vi.fn();
    const runsFn = vi.fn(() => ROWS);
    const { status, body } = await get(
      makeDeps({ runsFn, runsPageFn }),
      "/runs?limit=5&recipe=r&after=0",
    );
    expect(status).toBe(200);
    expect(body).toBe(JSON.stringify({ runs: ROWS }));
    expect(runsPageFn).not.toHaveBeenCalled();
    expect(runsFn).toHaveBeenCalledWith({ limit: 5, recipe: "r", after: 0 });
  });

  it("fields=summary drops stepResults from the legacy shape too", async () => {
    const { body } = await get(
      makeDeps({ runsFn: () => ROWS }),
      "/runs?fields=summary",
    );
    expect(JSON.parse(body)).toEqual({
      runs: [
        { seq: 2, taskId: "b", stepCount: 1 },
        { seq: 1, taskId: "a" },
      ],
    });
  });
});

describe("GET /runs?before=…", () => {
  it("before=latest asks the pager for the newest page", async () => {
    const runsPageFn = vi.fn(() => ({ runs: [], nextBefore: null }));
    const { status, body } = await get(
      makeDeps({ runsPageFn }),
      "/runs?before=latest&limit=10&status=done&trigger=cron&recipe=r&manualRunId=m&fields=summary",
    );
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ runs: [], nextBefore: null });
    expect(runsPageFn).toHaveBeenCalledWith({
      before: null,
      limit: 10,
      status: "done",
      trigger: "cron",
      recipe: "r",
      manualRunId: "m",
      fields: "summary",
    });
  });

  it("decodes a cursor and passes it through", async () => {
    const runsPageFn = vi.fn(() => ({ runs: [], nextBefore: null }));
    const cursor = encodeRunCursor({ createdAt: 42, key: "task:x" });
    await get(
      makeDeps({ runsPageFn }),
      `/runs?before=${encodeURIComponent(cursor)}`,
    );
    expect(runsPageFn).toHaveBeenCalledWith({
      before: { createdAt: 42, key: "task:x" },
    });
  });

  it.each([
    "",
    "nonsense",
    "v1.@@@",
  ])("an invalid cursor %j is a 400, not an empty page", async (bad) => {
    const runsPageFn = vi.fn();
    const { status, body } = await get(
      makeDeps({ runsPageFn }),
      `/runs?before=${encodeURIComponent(bad)}`,
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: "invalid_cursor" });
    expect(runsPageFn).not.toHaveBeenCalled();
  });

  it("before and after together is a 400 — they order by different keys", async () => {
    const { status, body } = await get(
      makeDeps({ runsPageFn: vi.fn() }),
      "/runs?before=latest&after=3",
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      error: "before_and_after_are_exclusive",
    });
  });

  it("an unknown fields value is a 400", async () => {
    const { status, body } = await get(
      makeDeps({ runsFn: () => [] }),
      "/runs?fields=everything",
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: "invalid_fields" });
  });

  it("no pager wired ⇒ an empty, exhausted page", async () => {
    const { status, body } = await get(makeDeps({}), "/runs?before=latest");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ runs: [], nextBefore: null });
  });
});

describe("GET /runs?before — through the route against a real run log", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runs-cursor-route-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("walks every run past the in-memory window, once each, in order", async () => {
    const log = new RecipeRunLog({ dir, memoryCap: 4 });
    for (let i = 0; i < 23; i++) {
      log.appendDirect({
        taskId: `t${i}`,
        recipeName: "r",
        trigger: "recipe",
        status: "done",
        createdAt: 1_000 + i,
        doneAt: 1_000 + i,
        durationMs: 1,
      });
    }
    const deps = makeDeps({
      runsPageFn: (q) =>
        log.queryPage(q as Parameters<RecipeRunLog["queryPage"]>[0]) as never,
    });
    const seen: string[] = [];
    let before = "latest";
    for (let guard = 0; guard < 50; guard++) {
      const { status, body } = await get(
        deps,
        `/runs?before=${encodeURIComponent(before)}&limit=5`,
      );
      expect(status).toBe(200);
      const page = JSON.parse(body) as {
        runs: Array<{ taskId: string }>;
        nextBefore: string | null;
      };
      seen.push(...page.runs.map((r) => r.taskId));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => `t${22 - i}`));
  });
});
