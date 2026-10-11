/**
 * Integration test for GET /evidence/ledgers and GET /evidence/ledger.
 *
 * The download half of `patchwork evidence verify`: an operator whose
 * workspace is not on their own machine still has to be able to take the
 * chained ledgers away and verify them offline. That only works if the bytes
 * served are the bytes on disk — a re-serialised file would fail its own
 * chain, or worse, pass a chain that was never written.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERIFIED_LEDGERS, verifyEvidenceChains } from "../evidenceVerify.js";
import { appendChained, chainSidecarPaths } from "../ledgerChain.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-evidence-ledgers-token-00000";

let server: Server | null = null;
let port = 0;
let home = "";
let prevHome: string | undefined;
const cleanup: string[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "pw-evidence-route-"));
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
  for (const d of cleanup.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function get(
  p: string,
  auth = true,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: p,
        headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
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

const enc = encodeURIComponent;

describe("GET /evidence/ledgers", () => {
  it("lists every verified ledger, reporting an absent one as absent", async () => {
    appendChained(path.join(home, "boundary_receipts.jsonl"), {
      decision: "ALLOW",
    });
    await start();
    const r = await get("/evidence/ledgers");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body.toString("utf8"));
    expect(body.ledgers.map((l: { file: string }) => l.file)).toEqual(
      VERIFIED_LEDGERS.map((l) => l.file),
    );
    const receipts = body.ledgers.find(
      (l: { file: string }) => l.file === "boundary_receipts.jsonl",
    );
    expect(receipts.present).toBe(true);
    expect(receipts.bytes).toBeGreaterThan(0);
    expect(receipts.files).toContain("boundary_receipts.jsonl");
    const gate = body.ledgers.find(
      (l: { file: string }) => l.file === "worker_gate_decisions.jsonl",
    );
    expect(gate.present).toBe(false);
    expect(gate.files).toEqual([]);
  });

  it("requires the bearer token", async () => {
    await start();
    expect((await get("/evidence/ledgers", false)).status).toBe(401);
  });
});

describe("GET /evidence/ledger", () => {
  it("serves the exact bytes on disk, as a download", async () => {
    // Non-ASCII and no trailing newline: a decode/re-encode or a line-based
    // reader would change these bytes.
    const bytes = Buffer.from('{"note":"café ✓"}\n{"note":"tail"}', "utf8");
    writeFileSync(path.join(home, "boundary_receipts.jsonl"), bytes);
    await start();
    const r = await get(
      `/evidence/ledger?file=${enc("boundary_receipts.jsonl")}`,
    );
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, bytes)).toBe(0);
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-disposition"]).toBe(
      'attachment; filename="boundary_receipts.jsonl"',
    );
  });

  it("serves a ledger's chain sidecars", async () => {
    const file = path.join(home, "approval_log.jsonl");
    appendChained(file, { kind: "request" });
    const { head } = chainSidecarPaths(file);
    await start();
    const r = await get(
      `/evidence/ledger?file=${enc("approval_log.jsonl.head")}`,
    );
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body, readFileSync(head))).toBe(0);
  });

  it("serves a ledger in a subdirectory by its listed name", async () => {
    mkdirSync(path.join(home, "butler"), { recursive: true });
    writeFileSync(path.join(home, "butler/permission_exercises.jsonl"), "{}\n");
    await start();
    const r = await get(
      `/evidence/ledger?file=${enc("butler/permission_exercises.jsonl")}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.toString("utf8")).toBe("{}\n");
    expect(r.headers["content-disposition"]).toBe(
      'attachment; filename="permission_exercises.jsonl"',
    );
  });

  it("refuses anything that is not a verified ledger or its sidecar", async () => {
    writeFileSync(path.join(home, "runs.jsonl"), "{}\n");
    writeFileSync(path.join(home, "boundary_receipts.jsonl.1"), "{}\n");
    await start();
    for (const f of [
      "runs.jsonl",
      "boundary_receipts.jsonl.1",
      "../boundary_receipts.jsonl",
      "/etc/passwd",
      "boundary_receipts.jsonl/../runs.jsonl",
      "config.json",
      "",
    ]) {
      const r = await get(`/evidence/ledger?file=${enc(f)}`);
      expect(r.status, f).toBe(400);
    }
    expect((await get("/evidence/ledger")).status).toBe(400);
  });

  it("answers 404 for a listed ledger that does not exist", async () => {
    await start();
    const r = await get(`/evidence/ledger?file=${enc("pr_outcomes.jsonl")}`);
    expect(r.status).toBe(404);
  });

  it("requires the bearer token", async () => {
    writeFileSync(path.join(home, "boundary_receipts.jsonl"), "{}\n");
    await start();
    const r = await get(
      `/evidence/ledger?file=${enc("boundary_receipts.jsonl")}`,
      false,
    );
    expect(r.status).toBe(401);
  });

  it("a full download verifies offline exactly as the live directory does", async () => {
    for (let i = 0; i < 3; i++) {
      appendChained(path.join(home, "boundary_receipts.jsonl"), { i });
      appendChained(path.join(home, "approval_log.jsonl"), { i });
    }
    await start();
    const out = mkdtempSync(path.join(tmpdir(), "pw-evidence-download-"));
    cleanup.push(out);
    const list = JSON.parse(
      (await get("/evidence/ledgers")).body.toString("utf8"),
    );
    for (const l of list.ledgers as Array<{ files: string[] }>) {
      for (const f of l.files) {
        const r = await get(`/evidence/ledger?file=${enc(f)}`);
        expect(r.status).toBe(200);
        mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
        writeFileSync(path.join(out, f), r.body);
      }
    }
    const live = verifyEvidenceChains(home);
    const offline = verifyEvidenceChains(out);
    expect(offline.ok).toBe(true);
    expect(offline.ok).toBe(live.ok);
    expect(
      offline.ledgers.map((l) => [l.file, l.ok, l.chainedRows, l.lastIseq]),
    ).toEqual(
      live.ledgers.map((l) => [l.file, l.ok, l.chainedRows, l.lastIseq]),
    );
  });
});
