/**
 * Verifies the GET handler added to /api/connector-requests. Pairs
 * with the existing POST suite (route.test.ts) — together they lock
 * the full write-then-read contract that closes the plumbing-audit
 * gap.
 *
 * Each test scopes HOME to a fresh tmpdir so the on-disk
 * ~/.patchwork/connector-requests.json doesn't leak state between
 * tests or read the user's real file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;
let originalHomedir: typeof os.homedir;

async function callGet() {
  const mod = await import("../route");
  return mod.GET();
}

describe("GET /api/connector-requests", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pw-connreq-"));
    originalHomedir = os.homedir;
    // Both the route handler and this test use os.homedir() to resolve
    // ~/.patchwork — patch it so the GET reads from our scratch dir.
    (os as { homedir: () => string }).homedir = () => tmpHome;
    // Force route module re-evaluation so any cached imports stay clean
    // across tests. Vitest re-imports per test file by default; this
    // is belt-and-suspenders.
    vi.resetModules();
  });

  afterEach(() => {
    (os as { homedir: () => string }).homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns an empty list when the file does not exist", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown };
    expect(body.requests).toEqual([]);
  });

  it("returns saved requests sorted newest-first", async () => {
    const dir = path.join(tmpHome, ".patchwork");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "connector-requests.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { name: "Older", requestedAt: "2026-01-01T00:00:00Z" },
        { name: "Newest", requestedAt: "2026-05-12T10:00:00Z" },
        { name: "Middle", notes: "with notes", requestedAt: "2026-03-15T00:00:00Z" },
      ]),
    );
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<{ name: string }> };
    expect(body.requests.map((r) => r.name)).toEqual(["Newest", "Middle", "Older"]);
  });

  it("caps the response at 50 entries", async () => {
    const dir = path.join(tmpHome, ".patchwork");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "connector-requests.json");
    const many = Array.from({ length: 75 }, (_, i) => ({
      name: `Req-${i}`,
      requestedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));
    fs.writeFileSync(file, JSON.stringify(many));
    const res = await callGet();
    const body = (await res.json()) as { requests: Array<{ name: string }> };
    expect(body.requests.length).toBe(50);
  });

  it("returns 500 when the file is malformed JSON", async () => {
    const dir = path.join(tmpHome, ".patchwork");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "connector-requests.json"), "not json");
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/i);
  });

  it("returns 500 when the file is JSON but not an array", async () => {
    const dir = path.join(tmpHome, ".patchwork");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "connector-requests.json"),
      JSON.stringify({ requests: [] }),
    );
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unexpected format/i);
  });
});
