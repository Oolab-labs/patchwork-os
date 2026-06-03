/**
 * Tests for `patchwork connect` — the connector front-door CLI.
 *
 * `runConnect` is a thin CLI→HTTP shim over already-built bridge
 * `/connections/*` routes. These tests inject a fake `findBridgeLock`
 * (so no real lock file is read) and a fake `fetchFn` (so no real HTTP
 * is made), plus capture-only `write`/`writeErr`/`exit` seams so the
 * test process is never torn down by `process.exit`.
 *
 * Bug Fix Protocol: written before `runConnect` exists.
 */

import { describe, expect, it, vi } from "vitest";
import type { ConnectorDescriptor } from "../../connectors/connectorRegistry.js";
import { type ConnectDeps, runConnect } from "../connect.js";

// ── test harness ──────────────────────────────────────────────────────────────

const FAKE_LOCK = { port: 1234, authToken: "t" };

const TEST_CONNECTORS: readonly ConnectorDescriptor[] = [
  {
    id: "gmail",
    label: "Gmail",
    authKind: "oauth",
    supports: { auth: true, test: true, delete: true },
  },
  {
    id: "notion",
    label: "Notion",
    authKind: "pat",
    supports: { auth: true, connect: true, test: true, delete: true },
  },
  {
    id: "caldiy",
    label: "Cal.diy",
    authKind: "pat",
    supports: { connect: true, test: true, delete: true },
  },
];

interface Capture {
  out: string;
  err: string;
  code: number | null;
}

interface HarnessResult {
  capture: Capture;
  fetchFn: ReturnType<typeof vi.fn>;
}

/** Build deps with capture seams + a scripted fetch. */
function makeDeps(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<ConnectDeps> = {},
): { deps: ConnectDeps; result: HarnessResult } {
  const capture: Capture = { out: "", err: "", code: null };
  const fetchFn = vi.fn(fetchImpl);
  const deps: ConnectDeps = {
    findBridgeLock: () => FAKE_LOCK,
    fetchFn: fetchFn as unknown as ConnectDeps["fetchFn"],
    connectors: TEST_CONNECTORS,
    write: (s: string) => {
      capture.out += s;
    },
    writeErr: (s: string) => {
      capture.err += s;
    },
    exit: (c: number) => {
      capture.code = c;
    },
    ...overrides,
  };
  return { deps, result: { capture, fetchFn } };
}

/** Minimal Response stub for JSON bodies. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Minimal Response stub for a 302 redirect with a Location header. */
function redirectResponse(location: string): Response {
  return {
    status: 302,
    ok: false,
    headers: new Headers({ location }),
    text: async () => "",
  } as unknown as Response;
}

// ── list ──────────────────────────────────────────────────────────────────────

describe("patchwork connect list", () => {
  it("joins live status with registry label + authKind", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, {
        connectors: [
          { id: "gmail", status: "connected" },
          { id: "notion", status: "needs_reauth" },
          // caldiy absent from the live response → treated as disconnected
        ],
      }),
    );
    await runConnect(["list"], deps);

    const { fetchFn, capture } = result;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/connections");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer t",
    );

    // Every registry connector is listed with its label.
    expect(capture.out).toContain("Gmail");
    expect(capture.out).toContain("Notion");
    expect(capture.out).toContain("Cal.diy");
    // Status surfaced from the live response.
    expect(capture.out.toLowerCase()).toContain("connected");
    expect(capture.out.toLowerCase()).toContain("reauth");
    expect(capture.code === null || capture.code === 0).toBe(true);
  });

  it("emits machine-readable JSON with --json", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, {
        connectors: [{ id: "gmail", status: "connected" }],
      }),
    );
    await runConnect(["list", "--json"], deps);

    const parsed = JSON.parse(result.capture.out) as {
      connectors: Array<{ id: string; status: string; label: string }>;
    };
    const gmail = parsed.connectors.find((c) => c.id === "gmail");
    expect(gmail?.status).toBe("connected");
    expect(gmail?.label).toBe("Gmail");
  });

  it("bare `connect` with no args lists connectors", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { connectors: [{ id: "gmail", status: "connected" }] }),
    );
    await runConnect([], deps);
    expect(result.fetchFn).toHaveBeenCalledTimes(1);
    expect(result.capture.out).toContain("Gmail");
  });
});

// ── OAuth ──────────────────────────────────────────────────────────────────────

