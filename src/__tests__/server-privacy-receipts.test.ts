/**
 * Integration test for GET /privacy/receipts.
 *
 * The endpoint half of making the ADR-0021 enforcement ledger readable from
 * the open runtime. Until it existed, the only reader of
 * `boundary_receipts.jsonl` in the whole workspace lived in the separate
 * non-MIT control plane — the condition ADR-0019:88-92 forbids.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
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
