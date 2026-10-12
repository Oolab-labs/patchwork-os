/**
 * Integration test for GET /privacy/receipts.
 *
 * The endpoint half of making the ADR-0021 enforcement ledger readable from
 * the open runtime. Until it existed, the only reader of
 * `boundary_receipts.jsonl` in the whole workspace lived in the separate
 * non-MIT control plane — the condition ADR-0019:88-92 forbids.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { BoundaryReceiptLog } from "../privacy/boundaryReceiptLog.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-privacy-receipts-token-00000";

let server: Server | null = null;
let port = 0;
let home = "";
let prevHome: string | undefined;

beforeEach(() => {
  // Redirect PATCHWORK_HOME rather than spying on a module: the reader imports
  // `patchworkPath` by name, and a namespace spy would silently miss it and
  // let the test read the REAL ledger.
  home = mkdtempSync(path.join(tmpdir(), "pw-receipts-route-"));
  prevHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
});

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function writeLedger(rows: Record<string, unknown>[]): void {
  writeFileSync(
    path.join(home, "boundary_receipts.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

function get(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: p,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function start(): Promise<void> {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq: 1,
  at: 1_000,
  decision: "ALLOW",
  classification: "internal",
  destinationId: "remote-model",
  destinationType: "remote",
  reason: "cleared",
  ...over,
});

describe("GET /privacy/receipts", () => {
  it("serves the real denominator, not the 500-row in-memory cap", async () => {
    // The property the whole reader exists for. `BoundaryReceiptLog` trims to
    // 500 on load and on every write, so an endpoint built on `.summary()`
    // would serve 500 here and present it as a total.
    writeLedger(
      Array.from({ length: 620 }, (_, i) =>
        row({
          seq: i + 1,
          at: 1_000 + i,
          decision: i % 10 === 0 ? "DENY" : "ALLOW",
        }),
      ),
    );
    await start();
    const res = await get("/privacy/receipts");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { recorded: number; refusals: number };
    expect(body.recorded).toBe(620);
    expect(body.refusals).toBe(62);
  });

  it("reports an absent ledger as recorded=0 rather than failing", async () => {
    await start();
    const res = await get("/privacy/receipts");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      recorded: number;
      refusals: number;
      recent: unknown[];
    };
    expect(body.recorded).toBe(0);
    expect(body.recent).toEqual([]);
  });

  it("honours sinceMs", async () => {
    writeLedger([
      row({ seq: 1, at: 1_000 }),
      row({ seq: 2, at: 9_000, decision: "DENY" }),
    ]);
    await start();
    const body = JSON.parse(
      (await get("/privacy/receipts?sinceMs=5000")).body,
    ) as {
      recorded: number;
      refusals: number;
      since: number;
    };
    expect(body.recorded).toBe(1);
    expect(body.refusals).toBe(1);
    // Echoed back so a windowed answer cannot be mistaken for the whole ledger.
    expect(body.since).toBe(5_000);
  });

  it("never serves a payload, even if one is on disk", async () => {
    writeLedger([row({ seq: 1, decision: "DENY", prompt: "SECRET-PAYLOAD" })]);
    await start();
    const res = await get("/privacy/receipts");
    expect(res.body).not.toContain("SECRET-PAYLOAD");
  });

  it("requires auth like every other bridge route", async () => {
    await start();
    const unauth = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "GET",
          path: "/privacy/receipts",
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(unauth).toBe(401);
  });
});

/**
 * `?run=<taskId>` — "what did this run send where", for a run-detail page.
 *
 * Rows carry `correlationId` (the run's `taskId`) from `rv >= 1`. Rows that
 * pre-date it have none, and that absence is never filled in on read.
 */
