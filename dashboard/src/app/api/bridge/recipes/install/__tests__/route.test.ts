/** @vitest-environment node */
/**
 * Server-side validation tests for /api/bridge/recipes/install.
 *
 * Audit (2026-05-16, post-PR #556) found the proxy forwarded any body to
 * the bridge with no shape check — browser-side assertValidInstallSource
 * was the only defense, easily bypassed by direct POST. The bridge does
 * validate, but the dashboard layer should reject obviously bad input
 * before opening the bridge socket.
 */
import { describe, expect, it, vi } from "vitest";

import { POST } from "../route";

vi.mock("@/lib/demoModeServer", () => ({ isDemoModeServer: () => false }));

const bridgeFetchMock = vi.fn(
  async (_path: string, _init: { body: string; method: string }) =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (path: string, init: { body: string; method: string }) =>
    bridgeFetchMock(path, init),
}));

function makeReq(body: string): Request {
  return new Request("https://dashboard.local/api/bridge/recipes/install", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body,
  });
}

describe("POST /api/bridge/recipes/install — source validation", () => {
  it("rejects non-JSON bodies with 400 / bad_json", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq("not json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_json");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects array bodies with 400 / bad_body_shape", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq("[1,2,3]"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_body_shape");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects bodies missing `source` with 400 / bad_source_type", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq(JSON.stringify({ foo: "bar" })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_source_type");
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-string `source` (number) with 400 / bad_source_type", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(makeReq(JSON.stringify({ source: 42 })));
    expect(res.status).toBe(400);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects opaque non-github sources with 400 / bad_source_shape", async () => {
    bridgeFetchMock.mockClear();
    // Tampered-registry attack: indexes a recipe with an https://attacker.com source.
    const res = await POST(
      makeReq(JSON.stringify({ source: "https://attacker.com/payload.yaml" })),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("bad_source_shape");
    expect(body.error ?? "").toMatch(/github:owner\/repo/i);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects file:// sources with 400 / bad_source_shape", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(JSON.stringify({ source: "file:///etc/passwd" })),
    );
    expect(res.status).toBe(400);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });

  it("forwards a well-formed github: source to the bridge", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(bridgeFetchMock).toHaveBeenCalledTimes(1);
    const call = bridgeFetchMock.mock.calls[0];
    const [path, init] = call as unknown as [string, { body: string }];
    expect(path).toBe("/recipes/install");
    // Body forwarded VERBATIM — re-serialising would mutate ordering and
    // strip whitespace that the bridge's payload signature would care about
    // in a future signed-payload flow.
    expect(init.body).toBe(
      JSON.stringify({
        source: "github:patchworkos/recipes/recipes/morning-brief",
      }),
    );
  });

  it("forwards a github: source with an @ref tag", async () => {
    bridgeFetchMock.mockClear();
    const res = await POST(
      makeReq(
        JSON.stringify({
          source: "github:patchworkos/recipes/recipes/morning-brief@v1.2.0",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(bridgeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/bridge/recipes/install — CSRF gate", () => {
  it("rejects cross-site POST with 403", async () => {
    const req = new Request("https://dashboard.local/api/bridge/recipes/install", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        source: "github:patchworkos/recipes/recipes/morning-brief",
      }),
    });
    bridgeFetchMock.mockClear();
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(bridgeFetchMock).not.toHaveBeenCalled();
  });
});
