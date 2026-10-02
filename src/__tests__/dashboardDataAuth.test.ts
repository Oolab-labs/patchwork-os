/**
 * Security sweep L10. GET /dashboard/data was unauthenticated and returned
 * `events` (recent activity) and `perf` (per-tool latency) alongside the
 * version/uptime summary its own comment described. The built-in status page
 * fetches it WITHOUT a token, so the route stays open — but only the summary
 * is public. Activity and performance detail need the bearer token.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const servers: Server[] = [];

async function setup() {
  const authToken = randomUUID();
  const server = new Server(authToken, new Logger(false));
  server.statusFn = () => ({ events: [{ msg: "distinctive-event-marker" }] });
  server.perfDataFn = () => ({ latency: { overallP95Ms: 7 } });
  const port = await server.findAndListen(null);
  servers.push(server);
  return { port, authToken };
}

function get(port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: Record<string, unknown> }>(
    (resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/dashboard/data`, { headers }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString();
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) }),
          );
        })
        .on("error", reject);
    },
  );
}

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers.length = 0;
});

describe("/dashboard/data (L10)", () => {
  it("without a token: summary only, no events or perf", async () => {
    const { port } = await setup();
    const { status, json } = await get(port);
    expect(status).toBe(200);
    expect(typeof json.version).toBe("string");
    expect(json.events).toEqual([]);
    expect(json.perf).toBeNull();
    expect(JSON.stringify(json)).not.toContain("distinctive-event-marker");
  });

  it("with a wrong token: still summary only", async () => {
    const { port } = await setup();
    const { json } = await get(port, { Authorization: "Bearer nope" });
    expect(JSON.stringify(json)).not.toContain("distinctive-event-marker");
    expect(json.perf).toBeNull();
  });

  it("with the bridge token: full detail", async () => {
    const { port, authToken } = await setup();
    const { json } = await get(port, { Authorization: `Bearer ${authToken}` });
    expect(JSON.stringify(json.events)).toContain("distinctive-event-marker");
    expect(json.perf).toEqual({ latency: { overallP95Ms: 7 } });
  });
});