describe("GET /privacy/receipts?run=<taskId>", () => {
  type Body = {
    recorded: number;
    refusals: number;
    byDecision: Record<string, number>;
    byDestination: Record<string, number>;
    byClassification: Record<string, number>;
    refusalsByRecipe: Record<string, number>;
    refusalsUnattributed: number;
    earliest?: number;
    latest?: number;
    unreadableLines: number;
    truncated: boolean;
    scope?: { run: string };
    recent: Record<string, unknown>[];
  };

  const mixed = (): Record<string, unknown>[] => [
    // Legacy: no rv, no correlationId.
    row({ seq: 1, at: 1_000, recipeName: "noisy-recipe" }),
    row({
      seq: 2,
      at: 2_000,
      rv: 1,
      correlationId: "task-0001",
      recipeName: "noisy-recipe",
    }),
    row({
      seq: 3,
      at: 3_000,
      rv: 1,
      correlationId: "task-0002",
      decision: "DENY",
      destinationId: "other-model",
      recipeName: "quiet-recipe",
    }),
    row({
      seq: 4,
      at: 4_000,
      rv: 1,
      correlationId: "task-0001",
      decision: "LOCAL_ONLY",
      classification: "personal",
      recipeName: "noisy-recipe",
    }),
  ];

  it("returns only that run's rows", async () => {
    writeLedger(mixed());
    await start();
    const res = await get("/privacy/receipts?run=task-0001");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Body;
    expect(body.recent.map((r) => r.seq)).toEqual([4, 2]);
    expect(body.recent.every((r) => r.correlationId === "task-0001")).toBe(
      true,
    );
  });

  it("describes the filtered set in the summary, and says so", async () => {
    writeLedger(mixed());
    await start();
    const body = JSON.parse(
      (await get("/privacy/receipts?run=task-0001")).body,
    ) as Body;
    expect(body.scope).toEqual({ run: "task-0001" });
    expect(body.recorded).toBe(2);
    expect(body.refusals).toBe(1);
    expect(body.byDecision).toEqual({ ALLOW: 1, LOCAL_ONLY: 1 });
    expect(body.byDestination).toEqual({ "remote-model": 2 });
    expect(body.byClassification).toEqual({ internal: 1, personal: 1 });
    expect(body.refusalsByRecipe).toEqual({ "noisy-recipe": 1 });
    expect(body.refusalsUnattributed).toBe(0);
    expect(body.earliest).toBe(2_000);
    expect(body.latest).toBe(4_000);
  });

  it("a run with no receipts is an empty, scoped answer, not the whole ledger", async () => {
    writeLedger(mixed());
    await start();
    const body = JSON.parse(
      (await get("/privacy/receipts?run=task-9999")).body,
    ) as Body;
    expect(body.scope).toEqual({ run: "task-9999" });
    expect(body.recorded).toBe(0);
    expect(body.recent).toEqual([]);
  });

  it("excludes legacy rows from a filtered query and never invents a correlationId", async () => {
    writeLedger(mixed());
    await start();
    const filtered = JSON.parse(
      (await get("/privacy/receipts?run=task-0001")).body,
    ) as Body;
    expect(filtered.recent.some((r) => r.seq === 1)).toBe(false);

    const all = JSON.parse((await get("/privacy/receipts")).body) as Body;
    const legacy = all.recent.find((r) => r.seq === 1);
    expect(legacy).toBeDefined();
    expect(legacy && "correlationId" in legacy).toBe(false);
    expect(all.recent.find((r) => r.seq === 2)?.correlationId).toBe(
      "task-0001",
    );
  });

  it.each([
    ["empty", "/privacy/receipts?run="],
    ["too long", `/privacy/receipts?run=${"a".repeat(129)}`],
    ["control character", "/privacy/receipts?run=task%0A0001"],
    ["NUL", "/privacy/receipts?run=task%000001"],
    ["DEL", "/privacy/receipts?run=task%7F0001"],
  ])("rejects an invalid run (%s) with 400", async (_label, p) => {
    writeLedger(mixed());
    await start();
    const res = await get(p);
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/run/);
  });

  it("accepts a run id of exactly 128 characters", async () => {
    writeLedger(mixed());
    await start();
    const res = await get(`/privacy/receipts?run=${"a".repeat(128)}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Body;
    expect(body.scope).toEqual({ run: "a".repeat(128) });
  });

  it("without `run`, the output is exactly what it was before the filter existed", async () => {
    writeLedger(mixed());
    await start();
    const body = JSON.parse((await get("/privacy/receipts")).body) as Body;
    expect(body).toEqual({
      recorded: 4,
      refusals: 2,
      byDecision: { ALLOW: 2, DENY: 1, LOCAL_ONLY: 1 },
      byDestination: { "remote-model": 3, "other-model": 1 },
      byClassification: { internal: 3, personal: 1 },
      refusalsByRecipe: { "noisy-recipe": 1, "quiet-recipe": 1 },
      refusalsUnattributed: 0,
      earliest: 1_000,
      latest: 4_000,
      unreadableLines: 0,
      truncated: false,
      recent: [
        {
          seq: 4,
          rv: 1,
          correlationId: "task-0001",
          at: 4_000,
          decision: "LOCAL_ONLY",
          classification: "personal",
          destinationId: "remote-model",
          destinationType: "remote",
          reason: "cleared",
          recipeName: "noisy-recipe",
        },
        {
          seq: 3,
          rv: 1,
          correlationId: "task-0002",
          at: 3_000,
          decision: "DENY",
          classification: "internal",
          destinationId: "other-model",
          destinationType: "remote",
          reason: "cleared",
          recipeName: "quiet-recipe",
        },
        {
          seq: 2,
          rv: 1,
          correlationId: "task-0001",
          at: 2_000,
          decision: "ALLOW",
          classification: "internal",
          destinationId: "remote-model",
          destinationType: "remote",
          reason: "cleared",
          recipeName: "noisy-recipe",
        },
        {
          seq: 1,
          at: 1_000,
          decision: "ALLOW",
          classification: "internal",
          destinationId: "remote-model",
          destinationType: "remote",
          reason: "cleared",
          recipeName: "noisy-recipe",
        },
      ],
    });
    expect("scope" in body).toBe(false);
  });

  it("a chained ledger's marker rows are never receipts and never counted", async () => {
    // Legacy prefix first, then real chained appends: the writer stamps a
    // chain-start marker that commits to the prefix.
    writeLedger([row({ seq: 1, at: 1_000 })]);
    const log = new BoundaryReceiptLog({ dir: home });
    for (const correlationId of ["task-0001", "task-0002", "task-0001"]) {
      log.record({
        decision: "ALLOW",
        classification: "internal",
        destinationId: "remote-model",
        destinationType: "remote",
        reason: "cleared",
        correlationId,
      });
    }
    // Guard against a vacuous pass: the file must really contain a marker.
    const onDisk = readFileSync(
      path.join(home, "boundary_receipts.jsonl"),
      "utf-8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind?: string });
    expect(onDisk.some((r) => r.kind === "chain-start")).toBe(true);
    await start();
    const body = JSON.parse(
      (await get("/privacy/receipts?run=task-0001")).body,
    ) as Body;
    expect(body.recorded).toBe(2);
    expect(body.unreadableLines).toBe(0);
    expect(body.recent).toHaveLength(2);
    expect(body.recent.every((r) => !("kind" in r))).toBe(true);
    expect(body.scope).toEqual({ run: "task-0001" });

    const all = JSON.parse((await get("/privacy/receipts")).body) as Body;
    expect(all.recorded).toBe(4);
    expect(all.unreadableLines).toBe(0);
  });
});
