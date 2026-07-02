/**
 * GET/POST /outcomes — operator outcome dispositions over HTTP (the bridge
 * twin of `patchwork outcomes confirm|reject|list`). Exercises
 * `tryHandleRecipeRoute` directly with a fake req/res + a temp OutcomeStore,
 * so no real `~/.patchwork/outcome-log.jsonl` is touched.
 *
 * The write path is deliberately Bearer-gated HTTP + CLI ONLY (never a recipe
 * step / MCP tool) so a worker cannot confirm its own filings — that boundary
 * is enforced by where the route lives (after the auth gate in server.ts) and
 * by never registering it as a tool; these tests cover the route contract.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipeRouteDeps } from "../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../recipeRoutes.js";
import { OutcomeStore } from "../workers/outcomeStore.js";

function makeReq(method: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  read: () => { status: number; body: string };
} {
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

/** Let the POST route's async body-read + handler settle before asserting. */
const flush = () => new Promise((r) => setImmediate(r));

let tmpDir: string;
let deps: RecipeRouteDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "outcomes-routes-"));
  // A fresh store per call — exactly what the production wiring does — so every
  // read re-reads the append-only log from disk (last-writer-wins).
  deps = {
    outcomeStoreFn: () => new OutcomeStore(tmpDir),
  } as unknown as RecipeRouteDeps;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function getOutcomes(d: RecipeRouteDeps = deps): {
  handled: boolean;
  status: number;
  body: string;
} {
  const { res, read } = makeRes();
  const handled = tryHandleRecipeRoute(
    makeReq("GET"),
    res,
    new URL("http://x/outcomes"),
    d,
  );
  return { handled, ...read() };
}

async function postOutcome(
  bodyObj: unknown,
  d: RecipeRouteDeps = deps,
): Promise<{ handled: boolean; status: number; body: string }> {
  const req = makeReq("POST");
  const { res, read } = makeRes();
  const handled = tryHandleRecipeRoute(
    req,
    res,
    new URL("http://x/outcomes"),
    d,
  );
  req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
  req.emit("end");
  await flush();
  await flush();
  return { handled, ...read() };
}

const URL_A = "https://github.com/o/r/issues/9";

describe("GET /outcomes", () => {
  it("returns an empty list when no records exist", () => {
    const { handled, status, body } = getOutcomes();
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ outcomes: [] });
  });

  it("returns the recorded outcomes after a POST", async () => {
    await postOutcome({ issueUrl: URL_A, disposition: "confirmed" });
    const { status, body } = getOutcomes();
    expect(status).toBe(200);
    const { outcomes } = JSON.parse(body);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      issueUrl: URL_A,
      disposition: "confirmed",
    });
    expect(typeof outcomes[0].checkedAt).toBe("number");
  });

  it("returns an empty list (not an error) when the store dep is absent", () => {
    const noStore = {} as unknown as RecipeRouteDeps;
    const { status, body } = getOutcomes(noStore);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ outcomes: [] });
  });
});

describe("POST /outcomes", () => {
  it("records a confirmed disposition (200)", async () => {
    const { handled, status, body } = await postOutcome({
      issueUrl: URL_A,
      disposition: "confirmed",
    });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      issueUrl: URL_A,
      disposition: "confirmed",
    });
  });

  it("records a junk disposition + audit context (200)", async () => {
    const { status } = await postOutcome({
      issueUrl: URL_A,
      disposition: "junk",
      recipeName: "triage-failing-tests-autofile",
      workerClass: "issue:compensable:high",
    });
    expect(status).toBe(200);
    const { outcomes } = JSON.parse(getOutcomes().body);
    expect(outcomes[0]).toMatchObject({
      issueUrl: URL_A,
      disposition: "junk",
      recipeName: "triage-failing-tests-autofile",
      workerClass: "issue:compensable:high",
    });
  });

  it("last-writer-wins: a superseding POST flips the disposition", async () => {
    await postOutcome({ issueUrl: URL_A, disposition: "confirmed" });
    await postOutcome({ issueUrl: URL_A, disposition: "junk" });
    const { outcomes } = JSON.parse(getOutcomes().body);
    expect(outcomes).toHaveLength(1); // deduped
    expect(outcomes[0].disposition).toBe("junk");
  });

  it("rejects a non-http(s) issueUrl (400)", async () => {
    const { status, body } = await postOutcome({
      issueUrl: "not-a-url",
      disposition: "confirmed",
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).ok).toBe(false);
  });

  it("rejects a missing issueUrl (400)", async () => {
    const { status } = await postOutcome({ disposition: "confirmed" });
    expect(status).toBe(400);
  });

  it("rejects disposition 'unknown' — ingester-only (400)", async () => {
    const { status, body } = await postOutcome({
      issueUrl: URL_A,
      disposition: "unknown",
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/ingester-only/);
  });

  it("rejects a missing disposition (400)", async () => {
    const { status } = await postOutcome({ issueUrl: URL_A });
    expect(status).toBe(400);
  });

  it("rejects an unknown body key (400)", async () => {
    const { status } = await postOutcome({
      issueUrl: URL_A,
      disposition: "confirmed",
      sneaky: "x",
    });
    expect(status).toBe(400);
  });

  it("returns 503 when the store dep is absent (nothing persisted)", async () => {
    const noStore = {} as unknown as RecipeRouteDeps;
    const { status } = await postOutcome(
      { issueUrl: URL_A, disposition: "confirmed" },
      noStore,
    );
    expect(status).toBe(503);
  });
});
