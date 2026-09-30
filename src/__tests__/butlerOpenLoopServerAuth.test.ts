import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../logger.js";
import { Server } from "../server.js";

const logger = new Logger(false);
let server: Server | null = null;
const envKey = "PATCHWORK_FLAG_BUTLER_OPEN_LOOPS";
let previousFlag: string | undefined;

afterEach(async () => {
  await server?.close();
  server = null;
  if (previousFlag === undefined) delete process.env[envKey];
  else process.env[envKey] = previousFlag;
});

describe("Server: Butler Loose Ends authentication", () => {
  it("rejects an unauthenticated request before the feature gate", async () => {
    previousFlag = process.env[envKey];
    process.env[envKey] = "false";

    server = new Server("test-token", logger);
    const port = await server.findAndListen(null);

    const unauth = await fetch(`http://127.0.0.1:${port}/butler/loops`);
    expect(unauth.status).toBe(401);

    // With the Bearer token the request reaches the route, which proves the
    // 401 above came from the server auth wall rather than from the route.
    const authed = await fetch(`http://127.0.0.1:${port}/butler/loops`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authed.status).toBe(503);
    expect((await authed.json()) as { code?: string }).toMatchObject({
      code: "feature_disabled",
    });
  });
});