describe("patchwork connect <oauth-vendor>", () => {
  it("captures the 302 Location and prints the authorize URL", async () => {
    const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?x=1";
    const { deps, result } = makeDeps(async () =>
      redirectResponse(authorizeUrl),
    );
    await runConnect(["gmail"], deps);

    const [url, init] = result.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/connections/gmail/auth");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer t",
    );
    // The URL the user should open is surfaced to stdout.
    expect(result.capture.out).toContain(authorizeUrl);
    expect(result.capture.out).toContain("Gmail");
  });

  it("--url-only prints ONLY the authorize URL", async () => {
    const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?x=2";
    const { deps, result } = makeDeps(async () =>
      redirectResponse(authorizeUrl),
    );
    await runConnect(["gmail", "--url-only"], deps);
    expect(result.capture.out.trim()).toBe(authorizeUrl);
  });

  it("errors clearly when no Location header is returned", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(503, { error: "not configured" }),
    );
    await runConnect(["gmail"], deps);
    expect(result.capture.err.length).toBeGreaterThan(0);
    expect(result.capture.code).toBe(1);
  });
});

// ── PAT ────────────────────────────────────────────────────────────────────────

describe("patchwork connect <pat-vendor>", () => {
  it("POSTs {token} to /connect when --token is provided", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { ok: true, workspace: "Acme" }),
    );
    await runConnect(["notion", "--token", "secret_abc"], deps);

    const [url, init] = result.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/connections/notion/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "secret_abc" });
    expect(result.capture.out).toContain("Notion");
    expect(result.capture.code === null || result.capture.code === 0).toBe(
      true,
    );
  });

  it("reports failure (nonzero exit) when /connect rejects the token", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(401, { ok: false, error: "Token rejected" }),
    );
    await runConnect(["notion", "--token", "bad"], deps);
    expect(result.capture.err).toContain("Token rejected");
    expect(result.capture.code).toBe(1);
  });

  it("prints instructions and does NOT POST when no --token is given", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { ok: true }),
    );
    await runConnect(["notion"], deps);
    expect(result.fetchFn).not.toHaveBeenCalled();
    expect(result.capture.out).toContain("--token");
    // Multi-field connectors are directed to the dashboard.
    expect(result.capture.out.toLowerCase()).toContain("dashboard");
  });
});

// ── test verb ──────────────────────────────────────────────────────────────────

describe("patchwork connect test <vendor>", () => {
  it("POSTs to /test and reports pass", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { ok: true }),
    );
    await runConnect(["test", "gmail"], deps);
    const [url, init] = result.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/connections/gmail/test");
    expect(init.method).toBe("POST");
    expect(result.capture.code === null || result.capture.code === 0).toBe(
      true,
    );
  });

  it("exits nonzero on a failing health probe", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(401, { ok: false, error: "expired" }),
    );
    await runConnect(["test", "gmail"], deps);
    expect(result.capture.err).toContain("expired");
    expect(result.capture.code).toBe(1);
  });
});

// ── disconnect verb ─────────────────────────────────────────────────────────────

describe("patchwork connect disconnect <vendor>", () => {
  it("issues a DELETE and reports success", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { ok: true }),
    );
    await runConnect(["disconnect", "gmail"], deps);
    const [url, init] = result.fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/connections/gmail");
    expect(init.method).toBe("DELETE");
    expect(result.capture.code === null || result.capture.code === 0).toBe(
      true,
    );
  });
});

// ── error paths ─────────────────────────────────────────────────────────────────

describe("patchwork connect error handling", () => {
  it("rejects an unknown vendor with a nonzero exit + suggestion", async () => {
    const { deps, result } = makeDeps(async () =>
      jsonResponse(200, { connectors: [] }),
    );
    await runConnect(["gmial"], deps);
    expect(result.fetchFn).not.toHaveBeenCalled();
    expect(result.capture.err.toLowerCase()).toContain("unknown");
    // Should hint at the closest valid id.
    expect(result.capture.err).toContain("gmail");
    expect(result.capture.code).toBe(1);
  });

  it("prints the start hint and exits nonzero when no bridge is running", async () => {
    const { deps, result } = makeDeps(
      async () => jsonResponse(200, { connectors: [] }),
      { findBridgeLock: () => null },
    );
    await runConnect(["list"], deps);
    expect(result.fetchFn).not.toHaveBeenCalled();
    expect(result.capture.err).toContain("patchwork start");
    expect(result.capture.code).toBe(1);
  });

  it("fails soft on a network error with a readable message", async () => {
    const { deps, result } = makeDeps(async () => {
      throw new Error("ECONNREFUSED");
    });
    await runConnect(["list"], deps);
    expect(result.capture.err).toContain("ECONNREFUSED");
    expect(result.capture.code).toBe(1);
  });
});
