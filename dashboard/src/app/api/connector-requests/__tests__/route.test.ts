/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../route";

// connector-requests writes to ~/.patchwork/connector-requests.json. We
// redirect HOME via os.homedir() spy and use a fresh temp dir per test
// so cases don't see each other's writes.

let tmpHome: string;
let storeFile: string;

function makeReq(
  body: unknown,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Request {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
  return new Request("https://dashboard.local/api/connector-requests", init);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "connreq-test-"));
  storeFile = path.join(tmpHome, ".patchwork", "connector-requests.json");
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("POST /api/connector-requests — CSRF guard", () => {
  it("rejects sec-fetch-site=cross-site with 403", async () => {
    const res = await POST(
      makeReq({ name: "x" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows sec-fetch-site=same-origin", async () => {
    const res = await POST(
      makeReq({ name: "ok" }, { "sec-fetch-site": "same-origin" }),
    );
    expect(res.status).toBe(200);
  });

  it("allows sec-fetch-site=none (direct address-bar navigation)", async () => {
    const res = await POST(
      makeReq({ name: "ok" }, { "sec-fetch-site": "none" }),
    );
    expect(res.status).toBe(200);
  });

  it("allows requests with no sec-fetch-site header (server-to-server)", async () => {
    const res = await POST(makeReq({ name: "ok" }, {}));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/connector-requests — body validation", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(
      makeReq("{not json", { "sec-fetch-site": "same-origin" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid JSON" });
  });

  it("400s on non-object body (array, string, number, null)", async () => {
    for (const body of [[1, 2], "hello", 42, null]) {
      const res = await POST(makeReq(body));
      expect(res.status).toBe(400);
    }
  });

  it("400s when name is missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "name is required" });
  });

  it("400s when name is an empty / whitespace-only string", async () => {
    for (const name of ["", "   ", "\t\n"]) {
      const res = await POST(makeReq({ name }));
      expect(res.status).toBe(400);
    }
  });

  it("400s when name is not a string", async () => {
    const res = await POST(makeReq({ name: 7 }));
    expect(res.status).toBe(400);
  });

  it("400s when name is longer than 100 chars", async () => {
    const res = await POST(makeReq({ name: "x".repeat(101) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("100"),
    });
  });

  it("400s when notes is non-string (number, boolean, object)", async () => {
    for (const notes of [7, true, { a: 1 }]) {
      const res = await POST(makeReq({ name: "ok", notes }));
      expect(res.status).toBe(400);
    }
  });

  it("400s when notes is longer than 500 chars", async () => {
    const res = await POST(makeReq({ name: "ok", notes: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });

  it("accepts notes=null and notes=undefined as 'no notes'", async () => {
    const a = await POST(makeReq({ name: "ok", notes: null }));
    expect(a.status).toBe(200);
    const b = await POST(makeReq({ name: "ok2" }));
    expect(b.status).toBe(200);
  });
});

describe("POST /api/connector-requests — persistence", () => {
  it("writes a fresh file when none exists", async () => {
    const res = await POST(makeReq({ name: "  Asana  ", notes: "  pls  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      name: string;
      notes?: string;
      requestedAt: string;
    }[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.name).toBe("Asana");
    expect(persisted[0]!.notes).toBe("pls");
    expect(persisted[0]!.requestedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("omits notes from the persisted record when notes is empty/whitespace", async () => {
    await POST(makeReq({ name: "Asana", notes: "   " }));
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    expect(persisted[0]).not.toHaveProperty("notes");
  });

  it("appends to an existing array", async () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(
      storeFile,
      JSON.stringify([
        { name: "First", requestedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );

    await POST(makeReq({ name: "Second" }));

    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      name: string;
    }[];
    expect(persisted.map((r) => r.name)).toEqual(["First", "Second"]);
  });

  it("500s with a fix-or-delete message when the file is malformed JSON", async () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, "{not json");

    const res = await POST(makeReq({ name: "x" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/malformed/);
  });

  it("500s when the file is valid JSON but not an array", async () => {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ entries: [] }));

    const res = await POST(makeReq({ name: "x" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/expected an array/);
  });

  it("500s with 'Failed to save request' on write error (with console.error)", async () => {
    // Force fs.writeFileSync to throw.
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeReq({ name: "x" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to save request");
    expect(errSpy).toHaveBeenCalled();

    writeSpy.mockRestore();
    errSpy.mockRestore();
  });
});
