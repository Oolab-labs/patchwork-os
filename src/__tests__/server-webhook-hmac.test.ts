/**
 * Tests for HMAC-SHA256 webhook authentication at POST /hooks/*.
 *
 * When `webhookSecret` is configured, requests carrying the
 * `X-Hub-Signature-256: sha256=<hex>` header are authenticated via HMAC
 * over the raw request body, bypassing the bearer-token gate. Bearer
 * access continues to work — HMAC is additive, not a replacement.
 */
import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { readSingleSignatureHeader, Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-hmac-bearer-token-000000000000";
const SECRET =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 64 hex chars

let server: Server | null = null;
let port = 0;
let calls: Array<{ path: string; payload: unknown; deliveryId?: string }>;

async function startServer(opts: { secret: string | null }): Promise<void> {
  calls = [];
  server = new Server(TOKEN, logger);
  server.webhookSecret = opts.secret;
  server.webhookFn = async (path, payload, deliveryId) => {
    calls.push({ path, payload, deliveryId });
    return { ok: true, name: "stub-recipe", taskId: "task-1" };
  };
  port = await server.findAndListen(null);
}

afterEach(async () => {
  await server?.close();
  server = null;
  port = 0;
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function postHooks(
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/hooks/test-recipe",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body, "utf-8")),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("POST /hooks/* — HMAC-SHA256 webhook auth", () => {
  beforeEach(() => {
    calls = [];
  });

  it("accepts a valid X-Hub-Signature-256 (no bearer needed)", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened", number: 42 });
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/test-recipe");
    expect(calls[0]!.payload).toEqual({ action: "opened", number: 42 });
  });

  it("rejects an invalid signature with 401 invalid_signature", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const bogus = sign(body, "0".repeat(64));
    const { status, body: respBody } = await postHooks(body, {
      "X-Hub-Signature-256": bogus,
    });
    expect(status).toBe(401);
    expect(JSON.parse(respBody)).toEqual({ error: "invalid_signature" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a tampered signature (one char off) — constant-time compare", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const good = sign(body, SECRET);
    // Flip the final hex char to its neighbor — same length, off by one.
    const last = good[good.length - 1];
    const flipped = last === "0" ? "1" : "0";
    const tampered = good.slice(0, -1) + flipped;
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": tampered,
    });
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns 401 webhook_secret_not_configured when signature presented but no secret set", async () => {
    await startServer({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    // Use any valid-shaped signature — server has no secret to compare against
    const sig = sign(body, SECRET);
    // Need a bearer to pass the outer gate, otherwise we never reach the
    // /hooks handler. (No secret means no HMAC bypass.)
    const { status, body: respBody } = await postHooks(body, {
      "X-Hub-Signature-256": sig,
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(401);
    expect(JSON.parse(respBody)).toEqual({
      error: "webhook_secret_not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("falls back to Bearer auth when no signature header (backwards compat)", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ source: "internal-automation" });
    const { status } = await postHooks(body, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toEqual({ source: "internal-automation" });
  });

  it("returns 401 when neither signature nor Bearer is provided", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    const { status } = await postHooks(body, {});
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("accepts empty body with a valid signature (GitHub ping edge case)", async () => {
    await startServer({ secret: SECRET });
    const body = "";
    const { status } = await postHooks(body, {
      "X-Hub-Signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    // Empty body — payload is undefined (no JSON parse attempted on empty input)
    expect(calls[0]!.payload).toBeUndefined();
  });

  // H6 — audit 2026-06-19: duplicate X-Hub-Signature-256 headers must NOT
  // bypass both bearer auth and HMAC verification.
  // node's http.IncomingMessage merges duplicate headers into a string[] array.
  // Before the fix: !!headers['x-hub-signature-256'] is truthy for an array
  // → isHmacWebhookCandidate=true → bearer gate bypassed.
  // typeof sigHeader === 'string' is false for an array → HMAC check skipped.
  // Net: the request goes through with no valid credential of any kind.
  it("duplicate X-Hub-Signature-256 headers must NOT bypass bearer auth and HMAC (H6)", async () => {
    await startServer({ secret: SECRET });
    const body = JSON.stringify({ action: "opened" });
    // Use a raw TCP socket to send duplicate X-Hub-Signature-256 headers;
    // the high-level http.request API collapses duplicate headers, so we
    // craft the bytes manually.
    const net = await import("node:net");
    const raw =
      `POST /hooks/test-recipe HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `X-Hub-Signature-256: sha256=invalid1\r\n` +
      `X-Hub-Signature-256: sha256=invalid2\r\n` +
      `\r\n` +
      body;
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(raw);
      });
      let resp = "";
      sock.on("data", (d) => {
        resp += d.toString();
        if (resp.includes("\r\n\r\n")) {
          const statusLine = resp.split("\r\n")[0] ?? "";
          const statusCode = Number(statusLine.split(" ")[1]);
          sock.destroy();
          resolve({ status: statusCode });
        }
      });
      sock.on("error", reject);
      sock.on("close", () => {
        if (!resp) resolve({ status: 0 });
      });
    });
    // Must be rejected — not 200.
    expect(result.status).not.toBe(200);
    expect(calls).toHaveLength(0);
  });
});

// H6 — direct coverage of the array/multi-valued reproduction that the raw
// HTTP path cannot produce (Node comma-joins duplicate headers into a single
// string). An upstream reverse-proxy or HTTP/2 frontend CAN hand the bridge a
// string[] for x-hub-signature-256; before the fix the outer gate saw it as
// truthy (bearer bypass) and the inner gate's `typeof === "string"` skipped
// HMAC entirely — auth bypass with no valid credential.
describe("readSingleSignatureHeader — H6 multi-valued rejection", () => {
  it("returns the lone string for a single valid value", () => {
    expect(readSingleSignatureHeader("sha256=abc")).toBe("sha256=abc");
  });
  it("returns null for undefined (absent)", () => {
    expect(readSingleSignatureHeader(undefined)).toBeNull();
  });
  it("returns null for a string[] (duplicate headers via proxy/HTTP-2)", () => {
    expect(
      readSingleSignatureHeader(["sha256=invalid1", "sha256=invalid2"]),
    ).toBeNull();
  });
  it("returns null for a comma-joined string (Node duplicate-header merge)", () => {
    expect(
      readSingleSignatureHeader("sha256=invalid1, sha256=invalid2"),
    ).toBeNull();
  });
});

// Webhook redelivery dedup — deliveryId derivation passed to webhookFn.
// A sender's own delivery-id header (GitHub's X-GitHub-Delivery, a UUID
// unique per delivery attempt, including retries of the SAME delivery)
// should produce a stable, deterministic deliveryId so a recipe's
// write-effect ledger can dedup a redelivered webhook against a run that
// already executed its writes before a crash/restart mid-run. Senders with
// no delivery header fall back to a hash of the raw body.
describe("POST /hooks/* — deliveryId derivation for webhook redelivery dedup", () => {
  it("derives deliveryId from X-GitHub-Delivery when present", async () => {
    await startServer({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    const deliveryHeader = "12345678-1234-1234-1234-123456789012";
    const { status } = await postHooks(body, {
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Delivery": deliveryHeader,
    });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    const expected = createHash("sha256")
      .update(deliveryHeader)
      .digest("hex")
      .slice(0, 32);
    expect(calls[0]!.deliveryId).toBe(expected);
  });

  it("two deliveries with the SAME X-GitHub-Delivery produce the SAME deliveryId (redelivery dedup)", async () => {
    await startServer({ secret: null });
    const deliveryHeader = "same-delivery-id-retried-once";
    await postHooks(JSON.stringify({ n: 1 }), {
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Delivery": deliveryHeader,
    });
    // Sender retries the identical delivery (e.g. bridge timed out the
    // first response) — same delivery id, possibly identical or retried body.
    await postHooks(JSON.stringify({ n: 1 }), {
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Delivery": deliveryHeader,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.deliveryId).toBe(calls[1]!.deliveryId);
  });

  it("falls back to a hash of the raw body when no delivery header is present", async () => {
    await startServer({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    const { status } = await postHooks(body, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(200);
    const expected = createHash("sha256")
      .update(Buffer.from(body, "utf-8"))
      .digest("hex")
      .slice(0, 32);
    expect(calls[0]!.deliveryId).toBe(expected);
  });

  it("different bodies with no delivery header produce different deliveryIds", async () => {
    await startServer({ secret: null });
    await postHooks(JSON.stringify({ a: 1 }), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await postHooks(JSON.stringify({ a: 2 }), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.deliveryId).not.toBe(calls[1]!.deliveryId);
  });

  it("ignores a spoofed multi-valued X-GitHub-Delivery header and falls back to the body hash", async () => {
    // Same H6 rejection pattern as X-Hub-Signature-256: a multi-valued
    // delivery header (duplicate lines, comma-joined by Node, or an
    // upstream proxy handing us a string[]) must not be trusted verbatim.
    await startServer({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    const { status } = await postHooks(body, {
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Delivery": "id-one, id-two",
    });
    expect(status).toBe(200);
    const expected = createHash("sha256")
      .update(Buffer.from(body, "utf-8"))
      .digest("hex")
      .slice(0, 32);
    expect(calls[0]!.deliveryId).toBe(expected);
  });
});
