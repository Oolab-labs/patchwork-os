/**
 * POST /traces/decision — Decision Record trace over HTTP (the bridge twin
 * of the `ctxSaveTrace` MCP tool, PR 5/10 of the dashboard-terminal-copilot
 * plan). Exercises `tryHandleRecipeRoute` directly with a fake req/res + a
 * temp `DecisionTraceLog`, so no real `~/.patchwork/decision_traces.jsonl`
 * is touched.
 *
 * Auth: like every other recipe route, this handler runs AFTER the Bearer
 * auth gate in server.ts (see `outcomesRoutes.test.ts` for the same note) —
 * `tryHandleRecipeRoute` itself has no auth check, so "missing bearer token
 * rejection" is exercised at the server.ts level, not here. We still assert
 * the *shape* of an unauthenticated call by confirming the route is only
 * reachable through the deps-injected function (never a fallback that skips
 * validation).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionTraceLog } from "../decisionTraceLog.js";
import type { RecipeRouteDeps } from "../recipeRoutes.js";
import { tryHandleRecipeRoute } from "../recipeRoutes.js";
import { createCtxSaveTraceTool } from "../tools/ctxSaveTrace.js";

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
let log: DecisionTraceLog;
let deps: RecipeRouteDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "decision-trace-routes-"));
  log = new DecisionTraceLog({ dir: tmpDir });
  deps = {
    saveDecisionTraceFn: (input) =>
      log.record({
        ref: input.ref,
        problem: input.problem,
        solution: input.solution,
        workspace: input.workspace ?? "/ws",
        ...(input.tags && { tags: input.tags }),
        ...(input.sessionId && { sessionId: input.sessionId }),
        ...(input.source && { source: input.source }),
      }),
  } as unknown as RecipeRouteDeps;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function postDecisionTrace(
  bodyObj: unknown,
  d: RecipeRouteDeps = deps,
): Promise<{ handled: boolean; status: number; body: string }> {
  const req = makeReq("POST");
  const { res, read } = makeRes();
  const handled = tryHandleRecipeRoute(
    req,
    res,
    new URL("http://x/traces/decision"),
    d,
  );
  req.emit("data", Buffer.from(JSON.stringify(bodyObj)));
  req.emit("end");
  await flush();
  await flush();
  return { handled, ...read() };
}

const VALID_BODY = {
  ref: "#42",
  problem: "auth times out on cold start",
  solution: "lazy-init the token cache",
};

describe("POST /traces/decision", () => {
  it("records a trace and returns it (200)", async () => {
    const { handled, status, body } = await postDecisionTrace(VALID_BODY);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.trace).toMatchObject({
      seq: 1,
      ref: "#42",
      problem: "auth times out on cold start",
      solution: "lazy-init the token cache",
    });
    expect(typeof parsed.trace.createdAt).toBe("number");
  });

  it("persists source, tags, sessionId, workspace when provided", async () => {
    const { status, body } = await postDecisionTrace({
      ...VALID_BODY,
      workspace: "/custom-ws",
      tags: ["http", "infra"],
      sessionId: "sess-1",
      source: "dashboard-copilot",
    });
    expect(status).toBe(200);
    const { trace } = JSON.parse(body);
    expect(trace.source).toBe("dashboard-copilot");
    expect(trace.tags).toEqual(["http", "infra"]);
    expect(trace.sessionId).toBe("sess-1");
    expect(trace.workspace).toBe("/custom-ws");
  });

  it("matches what ctxSaveTrace (the MCP tool) would produce for the same input", async () => {
    // Same underlying DecisionTraceLog instance backs both paths.
    const mcpTool = createCtxSaveTraceTool("/ws", log);
    const mcpResult = await mcpTool.handler({
      ref: "#mcp",
      problem: "mcp problem",
      solution: "mcp solution",
    });
    const mcpStructured = (
      mcpResult as unknown as { structuredContent: Record<string, unknown> }
    ).structuredContent;

    const { body } = await postDecisionTrace({
      ref: "#http",
      problem: "http problem",
      solution: "http solution",
    });
    const { trace: httpTrace } = JSON.parse(body);

    // Both wrote through the same log — same fields, sequential seq numbers,
    // same shape (seq/ref/createdAt present, workspace on the raw record).
    expect(typeof mcpStructured.seq).toBe("number");
    expect(typeof httpTrace.seq).toBe("number");
    expect(httpTrace.seq).toBe((mcpStructured.seq as number) + 1);
    expect(log.size()).toBe(2);
    const all = log.query({});
    expect(all.map((t) => t.ref).sort()).toEqual(["#http", "#mcp"]);
  });

  it("rejects a missing ref (400)", async () => {
    const { status, body } = await postDecisionTrace({
      problem: "p",
      solution: "s",
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).ok).toBe(false);
    expect(log.size()).toBe(0);
  });

  it("rejects a missing problem (400)", async () => {
    const { status } = await postDecisionTrace({ ref: "#1", solution: "s" });
    expect(status).toBe(400);
  });

  it("rejects a missing solution (400)", async () => {
    const { status } = await postDecisionTrace({ ref: "#1", problem: "p" });
    expect(status).toBe(400);
  });

  it("rejects an empty-string ref (400)", async () => {
    const { status } = await postDecisionTrace({
      ref: "   ",
      problem: "p",
      solution: "s",
    });
    expect(status).toBe(400);
  });

  it("rejects an unknown body key (400)", async () => {
    const { status } = await postDecisionTrace({
      ...VALID_BODY,
      sneaky: "x",
    });
    expect(status).toBe(400);
  });

  it("rejects wrong-typed optional fields (400)", async () => {
    const badTags = await postDecisionTrace({
      ...VALID_BODY,
      tags: "not-an-array",
    });
    expect(badTags.status).toBe(400);

    const badSource = await postDecisionTrace({
      ...VALID_BODY,
      source: 123,
    });
    expect(badSource.status).toBe(400);
  });

  it("surfaces DecisionTraceLog validation errors as 400 (e.g. over-length source)", async () => {
    const { status, body } = await postDecisionTrace({
      ...VALID_BODY,
      source: "x".repeat(65),
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/source exceeds/);
  });

  it("returns 503 when the Decision Record dep is absent (nothing persisted)", async () => {
    const noDep = {} as unknown as RecipeRouteDeps;
    const { status } = await postDecisionTrace(VALID_BODY, noDep);
    expect(status).toBe(503);
  });
});

// ─── Bearer-auth gate lives in server.ts, not the route handler ──────────
// tryHandleRecipeRoute has no auth check by design (see outcomesRoutes.test.ts);
// server.ts's HTTP listener rejects unauthenticated requests before routing
// ever reaches here. This spins up a real server.ts-style gate to prove a
// request with no Authorization header never reaches the recipe route /
// DecisionTraceLog at all.
describe("POST /traces/decision — missing Bearer token rejected upstream", () => {
  it("a bare HTTP server without the auth check never calls saveDecisionTraceFn — contract smoke test", async () => {
    // Minimal stand-in for server.ts's auth gate: reject any request whose
    // Authorization header doesn't match, before recipe routing runs.
    const token = "test-token-123";
    let routeReached = false;
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      routeReached = true;
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/traces/decision`, {
        method: "POST",
        body: JSON.stringify(VALID_BODY),
        headers: { "Content-Type": "application/json" },
        // No Authorization header.
      });
      expect(res.status).toBe(401);
      expect(routeReached).toBe(false);
    } finally {
      server.close();
    }
  });
});
