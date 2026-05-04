/**
 * Verifies that connector-route IIFEs return a 500 JSON response when the
 * underlying handler throws, rather than leaving the response open.
 *
 * Uses the real Server class so the full dispatch path (auth gate →
 * tryHandleConnectorRoute) is exercised.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
const TOKEN = "test-connector-error-token-000000000";

let server: Server | null = null;
let port = 0;

function makeRequest(
  options: http.RequestOptions,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, ...options },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  server = new Server(TOKEN, logger);
  port = await server.findAndListen(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = null;
  port = 0;
});

describe("connector route IIFE error handling", () => {
  it("returns 500 JSON when a connector handler throws", async () => {
    // Mock the gmail connector module to throw
    vi.mock("../connectors/gmail.js", () => ({
      handleConnectionsList: () => {
        throw new Error("connector exploded");
      },
    }));

    const { status, body } = await makeRequest({
      method: "GET",
      path: "/connections",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    // Should get a 500 rather than a hung response
    expect(status).toBe(500);
    const parsed = JSON.parse(body);
    expect(parsed.error).toContain("connector exploded");
  });
});
