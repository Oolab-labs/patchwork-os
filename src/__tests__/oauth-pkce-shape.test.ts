/**
 * PKCE input shape — RFC 7636 §4.1 / §4.2 (security sweep 2026-10-01, L12).
 *
 * The server required S256 and compared hashes correctly, but never checked
 * the SHAPE of either side: a one-character `code_verifier` whose S256 hash
 * matched was accepted, and a ten-character `code_challenge` was stored at
 * authorize. The server itself was not exploitable — the attacker still needs
 * the verifier — but it tolerated clients with no entropy in the one value
 * PKCE exists to make unguessable, and said nothing.
 *
 * RFC 7636: verifier is 43–128 characters from the unreserved set
 * `[A-Za-z0-9-._~]`; an S256 challenge is the base64url (no padding) of a
 * 32-byte hash, i.e. exactly 43 characters of `[A-Za-z0-9_-]`.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthServerImpl } from "../oauth.js";

const ISSUER = "https://bridge.example.test";
const BRIDGE_TOKEN = crypto.randomBytes(32).toString("hex");
const CLIENT_ID = "test-client";
const REDIRECT_URI = "http://localhost:3000/callback";

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, hdrs?: Record<string, string>) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(hdrs ?? {}))
      this.headers[k.toLowerCase()] = v;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  getHeader(k: string) {
    return this.headers[k.toLowerCase()];
  }
  end(body?: string) {
    this.body = body ?? "";
    return this;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body || "{}") as Record<string, unknown>;
  }
}
const res = () => {
  const r = new MockResponse();
  return { r, sr: r as unknown as http.ServerResponse };
};
const getReq = (url: string) =>
  ({
    method: "GET",
    url,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;
const postForm = (form: URLSearchParams) =>
  Object.assign(Readable.from([Buffer.from(form.toString(), "utf-8")]), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;

const live: OAuthServerImpl[] = [];
afterEach(() => {
  for (const o of live.splice(0)) o.destroy();
});
function make(): OAuthServerImpl {
  const oauth = new OAuthServerImpl(BRIDGE_TOKEN, ISSUER);
  live.push(oauth);
  (oauth as any).registeredClients.set(CLIENT_ID, {
    redirectUris: [REDIRECT_URI],
    issuedAt: Date.now(),
  });
  return oauth;
}
const s256 = (verifier: string) =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

async function authorizeGet(oauth: OAuthServerImpl, challenge: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
  });
  const { r, sr } = res();
  await oauth.handleAuthorize(getReq(`/oauth/authorize?${params}`), sr);
  return r;
}

/** Full approve flow for a given verifier; returns the auth code. */
async function issueCodeFor(
  oauth: OAuthServerImpl,
  verifier: string,
): Promise<string> {
  const challenge = s256(verifier);
  const get = await authorizeGet(oauth, challenge);
  expect(get.statusCode).toBe(200);
  const nonces = (oauth as any).csrfNonces as Map<
    string,
    { nonce: string; clientId: string }
  >;
  const [flowId, entry] = [...nonces.entries()].find(
    ([, v]) => v.clientId === CLIENT_ID,
  ) ?? ["", undefined];
  if (!entry) throw new Error("nonce not primed");
  const form = new URLSearchParams({
    action: "approve",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    bridge_token: BRIDGE_TOKEN,
    scope: "mcp",
    csrf_nonce: entry.nonce,
    flow_id: flowId,
  });
  const { r, sr } = res();
  await oauth.handleAuthorize(postForm(form), sr);
  const code = new URL(r.headers.location ?? "http://invalid").searchParams.get(
    "code",
  );
  if (!code) throw new Error(`no code issued (status ${r.statusCode})`);
  return code;
}

async function exchange(
  oauth: OAuthServerImpl,
  code: string,
  verifier: string,
) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
  });
  const { r, sr } = res();
  await oauth.handleToken(postForm(form), sr);
  return r;
}

const GOOD_VERIFIER = crypto.randomBytes(32).toString("base64url"); // 43 chars

describe("PKCE verifier shape (RFC 7636 §4.1)", () => {
  it("a spec-conformant 43-char verifier still works (control)", async () => {
    const oauth = make();
    const code = await issueCodeFor(oauth, GOOD_VERIFIER);
    const r = await exchange(oauth, code, GOOD_VERIFIER);
    expect(r.statusCode).toBe(200);
  });

  it("a 1-character verifier is refused even though its S256 hash matches", async () => {
    const oauth = make();
    const code = await issueCodeFor(oauth, "a");
    const r = await exchange(oauth, code, "a");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_grant");
  });

  it("a 42-character verifier is refused; 43 and 128 are accepted; 129 refused", async () => {
    for (const [len, ok] of [
      [42, false],
      [43, true],
      [128, true],
      [129, false],
    ] as const) {
      const oauth = make();
      const v = "A".repeat(len);
      const code = await issueCodeFor(oauth, v);
      const r = await exchange(oauth, code, v);
      expect(r.statusCode, `length ${len}`).toBe(ok ? 200 : 400);
    }
  });

  it("a verifier with a character outside the unreserved set is refused", async () => {
    const oauth = make();
    const v = `${"A".repeat(42)}+`; // '+' is not unreserved
    const code = await issueCodeFor(oauth, v);
    const r = await exchange(oauth, code, v);
    expect(r.statusCode).toBe(400);
  });

  it("a malformed verifier invalidates the code like any other PKCE failure (M20)", async () => {
    const oauth = make();
    const code = await issueCodeFor(oauth, "a");
    await exchange(oauth, code, "a");
    // Retrying the same code with ANY verifier must now fail as unknown/used.
    const again = await exchange(oauth, code, GOOD_VERIFIER);
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_grant");
  });
});

describe("PKCE challenge shape (RFC 7636 §4.2, S256)", () => {
  it("a 43-char base64url challenge is accepted (control)", async () => {
    const r = await authorizeGet(make(), s256(GOOD_VERIFIER));
    expect(r.statusCode).toBe(200);
  });

  it("a short challenge is refused with invalid_request", async () => {
    const r = await authorizeGet(make(), "tooshort");
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("invalid_request");
  });

  it("a challenge with padding or non-base64url characters is refused", async () => {
    expect((await authorizeGet(make(), `${"A".repeat(42)}=`)).statusCode).toBe(
      400,
    );
    expect((await authorizeGet(make(), `${"A".repeat(42)}+`)).statusCode).toBe(
      400,
    );
  });
});
