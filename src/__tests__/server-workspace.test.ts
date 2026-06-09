/**
 * Audit 2026-06-08 HIGH (server-3): workspace-relative routes used process.cwd()
 * instead of the configured --workspace. A bridge started with
 * --workspace /elsewhere (or under a launchd/systemd cwd) computed decision
 * replay + CC permission attribution against the wrong directory. The Server now
 * exposes a `workspace` field the bridge sets from config; routes read it.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replayMock = vi.fn(
  (_log: unknown, _opts: { workspace: string; sinceMs: number }) => ({
    decisions: [] as unknown[],
    summary: {} as Record<string, unknown>,
  }),
);
vi.mock("../decisionReplay.js", () => ({
  computeDecisionReplay: replayMock,
}));

import { Logger } from "../logger.js";
import { Server } from "../server.js";

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Authorization: "Bearer tok" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Server workspace threading", () => {
  let server: Server | undefined;

  beforeEach(() => {
    replayMock.mockClear();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("defaults workspace to process.cwd() when not overridden", () => {
    const s = new Server("tok", new Logger(false));
    expect(s.workspace).toBe(process.cwd());
  });

  it("decision-replay route uses the configured workspace, not process.cwd()", async () => {
    server = new Server("tok", new Logger(false));
    const configured = "/tmp/a-configured-workspace-dir";
    server.workspace = configured;
    // The replay route 503s without a wired activity log; the computeDecisionReplay
    // mock ignores it, so a stub suffices.
    server.activityLog = {} as never;
    const port = await server.findAndListen(null);

    const res = await httpGet(port, "/approval-insights/replay?sinceDays=7");

    expect(res.status).toBe(200);
    expect(replayMock).toHaveBeenCalledTimes(1);
    const opts = replayMock.mock.calls[0]?.[1];
    expect(opts?.workspace).toBe(configured);
    expect(opts?.workspace).not.toBe(process.cwd());
  });
});
