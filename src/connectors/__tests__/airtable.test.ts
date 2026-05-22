import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Fetch mock helper ──────────────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };

function installFetchMock(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return responder(u, init);
  });
  // @ts-expect-error — override global fetch
  globalThis.fetch = fn;
  return { calls, fn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Test harness ───────────────────────────────────────────────────────────

const tmpDir = join(os.tmpdir(), `patchwork-airtable-${Date.now()}`);
const homeDir = join(tmpDir, "home");
const patchworkHome = join(homeDir, ".patchwork");
const tokensDir = join(patchworkHome, "tokens");

beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATCHWORK_HOME = patchworkHome;
  process.env.PATCHWORK_TOKEN_STORAGE_BACKEND = "file";
  delete process.env.AIRTABLE_ACCESS_TOKEN;
  mkdirSync(tokensDir, { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATCHWORK_HOME;
  delete process.env.PATCHWORK_TOKEN_STORAGE_BACKEND;
  delete process.env.AIRTABLE_ACCESS_TOKEN;
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── normalizeError ─────────────────────────────────────────────────────────

describe("normalizeError", () => {
  it("maps HTTP status codes from Response", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(401)).code).toBe("auth_expired");
    expect(c.normalizeError(make(403)).code).toBe("permission_denied");
    expect(c.normalizeError(make(404)).code).toBe("not_found");
    expect(c.normalizeError(make(422)).code).toBe("provider_error");
    expect(c.normalizeError(make(429)).code).toBe("rate_limited");
    expect(c.normalizeError(make(500)).code).toBe("provider_error");
  });

  it("marks 429 + 5xx retryable; 4xx non-retryable", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    const make = (status: number) => new Response(null, { status });
    expect(c.normalizeError(make(429)).retryable).toBe(true);
    expect(c.normalizeError(make(503)).retryable).toBe(true);
    expect(c.normalizeError(make(401)).retryable).toBe(false);
    expect(c.normalizeError(make(403)).retryable).toBe(false);
    expect(c.normalizeError(make(404)).retryable).toBe(false);
    expect(c.normalizeError(make(422)).retryable).toBe(false);
  });

  it("detects ENOTFOUND/ECONNREFUSED as network_error", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    expect(c.normalizeError(new Error("getaddrinfo ENOTFOUND x")).code).toBe(
      "network_error",
    );
    expect(c.normalizeError(new Error("ECONNREFUSED")).code).toBe(
      "network_error",
    );
  });

  it("defaults to provider_error", async () => {
    const { AirtableConnector } = await import("../airtable.js");
    const c = new AirtableConnector();
    expect(c.normalizeError(new Error("boom")).code).toBe("provider_error");
    expect(c.normalizeError("plain string").code).toBe("provider_error");
  });
});

// ── listRecords URL encoding + maxRecords cap ──────────────────────────────

describe("listRecords", () => {
  it("URL-encodes filterByFormula and caps maxRecords at 1000", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({ records: [], offset: undefined }),
    );

    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks", {
      filterByFormula: "AND({Status}='Open', {Name}='A&B')",
      maxRecords: 5000, // should be capped at 1000
    });

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url).toContain("/v0/appXYZ/Tasks?");
    expect(url).toContain("maxRecords=1000");
    // URLSearchParams encodes — verify the raw formula is NOT present
    expect(url).not.toContain("{Status}='Open'");
    // Verify the encoded form is present
    expect(url).toMatch(/filterByFormula=AND/);
    expect(url).toContain("%7BStatus%7D"); // {Status} encoded
    expect(url).toContain("%26"); // & encoded
  });

  it("defaults maxRecords to 100 when omitted", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks");
    expect(calls[0]!.url).toContain("maxRecords=100");
  });

  it("encodes baseId and table name with special chars", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "My Table/With Slash");
    expect(calls[0]!.url).toContain("My%20Table%2FWith%20Slash");
  });

  it("serialises sort and fields params", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await c.listRecords("appXYZ", "Tasks", {
      sort: [{ field: "Name", direction: "desc" }],
      fields: ["Name", "Status"],
      view: "Grid view",
    });
    const url = calls[0]!.url;
    expect(url).toMatch(/sort%5B0%5D%5Bfield%5D=Name/);
    expect(url).toMatch(/sort%5B0%5D%5Bdirection%5D=desc/);
    expect(url).toMatch(/fields%5B%5D=Name/);
    expect(url).toMatch(/fields%5B%5D=Status/);
    expect(url).toMatch(/view=Grid\+view|view=Grid%20view/);
  });
});

// ── createRecord wraps fields in records array ─────────────────────────────

