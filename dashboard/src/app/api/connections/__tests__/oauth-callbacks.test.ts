/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All 7 OAuth callback routes proxy through bridgeFetch with an
// allowlisted query string. Mock once and parameterize over the routes.
const bridgeFetchMock = vi.fn();
vi.mock("@/lib/bridge", () => ({
  bridgeFetch: (...args: unknown[]) => bridgeFetchMock(...args),
}));

import { GET as gmailCallback } from "../gmail/callback/route";
import { GET as asanaCallback } from "../asana/callback/route";
import { GET as discordCallback } from "../discord/callback/route";
import { GET as gitlabCallback } from "../gitlab/callback/route";
import { GET as slackCallback } from "../slack/callback/route";
import { GET as gcalCallback } from "../google-calendar/callback/route";
import { GET as gdriveCallback } from "../google-drive/callback/route";

type Handler = (req: Request) => Promise<Response>;

const ROUTES: { name: string; bridgePath: string; handler: Handler }[] = [
  { name: "gmail",            bridgePath: "/connections/gmail/callback",            handler: gmailCallback },
  { name: "asana",            bridgePath: "/connections/asana/callback",            handler: asanaCallback },
  { name: "discord",          bridgePath: "/connections/discord/callback",          handler: discordCallback },
  { name: "gitlab",           bridgePath: "/connections/gitlab/callback",           handler: gitlabCallback },
  { name: "slack",            bridgePath: "/connections/slack/callback",            handler: slackCallback },
  { name: "google-calendar",  bridgePath: "/connections/google-calendar/callback",  handler: gcalCallback },
  { name: "google-drive",     bridgePath: "/connections/google-drive/callback",     handler: gdriveCallback },
];

beforeEach(() => {
  bridgeFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function reqWithQuery(query: string): Request {
  return new Request(`https://dashboard.local/cb?${query}`);
}

describe.each(ROUTES)("$name OAuth callback", ({ bridgePath, handler }) => {
  it(`forwards code+state to ${bridgePath} and passes status + body through`, async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await handler(reqWithQuery("code=abc123&state=nonce"));
    expect(bridgeFetchMock).toHaveBeenCalledOnce();
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain(bridgePath);
    expect(calledPath).toContain("code=abc123");
    expect(calledPath).toContain("state=nonce");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("forwards an error param when the provider denied the request", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await handler(reqWithQuery("error=access_denied&state=x"));
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain("error=access_denied");
    expect(calledPath).toContain("state=x");
    expect(res.status).toBe(400);
  });

  it("strips unallowed query params (only code/state/error reach the bridge)", async () => {
    // Allowlist matters — without it, an attacker could inject arbitrary
    // query params (e.g. ?bridge_secret=...) into the upstream call.
    bridgeFetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await handler(
      reqWithQuery("code=ok&utm_source=phish&bridge_secret=oops&state=s"),
    );
    const [calledPath] = bridgeFetchMock.mock.calls[0]!;
    expect(calledPath).toContain("code=ok");
    expect(calledPath).toContain("state=s");
    expect(calledPath).not.toContain("utm_source");
    expect(calledPath).not.toContain("bridge_secret");
  });

  it("502s with the error message when bridgeFetch throws", async () => {
    bridgeFetchMock.mockRejectedValueOnce(new Error("connection reset"));
    const res = await handler(reqWithQuery("code=x"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "connection reset" });
  });

  it("passes a 5xx response from the bridge through with body + status", async () => {
    bridgeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "exchange failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await handler(reqWithQuery("code=x&state=y"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "exchange failed" });
  });
});
