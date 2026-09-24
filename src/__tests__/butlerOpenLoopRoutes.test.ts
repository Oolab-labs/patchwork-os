import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ButlerOpenLoopStore } from "../butler/openLoopStore.js";
import type { ButlerOpenLoopRouteDeps } from "../butlerOpenLoopRoutes.js";
import { tryHandleButlerOpenLoopRoute } from "../butlerOpenLoopRoutes.js";

let dir: string;
let store: ButlerOpenLoopStore;
let enabled = true;
let deps: ButlerOpenLoopRouteDeps;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "butler-open-loop-routes-"));
  store = new ButlerOpenLoopStore({ dir, logger: { warn: () => {} } });
  enabled = true;
  deps = { storeFn: () => store, enabledFn: () => enabled };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
    end(value?: string) {
      body = value ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ handled: boolean; status: number; json: any }> {
  const req = makeReq(method);
  const { res, read } = makeRes();
  const handled = tryHandleButlerOpenLoopRoute(
    req,
    res,
    new URL(`http://x${url}`),
    deps,
  );
  if (body !== undefined) {
    (req as unknown as EventEmitter).emit(
      "data",
      Buffer.from(JSON.stringify(body)),
    );
  }
  (req as unknown as EventEmitter).emit("end");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const result = read();
  return {
    handled,
    status: result.status,
    json: result.body ? JSON.parse(result.body) : undefined,
  };
}

describe("Butler Loose Ends routes", () => {
  it("fails closed before touching disk when the feature is disabled", async () => {
    enabled = false;
    const r = await call("POST", "/butler/loops", {
      kind: "remember",
      text: "Buy batteries",
    });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("feature_disabled");
    expect(() =>
      readFileSync(path.join(dir, "open_loops.jsonl"), "utf8"),
    ).toThrow();
  });

  it("creates, lists, completes and reopens a loose end", async () => {
    const created = await call("POST", "/butler/loops", {
      kind: "promise",
      text: "Bring David his book",
    });
    expect(created.status).toBe(201);
    expect(created.json.loop.kind).toBe("promise");
    expect(created.json.loop.source).toBe("http");

    const id = created.json.loop.id as string;
    const listed = await call("GET", "/butler/loops?status=open&kind=promise");
    expect(listed.status).toBe(200);
    expect(listed.json.count).toBe(1);

    const completed = await call(
      "POST",
      `/butler/loops/${encodeURIComponent(id)}/complete`,
    );
    expect(completed.status).toBe(200);
    expect(completed.json.loop.status).toBe("done");

    const reopened = await call(
      "POST",
      `/butler/loops/${encodeURIComponent(id)}/reopen`,
    );
    expect(reopened.status).toBe(200);
    expect(reopened.json.loop.status).toBe("open");
  });

  it("rejects caller-supplied provenance and any other unknown keys", async () => {
    const r = await call("POST", "/butler/loops", {
      kind: "remember",
      text: "Buy batteries",
      source: "import",
    });
    expect(r.status).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  it("returns a deterministic compact brief", async () => {
    await call("POST", "/butler/loops", {
      kind: "remember",
      text: "Buy batteries",
    });
    await call("POST", "/butler/loops", {
      kind: "waiting",
      text: "Headphones refund",
    });

    const r = await call("GET", "/butler/loops/brief?limit=1");
    expect(r.status).toBe(200);
    expect(r.json.openCount).toBe(2);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].text).toBe("Buy batteries");
    expect(r.json.message).toBe("1 thing worth remembering");
  });

  it("requires explicit erase=true and then destroys the text", async () => {
    const created = await call("POST", "/butler/loops", {
      kind: "waiting",
      text: "Private refund reference",
    });
    const id = created.json.loop.id as string;

    const guarded = await call("DELETE", `/butler/loops/${id}`);
    expect(guarded.status).toBe(400);
    expect(store.get(id)?.text).toBe("Private refund reference");

    const erased = await call("DELETE", `/butler/loops/${id}?erase=true`);
    expect(erased.status).toBe(200);
    expect(erased.json.erased).toBe(true);
    expect(store.get(id)).toBeUndefined();
    expect(
      readFileSync(path.join(dir, "open_loops.jsonl"), "utf8"),
    ).not.toContain("Private refund reference");
  });

  it("returns 404 for an unknown id and validates filters", async () => {
    const missing = await call("POST", "/butler/loops/not-a-real-id/complete");
    expect(missing.status).toBe(404);

    expect((await call("GET", "/butler/loops?status=maybe")).status).toBe(400);
    expect((await call("GET", "/butler/loops?kind=other")).status).toBe(400);
    expect((await call("GET", "/butler/loops/brief?limit=99")).status).toBe(
      400,
    );
  });

  it("does not claim unrelated Butler paths", async () => {
    const r = await call("GET", "/butler/facts");
    expect(r.handled).toBe(false);
    expect(r.status).toBe(0);
  });
});