describe("createRecord", () => {
  it("POSTs JSON with { records: [{ fields }] } shape", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");

    const { calls } = installFetchMock(() =>
      jsonResponse({
        records: [
          {
            id: "recNEW1",
            createdTime: "2026-01-01T00:00:00.000Z",
            fields: { Name: "Hello" },
          },
        ],
      }),
    );

    const c = getAirtableConnector();
    const out = await c.createRecord("appXYZ", "Tasks", { Name: "Hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ records: [{ fields: { Name: "Hello" } }] });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer pat_test_abc");
    expect(out.id).toBe("recNEW1");
  });

  it("throws when Airtable returns empty records array", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    installFetchMock(() => jsonResponse({ records: [] }));
    const c = getAirtableConnector();
    await expect(c.createRecord("appXYZ", "Tasks", {})).rejects.toThrow(
      /no record/i,
    );
  });
});

// ── updateRecord ───────────────────────────────────────────────────────────

describe("updateRecord", () => {
  it("PATCHes with { fields } body (no records wrapper)", async () => {
    process.env.AIRTABLE_ACCESS_TOKEN = "pat_test_abc";
    const { getAirtableConnector } = await import("../airtable.js");
    const { calls } = installFetchMock(() =>
      jsonResponse({
        id: "rec1",
        createdTime: "2026-01-01T00:00:00.000Z",
        fields: { Status: "Done" },
      }),
    );
    const c = getAirtableConnector();
    const out = await c.updateRecord("appXYZ", "Tasks", "rec1", {
      Status: "Done",
    });
    expect(calls[0]!.init?.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ fields: { Status: "Done" } });
    expect(out.fields.Status).toBe("Done");
  });
});

// ── Connect handler captures user id + email ───────────────────────────────

describe("handleAirtableConnect", () => {
  it("rejects invalid JSON", async () => {
    const { handleAirtableConnect } = await import("../airtable.js");
    const r = await handleAirtableConnect("not json");
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/Invalid JSON/);
  });

  it("requires accessToken field", async () => {
    const { handleAirtableConnect } = await import("../airtable.js");
    const r = await handleAirtableConnect(JSON.stringify({}));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/accessToken is required/);
  });

  it("validates via /v0/meta/whoami and captures user id + email", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );

    const { calls } = installFetchMock(() =>
      jsonResponse({ id: "usrAAA", email: "user@example.com" }),
    );

    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patABC123" }),
    );

    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe("https://api.airtable.com/v0/meta/whoami");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer patABC123");

    const body = JSON.parse(r.body) as {
      ok: boolean;
      userId?: string;
      email?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("usrAAA");
    expect(body.email).toBe("user@example.com");

    const stored = loadTokens();
    expect(stored?.userId).toBe("usrAAA");
    expect(stored?.email).toBe("user@example.com");
    expect(stored?.accessToken).toBe("patABC123");
  });

  it("captures user id when email scope absent", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );
    installFetchMock(() => jsonResponse({ id: "usrBBB" })); // no email
    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patXYZ" }),
    );
    expect(r.status).toBe(200);
    const stored = loadTokens();
    expect(stored?.userId).toBe("usrBBB");
    expect(stored?.email).toBeUndefined();
  });

  it("returns 401 when Airtable rejects token, without persisting", async () => {
    const { handleAirtableConnect, loadTokens } = await import(
      "../airtable.js"
    );
    installFetchMock(() => new Response("nope", { status: 401 }));
    const r = await handleAirtableConnect(
      JSON.stringify({ accessToken: "patBAD" }),
    );
    expect(r.status).toBe(401);
    expect(loadTokens()).toBeNull();
  });
});

// ── Disconnect ─────────────────────────────────────────────────────────────

describe("handleAirtableDisconnect", () => {
  it("clears stored tokens", async () => {
    const { handleAirtableDisconnect, saveTokens, loadTokens } = await import(
      "../airtable.js"
    );
    saveTokens({
      accessToken: "patABC",
      connected_at: new Date().toISOString(),
    });
    expect(loadTokens()).not.toBeNull();
    const r = handleAirtableDisconnect();
    expect(r.status).toBe(200);
    expect(loadTokens()).toBeNull();
  });
});

// ── getStatus ──────────────────────────────────────────────────────────────

describe("getStatus", () => {
  it("returns disconnected when no tokens", async () => {
    const { getAirtableConnector } = await import("../airtable.js");
    const s = getAirtableConnector().getStatus();
    expect(s.status).toBe("disconnected");
  });

  it("returns connected + workspace label from email", async () => {
    const { getAirtableConnector, saveTokens } = await import("../airtable.js");
    saveTokens({
      accessToken: "patABC",
      userId: "usrAAA",
      email: "u@x.com",
      connected_at: new Date().toISOString(),
    });
    const s = getAirtableConnector().getStatus();
    expect(s.status).toBe("connected");
    expect(s.workspace).toContain("u@x.com");
  });
});
