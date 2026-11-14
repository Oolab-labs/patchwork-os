/** @vitest-environment node */
/**
 * "Run now" forwards the member's own dashboard session to the bridge as
 * `x-patchwork-session` (ADR-0020 separation of duties). The bridge verifies it
 * and stamps the member on the run's approval requests, so that member cannot
 * approve their own run's gated steps. Without the header the run is started
 * unnamed and no self-approval check can ever apply — an absence that looks
 * exactly like normal operation, which is why it is pinned here.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
  findBridge: () => ({ port: 3101, authToken: "t", workspace: "/w" }),
  resolveBridgeUrl: () => "http://127.0.0.1:3101",
}));
vi.mock("@/lib/csrf", () => ({ requireSameOrigin: () => null }));

const route = await import("../route");

const COOKIE = "patchwork_session";
const SESSION = "v2.alice.9999999999999.deadbeef";

function forwardedHeaders(): Record<string, string> {
  const init = bridgeFetchMock.mock.calls.at(-1)?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers ?? {};
}

async function run(headers: Record<string, string>) {
  const req = new NextRequest("http://localhost/api/bridge/recipes/demo/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  await route.POST(req, { params: Promise.resolve({ name: ["demo", "run"] }) });
}

beforeEach(() => {
  bridgeFetchMock.mockReset();
  bridgeFetchMock.mockResolvedValue(
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  );
});

describe("Run now session forwarding", () => {
  it("forwards the session cookie as x-patchwork-session", async () => {
    await run({ cookie: `${COOKIE}=${SESSION}` });
    expect(bridgeFetchMock).toHaveBeenCalledTimes(1);
    expect(forwardedHeaders()["x-patchwork-session"]).toBe(SESSION);
  });

  it("forwards nothing when there is no session cookie", async () => {
    await run({});
    expect(forwardedHeaders()["x-patchwork-session"]).toBeUndefined();
  });

  it("never passes through a client-supplied x-patchwork-session header", async () => {
    await run({ "x-patchwork-session": "v2.mallory.1.forged" });
    expect(forwardedHeaders()["x-patchwork-session"]).toBeUndefined();
  });
});
